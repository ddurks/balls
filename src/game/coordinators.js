// coordinators.js — SwingCoordinator, GameStateCoordinator.
// Split out of game.js; loaded as a plain <script> before game.js (see game.html),
// and require()-able in Node for unit tests. Cross-module refs resolve via globals.
(function (global) {
  // ─── SWING COORDINATOR ───────────────────────────────────────────────────────

  class SwingCoordinator {
    constructor(game, clubSystem, golfBall, camera, ballTrail) {
      this.game = game;
      this.clubSystem = clubSystem;
      this.golfBall = golfBall;
      this.camera = camera;
      this.ballTrail = ballTrail;
    }

    executeSwing(shotDirection, force, deltaX, deltaY) {
      const currentClubId = this.game.aimView?.currentClub ?? 12;
      const club = ClubData.getClub(currentClubId);

      // Ball's committed — the "back to club select" option is gone.
      this.game.circleUIManager?.hideClubBackButton();

      this.game.swingCameraRestored = false;

      // Zoom camera out for swing view (scaled to the 42.7 mm ball; old values
      // 0,14,20,7,0 were for the ~0.4 m ball → framed way too far/high now).
      this.camera.setOffsets(0, 1.5, 2.1, 0.75, 0);

      // Trigger club swing animation (visual only, no physics pause)
      if (this.clubSystem && this.clubSystem.isLoaded) {
        const forceRatio = Math.min(
          force / (CONFIG.GOLF_BALL.MAX_HIT_STRENGTH * 100),
          1,
        );

        // Apply impulse at contact frame (frame 80/100 of the animation)
        const onContactPoint = () => {
          this.golfBall.landed = false;
          this.golfBall.applyHit(
            deltaX,
            deltaY,
            force,
            shotDirection,
            club.angle,
            club.v0,
          );
        };

        const onSwingEnd = () => {
          this.camera.setPlayView();
        };

        const ballPos = this.golfBall.getPosition();
        this.clubSystem.swing(
          currentClubId,
          forceRatio,
          ballPos,
          shotDirection,
          onContactPoint,
          onSwingEnd,
        );
      }

      this.ballTrail.startTracing();
      this.camera.setShotStartPosition(this.golfBall.getPosition());
    }
  }

  // ─── GAME STATE COORDINATOR ─────────────────────────────────────────────────

  class GameStateCoordinator {
    constructor(game) {
      this.game = game;
    }

    transitionAimToPlay(shotDirection) {
      this.game.aimedDirection = shotDirection;
      this.game.gameState = GameState.PLAY;
      this.game.justTransitioned = true;
      this.game._awaitingSettle = false; // new shot cancels any pending settle→aim
      this.game.currentHoleShotCount++;

      if (this.game.circleUIManager) {
        this.game.circleUIManager.showStatsCircle();
        this.game.circleUIManager.showPowerCircle();
        this.game.circleUIManager.hideClubCircle();
        this.game.circleUIManager.showClubBackButton();
        this.game.circleUIManager.showCompassCircle();
      }

      if (this.game.aimView) {
        this.game.aimView.removeOrbitControls();
        this.game.aimView.deactivate();
      }

      this.game.golfBall.startSpinTransition();
    }

    handleBallLanded() {
      this.game.gameState = GameState.LANDED;
      this.game.justTransitioned = true;
    }

    resetForNextHole() {
      this.game.golfBall.reset();
      this.game.ballTrail.clear();
      this.game.ballTrail.setVisible(false);
      this.game.clearArchivedTrails();
      this.game.gameState = GameState.AIM;
      this.game.golfBallFacingCamera = false;
      this.game.swingCameraRestored = false;

      if (this.game.clubSystem) {
        this.game.clubSystem.resetClubs();
      }

      if (this.game.circleUIManager) {
        this.game.circleUIManager.hidePowerCircle();
      }

      if (this.game.aimView) {
        this.game.aimView.cameraRotation = 0;
        this.game.aimView.activate();
      }
    }

    toggleMode() {
      if (this.game.gameState === GameState.AIM) {
        if (this.game.aimView) {
          this.transitionAimToPlay(this.game.aimView.cameraRotation);
        }
      }
      // (Clicking the club circle in PLAY mode used to reset the shot to the tee;
      // that mulligan was removed — it fired accidentally and threw the ball back.)
    }

    // Back out of strike mode (the "club select" button) — only valid before the
    // ball is struck. Reverses transitionAimToPlay: un-counts the up-front stroke,
    // drops the tee-anchored trail, and re-arms aim so the player can change clubs.
    transitionPlayToAim() {
      if (this.game.gameState !== GameState.PLAY) return;
      if (this.game.golfBall.isAirborne()) return; // shot already committed

      this.game.gameState = GameState.AIM;
      this.game._awaitingSettle = false;
      if (this.game.currentHoleShotCount > 0) this.game.currentHoleShotCount--;

      if (this.game.ballTrail) {
        this.game.ballTrail.stopTracing();
        this.game.ballTrail.clear();
      }

      if (this.game.circleUIManager) {
        this.game.circleUIManager.hidePowerCircle();
      }

      // activate() restores orbit controls, the trajectory arrow, aim camera, and
      // re-shows the club carousel (which also hides the back button). It also
      // resets the club to the auto-suggestion — but here the player backed out
      // precisely to change clubs, so keep their current pick: snapshot it around
      // activate() and repaint the carousel. Preserving manuallySelectedClub stops
      // the aim loop's auto-select from clobbering the restored club.
      if (this.game.aimView) {
        const club = this.game.aimView.currentClub;
        const manual = this.game.aimView.manuallySelectedClub;
        this.game.aimView.activate();
        this.game.aimView.currentClub = club;
        this.game.aimView.manuallySelectedClub = manual;
        this.game.aimView.clubSelector.updateUI();
      }
    }

    applySpin(spinAxis, spinAmount) {
      if (this.game.gameState !== GameState.PLAY) return;
      this.game.golfBall.applySpin(spinAxis, spinAmount);
    }
  }

  Object.assign(global, { SwingCoordinator, GameStateCoordinator });
  if (typeof module !== "undefined" && module.exports)
    module.exports = { SwingCoordinator, GameStateCoordinator };
})(typeof globalThis !== "undefined" ? globalThis : this);
