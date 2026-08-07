// character.js — GolfBallGuy, BallTrail.
// Split out of game.js; loaded as a plain <script> before game.js (see game.html),
// and require()-able in Node for unit tests. Cross-module refs resolve via globals.
(function (global) {
  // ─── CHARACTER (GOLF BALL WITH ANIMATIONS) ─────────────────────────────────

  class GolfBallGuy {
    // Rolling resistance: only brake once the ball is already slow, and use a
    // constant decel. 0.6 m/s² ≈ a medium-fast green (Stimp ~9): a lag putt rolls a
    // realistic distance and settles. (3.0 was ~5× real green resistance and, with the
    // old 1.2 angular damping, made putting almost impossible — the ball died in ~1 m.)
    // Trade-off: 0.6 only holds the ball on slopes up to ~3.5°; steeper banks keep
    // rolling, which is realistic — a ball won't sit still on a steep green either.
    static ROLL_BRAKE_SPEED = 2.5;
    static ROLL_BRAKE_DECEL = 0.6;
    // Anti-tunnel guard: a real-size (42.7 mm) ball at ~100 m/s moves far more than
    // its own radius per physics step, so on a fast terrain impact (tee-shot into a
    // rise, or a hard landing) it can punch straight through the thin triangle-MESH
    // terrain. No substep rate is high enough to catch that reliably, so we sweep it
    // back on top each frame instead. Only meaningful above this speed.
    static TUNNEL_GUARD_MIN_SPEED = 6;
    // Above this height over the terrain the ball can't tunnel through it, so we skip
    // the (costly) per-frame terrain ray-pick — it only matters in the last metre or
    // two before the surface. Comfortably clears one frame's fall at drive speed.
    static TUNNEL_GUARD_MAX_HEIGHT = 3;
    static _surfPred = (m) =>
      m.name && m.name.startsWith("surf_") && !m.name.startsWith("surf_water");

    constructor(mesh, physicsBody, skeleton, scene) {
      this.mesh = mesh;
      this.body = physicsBody;
      this.startPosition = mesh.position.clone();
      this.landed = true;
      this.touchedGround = false;
      // Terrain height directly under the ball (0 for the flat practice ground).
      // Course mode updates this each frame so airborne/contact tests are measured
      // relative to the ground below, not absolute world Y.
      this.heightRef = 0;

      // Teleport support: reset() flips disablePreStep off so the body follows the
      // mesh for a few physics steps; updateLandingState() restores it afterward.
      this._teleportRestoreFrames = 0;
      this._inCup = false; // sitting in a real cavity cup — exempt from preventTunneling
      this.pendingSpinAmount = 0;
      this.pendingSpinAxis = BABYLON.Vector3.Zero();

      this.skeleton = skeleton;
      this.spinBone = null;
      this.scene = scene;

      this.faceMesh = null;
      this.faceMaterial = null;
      this.faceTextures = {};
      this.currentFace = "default";
      this.faceTransitionTimer = 0;
      this.nextFace = null;

      this.HIT_FACE_DURATION = 0.3;
      this.COLLISION_FACE_DURATION = 0.4;

      this.spinTransitionActive = false;
      this.spinTransitionTimer = 0;
      this.spinTransitionDuration = 0.4;

      this.targetRotation = 0;
      this.facingAimDirection = false;
      // Visual root the character meshes hang from (set up in loadCharacter).
      // Facing is applied here, not on this.mesh — see updateRotation.
      this.characterRoot = null;

      // Blinking system — the state machine lives in balls.js; this.blink and
      // this.blinkMorphIdx are set up in initializeEyelids once the model loads.
      this.eyelidsMesh = null;
      this.blink = null;
      this.blinkMorphIdx = null;

      this.eyeL = null;
      this.eyeR = null;
      this.eyeLRest = null;
      this.eyeRRest = null;
      this.eyeYaw = 0;
      this.eyePitch = 0;

      if (skeleton && skeleton.bones.length > 0) {
        this.spinBone = skeleton.bones.find((b) =>
          b.name.toLowerCase().includes("spin"),
        );
        if (!this.spinBone) {
          this.spinBone = skeleton.bones[0];
        }
      }
    }

    // === PHYSICS METHODS ===
    getPosition() {
      return this.mesh.position;
    }

    getHeight() {
      return this.mesh.position.y - this.heightRef;
    }

    getVelocity() {
      let vel = BABYLON.Vector3.Zero();
      this.body.getLinearVelocityToRef(vel);
      return vel;
    }

    getSpeed() {
      // Reuse a scratch vector — getSpeed runs several times per frame and returns
      // only a scalar, so there's no need to allocate a fresh Vector3 each call.
      const v =
        this._speedScratch || (this._speedScratch = new BABYLON.Vector3());
      this.body.getLinearVelocityToRef(v);
      return v.length();
    }

    getAngularVelocity() {
      let angVel = BABYLON.Vector3.Zero();
      this.body.getAngularVelocityToRef(angVel);
      return angVel;
    }

    // Cartoonish glow shell around the ball. Additive so intensity 0 = invisible
    // (no spin → no aura). Colour ramps blue → orange → flaming red with spin.
    createSpinAura() {
      const d = CONFIG.BALL.COLLIDER_DIAMETER * CONFIG.PHYSICS.SPIN_AURA_SCALE;
      const aura = BABYLON.MeshBuilder.CreateSphere(
        "spinAura",
        { diameter: d, segments: 12 },
        this.scene,
      );
      aura.parent = this.mesh;
      aura.position = BABYLON.Vector3.Zero();
      aura.isPickable = false;
      const mat = new BABYLON.StandardMaterial("spinAuraMat", this.scene);
      mat.disableLighting = true;
      mat.diffuseColor = new BABYLON.Color3(0, 0, 0);
      mat.specularColor = new BABYLON.Color3(0, 0, 0);
      mat.emissiveColor = new BABYLON.Color3(0.2, 0.5, 1);
      // Alpha<1 flags the material transparent so it blends (an opaque emissive
      // shell would just be a black ball over the gball). alpha=0 ⇒ invisible.
      mat.alpha = 0;
      mat.transparencyMode = BABYLON.Material.MATERIAL_ALPHABLEND;
      mat.backFaceCulling = true;
      aura.material = mat;
      aura.setEnabled(false); // hidden until the ball actually spins
      this.spinAura = aura;
      this.spinAuraMat = mat;
      this._auraPhase = 0;
    }

    // Drive the aura from the ball's angular speed each frame (called from
    // updateLandingState so it needs no separate per-frame hook in game.js).
    updateSpinAura() {
      if (!this.mesh || this.mesh.isDisposed()) return;
      if (!this.spinAura) this.createSpinAura();
      // Only glow when the PLAYER is spinning the ball — a spin-swipe sets
      // pendingSpinAmount (zeroed on landing). Natural roll / putting also spins
      // the ball but must not light the aura.
      if (this.pendingSpinAmount <= 0) {
        if (this.spinAura.isEnabled()) this.spinAura.setEnabled(false);
        return;
      }
      this.spinAura.setEnabled(true);
      const t = Math.min(
        this.pendingSpinAmount / CONFIG.PHYSICS.SPIN_AURA_MAX,
        1,
      );
      // blue → orange (t<0.5) → red (t≥0.5)
      let r, g, b;
      if (t < 0.5) {
        const k = t / 0.5;
        r = 0.2 + 0.8 * k;
        g = 0.5 + 0.05 * k;
        b = 1 - 0.9 * k;
      } else {
        const k = (t - 0.5) / 0.5;
        r = 1;
        g = 0.55 - 0.45 * k;
        b = 0.1 - 0.05 * k;
      }
      // Flaming flicker at high spin; frame-counter phase (no time dependency).
      this._auraPhase = (this._auraPhase + 1) % 100000;
      let intensity = t;
      if (t > 0.6) intensity *= 0.85 + 0.15 * Math.sin(this._auraPhase * 0.4);
      this.spinAuraMat.emissiveColor.set(r, g, b);
      this.spinAuraMat.alpha = Math.min(intensity, 1) * 0.55; // translucent glow
      this.spinAura.scaling.setAll(1 + 0.14 * t);
    }

    /**
     * Rolling resistance. A physics sphere rolls down any slope forever (sliding
     * friction can't stop a rolling ball — only rolling resistance can). So when
     * the ball is on the ground and already slow, bleed off horizontal speed with
     * a CONSTANT deceleration (not proportional damping, which only asymptotes).
     * On a gentle undulation this beats gravity → the ball fully stops; on a steep
     * bank gravity wins → it keeps rolling. Makes the ball settle instead of creep.
     */
    applyRollingResistance(dt) {
      if (this.isAirborne()) return;
      // Scratch vectors reused every frame instead of allocating (this runs each
      // render frame while the ball is settling on an undulation).
      const v = this._rrLin || (this._rrLin = new BABYLON.Vector3());
      const av = this._rrAng || (this._rrAng = new BABYLON.Vector3());
      this.body.getLinearVelocityToRef(v);
      const hs = Math.hypot(v.x, v.z);
      if (hs < 1e-3) return;

      // Sand grabs the ball hard (plush bunker): once it's on sand, brake at ANY
      // speed and kill the spin so it plugs almost immediately instead of skidding
      // or rolling through. grab = per-second decay rate (SURFACE_PHYSICS.sand.grab).
      const grab = this.getHeight() < 0.6 ? this._sandGrabUnderBall() : 0;
      if (grab > 0) {
        const s = 1 - Math.min(grab * dt, 1);
        if (hs * s < 0.06) {
          v.set(0, Math.min(0, v.y), 0);
          this.body.setLinearVelocity(v);
          av.set(0, 0, 0);
          this.body.setAngularVelocity(av);
        } else {
          v.set(v.x * s, v.y, v.z * s);
          this.body.setLinearVelocity(v);
          this.body.getAngularVelocityToRef(av);
          av.scaleInPlace(s);
          this.body.setAngularVelocity(av);
        }
        return;
      }

      if (hs > GolfBallGuy.ROLL_BRAKE_SPEED) return;
      const newHs = hs - GolfBallGuy.ROLL_BRAKE_DECEL * dt;
      if (newHs < 0.06) {
        // A manually-spun ball can pass through ~0 linear speed while its spin is
        // still converting to roll — killing it there murders the roll-out. Only
        // snap to rest once the spin is also low (a normal rolling ball at this
        // speed spins at <3 rad/s, so this never blocks ordinary settling).
        this.body.getAngularVelocityToRef(av);
        if (av.length() >= CONFIG.PHYSICS.LANDED_ANGULAR_THRESHOLD) return;
        // Fully stopped: kill motion so static friction can hold it on the slope.
        v.set(0, Math.min(0, v.y), 0);
        this.body.setLinearVelocity(v);
        av.set(0, 0, 0);
        this.body.setAngularVelocity(av);
      } else {
        const s = newHs / hs;
        v.set(v.x * s, v.y, v.z * s);
        this.body.setLinearVelocity(v);
        this.body.getAngularVelocityToRef(av);
        av.scaleInPlace(s);
        this.body.setAngularVelocity(av);
      }
    }

    // Downward ray → the surface grab under the ball (sand > 0; 0 elsewhere), so a
    // bunker can brake the roll. Throttled + cached so it isn't a fresh ray every
    // frame of every roll (the pick cost is what spikes frame times — see below).
    _sandGrabUnderBall() {
      this._surfTick = (this._surfTick || 0) + 1;
      if (this._surfGrab !== undefined && this._surfTick % 4 !== 0) {
        return this._surfGrab;
      }
      const p = this.mesh.getAbsolutePosition();
      const ray =
        this._sbRay ||
        (this._sbRay = new BABYLON.Ray(
          new BABYLON.Vector3(),
          new BABYLON.Vector3(0, -1, 0),
          4,
        ));
      ray.origin.set(p.x, p.y + 1, p.z);
      const hit = this.scene.pickWithRay(ray, GolfBallGuy._surfPred);
      this._surfGrab =
        (hit && hit.hit && hit.pickedMesh && hit.pickedMesh._surfaceGrab) || 0;
      return this._surfGrab;
    }

    // Swept anti-tunnel guard (see TUNNEL_GUARD_MIN_SPEED). If the ball ended a step
    // below the terrain surface at its x,z, it tunneled through — bounce it off the
    // surface (reflect velocity by restitution) and lift it back on top.
    preventTunneling() {
      if (!this.body || this._teleportRestoreFrames > 0 || this._inCup) return;
      if (this.getSpeed() < GolfBallGuy.TUNNEL_GUARD_MIN_SPEED) return;
      // Skip the terrain ray-pick while the ball is well above the ground — it can't
      // tunnel from up there, and picking every frame of the whole flight is what
      // spikes frame times (and makes the follow camera look jittery). getHeight() is
      // an O(1) height-grid read, so this early-out is essentially free.
      if (this.getHeight() > GolfBallGuy.TUNNEL_GUARD_MAX_HEIGHT) return;
      const p = this.mesh.getAbsolutePosition();
      const r = CONFIG.BALL.COLLIDER_DIAMETER / 2;
      const ray =
        this._tgRay ||
        (this._tgRay = new BABYLON.Ray(
          new BABYLON.Vector3(),
          new BABYLON.Vector3(0, -1, 0),
          80,
        ));
      ray.origin.set(p.x, p.y + 3, p.z);
      const hit = this.scene.pickWithRay(ray, GolfBallGuy._surfPred);
      if (!hit || !hit.hit) return;
      const surfaceY = hit.pickedPoint.y;
      if (p.y >= surfaceY + r - 0.03) return; // on/above the surface — nothing to do
      // Reflect the into-surface velocity component (a bounce), then lift on top.
      const v = this._tgV || (this._tgV = new BABYLON.Vector3());
      this.body.getLinearVelocityToRef(v);
      let n = hit.getNormal(true);
      if (!n) n = new BABYLON.Vector3(0, 1, 0);
      const vn = v.x * n.x + v.y * n.y + v.z * n.z;
      if (vn < 0) {
        // Bounce with the STRUCK surface's restitution (sand deadens, rock kicks);
        // falls back to the ball default off unstamped surfaces (practice disc).
        const e =
          hit.pickedMesh?._surfaceRestitution ?? CONFIG.BALL.RESTITUTION;
        v.x -= (1 + e) * vn * n.x;
        v.y -= (1 + e) * vn * n.y;
        v.z -= (1 + e) * vn * n.z;
        this.body.setLinearVelocity(v);
      }
      this.mesh.position.y = surfaceY + r + 0.01;
      this.body.disablePreStep = false;
      this._teleportRestoreFrames = 2;
      this.mesh.computeWorldMatrix(true);
    }

    applyHit(
      deltaX,
      deltaY,
      force,
      aimedDirection = 0,
      clubLaunchAngle = 0,
      clubLaunchSpeed = 40,
    ) {
      const swipeStrength = Math.min(
        force / 100,
        CONFIG.GOLF_BALL.MAX_HIT_STRENGTH,
      );
      // Distance is driven by a per-club launch SPEED (calibrated so full-power
      // carry ≈ the club's estimate — see scripts/club-distance-test.js), launched
      // at the club's loft. The old model derived speed from ad-hoc force constants
      // × sqrt(distance) for forward and × sin(loft) for lift, which were coupled to
      // neither each other nor the target — so short/high-loft clubs flew ~2.5× their
      // number and the whole set bunched into a narrow band.
      const powerRatio = swipeStrength / CONFIG.GOLF_BALL.MAX_HIT_STRENGTH;
      const theta = (clubLaunchAngle * Math.PI) / 180;
      const speed = clubLaunchSpeed * powerRatio;
      const vForward = speed * Math.cos(theta);
      const vUp = speed * Math.sin(theta);
      // Sideways component of the swipe curves the shot. Kept on the same Δv scale as
      // the old force path (force→impulse/mass·dt) so left/right feel is unchanged.
      const vLateral =
        (-deltaX *
          CONFIG.GOLF_BALL.HIT_HORIZONTAL_DEVIATION_FACTOR *
          CONFIG.SWIPE_OVERLAY.PHYSICS_STEP_SECONDS) /
        CONFIG.BALL.MASS;

      const localVel = new BABYLON.Vector3(vLateral, vUp, -vForward);
      const { x: rotX, z: rotZ } = Utils.rotate2D(
        localVel.x,
        localVel.z,
        aimedDirection,
      );
      const launchVel = new BABYLON.Vector3(rotX, localVel.y, rotZ);

      const impactPoint = this.getPosition().add(
        new BABYLON.Vector3(
          CONFIG.GOLF_BALL.IMPACT_POINT_OFFSET_X,
          CONFIG.GOLF_BALL.IMPACT_POINT_OFFSET_Y,
          CONFIG.GOLF_BALL.IMPACT_POINT_OFFSET_Z,
        ),
      );

      // From rest, an impulse J = m·Δv delivers Δv = launchVel exactly, so the launch
      // speed is the calibrated value regardless of frame length (frame-rate safe).
      this.body.applyImpulse(launchVel.scale(CONFIG.BALL.MASS), impactPoint);

      // Loft generates backspin at the strike (real physics). High-loft wedges spin
      // hard and land steeply, so on landing friction bites and can check/draw the
      // ball back; low-loft clubs spin little and land shallow, so they run out.
      // Backspin axis = horizontal-travel × up. Not tied to pendingSpinAmount, so it
      // doesn't light the manual-spin aura.
      const horiz = new BABYLON.Vector3(launchVel.x, 0, launchVel.z);
      if (clubLaunchAngle > 0 && horiz.lengthSquared() > 1e-6) {
        const axis = BABYLON.Vector3.Cross(
          horiz.normalize(),
          new BABYLON.Vector3(0, 1, 0),
        ).normalize();
        const backspin = Math.min(
          clubLaunchAngle * powerRatio * CONFIG.PHYSICS.STRIKE_SPIN_FACTOR,
          CONFIG.PHYSICS.STRIKE_SPIN_MAX,
        );
        this.body.setAngularVelocity(axis.scale(backspin));
      } else {
        this.body.setAngularVelocity(BABYLON.Vector3.Zero());
      }
    }

    applySpin(spinAxis, spinAmount) {
      // Add this swipe's spin ON TOP of the ball's current spin (e.g. the strike's
      // loft backspin) so a swipe augments / kills / curves it rather than replacing
      // it. Clamp the total (STRIKE_SPIN_MAX) so repeated swipes can't run away.
      const delta = spinAxis.scale(spinAmount * PhysicsConfig.SPIN_MULTIPLIER);
      const next = this.getAngularVelocity().add(delta);
      const mag = next.length();
      if (mag > CONFIG.PHYSICS.STRIKE_SPIN_MAX) {
        next.scaleInPlace(CONFIG.PHYSICS.STRIKE_SPIN_MAX / mag);
      }
      this.body.setAngularVelocity(next);
      this.pendingSpinAmount = Math.min(
        this.pendingSpinAmount + spinAmount,
        1.2,
      );
      this.pendingSpinAxis = spinAxis;
    }

    updateLandingState() {
      // Restore physics control a few steps after a teleport (see reset()).
      if (this._teleportRestoreFrames > 0) {
        this._teleportRestoreFrames--;
        if (this._teleportRestoreFrames === 0 && this.body) {
          this.body.disablePreStep = true;
        }
      }
      const height = this.getHeight();
      const speed = this.getSpeed();

      this.updateSpinAura(); // spin glow (runs every frame; fades out at rest)

      // Flight air-drag (LINEAR_DAMPING, calibrated for carry) also over-brakes a
      // grounded roll, killing roll-out. Drop to a low rolling damping while on the
      // ground so the ball releases into real roll (ROLL_BRAKE + slope still settle
      // it); restore full air-drag when airborne. Toggle on state change only.
      const airborne = height > PhysicsConfig.AIRBORNE_HEIGHT;
      if (airborne !== this._airborneNow) {
        this._airborneNow = airborne;
        this.body.setLinearDamping(
          airborne
            ? PhysicsConfig.BALL_LINEAR_DAMPING
            : CONFIG.BALL.ROLL_LINEAR_DAMPING,
        );
      }

      if (height < PhysicsConfig.GROUND_CONTACT_HEIGHT && !this.touchedGround) {
        this.touchedGround = true;
        this.pendingSpinAmount = 0;
        this.pendingSpinAxis = BABYLON.Vector3.Zero();
        return "firstContact";
      }

      if (
        speed < PhysicsConfig.LANDED_SPEED_THRESHOLD &&
        this.getAngularVelocity().length() <
          CONFIG.PHYSICS.LANDED_ANGULAR_THRESHOLD &&
        height < PhysicsConfig.GROUND_CONTACT_HEIGHT &&
        this.touchedGround
      ) {
        if (!this.landed) {
          this.landed = true;
          this.body.setLinearVelocity(BABYLON.Vector3.Zero());
          this.body.setAngularVelocity(BABYLON.Vector3.Zero());
          return "fullLand";
        }
      }

      if (height > PhysicsConfig.AIRBORNE_HEIGHT && this.touchedGround) {
        this.touchedGround = false;
      }

      return null;
    }

    isAirborne() {
      return this.getHeight() > PhysicsConfig.AIRBORNE_HEIGHT;
    }

    isLanded() {
      return this.landed;
    }

    // === CHARACTER METHODS ===
    async loadFaceTextures() {
      if (this.scene && this.scene.meshes) {
        this.faceMesh = this.scene.meshes.find(
          (m) => m.name && m.name.toLowerCase().includes("face"),
        );
      }

      if (!this.faceMesh) {
        return;
      }

      this.faceMaterial = this.faceMesh.material;

      const textureMap = {
        default: null,
        hit: "grimace.png",
        ascending: "elated.png",
        descending: "woah.png",
        collision: "o.png",
      };

      for (const [name, filename] of Object.entries(textureMap)) {
        if (!filename) continue;
        try {
          this.faceTextures[name] = Balls.faceTexture(this.scene, filename);
        } catch (e) {
          console.warn(`Face texture "${filename}" failed to load:`, e);
        }
      }

      if (this.faceMaterial) {
        if (this.faceMaterial.albedoTexture) {
          this.faceTextures["default"] = this.faceMaterial.albedoTexture;
        } else if (this.faceMaterial.diffuseTexture) {
          this.faceTextures["default"] = this.faceMaterial.diffuseTexture;
        }
        // Locker-room drawn face replaces the resting smile as "default", so the
        // flight expressions (grimace/elated/woah/o) still override + restore it.
        const styleFace = BallsStyle.loadStyle().face;
        if (styleFace) {
          const t = BallsStyle.faceTextureFromDataURL(this.scene, styleFace);
          if (t) {
            this.faceTextures["default"] = t;
            if (this.faceMaterial.albedoTexture !== undefined) {
              this.faceMaterial.albedoTexture = t;
            } else if (this.faceMaterial.diffuseTexture) {
              this.faceMaterial.diffuseTexture = t;
            }
          }
        }
      }
    }

    // Locker-room hat + ball skin (the face part lives in loadFaceTextures).
    applyStyle(style) {
      const st = BallsStyle.normalizeStyle(style);
      BallsStyle.applySkin(this.scene, this.scene.meshes, st.skin, st.skinImg);
      if (this.hatMount) this.hatMount.dispose(false, true);
      this.hatMount = null;
      const hat = BallsStyle.buildHat(this.scene, st.hat);
      if (hat) {
        this.hatMount = new BABYLON.TransformNode("hatMount", this.scene);
        // Parent the hat to the spin bone's node so it tracks the head exactly —
        // during flight the whole character tumbles via this bone, and the node
        // already carries the model's 0.0254 scale. (Parenting to the body mesh
        // instead and mirroring the spin drifts off: the bone's bind pose is
        // rotated 180° about Y, so a LOCAL-space spin axis maps to a mirrored
        // world axis and the hat and head diverge.) Fall back to the body mesh
        // if the skeleton is missing.
        const boneNode =
          this.spinBone && this.spinBone.getTransformNode
            ? this.spinBone.getTransformNode()
            : null;
        if (boneNode) {
          this.hatMount.parent = boneNode;
          this.hatMount.rotationQuaternion = BABYLON.Quaternion.RotationAxis(
            BABYLON.Axis.Y,
            Math.PI,
          ); // undo the bone's 180°-Y bind so the hat faces forward
        } else {
          // characterRoot (not the physics mesh) so the hat turns with aim facing
          this.hatMount.parent = this.characterRoot || this.mesh;
          this.hatMount.scaling.setAll(0.0254); // gball model units -> metres
        }
        hat.parent = this.hatMount;
        for (const m of hat.getChildMeshes(false)) m.isPickable = false;
        Utils.addShadowCasters(
          hat.getChildMeshes(false),
          this.scene.shadowGenerator,
        );
      }
    }

    initializeEyelids() {
      if (!this.mesh) return;

      // Find the eyelids mesh WITHIN the ball's own hierarchy. A scene-wide search
      // grabs the bird flock's eyelids (bird0_eyelids…, spawned on the course) first,
      // so the ball would end up blinking a bird instead of itself.
      this.eyelidsMesh = this.mesh
        .getChildMeshes(false)
        .find(
          (m) =>
            m.name &&
            m.name.toLowerCase().includes("eyelid") &&
            m.morphTargetManager,
        );

      const mgr = this.eyelidsMesh && this.eyelidsMesh.morphTargetManager;
      if (mgr) {
        this.blink = Balls.newBlinkState();
        this.blinkMorphIdx = Balls.findBlinkMorphIndex(mgr);
      }
    }

    initializeEyes(skeleton) {
      if (!skeleton || skeleton.bones.length === 0) return;

      const boneL = skeleton.bones.find(
        (b) => b.name && b.name.toLowerCase().includes("eye.l"),
      );
      const boneR = skeleton.bones.find(
        (b) => b.name && b.name.toLowerCase().includes("eye.r"),
      );

      if (boneL) {
        this.eyeL = boneL.getTransformNode?.() || boneL;
        this.eyeLRest = this.eyeL?.rotationQuaternion?.clone?.() ?? null;
      }

      if (boneR) {
        this.eyeR = boneR.getTransformNode?.() || boneR;
        this.eyeRRest = this.eyeR?.rotationQuaternion?.clone?.() ?? null;
      }
    }

    updateEyeGaze(cameraPosition, dt) {
      if (!this.eyeL || !this.eyeR) return;
      if (!this.eyeLRest || !this.eyeRRest) return;

      const charPos = this.getPosition();
      const dirToCamera = cameraPosition.subtract(charPos);
      dirToCamera.normalize();

      let targetYaw = Math.atan2(dirToCamera.x, dirToCamera.z);
      let targetPitch = -Math.asin(dirToCamera.y);

      targetYaw = Math.max(
        -CONFIG.EYES.MAX_YAW,
        Math.min(CONFIG.EYES.MAX_YAW, targetYaw),
      );
      targetPitch = Math.max(
        -CONFIG.EYES.MAX_PITCH,
        Math.min(CONFIG.EYES.MAX_PITCH, targetPitch),
      );

      const f = 1 - Math.exp(-CONFIG.EYES.LERP_SPEED * dt);
      this.eyeYaw += (targetYaw - this.eyeYaw) * f;
      this.eyePitch += (targetPitch - this.eyePitch) * f;

      const gazeQ = BABYLON.Quaternion.FromEulerAngles(
        this.eyePitch,
        this.eyeYaw,
        0,
      );

      if (this.eyeL && this.eyeLRest) {
        this.eyeL.rotationQuaternion = gazeQ.multiply(this.eyeLRest);
      }
      if (this.eyeR && this.eyeRRest) {
        this.eyeR.rotationQuaternion = gazeQ.multiply(this.eyeRRest);
      }
    }

    updateBlinking(dt) {
      const mgr = this.eyelidsMesh && this.eyelidsMesh.morphTargetManager;
      if (
        !mgr ||
        !this.blink ||
        this.blinkMorphIdx == null ||
        this.blinkMorphIdx < 0
      )
        return;
      const target = mgr.getTarget(this.blinkMorphIdx);
      if (target) target.influence = Balls.updateBlink(this.blink, dt);
    }

    setFace(name, duration = 0) {
      if (this.currentFace === name) return;
      if (!this.faceMaterial || !this.faceTextures[name]) return;

      this.currentFace = name;
      const tex = this.faceTextures[name];

      if (this.faceMaterial.albedoTexture !== undefined) {
        this.faceMaterial.albedoTexture = tex;
      } else if (this.faceMaterial.diffuseTexture) {
        this.faceMaterial.diffuseTexture = tex;
      }

      if (duration > 0) {
        this.faceTransitionTimer = duration;
        this.nextFace = "default";
      } else {
        this.faceTransitionTimer = 0;
        this.nextFace = null;
      }
    }

    startSpinTransition() {
      this.spinTransitionActive = true;
      this.spinTransitionTimer = 0;
    }

    updateFaces(dt) {
      if (this.spinTransitionActive) {
        this.spinTransitionTimer += dt;
        if (this.spinTransitionTimer >= this.spinTransitionDuration) {
          this.spinTransitionActive = false;
          this.spinTransitionTimer = 0;
        }
      }

      if (this.faceTransitionTimer > 0) {
        this.faceTransitionTimer -= dt;
        if (this.faceTransitionTimer <= 0 && this.nextFace) {
          this.setFace(this.nextFace, 0);
        }
      }
    }

    animateSpin(spinAxis, spinAmount) {
      if (!this.spinBone) return;
      const spinSpeed = spinAmount * PhysicsConfig.SPIN_ANIMATION_SPEED;
      // The hat is parented to this bone's node (see applyStyle), so it tumbles
      // with the head automatically — no separate rotation needed.
      this.spinBone.rotate(spinAxis, spinSpeed, BABYLON.Space.LOCAL);
    }

    hasSpinBone() {
      return this.spinBone !== null;
    }

    // === ROTATION METHODS ===
    setFacingAim(aimDirection) {
      this.targetRotation = aimDirection + Math.PI;
      this.facingAimDirection = true;
    }

    setFacingCamera(cameraPosition) {
      const charPos = this.getPosition();
      const dirToCamera = cameraPosition.subtract(charPos);
      this.targetRotation = Math.atan2(dirToCamera.x, dirToCamera.z);
      this.facingAimDirection = false;
    }

    updateRotation(lerpSpeed = 0.1) {
      // The physics body owns this.mesh's rotationQuaternion (re-synced from the
      // body every step, and the Euler .rotation is ignored once a quaternion is
      // set), so writing this.mesh.rotation.y does nothing. Instead, counter-rotate
      // the visual characterRoot so the character's WORLD orientation becomes a
      // pure upright yaw of targetRotation, whatever tumble the body ended on.
      const root = this.characterRoot;
      const bodyQ = this.mesh.rotationQuaternion;
      if (!root || !bodyQ) return;
      const desiredWorld = BABYLON.Quaternion.RotationAxis(
        BABYLON.Axis.Y,
        this.targetRotation,
      );
      const targetLocal =
        BABYLON.Quaternion.Inverse(bodyQ).multiply(desiredWorld);
      if (!root.rotationQuaternion)
        root.rotationQuaternion = BABYLON.Quaternion.Identity();
      BABYLON.Quaternion.SlerpToRef(
        root.rotationQuaternion,
        targetLocal,
        lerpSpeed,
        root.rotationQuaternion,
      );
    }

    // === GENERAL METHODS ===
    reset() {
      this.mesh.position = this.startPosition.clone();
      this.mesh.rotation = BABYLON.Vector3.Zero();
      // .rotation alone is inert once physics has set a rotationQuaternion; reset
      // that too (the pre-step dance below pushes it into the body), and clear any
      // aim-facing offset on the visual root.
      if (this.mesh.rotationQuaternion)
        this.mesh.rotationQuaternion.set(0, 0, 0, 1);
      if (this.characterRoot?.rotationQuaternion)
        this.characterRoot.rotationQuaternion.set(0, 0, 0, 1);
      this.body.setLinearVelocity(BABYLON.Vector3.Zero());
      this.body.setAngularVelocity(BABYLON.Vector3.Zero());
      // Teleport the physics body to the new spot: let it read the mesh transform
      // for a few physics steps, then hand position control back to the simulation.
      if (this.body) {
        this.body.disablePreStep = false;
        this._teleportRestoreFrames = 3;
        this.mesh.computeWorldMatrix(true);
      }
      this.landed = true;
      this.touchedGround = false;
      this.pendingSpinAmount = 0;
      this.pendingSpinAxis = BABYLON.Vector3.Zero();
      this.targetRotation = 0;
      this.facingAimDirection = false;
      this._inCup = false;
    }

    // Teleport the physics body to a new spot (e.g. dropping into the cup): let the
    // body read the mesh transform for a couple of physics steps, then hand control
    // back to the simulation (same dance as reset()).
    teleport(x, y, z, zeroVel = true) {
      this.mesh.position.set(x, y, z);
      if (zeroVel && this.body) {
        this.body.setLinearVelocity(BABYLON.Vector3.Zero());
        this.body.setAngularVelocity(BABYLON.Vector3.Zero());
      }
      if (this.body) {
        this.body.disablePreStep = false;
        this._teleportRestoreFrames = 2;
        this.mesh.computeWorldMatrix(true);
      }
    }
  }

  // ─── BALL TRAIL ──────────────────────────────────────────────────────────────

  class BallTrail {
    constructor(scene, maxPoints = 1000, maxAge = null) {
      this.scene = scene;
      this.positions = [];
      this.timestamps = [];
      this.maxPoints = maxPoints;
      this.maxAge = maxAge;
      this.line = null;
      this.isTracing = false;
      this._visible = false;
      this.minDistanceBetweenPoints = CONFIG.TRAIL.MIN_DISTANCE_BETWEEN_POINTS;
      this.updateCounter = 0;
      this.updateFrequency = CONFIG.TRAIL.UPDATE_FREQUENCY;
    }

    startTracing() {
      this.isTracing = true;
    }

    stopTracing() {
      this.isTracing = false;
    }

    addPoint(position) {
      if (!this.isTracing) return;

      const now = Date.now();

      if (this.positions.length > 0) {
        const lastPos = this.positions[this.positions.length - 1];
        const distance = BABYLON.Vector3.Distance(position, lastPos);
        if (distance < this.minDistanceBetweenPoints) {
          return;
        }
      }

      this.positions.push(position.clone());
      this.timestamps.push(now);

      while (this.positions.length > this.maxPoints) {
        this.positions.shift();
        this.timestamps.shift();
      }

      // Only update line every N points to reduce lag
      this.updateCounter++;
      if (this.updateCounter >= this.updateFrequency) {
        this.updateLine();
        this.updateCounter = 0;
      }
    }

    updateLine() {
      if (this.positions.length < 2) {
        return;
      }

      // Update ONE updatable LinesMesh in place rather than disposing + rebuilding
      // a fresh mesh (new vertex buffer + GC) on every point. The buffer is a fixed
      // maxPoints size; unused tail slots repeat the tip (degenerate segments), so
      // the vertex count never changes and we can pass `instance:`.
      const pts = this.positions;
      const cap = this.maxPoints;
      const buf = this._lineBuf || (this._lineBuf = new Array(cap));
      const tip = pts[pts.length - 1];
      for (let i = 0; i < cap; i++) buf[i] = i < pts.length ? pts[i] : tip;

      if (!this.line) {
        this.line = BABYLON.MeshBuilder.CreateLines(
          "trail",
          { points: buf, updatable: true },
          this.scene,
        );
        this.line.color = new BABYLON.Color3(1, 0.15, 0.15);
        this.line.alpha = 0.95;
        this.line.isPickable = false;
      } else {
        this.line = BABYLON.MeshBuilder.CreateLines(
          "trail",
          { points: buf, instance: this.line },
          this.scene,
        );
      }
      this.line.setEnabled(this._visible);
    }

    setVisible(visible) {
      this._visible = visible;
      if (this.line) this.line.setEnabled(visible);
    }

    update(currentPosition) {
      this.addPoint(currentPosition);
    }

    clear() {
      if (this.line) {
        this.line.dispose();
        this.line = null;
      }
      this.positions = [];
      this.timestamps = [];
      this.isTracing = false;
      this.updateCounter = 0;
    }
  }

  Object.assign(global, { GolfBallGuy, BallTrail });
  if (typeof module !== "undefined" && module.exports)
    module.exports = { GolfBallGuy, BallTrail };
})(typeof globalThis !== "undefined" ? globalThis : this);
