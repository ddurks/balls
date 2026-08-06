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
   * Cinematic tee→green flyover: glide down the fairway, circle the pin a full
   * 360° while closing in, then pull back to the tee keeping the pin in view.
   * Runs on its own temporary camera and resolves when the animation ends.
   */
  class DroneCamera {
    constructor(scene) {
      this.scene = scene;
    }

    fly(teePos, pinPos, restoreCamera, duration = 10000) {
      return new Promise((resolve) => {
        const scene = this.scene;
        const dir = pinPos.subtract(teePos);
        dir.y = 0;
        if (dir.lengthSquared() < 1e-3) dir.set(0, 0, 1);
        dir.normalize();
        const mid = BABYLON.Vector3.Center(teePos, pinPos);
        const off = (along, x, y) =>
          teePos.add(dir.scale(along)).add(new BABYLON.Vector3(x, y, 0));

        // Orbit + return are ONE parametric sweep around the pin: enter abeam
        // of the green (so the fairway glide is already tangent to the circle),
        // spiral in over a full 360°, then keep the same rotation going while
        // the radius opens back out until the arc lands exactly behind the tee.
        // A single curve means there is no phase boundary to stall or snap at.
        const entryAngle = Math.atan2(-dir.x, dir.z); // radial ⟂ fairway; tangent = dir
        const R0 = 20,
          R1 = 10; // loop radius shrinks wide → tight (the zoom-in)
        const H0 = 16,
          H1 = 6; // loop height eases down with it
        const finalPos = off(-9, 0, 5);
        const homeVec = finalPos.subtract(pinPos);
        // Extra sweep past the full loop to reach the tee's bearing, in the
        // same rotational direction; keep at least a quarter turn so the
        // radius has room to open out gradually.
        let homeSweep =
          (Math.atan2(homeVec.z, homeVec.x) - entryAngle) % (2 * Math.PI);
        if (homeSweep < Math.PI / 2) homeSweep += 2 * Math.PI;
        const totalSweep = 2 * Math.PI + homeSweep;
        const loopEnd = (2 * Math.PI) / totalSweep; // sweep fraction where the 360° completes
        const homeRadius = Math.hypot(homeVec.x, homeVec.z);
        const orbitPos = (angle, r, h) =>
          new BABYLON.Vector3(
            pinPos.x + Math.cos(angle) * r,
            pinPos.y + h,
            pinPos.z + Math.sin(angle) * r,
          );

        // Fraction of the eased timeline spent on the approach; the sweep gets
        // the rest.
        const FRAC_A = 0.3;
        const sweepX = 1 - FRAC_A;

        // Approach: cubic Bezier from behind the tee to the orbit entry point.
        // c1 pulls the glide up over the fairway; c2 sits behind the entry
        // point along the circle's tangent, at the distance that makes the
        // arrival velocity exactly the loop's entry velocity (level, tangent
        // direction, matching speed) — so the join needs no correction at all.
        const radial = new BABYLON.Vector3(dir.z, 0, -dir.x); // orbit-entry side
        const a0 = off(-14, 0, 26);
        const a2 = orbitPos(entryAngle, R0, H0);
        const entrySpeed = (totalSweep / sweepX) * R0; // rad/tl · m = m/tl
        const c1 = mid.add(radial.scale(8)).add(new BABYLON.Vector3(0, 38, 0));
        const c2 = a2.subtract(dir.scale((entrySpeed * FRAC_A) / 3));
        const tgt0 = off(30, 0, 1); // initial look: down the fairway

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
          } else {
            // Constant-rate sweep around the pin: 360° spiralling in, then the
            // radius opens out and the same arc carries the camera home to the
            // tee — pin held in frame the whole way.
            const x = (s - FRAC_A) / sweepX;
            const angle = entryAngle + totalSweep * x;
            let r, h;
            if (x < loopEnd) {
              const k = smooth(x / loopEnd);
              r = R0 + (R1 - R0) * k;
              h = H0 + (H1 - H0) * k;
            } else {
              const k = (x - loopEnd) / (1 - loopEnd);
              // Radius opens out ~20× on the way home, so use eases whose
              // slope AND curvature are zero at the join — anything less kicks
              // the camera outward the moment the loop completes.
              const e = k * k * k * (k * (k * 6 - 15) + 10); // smootherstep
              r = R1 + (homeRadius - R1) * e;
              const lift = 12 * Math.sin(Math.PI * k) ** 3;
              h = H1 + (homeVec.y - H1) * e + lift;
            }
            cam.position.copyFrom(orbitPos(angle, r, h));
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
