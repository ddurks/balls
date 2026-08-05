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
      this.lastArrowAngle = -1;
      this.isLoaded = false;
      this.currentColor = new BABYLON.Color3(
        0xe1 / 255,
        0xe4 / 255,
        0x4e / 255,
      );
      this.pendingColor = null;
      this.loadArrowModel();
    }

    async loadArrowModel() {
      try {
        const result = await Shared.loadModel("arrow.glb", this.scene);

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

    create(clubAngle = 12) {
      if (!this.isLoaded || !this.arrowTemplate) return;

      if (this.arrow) {
        if (this.scene.shadowGenerator) {
          const meshes = [this.arrow, ...this.arrow.getChildMeshes()];
          meshes.forEach((mesh) => {
            if (mesh) {
              this.scene.shadowGenerator.removeShadowCaster(mesh, true);
            }
          });
        }
        this.arrow.dispose();
      }

      this.arrow = this.arrowTemplate.clone("trajectoryArrow_instance");
      this.arrow.scaling.scaleInPlace(0.107); // Phase 1: match real golf-ball scale
      this.arrow.setEnabled(true);

      this.arrow.rotation = new BABYLON.Vector3(0, 0, 0);
      this.arrow.rotationQuaternion = null;

      this.arrow.getChildMeshes().forEach((mesh) => {
        mesh.setEnabled(true);
      });

      if (this.pendingColor) {
        this.currentColor = this.pendingColor;
        this.pendingColor = null;
        this.applyColor();
      }

      if (this.scene.shadowGenerator) {
        const meshes = [this.arrow, ...this.arrow.getChildMeshes()];
        meshes.forEach((mesh) => {
          if (mesh) {
            this.scene.shadowGenerator.addShadowCaster(mesh, true);
          }
        });
      }

      this.lastArrowAngle = clubAngle;
    }

    update(ballPos, clubAngle, cameraRotation) {
      if (!this.arrow || this.lastArrowAngle !== clubAngle) {
        this.create(clubAngle);
      }

      if (!this.arrow) return;

      this.arrow.position = ballPos.clone();
      this.arrow.position.y += CONFIG.TRAJECTORY.ARROW_Y_OFFSET;

      const angleDeg = Shared.clamp(clubAngle || 12, 0, 60);
      const angleRad = (angleDeg * Math.PI) / 180;

      // X rotation: pitch up based on club angle (negated to get correct direction)
      // Y rotation: 180° + camera rotation to face the aim direction
      this.arrow.rotation.x = -angleRad;
      this.arrow.rotation.y = Math.PI + cameraRotation;
      this.arrow.rotation.z = 0;
    }

    dispose() {
      if (this.arrow) {
        this.arrow.dispose();
        this.arrow = null;
      }
      // Keep arrowTemplate for reuse across multiple activations
    }

    setArrowColor(color) {
      this.currentColor = color;

      if (!this.arrow) {
        this.pendingColor = color;
        return;
      }

      this.applyColor();
    }

    applyColor() {
      if (!this.arrow) {
        return;
      }

      try {
        const meshes = [this.arrow, ...this.arrow.getChildMeshes()];
        const color = this.currentColor.clone();

        meshes.forEach((mesh) => {
          if (!mesh) return;

          let mat = mesh.material;
          if (!mat || !(mat instanceof BABYLON.StandardMaterial)) {
            mat = new BABYLON.StandardMaterial(
              "arrowMat_" + Math.random(),
              this.scene,
            );
            mesh.material = mat;
          }

          // ─── CEL SHADING ──────────────────────────────────────────────
          mat.diffuseColor = color;
          mat.specularColor = new BABYLON.Color3(0, 0, 0);
          mat.ambientColor = new BABYLON.Color3(0.6, 0.6, 0.6);
          mat.emissiveColor = color.scale(0.3);

          // ─── OUTLINE ──────────────────────────────────────────────────
          mesh.outlineWidth = 0.15;
          mesh.outlineColor = new BABYLON.Color3(0, 0, 0);
          mat.backFaceCulling = false; // Needed for outline rendering
        });
      } catch (error) {
        console.warn("Error applying arrow color:", error);
      }
    }
  }

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
      this.isActive = true;
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
      this.camera.position = new BABYLON.Vector3(cameraX, cameraY, cameraZ);
      this.camera.setTarget(ballPos.add(new BABYLON.Vector3(0, 0.05, 0)));

      const club = ClubData.getClub(this.clubSelector.currentClub);

      const pins = this.game?.scene?.pinManager?.pins;

      if (pins && pins.length > 0) {
        try {
          // Metres, to match ClubData.maxDistance (used for club auto-select AND
          // the arrow-color ±10 m band below). Do NOT convert to yards here.
          const distanceToPin = this.getDistanceToNearestPin(ballPos);

          if (this.clubSelector.autoSelectClubIfNeeded(distanceToPin)) {
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

      if (Math.abs(difference) <= tolerance) {
        return new BABYLON.Color3(0x68 / 255, 0x8d / 255, 0x46 / 255); // #688D46
      } else if (difference < -tolerance) {
        return new BABYLON.Color3(1, 1, 0);
      } else {
        return new BABYLON.Color3(1, 0, 0);
      }
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

    drawArrow(start, end, color, width, alpha = 1) {
      const ctx = this.ctx;
      const dx = end.x - start.x;
      const dy = end.y - start.y;
      const len = Math.sqrt(dx * dx + dy * dy);
      if (len < 2) return;

      const ux = dx / len;
      const uy = dy / len;
      const headLen = Shared.clamp(len * 0.22, 10, 18);
      const headW = headLen * 0.6;
      const baseX = end.x - ux * headLen;
      const baseY = end.y - uy * headLen;
      const px = -uy;
      const py = ux;

      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.strokeStyle = color;
      ctx.fillStyle = color;
      ctx.lineWidth = width;
      ctx.lineCap = "round";

      ctx.beginPath();
      ctx.moveTo(start.x, start.y);
      ctx.lineTo(baseX, baseY);
      ctx.stroke();

      ctx.beginPath();
      ctx.moveTo(end.x, end.y);
      ctx.lineTo(baseX + px * headW, baseY + py * headW);
      ctx.lineTo(baseX - px * headW, baseY - py * headW);
      ctx.closePath();
      ctx.fill();
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
    }
  }

  Object.assign(global, { TrajectoryArrow, AimView, SwipeArrowOverlay });
  if (typeof module !== "undefined" && module.exports)
    module.exports = { TrajectoryArrow, AimView, SwipeArrowOverlay };
})(typeof globalThis !== "undefined" ? globalThis : this);
