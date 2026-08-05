// input.js — InputHandler.
// Split out of game.js; loaded as a plain <script> before game.js (see game.html),
// and require()-able in Node for unit tests. Cross-module refs resolve via globals.
(function (global) {
  // ─── INPUT HANDLER ──────────────────────────────────────────────────────────

  class InputHandler {
    constructor(
      canvas,
      golfBall,
      game = null,
      eventManager = null,
      swipeOverlay = null,
      circleUIManager = null,
    ) {
      this.canvas = canvas;
      this.golfBall = golfBall;
      this.game = game;
      this.eventManager = eventManager || new EventManager();
      this.swipeOverlay = swipeOverlay;
      this.circleUIManager = circleUIManager;
      this.touchStartX = 0;
      this.touchStartY = 0;
      this.touchStartTime = 0;
      this.isHitting = false;
      this.isSpinning = false;
      this.currentSwipeDistance = 0;
      this.pointerActive = false;
      this.overviewOrbiting = false;
      this.lastPointerX = 0;
      this.spinColorIndex = 0;
      this.currentSpinColor = CONFIG.SWIPE_OVERLAY.SPIN_COLORS[0];

      this.setupListeners();
    }

    isAimMode() {
      return this.game?.gameState === GameState.AIM;
    }

    isShotReviewMode() {
      return this.game?.camera?.viewMode === CameraViewMode.SHOT_REVIEW;
    }

    canShowIdealArrow() {
      return (
        this.game?.gameState === GameState.PLAY &&
        this.golfBall.isLanded() &&
        !this.isSpinning &&
        !this.game?.aimView?.isActive &&
        !this.isShotReviewMode()
      );
    }

    getHitForceFromDistance(distance) {
      const scale = CONFIG.SWIPE_OVERLAY.VISUAL_SCALE;
      const maxForce = CONFIG.GOLF_BALL.MAX_HIT_STRENGTH * 100;
      return Math.min((distance / scale / 50) * 100, maxForce);
    }

    clearInputPreview() {
      this.isHitting = false;
      this.isSpinning = false;
      this.currentSwipeDistance = 0;
      this.updateUIFeedback(0);
      this.swipeOverlay?.clearLiveArrow();
    }

    clampSwipeVector(deltaX, deltaY) {
      const length = Math.sqrt(deltaX * deltaX + deltaY * deltaY);
      if (length <= CONFIG.SWIPE_OVERLAY.MAX_PREVIEW_LENGTH) {
        return { deltaX, deltaY };
      }
      const scale = CONFIG.SWIPE_OVERLAY.MAX_PREVIEW_LENGTH / length;
      return { deltaX: deltaX * scale, deltaY: deltaY * scale };
    }

    buildPinCandidates(ballPos, aimedDirection) {
      const candidates = [];
      for (const pin of this.game.scene.pinManager.pins) {
        const dx = pin.mesh.position.x - ballPos.x;
        const dz = pin.mesh.position.z - ballPos.z;
        const worldDistance = Math.sqrt(dx * dx + dz * dz);
        const local = Utils.rotate2D(dx, dz, -aimedDirection);
        const depth = -local.z;
        const angleError = Math.abs(
          Math.atan2(local.x, Math.max(0.001, depth)),
        );
        const isAimed =
          depth > 0 &&
          angleError <= CONFIG.SWIPE_OVERLAY.AIM_SELECTION_ANGLE_RAD;
        candidates.push({
          dx,
          dz,
          local,
          depth,
          angleError,
          worldDistance,
          isAimed,
        });
      }
      return candidates;
    }

    pickTargetCandidate(candidates) {
      const aimedCandidates = candidates.filter((c) => c.isAimed);
      if (aimedCandidates.length === 1) {
        return aimedCandidates[0];
      }
      if (aimedCandidates.length > 1) {
        return aimedCandidates.reduce((closest, candidate) =>
          candidate.worldDistance < closest.worldDistance ? candidate : closest,
        );
      }
      if (candidates.length > 0) {
        return candidates.reduce((closest, candidate) =>
          candidate.worldDistance < closest.worldDistance ? candidate : closest,
        );
      }
      return null;
    }

    // Damped point-mass range for a launch at (speed, loft). Used only to shape the
    // power curve for the ideal-swipe assist — its absolute output is normalised out
    // in predictLandingRangeForStrength, which anchors full power to the club's
    // calibrated carry.
    simFlightRange(launchSpeed, loftRad, dt, linearDamping, gAbs) {
      let vx = launchSpeed * Math.cos(loftRad);
      let vy = launchSpeed * Math.sin(loftRad);
      let x = 0;
      let y = 0;
      for (let i = 0; i < 600; i++) {
        vy += (-gAbs - linearDamping * vy) * dt;
        vx += -linearDamping * vx * dt;
        y += vy * dt;
        x += vx * dt;
        if (i > 1 && y <= 0) break;
      }
      return Math.max(0, x);
    }

    // Predicted carry for a swipe strength with `club`, under the same per-club launch
    // model as applyHit: launch at the club's loft with speed club.v0·powerRatio. Full
    // power is anchored to the club's calibrated carry (maxDistance) so the assist
    // agrees with what the ball actually does; the flight sim only supplies the shape
    // of the power curve between 0 and full.
    predictLandingRangeForStrength(strength, dt, linearDamping, gAbs, club) {
      const powerRatio = strength / CONFIG.GOLF_BALL.MAX_HIT_STRENGTH;
      const loftRad = (club.angle * Math.PI) / 180;
      const full = this.simFlightRange(
        club.v0,
        loftRad,
        dt,
        linearDamping,
        gAbs,
      );
      // Putter (loft 0) rolls rather than flies — sim range is ~0; approximate linearly.
      if (full <= 0.01) return club.maxDistance * powerRatio;
      const atPower = this.simFlightRange(
        club.v0 * powerRatio,
        loftRad,
        dt,
        linearDamping,
        gAbs,
      );
      return (club.maxDistance * atPower) / full;
    }

    solveSwipeStrengthForDistance(
      worldDistance,
      dt,
      linearDamping,
      gAbs,
      club,
    ) {
      // This binary search runs a 600-step integration 14× and is called every
      // frame while aiming. The target distance barely moves frame-to-frame (the
      // ball is at rest), so memoize on the inputs and skip the ~8,400-step solve.
      const c = this._strengthCache;
      if (
        c &&
        c.dt === dt &&
        c.damping === linearDamping &&
        c.g === gAbs &&
        c.clubId === club.id &&
        Math.abs(c.dist - worldDistance) < 0.5
      ) {
        return c.strength;
      }

      const minStrength = CONFIG.SWIPE_OVERLAY.MIN_FORWARD_FORCE / 100;
      const maxStrength = CONFIG.GOLF_BALL.MAX_HIT_STRENGTH;
      let low = minStrength;
      let high = maxStrength;

      for (let i = 0; i < 14; i++) {
        const mid = (low + high) * 0.5;
        const predictedRange = this.predictLandingRangeForStrength(
          mid,
          dt,
          linearDamping,
          gAbs,
          club,
        );
        if (predictedRange < worldDistance) {
          low = mid;
        } else {
          high = mid;
        }
      }

      const strength = Shared.clamp(high, minStrength, maxStrength);
      this._strengthCache = {
        dist: worldDistance,
        dt,
        damping: linearDamping,
        g: gAbs,
        clubId: club.id,
        strength,
      };
      return strength;
    }

    buildIdealSwipeVector(best, aimedDirection, swipeStrength) {
      const desiredForwardForce =
        PhysicsConfig.HIT_FORWARD_FORCE * swipeStrength;
      const force = swipeStrength * 100;
      const baseLength = force / 2;

      const local =
        best.local || Utils.rotate2D(best.dx, best.dz, -aimedDirection);
      const depth = Math.max(1, -local.z);
      const desiredLateralRatio = Math.max(
        -CONFIG.SWIPE_OVERLAY.MAX_LATERAL_RATIO,
        Math.min(CONFIG.SWIPE_OVERLAY.MAX_LATERAL_RATIO, local.x / depth),
      );
      const desiredLateralForce = Math.max(
        -CONFIG.SWIPE_OVERLAY.MAX_LATERAL_FORCE,
        Math.min(
          CONFIG.SWIPE_OVERLAY.MAX_LATERAL_FORCE,
          desiredForwardForce * desiredLateralRatio,
        ),
      );

      let deltaX =
        -desiredLateralForce / CONFIG.GOLF_BALL.HIT_HORIZONTAL_DEVIATION_FACTOR;
      let swipeLen = Math.max(
        CONFIG.SWIPE_OVERLAY.IDEAL_MIN_PREVIEW_LENGTH,
        baseLength,
        Math.abs(deltaX) + 6,
      );

      deltaX = Shared.clamp(deltaX, -(swipeLen - 1), swipeLen - 1);
      let deltaY = -Math.sqrt(
        Math.max(1, swipeLen * swipeLen - deltaX * deltaX),
      );

      const clamped = this.clampSwipeVector(deltaX, deltaY);
      return { deltaX: clamped.deltaX, deltaY: clamped.deltaY };
    }

    computeIdealHitSwipe() {
      if (!this.game?.scene?.pinManager?.pins?.length) return null;
      const ballPos = this.golfBall.getPosition();
      const aimedDirection =
        this.game?.getShotDirection?.() || this.game.aimedDirection || 0;

      const candidates = this.buildPinCandidates(ballPos, aimedDirection);
      const best = this.pickTargetCandidate(candidates);
      if (!best) return null;

      const dt = CONFIG.SWIPE_OVERLAY.PHYSICS_STEP_SECONDS;
      const linearDamping = PhysicsConfig.BALL_LINEAR_DAMPING;
      const gAbs = Math.abs(PhysicsConfig.GRAVITY.y);
      // Assist is for the club the player will actually hit with.
      const club = ClubData.getClub(this.game?.aimView?.currentClub ?? 12);
      const swipeStrength = this.solveSwipeStrengthForDistance(
        best.worldDistance,
        dt,
        linearDamping,
        gAbs,
        club,
      );
      const { deltaX, deltaY } = this.buildIdealSwipeVector(
        best,
        aimedDirection,
        swipeStrength,
      );

      const scale = CONFIG.SWIPE_OVERLAY.VISUAL_SCALE;
      const start = this.swipeOverlay.getGuideStartPoint();
      return {
        start,
        end: { x: start.x + deltaX * scale, y: start.y + deltaY * scale },
      };
    }

    updateSwipeOverlay(deltaMs) {
      if (!this.swipeOverlay) return;

      const showIdeal = this.canShowIdealArrow();

      if (showIdeal) {
        const ideal = this.computeIdealHitSwipe();
        if (ideal) this.swipeOverlay.setIdealArrow(ideal.start, ideal.end);
        else this.swipeOverlay.clearIdealArrow();
      } else {
        this.swipeOverlay.clearIdealArrow();
      }

      this.swipeOverlay.update(deltaMs);
    }

    setupListeners() {
      this.canvas.addEventListener("pointerdown", (e) =>
        this.handlePointerDown(e),
      );
      this.canvas.addEventListener("pointermove", (e) =>
        this.handlePointerMove(e),
      );
      this.canvas.addEventListener("pointerup", (e) => this.handlePointerUp(e));
    }

    handlePointerDown(event) {
      this.pointerActive = true;
      this.touchStartX = event.clientX;
      this.touchStartY = event.clientY;
      this.touchStartTime = Date.now();
      this.game.justTransitioned = false;

      // In shot review mode, allow orbit controls but block game actions
      if (this.isShotReviewMode() && this.golfBall.isLanded()) {
        this.overviewOrbiting = true;
        this.lastPointerX = event.clientX;
        this.clearInputPreview();
        return;
      }

      if (this.game?.isControlsDisabled) return;

      if (this.isAimMode()) {
        return;
      }

      if (this.golfBall.isLanded()) {
        this.isHitting = true;
      } else {
        this.isSpinning = true;
        this.currentSpinColor =
          CONFIG.SWIPE_OVERLAY.SPIN_COLORS[
            this.spinColorIndex % CONFIG.SWIPE_OVERLAY.SPIN_COLORS.length
          ];
        this.spinColorIndex++;
      }
    }

    updateUIFeedback(amount, label = "") {
      if (this.circleUIManager) {
        this.circleUIManager.updatePower(amount * 100);
      }
    }

    handlePointerMove(event) {
      if (!this.pointerActive) return;
      if (this.isAimMode()) return;

      if (this.overviewOrbiting) {
        const deltaX = event.clientX - this.lastPointerX;
        this.lastPointerX = event.clientX;
        const sensitivity = CONFIG.FOLLOW_CAMERA.OVERVIEW_ORBIT_SENSITIVITY;
        this.game?.camera?.setCameraAngle(
          (this.game?.camera?.targetCameraAngle || 0) - deltaX * sensitivity,
        );
        return;
      }

      const deltaX = event.clientX - this.touchStartX;
      const deltaY = event.clientY - this.touchStartY;
      this.currentSwipeDistance = Math.sqrt(deltaX * deltaX + deltaY * deltaY);

      if (this.isHitting) {
        const force = this.getHitForceFromDistance(this.currentSwipeDistance);
        const maxForce = CONFIG.GOLF_BALL.MAX_HIT_STRENGTH * 100;
        this.updateUIFeedback(
          Math.min(force / maxForce, 1),
          "Force: " + force.toFixed(0),
        );
      } else {
        this.updateUIFeedback(Math.min(this.currentSwipeDistance / 100, 1));
      }
    }

    handlePointerUp(event) {
      if (!this.pointerActive) return;
      if (this.game?.isControlsDisabled) return;
      this.pointerActive = false;
      const deltaX = event.clientX - this.touchStartX;
      const deltaY = event.clientY - this.touchStartY;
      const distance = Math.sqrt(deltaX * deltaX + deltaY * deltaY);

      if (this.isAimMode()) {
        this.clearInputPreview();
        return;
      }

      if (this.game?.justTransitioned) {
        this.clearInputPreview();
        return;
      }

      if (this.overviewOrbiting) {
        this.overviewOrbiting = false;
        this.clearInputPreview();
        return;
      }

      if (this.game?.isControlsDisabled) return;

      if (
        this.isHitting &&
        this.golfBall.isLanded() &&
        distance > PhysicsConfig.MIN_SWIPE_DISTANCE
      ) {
        const scale = CONFIG.SWIPE_OVERLAY.VISUAL_SCALE;
        const force = this.getHitForceFromDistance(distance);
        const swipeDuration = Math.max(
          0.01,
          (Date.now() - this.touchStartTime) / 1000,
        );
        this.eventManager.emit("input:hit", {
          deltaX: deltaX / scale,
          deltaY: deltaY / scale,
          force,
          swipeDuration,
        });
        this.swipeOverlay?.addFadeArrow(
          { x: this.touchStartX, y: this.touchStartY },
          { x: event.clientX, y: event.clientY },
          CONFIG.SWIPE_OVERLAY.HIT_COLOR,
          CONFIG.SWIPE_OVERLAY.HIT_FADE_MS,
          CONFIG.SWIPE_OVERLAY.HIT_WIDTH,
        );
      } else if (
        this.isSpinning &&
        !this.golfBall.isLanded() &&
        distance > PhysicsConfig.MIN_SWIPE_DISTANCE &&
        this.golfBall.isAirborne()
      ) {
        const spinAmount = Math.min(distance / 50, 1.2);
        const magnitude = Math.sqrt(deltaX * deltaX + deltaY * deltaY);

        // Compute spin axis in screen space (camera-independent)
        let spinAxis = new BABYLON.Vector3(
          (deltaY / magnitude) * 0.1,
          0,
          (deltaX / magnitude) * 0.1,
        );

        // During play mode, rotate axis by inverse camera angle so it tracks with camera
        if (this.game?.gameState === GameState.PLAY) {
          const cameraAngle = this.game?.camera?.cameraAngle || 0;
          if (Math.abs(cameraAngle) > 0.01) {
            const rotationMatrix = BABYLON.Matrix.RotationY(-cameraAngle);
            spinAxis = BABYLON.Vector3.TransformCoordinates(
              spinAxis,
              rotationMatrix,
            );
          }
        }

        this.eventManager.emit("input:spin", {
          spinAxis,
          spinAmount: spinAmount * 0.4,
        });
        this.swipeOverlay?.addFadeArrow(
          { x: this.touchStartX, y: this.touchStartY },
          { x: event.clientX, y: event.clientY },
          this.currentSpinColor,
          CONFIG.SWIPE_OVERLAY.SPIN_FADE_MS,
          CONFIG.SWIPE_OVERLAY.SPIN_WIDTH,
        );
      }

      this.clearInputPreview();
    }
  }

  Object.assign(global, { InputHandler });
  if (typeof module !== "undefined" && module.exports)
    module.exports = { InputHandler };
})(typeof globalThis !== "undefined" ? globalThis : this);
