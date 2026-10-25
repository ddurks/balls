// character.js — GolfBallGuy, BallTrail.
// Split out of game.js; loaded as a plain <script> before game.js (see game.html),
// and require()-able in Node for unit tests. Cross-module refs resolve via globals.
(function (global) {
  // ─── CHARACTER (GOLF BALL WITH ANIMATIONS) ─────────────────────────────────

  class GolfBallGuy {
    // Havok handles ordinary contacts; a native sphere sweep recovers fast misses.
    static TUNNEL_GUARD_MIN_SPEED = 6;
    // How far past a swept surface a step may end before it counts as a miss.
    static TUNNEL_DEPTH = 0.01;
    // At rest = in ground contact with speed and spin this low for REST_STEPS
    // consecutive physics steps. The rolling law, not a snap, brings it there.
    static REST_SPEED = 0.01;
    static REST_SPIN = 1;
    static REST_STEPS = 6;
    // Normal speed into a surface that counts as a landing impact (applyTurfImpact).
    // A rolling ball meets the ground at ~g·dt ≈ 0.08 m/s per step.
    static IMPACT_SPEED = 1;
    // Speed away from the surface at which the ball is leaving it (a bounce).
    static LEAVING_SPEED = 0.5;
    // Havok reports one contact per body pair per step, so a ball touching two
    // faces of the same mesh (a valley crease) sees them on alternate steps. The
    // support normal is the mean of this many recent contact normals.
    static SUPPORT_STEPS = 16;
    // Contact normals within 2° of each other count as one plane.
    static SAME_PLANE_COS = Math.cos((2 * Math.PI) / 180);
    // Below this speed turf grips a ball like a stopped one (see the hold in
    // applyRollingResistance), so a crawl near the hold angle ends instead of
    // inching on for tens of seconds.
    static STATIC_CATCH_SPEED = 0.02;
    // A ball on the ground crawling slower than that this long is at rest,
    // held or not (see updateGroundContact).
    static STILL_SECONDS = 2;
    // Turf's grip radius for spin about the contact normal (twistDecel). Grass
    // blades grip well beyond the ball's geometric contact patch; this is sized
    // so a capped sidespin dies within ~2 s of landing rather than pirouetting.
    static TURF_TWIST_RADIUS = 0.04;
    // Havok decelerates any contact slower than this by HAVOK_SLOW_CONTACT_DECEL
    // (m/s², linear) by itself; see restoreSlowRoll.
    static HAVOK_SLOW_CONTACT_SPEED = 0.1;
    static HAVOK_SLOW_CONTACT_DECEL = 0.3;

    constructor(mesh, physicsBody, skeleton, scene) {
      this.mesh = mesh;
      this.body = physicsBody;
      this.startPosition = mesh.position.clone();
      this.landed = true;
      // From applyHit until that shot's rest; a reset/drop is not a shot.
      this.inShot = false;
      this.touchedGround = false;
      // Ground contact comes from Havok's collision events (see the observer below).
      this._onGround = false;
      this._contactPhysics = null; // SURFACE_PHYSICS of the stamped surface touched
      this._contactNormal = new BABYLON.Vector3(0, 1, 0);
      this._supportNormals = Array.from(
        { length: GolfBallGuy.SUPPORT_STEPS },
        () => new BABYLON.Vector3(),
      );
      this._supportCount = 0;
      this._restSteps = 0;
      this._crawlSteps = 0;
      this._grip = 0; // see applyTurfImpact
      this._topGrip = 0;
      this._shotDir = new BABYLON.Vector3(); // horizontal launch line (applyHit)
      this._restSpin = new BABYLON.Vector3();
      this._rrRoll = new BABYLON.Vector3();
      this._heldThisStep = false;
      this.wind = null; // Wind, set by the game; tests run without it
      // Terrain height directly under the ball. CourseManager updates this each
      // frame so height readouts are relative to the ground below, not world Y.
      this.heightRef = 0;

      // Teleport support: reset() flips disablePreStep off so the body follows the
      // mesh for a few physics steps; updateLandingState() restores it afterward.
      this._teleportRestoreFrames = 0;
      this._inCup = false; // sitting in a real cavity cup — exempt from preventTunneling
      this.pendingSpinAmount = 0;

      this.skeleton = skeleton;
      this.spinBone = null;
      this.scene = scene;
      // Ball values are 1, so MULTIPLY hands every contact the surface's own value
      // (Havok's defaults, MINIMUM friction / MAXIMUM restitution, let the ball win).
      this._material = {
        ...this.body.shape.material,
        friction: PhysicsConfig.BALL_FRICTION,
        frictionCombine: BABYLON.PhysicsMaterialCombineMode.MULTIPLY,
        restitution: PhysicsConfig.BALL_RESTITUTION,
        restitutionCombine: BABYLON.PhysicsMaterialCombineMode.MULTIPLY,
      };
      this.body.shape.material = this._material;
      this._frictionlessMaterial = { ...this._material, friction: 0 };
      this._stepStart = mesh.position.clone();
      this._stepEnd = mesh.position.clone();
      this._stepStartVel = new BABYLON.Vector3();
      this._renderPos = new BABYLON.Vector3();
      this._renderOffset = new BABYLON.Vector3();
      this._renderQ = new BABYLON.Quaternion();
      this.body.setCollisionCallbackEnabled(true);
      this.body.getCollisionObservable().add((e) => {
        this._collidedThisStep = true;
        const phys = e.collidedAgainst.transformNode?._surfacePhysics;
        if (phys) {
          this._contactPhysics = phys;
          // While held, keep the support the ball came to rest on (static
          // friction persists); Havok's normals at rest can wander off it.
          if (!this._heldThisStep) this.addSupportNormal(e.normal);
        } else if (
          e.point &&
          !this._heldThisStep &&
          this.getSpeed() < GolfBallGuy.HAVOK_SLOW_CONTACT_SPEED
        ) {
          // A rock, trunk or flagstick the ball has come to lean on supports
          // it too: wedged against one on a slope the turf alone can't hold,
          // it is at rest. It still rolls by the turf's plane and law.
          this.addSupportNormal(e.normal, e.point);
        }
      });
      // The single per-physics-step hook: forces and the rolling law run at the fixed
      // STEP_SECONDS, so behaviour is the same at any render frame rate.
      scene.onBeforePhysicsObservable.add(() => {
        // mesh.position, not getAbsolutePosition(): the world matrix is only
        // recomputed per rendered frame, but this runs every physics sub-step.
        this._stepStart.copyFrom(this.mesh.position);
        this.body.getLinearVelocityToRef(this._stepStartVel);
        this._collidedThisStep = false;
        this._heldThisStep = false;
        if (this._onGround) {
          this.applyRollingResistance(PhysicsConfig.STEP_SECONDS);
        } else if (!this.landed) {
          if (this.wind) this.applyWind();
          this.applyMagnus();
        }
      });
      scene.onAfterPhysicsObservable.add(() => {
        if (this._frictionless) {
          this._frictionless = false;
          this.body.shape.material = this._material;
        }
        this.applyTurfImpact();
        this.releaseContactFriction();
        this.restoreSlowRoll();
        this.updateGroundContact();
        this.preventTunneling();
        if (
          this._teleportRestoreFrames > 0 &&
          --this._teleportRestoreFrames === 0
        ) {
          this.body.disablePreStep = true;
        }
        this._stepEnd.copyFrom(this.mesh.position);
      });

      this.faceMesh = null;
      this.faceMaterial = null;
      this.faceTextures = {};
      this.currentFace = "default";
      this.faceTransitionTimer = 0;
      this.nextFace = null;

      this.spinTransitionActive = false;
      this.spinTransitionTimer = 0;
      this.spinTransitionDuration = 0.4;

      this.targetRotation = 0;
      this.facingAimDirection = false;
      // Visual root the character meshes hang from (set up in loadCharacter).
      // Facing is applied here, not on this.mesh — see updateVisualRotation.
      this._visualQ = BABYLON.Quaternion.Identity();
      // Havok syncs into the Euler .rotation while there's no quaternion, and
      // updateVisualRotation needs the body's orientation as one.
      if (!mesh.rotationQuaternion)
        mesh.rotationQuaternion = BABYLON.Quaternion.FromEulerVector(
          mesh.rotation,
        );
      this._visualTmp = new BABYLON.Quaternion();
      this._visualW = new BABYLON.Vector3();
      this.characterRoot = null;
      // Strike squash (see initSquash/updateSquash). t ≥ DURATION = at rest.
      this._squashOuter = null;
      this._squashInner = null;
      this._squashT = Infinity;
      this._squashAmp = 0;
      this._squashDir = new BABYLON.Vector3(0, 1, 0);
      this._squashQ = new BABYLON.Quaternion();

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

    // Where the ball is drawn this frame. Physics steps at a fixed 120 Hz, so a
    // frame lands 0..N steps after the last one and the raw step position makes a
    // fast ball judder by up to a step (~0.6 m off a driver). Blend the last
    // step's start→end by the time Babylon's accumulator has left over instead:
    // a constant one-step lag, smooth at any frame rate.
    getRenderPosition() {
      const p = this.mesh.position;
      // Moved outside a physics step (reset, teleport): nothing to blend from.
      if (!p.equals(this._stepEnd)) return p;
      const alpha = Math.min(
        (this.scene._physicsTimeAccumulator || 0) /
          (PhysicsConfig.STEP_SECONDS * 1000),
        1,
      );
      return BABYLON.Vector3.LerpToRef(
        this._stepStart,
        p,
        alpha,
        this._renderPos,
      );
    }

    // Draw the visible ball at getRenderPosition() without moving the physics
    // body: shift its visual children by the difference, expressed in the body's
    // rotated frame (they hang off this.mesh). Once per rendered frame.
    applyRenderOffset() {
      const off = this.getRenderPosition().subtractToRef(
        this.mesh.position,
        this._renderOffset,
      );
      this.mesh.rotationQuaternion.conjugateToRef(this._renderQ);
      off.rotateByQuaternionToRef(this._renderQ, off);
      (this._squashOuter || this.characterRoot)?.position.copyFrom(off);
      this.spinAura?.position.copyFrom(off);
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

    // Aerodynamic lift/curve from spin (Magnus): F = coeff·(ω × v), applied while
    // airborne. Backspin lifts (float/carry), topspin drops, sidespin curves the
    // shot (slice/hook). This is what makes spin shape the path of travel.
    applyMagnus() {
      const f = this._magnus || (this._magnus = new BABYLON.Vector3());
      this.body.applyForce(this.magnusForceToRef(f), this.getPosition());
    }

    // Wind acts through the air flowing past the ball, so its push grows with
    // the ball's airspeed, up to the tuned full-shot force at FULL_FORCE_SPEED: a
    // slow hop off the turf barely feels it (a constant force rolled bounces off
    // sideways). Full shots fly faster than that nearly all the way.
    applyWind() {
      const f = this._windForce || (this._windForce = new BABYLON.Vector3());
      f.copyFrom(this.wind.getForceVector()).scaleInPlace(
        Math.min(1, this.getSpeed() / CONFIG.WIND.FULL_FORCE_SPEED),
      );
      this.body.applyForce(f, this.getPosition());
    }

    // Magnus force c·(ω × v), with its sideways (horizontal, ⟂ v) part scaled by
    // MAGNUS_SIDE_GAIN — see CONFIG.PHYSICS for why the two are tuned apart.
    magnusForceToRef(out) {
      const w = this._mgW || (this._mgW = new BABYLON.Vector3());
      const v = this._mgV || (this._mgV = new BABYLON.Vector3());
      this.body.getAngularVelocityToRef(w);
      this.body.getLinearVelocityToRef(v);
      BABYLON.Vector3.CrossToRef(w, v, out).scaleInPlace(
        CONFIG.PHYSICS.MAGNUS_COEFF,
      );
      // Horizontal unit ⟂ travel (v × up, up = +y).
      const sx = -v.z;
      const sz = v.x;
      const sLen = Math.hypot(sx, sz);
      if (sLen > 1e-6) {
        const side = (out.x * sx + out.z * sz) / sLen;
        const extra = ((CONFIG.PHYSICS.MAGNUS_SIDE_GAIN - 1) * side) / sLen;
        out.x += sx * extra;
        out.z += sz * extra;
      }
      return out;
    }

    // Unit direction of the Magnus push (ω × v), or zero when there is none to show.
    getMagnusDirection() {
      const f = this.magnusForceToRef(new BABYLON.Vector3());
      const len = f.length();
      return len > 1e-8 ? f.scaleInPlace(1 / len) : f.setAll(0);
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

    // `point` marks an obstacle's contact: a support, but not the plane the
    // ball rolls on.
    addSupportNormal(normal, point) {
      const n =
        this._supportNormals[this._supportCount++ % GolfBallGuy.SUPPORT_STEPS];
      n.copyFrom(normal);
      if (point) {
        // Turned toward the ball: a trunk's normal is level, so its y can't say.
        const c = this.mesh.position;
        const out =
          n.x * (c.x - point.x) + n.y * (c.y - point.y) + n.z * (c.z - point.z);
        if (out < 0) n.scaleInPlace(-1);
        return;
      }
      // The event normal's sign depends on which body Havok lists first.
      if (n.y < 0) n.scaleInPlace(-1);
      this._contactNormal.copyFrom(n);
    }

    // Whether all recent contacts were on (nearly) the current contact plane.
    supportIsPlane() {
      const count = Math.min(this._supportCount, GolfBallGuy.SUPPORT_STEPS);
      for (let i = 0; i < count; i++) {
        const c = BABYLON.Vector3.Dot(
          this._supportNormals[i],
          this._contactNormal,
        );
        if (c < GolfBallGuy.SAME_PLANE_COS) return false;
      }
      return true;
    }

    // Cosine of the steepest slope the recent contacts can support the ball on
    // together: the most upright direction in the cone of their normals. One face
    // gives its own normal; the two faces of a valley crease give the vertical
    // between them, so a ball resting in the crease is held although neither face
    // alone could hold it.
    // (Gravity is −y, so "upright" is a normal's y.)
    supportUpright() {
      const list = this._supportNormals;
      const count = Math.min(this._supportCount, GolfBallGuy.SUPPORT_STEPS);
      let best = 0;
      for (let i = 0; i < count; i++) {
        const a = list[i];
        best = Math.max(best, a.y);
        for (let j = i + 1; j < count; j++) {
          const b = list[j];
          const c = BABYLON.Vector3.Dot(a, b);
          if (c > 0.9999) continue;
          // Up projected onto span{a, b} is α·a + β·b; inside the cone when both
          // are ≥ 0, and its length² is then α·a.y + β·b.y.
          const ua = a.y;
          const ub = b.y;
          const alpha = (ua - c * ub) / (1 - c * c);
          const beta = (ub - c * ua) / (1 - c * c);
          if (alpha < 0 || beta < 0) continue;
          best = Math.max(best, Math.sqrt(alpha * ua + beta * ub));
        }
      }
      return best;
    }

    setOnGround(onGround) {
      this._onGround = onGround;
      // Keep the support history through a brief hop (a crease's edge can
      // kick the ball off for a step); teleports and strikes clear it.
      if (!onGround) this._contactPhysics = null;
      // Damping is the air-drag model: none on the ground, where the surface's
      // rolling resistance is the only drag. On the ground the rolling law
      // applies gravity itself.
      this.body.setGravityFactor(onGround ? 0 : 1);
      this.body.setLinearDamping(
        onGround ? 0 : PhysicsConfig.BALL_LINEAR_DAMPING,
      );
      this.body.setAngularDamping(
        onGround ? 0 : PhysicsConfig.BALL_ANGULAR_DAMPING,
      );
    }

    // Ground contact for the step just taken. Havok reports a collision event every
    // step while touching — except for a sleeping body, which reports nothing but
    // also isn't moving, so a still ball keeps its last state.
    updateGroundContact() {
      const speed = this.getSpeed();
      this.body.getAngularVelocityToRef(this._restSpin);
      const onGround =
        this._collidedThisStep || (this._onGround && speed < 1e-3);
      if (onGround !== this._onGround) this.setOnGround(onGround);
      // On a stamped surface only the rolling law's hold counts as rest, so a ball
      // easing off a slope it can't hold is never mistaken for a stopped one.
      const resting =
        onGround &&
        (this._contactPhysics ? this._heldThisStep : true) &&
        speed < GolfBallGuy.REST_SPEED &&
        this._restSpin.length() < GolfBallGuy.REST_SPIN;
      this._restSteps = resting ? this._restSteps + 1 : 0;
      // The rolling law holds a crawl this slow wherever the turf can hold
      // the slope, so a ball that keeps crawling, or sits spinning, is held by
      // something it doesn't model (caught between two surface meshes where
      // a fairway's edge overlaps the rough, say) and would never be called
      // at rest. After STILL_SECONDS it is, where it lies, spin and all.
      this._crawlSteps =
        onGround && !this.landed && speed < GolfBallGuy.STATIC_CATCH_SPEED
          ? this._crawlSteps + 1
          : 0;
      if (
        this._crawlSteps * PhysicsConfig.STEP_SECONDS >=
        GolfBallGuy.STILL_SECONDS
      ) {
        this.body.setLinearVelocity(BABYLON.Vector3.Zero());
        this.body.setAngularVelocity(BABYLON.Vector3.Zero());
        this._restSteps = GolfBallGuy.REST_STEPS;
      }
    }

    /**
     * Rolling law, once per physics step while in ground contact. The ball's
     * gravity is applied here (Havok's is off on the ground — see
     * updateGroundContact), then the contact absorbs up to μr·g·dt of the
     * resulting tangential velocity: at any speed, never past zero. A ball whose
     * gravity pull fits inside that budget therefore stays exactly put, and one
     * that doesn't rolls on. The braking acts on linear velocity; Havok's contact
     * friction shares it with the spin, so a rolling ball feels 5/7 of it — the
     * same factor as slope gravity. Net: rest on any slope up to asin(μr), else
     * accelerate at 5/7·g·(sinθ − μr); on the flat decelerate at 5/7·μr·g.
     * (Applying gravity ourselves matters: pre-cancelling Havok's own gravity
     * lets its friction see the slope pull mid-step and creep the ball.)
     */
    applyRollingResistance(dt) {
      const phys = this._contactPhysics;
      const n = this._contactNormal;
      const g = PhysicsConfig.GRAVITY;
      const v = this._rrLin || (this._rrLin = new BABYLON.Vector3());
      this.body.getLinearVelocityToRef(v);
      v.x += g.x * dt;
      v.y += g.y * dt;
      v.z += g.z * dt;
      this._slowRollExpected = false;
      let vn = BABYLON.Vector3.Dot(v, n);
      // No surface law to apply, or the ball is leaving the surface (struck, or
      // bouncing off): gravity only.
      if (!phys || vn > 0) {
        this.body.setLinearVelocity(v);
        return;
      }
      let tx = v.x - n.x * vn;
      let ty = v.y - n.y * vn;
      let tz = v.z - n.z * vn;
      const hs = Math.hypot(tx, ty, tz);
      const w = this._rrAng || (this._rrAng = new BABYLON.Vector3());
      this.body.getAngularVelocityToRef(w);
      // Spinning friction about the contact normal (see twistDecel).
      const wn = BABYLON.Vector3.Dot(w, n);
      const r = CONFIG.BALL.COLLIDER_DIAMETER / 2;
      const spinCut = Math.min(Math.abs(wn), GolfBallGuy.twistDecel(phys) * dt);
      if (spinCut > 0) {
        n.scaleAndAddToRef(-Math.sign(wn) * spinCut, w);
        this.body.setAngularVelocity(w);
      }
      // The slope's pull (gravity along the surface), and the motion before it.
      const gn = BABYLON.Vector3.Dot(g, n);
      const px = g.x - n.x * gn;
      const py = g.y - n.y * gn;
      const pz = g.z - n.z * gn;
      const pull = Math.hypot(px, py, pz);
      const moving = Math.hypot(tx - px * dt, ty - py * dt, tz - pz * dt);
      // Above putting speeds a ball hops and skids through grass rather than
      // rolling over it: the surface's turfDrag (1/s) adds to the budget there.
      // Judged on the speed it will roll at, so a putt launched sliding (rolling
      // at 5/7 of its launch speed) stays under the threshold the whole way.
      const roll = this.rollingVelocity(tx, ty, tz, w, this._rrRoll).length();
      const budget =
        (phys.rollingResistance * g.length() +
          phys.turfDrag * Math.max(0, roll - phys.turfDragSpeed)) *
        dt;
      // Held when the ball has all but stopped (the rolling resistance can absorb
      // its motion this step, or it is down to a crawl turf grips like a stopped
      // ball) and the static resistance — larger, as turf's breakaway is — can
      // absorb the pull: rest on slopes up to asin(holdResistance), but once
      // moving keep rolling on slopes above asin(rollingResistance).
      const held =
        moving <=
          Math.max(
            phys.rollingResistance * g.length() * dt,
            GolfBallGuy.STATIC_CATCH_SPEED,
          ) &&
        (pull <= phys.holdResistance * g.length() ||
          Math.sqrt(Math.max(0, 1 - this.supportUpright() ** 2)) <=
            phys.holdResistance);
      if (!held) {
        const k = Math.max(0, hs - budget) / hs;
        tx *= k;
        ty *= k;
        tz *= k;
        // Remember the slow roll this should produce; see restoreSlowRoll.
        const u = this.rollingVelocity(tx, ty, tz, w, this._slowRoll);
        this._slowRoll = u;
        this._slowRollExpected =
          u.length() <= GolfBallGuy.HAVOK_SLOW_CONTACT_SPEED + 0.01;
      } else {
        tx = ty = tz = 0;
        // Stopped: end the leftover roll too — at these speeds Havok's friction
        // no longer turns it back into motion — but keep real spin (a backspin
        // bite) for friction to act on. Not on turf that never bites (spinGrip
        // 0): sand holds a ball plugged at any tilt, even in a bunker's
        // vertical lip, where nothing presses it on for friction to act and
        // the spin would last forever.
        if (
          w.length() * r <= GolfBallGuy.HAVOK_SLOW_CONTACT_SPEED ||
          !phys.spinGrip
        ) {
          this.body.setAngularVelocity(w.setAll(0));
          this._heldThisStep = true;
          // At rest it no longer presses into its support either: that is the
          // contact normal it came to rest on, kept while held (see the
          // collision observer), and where it differs from the face the ball
          // touches now, the push runs partly along that face and rolls the
          // ball on at a couple of cm/s for good.
          vn = 0;
        }
      }
      v.set(tx + n.x * vn, ty + n.y * vn, tz + n.z * vn);
      this.body.setLinearVelocity(v);
    }

    // A landing, once per impact (Havok spreads one over two steps). Applied here
    // rather than left to Havok: its solver gave a landing wedge only a fraction
    // of the friction the bounce allows, and replays it as the ball leaves.
    //  1. Pitch mark: turf gives way under the ball, costing impactLoss·vn of its
    //     forward motion (never pushing it backwards). It acts on the ball as a
    //     whole; the contact friction below then shares it with the spin.
    //  2. Coulomb friction at the contact point, up to μ·(1+e)·vn, never past
    //     rolling (slip/3.5) and never reversing the ball: it conserves the
    //     rolling speed (5v + 2Rω×n)/7, so heavy backspin stops the ball here and
    //     the skid that follows draws it back.
    //  3. Grip: the turf can only hold so much spin. Like friction, its grip
    //     scales with how hard the landing presses the ball in: the backward
    //     rolling speed backspin can produce is capped at spinGrip·(1+e)·vn, and
    //     the forward speed topspin can add at topspinGrip·(1+e)·vn, so stacked
    //     spin saturates and a soft, shallow landing bites or releases less.
    //  4. Twist: the impact's large contact force wrings out most spin about the
    //     contact normal (the same torsional friction as at rest, on (1+e)·vn).
    // Rolling and putting never reach IMPACT_SPEED.
    applyTurfImpact() {
      const phys = this._contactPhysics;
      if (!this._collidedThisStep || !phys || this._onGround) return;
      const n = this._contactNormal;
      const before = this._stepStartVel;
      const vn = -BABYLON.Vector3.Dot(before, n);
      if (vn < GolfBallGuy.IMPACT_SPEED) return;
      const r = CONFIG.BALL.COLLIDER_DIAMETER / 2;
      const v = this._impactVel || (this._impactVel = new BABYLON.Vector3());
      const w = this._impactSpin || (this._impactSpin = new BABYLON.Vector3());
      this.body.getLinearVelocityToRef(v);
      this.body.getAngularVelocityToRef(w);
      // Forward = the tangential direction the ball came in on.
      const f = this._impactDir || (this._impactDir = new BABYLON.Vector3());
      f.copyFrom(before).subtractInPlace(n.scale(-vn));
      const fLen = f.length();
      if (fLen > 1e-6) f.scaleInPlace(1 / fLen);
      else f.setAll(0);

      const ahead = BABYLON.Vector3.Dot(v, f);
      if (ahead > 0)
        f.scaleAndAddToRef(-Math.min(phys.impactLoss * vn, ahead), v);

      // Backspin and topspin are relative to the shot's line, not to however
      // the ball happens to be drifting when it comes down from a later hop.
      const shot =
        this._impactShot || (this._impactShot = new BABYLON.Vector3());
      shot.copyFrom(this._shotDir);
      shot.subtractInPlace(n.scale(BABYLON.Vector3.Dot(shot, n)));
      if (shot.lengthSquared() > 1e-6) shot.normalize();
      else shot.copyFrom(f);

      // Topspin's grip: the forward rolling speed spin beyond plain rolling can
      // add, 2/7·(R(ω×n) − v)·shot, is capped like backspin's by how hard the
      // landing pressed the ball in. (A ball that is simply rolling adds none.)
      const roll =
        this._impactRoll || (this._impactRoll = new BABYLON.Vector3());
      BABYLON.Vector3.CrossToRef(w, n, roll).scaleInPlace(r);
      this._topGrip = Math.max(
        this._topGrip,
        phys.topspinGrip * (1 + phys.restitution) * vn,
      );
      const added =
        (2 * (BABYLON.Vector3.Dot(roll, shot) - BABYLON.Vector3.Dot(v, shot))) /
        7;
      if (added > this._topGrip) {
        const ds = shot.scale(-3.5 * (added - this._topGrip));
        w.addInPlace(BABYLON.Vector3.Cross(n, ds).scaleInPlace(1 / r));
      }

      // Contact point velocity v + R·n × ω, tangential part.
      const slip =
        this._impactSlip || (this._impactSlip = new BABYLON.Vector3());
      BABYLON.Vector3.CrossToRef(n, w, slip).scaleInPlace(r).addInPlace(v);
      slip.subtractInPlace(n.scale(BABYLON.Vector3.Dot(slip, n)));
      const slipSpeed = slip.length();
      if (slipSpeed > 1e-6) {
        slip.scaleInPlace(1 / slipSpeed);
        let j = Math.min(
          phys.friction * (1 + phys.restitution) * vn,
          slipSpeed / 3.5,
        );
        const along = BABYLON.Vector3.Dot(slip, f);
        const fwd = BABYLON.Vector3.Dot(v, f);
        if (along > 1e-6) j = Math.min(j, Math.max(0, fwd) / along);
        slip.scaleAndAddToRef(-j, v);
        // Δω = (5j / 2R)·(n × ŝ)
        w.addInPlace(
          BABYLON.Vector3.Cross(n, slip).scaleInPlace((2.5 * j) / r),
        );
      }

      // Backward rolling speed this spin will produce: −shot·(5v + 2Rω×n)/7.
      const s = roll;
      BABYLON.Vector3.CrossToRef(w, n, s).scaleInPlace(r);
      const back =
        -(5 * BABYLON.Vector3.Dot(v, shot) + 2 * BABYLON.Vector3.Dot(s, shot)) /
        7;
      // The shot's hardest landing sets the grip; the small hops that follow
      // can't lower it.
      this._grip = Math.max(
        this._grip,
        phys.spinGrip * (1 + phys.restitution) * vn,
      );
      const grip = this._grip;
      if (back > grip) {
        // Raise the spin's surface speed along the shot by 7/2 of the excess.
        const ds = shot.scale(3.5 * (back - grip));
        w.addInPlace(BABYLON.Vector3.Cross(n, ds).scaleInPlace(1 / r));
      }

      const wn = BABYLON.Vector3.Dot(w, n);
      const twist = Math.min(
        Math.abs(wn),
        (GolfBallGuy.twistDecel(phys) * ((1 + phys.restitution) * vn)) /
          -PhysicsConfig.GRAVITY.y,
      );
      n.scaleAndAddToRef(-Math.sign(wn) * twist, w);

      this.body.setLinearVelocity(v);
      this.body.setAngularVelocity(w);
      this.skipFrictionNextStep();
    }

    // Spin about the contact normal lost per second resting on `phys` (rad/s²):
    // torsional friction (3π/16)·μ·m·g·a over the turf's grip radius a, divided
    // by I = 2/5·m·R². Havok has none, so without it a sidespun ball never rests.
    static twistDecel(phys) {
      const r = CONFIG.BALL.COLLIDER_DIAMETER / 2;
      return (
        (((15 * Math.PI) / 32) *
          phys.friction *
          -PhysicsConfig.GRAVITY.y *
          GolfBallGuy.TURF_TWIST_RADIUS) /
        (r * r)
      );
    }

    // Havok warm-starts a contact with the impulses it solved the step before. On
    // the step a ball leaves the turf (struck, or bouncing off it) that replays the
    // landing's whole friction impulse again — measured: a backspinning wedge
    // flipped from ωR = 2 m/s of backspin to 6 m/s of overspin as it bounced. The
    // ball is frictionless for that one step; it is leaving the contact anyway.
    releaseContactFriction() {
      if (!this._collidedThisStep) return;
      const v = this._impactVel || (this._impactVel = new BABYLON.Vector3());
      this.body.getLinearVelocityToRef(v);
      if (
        BABYLON.Vector3.Dot(v, this._contactNormal) > GolfBallGuy.LEAVING_SPEED
      )
        this.skipFrictionNextStep();
    }

    skipFrictionNextStep() {
      this._frictionless = true;
      this.body.shape.material = this._frictionlessMaterial;
    }

    // The ball's speed once contact friction has made it roll without slipping:
    // (5·v + 2·R·ω×n) / 7, which that friction can't change (it conserves angular
    // momentum about the contact point). Tangential v is (tx, ty, tz).
    rollingVelocity(tx, ty, tz, w, out) {
      const n = this._contactNormal;
      const r = CONFIG.BALL.COLLIDER_DIAMETER / 2;
      out = out || new BABYLON.Vector3();
      return out.set(
        (5 * tx + 2 * r * (w.y * n.z - w.z * n.y)) / 7,
        (5 * ty + 2 * r * (w.z * n.x - w.x * n.z)) / 7,
        (5 * tz + 2 * r * (w.x * n.y - w.y * n.x)) / 7,
      );
    }

    // Havok brakes any contact slower than ~0.1 m/s by about 0.3 m/s² by itself
    // (friction-, shape- and mass-independent; measured with Havok 1.3.12). Left
    // in, it would stall balls near the hold angle and make μr alone not decide
    // how they roll, so after a step that should have kept a slow roll, give
    // back what it took.
    restoreSlowRoll() {
      if (!this._slowRollExpected || !this._collidedThisStep) return;
      this._slowRollExpected = false;
      // Only on a single plane: in a crease the faces' collisions take speed too,
      // and refunding those would keep a rocking ball going.
      if (!this.supportIsPlane()) return;
      const n = this._contactNormal;
      const v = this._rrLin;
      const w = this._rrAng;
      this.body.getLinearVelocityToRef(v);
      this.body.getAngularVelocityToRef(w);
      const vn = BABYLON.Vector3.Dot(v, n);
      const u = this.rollingVelocity(
        v.x - n.x * vn,
        v.y - n.y * vn,
        v.z - n.z * vn,
        w,
        this._slowRollNow,
      );
      this._slowRollNow = u;
      const want = this._slowRoll;
      const speed = want.length();
      const lost = speed - BABYLON.Vector3.Dot(u, want) / speed;
      // Its brake is linear, so the rolling speed loses exactly 5/7 of it, or all
      // of a slower roll. Give back only a loss like that: anything else is a real
      // collision (e.g. the far face of a crease), and refunding it would pump
      // energy in.
      const brake =
        (5 / 7) *
        GolfBallGuy.HAVOK_SLOW_CONTACT_DECEL *
        PhysicsConfig.STEP_SECONDS;
      const stopped = u.length() < 0.2 * brake;
      if (lost <= 0 || lost > 1.2 * brake || (lost < 0.8 * brake && !stopped))
        return;
      // A linear push changes the rolling speed by 5/7 of itself.
      want.scaleAndAddToRef((1.4 * lost) / speed, v);
      this.body.setLinearVelocity(v);
    }

    preventTunneling() {
      if (
        this._inCup ||
        this._teleportRestoreFrames > 0 ||
        // Pre-step speed: Havok can slow a ball within the very step it passes
        // through the surface.
        Math.max(this.getSpeed(), this._stepStartVel.length()) <
          GolfBallGuy.TUNNEL_GUARD_MIN_SPEED
      )
        return;
      const end = this.mesh.position;
      if (
        BABYLON.Vector3.DistanceSquared(this._stepStart, end) <
        (CONFIG.BALL.COLLIDER_DIAMETER / 2) ** 2
      )
        return;
      const input =
        this._castInput || (this._castInput = new BABYLON.ShapeCastResult());
      const hit =
        this._castHit || (this._castHit = new BABYLON.ShapeCastResult());
      this.scene.getPhysicsEngine().getPhysicsPlugin().shapeCast(
        {
          shape: this.body.shape,
          rotation: BABYLON.Quaternion.Identity(),
          startPosition: this._stepStart,
          endPosition: end,
          shouldHitTriggers: false,
          ignoreBody: this.body,
        },
        input,
        hit,
      );
      // A zero-fraction hit is an existing overlap, not a newly crossed surface.
      if (!hit.hasHit || hit.hitFraction <= 1e-4) return;
      const n = hit.hitNormal;
      // Judge by where the step ended, not by whether Havok reported a contact:
      // a fast ball can get a contact event and still end the step through the
      // surface (a steep facet meeting the ground). A ball Havok did resolve ends
      // on the near side, ~R from the struck plane — leave it, or it would bounce
      // twice.
      const r = CONFIG.BALL.COLLIDER_DIAMETER / 2;
      const end2plane = BABYLON.Vector3.Dot(end.subtract(hit.hitPoint), n);
      if (end2plane > r - GolfBallGuy.TUNNEL_DEPTH) return;
      const v = this.getVelocity();
      const vn = BABYLON.Vector3.Dot(v, n);
      if (vn >= 0) return;
      const material = (hit.shape || hit.body.shape).material;
      const restitution = PhysicsConfig.BALL_RESTITUTION * material.restitution;
      v.subtractInPlace(n.scale((1 + restitution) * vn));
      // Stop at first impact. Havok resolves tangential contact on the next step;
      // reflecting only misses avoids applying a second bounce to native contacts.
      const contact = BABYLON.Vector3.Lerp(
        this._stepStart,
        end,
        hit.hitFraction,
      );
      contact.addInPlace(n.scale(0.001));
      this.teleport(contact.x, contact.y, contact.z, false);
      this._teleportRestoreFrames = 2;
      this.body.setLinearVelocity(v);
    }

    applyHit(
      deltaX,
      deltaY,
      force,
      aimedDirection = 0,
      clubLaunchAngle = 0,
      clubLaunchSpeed = 40,
    ) {
      // Struck: the ball leaves the ground now, not after the step. Havok still
      // solves the resting contact on the launch step, and its friction (on the
      // last step's normal impulse) would hand a no-spin shot ~5 rad/s of topspin.
      this.forgetContact();
      this.skipFrictionNextStep();
      this.landed = false;
      this.inShot = true;
      this.touchedGround = false;
      this._restSteps = 0;
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
      this._shotDir.set(rotX, 0, rotZ);

      // From rest, an impulse J = m·Δv delivers Δv = launchVel exactly, so the launch
      // speed is the calibrated value regardless of frame length (frame-rate safe).
      this.body.applyImpulse(
        launchVel.scale(CONFIG.BALL.MASS),
        this.getPosition(),
      );
      this.startSquash(launchVel);

      // The clubface imparts NO spin — the ball launches spin-free and the
      // player's swipe is the only source of spin (see applySpin / applyMagnus).
      // (Loft still sets the launch ANGLE above; it just no longer auto-backspins.)
      this.body.setAngularVelocity(BABYLON.Vector3.Zero());
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
    }

    updateLandingState() {
      this.updateSpinAura(); // spin glow (runs every frame; fades out at rest)

      if (this._onGround && !this.touchedGround) {
        this.touchedGround = true;
        this.pendingSpinAmount = 0;
        return "firstContact";
      }

      if (
        !this.landed &&
        this.touchedGround &&
        this._teleportRestoreFrames === 0 &&
        this._restSteps >= GolfBallGuy.REST_STEPS
      ) {
        this.landed = true;
        return "fullLand";
      }

      // Airborne again (a bounce): the next contact ends any player spin too.
      if (!this._onGround && this.touchedGround) this.touchedGround = false;

      return null;
    }

    isAirborne() {
      return !this._onGround;
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
      Balls.liftFace(this.faceMesh);

      // Picked per frame by Game.updateCharacterFace from speed, climb/drop and
      // distance to the hole.
      const textureMap = {
        default: null,
        grimace: "grimace.png",
        elated: "elated.png",
        woah: "woah.png",
        o: "o.png",
        frown: "frown.png",
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
        // expressions (grimace/elated/woah/o/frown) still override + restore it.
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

      // Per frame: scratch objects instead of ~4 fresh ones each call.
      const dirToCamera = (this._gazeDir ??= new BABYLON.Vector3());
      cameraPosition.subtractToRef(this.getPosition(), dirToCamera);
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

      const gazeQ = (this._gazeQ ??= new BABYLON.Quaternion());
      BABYLON.Quaternion.FromEulerAnglesToRef(
        this.eyePitch,
        this.eyeYaw,
        0,
        gazeQ,
      );

      this.eyeL.rotationQuaternion ??= new BABYLON.Quaternion();
      this.eyeR.rotationQuaternion ??= new BABYLON.Quaternion();
      gazeQ.multiplyToRef(this.eyeLRest, this.eyeL.rotationQuaternion);
      gazeQ.multiplyToRef(this.eyeRRest, this.eyeR.rotationQuaternion);
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

    // The character's visible orientation, once per rendered frame. The physics
    // body owns this.mesh's rotationQuaternion, so the visual characterRoot below
    // it is counter-rotated to show _visualQ instead. In flight and rolling,
    // _visualQ turns about the body's spin axis but no faster than
    // VISUAL_SPIN_MAX: a real ~1000 rad/s spin would strobe (several turns per
    // frame) and read as slow, backwards or random. While aiming it eases to an
    // upright yaw of targetRotation instead.
    updateVisualRotation(dt, faceUpright) {
      const root = this.characterRoot;
      const bodyQ = this.mesh.rotationQuaternion;
      if (!root || !bodyQ) return;
      const q = this._visualQ;
      if (faceUpright) {
        BABYLON.Quaternion.RotationAxisToRef(
          BABYLON.Axis.Y,
          this.targetRotation,
          this._visualTmp,
        );
        // 10% of the way per 60 fps frame, at any frame rate.
        const ease = 1 - Math.exp(-0.105 * 60 * dt);
        BABYLON.Quaternion.SlerpToRef(q, this._visualTmp, ease, q);
      } else {
        const w = this._visualW;
        this.body.getAngularVelocityToRef(w);
        const rate = w.length();
        if (rate > 1e-6) {
          BABYLON.Quaternion.RotationAxisToRef(
            w.scaleInPlace(1 / rate),
            // A frame hitch must not turn the ball past readability either.
            Math.min(rate, CONFIG.PHYSICS.VISUAL_SPIN_MAX) *
              Math.min(dt, 1 / 30),
            this._visualTmp,
          );
          this._visualTmp.multiplyToRef(q, q).normalize();
        }
      }
      if (!root.rotationQuaternion)
        root.rotationQuaternion = new BABYLON.Quaternion();
      // world = bodyQ · local, so local = bodyQ⁻¹ · _visualQ.
      bodyQ.conjugateToRef(this._visualTmp);
      this._visualTmp.multiplyToRef(q, root.rotationQuaternion);
    }

    // Hang the visual characterRoot under two nodes that squash it along an
    // arbitrary WORLD direction d, about the ball's centre: outer = R_d·S in the
    // body's frame, inner = R_d⁻¹ back, so the root still shows _visualQ and the
    // squash axis stays on the launch line however the body spins.
    initSquash() {
      if (!this.characterRoot || this._squashOuter) return;
      this._squashOuter = new BABYLON.TransformNode("ballSquash", this.scene);
      this._squashOuter.rotationQuaternion = new BABYLON.Quaternion();
      this._squashOuter.parent = this.mesh;
      this._squashInner = new BABYLON.TransformNode("ballUnsquash", this.scene);
      this._squashInner.rotationQuaternion = new BABYLON.Quaternion();
      this._squashInner.parent = this._squashOuter;
      this.characterRoot.parent = this._squashInner;
    }

    startSquash(launchVel) {
      const speed = launchVel.length();
      if (speed < 0.5) return;
      const S = CONFIG.GOLF_BALL.SQUASH;
      this._squashAmp =
        S.MAX * Math.pow(Math.min(speed / S.FULL_SPEED, 1), 0.6);
      launchVel.scaleToRef(1 / speed, this._squashDir);
      this._squashT = 0;
    }

    // Once per rendered frame (after updateVisualRotation): flattened along the
    // launch line on contact, overshooting into a stretch, then settling round.
    updateSquash(dt) {
      const outer = this._squashOuter;
      if (!outer || this._squashT === Infinity) return;
      const S = CONFIG.GOLF_BALL.SQUASH;
      // Sample, then advance: the strike frame itself shows the full squash.
      // Capped step, as in updateVisualRotation: the strike frame often hitches,
      // and a skipped squash is the whole effect.
      const t = this._squashT;
      this._squashT += Math.min(dt, 1 / 30);
      if (t >= S.DURATION) {
        this._squashT = Infinity;
        outer.rotationQuaternion.set(0, 0, 0, 1);
        outer.scaling.setAll(1);
        this._squashInner.rotationQuaternion.set(0, 0, 0, 1);
        return;
      }
      const s =
        this._squashAmp *
        Math.exp(-t / S.DECAY) *
        Math.cos(2 * Math.PI * S.FREQ * t);
      const axial = 1 - s;
      const perp = 1 / Math.sqrt(axial); // keep the volume
      // R_d: the node's local +Y onto the world launch direction.
      const qd = this._squashQ;
      BABYLON.Quaternion.FromUnitVectorsToRef(
        BABYLON.Axis.Y,
        this._squashDir,
        qd,
      );
      const bodyQ = this.mesh.rotationQuaternion;
      bodyQ.conjugateToRef(this._visualTmp);
      this._visualTmp.multiplyToRef(qd, outer.rotationQuaternion); // bodyQ⁻¹·R_d
      outer.scaling.set(perp, axial, perp);
      qd.conjugateToRef(this._visualTmp);
      this._visualTmp.multiplyToRef(
        bodyQ,
        this._squashInner.rotationQuaternion,
      ); // R_d⁻¹·bodyQ
    }

    // === GENERAL METHODS ===
    // A moved ball starts from fresh contact: the old support (e.g. a crease's
    // two faces) must not hold it wherever it lands.
    forgetContact() {
      if (this._onGround) this.setOnGround(false);
      this._grip = 0;
      this._topGrip = 0;
      this._shotDir.setAll(0);
      this._supportCount = 0;
      this._heldThisStep = false;
      this._restSteps = 0;
    }

    reset() {
      this.forgetContact();
      this.mesh.position = this.startPosition.clone();
      // Reset the orientation as a quaternion (the pre-step dance below pushes it
      // into the body); assigning .rotation would null it, and Havok would then
      // sync into Euler angles that updateVisualRotation can't read. Clear any
      // aim-facing offset on the visual root too.
      this.mesh.rotationQuaternion = BABYLON.Quaternion.Identity();
      if (this.characterRoot?.rotationQuaternion)
        this.characterRoot.rotationQuaternion.set(0, 0, 0, 1);
      this._visualQ.set(0, 0, 0, 1);
      if (this._squashT !== Infinity) {
        this._squashT = CONFIG.GOLF_BALL.SQUASH.DURATION; // snap round next frame
        this.updateSquash(0);
      }
      this.body.setLinearVelocity(BABYLON.Vector3.Zero());
      this.body.setAngularVelocity(BABYLON.Vector3.Zero());
      // Teleport the physics body to the new spot: let it read the mesh transform
      // for a few physics steps, then hand position control back to the simulation.
      if (this.body) {
        this.body.disablePreStep = false;
        this._teleportRestoreFrames = 3;
        this.mesh.computeWorldMatrix(true);
      }
      // Not landed until rest detection says so: the spot may be a slope the
      // surface can't hold, and the ball must not roll away during aim.
      this.landed = false;
      this.inShot = false;
      this.touchedGround = false;
      this.pendingSpinAmount = 0;
      this.targetRotation = 0;
      this.facingAimDirection = false;
      this._inCup = false;
    }

    // Teleport the physics body to a new spot (e.g. dropping into the cup): let the
    // body read the mesh transform for a couple of physics steps, then hand control
    // back to the simulation (same dance as reset()).
    teleport(x, y, z, zeroVel = true) {
      this.forgetContact();
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
