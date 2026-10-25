// aim.js — TrajectoryArrow, AimView, SwipeArrowOverlay.
// Split out of game.js; loaded as a plain <script> before game.js (see game.html),
// and require()-able in Node for unit tests. Cross-module refs resolve via globals.
(function (global) {
  // ─── TRAJECTORY ARROW ──────────────────────────────────────────────────────

  class TrajectoryArrow {
    constructor(scene, ballPos) {
      this.scene = scene;
      this.ballPos = ballPos;
      this.arrow = null;
      this.arrowTemplate = null;
      this.isLoaded = false;
      this.currentColor = new BABYLON.Color3(
        0xe1 / 255,
        0xe4 / 255,
        0x4e / 255,
      );
      this.loadArrowModel();
    }

    async loadArrowModel() {
      try {
        const result = await Shared.loadModel(
          "models/gameplay/arrow.glb",
          this.scene,
        );

        if (result.meshes && result.meshes.length > 0) {
          this.arrowTemplate = result.meshes[0];
          this.arrowTemplate.setEnabled(false);

          this.arrowTemplate.getChildMeshes().forEach((mesh) => {
            mesh.setEnabled(false);
          });

          this.isLoaded = true;
        }
      } catch (error) {
        console.error("Failed to load arrow.glb:", error);
      }
    }

    // Clone the template once and keep it: re-cloning per activation/club change
    // left a fresh StandardMaterial behind every time. Pitch is set per frame in
    // update(), so the clone never needs rebuilding.
    create() {
      if (!this.isLoaded || !this.arrowTemplate) return;

      if (!this.arrow) {
        this.arrow = this.arrowTemplate.clone("trajectoryArrow_instance");
        this.arrow.scaling.scaleInPlace(0.107); // Phase 1: match real golf-ball scale
        this.arrow.rotation = new BABYLON.Vector3(0, 0, 0);
        this.arrow.rotationQuaternion = null;

        // ─── CEL SHADING ──────────────────────────────────────────────
        this.mat = new BABYLON.StandardMaterial("arrowMat", this.scene);
        this.mat.specularColor = new BABYLON.Color3(0, 0, 0);
        this.mat.ambientColor = new BABYLON.Color3(0.6, 0.6, 0.6);
        this.mat.backFaceCulling = false; // Needed for outline rendering
        this.applyColor();

        const meshes = [this.arrow, ...this.arrow.getChildMeshes()];
        for (const mesh of meshes) {
          if (mesh.getTotalVertices && mesh.getTotalVertices() > 0)
            mesh.material = this.mat;
          // ─── OUTLINE ──────────────────────────────────────────────────
          mesh.outlineWidth = 0.15;
          mesh.outlineColor = new BABYLON.Color3(0, 0, 0);
          this.scene.shadowGenerator?.addShadowCaster(mesh, true);
        }
      }

      this.arrow.setEnabled(true);
      for (const mesh of this.arrow.getChildMeshes()) mesh.setEnabled(true);
    }

    update(ballPos, clubAngle, cameraRotation) {
      if (!this.arrow) this.create();
      if (!this.arrow) return;

      this.arrow.position.copyFrom(ballPos);
      this.arrow.position.y += CONFIG.TRAJECTORY.ARROW_Y_OFFSET;

      const angleDeg = Shared.clamp(clubAngle || 12, 0, 60);
      const angleRad = (angleDeg * Math.PI) / 180;

      // X rotation: pitch up based on club angle (negated to get correct direction)
      // Y rotation: 180° + camera rotation to face the aim direction
      this.arrow.rotation.x = -angleRad;
      this.arrow.rotation.y = Math.PI + cameraRotation;
      this.arrow.rotation.z = 0;
    }

    // Hidden, not disposed, between aims (see create()).
    dispose() {
      if (this.arrow) this.arrow.setEnabled(false);
    }

    setArrowColor(color) {
      if (this.currentColor.equals(color)) return;
      this.currentColor.copyFrom(color);
      this.applyColor();
    }

    applyColor() {
      if (!this.mat) return;
      this.mat.diffuseColor.copyFrom(this.currentColor);
      this.currentColor.scaleToRef(0.3, this.mat.emissiveColor);
    }
  }

  // Shared, read-only (setArrowColor copies them). Built on first use: this
  // module is require()d by Node tests before BABYLON is stubbed in.
  let ARROW_COLORS = null;

  // ─── AIM VIEW ──────────────────────────────────────────────────────────────

  class AimView {
    constructor(
      camera,
      ballMesh,
      golfBallGuy,
      scene,
      canvas,
      eventManager,
      game = null,
      circleUIManager = null,
    ) {
      this.camera = camera;
      this._target = new BABYLON.Vector3();
      this._greenCache = null;
      this.ballMesh = ballMesh;
      this.golfBallGuy = golfBallGuy;
      this.scene = scene;
      this.canvas = canvas;
      this.eventManager = eventManager;
      this.game = game;
      this.circleUIManager = circleUIManager;
      this.isActive = false;
      this.cameraDistance = CONFIG.AIM_VIEW.CAMERA_DISTANCE;
      this.cameraHeight = CONFIG.AIM_VIEW.CAMERA_HEIGHT;
      this.cameraRotation = 0;

      this.clubSelector = new ClubSelector(circleUIManager);

      this.trajectoryArrow = new TrajectoryArrow(scene, ballMesh.position);
      this.touchStartX = 0;
      this.touchStartY = 0;
      this.lastMouseX = 0;
      this.lastMouseY = 0;
      this.isDragging = false;

      // Initialize event handlers once so removeEventListener can find them
      this.initializeEventHandlers();
    }

    initializeEventHandlers() {
      this.onPointerDown = (e) => {
        if (!this.isActive) return;
        this.isDragging = true;
        this._aimDragging = false; // becomes true only past the tap dead-zone
        this.touchStartX = e.clientX;
        this.touchStartY = e.clientY;
        this.lastMouseX = e.clientX;
        this.lastMouseY = e.clientY;
      };

      this.onPointerMove = (e) => {
        if (!this.isDragging || !this.isActive) return;

        // NOTE: rotating the camera must NOT wipe a manual club pick. Auto-select
        // already tracks the aim every frame in update() while manuallySelectedClub
        // is false; the old enableAutoSelect() here only cleared the player's choice,
        // so switching clubs and then nudging the aim fired the shot with the
        // suggested club instead of the one you picked.

        // Tap dead-zone: a tap on the ball to enter swipe mode must NOT nudge the
        // aim. Hold off rotating until the pointer moves past the click threshold,
        // but keep tracking it so there's no jump the moment it becomes a real drag.
        if (!this._aimDragging) {
          const movedX = e.clientX - this.touchStartX;
          const movedY = e.clientY - this.touchStartY;
          if (
            Math.hypot(movedX, movedY) <=
            CONFIG.AIM_VIEW.CLICK_DETECTION_THRESHOLD
          ) {
            this.lastMouseX = e.clientX;
            this.lastMouseY = e.clientY;
            return;
          }
          this._aimDragging = true;
        }

        const deltaX = e.clientX - this.lastMouseX;
        const deltaY = e.clientY - this.lastMouseY;
        this.cameraRotation +=
          deltaX * CONFIG.AIM_VIEW.MOUSE_ROTATION_SENSITIVITY;
        this.cameraHeight += deltaY * CONFIG.AIM_VIEW.MOUSE_HEIGHT_SENSITIVITY;
        this.cameraHeight = Math.max(
          CONFIG.AIM_VIEW.CAMERA_HEIGHT_MIN,
          Math.min(CONFIG.AIM_VIEW.CAMERA_HEIGHT_MAX, this.cameraHeight),
        );
        this.lastMouseX = e.clientX;
        this.lastMouseY = e.clientY;
      };

      this.onPointerUp = (e) => {
        if (!this.isActive) return;
        this.isDragging = false;

        // Check if we clicked on the ball (distance from START, not from last frame)
        const deltaX = e.clientX - this.touchStartX;
        const deltaY = e.clientY - this.touchStartY;
        const distance = Math.sqrt(deltaX * deltaX + deltaY * deltaY);

        if (distance < CONFIG.AIM_VIEW.CLICK_DETECTION_THRESHOLD) {
          const pickResult = this.scene.pick(e.clientX, e.clientY);

          if (pickResult && pickResult.hit) {
            const pickedMesh = pickResult.pickedMesh;

            const pins = this.game?.scene?.pinManager?.pins;
            if (pins && pins.length > 0) {
              for (const pinData of pins) {
                if (
                  pickedMesh === pinData.mesh ||
                  pickedMesh?.parent === pinData.mesh
                ) {
                  const distanceToPin = BABYLON.Vector3.Distance(
                    this.ballMesh.position,
                    pinData.mesh.position,
                  );
                  const bestClubId =
                    this.clubSelector.findBestClubForDistance(distanceToPin);
                  this.clubSelector.selectClub(bestClubId);
                  this.clubSelector.updateUI();
                  return;
                }
              }
            }

            let isValidClick = false;
            if (pickedMesh === this.ballMesh || pickedMesh?.name === "gball") {
              isValidClick = true;
            } else {
              let parent = pickedMesh?.parent;
              while (parent) {
                if (parent === this.ballMesh) {
                  isValidClick = true;
                  break;
                }
                parent = parent.parent;
              }
            }

            if (isValidClick) {
              this.eventManager.emit("aimView:ballClicked");
            }
          }
        }
      };

      this.onKeyDown = (e) => {
        if (!this.isActive) return;
        if (this.clubSelector.handleKeyPress(e.key)) {
          this.clubSelector.updateUI();
        }
      };
    }

    get currentClub() {
      return this.clubSelector.currentClub;
    }

    set currentClub(value) {
      this.clubSelector.currentClub = value;
    }

    set manuallySelectedClub(value) {
      this.clubSelector.manuallySelectedClub = value;
    }

    get manuallySelectedClub() {
      return this.clubSelector.manuallySelectedClub;
    }

    activate() {
      // In a match the ball is only ours to aim on our turn.
      if (this.game?.match && !this.game.match.canAim()) return;
      this.isActive = true;
      this._greenCache = null; // new lie (or a new hole's surfaces)
      this.clubSelector.reset();
      this.camera.fov = CONFIG.CAMERA.FOV_AIM;

      this.golfBallGuy.setFacingCamera(this.camera.position);

      this.setupOrbitControls();
      this.trajectoryArrow.create();

      if (!this.game?.currentHolePin) {
        const ballPos = this.ballMesh.position;
        const pinManager = this.game?.scene?.pinManager;
        if (pinManager && pinManager.pins.length > 0) {
          const targetPinResult = pinManager.getTargetPin(
            ballPos,
            this.cameraRotation,
          );
          if (targetPinResult.pin) {
            this.game.currentHolePin = targetPinResult.pin;
            this.game.currentHoleShotCount = 0;
          }
        }
      }

      if (this.game?.currentHolePin) {
        const ballPos = this.ballMesh.position;
        const pinPos = this.game.currentHolePin.holePosition;
        const direction = pinPos.subtract(ballPos);
        const angleToPin = Math.atan2(direction.x, direction.z);
        this.cameraRotation = angleToPin + Math.PI; // Camera behind ball looking at pin
      }

      if (this.circleUIManager) {
        this.circleUIManager.showClubCircle();
        this.circleUIManager.showCompassCircle();
        this.circleUIManager.hidePowerCircle();
      }
      this.clubSelector.updateUI();
    }

    deactivate() {
      this.isActive = false;
      this.camera.fov = CONFIG.CAMERA.FOV_PLAY;
      this.removeOrbitControls();
      this.trajectoryArrow.dispose();
    }

    setupOrbitControls() {
      this.canvas.addEventListener("pointerdown", this.onPointerDown);
      this.canvas.addEventListener("pointermove", this.onPointerMove);
      this.canvas.addEventListener("pointerup", this.onPointerUp);
      document.addEventListener("keydown", this.onKeyDown);
    }

    removeOrbitControls() {
      this.canvas.removeEventListener("pointerdown", this.onPointerDown);
      this.canvas.removeEventListener("pointermove", this.onPointerMove);
      this.canvas.removeEventListener("pointerup", this.onPointerUp);
      document.removeEventListener("keydown", this.onKeyDown);
    }

    update() {
      if (!this.isActive) {
        return;
      }

      const ballPos = this.ballMesh.getAbsolutePosition();
      const cameraX =
        ballPos.x + Math.sin(this.cameraRotation) * this.cameraDistance;
      const cameraZ =
        ballPos.z + Math.cos(this.cameraRotation) * this.cameraDistance;

      let cameraY = ballPos.y + this.cameraHeight;
      // Governor: an up-slope behind the ball must not put the aim camera
      // underground (nor below the water surface).
      if (this.game?.cameraFloorY) {
        cameraY = Math.max(cameraY, this.game.cameraFloorY(cameraX, cameraZ));
      }
      this.camera.position.set(cameraX, cameraY, cameraZ);
      this._target.copyFrom(ballPos).y += 0.05;
      this.camera.setTarget(this._target);

      const club = ClubData.getClub(this.clubSelector.currentClub);

      const pins = this.game?.scene?.pinManager?.pins;

      if (pins && pins.length > 0) {
        try {
          // Metres, to match ClubData.maxDistance (used for club auto-select AND
          // the arrow-color ±10 m band below). Do NOT convert to yards here.
          const distanceToPin = this.getDistanceToNearestPin(ballPos);

          // Only default to the putter when the ball is actually on the green;
          // off the green the suggestion is at least a wedge. The ball is at
          // rest while aiming, so the surface ray runs once per ball position.
          if (!this.clubSelector.manuallySelectedClub) {
            const onGreen = this.isBallOnGreen(ballPos);
            if (
              this.clubSelector.autoSelectClubIfNeeded(distanceToPin, onGreen)
            )
              this.clubSelector.updateUI();
          }

          const predictedDistance =
            this.clubSelector.getPredictedDistanceForClub(club);
          const arrowColor = this.getArrowColor(
            predictedDistance,
            distanceToPin,
          );
          if (
            this.trajectoryArrow &&
            typeof this.trajectoryArrow.setArrowColor === "function"
          ) {
            this.trajectoryArrow.setArrowColor(arrowColor);
          }
        } catch (error) {
          console.warn("Error in auto-club selection:", error);
        }
      }

      this.trajectoryArrow.update(ballPos, club.angle, this.cameraRotation);
    }

    isBallOnGreen(ballPos) {
      const c = this._greenCache;
      if (c && BABYLON.Vector3.DistanceSquared(c.pos, ballPos) < 1e-6)
        return c.onGreen;
      const onGreen = !!this.game?.courseManager?.isOnGreen(ballPos);
      this._greenCache = { pos: ballPos.clone(), onGreen };
      return onGreen;
    }

    getDistanceToNearestPin(ballPos) {
      const pinManager = this.game?.scene?.pinManager;
      if (!pinManager) return 0;

      const { distance: targetDist, pin: targetPin } = pinManager.getTargetPin(
        ballPos,
        this.cameraRotation,
      );
      if (targetPin) return targetDist;

      const pins = pinManager.pins;
      const nearestPin = pins.reduce((nearest, pin) => {
        const dist = BABYLON.Vector3.Distance(ballPos, pin.mesh.position);
        return !nearest || dist < nearest.dist ? { dist, pin } : nearest;
      }, null);
      return nearestPin ? nearestPin.dist : 0;
    }

    findBestClubForDistance(distance) {
      return this.clubSelector.findBestClubForDistance(distance);
    }

    getPredictedDistance(club) {
      return this.clubSelector.getPredictedDistanceForClub(club);
    }

    getArrowColor(predictedDistance, distanceToPin) {
      const tolerance = 10; // ±10m tolerance for "on target"
      const difference = predictedDistance - distanceToPin;

      const c = (ARROW_COLORS ??= {
        onTarget: new BABYLON.Color3(0x68 / 255, 0x8d / 255, 0x46 / 255), // #688D46
        short: new BABYLON.Color3(1, 1, 0),
        long: new BABYLON.Color3(1, 0, 0),
      });
      if (Math.abs(difference) <= tolerance) return c.onTarget;
      return difference < -tolerance ? c.short : c.long;
    }

    updateUI() {
      this.clubSelector.updateUI();
    }
  }

  // ─── SWIPE ARROW OVERLAY ────────────────────────────────────────────────────

  class SwipeArrowOverlay {
    constructor(renderCanvas, circleUIManager = null) {
      this.renderCanvas = renderCanvas;
      this.circleUIManager = circleUIManager;
      this.overlayCanvas = document.createElement("canvas");
      this.ctx = this.overlayCanvas.getContext("2d");
      this.fadeArrows = [];
      this.liveArrow = null;
      this.idealArrow = null;
      this.magnusArrow = null;

      // Swipe feedback uses the real arrow.glb art (baked to the swipe-arrow sprite,
      // a flat white silhouette — no cel outline) instead of hand-drawn lines. The
      // white sprite is tinted per color and cached.
      this.arrowSprite = new Image();
      this.arrowSprite.src = "assets/ui/effects/swipe-arrow.png";
      this.tintCache = new Map();

      this.setupCanvas();
      this.resize();
      window.addEventListener("resize", () => this.resize());
    }

    setupCanvas() {
      this.overlayCanvas.id = "swipeOverlay";
      this.renderCanvas.parentElement.appendChild(this.overlayCanvas);
    }

    resize() {
      const rect = this.renderCanvas.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      this.overlayCanvas.width = Math.max(1, Math.floor(rect.width * dpr));
      this.overlayCanvas.height = Math.max(1, Math.floor(rect.height * dpr));
      this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }

    getGuideStartPoint() {
      return {
        x:
          (this.overlayCanvas.width / (window.devicePixelRatio || 1)) *
          CONFIG.SWIPE_OVERLAY.START_X_PCT,
        y:
          (this.overlayCanvas.height / (window.devicePixelRatio || 1)) *
          CONFIG.SWIPE_OVERLAY.START_Y_PCT,
      };
    }

    setIdealArrow(start, end) {
      this.idealArrow = { start, end, color: CONFIG.SWIPE_OVERLAY.IDEAL_COLOR };
    }

    clearIdealArrow() {
      this.idealArrow = null;
    }

    setLiveArrow(start, end, color) {
      this.liveArrow = { start, end, color };
    }

    clearLiveArrow() {
      this.liveArrow = null;
    }

    // Which way spin's Magnus force is pushing the ball in flight (screen px).
    setMagnusArrow(start, end) {
      this.magnusArrow = { start, end };
    }

    clearMagnusArrow() {
      this.magnusArrow = null;
    }

    addFadeArrow(start, end, color, durationMs, width) {
      this.fadeArrows.push({
        start,
        end,
        color,
        durationMs,
        remainingMs: durationMs,
        width,
      });
    }

    // The white arrow sprite tinted to `color`, cached (few distinct colors).
    getTinted(color) {
      const cached = this.tintCache.get(color);
      if (cached) return cached;
      const img = this.arrowSprite;
      const cv = document.createElement("canvas");
      cv.width = img.naturalWidth;
      cv.height = img.naturalHeight;
      const cx = cv.getContext("2d");
      cx.drawImage(img, 0, 0);
      cx.globalCompositeOperation = "source-in"; // keep the arrow's alpha as a mask
      cx.fillStyle = color;
      cx.fillRect(0, 0, cv.width, cv.height);
      this.tintCache.set(color, cv);
      return cv;
    }

    drawArrow(start, end, color, width, alpha = 1) {
      const ctx = this.ctx;
      const dx = end.x - start.x;
      const dy = end.y - start.y;
      const len = Math.sqrt(dx * dx + dy * dy);
      if (len < 2) return;
      if (!this.arrowSprite.complete || !this.arrowSprite.naturalWidth) return;

      const sprite = this.getTinted(color);
      // Keep the arrow.glb proportions; the whole sprite scales with the swipe
      // length (tail at start, tip at end). `width` nudges thickness so the
      // spin/hit/ideal arrows still read a touch different, matching before.
      const thickness = len * (sprite.height / sprite.width) * (width / 5);

      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.translate(start.x, start.y);
      ctx.rotate(Math.atan2(dy, dx));
      ctx.drawImage(sprite, 0, -thickness / 2, len, thickness);
      ctx.restore();
    }

    update(deltaMs) {
      const ctx = this.ctx;
      const w = this.overlayCanvas.width / (window.devicePixelRatio || 1);
      const h = this.overlayCanvas.height / (window.devicePixelRatio || 1);
      ctx.clearRect(0, 0, w, h);

      if (this.idealArrow) {
        this.drawArrow(
          this.idealArrow.start,
          this.idealArrow.end,
          this.idealArrow.color,
          CONFIG.SWIPE_OVERLAY.IDEAL_WIDTH,
          CONFIG.SWIPE_OVERLAY.IDEAL_ALPHA,
        );
      }

      const next = [];
      for (const arrow of this.fadeArrows) {
        arrow.remainingMs -= deltaMs;
        if (arrow.remainingMs <= 0) continue;
        this.drawArrow(
          arrow.start,
          arrow.end,
          arrow.color,
          arrow.width,
          arrow.remainingMs / arrow.durationMs,
        );
        next.push(arrow);
      }
      this.fadeArrows = next;

      if (this.liveArrow) {
        this.drawArrow(
          this.liveArrow.start,
          this.liveArrow.end,
          this.liveArrow.color,
          CONFIG.SWIPE_OVERLAY.HIT_WIDTH,
          0.9,
        );
      }

      if (this.magnusArrow) {
        this.drawArrow(
          this.magnusArrow.start,
          this.magnusArrow.end,
          CONFIG.SWIPE_OVERLAY.MAGNUS_COLOR,
          CONFIG.SWIPE_OVERLAY.SPIN_WIDTH,
          0.9,
        );
      }
    }
  }

  Object.assign(global, { TrajectoryArrow, AimView, SwipeArrowOverlay });
  if (typeof module !== "undefined" && module.exports)
    module.exports = { TrajectoryArrow, AimView, SwipeArrowOverlay };
})(typeof globalThis !== "undefined" ? globalThis : this);
