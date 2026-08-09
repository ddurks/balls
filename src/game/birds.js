// birds.js — Boid3D, BirdFlockSystem.
// Split out of game.js; loaded as a plain <script> before game.js (see game.html),
// and require()-able in Node for unit tests. Cross-module refs resolve via globals.
(function (global) {
  // ─── 3D BOID FLOCKING SYSTEM ───────────────────────────────────────────────

  class Boid3D {
    constructor(position, scene, entries) {
      this.scene = scene;
      this.position = position.clone();
      const s = CONFIG.BOIDS.MAX_SPEED;
      this.velocity = new BABYLON.Vector3(
        (Math.random() - 0.5) * s,
        (Math.random() - 0.5) * s * 0.25,
        (Math.random() - 0.5) * s,
      );
      this.acceleration = new BABYLON.Vector3();

      // Flight state machine: flying → landing → perched → takeoff → flying
      this.state = "flying";
      this.landTarget = new BABYLON.Vector3();
      this.hasTarget = false;
      this.onWater = false;
      this.perchTimer = 0;
      this.bobPhase = Math.random() * Math.PI * 2;
      this.driftAngle = Math.random() * Math.PI * 2;

      // Smoothed orientation (radians) — birds bank into turns and level out to perch.
      // The model's nose is +Z, so yaw = atan2(x,z) faces the travel direction.
      this.yaw = Math.atan2(this.velocity.x, this.velocity.z);
      this.pitch = 0;
      this.roll = 0;

      this.wanderAngle = Math.random() * Math.PI * 2;
      this.animSpeedVariation = 0.8 + Math.random() * 0.4; // per-bird desync (±20%)
      this._tmp = new BABYLON.Vector3();

      // Fully-independent instance of the GLTF (mesh + skeleton + retargeted
      // animation groups). instantiateModelsToScene remaps every animation to THIS
      // bird's own nodes, so playback is truly independent (unlike a manual clone,
      // whose GLTF node targets couldn't be retargeted → all birds locked in sync).
      this.entries = entries;
      // Wrap the instance's __root__ (which carries the glTF handedness) under our
      // own control node so we can position/rotate the bird without disturbing it.
      this.mesh = new BABYLON.TransformNode(`bird_${Math.random()}`, scene);
      for (const rn of entries.rootNodes) rn.parent = this.mesh;
      this.mesh.scaling.setAll(CONFIG.BOIDS.MODEL_SCALE); // real-scale bird (see MODEL_SCALE)
      this.mesh.position = this.position.clone();
      this.mesh.rotationQuaternion = null;
      this.mesh.rotation = BABYLON.Vector3.Zero();

      this.skeleton = entries.skeletons?.[0] || null;
      const groups = entries.animationGroups || [];
      this.idleAnimation = groups.find((g) => /idle/i.test(g.name)) || null;
      this.flapAnimation = groups.find((g) => /flap/i.test(g.name)) || null;
      this.idleAnimation?.stop();
      this.flapAnimation?.stop();
      // Cross-fade between idle/flap instead of snapping.
      Boid3D.enableBlend(this.idleAnimation);
      Boid3D.enableBlend(this.flapAnimation);

      this.currentAnimationType = null;
      this.playAnimationOfType("flap");
    }

    static enableBlend(animGroup) {
      if (!animGroup) return;
      for (const ta of animGroup.targetedAnimations) {
        ta.animation.enableBlending = true;
        ta.animation.blendingSpeed = 0.06;
      }
    }

    applyForce(force) {
      this.acceleration.addInPlace(force);
    }

    playAnimationOfType(animationType) {
      if (this.currentAnimationType === animationType) return;
      const animGroup =
        animationType === "idle" ? this.idleAnimation : this.flapAnimation;
      if (!animGroup) return;
      // Don't reset() — that snaps targets to frame 0 and defeats the cross-fade.
      // Stop the other group (leaves its pose in place) and start this one; the
      // per-animation blending eases from that pose. Start at a random frame so
      // birds don't beat their wings in unison.
      if (animationType === "idle") this.flapAnimation?.stop();
      else this.idleAnimation?.stop();
      animGroup.loopAnimation = true;
      animGroup.start(true, 1.0, animGroup.from, animGroup.to);
      // Offset the phase so birds don't beat their wings in unison (the pose still
      // cross-fades smoothly because the animations have blending enabled).
      if (animGroup.to > animGroup.from) {
        animGroup.goToFrame(
          animGroup.from + Math.random() * (animGroup.to - animGroup.from),
        );
      }
      this.currentAnimationType = animationType;
    }

    updateAnimation() {
      const want = this.state === "perched" ? "idle" : "flap";
      const grp = want === "idle" ? this.idleAnimation : this.flapAnimation;
      // Switch type, or restart if the group somehow stopped (keeps wings moving).
      if (this.currentAnimationType !== want || (grp && !grp.isPlaying)) {
        this.currentAnimationType = null;
        this.playAnimationOfType(want);
      }
      if (this.state === "perched") {
        if (this.idleAnimation)
          this.idleAnimation.speedRatio = this.animSpeedVariation;
        return;
      }
      if (this.flapAnimation) {
        // Climb/descend threshold scales with cruise speed (15% of MAX_SPEED),
        // so the boost/dampen still triggers after speed retunes.
        const vt = CONFIG.BOIDS.MAX_SPEED * 0.15;
        let m = 1.0;
        if (this.velocity.y > vt) m = CONFIG.BOIDS.CLIMB_ANIMATION_BOOST;
        else if (this.velocity.y < -vt)
          m = CONFIG.BOIDS.DESCENT_ANIMATION_DAMPEN;
        this.flapAnimation.speedRatio = m * this.animSpeedVariation;
      }
    }

    // Smoothly turn to face travel direction, banking into turns; level when perched.
    orient(dt) {
      const k = 1 - Math.exp(-CONFIG.BOIDS.ROTATE_SMOOTH * dt);
      let targetYaw = this.yaw;
      let targetPitch = 0;
      let targetRoll = 0;
      const hLen = Math.hypot(this.velocity.x, this.velocity.z);
      if (this.state !== "perched" && hLen > 0.02) {
        targetYaw = Math.atan2(this.velocity.x, this.velocity.z);
        targetPitch = Math.max(
          -Math.PI / 3,
          Math.min(Math.PI / 3, Math.atan2(this.velocity.y, hLen)),
        );
      }
      // shortest-path yaw delta (drives both the turn and the bank)
      let dyaw = targetYaw - this.yaw;
      while (dyaw > Math.PI) dyaw -= 2 * Math.PI;
      while (dyaw < -Math.PI) dyaw += 2 * Math.PI;
      if (this.state !== "perched") {
        targetRoll = Shared.clamp(dyaw * 2.5, -0.5, 0.5);
      }
      this.yaw += dyaw * k;
      this.pitch += (targetPitch - this.pitch) * k;
      this.roll += (targetRoll - this.roll) * k;
      this.mesh.rotation.set(this.pitch, this.yaw, this.roll);
    }

    dispose() {
      this.entries?.animationGroups?.forEach((g) => {
        g.stop();
        g.dispose();
      });
      this.entries?.skeletons?.forEach((s) => s.dispose());
      this.entries?.rootNodes?.forEach((n) => n.dispose());
      this.mesh.dispose();
    }
  }

  /**
   * A small flock of birds that fly, flock (separation/alignment/cohesion), and
   * every so often peel off to land — on the ground or on the water, where they
   * float and gently bob. Motion is a delta-timed steering model with a clamped
   * steering force, so turns and landings are smooth rather than jerky.
   */
  class BirdFlockSystem {
    constructor(scene, groundCenterX = 0, groundCenterZ = 0) {
      this.scene = scene;
      this.boids = [];
      this.groundCenterX = groundCenterX;
      this.groundCenterZ = groundCenterZ;
      this.birdTemplate = null;
      this.isLoaded = false;
      this.bottomOffset = 0.7 * CONFIG.BOIDS.MODEL_SCALE; // mesh origin → underside; refined at load
      // Reusable temp vectors — no per-frame allocations in the neighbor loops.
      this._diff = new BABYLON.Vector3();
      this._align = new BABYLON.Vector3();
      this._center = new BABYLON.Vector3();
      this._steer = new BABYLON.Vector3();
      this._down = new BABYLON.Vector3(0, -1, 0);
    }

    async load() {
      try {
        // Keep the model in a container and stamp independent instances from it —
        // instantiateModelsToScene properly clones + retargets skeleton animations.
        this.container = await Shared.loadModel("ballsbird.glb", this.scene, {
          container: true,
        });
        this.container.animationGroups.forEach((g) => g.stop());

        // Underside offset (level pose) so perched birds sit tangent to the surface.
        const probe = this.container.instantiateModelsToScene(
          (n) => "birdProbe_" + n,
          false,
        );
        const proot = probe.rootNodes[0];
        proot.scaling.setAll(CONFIG.BOIDS.MODEL_SCALE); // measure at the birds' real scale
        proot.computeWorldMatrix(true);
        const bb = proot.getHierarchyBoundingVectors(true);
        this.bottomOffset = proot.getAbsolutePosition().y - bb.min.y;
        if (!isFinite(this.bottomOffset))
          this.bottomOffset = 0.7 * CONFIG.BOIDS.MODEL_SCALE;
        probe.dispose();

        this.init();
        this.isLoaded = true;
      } catch (error) {
        console.error("Failed to load ballsbird.glb:", error);
        this.isLoaded = false;
      }
    }

    init() {
      if (!this.container) return;
      const c = CONFIG.BOIDS;
      for (let i = 0; i < c.COUNT; i++) {
        const angle = Math.random() * Math.PI * 2;
        const radius = Math.random() * c.CYLINDER_RADIUS;
        const height =
          c.CYLINDER_MIN_HEIGHT +
          Math.random() * (c.CYLINDER_MAX_HEIGHT - c.CYLINDER_MIN_HEIGHT);
        const x = this.groundCenterX + Math.cos(angle) * radius;
        const z = this.groundCenterZ + Math.sin(angle) * radius;
        const entries = this.container.instantiateModelsToScene(
          (n) => `bird${i}_${n}`,
          false,
        );
        this.boids.push(
          new Boid3D(new BABYLON.Vector3(x, height, z), this.scene, entries),
        );
      }
    }

    // ── surface lookup for landing: raycast against ground/water meshes (both
    //    modes) via intersectsMesh so it works even on non-pickable meshes. ──
    sampleSurface(x, z) {
      const ray = new BABYLON.Ray(
        new BABYLON.Vector3(x, 600, z),
        this._down,
        1200,
      );
      let bestY = -Infinity;
      let water = false;
      for (const m of this.scene.meshes) {
        const n = m.name;
        if (!m.isEnabled()) continue;
        if (n !== "groundDisc" && n !== "waterRing" && !n.startsWith("surf_"))
          continue;
        const info = ray.intersectsMesh(m);
        if (info.hit && info.pickedPoint.y > bestY) {
          bestY = info.pickedPoint.y;
          water = n.toLowerCase().includes("water");
        }
      }
      return bestY === -Infinity ? null : { y: bestY, isWater: water };
    }

    update(dt = 1 / 60, ballPosition = null, ballVelocity = null) {
      if (!this.boids.length) return;
      const c = CONFIG.BOIDS;
      // Clamp dt so a frame hitch can't fast-forward timers or mass-trigger
      // landings (LAND_CHANCE*dt). Harmless at a normal frame rate.
      dt = Math.min(dt, 0.05);
      const f = dt * 60; // frame-equivalent step (≤3)

      for (const boid of this.boids) {
        boid.acceleration.setAll(0);

        switch (boid.state) {
          case "flying":
            this.flock(boid);
            this.wander(boid);
            this.keepWithinBounds(boid);
            this.steer(boid, f);
            this.maybeStartLanding(boid, dt);
            break;

          case "landing":
            if (this.startled(boid, ballPosition)) {
              this.takeOff(boid);
            } else {
              this.glideToLanding(boid, f);
            }
            break;

          case "perched":
            this.updatePerched(boid, dt, ballPosition);
            break;

          case "takeoff":
            this.separationOnly(boid);
            boid.acceleration.y += c.CLIMB_FORCE;
            this.steer(boid, f);
            if (boid.position.y > boid.landTarget.y + c.TAKEOFF_HEIGHT) {
              boid.state = "flying";
              boid.hasTarget = false;
            }
            break;
        }

        boid.updateAnimation();
        boid.mesh.position.copyFrom(boid.position);
        boid.orient(dt);
      }
    }

    // Integrate steering: clamp the force (smooth turns), then velocity, then move.
    steer(boid, f) {
      const c = CONFIG.BOIDS;
      const aLen = boid.acceleration.length();
      if (aLen > c.MAX_FORCE)
        boid.acceleration.scaleInPlace(c.MAX_FORCE / aLen);
      boid.velocity.addInPlace(boid.acceleration.scale(f));
      const sp = boid.velocity.length();
      if (sp > c.MAX_SPEED) boid.velocity.scaleInPlace(c.MAX_SPEED / sp);
      boid.position.addInPlace(boid.velocity.scale(f));
    }

    // Smooth glide-down landing: ease the bird straight toward its landing spot at
    // a steady glide speed, flaring (slowing) over the last stretch for a soft
    // touchdown, then perch. Velocity is derived from the motion (per-frame units)
    // so the bird pitches into the descent and the wings switch to a glide — no
    // steering overshoot, and no final snap (it lerps all the way in).
    glideToLanding(boid, f) {
      const c = CONFIG.BOIDS;
      const t = boid.landTarget;
      const dx = t.x - boid.position.x;
      const dy = t.y - boid.position.y;
      const dz = t.z - boid.position.z;
      const dist = Math.hypot(dx, dy, dz);
      if (dist < 0.04) {
        this.perch(boid);
        return;
      }
      let speed = c.LAND_GLIDE_SPEED; // per-frame units (same scale as MAX_SPEED)
      if (dist < c.LAND_FLARE_DIST)
        speed *= Math.max(0.15, dist / c.LAND_FLARE_DIST); // flare to a soft touch
      const step = Math.min(dist, speed * f); // metres to move this frame
      const inv = step / dist;
      boid.position.x += dx * inv;
      boid.position.y += dy * inv;
      boid.position.z += dz * inv;
      // per-frame velocity along the glide, for orient() + wing animation
      const vscale = step / f / dist;
      boid.velocity.set(dx * vscale, dy * vscale, dz * vscale);
    }

    wander(boid) {
      boid.wanderAngle += (Math.random() - 0.5) * 0.3;
      boid._tmp.set(
        Math.cos(boid.wanderAngle),
        (Math.random() - 0.5) * 0.4,
        Math.sin(boid.wanderAngle),
      );
      boid._tmp.scaleInPlace(CONFIG.BOIDS.WANDER_STRENGTH);
      boid.applyForce(boid._tmp);
    }

    flock(boid) {
      const c = CONFIG.BOIDS;
      const avoidSq = c.MIN_AVOID_DISTANCE * c.MIN_AVOID_DISTANCE;
      const rangeSq = c.VISUAL_RANGE * c.VISUAL_RANGE;
      const sep = this._steer;
      const align = this._align;
      const coh = this._center;
      sep.setAll(0);
      align.setAll(0);
      coh.setAll(0);
      let sepN = 0;
      let n = 0;

      for (const other of this.boids) {
        if (other === boid) continue;
        const distSq = BABYLON.Vector3.DistanceSquared(
          boid.position,
          other.position,
        );
        if (distSq > 0 && distSq < avoidSq) {
          boid.position.subtractToRef(other.position, this._diff);
          this._diff.scaleInPlace(c.SEPARATION_WEIGHT / Math.sqrt(distSq));
          sep.addInPlace(this._diff);
          sepN++;
        }
        if (distSq > 0 && distSq < rangeSq) {
          align.addInPlace(other.velocity);
          coh.addInPlace(other.position);
          n++;
        }
      }

      if (sepN > 0) {
        sep.scaleInPlace(c.AVOID_FACTOR);
        boid.applyForce(sep);
      }
      if (n > 0) {
        align
          .scaleInPlace(1 / n)
          .subtractInPlace(boid.velocity)
          .scaleInPlace(c.MATCHING_FACTOR);
        boid.applyForce(align);
        coh
          .scaleInPlace(1 / n)
          .subtractInPlace(boid.position)
          .scaleInPlace(c.CENTERING_FACTOR);
        boid.applyForce(coh);
      }
    }

    separationOnly(boid) {
      const c = CONFIG.BOIDS;
      const avoidSq = c.MIN_AVOID_DISTANCE * c.MIN_AVOID_DISTANCE;
      const sep = this._steer;
      sep.setAll(0);
      let sepN = 0;
      for (const other of this.boids) {
        if (other === boid) continue;
        const distSq = BABYLON.Vector3.DistanceSquared(
          boid.position,
          other.position,
        );
        if (distSq > 0 && distSq < avoidSq) {
          boid.position.subtractToRef(other.position, this._diff);
          this._diff.scaleInPlace(c.SEPARATION_WEIGHT / Math.sqrt(distSq));
          sep.addInPlace(this._diff);
          sepN++;
        }
      }
      if (sepN > 0) {
        sep.scaleInPlace(c.AVOID_FACTOR);
        boid.applyForce(sep);
      }
    }

    keepWithinBounds(boid) {
      const c = CONFIG.BOIDS;
      const dx = boid.position.x - this.groundCenterX;
      const dz = boid.position.z - this.groundCenterZ;
      const dist = Math.sqrt(dx * dx + dz * dz);
      // Velocity nudge per frame, proportional to cruise speed (~20%) so the
      // boundary turn stays gentle rather than reversing the bird outright.
      const turn = c.MAX_SPEED * 0.2;
      if (dist > c.CYLINDER_RADIUS) {
        boid.velocity.x -= (dx / dist) * turn;
        boid.velocity.z -= (dz / dist) * turn;
      }
      if (boid.position.y < c.CYLINDER_MIN_HEIGHT) boid.velocity.y += turn;
      if (boid.position.y > c.CYLINDER_MAX_HEIGHT) boid.velocity.y -= turn;
    }

    // Occasionally peel off to land. Birds near an already-landed group are more
    // likely to join it — producing natural flock landings.
    maybeStartLanding(boid, dt) {
      const c = CONFIG.BOIDS;
      let chance = c.LAND_CHANCE;
      let anchor = null;
      let nearby = 0;
      for (const other of this.boids) {
        if (other === boid) continue;
        if (other.state !== "perched" && other.state !== "landing") continue;
        const dx = boid.position.x - other.position.x;
        const dz = boid.position.z - other.position.z;
        if (dx * dx + dz * dz < c.GROUP_RANGE * c.GROUP_RANGE) {
          nearby++;
          if (!anchor) anchor = other;
        }
      }
      // Nudge toward joining only while the group is still small, so flocks land
      // in modest clusters rather than the whole flock piling onto one spot.
      if (nearby > 0 && nearby < c.GROUP_CAP) chance += c.LAND_JOIN_BONUS;
      else anchor = null;
      if (Math.random() >= chance * dt) return;

      let tx = boid.position.x;
      let tz = boid.position.z;
      if (anchor) {
        // ±3 m scatter — a tight cluster at 0.6 m bird scale, but wider than
        // MIN_AVOID_DISTANCE so separation doesn't block the touchdown.
        tx = anchor.landTarget.x + (Math.random() - 0.5) * 6;
        tz = anchor.landTarget.z + (Math.random() - 0.5) * 6;
      } else {
        // Project the spot AHEAD along the current heading (lead scaled to
        // altitude for a natural ~25° glide slope) so the bird glides
        // forward-and-down to it instead of dropping straight down.
        const hx = boid.velocity.x,
          hz = boid.velocity.z;
        const hlen = Math.hypot(hx, hz);
        if (hlen > 1e-3) {
          const below = this.sampleSurface(tx, tz);
          const alt = below ? Math.max(2, boid.position.y - below.y) : 20;
          const lead = Math.min(30, Math.max(6, alt * 2));
          tx += (hx / hlen) * lead;
          tz += (hz / hlen) * lead;
        }
      }
      const surf = this.sampleSurface(tx, tz);
      if (!surf) return; // nothing to land on (over the void) — keep flying
      // Offset by the mesh's bottom so the bird's underside rests on the surface.
      boid.landTarget.set(tx, surf.y + this.bottomOffset, tz);
      boid.onWater = surf.isWater;
      boid.hasTarget = true;
      boid.state = "landing";
    }

    perch(boid) {
      const c = CONFIG.BOIDS;
      boid.state = "perched";
      boid.velocity.setAll(0);
      boid.position.copyFrom(boid.landTarget);
      boid.perchTimer =
        c.PERCH_SECONDS_MIN +
        Math.random() * (c.PERCH_SECONDS_MAX - c.PERCH_SECONDS_MIN);
    }

    updatePerched(boid, dt, ballPosition) {
      const c = CONFIG.BOIDS;
      boid.velocity.setAll(0);
      if (boid.onWater) {
        // Slowly drift on the water and bob with the ripples.
        boid.driftAngle += (Math.random() - 0.5) * 0.05;
        boid.landTarget.x += Math.cos(boid.driftAngle) * c.WATER_DRIFT * dt;
        boid.landTarget.z += Math.sin(boid.driftAngle) * c.WATER_DRIFT * dt;
        boid.bobPhase += c.WATER_BOB_SPEED * dt;
        boid.position.x = boid.landTarget.x;
        boid.position.z = boid.landTarget.z;
        boid.position.y =
          boid.landTarget.y +
          c.WATER_FLOAT +
          Math.sin(boid.bobPhase) * c.WATER_BOB_AMP;
        // gentle heading sway as it floats
        boid.yaw += Math.cos(boid.bobPhase * 0.5) * 0.004;
      } else {
        boid.position.copyFrom(boid.landTarget);
      }
      boid.perchTimer -= dt;
      if (boid.perchTimer <= 0 || this.startled(boid, ballPosition)) {
        this.takeOff(boid);
      }
    }

    takeOff(boid) {
      boid.state = "takeoff";
      boid.velocity.y = CONFIG.BOIDS.TAKEOFF_KICK;
      // nudge outward a touch so it doesn't climb straight back into neighbors
      boid.velocity.x += (Math.random() - 0.5) * CONFIG.BOIDS.MAX_SPEED * 0.5;
      boid.velocity.z += (Math.random() - 0.5) * CONFIG.BOIDS.MAX_SPEED * 0.5;
    }

    startled(boid, ballPosition) {
      if (!ballPosition) return false;
      const r = CONFIG.BOIDS.STARTLE_RADIUS;
      const dx = boid.position.x - ballPosition.x;
      const dz = boid.position.z - ballPosition.z;
      return dx * dx + dz * dz < r * r;
    }

    dispose() {
      this.boids.forEach((boid) => boid.dispose());
      this.boids = [];
    }
  }

  Object.assign(global, { Boid3D, BirdFlockSystem });
  if (typeof module !== "undefined" && module.exports)
    module.exports = { Boid3D, BirdFlockSystem };
})(typeof globalThis !== "undefined" ? globalThis : this);
