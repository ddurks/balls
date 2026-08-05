// game.js — GolfGame, startGame.
// Split out of game.js; loaded as a plain <script> before game.js (see game.html),
// and require()-able in Node for unit tests. Cross-module refs resolve via globals.
(function (global) {
  // ─── MAIN GAME ORCHESTRATOR ────────────────────────────────────────────────

  class GolfGame {
    constructor(canvas, options = {}) {
      this.canvas = canvas;
      this.options = options;
      // "practice" = original random-pin sandbox, "course" = 3-hole match play
      this.mode = options.mode || "practice";
      this.courseManager = null;
      this.engine = new BABYLON.Engine(canvas, true);
      this.scene = null;
      this.eventManager = new EventManager();
      this.golfBall = null;
      this.camera = null;
      this.inputHandler = null;
      this.uiManager = null;
      this.ballTrail = null;
      this.aimView = null;
      this.gameState = GameState.AIM;
      this.ballStartPosition = new BABYLON.Vector3(0, 0.425, 150);
      this.aimedDirection = 0;
      this.justTransitioned = false;
      this.physicsDebugEnabled = false;
      this.physicsViewer = null;
      this.swipeOverlay = null;
      this.wind = new Wind();
      this.cloudSystem = null;
      this.clubSystem = null;
      this.swingCameraRestored = false;
      this.golfBallFacingCamera = false;

      this.lastBallVelocity = new BABYLON.Vector3(0, 0, 0);
      this.wasHit = false;
      this.hitCooldown = 0;

      this.swingCoordinator = null;

      this.compassTransitionFrames = 0;
      this.compassTransitionDuration = 3; // frames to blend rotation sources
      this.compassElements = null;
      this.lastCompassAngle = null;
      this.lastCompassRotate = null;
      this.lastWindSpeedDisplay = null;
      this.gameStateCoordinator = null;

      this.currentHolePin = null;
      this.currentHoleShotCount = 0;
      this.holeSinkProcessed = false; // Guard against repeated holesink events

      this.shotTrails = [];

      this.isControlsDisabled = false;
    }

    normalizeAngle(angle) {
      return Math.atan2(Math.sin(angle), Math.cos(angle));
    }

    getShotDirection() {
      if (this.camera?.camera?.getForwardRay) {
        const forward = this.camera.camera.getForwardRay(1).direction;
        if (
          forward &&
          Number.isFinite(forward.x) &&
          Number.isFinite(forward.z)
        ) {
          return this.normalizeAngle(Math.atan2(forward.x, -forward.z));
        }
      }
      if (this.camera && Number.isFinite(this.camera.cameraAngle)) {
        return this.normalizeAngle(this.camera.cameraAngle);
      }
      return this.normalizeAngle(this.aimedDirection || 0);
    }

    async initialize() {
      this.scene = new BABYLON.Scene(this.engine);
      this.scene.clearColor = new BABYLON.Color3(0.53, 0.81, 0.92); // Sky blue

      await PhysicsManager.initialize(this.scene);
      if (BABYLON.PhysicsViewer) {
        this.physicsViewer = new BABYLON.PhysicsViewer(this.scene);
      }
      const courseMode = this.mode === "course";
      await SceneSetup.createEnvironment(this.scene, {
        skipGround: courseMode,
      });

      await this.loadGolfBall();
      await this.loadCharacter();

      if (courseMode) {
        // Course mode: CourseManager owns pins/terrain per hole
        this.courseManager = new CourseManager(this);
        await this.courseManager.init();
      } else {
        // Setup pins after golfBall is loaded (practice sandbox)
        this.setupPins();
      }

      // Holing out runs one handler for both modes (see GolfGame.onHoleSink);
      // registered here, after either mode's PinManager exists, so practice and
      // course share the exact same hole-entry cinematic.
      this.eventManager.on("pin:holesink", (holePos) =>
        this.onHoleSink(holePos),
      );

      this.grassSystem = new GrassSystem(this.scene);
      await this.grassSystem.initialize();

      this.setupCamera();
      this.circleUIManager = new CircleUIManager();
      this.swipeOverlay = new SwipeArrowOverlay(
        this.canvas,
        this.circleUIManager,
      );
      this.setupInput();
      this.setupUI();
      this.ballTrail = new BallTrail(
        this.scene,
        CONFIG.TRAIL.MAX_POINTS,
        CONFIG.TRAIL.MAX_AGE_MS,
      );
      this.setupCompass();
      this.cloudSystem = new CloudSystem(this.scene, this.camera);
      this.clubSystem = new ClubSystem(this.scene);
      await this.clubSystem.load(this.ballStartPosition);

      // Initialize coordinators after all dependencies are set up
      this.swingCoordinator = new SwingCoordinator(
        this,
        this.clubSystem,
        this.golfBall,
        this.camera,
        this.ballTrail,
      );
      this.gameStateCoordinator = new GameStateCoordinator(this);

      this.circleUIManager.modeToggleCallback = () =>
        this.gameStateCoordinator.toggleMode();

      // Setup AimView after coordinators are ready (it depends on them)
      this.setupAimView();

      this.setupRenderLoop();

      if (this.courseManager) {
        await this.courseManager.start();
      }
    }

    async loadGolfBall() {
      const bodyMesh = BABYLON.MeshBuilder.CreateSphere(
        "ballBody",
        { diameter: CONFIG.BALL.COLLIDER_DIAMETER, segments: 8 },
        this.scene,
      );
      bodyMesh.position = this.ballStartPosition.clone();
      bodyMesh.isVisible = false;
      bodyMesh.isPickable = false;

      const aggregate = new BABYLON.PhysicsAggregate(
        bodyMesh,
        BABYLON.PhysicsShapeType.SPHERE,
        {
          mass: PhysicsConfig.BALL_MASS,
          friction: PhysicsConfig.BALL_FRICTION,
          restitution: PhysicsConfig.BALL_RESTITUTION,
        },
        this.scene,
      );

      aggregate.body.setLinearDamping(PhysicsConfig.BALL_LINEAR_DAMPING);
      aggregate.body.setAngularDamping(PhysicsConfig.BALL_ANGULAR_DAMPING);

      this.golfBall = new GolfBallGuy(
        bodyMesh,
        aggregate.body,
        null,
        this.scene,
      );
    }

    async loadCharacter() {
      let result;
      try {
        result = await Shared.loadModel("gball.glb", this.scene);
      } catch (e) {
        // Non-fatal: the ball still has its physics body + collider mesh, it just
        // won't have the character face/skeleton. Don't kill the whole game.
        console.warn(
          "Character model (gball.glb) failed to load; continuing without it.",
          e,
        );
        return;
      }

      // Parent all character meshes directly to the physics body
      // so they rotate and position with it automatically
      const bodyMesh = this.golfBall.mesh;
      result.meshes.forEach((mesh) => {
        if (mesh) {
          mesh.parent = bodyMesh;
          mesh.position = BABYLON.Vector3.Zero();
          mesh.scaling = new BABYLON.Vector3(0.0254, 0.0254, 0.0254);
        }
      });

      this.golfBall.skeleton = result.skeletons?.[0] || null;
      this.golfBall.scene = this.scene;

      if (this.golfBall.skeleton && this.golfBall.skeleton.bones.length > 0) {
        this.golfBall.spinBone = this.golfBall.skeleton.bones.find((b) =>
          b.name.toLowerCase().includes("spin"),
        );
        if (!this.golfBall.spinBone) {
          this.golfBall.spinBone = this.golfBall.skeleton.bones[0];
        }
      }

      await this.golfBall.loadFaceTextures();

      this.golfBall.initializeEyelids();

      this.golfBall.initializeEyes(this.golfBall.skeleton);

      // Locker-room customization (hat + ball skin; face applied above)
      this.golfBall.applyStyle(BallsStyle.loadStyle());

      Utils.addShadowCasters(result.meshes, this.scene.shadowGenerator);
    }

    setupCamera() {
      this.camera = new BABYLON.UniversalCamera(
        "camera",
        new BABYLON.Vector3(0, 1, 6),
        this.scene,
      );
      // NO attachControl: AimView + FollowCamera position this camera entirely,
      // and Babylon's built-in pointer/touch input was fighting the strike/spin
      // swipes (every drag also nudged the camera). The canvas' touch-action:none
      // CSS now blocks page pan/zoom instead of Babylon's preventDefault.
      this.camera = new FollowCamera(
        this.camera,
        this.golfBall.mesh,
        this.golfBall,
      );
      // Terrain/water floor: the follow camera may never sink below it.
      this.camera.floorYAt = (x, z) => this.cameraFloorY(x, z);
    }

    // Lowest Y the camera may occupy at (x,z): a hair above the terrain, and
    // never beneath the water surface. Course mode reads the per-hole height
    // grid (bed height under water, so the waterline is the binding limit
    // there); practice models the flat range plus the greens' squashed-sphere
    // bulge. CLEAR is small on purpose — the aim view legitimately hugs the
    // ground at ball height.
    cameraFloorY(x, z) {
      const CLEAR = 0.06;
      if (this.courseManager?.hg) {
        const cm = this.courseManager;
        return Math.max(cm.groundY(x, z), cm.waterlineY) + CLEAR;
      }
      let ground = 0; // practice range floor
      for (const p of this.greenPositions || []) {
        const dx = x - p.x;
        const dz = z - p.z;
        if (dx * dx + dz * dz < 144) {
          // flat green pad, radius 12: top = 0.001 + radius/100 (see addGreen)
          ground = Math.max(ground, 0.121);
        }
      }
      return ground + CLEAR;
    }

    setupAimView() {
      this.aimView = new AimView(
        this.camera.camera,
        this.golfBall.mesh,
        this.golfBall,
        this.scene,
        this.canvas,
        this.eventManager,
        this,
        this.circleUIManager,
      );

      this.eventManager.on("aimView:ballClicked", () => {
        this.gameStateCoordinator.transitionAimToPlay(
          this.aimView.cameraRotation,
        );
        // Transition the follow-camera to play view. Camera angle convention is
        // opposite to aimView, so negate it; setCameraAngleImmediate normalizes
        // both angle fields so the follow-cam doesn't lerp a full 360° spin when
        // the pin is dead ahead (cameraRotation ≈ 2π).
        this.camera.setShotStartPosition(this.golfBall.getPosition());
        this.camera.setCameraAngleImmediate(-this.aimedDirection);
        this.camera.setPlayView();
        this.compassTransitionFrames = 0;
        setTimeout(() => {
          this.aimView.isActive = false;
        }, 0);
        this.ballTrail.startTracing();
      });

      this.aimView.activate();
    }

    setupInput() {
      this.inputHandler = new InputHandler(
        this.canvas,
        this.golfBall,
        this,
        this.eventManager,
        this.swipeOverlay,
        this.circleUIManager,
      );

      document.addEventListener("keydown", (e) => {
        if (e.key.toLowerCase() === "p") {
          this.togglePhysicsDebug();
        }
      });

      this.eventManager.on("input:hit", (data) => {
        if (this.gameState !== GameState.PLAY) return;

        const shotDirection = this.getShotDirection();

        this.swingCoordinator.executeSwing(
          shotDirection,
          data.force,
          data.deltaX,
          data.deltaY,
        );
      });

      this.eventManager.on("input:spin", (data) => {
        this.gameStateCoordinator.applySpin(data.spinAxis, data.spinAmount);
      });
    }

    disableControls() {
      this.isControlsDisabled = true;

      // Keep aimView ACTIVE for orbit controls during review
      // Don't deactivate it - we want the camera to be orbitable

      if (this.circleUIManager) {
        this.circleUIManager.hideAllCircles();
      }
    }

    enableControls() {
      this.isControlsDisabled = false;

      if (this.circleUIManager) {
        this.circleUIManager.showAllCircles();
      }
    }

    // Single holing-out handler for BOTH modes, registered once in initialize().
    // The cinematic half — freeze aim, reveal every shot's trail, swing to the
    // shot-review camera — is identical in practice and course; only the tail
    // differs. Practice pops the "Continue" overlay; course scores + auto-advances
    // (its review camera shows during the advance delay). Keeping this in one
    // place means the two modes can't drift apart or double-fire.
    onHoleSink(holePos) {
      if (this.holeSinkProcessed) return; // ball still vibrating in the cup re-emits
      this.holeSinkProcessed = true;

      // Freeze aim; each mode then shows a make result and resets. No shot
      // overview / review camera for now — just result + reset.
      if (this.aimView) {
        this.aimView.isActive = false;
        this.aimView.removeOrbitControls();
      }

      const shotCount = this.currentHoleShotCount;

      // ── mode-specific completion tail ──
      if (this.courseManager) {
        this.courseManager.onHoleComplete(shotCount);
      } else {
        const holeNumber =
          (this.scene.pinManager?.pins?.findIndex(
            (pin) => BABYLON.Vector3.Distance(pin.holePosition, holePos) < 1,
          ) ?? 0) + 1;
        this.eventManager.emit("game:showShotReview", {
          holeNumber,
          shotCount,
        });
        this.currentHolePin = null;
        this.currentHoleShotCount = 0;
      }
    }

    showShotReviewMessage(holeNumber, shotCount) {
      this.disableControls();

      const container = document.createElement("div");
      container.id = "shotReviewMessage";
      container.style.cssText = `
      position: fixed;
      top: 50%;
      left: 50%;
      transform: translate(-50%, -50%);
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 20px;
      z-index: 10000;
      pointer-events: auto;
    `;

      const message = document.createElement("div");
      message.style.cssText = `
      font-size: 36px;
      font-weight: bold;
      color: #E1E44E;
      text-align: center;
      font-family: Arial, sans-serif;
      text-shadow: 2px 2px 4px rgba(0, 0, 0, 0.8);
    `;
      message.textContent = `Hole in ${shotCount} on ${holeNumber}`;

      // Continue button: dismiss the review and resume play at the tee so the
      // player can go for the next pin (previously this only offered a full reload,
      // which soft-locked Practice after the first hole-out).
      const button = document.createElement("button");
      button.textContent = "Continue";
      button.style.cssText = `
      padding: 12px 36px;
      font-size: 18px;
      background: #3a6b35;
      color: white;
      border: 2px solid #ffeb3b;
      border-radius: 6px;
      cursor: pointer;
      font-weight: bold;
      transition: background 0.3s;
    `;
      button.addEventListener("mouseover", () => {
        button.style.background = "#4a8b45";
      });
      button.addEventListener("mouseout", () => {
        button.style.background = "#3a6b35";
      });
      button.addEventListener("click", () => {
        container.remove();
        this.enableControls();
        this.holeSinkProcessed = false; // allow the next pin to register a sink
        this.scene.pinManager?.pins?.forEach((p) => {
          p.sunk = false;
          p.captured = false;
          p.captureFrames = 0;
          if (this.golfBall) this.golfBall._inCup = false;
        });
        this.gameStateCoordinator.resetForNextHole();
      });

      container.appendChild(message);
      container.appendChild(button);
      document.body.appendChild(container);
    }

    togglePhysicsDebug() {
      if (!this.physicsViewer) return;
      this.physicsDebugEnabled = !this.physicsDebugEnabled;

      const bodies = [];
      if (this.golfBall?.body) bodies.push(this.golfBall.body);
      if (this.scene.groundPhysicsBody)
        bodies.push(this.scene.groundPhysicsBody);
      if (this.scene.pinManager?.pins) {
        for (const pin of this.scene.pinManager.pins) {
          if (pin.body?.body) bodies.push(pin.body.body);
        }
      }

      for (const body of bodies) {
        if (this.physicsDebugEnabled) this.physicsViewer.showBody(body);
        else this.physicsViewer.hideBody(body);
      }
    }

    setupUI() {
      this.uiManager = new UIManager(
        this.golfBall,
        this.ballStartPosition,
        this,
        this.circleUIManager,
      );
    }

    pausePhysics() {
      // Physics never pause - clubs are visual only
    }

    resumePhysics() {
      // Physics never pause - clubs are visual only
    }

    setupPins() {
      const pinManager = new PinManager(
        this.scene,
        this.golfBall,
        this.eventManager,
      );

      // Generate random pin positions outside a 100-yard radius from player
      const playerPos = this.ballStartPosition; // (0, 0, 150)
      const minDistance = 91.44; // 100 yards in meters
      const discRadius = 183; // Match ground disc radius
      const numPins = 5;
      const greenPositions = [];

      while (greenPositions.length < numPins) {
        const angle = Math.random() * Math.PI * 2;
        const maxDistance = discRadius - 25; // 25m buffer from edge
        const distance =
          minDistance + Math.random() * (maxDistance - minDistance - 30); // Leave buffer for green radius

        const x = Math.cos(angle) * distance;
        const z = Math.sin(angle) * distance;
        const pos = new BABYLON.Vector3(x, 0, z);

        if (BABYLON.Vector3.Distance(pos, playerPos) < minDistance) {
          continue;
        }

        // Check if far enough from all existing greens (60m minimum = 2 x green radius of 30)
        const minGreenDistance = 60;
        let tooClose = false;
        for (const existingPin of greenPositions) {
          if (BABYLON.Vector3.Distance(pos, existingPin) < minGreenDistance) {
            tooClose = true;
            break;
          }
        }

        if (!tooClose) {
          greenPositions.push(pos);
        }
      }

      this.greenPositions = greenPositions;

      for (const pos of greenPositions) {
        const surfaceY = pinManager.addGreen(pos, 12, this.scene);
        pos.y = 0.2;
        pinManager.addPin(pos, this.scene, { surfaceY });
      }

      this.scene.pinManager = pinManager;
      this.eventManager.on("pin:hit", (pinPos) => {});

      // pin:holesink is handled by GolfGame.onHoleSink — one handler shared by
      // both modes, registered once in initialize(). setupPins only wires the
      // practice-only "Continue" review overlay below.

      this.eventManager.on("game:showShotReview", (reviewData) => {
        this.showShotReviewMessage(reviewData.holeNumber, reviewData.shotCount);
      });
    }

    updateBallState() {
      const landingState = this.golfBall.updateLandingState();
      if (landingState === "fullLand") {
        this.ballTrail.stopTracing();
        this.ballTrail.setVisible(false);
        // Don't go to shot review here - only go when ball is sunk in hole
        this.archiveCurrentTrail();
        this.eventManager.emit(
          "ball:landed",
          this.golfBall.getPosition().clone(),
        );
        // Don't pop up aim yet — wait until the ball has fully stopped for 1s
        // (it may still be trickling down an undulation).
        this._settleTimer = 0;
        this._awaitingSettle = this.gameState !== GameState.LANDED;
      }

      // Enter aim mode only after the ball has stopped for 1 second — but NOT
      // while a hole-out is being processed (holeSinkProcessed), so the make
      // result + reset isn't interrupted by an auto re-aim.
      if (
        this._awaitingSettle &&
        this.gameState !== GameState.AIM &&
        !this.holeSinkProcessed
      ) {
        if (this.golfBall.getSpeed() < 0.15 && !this.golfBall.isAirborne()) {
          this._settleTimer += this.engine.getDeltaTime() / 1000;
          if (this._settleTimer >= 1.0) {
            this._awaitingSettle = false;
            this.gameState = GameState.AIM;
            this.aimView.activate();
          }
        } else {
          this._settleTimer = 0; // still rolling — reset the settle clock
        }
      }

      if (
        !this.golfBall.isLanded() &&
        this.golfBall.pendingSpinAmount > 0 &&
        this.golfBall.hasSpinBone()
      ) {
        this.golfBall.animateSpin(
          this.golfBall.pendingSpinAxis,
          this.golfBall.pendingSpinAmount,
        );
      }

      this.updateCharacterFace();
    }

    updateCharacterFace() {
      if (!this.golfBall) return;

      // Skip expensive face updates during PLAY mode (optimize for moving ball)
      if (this.gameState === GameState.PLAY) {
        this.golfBall.updateFaces(this.engine.getDeltaTime() / 1000);
        this.golfBall.updateBlinking(this.engine.getDeltaTime() / 1000);
        return;
      }

      const ballVel = this.golfBall.getVelocity();
      const ballSpeed = ballVel.length();
      const isMoving = ballSpeed > 0.2;

      // Detect if ball was just hit (sudden velocity increase)
      const velMagnitudePrev = this.lastBallVelocity.length();
      const velMagnitudeCurr = ballSpeed;
      const wasJustHit =
        velMagnitudeCurr > velMagnitudePrev * 1.5 && velMagnitudeCurr > 5;

      if (wasJustHit) {
        this.wasHit = true;
        this.hitCooldown = 0.1;
      }

      if (this.hitCooldown > 0) {
        this.hitCooldown -= this.engine.getDeltaTime() / 1000;
        this.golfBall.setFace("hit", this.golfBall.HIT_FACE_DURATION);
      } else if (isMoving && ballVel.y > 1) {
        this.golfBall.setFace("ascending");
      } else if (isMoving && ballVel.y < -2) {
        this.golfBall.setFace("descending");
      } else if (isMoving && Math.abs(ballVel.x) > 3) {
        this.golfBall.setFace("collision");
      } else if (!isMoving) {
        this.golfBall.setFace("default");
      }

      if (this.camera && this.gameState === GameState.AIM) {
        // Face the aim camera every frame (it can orbit), then rotate smoothly toward
        // it. cameraRotation is the ball→camera angle and is stable within the frame,
        // unlike camera.position, which the follow-cam rewrites later in the frame.
        if (this.aimView)
          this.golfBall.targetRotation = this.aimView.cameraRotation;
        this.golfBall.updateRotation(0.1);
      }

      this.golfBall.updateFaces(this.engine.getDeltaTime() / 1000);

      this.golfBall.updateBlinking(this.engine.getDeltaTime() / 1000);

      this.lastBallVelocity.copyFrom(ballVel);
    }

    archiveCurrentTrail() {
      if (!this.ballTrail || !this.ballTrail.line) return;

      const colors = [
        new BABYLON.Color3(1, 0.15, 0.15), // Red
        new BABYLON.Color3(0.15, 0.8, 1), // Cyan
        new BABYLON.Color3(1, 1, 0.15), // Yellow
        new BABYLON.Color3(0.8, 0.15, 1), // Magenta
        new BABYLON.Color3(0.15, 1, 0.8), // Green
        new BABYLON.Color3(1, 0.6, 0.15), // Orange
      ];

      const colorIndex = this.shotTrails.length % colors.length;
      const color = colors[colorIndex];

      const archivedTrail = this.ballTrail.line.clone(
        "shot_trail_" + this.shotTrails.length,
      );
      archivedTrail.color = color.clone();
      archivedTrail.setEnabled(false); // Hide until hole sink overview
      this.shotTrails.push({
        trail: archivedTrail,
        shotNumber: this.currentHoleShotCount + 1,
      });

      // Clear the ball trail for the next shot, but keep archived trails visible
      this.ballTrail.clear();
      this.ballTrail.setVisible(false);
    }

    clearArchivedTrails() {
      for (const { trail } of this.shotTrails) {
        if (trail) {
          trail.dispose();
        }
      }
      this.shotTrails = [];
      this.holeSinkProcessed = false; // Reset guard for next hole
    }

    setupCompass() {
      this.setupWindControl();
    }

    setupWindControl() {
      const svg = this.circleUIManager.getCompassSvg();
      if (!svg) return;
      // Course mode: wind is a fixed per-hole condition, not a player control —
      // the compass still displays it, but dragging/clicking it does nothing.
      if (this.mode === "course") return;

      let isDragging = false;

      const updateWindFromPosition = (clientX, clientY) => {
        const svgRect = svg.getBoundingClientRect();
        const centerX = svgRect.left + svgRect.width / 2;
        const centerY = svgRect.top + svgRect.height / 2;

        const deltaX = clientX - centerX;
        const deltaY = clientY - centerY;

        // Calculate angle (0 = North, increases clockwise)
        let angle = Math.atan2(deltaX, -deltaY);
        if (angle < 0) angle += Math.PI * 2;

        // Convert to our wind direction (0 = South, PI/2 = East, PI = North, 3PI/2 = West)
        const windDirection = (Math.PI - angle + Math.PI * 2) % (Math.PI * 2);

        const distance = Math.sqrt(deltaX * deltaX + deltaY * deltaY);
        const maxDistance = svgRect.width / 2;
        const speedRatio = Math.min(distance / (maxDistance * 0.7), 1);
        const speed =
          CONFIG.WIND.MIN_SPEED +
          (CONFIG.WIND.MAX_SPEED - CONFIG.WIND.MIN_SPEED) * speedRatio;

        this.wind.direction = windDirection;
        this.wind.speed = speed;
        this.wind.nextChangeTime = Date.now() + CONFIG.WIND.CHANGE_FREQUENCY;
      };

      const handleMouseDown = (e) => {
        isDragging = true;
      };

      const handleMouseMove = (e) => {
        if (!isDragging) return;
        updateWindFromPosition(e.clientX, e.clientY);
      };

      const handleMouseUp = () => {
        isDragging = false;
      };

      const handleTouchStart = (e) => {
        isDragging = true;
      };

      const handleTouchMove = (e) => {
        if (!isDragging) return;
        e.preventDefault();
        const touch = e.touches[0];
        if (touch) {
          updateWindFromPosition(touch.clientX, touch.clientY);
        }
      };

      const handleTouchEnd = () => {
        isDragging = false;
      };

      svg.addEventListener("mousedown", handleMouseDown);
      document.addEventListener("mousemove", handleMouseMove);
      document.addEventListener("mouseup", handleMouseUp);

      svg.addEventListener("touchstart", handleTouchStart, { passive: false });
      document.addEventListener("touchmove", handleTouchMove, {
        passive: false,
      });
      document.addEventListener("touchend", handleTouchEnd);

      svg.addEventListener("click", (e) => {
        const rect = svg.getBoundingClientRect();
        const centerX = rect.left + rect.width / 2;
        const centerY = rect.top + rect.height / 2;

        const deltaX = e.clientX - centerX;
        const deltaY = e.clientY - centerY;

        let angle = Math.atan2(deltaX, -deltaY);
        if (angle < 0) angle += Math.PI * 2;

        const windDirection = (Math.PI - angle + Math.PI * 2) % (Math.PI * 2);
        const distance = Math.sqrt(deltaX * deltaX + deltaY * deltaY);
        const maxDistance = rect.width / 2;
        const speedRatio = Math.min(distance / (maxDistance * 0.7), 1);
        const speed =
          CONFIG.WIND.MIN_SPEED +
          (CONFIG.WIND.MAX_SPEED - CONFIG.WIND.MIN_SPEED) * speedRatio;

        this.wind.direction = windDirection;
        this.wind.speed = speed;
        this.wind.nextChangeTime = Date.now() + CONFIG.WIND.CHANGE_FREQUENCY;
      });
    }

    updateCompass() {
      // Skip compass updates during PLAY mode for performance
      if (this.gameState === GameState.PLAY) return;

      if (!this.compassElements) {
        this.compassElements = {
          arrow: document.getElementById("windArrow"),
          compassSvg: document.getElementById("compassSvg"),
          speedDisplay: document.getElementById("windSpeedDisplay"),
        };
      }
      const { arrow, speedDisplay, compassSvg } = this.compassElements;
      if (!arrow || !speedDisplay || !compassSvg) return;

      // Convert wind direction to compass angle for arrow display
      // Wind: 0=South, PI/2=East, PI=North, 3PI/2=West
      // Compass: 0°=North, 90°=East, 180°=South, 270°=West
      const compassAngle =
        (180 - (this.wind.direction * 180) / Math.PI + 360) % 360;

      // Only update if arrow angle changed (avoid DOM updates when unchanged)
      if (this.lastCompassAngle !== compassAngle) {
        arrow.setAttribute("transform", `rotate(${compassAngle} 60 60)`);
        this.lastCompassAngle = compassAngle;
      }

      let cameraAngleDeg = 0;
      const isTransitioning =
        this.compassTransitionFrames < this.compassTransitionDuration;

      if (isTransitioning) {
        // Note: camera.cameraAngle is negated relative to aimView.cameraRotation
        const aimDeg = this.aimView
          ? ((this.aimView.cameraRotation * 180) / Math.PI) % 360
          : 0;
        const cameraDeg =
          this.camera && Number.isFinite(this.camera.cameraAngle)
            ? ((-this.camera.cameraAngle * 180) / Math.PI) % 360
            : aimDeg;

        // Blend factor: 0 at start (use aim), 1 at end (use camera)
        const blendFactor =
          this.compassTransitionFrames / this.compassTransitionDuration;
        cameraAngleDeg = aimDeg + (cameraDeg - aimDeg) * blendFactor;
        this.compassTransitionFrames++;
      } else if (this.aimView && this.aimView.isActive) {
        cameraAngleDeg = ((this.aimView.cameraRotation * 180) / Math.PI) % 360;
      } else if (this.camera && Number.isFinite(this.camera.cameraAngle)) {
        // In play view, negate camera angle to match compass convention
        cameraAngleDeg = ((-this.camera.cameraAngle * 180) / Math.PI) % 360;
      }
      // Only update SVG rotation if compass angle changed
      const compassRotate = `rotate(${-cameraAngleDeg}deg)`;
      if (this.lastCompassRotate !== compassRotate) {
        compassSvg.style.transform = compassRotate;
        this.lastCompassRotate = compassRotate;
      }

      // Only update wind speed display if it changed (convert every frame, but cache result)
      const windSpeedMph = (this.wind.speed * UNITS.MS_TO_MPH).toFixed(0);
      if (this.lastWindSpeedDisplay !== windSpeedMph) {
        speedDisplay.textContent = `${windSpeedMph} mph`;
        this.lastWindSpeedDisplay = windSpeedMph;
      }
    }

    updateWater(dt) {
      const waterRing = this.scene?.waterRing;
      if (!waterRing || !waterRing.diffuseTex || !waterRing.normalTex) return;

      waterRing.waterAnimTime += dt;

      const flowSpeed = 0.3;
      const circularFlow = waterRing.waterAnimTime * flowSpeed;

      waterRing.diffuseTex.uOffset = Math.cos(circularFlow) * 0.15;
      waterRing.diffuseTex.vOffset = Math.sin(circularFlow) * 0.15;
      waterRing.normalTex.uOffset = Math.cos(circularFlow) * 0.075;
      waterRing.normalTex.vOffset = Math.sin(circularFlow) * 0.075;
    }

    setupRenderLoop() {
      this.scene.registerBeforeRender(() => {
        this.wind.update();
        this.updateCompass();

        if (this.golfBall.isAirborne() && !this.golfBall.isLanded()) {
          const windForce = this.wind.getForceVector();
          this.golfBall.body.applyForce(windForce, this.golfBall.getPosition());
        }
        // Keep the small, fast ball from tunneling through the thin terrain mesh.
        this.golfBall.preventTunneling();
        // Rolling resistance so the ball actually settles on undulations.
        this.golfBall.applyRollingResistance(this.engine.getDeltaTime() / 1000);

        this.updateBallState();
        // Pin collisions handled by Havok physics automatically
        this.scene.pinManager?.checkHoleSink();
        this.scene.pinManager?.updateFlags(
          this.wind,
          this.engine.getDeltaTime() / 1000,
        );
        this.updateWater(this.engine.getDeltaTime() / 1000);
        this.ballTrail.update(this.golfBall.getPosition());
        this.inputHandler?.updateSwipeOverlay(this.engine.getDeltaTime());
        this.uiManager.update();
        this.aimView?.isActive && this.aimView.update();
        const pinPositions =
          this.scene.pinManager?.pins?.map((p) => p.holePosition) || [];
        // Grow grass around the CAMERA (not the ball) every frame. The grass system
        // streams a bounded number of chunks per frame into a persistent GPU buffer via
        // partial uploads (no realloc, no full re-upload), so there's neither an
        // in-flight rebuild spike nor a batch pop-in when the ball comes to rest.
        this.grassSystem?.update(
          this.camera?.camera?.position || this.golfBall.getPosition(),
          pinPositions,
        );
        if (this.cloudSystem) {
          this.cloudSystem.update(this.golfBall.getPosition(), this.wind);
        }

        if (this.scene.birdFlockSystem) {
          this.scene.birdFlockSystem.update(
            this.engine.getDeltaTime() / 1000,
            this.golfBall.getPosition(),
            this.golfBall.getVelocity(),
          );
        }
      });

      // Update camera AFTER physics so it reads the ball's post-step position,
      // eliminating the one-frame lag that causes jitter during ball flight.
      this.scene.onAfterPhysicsObservable.add(() => {
        // Hold the camera still while the ball drops into the cup — following it
        // down would drag the low PLAY-view camera under the green.
        if (this.golfBall?._inCup) return;
        this.camera.update(this.engine.getDeltaTime() / 1000);
      });

      // Update eye gaze after animations are evaluated
      this.scene.onAfterAnimationsObservable.add(() => {
        this.golfBall.updateEyeGaze(
          this.camera.camera.position,
          this.engine.getDeltaTime() / 1000,
        );
      });

      this.engine.runRenderLoop(() => {
        this.scene.render();
      });
      // Practice reveals now; course defers the reveal to loadHole(0) so the first
      // hole is fully loaded (no flash of just the ball + water) before the screen lifts.
      if (!this.courseManager) {
        Shared.roomFX.clearCovers(); // drop the arrival cover sitting behind the logo…
        Shared.hideBoot(); //           …then fade the logo out to reveal the sandbox
      }

      window.addEventListener("resize", () => {
        this.engine.resize();
      });
    }
  }

  async function startGame(options = {}) {
    try {
      const canvas = document.getElementById("renderCanvas");
      const game = new GolfGame(canvas, options);
      window.game = game; // Global reference for debugging
      await game.initialize();
      return game;
    } catch (error) {
      // Log the full error (stack included) for debugging; the individual asset
      // loaders now fail soft, so reaching here means something fundamental broke.
      console.error("Game initialization failed:", error);
      alert("Failed to initialize game: " + (error?.message || error));
    }
  }

  // Boot straight into a mode. The clubhouse (index.html) is the game's root; its
  // doors link here as game.html?mode=course|practice, so a mode is always present
  // — we default to practice only if game.html is opened bare. Guarded so this file
  // can be require()d in Node (no DOM) for unit tests without auto-booting.
  if (typeof document !== "undefined") {
    const urlMode = new URLSearchParams(location.search).get("mode");
    // Lift the logo above the clubhouse-arrival cover so it (not plain black) shows
    // for the whole boot + first-hole load; the reveal fades it out (see loadHole).
    Shared.showBoot();
    startGame({ mode: urlMode === "course" ? "course" : "practice" });
  }

  Object.assign(global, { GolfGame, startGame });
  if (typeof module !== "undefined" && module.exports)
    module.exports = { GolfGame, startGame };
})(typeof globalThis !== "undefined" ? globalThis : this);
