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
   * Cinematic tee→green flyover, then a swoop down to the tee. Runs on its own
   * temporary camera and resolves when the animation ends.
   */
  class DroneCamera {
    constructor(scene) {
      this.scene = scene;
    }

    fly(teePos, pinPos, restoreCamera, duration = 6500) {
      return new Promise((resolve) => {
        const scene = this.scene;
        const dir = pinPos.subtract(teePos);
        dir.y = 0;
        if (dir.lengthSquared() < 1e-3) dir.set(0, 0, 1);
        dir.normalize();
        const mid = BABYLON.Vector3.Center(teePos, pinPos);
        const off = (along, x, y) =>
          teePos.add(dir.scale(along)).add(new BABYLON.Vector3(x, y, 0));

        // Normalized keyframes: behind/above tee → glide down the fairway →
        // high over the green → swoop back to just behind the ball at the tee.
        const keys = [
          { t: 0.0, pos: off(-14, 0, 26), tgt: off(30, 0, 1) },
          {
            t: 0.3,
            pos: mid.add(new BABYLON.Vector3(8, 34, 0)),
            tgt: pinPos.clone(),
          },
          {
            t: 0.55,
            pos: pinPos.add(dir.scale(26)).add(new BABYLON.Vector3(-8, 24, 0)),
            tgt: pinPos.clone(),
          },
          {
            t: 0.75,
            pos: pinPos.add(dir.scale(8)).add(new BABYLON.Vector3(0, 14, 0)),
            tgt: pinPos.clone(),
          },
          { t: 1.0, pos: off(-9, 0, 5), tgt: off(24, 0, 1) },
        ];

        const smooth = (u) => u * u * (3 - 2 * u);
        const sample = (s, prop) => {
          let i = 0;
          while (i < keys.length - 2 && s > keys[i + 1].t) i++;
          const a = keys[i];
          const b = keys[i + 1];
          const local = (s - a.t) / (b.t - a.t || 1);
          return BABYLON.Vector3.Lerp(
            a[prop],
            b[prop],
            Shared.clamp(local, 0, 1),
          );
        };

        const cam = new BABYLON.UniversalCamera(
          "droneCam",
          keys[0].pos.clone(),
          scene,
        );
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
          const s = smooth(u);
          cam.position.copyFrom(sample(s, "pos"));
          cam.setTarget(sample(s, "tgt"));
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
