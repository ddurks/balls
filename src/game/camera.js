// camera.js — FollowCamera, DroneCamera.
// Split out of game.js; loaded as a plain <script> before game.js (see game.html),
// and require()-able in Node for unit tests. Cross-module refs resolve via globals.
(function (global) {
  // ─── FOLLOW CAMERA ──────────────────────────────────────────────────────────

  class FollowCamera {
    constructor(camera, targetMesh, golfBallGuy = null) {
      this.camera = camera;
      this.targetMesh = targetMesh;
      this.golfBallGuy = golfBallGuy;
      this.offsetX = 0;
      this.offsetY = 0;
      this.offsetZ = 2;
      this.lookOffsetY = 1.5;
      this.lookOffsetZ = -5;

      this.targetOffsetX = 0;
      this.targetOffsetY = 0;
      this.targetOffsetZ = 2;
      this.targetLookOffsetY = 1.5;
      this.targetLookOffsetZ = -5;

      this.smoothSpeed = CONFIG.CAMERA.FOLLOW_SMOOTH;
      this.lastPosition = new BABYLON.Vector3(0, 0, 0);
      this.floorYAt = null; // (x,z) => min camera Y (terrain/water governor)

      this.shotStartPosition = null;
      this.viewMode = CameraViewMode.PLAY;
      this.cameraAngle = 0;
      this.targetCameraAngle = 0;
      this.cameraAngleLerpSpeed = CONFIG.CAMERA.ANGLE_LERP_SPEED;

      this.configure();
    }

    configure() {
      this.camera.fov = CONFIG.CAMERA.FOV_PLAY;
      this.camera.minZ = 0.01;
      this.camera.maxZ = 3000;
      this.camera.inertia = 0;
      this.camera.angularSensibility = 0;
      this.camera.keysUp = [];
      this.camera.keysDown = [];
      this.camera.keysLeft = [];
      this.camera.keysRight = [];
      this.camera.wheelPrecision = 0;
    }

    setShotStartPosition(position) {
      this.shotStartPosition = position.clone();
    }

    setOffsets(x, y, z, lookY, lookZ, framing = null) {
      this.targetOffsetX = x;
      this.targetOffsetY = y;
      this.targetOffsetZ = z;
      this.targetLookOffsetY = lookY;
      this.targetLookOffsetZ = lookZ;
      this.framingMidpoint = framing;
    }

    setShotReviewView() {
      this.viewMode = CameraViewMode.SHOT_REVIEW;
      if (!this.shotStartPosition || !this.targetMesh) {
        this.setOffsets(
          0,
          CONFIG.FOLLOW_CAMERA.FULL_SHOT_VIEW_MIN_HEIGHT,
          CONFIG.FOLLOW_CAMERA.FULL_SHOT_VIEW_MIN_Z,
          0,
          CONFIG.FOLLOW_CAMERA.FULL_SHOT_VIEW_LOOK_Z,
        );
        return;
      }

      const ballPos = this.targetMesh.getAbsolutePosition();
      const dist = BABYLON.Vector3.Distance(this.shotStartPosition, ballPos);
      const mid = BABYLON.Vector3.Lerp(this.shotStartPosition, ballPos, 0.5);

      this.setOffsets(
        Math.max(0.8, dist * CONFIG.FOLLOW_CAMERA.FULL_SHOT_VIEW_SCALE_X),
        Math.max(1.2, dist * CONFIG.FOLLOW_CAMERA.FULL_SHOT_VIEW_SCALE_Y),
        Math.max(2, dist * CONFIG.FOLLOW_CAMERA.FULL_SHOT_VIEW_SCALE_Z),
        0.1,
        -Math.max(3.5, dist * CONFIG.FOLLOW_CAMERA.FULL_SHOT_VIEW_SCALE_LOOK_Z),
        mid,
      );
    }

    setPlayView() {
      this.viewMode = CameraViewMode.PLAY;
      this.setOffsets(
        CONFIG.FOLLOW_CAMERA.PLAY_VIEW_OFFSET_X,
        CONFIG.FOLLOW_CAMERA.PLAY_VIEW_OFFSET_Y,
        CONFIG.FOLLOW_CAMERA.PLAY_VIEW_OFFSET_Z,
        CONFIG.FOLLOW_CAMERA.PLAY_VIEW_LOOK_OFFSET_Y,
        CONFIG.FOLLOW_CAMERA.PLAY_VIEW_LOOK_OFFSET_Z,
      );
    }

    setCameraAngle(angle) {
      // Normalize angle to [-π, π] range to avoid 360 spin
      let normalizedAngle = angle;
      while (normalizedAngle > Math.PI) normalizedAngle -= 2 * Math.PI;
      while (normalizedAngle < -Math.PI) normalizedAngle += 2 * Math.PI;

      // Find shortest path from current angle to target
      const diff = normalizedAngle - this.cameraAngle;
      if (diff > Math.PI) {
        this.targetCameraAngle = normalizedAngle - 2 * Math.PI;
      } else if (diff < -Math.PI) {
        this.targetCameraAngle = normalizedAngle + 2 * Math.PI;
      } else {
        this.targetCameraAngle = normalizedAngle;
      }
    }

    setCameraAngleImmediate(angle) {
      let normalized = angle;
      while (normalized > Math.PI) normalized -= 2 * Math.PI;
      while (normalized < -Math.PI) normalized += 2 * Math.PI;
      this.cameraAngle = normalized;
      this.targetCameraAngle = normalized;
    }

    update(dt) {
      if (!this.targetMesh) return;

      // Exponential smoothing — frame-rate independent
      // f approaches 1 as dt grows, giving consistent feel at any fps
      const f = 1 - Math.exp(-this.smoothSpeed * 60 * dt);
      const fAngle = 1 - Math.exp(-this.cameraAngleLerpSpeed * 60 * dt);
      // Track tightly during live play (the ball path is smooth, so tight ≠ jittery);
      // keep the gentle ease for the shot-review reveal.
      const posSpeed =
        this.viewMode === CameraViewMode.PLAY
          ? CONFIG.CAMERA.POSITION_LERP_SPEED_PLAY
          : CONFIG.CAMERA.POSITION_LERP_SPEED;
      const fPos = 1 - Math.exp(-posSpeed * 60 * dt);

      this.offsetX = BABYLON.Scalar.Lerp(this.offsetX, this.targetOffsetX, f);
      this.offsetY = BABYLON.Scalar.Lerp(this.offsetY, this.targetOffsetY, f);
      this.offsetZ = BABYLON.Scalar.Lerp(this.offsetZ, this.targetOffsetZ, f);
      this.lookOffsetY = BABYLON.Scalar.Lerp(
        this.lookOffsetY,
        this.targetLookOffsetY,
        f,
      );
      this.lookOffsetZ = BABYLON.Scalar.Lerp(
        this.lookOffsetZ,
        this.targetLookOffsetZ,
        f,
      );
      this.cameraAngle = BABYLON.Scalar.Lerp(
        this.cameraAngle,
        this.targetCameraAngle,
        fAngle,
      );

      const referencePoint =
        this.framingMidpoint || this.targetMesh.getAbsolutePosition();
      const { x: offsetX, z: offsetZ } = Utils.rotate2D(
        this.offsetX,
        this.offsetZ,
        this.cameraAngle,
      );

      // Scratch vectors reused every frame (this runs on every physics tick).
      const newPosition =
        this._camPos || (this._camPos = new BABYLON.Vector3());
      newPosition.set(
        referencePoint.x + offsetX,
        referencePoint.y + this.offsetY,
        referencePoint.z + offsetZ,
      );

      // Smooth in place, then copy values into the camera's own position vector
      // (keeping them separate objects so engine-side normalization can't perturb
      // our smoothing source). No distance-clamp: the tight PLAY follow rate keeps
      // the ball framed on its own, and the old clamp was what pinned the camera to
      // the ball's (fast-rotating) velocity direction and made it shake.
      BABYLON.Vector3.LerpToRef(
        this.lastPosition,
        newPosition,
        fPos,
        this.lastPosition,
      );
      // Governor: never let the camera sink below the terrain or the water
      // surface. Clamp the smoothing source too, so the lerp can't fight it.
      if (this.floorYAt) {
        const floorY = this.floorYAt(this.lastPosition.x, this.lastPosition.z);
        if (this.lastPosition.y < floorY) this.lastPosition.y = floorY;
      }
      this.camera.position.copyFrom(this.lastPosition);

      const { x: lookX, z: lookZ } = Utils.rotate2D(
        0,
        this.lookOffsetZ,
        this.cameraAngle,
      );
      const newLook = this._newLook || (this._newLook = new BABYLON.Vector3());
      newLook.set(
        referencePoint.x + lookX,
        referencePoint.y + this.lookOffsetY,
        referencePoint.z + lookZ,
      );
      // Smooth the look target too (same rate as position) so any transient in the
      // aim point — an impact, a landing bounce — can't snap the view's rotation.
      const lookTarget = this._camLook || (this._camLook = newLook.clone());
      BABYLON.Vector3.LerpToRef(lookTarget, newLook, fPos, lookTarget);
      this.camera.setTarget(lookTarget);
    }
  }

  /**
   * Cinematic tee→green flyover: glide down the fairway, circle the pin ~180°
   * while closing in, then peel off straight to the tee keeping the pin in view.
   * Runs on its own temporary camera and resolves when the animation ends.
   */
  class DroneCamera {
    constructor(scene) {
      this.scene = scene;
    }

    fly(teePos, pinPos, restoreCamera, duration = 5000) {
      return new Promise((resolve) => {
        const scene = this.scene;
        const dir = pinPos.subtract(teePos);
        dir.y = 0;
        if (dir.lengthSquared() < 1e-3) dir.set(0, 0, 1);
        dir.normalize();
        const mid = BABYLON.Vector3.Center(teePos, pinPos);
        const off = (along, x, y) =>
          teePos.add(dir.scale(along)).add(new BABYLON.Vector3(x, y, 0));

        // Enter abeam of the green (the fairway glide is already tangent to the
        // circle), spiral in over ~180°, then peel off straight toward the tee —
        // no second wide loop. The pin stays in frame from the entry onward.
        const entryAngle = Math.atan2(-dir.x, dir.z); // radial ⟂ fairway; tangent = dir
        const R0 = 20,
          R1 = 10; // loop radius shrinks wide → tight (the zoom-in)
        const H0 = 16,
          H1 = 6; // loop height eases down with it
        const finalPos = off(-9, 0, 5); // ends behind the tee, pin in view
        const orbitPos = (angle, r, h) =>
          new BABYLON.Vector3(
            pinPos.x + Math.cos(angle) * r,
            pinPos.y + h,
            pinPos.z + Math.sin(angle) * r,
          );

        // Timeline (eased): approach glide, a 180° orbit spiralling in, then a
        // break-off straight to the tee — no second wide loop.
        const FRAC_A = 0.28; // approach glide
        const FRAC_ORBIT = 0.44; // 180° circle around the pin
        const FRAC_TEE = 1 - FRAC_A - FRAC_ORBIT; // peel off to the tee
        const orbitTurns = Math.PI; // 180°

        // Approach: cubic Bezier from behind the tee to the orbit entry point,
        // arriving at the loop's entry velocity (tangent = fairway dir) so the
        // join needs no correction.
        const radial = new BABYLON.Vector3(dir.z, 0, -dir.x); // orbit-entry side
        const a0 = off(-14, 0, 26);
        const a2 = orbitPos(entryAngle, R0, H0);
        const entrySpeed = (orbitTurns / FRAC_ORBIT) * R0; // rad/tl · m = m/tl
        const c1 = mid.add(radial.scale(8)).add(new BABYLON.Vector3(0, 38, 0));
        const c2 = a2.subtract(dir.scale((entrySpeed * FRAC_A) / 3));
        const tgt0 = off(30, 0, 1); // initial look: down the fairway

        // Break-off from the 180° point straight to the tee: a quadratic Bezier
        // that leaves roughly along the orbit tangent (smooth peel-off) then heads
        // home to finalPos, pin held in view.
        const orbitEndAngle = entryAngle + orbitTurns;
        const orbitEnd = orbitPos(orbitEndAngle, R1, H1);
        const tan = new BABYLON.Vector3(
          -Math.sin(orbitEndAngle),
          0,
          Math.cos(orbitEndAngle),
        );
        const teeC = orbitEnd.add(
          tan.scale(BABYLON.Vector3.Distance(orbitEnd, finalPos) * 0.2),
        );

        const smooth = (u) => u * u * (3 - 2 * u);

        const cam = new BABYLON.UniversalCamera("droneCam", a0.clone(), scene);
        cam.fov = 1.05;
        cam.minZ = 0.2;
        const prevActive = scene.activeCamera;
        scene.activeCamera = cam;

        let elapsed = 0;
        let done = false;
        let obs = null;
        const finish = () => {
          if (done) return;
          done = true;
          if (obs) scene.onBeforeRenderObservable.remove(obs);
          scene.activeCamera = restoreCamera || prevActive;
          cam.dispose();
          resolve();
        };

        obs = scene.onBeforeRenderObservable.add(() => {
          // Clamp dt so a throttled/background frame can't jump the whole flight
          elapsed += Math.min(scene.getEngine().getDeltaTime(), 60);
          const u = Math.min(elapsed / duration, 1);
          const s = smooth(u); // one global ease over the whole flight
          if (s < FRAC_A) {
            const g = s / FRAC_A;
            const inv = 1 - g;
            const p = a0
              .scale(inv * inv * inv)
              .addInPlace(c1.scale(3 * g * inv * inv))
              .addInPlace(c2.scale(3 * g * g * inv))
              .addInPlace(a2.scale(g * g * g));
            cam.position.copyFrom(p);
            // Hand the look target from down-the-fairway to the pin over the
            // first half of the glide.
            cam.setTarget(
              BABYLON.Vector3.Lerp(tgt0, pinPos, smooth(Math.min(1, g / 0.55))),
            );
          } else if (s < FRAC_A + FRAC_ORBIT) {
            // 180° orbit, spiralling in (radius R0→R1, height H0→H1), pin in frame.
            const x = (s - FRAC_A) / FRAC_ORBIT;
            const angle = entryAngle + orbitTurns * x;
            const k = smooth(x);
            cam.position.copyFrom(
              orbitPos(angle, R0 + (R1 - R0) * k, H0 + (H1 - H0) * k),
            );
            cam.setTarget(pinPos);
          } else {
            // Peel off straight toward the tee, still looking at the pin.
            const y = (s - FRAC_A - FRAC_ORBIT) / FRAC_TEE;
            const inv = 1 - y;
            const p = orbitEnd
              .scale(inv * inv)
              .addInPlace(teeC.scale(2 * y * inv))
              .addInPlace(finalPos.scale(y * y));
            cam.position.copyFrom(p);
            cam.setTarget(pinPos);
          }
          if (u >= 1) finish();
        });
        // Guarantee the round proceeds even if rendering stalls.
        setTimeout(finish, duration + 2500);
      });
    }
  }

  Object.assign(global, { FollowCamera, DroneCamera });
  if (typeof module !== "undefined" && module.exports)
    module.exports = { FollowCamera, DroneCamera };
})(typeof globalThis !== "undefined" ? globalThis : this);
