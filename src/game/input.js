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

    // A ball can be struck once its shot has come to rest, or while a placed
    // ball (tee, penalty drop) is still settling on the ground — waiting for
    // that rest would swallow the player's swipe.
    canHit() {
      const ball = this.golfBall;
      return ball.isLanded() || (!ball.inShot && !ball.isAirborne());
    }

    canShowIdealArrow() {
      return (
        this.game?.gameState === GameState.PLAY &&
        this.canHit() &&
        !this.isSpinning &&
        !this.game?.aimView?.isActive &&
        !this.isShotReviewMode()
      );
    }

    getHitSwipeScale() {
      // More finger travel gives short putts finer power and direction control.
      const isPutter = this.game?.aimView?.currentClub === 0;
      return CONFIG.SWIPE_OVERLAY.VISUAL_SCALE * (isPutter ? 2 : 1);
    }

    getHitForceFromDistance(distance) {
      const scale = this.getHitSwipeScale();
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
      if (club.angle === 0) {
        // Flat-green putt under GolfBallGuy's rolling law, in closed form. The ball
        // launches sliding without spin: kinetic friction μ brakes it and spins it
        // up (spin gains 5/2 of what it brakes) while the law also brakes it by
        // μr·g, until it rolls at v1; it then rolls out at 5/7·μr·g.
        const { friction: mu, rollingResistance: mr } = SURFACE_PHYSICS.green;
        const v0 = club.v0 * powerRatio;
        const skid = v0 / ((3.5 * mu + mr) * gAbs);
        const v1 = 2.5 * mu * gAbs * skid;
        return (
          v0 * skid -
          0.5 * (mu + mr) * gAbs * skid * skid +
          (0.7 * v1 * v1) / (mr * gAbs)
        );
      }
      const loftRad = (club.angle * Math.PI) / 180;
      const full = this.simFlightRange(
        club.v0,
        loftRad,
        dt,
        linearDamping,
        gAbs,
      );
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
        c.v0 === club.v0 &&
        Math.abs(c.dist - worldDistance) < (club.angle === 0 ? 0.001 : 0.5)
      ) {
        return c.strength;
      }

      const minStrength =
        club.angle === 0
          ? this.getHitForceFromDistance(PhysicsConfig.MIN_SWIPE_DISTANCE + 1) /
            100
          : CONFIG.SWIPE_OVERLAY.MIN_FORWARD_FORCE / 100;
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
        v0: club.v0,
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
      const club = ClubData.getClub(this.game?.aimView?.currentClub ?? 12);
      if (club.angle === 0) {
        const speed =
          (club.v0 * swipeStrength) / CONFIG.GOLF_BALL.MAX_HIT_STRENGTH;
        const lateralSpeed = (speed * local.x) / Math.max(0.001, -local.z);
        const lateralPerUnit =
          (CONFIG.GOLF_BALL.HIT_HORIZONTAL_DEVIATION_FACTOR *
            CONFIG.SWIPE_OVERLAY.PHYSICS_STEP_SECONDS) /
          CONFIG.BALL.MASS;
        const deltaX = Shared.clamp(
          -lateralSpeed / lateralPerUnit,
          -baseLength,
          baseLength,
        );
        // Preserve the solved power, including tap-ins; a display minimum must
        // never lengthen the stroke the player is being asked to reproduce.
        return {
          deltaX,
          deltaY: -Math.sqrt(Math.max(0, baseLength ** 2 - deltaX ** 2)),
        };
      }
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

      const dt = PhysicsConfig.STEP_SECONDS;
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

      const scale = this.getHitSwipeScale();
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

      const push = this.computeMagnusArrow();
      if (push) this.swipeOverlay.setMagnusArrow(push.start, push.end);
      else this.swipeOverlay.clearMagnusArrow();

      this.swipeOverlay.update(deltaMs);
    }

    // While a spun ball flies, an arrow from the ball showing where Magnus is
    // pushing it — the opposite of a sideways swipe, so the curve reads clearly.
    computeMagnusArrow() {
      const ball = this.golfBall;
      if (ball.isLanded() || !ball.isAirborne() || ball.pendingSpinAmount <= 0)
        return null;
      // Length follows the push's strength, so cancelled or decayed spin fades.
      const force = ball.magnusForceToRef(
        this._magnusForce || (this._magnusForce = new BABYLON.Vector3()),
      );
      const strength = Math.min(
        force.length() /
          CONFIG.BALL.MASS /
          CONFIG.SWIPE_OVERLAY.MAGNUS_ARROW_FULL_ACCEL,
        1,
      );
      if (strength < 0.1) return null;
      const dir = force.normalize();
      const cam = this.game.camera.camera;
      const dpr = window.devicePixelRatio || 1;
      const canvas = this.swipeOverlay.overlayCanvas;
      const viewport = cam.viewport.toGlobal(
        canvas.width / dpr,
        canvas.height / dpr,
      );
      // Anchored where the ball is drawn, not its raw physics step position.
      const pos = ball.getRenderPosition();
      // Offset in proportion to range so perspective doesn't shrink the arrow away.
      const tip = pos.add(
        dir.scale(0.05 * BABYLON.Vector3.Distance(pos, cam.position)),
      );
      // This frame's camera (already moved), not the scene's transform matrix,
      // which still holds last frame's view until render.
      const m = cam.getViewMatrix().multiply(cam.getProjectionMatrix());
      const id = BABYLON.Matrix.IdentityReadOnly;
      const a = BABYLON.Vector3.Project(pos, id, m, viewport);
      const b = BABYLON.Vector3.Project(tip, id, m, viewport);
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const len = Math.hypot(dx, dy);
      // Foreshortened like the push itself: one along the view axis barely shows.
      const across = Math.sqrt(
        Math.max(
          0,
          1 - BABYLON.Vector3.Dot(dir, cam.getDirection(BABYLON.Axis.Z)) ** 2,
        ),
      );
      if (len < 1 || strength * across < 0.1) return null;
      const k =
        (CONFIG.SWIPE_OVERLAY.MAGNUS_ARROW_LENGTH * strength * across) / len;
      return {
        start: { x: a.x, y: a.y },
        end: { x: a.x + dx * k, y: a.y + dy * k },
      };
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

      if (this.canHit()) {
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
        this.canHit() &&
        distance > PhysicsConfig.MIN_SWIPE_DISTANCE
      ) {
        const scale = this.getHitSwipeScale();
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
        const spinAmount = Math.min(distance / 100, 1.2);

        // The swipe drags the ball's camera-facing surface point (−forward·R)
        // along swipeWorld, so ω × (−forward) ∝ swipeWorld ⇒ ω ∝ swipeWorld ×
        // forward. Magnus (∝ ω × v) then pushes the ball AWAY from the swipe:
        // behind the ball, swipe right curves left, swipe down is backspin (lift).
        const cam = this.game.camera.camera;
        const swipeWorld = cam
          .getDirection(BABYLON.Axis.X)
          .scale(deltaX)
          .subtractInPlace(cam.getDirection(BABYLON.Axis.Y).scale(deltaY)); // screen y is down
        const spinAxis = BABYLON.Vector3.Cross(
          swipeWorld,
          cam.getDirection(BABYLON.Axis.Z),
        ).normalize();

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
