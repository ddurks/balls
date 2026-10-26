// game.js — GolfGame, startGame.
// Split out of game.js; loaded as a plain <script> before game.js (see game.html),
// and require()-able in Node for unit tests. Cross-module refs resolve via globals.
(function (global) {
  // ─── MAIN GAME ORCHESTRATOR ────────────────────────────────────────────────

  class GolfGame {
    constructor(canvas, options = {}) {
      this.canvas = canvas;
      this.options = options;
      // "practice" = the driving range, "course" = 3-hole match play
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

      this._faceHold = 0; // s the current expression has been showing
      this._frownT = 0; // near-miss frown left (s)
      this._wasMoving = false;

      this.swingCoordinator = null;

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
      // Preload the handwriting font so canvas-baked text (ball skins, etc.)
      // renders in it — canvas ignores @font-face until the face is loaded.
      if (document.fonts?.load)
        await document.fonts.load('bold 40px "DrawvidHand"').catch(() => {});
      this.scene = new BABYLON.Scene(this.engine);
      this.scene.clearColor = new BABYLON.Color3(0.53, 0.81, 0.92); // Sky blue

      await PhysicsManager.initialize(this.scene);
      await SceneSetup.createEnvironment(this.scene);

      await this.loadGolfBall();
      await this.loadCharacter();

      // CourseManager owns pins/terrain in both modes (practice plays the range).
      this.courseManager = new CourseManager(this);
      await this.courseManager.init();

      // Holing out runs one handler for both modes (see GolfGame.onHoleSink);
      // registered here, after the PinManager exists, so practice and course
      // share the exact same hole-entry cinematic.
      this.eventManager.on("pin:holesink", () => this.onHoleSink());
      this.eventManager.on("game:showShotReview", (reviewData) => {
        this.showShotReviewMessage(reviewData.holeNumber, reviewData.shotCount);
      });

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
      this.circleUIManager.clubSelectBackCallback = () =>
        this.gameStateCoordinator.transitionPlayToAim();

      // Setup AimView after coordinators are ready (it depends on them)
      this.setupAimView();

      this.setupRenderLoop();

      if (this.options.match) this.match = new MatchCoordinator(this);
      await this.courseManager.start();
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
      // The ball applies wind itself, in its per-physics-step flight forces.
      this.golfBall.wind = this.wind;
    }

    async loadCharacter() {
      let result;
      try {
        result = await Shared.loadModel(
          "models/characters/golf-ball.glb",
          this.scene,
        );
      } catch (e) {
        // Non-fatal: the ball still has its physics body + collider mesh, it just
        // won't have the character face/skeleton. Don't kill the whole game.
        console.warn(
          "Character model (gball.glb) failed to load; continuing without it.",
          e,
        );
        return;
      }

      // Parent all character meshes under the physics body via an intermediate
      // "characterRoot" node. The physics engine owns bodyMesh's rotationQuaternion
      // (it re-syncs it from the body every step, and once a quaternion is set the
      // Euler .rotation is ignored), so aim-mode facing must rotate this child node
      // — writes to bodyMesh's rotation never reach the screen.
      const bodyMesh = this.golfBall.mesh;
      const characterRoot = new BABYLON.TransformNode(
        "characterRoot",
        this.scene,
      );
      characterRoot.parent = bodyMesh;
      result.meshes.forEach((mesh) => {
        if (mesh) {
          mesh.parent = characterRoot;
          mesh.position = BABYLON.Vector3.Zero();
          mesh.scaling = new BABYLON.Vector3(0.0254, 0.0254, 0.0254);
        }
      });
      this.golfBall.characterRoot = characterRoot;
      this.golfBall.initSquash();

      // Flat matte ball. Also damp the scene IBL on the ball: the environment
      // texture (scene.js) floods this near-white PBR ball with flat ambient and
      // washes out the painted dimple shading — with no normal map, that shading
      // is the only dimple definition. Low environmentIntensity lets the
      // directional sun shade the dimples so they read. Set on the original
      // material so locker skin-swaps (which clone _origBallMat) inherit it.
      const ballMesh = result.meshes.find(
        (m) => m && m.name && /gball/i.test(m.name) && m.material,
      );
      if (ballMesh) {
        const mat = ballMesh.material;
        if ("roughness" in mat) {
          mat.metallic = 0;
          mat.roughness = 1;
        } else if ("specularColor" in mat) {
          mat.specularColor = new BABYLON.Color3(0, 0, 0);
        }
        if ("environmentIntensity" in mat) mat.environmentIntensity = 0.35;
      }

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
    // never beneath the water surface. Reads the hole's height grid (bed height
    // under water, so the waterline is the binding limit there). CLEAR is small
    // on purpose — the aim view legitimately hugs the ground at ball height.
    cameraFloorY(x, z) {
      const CLEAR = 0.06;
      const cm = this.courseManager;
      if (!cm?.hg) return CLEAR; // before the first hole is built
      return Math.max(cm.groundY(x, z), cm.waterlineY) + CLEAR;
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
        this.camera.syncFromCamera(); // ease on from the aim pose, no jump
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
    onHoleSink() {
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
      if (!this.courseManager.practice) {
        this.courseManager.onHoleComplete(shotCount);
      } else {
        this.eventManager.emit("game:showShotReview", {
          // The range has a cup on every green: report the one actually holed.
          holeNumber: this.scene.pinManager.pins.findIndex((p) => p.sunk) + 1,
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
      font-family: "DrawvidHand", "Comic Sans MS", cursive, sans-serif;
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
        this.golfBall._inCup = false;
        this.gameStateCoordinator.resetForNextHole();
        this.courseManager.nextPracticePin();
      });

      container.appendChild(message);
      container.appendChild(button);
      document.body.appendChild(container);
    }

    togglePhysicsDebug() {
      // Created on first use: a PhysicsViewer's utility layer renders (and
      // clears depth) every frame even when it shows nothing.
      if (!this.physicsViewer && BABYLON.PhysicsViewer)
        this.physicsViewer = new BABYLON.PhysicsViewer(this.scene);
      if (!this.physicsViewer) return;
      this.physicsDebugEnabled = !this.physicsDebugEnabled;

      const bodies = [];
      if (this.golfBall?.body) bodies.push(this.golfBall.body);
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

    updateBallState() {
      const landingState = this.golfBall.updateLandingState();
      // A placed ball (tee, penalty drop) settling is not the end of a shot: it
      // must not archive a trail or send a player already in PLAY back to AIM.
      if (landingState === "fullLand" && this.golfBall.inShot) {
        this.golfBall.inShot = false;
        this.ballTrail.stopTracing();
        this.ballTrail.setVisible(false);
        // Don't go to shot review here - only go when ball is sunk in hole
        this.archiveCurrentTrail();
        this.eventManager.emit(
          "ball:landed",
          this.golfBall.getPosition().clone(),
        );
        // Keep a short pause between the completed shot and the aiming UI.
        this._settleTimer = 0;
        this._awaitingSettle = this.gameState !== GameState.LANDED;
      }

      // A shot that FLEW onto the green (not a putt: that starts on it, and the
      // post-swing setPlayView would fight it) pulls the camera back so the
      // run-out and the cup are in view. The next swing restores the PLAY view.
      const ball = this.golfBall;
      if (!ball.inShot) this._shotFlew = this._greenView = false;
      else if (!this._greenView) {
        if (!this._shotFlew && ball.getVelocity().y > 1.5)
          this._shotFlew = true;
        if (
          this._shotFlew &&
          !ball.isAirborne() &&
          ball._contactPhysics === SURFACE_PHYSICS.green &&
          this.camera?.viewMode === CameraViewMode.PLAY
        ) {
          this._greenView = true;
          this.camera.setGreenView();
        }
      }

      // Hole-out processing owns the transition while the ball drops into the cup.
      if (
        this._awaitingSettle &&
        this.gameState !== GameState.AIM &&
        !this.holeSinkProcessed
      ) {
        const atRest =
          !this.golfBall.isAirborne() &&
          this.golfBall.getSpeed() < 0.03 &&
          this.golfBall.getAngularVelocity().length() <
            CONFIG.PHYSICS.LANDED_ANGULAR_THRESHOLD;
        if (atRest) {
          this._settleTimer += this.engine.getDeltaTime() / 1000;
          if (this._settleTimer >= 0.3) {
            this._awaitingSettle = false;
            this.gameState = GameState.AIM;
            this.aimView.activate();
          }
        } else {
          this._settleTimer = 0; // still moving — wait for a real stop
        }
      }

      // Aim: face the aim camera every frame (it can orbit), turning smoothly
      // toward it. cameraRotation is the ball→camera angle and is stable within
      // the frame, unlike camera.position, which the follow-cam rewrites later.
      const aiming = this.camera && this.gameState === GameState.AIM;
      if (aiming && this.aimView)
        this.golfBall.targetRotation = this.aimView.cameraRotation;
      this.golfBall.updateVisualRotation(
        this.engine.getDeltaTime() / 1000,
        aiming,
      );
      this.golfBall.updateSquash(this.engine.getDeltaTime() / 1000);
      this.golfBall.applyRenderOffset();

      this.updateCharacterFace();
    }

    // The ball's expression, every frame: grimace on a hard strike, woah when
    // rocketing or dropping, elated on the climb, an "o" rolling at the cup, a
    // frown for a near miss, elated when it drops. Holds each face a moment so
    // it doesn't flicker as the ball crosses a threshold.
    updateCharacterFace() {
      const ball = this.golfBall;
      if (!ball) return;
      const dt = this.engine.getDeltaTime() / 1000;

      const vel = ball.getVelocity();
      const speed = vel.length();
      const moving = speed > 0.2;
      const pos = ball.getPosition();

      // The hole that matters: the current hole's cup, else (range) the nearest.
      const pins = this.scene.pinManager?.pins || [];
      let hole = this.currentHolePin?.holePosition || null;
      let sunk = false;
      let best = Infinity;
      for (const pin of pins) {
        const hp = pin.holePosition;
        if (!hp) continue;
        const d = Math.hypot(hp.x - pos.x, hp.z - pos.z);
        if (pin.sunk && d < 0.3) sunk = true;
        if (!this.currentHolePin && d < best) {
          best = d;
          hole = hp;
        }
      }
      const dx = hole ? hole.x - pos.x : 0;
      const dz = hole ? hole.z - pos.z : 0;
      const dHole = hole ? Math.hypot(dx, dz) : Infinity;

      // Came to rest just short of / past the cup: a near-miss frown. (Inside
      // the cup isn't a miss: it rests a frame before the sink check runs.)
      const nearMiss = dHole < 2.5 && dHole > CONFIG.PINS.HOLE_RADIUS;
      if (this._wasMoving && !moving && !sunk && nearMiss) this._frownT = 2.5;
      this._wasMoving = moving;
      this._frownT = Math.max(0, this._frownT - dt);

      let face = "default";
      if (sunk) face = "elated";
      else if (ball._squashT < 0.25 && ball._squashAmp > 0.15) face = "grimace";
      else if (moving) {
        const towardHole = vel.x * dx + vel.z * dz > 0;
        if (dHole < 3 && towardHole && speed < 8 && Math.abs(vel.y) < 1.5)
          face = "o";
        else if (speed > 45 || vel.y < -3) face = "woah";
        else if (vel.y > 1) face = "elated";
      } else if (this._frownT > 0) face = "frown";

      this._faceHold += dt;
      // A strike, a sink or coming to rest switch at once; the rest wait 0.25 s.
      const instant =
        face === "grimace" || (face === "elated" && sunk) || !moving;
      if (face !== ball.currentFace && (instant || this._faceHold > 0.25)) {
        ball.setFace(face);
        this._faceHold = 0;
      }

      ball.updateFaces(dt);
      ball.updateBlinking(dt);
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

      // Heading straight from the view just drawn (this runs after render, once
      // every camera writer — follow, aim, review, flyover — has had its say). A
      // camera looking along −(sin r, cos r) has heading r. The view matrix's
      // second and third columns are the camera's world up and forward; summing
      // their horizontal parts keeps the heading defined when looking straight
      // down (forward vertical) or level (up vertical).
      const v = this.scene.activeCamera.getViewMatrix().m;
      const cameraAngleDeg =
        (Math.atan2(-(v[1] + v[2]), -(v[9] + v[10])) * 180) / Math.PI;
      // Only update SVG rotation if compass angle changed
      const compassRotate = `rotate(${(-cameraAngleDeg).toFixed(1)}deg)`;
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

        this.updateBallState();
        // Pin collisions handled by Havok physics automatically
        this.scene.pinManager?.checkHoleSink();
        this.scene.pinManager?.updateFlags(
          this.wind,
          this.engine.getDeltaTime() / 1000,
        );
        this.updateWater(this.engine.getDeltaTime() / 1000);
        this.ballTrail.update(this.golfBall.getRenderPosition());
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
      // Before-render runs once per frame after physics; the after-physics
      // observable fires once per fixed sub-step, so the frame-time smoothing
      // there would run 0–4 times a frame depending on the frame rate. Inserted
      // first so the rest of the frame sees the updated camera, as before.
      this.scene.onBeforeRenderObservable.add(
        () => {
          // Hold the camera still while the ball drops into the cup — following
          // it down would drag the low PLAY-view camera under the green.
          // (A match spectator's camera follows the opponent's ghost instead.)
          if (
            this.golfBall?._inCup &&
            this.camera.golfBallGuy === this.golfBall
          )
            return;
          this.camera.update(this.engine.getDeltaTime() / 1000);
        },
        undefined,
        true,
      );

      this.scene.onAfterRenderObservable.add(() => this.updateCompass());

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
    const p = new URLSearchParams(location.search);
    startGame({
      mode: urlMode === "course" ? "course" : "practice",
      // Opened into a networked match (see golfnet.js's entries).
      match:
        urlMode === "course" &&
        (p.has("rv") ||
          p.has("match") ||
          p.has("join") ||
          p.get("host") === "1"),
    });
  }

  Object.assign(global, { GolfGame, startGame });
  if (typeof module !== "undefined" && module.exports)
    module.exports = { GolfGame, startGame };
})(typeof globalThis !== "undefined" ? globalThis : this);
