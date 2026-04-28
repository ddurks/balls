// ═══════════════════════════════════════════════════════════════════════════
// GOLF BALL GAME — Babylon.js + Havok Physics
// ═══════════════════════════════════════════════════════════════════════════
//
// A 3D golf game with physics-based ball movement, procedural terrain,
// and character animation. Uses Babylon.js for rendering and Havok for physics.
//
// Architecture:
//  - CONFIG: Centralized tuning constants
//  - Utilities: EventManager, Utils, TrajectoryArrow
//  - Core Systems: Wind, Physics, Camera, Character
//  - Input & UI: InputHandler, UIManager, SwipeArrowOverlay
//  - Scene Setup: SceneSetup, GolfGame (main orchestrator)
//
// ═══════════════════════════════════════════════════════════════════════════

// ─── CONSTANTS ──────────────────────────────────────────────────────────────

const GameState = { AIM: "aim", PLAY: "play", LANDED: "landed" };
const CameraViewMode = { PLAY: "play", SHOT_REVIEW: "shotReview" };

const PALETTE = {
  YELLOW: "#ffeb3b",
  GREEN_DARK: "#3a6b35",
  GREEN_LIGHT: "rgba(144,200,150,0.85)",
};

const UNITS = {
  MS_TO_MPH: 2.237, // m/s → mph
  M_TO_FEET: 3.28084, // m → feet
  M_TO_YARDS: 1.094, // m → yards
};

// ─── CONFIGURATION ──────────────────────────────────────────────────────────

const CONFIG = {
  SCREEN: {
    // Robust mobile/small screen detection: true if viewport width < 1024px
    IS_SMALL_SCREEN: window.innerWidth < 1024,
    // UI scale factor: 2/3 for small screens, 1x for desktop
    UI_SCALE: window.innerWidth < 1024 ? 2 / 3 : 1.0,
  },
  ENVIRONMENT: {
    ENV_TEXTURE_PATH: "assets/puresky.env",
    SKYBOX_ENABLED: true,
    SKYBOX_SIZE: 1000,
    SKYBOX_PBRBRIGHT: 0,
  },
  TERRAIN: {
    WIDTH: 2500,
    HEIGHT: 2500,
    SUBDIVISIONS: 50,
    FRICTION: 0.4,
    RESTITUTION: 0.3,
    TEXTURE_PATH: "assets/ground.png",
    NORMAL_MAP_PATH: "assets/groundnormals.png",
    UV_TILING: 500,
  },
  BALL: {
    COLLIDER_DIAMETER: 0.9,
    MASS: 0.045,
    FRICTION: 0.7,
    RESTITUTION: 0.6,
    LINEAR_DAMPING: 0.3,
    ANGULAR_DAMPING: 0.8,
  },
  CAMERA: {
    FOV_AIM: 1.5,
    FOV_PLAY: 1.5,
    FOLLOW_SMOOTH: 0.1,
    POSITION_LERP_SPEED: 0.15,
    ANGLE_LERP_SPEED: 0.08,
  },
  GRASS: {
    VIEW_RADIUS: 60,
    UPDATE_THRESHOLD: 5,
    FRAME_COUNT: 5,
    BILLBOARD_MODE: BABYLON.Mesh.BILLBOARDMODE_ALL,
  },
  LIGHTING: {
    AMBIENT_INTENSITY: 0.75,
    SUN_INTENSITY: 1.1,
  },
  BALL_VISUAL: {
    PBR_METALLIC: 0,
    PBR_ROUGHNESS: 1,
    PBR_ENV_INTENSITY: 0.35,
    PBR_MICRO_SURFACE: 0.2,
    STANDARD_SPECULAR: 0.03,
  },
  AIM_VIEW: {
    CAMERA_DISTANCE: 10,
    CAMERA_HEIGHT: 5,
    CAMERA_HEIGHT_MIN: 3,
    CAMERA_HEIGHT_MAX: 15,
    MOUSE_ROTATION_SENSITIVITY: 0.005,
    MOUSE_HEIGHT_SENSITIVITY: 0.01,
    CLICK_DETECTION_THRESHOLD: 5,
  },
  TRAJECTORY: {
    ARROW_LENGTH: 12,
    ARROW_RADIUS: 0.15,
    ARROW_Y_OFFSET: 0.5,
  },
  FOLLOW_CAMERA: {
    PLAY_VIEW_OFFSET_X: 0,
    PLAY_VIEW_OFFSET_Y: 0,
    PLAY_VIEW_OFFSET_Z: 2,
    PLAY_VIEW_LOOK_OFFSET_Y: 1.5,
    PLAY_VIEW_LOOK_OFFSET_Z: -5,
    PLAY_VIEW_MAX_DISTANCE: 40, // Maximum distance camera can zoom out during shot review
    FULL_SHOT_VIEW_MIN_HEIGHT: 8,
    FULL_SHOT_VIEW_MIN_Z: 15,
    FULL_SHOT_VIEW_LOOK_Z: -30,
    FULL_SHOT_VIEW_SCALE_X: 0.2,
    FULL_SHOT_VIEW_SCALE_Y: 0.35,
    FULL_SHOT_VIEW_SCALE_Z: 0.5,
    FULL_SHOT_VIEW_SCALE_LOOK_Z: 0.6,
    OVERVIEW_ORBIT_SENSITIVITY: 0.005,
  },
  GOLF_BALL: {
    MAX_HIT_STRENGTH: 1.75,
    HIT_HORIZONTAL_DEVIATION_FACTOR: 0.1,
    IMPACT_POINT_OFFSET_X: 0,
    IMPACT_POINT_OFFSET_Y: -0.3,
    IMPACT_POINT_OFFSET_Z: 0.3,
  },
  BLINKING: {
    MIN_INTERVAL_MS: 2500,
    MAX_INTERVAL_MS: 5000,
    BLINK_CLOSE_DURATION_MS: 100,
    BLINK_HOLD_DURATION_MS: 50,
    BLINK_OPEN_DURATION_MS: 100,
  },
  EYES: {
    MAX_YAW: 0.25, // radians (~14°) — left/right gaze limit
    MAX_PITCH: 0.18, // radians (~10°) — up/down gaze limit
    LERP_SPEED: 6, // exponential smoothing factor
  },
  UI: {
    CLUB_SELECTOR_BOTTOM: 20,
    CLUB_SELECTOR_RIGHT: 20,
    CLUB_BUTTON_WIDTH: 60,
    CLUB_BUTTON_HEIGHT: 60,
    CLUB_DISPLAY_SIZE: 120,
  },
  PINS: {
    GREEN_RADIUS: 30,
    PIN_HEIGHT: 12.0,
    PIN_DIAMETER: 0.2,
    PIN_Y_OFFSET: 6.0,
    GREEN_Y_OFFSET: 0.5,
    GREEN_TEXTURE_PATH: "assets/puttingground.png",
    GREEN_NORMAL_MAP_PATH: "assets/puttinggroundnormals.png",
    GREEN_UV_TILING: 10,
    PIN_COLLISION_RADIUS: 0.3,
    PIN_COLLISION_MIN_SPEED: 0.5,
    PIN_FLASH_SCALE_Y: 2,
    PIN_FLASH_DURATION_MS: 100,
    FLAG_WIDTH: 4.0,
    FLAG_HEIGHT: 2.4,
    HOLE_RADIUS: 0.8,
    HOLE_Y_OFFSET: 0.52,
    FLAG_WIND_THRESHOLD: 2.235, // ~5 mph in m/s
  },
  TRAIL: {
    MAX_POINTS: 60,
    MAX_AGE_MS: 3000,
    MIN_DISTANCE_BETWEEN_POINTS: 4,
    UPDATE_FREQUENCY: 1,
    TRAIL_RADIUS: 0.06,
  },
  SWIPE_OVERLAY: {
    START_X_PCT: 0.5,
    START_Y_PCT: 0.82,
    IDEAL_ALPHA: 0.35,
    IDEAL_WIDTH: 5,
    HIT_WIDTH: 5,
    SPIN_WIDTH: 4,
    HIT_FADE_MS: 750,
    SPIN_FADE_MS: 300,
    MIN_PREVIEW_LENGTH: 24,
    IDEAL_MIN_PREVIEW_LENGTH: 8,
    MAX_PREVIEW_LENGTH: 110,
    VISUAL_SCALE: 2.0,
    PHYSICS_STEP_SECONDS: 1 / 60,
    BOUNCE_RANGE_MULTIPLIER: 1.12,
    MIN_FORWARD_FORCE: 8,
    MAX_LATERAL_RATIO: 0.45,
    MAX_LATERAL_FORCE: 10,
    AIM_SELECTION_ANGLE_RAD: 0.25,
    IDEAL_COLOR: PALETTE.YELLOW,
    HIT_COLOR: PALETTE.YELLOW,
    SPIN_COLORS: ["#55d6ff", "#8cff66", "#ff8cf5", "#ff9966"],
  },
  WIND: {
    MIN_SPEED: 0,
    MAX_SPEED: 10,
    CHANGE_FREQUENCY: 8000,
    FORCE_MULTIPLIER: 0.025,
    COMPASS_SIZE: 140,
    COMPASS_TOP: 15,
    COMPASS_RIGHT: 15,
  },
  CLOUDS: {
    TEXTURE_DIR: "assets/clouds",
    TEXTURE_COUNT: 10,
    COUNT: 25,
    HORIZON_DISTANCE: 300, // Radius around player where clouds spawn
    HORIZON_HEIGHT: 100, // Height above ball where clouds float
    MIN_HEIGHT: 30, // Minimum height above ground to keep visible
    CLOUD_SIZE: 50,
    SPEED: 30, // units per second
  },
};

// ═════════════════════════════════════════════════════════════════════════════
// UTILITIES & INFRASTRUCTURE
// ═════════════════════════════════════════════════════════════════════════════

// ─── WIND SYSTEM ────────────────────────────────────────────────────────────
// Manages wind direction and speed; applies procedural force to airborne balls.

class Wind {
  constructor() {
    this.direction = 0; // radians, 0 = right (East), PI/2 = down (South), etc.
    this.speed = 0; // m/s
    this.nextChangeTime = Date.now() + CONFIG.WIND.CHANGE_FREQUENCY;
    this.generateNewWind();
  }

  update() {
    // Wind changes are now controlled manually via compass
  }

  generateNewWind() {
    this.direction = Math.random() * Math.PI * 2; // 0 to 2π
    this.speed =
      CONFIG.WIND.MIN_SPEED +
      Math.random() * (CONFIG.WIND.MAX_SPEED - CONFIG.WIND.MIN_SPEED);
  }

  getWindVector() {
    // Convert polar coordinates to Cartesian
    // x = left/right in world coords (negative X = West, positive X = East)
    // z = forward/backward in world coords (positive Z = North, negative Z = South)
    return new BABYLON.Vector3(
      -Math.sin(this.direction) * this.speed,
      0,
      Math.cos(this.direction) * this.speed,
    );
  }

  getForceVector() {
    const windVec = this.getWindVector();
    return windVec.scale(CONFIG.WIND.FORCE_MULTIPLIER);
  }

  reset() {
    this.generateNewWind();
    this.nextChangeTime = Date.now() + CONFIG.WIND.CHANGE_FREQUENCY;
  }
}

// ─── CLOUD SYSTEM ──────────────────────────────────────────────────────────
// Renders billboarded clouds that drift across the horizon using spritesheet.

class CloudSystem {
  constructor(scene, camera = null) {
    this.scene = scene;
    this.camera = camera;
    this.clouds = [];
    this.cloudTextures = [];
    this.isInitialized = false;
    this.init();
  }

  init() {
    try {
      // Load all individual cloud textures
      for (let i = 1; i <= CONFIG.CLOUDS.TEXTURE_COUNT; i++) {
        const tex = new BABYLON.Texture(
          `${CONFIG.CLOUDS.TEXTURE_DIR}/clouds-${i}.png`,
          this.scene,
        );
        tex.hasAlpha = true;
        this.cloudTextures.push(tex);
      }

      for (let i = 0; i < CONFIG.CLOUDS.COUNT; i++) {
        this.createCloud(i);
      }

      this.isInitialized = true;
    } catch (error) {
      // Cloud loading failed silently
    }
  }

  createCloud(index) {
    const cloud = BABYLON.MeshBuilder.CreatePlane(
      `cloud_${index}`,
      { width: CONFIG.CLOUDS.CLOUD_SIZE, height: CONFIG.CLOUDS.CLOUD_SIZE },
      this.scene,
    );

    cloud.billboardMode = BABYLON.Mesh.BILLBOARDMODE_ALL;
    cloud.alwaysSelectAsActiveMesh = true;

    const mat = new BABYLON.StandardMaterial(`cloudMat_${index}`, this.scene);

    // Pick a random texture from the loaded set
    const tex =
      this.cloudTextures[Math.floor(Math.random() * this.cloudTextures.length)];
    mat.emissiveTexture = tex; // unlit color from texture pixels
    mat.emissiveColor = new BABYLON.Color3(1, 1, 1); // white multiplier — show full texture color
    mat.diffuseTexture = tex; // needed so alpha is read from the texture
    mat.diffuseColor = new BABYLON.Color3(0, 0, 0); // kill lighting contribution on diffuse
    mat.specularColor = new BABYLON.Color3(0, 0, 0);
    mat.useAlphaFromDiffuseTexture = true; // use texture alpha channel for transparency
    mat.transparencyMode = BABYLON.Material.MATERIAL_ALPHATESTANDBLEND;
    mat.backFaceCulling = false;

    cloud.material = mat;

    // Add random rotation for variety
    cloud.rotation.z = Math.random() * Math.PI * 2;

    // Position randomly distributed in area above player
    const spread = CONFIG.CLOUDS.HORIZON_DISTANCE;
    const minHeight = CONFIG.CLOUDS.MIN_HEIGHT;
    const maxHeight = CONFIG.CLOUDS.HORIZON_HEIGHT * 1.5;

    cloud.position = new BABYLON.Vector3(
      (Math.random() - 0.5) * spread * 2, // Random X within ±spread
      minHeight + Math.random() * (maxHeight - minHeight), // Random height
      (Math.random() - 0.5) * spread * 2, // Random Z within ±spread
    );

    // Store cloud data
    this.clouds.push({
      mesh: cloud,
    });
  }

  update(ballPos, wind) {
    if (!this.cloudTextures.length) {
      return;
    }

    this.clouds.forEach((cloud, idx) => {
      // Get wind vector - clouds move 100% with wind
      const windVector = wind.getWindVector();

      // Move cloud based on wind only
      const effectiveVelocity = windVector;

      const moveDistance = 1 / 60; // Per frame at 60fps
      cloud.mesh.position.x += effectiveVelocity.x * moveDistance;
      cloud.mesh.position.z += effectiveVelocity.z * moveDistance;

      // Calculate drift distance from ball on X/Z plane
      const driftX = cloud.mesh.position.x - ballPos.x;
      const driftZ = cloud.mesh.position.z - ballPos.z;
      const driftDist = Math.sqrt(driftX * driftX + driftZ * driftZ);

      // Recycle cloud when it drifts too far - respawn on opposite side
      if (driftDist > CONFIG.CLOUDS.HORIZON_DISTANCE * 3) {
        // Calculate direction cloud drifted away
        const driftAngle = Math.atan2(driftZ, driftX);

        // Respawn on the opposite side with a small random angle spread
        const oppositeAngle =
          driftAngle + Math.PI + (Math.random() - 0.5) * 1.2;
        const respawnDistance =
          CONFIG.CLOUDS.HORIZON_DISTANCE * (0.7 + Math.random() * 0.3);
        const minHeight = CONFIG.CLOUDS.MIN_HEIGHT;
        const maxHeight = CONFIG.CLOUDS.HORIZON_HEIGHT * 1.5;

        cloud.mesh.position = new BABYLON.Vector3(
          ballPos.x + Math.cos(oppositeAngle) * respawnDistance,
          minHeight + Math.random() * (maxHeight - minHeight),
          ballPos.z + Math.sin(oppositeAngle) * respawnDistance,
        );
      }
    });
  }

  dispose() {
    this.clouds.forEach((cloud) => {
      if (cloud.mesh.material) cloud.mesh.material.dispose();
      cloud.mesh.dispose();
    });
    this.clouds = [];
    this.cloudTextures.forEach((t) => t.dispose());
    this.cloudTextures = [];
  }
}

// ─── EVENT MANAGER ──────────────────────────────────────────────────────────

class EventManager {
  constructor() {
    this.listeners = {};
  }

  on(eventName, callback) {
    if (!this.listeners[eventName]) {
      this.listeners[eventName] = [];
    }
    this.listeners[eventName].push(callback);
  }

  off(eventName, callback) {
    if (!this.listeners[eventName]) return;
    this.listeners[eventName] = this.listeners[eventName].filter(
      (cb) => cb !== callback,
    );
  }

  emit(eventName, data = null) {
    if (!this.listeners[eventName]) return;
    this.listeners[eventName].forEach((callback) => callback(data));
  }
}

// ─── UTILITY HELPERS ────────────────────────────────────────────────────────

const Utils = {
  // Create StandardMaterial with common properties
  createMaterial(name, scene, color, specular = null, power = 16) {
    const mat = new BABYLON.StandardMaterial(name, scene);
    mat.diffuseColor = color;
    if (specular) {
      mat.specularColor = specular;
      mat.specularPower = power;
    }
    return mat;
  },

  // Rotate 2D vector by angle
  rotate2D(x, z, angle) {
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    return {
      x: x * cos - z * sin,
      z: x * sin + z * cos,
    };
  },

  // Add shadow caster to all meshes in array
  addShadowCasters(meshes, shadowGenerator) {
    meshes.forEach((m) => {
      if (m) shadowGenerator?.addShadowCaster(m, true);
    });
  },

  // Convert meters to yards (1 meter ≈ 1.094 yards)
  metersToYards(meters) {
    return Math.round(meters * UNITS.M_TO_YARDS);
  },

  // Format distance for display (yards with ' notation)
  formatDistance(meters) {
    const yards = this.metersToYards(meters);
    return `${yards}'`;
  },
};

// ═════════════════════════════════════════════════════════════════════════════
// GAME MECHANICS
// ═════════════════════════════════════════════════════════════════════════════

// ─── CLUB DATA ──────────────────────────────────────────────────────────────

class ClubData {
  static CLUBS = [
    { id: 0, name: "Putter", angle: 0, maxDistance: 11 },
    { id: 1, name: "Lob Wedge", angle: 60, maxDistance: 55 },
    { id: 2, name: "Pitching Wedge", angle: 45, maxDistance: 66 },
    { id: 3, name: "9 Iron", angle: 42, maxDistance: 88 },
    { id: 4, name: "8 Iron", angle: 39, maxDistance: 109 },
    { id: 5, name: "7 Iron", angle: 37, maxDistance: 131 },
    { id: 6, name: "6 Iron", angle: 34, maxDistance: 153 },
    { id: 7, name: "5 Iron", angle: 31, maxDistance: 175 },
    { id: 8, name: "4 Iron", angle: 28, maxDistance: 197 },
    { id: 9, name: "Hybrid", angle: 20, maxDistance: 241 },
    { id: 10, name: "3 Wood", angle: 16, maxDistance: 263 },
    { id: 11, name: "5 Wood", angle: 19, maxDistance: 252 },
    { id: 12, name: "Driver", angle: 12, maxDistance: 306 },
  ];

  static getClub(id) {
    return this.CLUBS[Math.max(0, Math.min(id, this.CLUBS.length - 1))];
  }
}

// ─── TRAJECTORY ARROW ──────────────────────────────────────────────────────

class TrajectoryArrow {
  constructor(scene, ballPos) {
    this.scene = scene;
    this.ballPos = ballPos;
    this.arrow = null;
    this.arrowTemplate = null; // Master template loaded from arrow.glb
    this.lastArrowAngle = -1;
    this.isLoaded = false;
    this.currentColor = new BABYLON.Color3(1, 1, 0); // Default yellow
    this.pendingColor = null; // Color to apply after arrow is created
    this.loadArrowModel();
  }

  async loadArrowModel() {
    try {
      const result = await BABYLON.SceneLoader.ImportMeshAsync(
        "",
        "assets/",
        "arrow.glb",
        this.scene,
      );

      // Store the first mesh as the template (parent container for tip and tail)
      if (result.meshes && result.meshes.length > 0) {
        this.arrowTemplate = result.meshes[0];
        this.arrowTemplate.setEnabled(false); // Hide template

        // Ensure all child meshes are also disabled initially
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
      this.arrow.dispose();
    }

    // Clone the arrow model
    this.arrow = this.arrowTemplate.clone("trajectoryArrow_instance");
    this.arrow.setEnabled(true);

    // Reset rotations to identity on the cloned instance
    this.arrow.rotation = new BABYLON.Vector3(0, 0, 0);
    this.arrow.rotationQuaternion = null;

    // Enable all child meshes (tip and tail)
    this.arrow.getChildMeshes().forEach((mesh) => {
      mesh.setEnabled(true);
    });

    // Apply any pending color that was set before arrow was created
    if (this.pendingColor) {
      this.currentColor = this.pendingColor;
      this.pendingColor = null;
      this.applyColor();
    }

    // Store angle for tilt calculation
    this.lastArrowAngle = clubAngle;
  }

  update(ballPos, clubAngle, cameraRotation) {
    // Recreate arrow if angle changed significantly (to show new trajectory)
    if (!this.arrow || this.lastArrowAngle !== clubAngle) {
      this.create(clubAngle);
    }

    if (!this.arrow) return;

    // Update position
    this.arrow.position = ballPos.clone();
    this.arrow.position.y += CONFIG.TRAJECTORY.ARROW_Y_OFFSET;

    // Convert club angle to radians (for pitch/tilt)
    const angleDeg = Math.max(0, Math.min(clubAngle || 12, 60));
    const angleRad = (angleDeg * Math.PI) / 180;

    // Set rotations fresh each frame
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
      // Arrow doesn't exist yet, store for later
      this.pendingColor = color;
      return;
    }

    // Arrow exists, apply color immediately
    this.applyColor();
  }

  applyColor() {
    if (!this.arrow) {
      return;
    }

    // Get all meshes in the arrow hierarchy
    try {
      const meshes = [this.arrow, ...this.arrow.getChildMeshes()];

      meshes.forEach((mesh) => {
        if (!mesh) return;

        // Create or update material
        let mat = mesh.material;
        if (!mat) {
          mat = new BABYLON.StandardMaterial(
            "arrowMat_" + Math.random(),
            this.scene,
          );
          mesh.material = mat;
        }

        // Apply color to multiple channels for visibility
        const color = this.currentColor.clone();

        // Set diffuse color (main surface color)
        if (mat.diffuseColor !== undefined) {
          mat.diffuseColor = color;
        }

        // Set emissive color at full brightness
        if (mat.emissiveColor !== undefined) {
          mat.emissiveColor = color.clone();
        }

        // Set specular for extra visibility
        if (mat.specularColor !== undefined) {
          mat.specularColor = color.clone();
        }
      });
    } catch (error) {
      console.warn("Error applying arrow color:", error);
    }
  }
}

// ─── CLUB SELECTOR ──────────────────────────────────────────────────────────
/**
 * Manages club selection logic and auto-selection based on distance
 */
class ClubSelector {
  constructor(circleUIManager = null) {
    this.circleUIManager = circleUIManager;
    this.currentClub = 12; // Default to driver
    this.manuallySelectedClub = false; // True if user manually picked a club
    this.clubButtonsAttached = false; // Track if button listeners are set up
  }

  /**
   * Reset to driver when entering aim mode
   */
  reset() {
    this.currentClub = 12;
    this.manuallySelectedClub = false;
    this.clubButtonsAttached = false;
  }

  /**
   * Find best club for a given distance
   */
  findBestClubForDistance(distance) {
    let bestClubId = 12; // Default to driver
    let bestDifference = Math.abs(
      this.getPredictedDistanceForClub(ClubData.getClub(12)) - distance,
    );

    for (let i = 0; i < ClubData.CLUBS.length; i++) {
      const club = ClubData.CLUBS[i];
      const predicted = this.getPredictedDistanceForClub(club);
      const difference = Math.abs(predicted - distance);
      if (difference < bestDifference) {
        bestDifference = difference;
        bestClubId = i;
      }
    }
    return bestClubId;
  }

  /**
   * Get predicted max distance for a club
   */
  getPredictedDistanceForClub(club) {
    return club.maxDistance;
  }

  /**
   * Auto-select best club if user hasn't manually picked one
   */
  autoSelectClubIfNeeded(distance) {
    if (!this.manuallySelectedClub) {
      this.currentClub = this.findBestClubForDistance(distance);
      return true; // Club changed
    }
    return false; // Club unchanged
  }

  /**
   * Manually set club and prevent auto-selection until camera rotates
   */
  selectClub(clubId) {
    this.currentClub = Math.max(0, Math.min(12, clubId));
    this.manuallySelectedClub = true;
  }

  /**
   * Allow auto-selection again (e.g., after camera rotation)
   */
  enableAutoSelect() {
    this.manuallySelectedClub = false;
  }

  /**
   * Update UI with current club info
   */
  updateUI() {
    if (!this.circleUIManager) return;

    const club = ClubData.getClub(this.currentClub);
    const estimatedDistance = Utils.metersToYards(club.maxDistance);

    this.circleUIManager.updateClub(
      this.currentClub,
      club.name,
      estimatedDistance,
    );

    // Attach button listeners if not already done
    if (!this.clubButtonsAttached) {
      const buttons = this.circleUIManager.getClubButtons();
      if (buttons) {
        if (buttons.upBtn) {
          buttons.upBtn.onclick = (e) => {
            e.stopPropagation();
            this.selectClub((this.currentClub - 1 + 13) % 13);
            this.updateUI();
          };
        }
        if (buttons.downBtn) {
          buttons.downBtn.onclick = (e) => {
            e.stopPropagation();
            this.selectClub((this.currentClub + 1) % 13);
            this.updateUI();
          };
        }
        this.clubButtonsAttached = true;
      }
    }
  }

  /**
   * Handle keyboard input for club selection
   */
  handleKeyPress(key) {
    if (key >= "0" && key <= "9") {
      this.selectClub(parseInt(key));
      return true;
    } else if (key === "q") {
      this.selectClub((this.currentClub + 1) % 13);
      return true;
    } else if (key === "e") {
      this.selectClub((this.currentClub - 1 + 13) % 13);
      return true;
    }
    return false;
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

    // Use ClubSelector to manage club logic
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

      // User is rotating camera - allow auto-select to track new aim
      this.clubSelector.enableAutoSelect();

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
        // Raycasting to detect what was clicked
        const pickResult = this.scene.pick(e.clientX, e.clientY);

        if (pickResult && pickResult.hit) {
          const pickedMesh = pickResult.pickedMesh;

          // Check if picked mesh is a pin
          const pins = this.game?.scene?.pinManager?.pins;
          if (pins && pins.length > 0) {
            for (const pinData of pins) {
              if (
                pickedMesh === pinData.mesh ||
                pickedMesh?.parent === pinData.mesh
              ) {
                // Pin clicked! Use clubSelector to auto-pick best club
                const distanceToPin = BABYLON.Vector3.Distance(
                  this.ballMesh.position,
                  pinData.mesh.position,
                );
                const bestClubId =
                  this.clubSelector.findBestClubForDistance(distanceToPin);
                this.clubSelector.selectClub(bestClubId);
                this.clubSelector.updateUI();
                return; // Don't check for ball click if pin was clicked
              }
            }
          }

          // Check if picked mesh is the ball or any child of the ball
          let isValidClick = false;
          if (pickedMesh === this.ballMesh || pickedMesh?.name === "gball") {
            isValidClick = true;
          } else {
            // Check if mesh is a child of the ball
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

  // Getter for backward compatibility
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
    this.clubSelector.reset(); // Reset club selection
    this.camera.fov = CONFIG.CAMERA.FOV_AIM;

    // Character faces camera in aim mode (smoothly rotates via updateRotation in render loop)
    this.golfBallGuy.setFacingCamera(this.camera.position);

    this.setupOrbitControls();
    this.trajectoryArrow.create();
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
    if (this.circleUIManager) {
      this.circleUIManager.hideClubCircle();
      this.circleUIManager.showStatsCircle();
      this.circleUIManager.showCompassCircle();
      this.circleUIManager.showPowerCircle();
    }
  }

  setupOrbitControls() {
    // Listen to canvas pointer events (same as InputHandler)
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

    this.camera.position = new BABYLON.Vector3(
      cameraX,
      ballPos.y + this.cameraHeight,
      cameraZ,
    );
    this.camera.setTarget(ballPos.add(new BABYLON.Vector3(0, 1, 0)));

    // Always get the current club (will be used for arrow and calculations)
    const club = ClubData.getClub(this.clubSelector.currentClub);

    // Calculate distance to nearest pin and auto-select best club
    const pins = this.game?.scene?.pinManager?.pins;

    if (pins && pins.length > 0) {
      try {
        const distanceToPin =
          this.getDistanceToNearestPin(ballPos) * UNITS.M_TO_YARDS;

        // Auto-select best club if user hasn't manually picked one
        if (this.clubSelector.autoSelectClubIfNeeded(distanceToPin)) {
          this.clubSelector.updateUI(); // Update UI if club changed
        }

        // Determine arrow color based on prediction
        const predictedDistance =
          this.clubSelector.getPredictedDistanceForClub(club);
        const arrowColor = this.getArrowColor(predictedDistance, distanceToPin);
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

    // Try to get pin aligned with aim direction
    const { distance: targetDist, pin: targetPin } = pinManager.getTargetPin(
      ballPos,
      this.cameraRotation,
    );
    if (targetPin) return targetDist;

    // Fallback to nearest pin if nothing in front
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
      // On target - GREEN
      return new BABYLON.Color3(0, 1, 0);
    } else if (difference < -tolerance) {
      // Too short - YELLOW
      return new BABYLON.Color3(1, 1, 0);
    } else {
      // Too far - RED
      return new BABYLON.Color3(1, 0, 0);
    }
  }

  updateUI() {
    this.clubSelector.updateUI();
  }

  hideClubUI() {
    // Now handled by circleUIManager.hideClubCircle()
    // Keep for backward compatibility
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// PHYSICS & CHARACTER SYSTEMS
// ═════════════════════════════════════════════════════════════════════════════

// ─── PHYSICS CONFIGURATION ──────────────────────────────────────────────────

class PhysicsConfig {
  static GRAVITY = new BABYLON.Vector3(0, -9.81, 0);
  static BALL_MASS = CONFIG.BALL.MASS;
  static BALL_FRICTION = CONFIG.BALL.FRICTION;
  static BALL_RESTITUTION = CONFIG.BALL.RESTITUTION;
  static BALL_LINEAR_DAMPING = CONFIG.BALL.LINEAR_DAMPING;
  static BALL_ANGULAR_DAMPING = CONFIG.BALL.ANGULAR_DAMPING;
  static GROUND_FRICTION = CONFIG.TERRAIN.FRICTION;
  static GROUND_RESTITUTION = CONFIG.TERRAIN.RESTITUTION;

  static HIT_FORWARD_FORCE = 100; // Reduced for finesse gameplay
  static HIT_UPWARD_FORCE = 60; // Reduced for finesse gameplay
  static SPIN_MULTIPLIER = 400; // Increased for more spin effect
  static SPIN_ANIMATION_SPEED = 0.3;

  static MIN_SWIPE_DISTANCE = 3; // Lowered for more control
  static AIRBORNE_HEIGHT = 2;
  static GROUND_CONTACT_HEIGHT = 1.5;
  static LANDED_SPEED_THRESHOLD = 0.5;
}

// ─── CHARACTER (GOLF BALL WITH ANIMATIONS) ─────────────────────────────────
// Ball physics, face expressions, blinking, and eye gaze system.

class GolfBallGuy {
  constructor(mesh, physicsBody, skeleton, scene) {
    // Physics properties
    this.mesh = mesh;
    this.body = physicsBody;
    this.startPosition = mesh.position.clone();
    this.landed = true;
    this.touchedGround = false;
    this.pendingSpinAmount = 0;
    this.pendingSpinAxis = BABYLON.Vector3.Zero();

    // Character properties
    this.skeleton = skeleton;
    this.spinBone = null;
    this.scene = scene;

    // Face system properties
    this.faceMesh = null;
    this.faceMaterial = null;
    this.faceTextures = {};
    this.currentFace = "default";
    this.faceTransitionTimer = 0;
    this.nextFace = null;

    // Face timing constants
    this.HIT_FACE_DURATION = 0.3;
    this.COLLISION_FACE_DURATION = 0.4;

    // Spin transition for aiming -> hitting
    this.spinTransitionActive = false;
    this.spinTransitionTimer = 0;
    this.spinTransitionDuration = 0.4;

    // Rotation control
    this.targetRotation = 0;
    this.facingAimDirection = false;

    // Blinking system
    this.eyelidsMesh = null;
    this.blinkState = "open"; // "open" -> "closing" -> "closed" -> "opening" -> "open"
    this.blinkTimer = 0;
    this.nextBlinkTime =
      CONFIG.BLINKING.MIN_INTERVAL_MS +
      Math.random() *
        (CONFIG.BLINKING.MAX_INTERVAL_MS - CONFIG.BLINKING.MIN_INTERVAL_MS);

    // Eye gaze system
    this.eyeL = null;
    this.eyeR = null;
    this.eyeLRest = null;
    this.eyeRRest = null;
    this.eyeYaw = 0;
    this.eyePitch = 0;

    if (skeleton && skeleton.bones.length > 0) {
      this.spinBone = skeleton.bones.find((b) =>
        b.name.toLowerCase().includes("spin"),
      );
      if (!this.spinBone) {
        this.spinBone = skeleton.bones[0];
      }
    }
  }

  // === PHYSICS METHODS ===
  getPosition() {
    return this.mesh.position;
  }

  getHeight() {
    return this.mesh.position.y;
  }

  getVelocity() {
    let vel = BABYLON.Vector3.Zero();
    this.body.getLinearVelocityToRef(vel);
    return vel;
  }

  getSpeed() {
    return this.getVelocity().length();
  }

  getAngularVelocity() {
    let angVel = BABYLON.Vector3.Zero();
    this.body.getAngularVelocityToRef(angVel);
    return angVel;
  }

  applyHit(
    deltaX,
    deltaY,
    force,
    aimedDirection = 0,
    clubLaunchAngle = 0,
    clubMaxDistance = 100,
  ) {
    const swipeStrength = Math.min(
      force / 100,
      CONFIG.GOLF_BALL.MAX_HIT_STRENGTH,
    );
    // Scale forward force based on club's max distance (e.g., Driver 280m vs Wedge 60m)
    // Use sqrt scaling to soften the differences while maintaining realistic ratios
    const distanceMultiplier = Math.sqrt(clubMaxDistance / 100);
    const forwardForce =
      PhysicsConfig.HIT_FORWARD_FORCE * swipeStrength * distanceMultiplier;
    // Club launch angle directly scales upward force: 0° = roll, 45° = high loft
    const angleRadians = (clubLaunchAngle * Math.PI) / 180;
    const upwardForce =
      PhysicsConfig.HIT_UPWARD_FORCE *
      swipeStrength *
      Math.sin(angleRadians) *
      2;
    const horizontalDeviation =
      -deltaX * CONFIG.GOLF_BALL.HIT_HORIZONTAL_DEVIATION_FACTOR;

    const localForce = new BABYLON.Vector3(
      horizontalDeviation,
      upwardForce,
      -forwardForce,
    );
    const { x: rotX, z: rotZ } = Utils.rotate2D(
      localForce.x,
      localForce.z,
      aimedDirection,
    );
    const rotatedForce = new BABYLON.Vector3(rotX, localForce.y, rotZ);

    const impactPoint = this.getPosition().add(
      new BABYLON.Vector3(
        CONFIG.GOLF_BALL.IMPACT_POINT_OFFSET_X,
        CONFIG.GOLF_BALL.IMPACT_POINT_OFFSET_Y,
        CONFIG.GOLF_BALL.IMPACT_POINT_OFFSET_Z,
      ),
    );

    this.body.applyForce(rotatedForce, impactPoint);
    this.body.setAngularVelocity(BABYLON.Vector3.Zero());
  }

  applySpin(spinAxis, spinAmount) {
    // Accumulate spin instead of replacing it
    const accumulatedSpin = Math.min(this.pendingSpinAmount + spinAmount, 1.2);
    const angularVelocity = spinAxis.scale(
      accumulatedSpin * PhysicsConfig.SPIN_MULTIPLIER,
    );
    this.body.setAngularVelocity(angularVelocity);
    this.pendingSpinAmount = accumulatedSpin;
    this.pendingSpinAxis = spinAxis;

    // Store spin axis for debug visualization
    this.debugSpinAxis = spinAxis.clone();
    this.debugSpinLineTimeout = 30;
  }

  updateLandingState() {
    const height = this.getHeight();
    const speed = this.getSpeed();

    if (height < PhysicsConfig.GROUND_CONTACT_HEIGHT && !this.touchedGround) {
      this.touchedGround = true;
      this.pendingSpinAmount = 0;
      this.pendingSpinAxis = BABYLON.Vector3.Zero();
      return "firstContact";
    }

    if (
      speed < PhysicsConfig.LANDED_SPEED_THRESHOLD &&
      height < PhysicsConfig.GROUND_CONTACT_HEIGHT &&
      this.touchedGround
    ) {
      if (!this.landed) {
        this.landed = true;
        this.body.setLinearVelocity(BABYLON.Vector3.Zero());
        this.body.setAngularVelocity(BABYLON.Vector3.Zero());
        return "fullLand";
      }
    }

    if (height > PhysicsConfig.AIRBORNE_HEIGHT && this.touchedGround) {
      this.touchedGround = false;
    }

    return null;
  }

  isAirborne() {
    return this.getHeight() > PhysicsConfig.AIRBORNE_HEIGHT;
  }

  isLanded() {
    return this.landed;
  }

  // === CHARACTER METHODS ===
  async loadFaceTextures() {
    if (this.scene && this.scene.meshes) {
      this.faceMesh = this.scene.meshes.find(
        (m) => m.name && m.name.toLowerCase().includes("face"),
      );
    }

    if (!this.faceMesh) {
      return;
    }

    this.faceMaterial = this.faceMesh.material;

    const textureMap = {
      default: null,
      hit: "grimace.png",
      ascending: "elated.png",
      descending: "woah.png",
      collision: "o.png",
    };

    for (const [name, filename] of Object.entries(textureMap)) {
      if (!filename) continue;
      try {
        const tex = new BABYLON.Texture(
          `./assets/faces/${filename}`,
          this.scene,
          false,
          false,
          BABYLON.Texture.TRILINEAR_SAMPLINGMODE,
        );
        tex.hasAlpha = true;
        this.faceTextures[name] = tex;
      } catch (e) {
        // Texture failed to load, continue
      }
    }

    if (this.faceMaterial) {
      if (this.faceMaterial.albedoTexture) {
        this.faceTextures["default"] = this.faceMaterial.albedoTexture;
      } else if (this.faceMaterial.diffuseTexture) {
        this.faceTextures["default"] = this.faceMaterial.diffuseTexture;
      }
    }
  }

  initializeEyelids() {
    if (!this.scene || !this.scene.meshes) return;

    // Find the eyelids mesh
    this.eyelidsMesh = this.scene.meshes.find(
      (m) => m.name && m.name.toLowerCase().includes("eyelid"),
    );

    if (this.eyelidsMesh && this.eyelidsMesh.morphTargetManager) {
      // Schedule first blink
      this.scheduleNextBlink();
    }
  }

  scheduleNextBlink() {
    this.nextBlinkTime =
      CONFIG.BLINKING.MIN_INTERVAL_MS +
      Math.random() *
        (CONFIG.BLINKING.MAX_INTERVAL_MS - CONFIG.BLINKING.MIN_INTERVAL_MS);
    this.blinkTimer = 0;
  }

  initializeEyes(skeleton) {
    if (!skeleton || skeleton.bones.length === 0) return;

    // Find eye bones
    const boneL = skeleton.bones.find(
      (b) => b.name && b.name.toLowerCase().includes("eye.l"),
    );
    const boneR = skeleton.bones.find(
      (b) => b.name && b.name.toLowerCase().includes("eye.r"),
    );

    if (boneL) {
      this.eyeL = boneL.getTransformNode?.() || boneL;
      this.eyeLRest = this.eyeL?.rotationQuaternion?.clone?.() ?? null;
    }

    if (boneR) {
      this.eyeR = boneR.getTransformNode?.() || boneR;
      this.eyeRRest = this.eyeR?.rotationQuaternion?.clone?.() ?? null;
    }
  }

  updateEyeGaze(cameraPosition, dt) {
    if (!this.eyeL || !this.eyeR) return;
    if (!this.eyeLRest || !this.eyeRRest) return;

    // Calculate direction from character to camera
    const charPos = this.getPosition();
    const dirToCamera = cameraPosition.subtract(charPos);
    dirToCamera.normalize();

    // Clamp gaze direction to eye rotation limits
    // Extract yaw (left/right) and pitch (up/down) from direction
    let targetYaw = Math.atan2(dirToCamera.x, dirToCamera.z);
    let targetPitch = -Math.asin(dirToCamera.y);

    // Clamp to max angles
    targetYaw = Math.max(
      -CONFIG.EYES.MAX_YAW,
      Math.min(CONFIG.EYES.MAX_YAW, targetYaw),
    );
    targetPitch = Math.max(
      -CONFIG.EYES.MAX_PITCH,
      Math.min(CONFIG.EYES.MAX_PITCH, targetPitch),
    );

    // Smooth interpolation
    const f = 1 - Math.exp(-CONFIG.EYES.LERP_SPEED * dt);
    this.eyeYaw += (targetYaw - this.eyeYaw) * f;
    this.eyePitch += (targetPitch - this.eyePitch) * f;

    // Create gaze quaternion from euler angles
    const gazeQ = BABYLON.Quaternion.FromEulerAngles(
      this.eyePitch,
      this.eyeYaw,
      0,
    );

    // Apply gaze by multiplying with rest pose
    if (this.eyeL && this.eyeLRest) {
      this.eyeL.rotationQuaternion = gazeQ.multiply(this.eyeLRest);
    }
    if (this.eyeR && this.eyeRRest) {
      this.eyeR.rotationQuaternion = gazeQ.multiply(this.eyeRRest);
    }
  }

  updateBlinking(dt) {
    if (!this.eyelidsMesh || !this.eyelidsMesh.morphTargetManager) return;

    const morphTargetManager = this.eyelidsMesh.morphTargetManager;

    // Get number of morph targets from _targets array
    const numMorphs = morphTargetManager._targets?.length ?? 0;

    if (numMorphs === 0) {
      return;
    }

    // Find the "Closed" shape key by checking _targets directly
    let closedMorphIndex = -1;
    if (morphTargetManager._targets) {
      for (let i = 0; i < morphTargetManager._targets.length; i++) {
        const target = morphTargetManager._targets[i];
        const targetName = (target?.name || target?.id || "").toLowerCase();
        if (
          targetName.includes("closed") ||
          targetName.includes("blink") ||
          targetName.includes("eyelid")
        ) {
          closedMorphIndex = i;
          break;
        }
      }
    }

    if (closedMorphIndex === -1) return;

    this.blinkTimer += dt * 1000; // Convert to milliseconds

    const closeDuration = CONFIG.BLINKING.BLINK_CLOSE_DURATION_MS;
    const holdDuration = CONFIG.BLINKING.BLINK_HOLD_DURATION_MS;
    const openDuration = CONFIG.BLINKING.BLINK_OPEN_DURATION_MS;

    // Check if it's time to start blinking
    if (this.blinkTimer >= this.nextBlinkTime && this.blinkState === "open") {
      this.blinkState = "closing";
      this.blinkTimer = 0;
    }

    // Update morph target influence based on blink state
    let morphInfluence = 0;

    if (this.blinkState === "closing") {
      // Animate from 0 to 1 over closeDuration
      morphInfluence = Math.min(this.blinkTimer / closeDuration, 1);
      if (this.blinkTimer >= closeDuration) {
        this.blinkState = "closed";
        this.blinkTimer = 0;
      }
    } else if (this.blinkState === "closed") {
      // Stay fully closed
      morphInfluence = 1;
      if (this.blinkTimer >= holdDuration) {
        this.blinkState = "opening";
        this.blinkTimer = 0;
      }
    } else if (this.blinkState === "opening") {
      // Animate from 1 to 0 over openDuration
      morphInfluence = 1 - Math.min(this.blinkTimer / openDuration, 1);
      if (this.blinkTimer >= openDuration) {
        this.blinkState = "open";
        this.blinkTimer = 0;
        this.scheduleNextBlink();
      }
    }

    // Apply morph target influence directly to the target
    const target = morphTargetManager._targets[closedMorphIndex];
    if (target) {
      target.influence = morphInfluence;
    }
  }

  setFace(name, duration = 0) {
    if (this.currentFace === name) return;
    if (!this.faceMaterial || !this.faceTextures[name]) return;

    this.currentFace = name;
    const tex = this.faceTextures[name];

    if (this.faceMaterial.albedoTexture !== undefined) {
      this.faceMaterial.albedoTexture = tex;
    } else if (this.faceMaterial.diffuseTexture) {
      this.faceMaterial.diffuseTexture = tex;
    }

    if (duration > 0) {
      this.faceTransitionTimer = duration;
      this.nextFace = "default";
    } else {
      this.faceTransitionTimer = 0;
      this.nextFace = null;
    }
  }

  startSpinTransition() {
    this.spinTransitionActive = true;
    this.spinTransitionTimer = 0;
  }

  updateFaces(dt) {
    if (this.spinTransitionActive) {
      this.spinTransitionTimer += dt;
      if (this.spinTransitionTimer >= this.spinTransitionDuration) {
        this.spinTransitionActive = false;
        this.spinTransitionTimer = 0;
      }
    }

    if (this.faceTransitionTimer > 0) {
      this.faceTransitionTimer -= dt;
      if (this.faceTransitionTimer <= 0 && this.nextFace) {
        this.setFace(this.nextFace, 0);
      }
    }
  }

  animateSpin(spinAxis, spinAmount) {
    if (!this.spinBone) return;
    const spinSpeed = spinAmount * PhysicsConfig.SPIN_ANIMATION_SPEED;
    this.spinBone.rotate(spinAxis, spinSpeed, BABYLON.Space.LOCAL);
  }

  hasSpinBone() {
    return this.spinBone !== null;
  }

  // === ROTATION METHODS ===
  setFacingAim(aimDirection) {
    // Face toward aim direction
    this.targetRotation = aimDirection + Math.PI;
    this.facingAimDirection = true;
  }

  setFacingCamera(cameraPosition) {
    // Face toward camera position
    const charPos = this.getPosition();
    const dirToCamera = cameraPosition.subtract(charPos);
    this.targetRotation = Math.atan2(dirToCamera.x, dirToCamera.z);
    this.facingAimDirection = false;
  }

  updateRotation(lerpSpeed = 0.1) {
    const currentRot = this.mesh.rotation.y;
    const lerpedRot = BABYLON.Scalar.Lerp(
      currentRot,
      this.targetRotation,
      lerpSpeed,
    );
    this.mesh.rotation.y = lerpedRot;
  }

  // === GENERAL METHODS ===
  reset() {
    this.mesh.position = this.startPosition.clone();
    this.mesh.rotation = BABYLON.Vector3.Zero();
    this.body.setLinearVelocity(BABYLON.Vector3.Zero());
    this.body.setAngularVelocity(BABYLON.Vector3.Zero());
    this.landed = true;
    this.touchedGround = false;
    this.pendingSpinAmount = 0;
    this.pendingSpinAxis = BABYLON.Vector3.Zero();
    this.targetRotation = 0;
    this.facingAimDirection = false;
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// CAMERA & VISUALIZATION
// ═════════════════════════════════════════════════════════════════════════════

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

    this.shotStartPosition = null;
    this.viewMode = CameraViewMode.PLAY;
    this.cameraAngle = 0;
    this.targetCameraAngle = 0;
    this.cameraAngleLerpSpeed = CONFIG.CAMERA.ANGLE_LERP_SPEED;

    this.configure();
  }

  configure() {
    this.camera.fov = CONFIG.CAMERA.FOV_PLAY;
    this.camera.minZ = 0.01; // Allow rendering objects very close to camera
    this.camera.maxZ = 1000; // Limit far clip to preserve depth-buffer precision
    this.camera.inertia = 0;
    this.camera.angularSensibility = 0;
    this.camera.keysUp = [];
    this.camera.keysDown = [];
    this.camera.keysLeft = [];
    this.camera.keysRight = [];
    this.camera.wheelPrecision = 0;
  }

  setShotStartPosition(position) {
    // Called when ball is hit, to frame from start to landing
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
      Math.max(8, dist * CONFIG.FOLLOW_CAMERA.FULL_SHOT_VIEW_SCALE_X),
      Math.max(12, dist * CONFIG.FOLLOW_CAMERA.FULL_SHOT_VIEW_SCALE_Y),
      Math.max(20, dist * CONFIG.FOLLOW_CAMERA.FULL_SHOT_VIEW_SCALE_Z),
      1,
      -Math.max(35, dist * CONFIG.FOLLOW_CAMERA.FULL_SHOT_VIEW_SCALE_LOOK_Z),
      mid,
    );
  }

  setFullShotView() {
    // Backward-compatible alias while we transition naming.
    this.setShotReviewView();
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
    const fPos = 1 - Math.exp(-CONFIG.CAMERA.POSITION_LERP_SPEED * 60 * dt);

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

    const newPosition = new BABYLON.Vector3(
      referencePoint.x + offsetX,
      referencePoint.y + this.offsetY,
      referencePoint.z + offsetZ,
    );

    // Clamp camera distance in PLAY view mode
    if (this.viewMode === CameraViewMode.PLAY) {
      const distFromRef = BABYLON.Vector3.Distance(
        new BABYLON.Vector3(newPosition.x, referencePoint.y, newPosition.z),
        referencePoint,
      );
      if (distFromRef > CONFIG.FOLLOW_CAMERA.PLAY_VIEW_MAX_DISTANCE) {
        const direction = new BABYLON.Vector3(
          newPosition.x - referencePoint.x,
          0,
          newPosition.z - referencePoint.z,
        ).normalize();
        newPosition.x =
          referencePoint.x +
          direction.x * CONFIG.FOLLOW_CAMERA.PLAY_VIEW_MAX_DISTANCE;
        newPosition.z =
          referencePoint.z +
          direction.z * CONFIG.FOLLOW_CAMERA.PLAY_VIEW_MAX_DISTANCE;
      }
    }

    this.lastPosition = BABYLON.Vector3.Lerp(
      this.lastPosition,
      newPosition,
      fPos,
    );
    this.camera.position = this.lastPosition;

    const { x: lookX, z: lookZ } = Utils.rotate2D(
      0,
      this.lookOffsetZ,
      this.cameraAngle,
    );
    const lookTarget = new BABYLON.Vector3(
      referencePoint.x + lookX,
      referencePoint.y + this.lookOffsetY,
      referencePoint.z + lookZ,
    );
    this.camera.setTarget(lookTarget);
  }
}

// ─── GRASS SYSTEM ──────────────────────────────────────────────────────────
// Manages grass blades with periodic wind-like animations.

class GrassSystem {
  constructor(scene, game = null) {
    this.scene = scene;
    this.game = game;
    this.grassFrames = [];
    this.grassBlades = [];
    this.baseBlades = [];
    this.ballPosition = new BABYLON.Vector3(0, 0, 0);
    this.grassViewRadius = CONFIG.GRASS.VIEW_RADIUS;
    this.lastUpdatePos = new BABYLON.Vector3(0, 0, 0);
    this.updateThreshold = CONFIG.GRASS.UPDATE_THRESHOLD;

    // Animation state
    this.animationTimer = 0;
    this.animationInterval = 1.0; // 1 second between new animations
    this.bladeAnimations = new Map(); // blade -> { time, duration }
  }

  async loadFrames(frameCount = 5) {
    for (let i = 1; i <= frameCount; i++) {
      const texture = new BABYLON.Texture(
        `assets/grass/grass${i}.png`,
        this.scene,
      );
      texture.wrapU = BABYLON.Texture.CLAMP_ADDRESSMODE;
      texture.wrapV = BABYLON.Texture.CLAMP_ADDRESSMODE;
      texture.hasAlpha = true;
      this.grassFrames.push(texture);

      // Create base blade with this frame's material
      const mat = Utils.createMaterial(
        `grassMaterial_${i}`,
        this.scene,
        new BABYLON.Color3(1, 1, 1),
      );
      mat.specularColor = new BABYLON.Color3(0, 0, 0);
      mat.specularPower = 1;
      mat.backFaceCulling = false;
      mat.alphaMode = BABYLON.Engine.ALPHA_BLEND;
      mat.diffuseTexture = texture;

      const blade = BABYLON.MeshBuilder.CreatePlane(
        `grassBladeBase_${i}`,
        { width: 0.4, height: 1.2 },
        this.scene,
      );
      blade.position.y = 0.6;
      blade.billboardMode = BABYLON.Mesh.BILLBOARDMODE_ALL;
      blade.material = mat;
      this.baseBlades.push(blade);
    }
  }

  createGrassBlade(position) {
    // Randomly select which base blade to instance from
    const baseIndex = Math.floor(Math.random() * this.baseBlades.length);
    const instance = this.baseBlades[baseIndex].createInstance(
      `grassBlade_${this.grassBlades.length}`,
    );
    instance.position = position.clone();
    instance.position.y = 0.6;
    instance.billboardMode = CONFIG.GRASS.BILLBOARD_MODE;
    this.grassBlades.push(instance);
    return instance;
  }

  scatter(groundSize = 200, density = 5, greenPositions = []) {
    // Scatter grass blades across terrain, avoiding greens
    const greenRadius = 30;
    const bladeCount = Math.floor((groundSize * groundSize) / 20); // ~3000 blades
    const clumpSize = 8;
    const clumpCount = Math.ceil(bladeCount / clumpSize);

    for (let c = 0; c < clumpCount; c++) {
      const clumpCenterX = (Math.random() - 0.5) * groundSize;
      const clumpCenterZ = (Math.random() - 0.5) * groundSize;

      let tooCloseToGreen = false;
      for (const greenPos of greenPositions) {
        const dist = Math.sqrt(
          (clumpCenterX - greenPos.x) ** 2 + (clumpCenterZ - greenPos.z) ** 2,
        );
        if (dist < greenRadius * 1.5) {
          tooCloseToGreen = true;
          break;
        }
      }

      if (tooCloseToGreen) continue;

      for (let i = 0; i < clumpSize; i++) {
        const angle = Math.random() * Math.PI * 2;
        const radius = Math.abs(Math.random() + Math.random()) * 2;
        const x = clumpCenterX + Math.cos(angle) * radius;
        const z = clumpCenterZ + Math.sin(angle) * radius;

        this.createGrassBlade(new BABYLON.Vector3(x, 0, z));
      }
    }
  }

  scatterGreenGrass(greenPositions = []) {
    // Add small, dense grass on the greens
    const greenRadius = 30;
    const smallScale = 0.25;

    for (const greenPos of greenPositions) {
      const bladesPerGreen = 80;

      for (let i = 0; i < bladesPerGreen; i++) {
        const angle = Math.random() * Math.PI * 2;
        const radius = Math.random() * greenRadius * 0.9;
        const x = greenPos.x + Math.cos(angle) * radius;
        const z = greenPos.z + Math.sin(angle) * radius;

        const instance = this.createGrassBlade(new BABYLON.Vector3(x, 0, z));
        instance.scaling = new BABYLON.Vector3(
          smallScale,
          smallScale,
          smallScale,
        );
      }
    }
  }

  updateAnimations(deltaTime) {
    // Early exit if no active animations
    if (this.bladeAnimations.size === 0) {
      this.animationTimer += deltaTime;
      if (this.animationTimer < this.animationInterval) return;
      this.animationTimer = 0;
      this.startRandomAnimation();
      return;
    }

    this.animationTimer += deltaTime;

    // Periodically start new blade animations
    if (this.animationTimer >= this.animationInterval) {
      this.animationTimer = 0;
      this.startRandomAnimation();
    }

    // Update active animations
    const finishedBlades = [];
    for (const [blade, animState] of this.bladeAnimations) {
      animState.time += deltaTime;
      const progress = Math.min(animState.time / animState.duration, 1);

      // Ping-pong through frames: 0,1,2,3,4,3,2,1 (no repeat of 0)
      const totalFrames = this.grassFrames.length * 2 - 2;
      const normalizedPos = progress * totalFrames;

      let frameIndex;
      if (normalizedPos <= this.grassFrames.length - 1) {
        frameIndex = Math.floor(normalizedPos);
      } else {
        frameIndex = Math.max(1, Math.floor(totalFrames - normalizedPos));
      }

      // Apply frame by swapping texture (instances can't change material, only properties)
      if (blade.material) {
        blade.material.diffuseTexture = this.grassFrames[frameIndex];
      }

      if (progress >= 1) {
        finishedBlades.push(blade);
      }
    }

    // Clean up finished animations and set to random frame
    for (const blade of finishedBlades) {
      const randomFrameIdx = Math.floor(
        Math.random() * this.grassFrames.length,
      );
      if (blade.material) {
        blade.material.diffuseTexture = this.grassFrames[randomFrameIdx];
      }
      this.bladeAnimations.delete(blade);
    }
  }

  startRandomAnimation() {
    // Pick random blade (more efficient than filtering all blades)
    const attempts = 5;
    for (let i = 0; i < attempts; i++) {
      const randomIdx = Math.floor(Math.random() * this.grassBlades.length);
      const blade = this.grassBlades[randomIdx];

      if (blade.isVisible && !this.bladeAnimations.has(blade)) {
        this.bladeAnimations.set(blade, {
          time: 0,
          duration: 2.0 + Math.random() * 1.0,
        });
        return;
      }
    }
  }

  update(deltaTime) {
    // Hide grass in overview mode
    if (this.game?.camera?.overviewOrbiting) {
      for (const blade of this.grassBlades) {
        blade.isVisible = false;
      }
      return;
    }

    // Update animations
    this.updateAnimations(deltaTime);

    // Only recull when ball moves significantly
    const moved = BABYLON.Vector3.Distance(
      this.ballPosition,
      this.lastUpdatePos,
    );

    if (moved < this.updateThreshold) {
      return; // Skip expensive distance checks if ball barely moved
    }

    this.lastUpdatePos.copyFrom(this.ballPosition);
    const radiusSq = this.grassViewRadius * this.grassViewRadius;

    // Cull grass instances based on distance from ball
    for (const blade of this.grassBlades) {
      const dx = blade.position.x - this.ballPosition.x;
      const dz = blade.position.z - this.ballPosition.z;
      const distSq = dx * dx + dz * dz;
      blade.isVisible = distSq < radiusSq;
    }
  }

  dispose() {
    // Dispose all instances
    for (const blade of this.grassBlades) {
      blade.dispose();
    }
    this.grassBlades = [];

    // Dispose all base blades
    for (const baseBlade of this.baseBlades) {
      baseBlade.dispose();
    }
    this.baseBlades = [];

    // Clear animation tracking
    this.bladeAnimations.clear();
    this.animatingBlades.clear();
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// INPUT & USER INTERFACE
// ═════════════════════════════════════════════════════════════════════════════

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
    const parent = this.renderCanvas.parentElement;
    if (!parent) return;
    if (window.getComputedStyle(parent).position === "static") {
      parent.style.position = "relative";
    }

    this.overlayCanvas.style.position = "absolute";
    this.overlayCanvas.style.left = "0";
    this.overlayCanvas.style.top = "0";
    this.overlayCanvas.style.width = "100%";
    this.overlayCanvas.style.height = "100%";
    this.overlayCanvas.style.pointerEvents = "none";
    this.overlayCanvas.style.zIndex = "10";
    parent.appendChild(this.overlayCanvas);
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
    const headLen = Math.max(10, Math.min(18, len * 0.22));
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
      const angleError = Math.abs(Math.atan2(local.x, Math.max(0.001, depth)));
      const isAimed =
        depth > 0 && angleError <= CONFIG.SWIPE_OVERLAY.AIM_SELECTION_ANGLE_RAD;
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

  predictLandingRangeForStrength(strength, dt, linearDamping, gAbs) {
    const initialForwardVel =
      ((PhysicsConfig.HIT_FORWARD_FORCE * strength) / PhysicsConfig.BALL_MASS) *
      dt;
    const initialUpVel =
      ((PhysicsConfig.HIT_UPWARD_FORCE * strength) / PhysicsConfig.BALL_MASS) *
      dt;

    let vx = initialForwardVel;
    let vy = initialUpVel;
    let y = 0;
    let x = 0;

    for (let i = 0; i < 600; i++) {
      vy += (-gAbs - linearDamping * vy) * dt;
      vx += -linearDamping * vx * dt;
      y += vy * dt;
      x += vx * dt;

      if (i > 1 && y <= 0) break;
    }

    return Math.max(0, x);
  }

  solveSwipeStrengthForDistance(worldDistance, dt, linearDamping, gAbs) {
    const minStrength =
      CONFIG.SWIPE_OVERLAY.MIN_FORWARD_FORCE / PhysicsConfig.HIT_FORWARD_FORCE;
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
      );
      if (predictedRange < worldDistance) {
        low = mid;
      } else {
        high = mid;
      }
    }

    return Math.max(minStrength, Math.min(maxStrength, high));
  }

  buildIdealSwipeVector(best, aimedDirection, swipeStrength) {
    const desiredForwardForce = PhysicsConfig.HIT_FORWARD_FORCE * swipeStrength;
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

    deltaX = Math.max(-(swipeLen - 1), Math.min(swipeLen - 1, deltaX));
    let deltaY = -Math.sqrt(Math.max(1, swipeLen * swipeLen - deltaX * deltaX));

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
    const swipeStrength = this.solveSwipeStrengthForDistance(
      best.worldDistance,
      dt,
      linearDamping,
      gAbs,
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
    window.addEventListener("keydown", (e) => this.handleKeyDown(e));
  }

  handlePointerDown(event) {
    this.pointerActive = true;
    this.touchStartX = event.clientX;
    this.touchStartY = event.clientY;
    this.touchStartTime = Date.now();
    this.game.justTransitioned = false; // Reset transition guard on new pointer down

    // In aim mode, don't trigger hit/spin, let orbit controls handle it
    if (this.isAimMode()) {
      return;
    }

    if (this.isShotReviewMode() && this.golfBall.isLanded()) {
      this.overviewOrbiting = true;
      this.lastPointerX = event.clientX;
      this.clearInputPreview();
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

      if (
        this.golfBall.isLanded() &&
        distance < PhysicsConfig.MIN_SWIPE_DISTANCE
      ) {
        this.eventManager.emit("input:reset");
      }
      return;
    }

    if (
      this.golfBall.isLanded() &&
      distance < PhysicsConfig.MIN_SWIPE_DISTANCE
    ) {
      this.eventManager.emit("input:reset");
    } else if (
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

  handleKeyDown(event) {
    if (event.code === "Space") {
      this.eventManager.emit("input:reset");
    }
  }
}

// ─── UNIFIED CIRCLE UI MANAGER ──────────────────────────────────────────────

class CircleUIManager {
  constructor() {
    this.circles = {
      topLeft: null, // Stats (play mode)
      topRight: null, // Compass
      bottomLeft: null, // Power indicator
      bottomRight: null, // Club selector (aim mode)
    };
    this.clubButtonsContainer = null; // Container for club +/- buttons
    this.baseSize = 150; // Base circle size in px
    this.createAllCircles();
  }

  createAllCircles() {
    // Remove any existing circles
    Object.values(this.circles).forEach((circle) => {
      if (circle) circle.remove();
    });

    // Build each circle
    this.buildStatsCircle();
    this.buildCompassCircle();
    this.buildPowerCircle();
    this.buildClubCircle();
  }

  /**
   * Build the stats circle (top-left) showing yardage to pin
   */
  buildStatsCircle() {
    const scale = CONFIG.SCREEN.UI_SCALE;
    const size = this.baseSize * scale;
    const margin = 15 * scale;
    const borderWidth = 6 * scale;
    const borderColor = PALETTE.GREEN_DARK;
    const bgColor = PALETTE.GREEN_LIGHT;
    const shadow = "drop-shadow(0 2px 8px rgba(0,0,0,0.8))";

    this.circles.topLeft = document.createElement("div");
    this.circles.topLeft.id = "circleStats";
    this.circles.topLeft.style.cssText = `position:absolute;top:${margin}px;left:${margin}px;width:${size}px;height:${size}px;background:${bgColor};border:${borderWidth}px solid ${borderColor};border-radius:50%;z-index:1500;display:flex;flex-direction:column;align-items:center;justify-content:center;filter:${shadow};pointer-events:auto;`;
    this.circles.topLeft.innerHTML = `
      <div style="position:relative;display:flex;flex-direction:column;align-items:center;justify-content:center;color:white;font-family:monospace;text-align:center;">
        <div style="position:relative;width:${112 * scale}px;height:${88 * scale}px;margin-bottom:${4 * scale}px;">
          <img id="statsFlagImg" src="assets/flag/flag.png" style="width:100%;height:100%;object-fit:contain;display:block;">
          <div id="statsPinNumber" style="position:absolute;top:20%;left:15%;color:${PALETTE.YELLOW};font-weight:bold;font-size:${36 * scale}px;text-shadow:0 0 4px rgba(0,0,0,0.9),1px 1px 2px rgba(0,0,0,1);">1</div>
        </div>
        <div style="color:${PALETTE.YELLOW};font-weight:bold;font-size:${28 * scale}px;"><span id="circleYardage">0</span>'</div>
      </div>
    `;
    document.body.appendChild(this.circles.topLeft);
    this._statsFlagImg = document.getElementById("statsFlagImg");
    this._statsPinNumber = document.getElementById("statsPinNumber");
  }

  /**
   * Build the compass circle (top-right) showing wind direction
   */
  buildCompassCircle() {
    const scale = CONFIG.SCREEN.UI_SCALE;
    const size = this.baseSize * scale;
    const margin = 15 * scale;
    const borderColor = PALETTE.GREEN_DARK;
    const bgColor = PALETTE.GREEN_LIGHT;
    const shadow = "drop-shadow(0 2px 8px rgba(0,0,0,0.8))";

    this.circles.topRight = document.createElement("div");
    this.circles.topRight.id = "circleCompass";
    this.circles.topRight.style.cssText = `position:absolute;top:${margin}px;right:${margin}px;display:flex;flex-direction:column;align-items:center;gap:${12 * scale}px;z-index:1500;pointer-events:none;`;

    const compassCircle = document.createElement("div");
    compassCircle.style.cssText = `width:${size}px;height:${size}px;border-radius:50%;background:${bgColor};border:3px solid ${borderColor};display:flex;align-items:center;justify-content:center;filter:drop-shadow(0 2px 8px rgba(0,0,0,0.8));pointer-events:auto;`;
    compassCircle.innerHTML = `
      <svg id="compassSvg" width="${size}" height="${size}" viewBox="0 0 120 120" style="filter:${shadow};pointer-events:auto;user-select:none;">
        <text x="60" y="18" text-anchor="middle" fill="${PALETTE.YELLOW}" font-size="28" font-weight="bold">N</text>
        <text x="102" y="65" text-anchor="middle" fill="${PALETTE.YELLOW}" font-size="28" font-weight="bold">E</text>
        <text x="60" y="108" text-anchor="middle" fill="${PALETTE.YELLOW}" font-size="28" font-weight="bold">S</text>
        <text x="18" y="65" text-anchor="middle" fill="${PALETTE.YELLOW}" font-size="28" font-weight="bold">W</text>
        <circle cx="60" cy="60" r="4" fill="${PALETTE.YELLOW}"/>
        <g id="windArrow">
          <polygon points="60,28 55,48 58,45 58,60 62,60 62,45 65,48" fill="#ff6b6b" stroke="${PALETTE.YELLOW}" stroke-width="1.5"/>
        </g>
      </svg>
    `;
    this.circles.topRight.appendChild(compassCircle);

    const windSpeedDisplay = document.createElement("div");
    windSpeedDisplay.id = "windSpeedDisplay";
    windSpeedDisplay.style.cssText = `color:${PALETTE.YELLOW};font-size:${32 * scale}px;font-weight:bold;font-family:monospace;pointer-events:auto;`;
    windSpeedDisplay.textContent = "0 mph";
    this.circles.topRight.appendChild(windSpeedDisplay);
    document.body.appendChild(this.circles.topRight);
  }

  /**
   * Build the power circle (bottom-left) showing swing power
   */
  buildPowerCircle() {
    const scale = CONFIG.SCREEN.UI_SCALE;
    const size = this.baseSize * scale;
    const margin = 15 * scale;
    const borderWidth = 6 * scale;
    const borderColor = PALETTE.GREEN_DARK;
    const bgColor = PALETTE.GREEN_LIGHT;
    const shadow = "drop-shadow(0 2px 8px rgba(0,0,0,0.8))";

    this.circles.bottomLeft = document.createElement("div");
    this.circles.bottomLeft.id = "circlePower";
    this.circles.bottomLeft.style.cssText = `position:absolute;bottom:${margin}px;left:${margin}px;width:${size}px;height:${size}px;background:${bgColor};border:${borderWidth}px solid ${borderColor};border-radius:50%;z-index:1500;display:flex;flex-direction:column;align-items:center;justify-content:center;filter:${shadow};pointer-events:auto;`;

    // SVG arc fill: circumference of circle with r=(size/2 - stroke/2 - padding)
    const r = Math.round(size / 2 - borderWidth - 8 * scale);
    const circ = Math.round(2 * Math.PI * r);
    const cx = Math.round(size / 2);
    const cy = Math.round(size / 2);
    const strokeW = Math.round(8 * scale);

    this.circles.bottomLeft.innerHTML = `
      <svg id="powerSvg" width="${size}" height="${size}" style="position:absolute;top:0;left:0;transform:rotate(90deg);">
        <circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="rgba(255,255,255,0.15)" stroke-width="${strokeW}"/>
        <circle id="powerArc" cx="${cx}" cy="${cy}" r="${r}" fill="none"
          stroke="${PALETTE.YELLOW}" stroke-width="${strokeW}" stroke-linecap="round"
          stroke-dasharray="${circ}" stroke-dashoffset="${circ}"
          style="transition:stroke-dashoffset 0.1s ease-out,stroke 0.1s ease-out;"/>
      </svg>
      <div style="display:flex;flex-direction:column;align-items:center;justify-content:center;gap:${2 * scale}px;pointer-events:none;">
        <div style="font-size:${44 * scale}px;line-height:1;">💪</div>
        <div style="color:${PALETTE.YELLOW};font-weight:bold;font-family:monospace;font-size:${26 * scale}px;text-shadow:0 1px 4px rgba(0,0,0,0.8);"><span id="powerPercent">0</span>%</div>
      </div>
    `;
    document.body.appendChild(this.circles.bottomLeft);
    this.powerPercent = document.getElementById("powerPercent");
    this.powerArc = document.getElementById("powerArc");
    this._powerCircumference = circ;
  }

  /**
   * Build the club selector circle (bottom-right) with +/- buttons
   */
  buildClubCircle() {
    const scale = CONFIG.SCREEN.UI_SCALE;
    const size = this.baseSize * scale;
    const margin = 15 * scale;
    const borderWidth = 6 * scale;
    const borderColor = PALETTE.GREEN_DARK;
    const bgColor = PALETTE.GREEN_LIGHT;
    const shadow = "drop-shadow(0 2px 8px rgba(0,0,0,0.8))";

    const clubContainerWrapper = document.createElement("div");
    clubContainerWrapper.id = "clubSelectorWrapper";
    clubContainerWrapper.style.cssText = `position:absolute;bottom:${margin}px;right:${margin}px;z-index:1000;display:flex;flex-direction:column;align-items:center;gap:${12 * scale}px;`;

    const btnSize = 40 * scale;
    const upBtn = document.createElement("button");
    upBtn.id = "clubUp";
    upBtn.textContent = "+";
    upBtn.style.cssText = `width:${btnSize}px;height:${btnSize}px;background:rgba(144,200,150,0.7);color:#fff;border:none;border-radius:50%;cursor:pointer;font-weight:bold;font-size:${24 * scale}px;filter:${shadow};touch-action:manipulation;`;
    clubContainerWrapper.appendChild(upBtn);

    this.circles.bottomRight = document.createElement("div");
    this.circles.bottomRight.id = "circleClub";
    this.circles.bottomRight.style.cssText = `position:relative;width:${size}px;height:${size}px;background:${bgColor};border:${borderWidth}px solid ${borderColor};border-radius:50%;z-index:1000;display:flex;flex-direction:column;align-items:center;justify-content:center;filter:${shadow};`;
    this.circles.bottomRight.innerHTML = `
      <div id="clubSelectorContent" style="display:flex;flex-direction:column;align-items:center;justify-content:center;width:100%;height:100%;gap:${2 * scale}px;color:white;text-shadow:2px 2px 4px rgba(0,0,0,0.8);font-family:monospace;text-align:center;">
        <div style="font-size:${64 * scale}px;">⛳</div>
        <div style="color:${PALETTE.YELLOW};font-weight:bold;font-size:${24 * scale}px;"><span id="clubName">Driver</span></div>
        <div style="color:${PALETTE.YELLOW};margin-top:${4 * scale}px;font-size:${12 * scale}px;font-weight:bold;">~<span id="clubDistance">306</span>'</div>
      </div>
    `;
    clubContainerWrapper.appendChild(this.circles.bottomRight);

    const downBtn = document.createElement("button");
    downBtn.id = "clubDown";
    downBtn.textContent = "−";
    downBtn.style.cssText = `width:${btnSize}px;height:${btnSize}px;background:rgba(200,100,100,0.7);color:#fff;border:none;border-radius:50%;cursor:pointer;font-weight:bold;font-size:${24 * scale}px;filter:${shadow};touch-action:manipulation;`;
    clubContainerWrapper.appendChild(downBtn);

    this.clubButtonsContainer = clubContainerWrapper;
    document.body.appendChild(clubContainerWrapper);

    // Store direct references to club elements AFTER appending to DOM
    this.clubName = document.getElementById("clubName");
    this.clubDistance = document.getElementById("clubDistance");
  }

  // Update stats circle (play mode) - just yardage
  updateStats(speed, spin, height, distance, flagFrame, pinNumber) {
    document.getElementById("circleYardage").textContent = distance.toFixed(0);
    // Sync flag image
    if (this._statsFlagImg) {
      const src =
        flagFrame > 0
          ? `assets/flag/flag-${flagFrame}.png`
          : "assets/flag/flag.png";
      if (this._statsFlagImg.src !== src) this._statsFlagImg.src = src;
    }
    // Show pin number
    if (this._statsPinNumber && pinNumber !== undefined) {
      this._statsPinNumber.textContent = pinNumber;
    }
  }

  // Update power circle
  updatePower(powerPercent) {
    const percent = Math.max(0, Math.min(100, powerPercent));
    if (this.powerPercent) this.powerPercent.textContent = percent.toFixed(0);
    if (this.powerArc && this._powerCircumference) {
      const offset = this._powerCircumference * (1 - percent / 100);
      this.powerArc.style.strokeDashoffset = offset;
      // Arc stays yellow
      this.powerArc.style.stroke = PALETTE.YELLOW;
    }
  }

  // Update club selector circle
  updateClub(clubId, clubName, estimatedDistance) {
    if (this.clubName) this.clubName.textContent = clubName;
    if (this.clubDistance)
      this.clubDistance.textContent = estimatedDistance.toFixed(0);
  }

  // Hide/show circles based on mode
  showStatsCircle() {
    if (this.circles.topLeft) this.circles.topLeft.style.display = "flex";
  }
  hideStatsCircle() {
    if (this.circles.topLeft) this.circles.topLeft.style.display = "none";
  }

  showCompassCircle() {
    if (this.circles.topRight) this.circles.topRight.style.display = "flex";
  }
  hideCompassCircle() {
    if (this.circles.topRight) this.circles.topRight.style.display = "none";
  }

  showPowerCircle() {
    if (this.circles.bottomLeft) this.circles.bottomLeft.style.display = "flex";
  }
  hidePowerCircle() {
    if (this.circles.bottomLeft) this.circles.bottomLeft.style.display = "none";
  }

  showClubCircle() {
    if (this.clubButtonsContainer)
      this.clubButtonsContainer.style.display = "flex";
  }
  hideClubCircle() {
    if (this.clubButtonsContainer)
      this.clubButtonsContainer.style.display = "none";
  }

  // Get SVG compass element (for wind control setup)
  getCompassSvg() {
    return document.getElementById("compassSvg");
  }

  // Get club buttons container for event listeners
  getClubButtons() {
    if (!this.clubButtonsContainer) return null;
    return {
      upBtn: this.clubButtonsContainer.querySelector("#clubUp"),
      downBtn: this.clubButtonsContainer.querySelector("#clubDown"),
    };
  }

  // Clean up
  destroy() {
    Object.values(this.circles).forEach((circle) => {
      if (circle) circle.remove();
    });
    if (this.clubButtonsContainer) this.clubButtonsContainer.remove();
    this.circles = {
      topLeft: null,
      topRight: null,
      bottomLeft: null,
      bottomRight: null,
    };
    this.clubButtonsContainer = null;
  }
}

// ─── UI MANAGER ─────────────────────────────────────────────────────────────

class UIManager {
  constructor(
    golfBall,
    ballStartPosition,
    game = null,
    circleUIManager = null,
  ) {
    this.golfBall = golfBall;
    this.ballStartPosition = ballStartPosition;
    this.game = game;
    this.circleUIManager = circleUIManager;
  }

  update() {
    const speed = this.golfBall.getSpeed() * UNITS.MS_TO_MPH;
    const height = Math.max(
      0,
      (this.golfBall.getHeight() - 1) * UNITS.M_TO_FEET,
    );
    const distanceToPin = this.getDistanceToNearestPin() * UNITS.M_TO_YARDS;
    const spin = this.golfBall.pendingSpinAmount * 100;

    const pinManager = this.game?.scene?.pinManager;
    const flagFrame = pinManager?.currentFlagFrame ?? 0;
    const targetPin = this.getTargetPin();
    const pinNumber = targetPin !== null ? targetPin + 1 : 1;

    if (this.circleUIManager) {
      this.circleUIManager.updateStats(
        speed,
        spin,
        height,
        distanceToPin,
        flagFrame,
        pinNumber,
      );
    } else {
      // Fallback for old DOM elements (backward compatibility)
      const speedEl = document.getElementById("circleSpeed");
      if (speedEl) speedEl.textContent = speed.toFixed(0);
      const spinEl = document.getElementById("circleSpin");
      if (spinEl) spinEl.textContent = spin.toFixed(0);
      const heightEl = document.getElementById("circleHeight");
      if (heightEl) heightEl.textContent = height.toFixed(0);
      const distanceEl = document.getElementById("circleDistance");
      if (distanceEl) distanceEl.textContent = distanceToPin.toFixed(0);
    }
  }

  getDistanceToNearestPin() {
    if (!this.game?.scene?.pinManager?.pins?.length) {
      return 0;
    }

    const ballPos = this.golfBall.getPosition();
    const pinManager = this.game.scene.pinManager;

    // During AIM state, find pin most aligned with aim direction
    if (this.game.gameState === GameState.AIM && this.game.aimView) {
      const { distance, pin } = pinManager.getTargetPin(
        ballPos,
        this.game.aimView.cameraRotation,
      );
      if (pin) return distance;
    }

    // During PLAY state, show nearest pin
    const nearestPin = pinManager.pins.reduce((nearest, pin) => {
      const dist = BABYLON.Vector3.Distance(ballPos, pin.mesh.position);
      return !nearest || dist < nearest.dist ? { dist, pin } : nearest;
    }, null);

    return nearestPin ? nearestPin.dist : 0;
  }

  getTargetPin() {
    if (!this.game?.scene?.pinManager?.pins?.length) return null;
    const pinManager = this.game.scene.pinManager;
    const ballPos = this.golfBall.getPosition();

    if (this.game.gameState === GameState.AIM && this.game.aimView) {
      const { index } = pinManager.getTargetPin(
        ballPos,
        this.game.aimView.cameraRotation,
      );
      if (index !== -1) return index;
    }

    // Fallback: nearest pin
    const pins = pinManager.pins;
    let nearestIdx = 0,
      nearestDist = Infinity;
    for (let i = 0; i < pins.length; i++) {
      const dist = BABYLON.Vector3.Distance(ballPos, pins[i].mesh.position);
      if (dist < nearestDist) {
        nearestDist = dist;
        nearestIdx = i;
      }
    }
    return nearestIdx;
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// GAME MECHANICS & EFFECTS
// ═════════════════════════════════════════════════════════════════════════════

// ─── PIN MANAGER ─────────────────────────────────────────────────────────────

class PinManager {
  constructor(scene, golfBall, eventManager = null) {
    this.scene = scene;
    this.golfBall = golfBall;
    this.eventManager = eventManager || new EventManager();
    this.pins = [];
    this.greens = [];
    this.currentFlagFrame = 0; // shared frame index (0=still, 1-6=animated)
  }

  addPin(position, scene) {
    const cfg = CONFIG.PINS;
    const baseY = position.y + cfg.PIN_Y_OFFSET;

    // ── Pole: black & white stripes using per-segment materials ──
    const STRIPE_COUNT = 8;
    const pole = BABYLON.MeshBuilder.CreateCylinder(
      "pin",
      {
        height: cfg.PIN_HEIGHT,
        diameter: cfg.PIN_DIAMETER,
        segments: 12,
        tessellation: 12,
      },
      scene,
    );
    pole.position = position.clone();
    pole.position.y = baseY;

    // Build a striped texture procedurally on a canvas
    const stripeCanvas = document.createElement("canvas");
    stripeCanvas.width = 4;
    stripeCanvas.height = 256;
    const ctx = stripeCanvas.getContext("2d");
    const stripeH = stripeCanvas.height / STRIPE_COUNT;
    for (let i = 0; i < STRIPE_COUNT; i++) {
      ctx.fillStyle = i % 2 === 0 ? "#ffffff" : "#111111";
      ctx.fillRect(0, i * stripeH, stripeCanvas.width, stripeH);
    }
    const stripeTexture = new BABYLON.DynamicTexture(
      "stripesTex",
      { width: 4, height: 256 },
      scene,
      false,
    );
    stripeTexture.getContext().drawImage(stripeCanvas, 0, 0);
    stripeTexture.update();
    const poleMat = new BABYLON.StandardMaterial("poleMat", scene);
    poleMat.diffuseTexture = stripeTexture;
    poleMat.specularColor = new BABYLON.Color3(0.1, 0.1, 0.1);
    pole.material = poleMat;

    const poleBody = new BABYLON.PhysicsAggregate(
      pole,
      BABYLON.PhysicsShapeType.CYLINDER,
      { mass: 0, friction: 0, restitution: 0.5 },
      scene,
    );

    // ── Flag quad at the top of the pole ──
    // Use a pivot node at the pole top so rotation always pivots from the left edge.
    const flagTopY = baseY + cfg.PIN_HEIGHT / 2;
    const flagPivot = new BABYLON.TransformNode("flagPivot", scene);
    flagPivot.position = new BABYLON.Vector3(
      position.x,
      flagTopY - cfg.FLAG_HEIGHT / 2,
      position.z,
    );

    const flagPlane = BABYLON.MeshBuilder.CreatePlane(
      "flag",
      {
        width: cfg.FLAG_WIDTH,
        height: cfg.FLAG_HEIGHT,
        sideOrientation: BABYLON.Mesh.DOUBLESIDE,
      },
      scene,
    );
    // Parent to pivot; offset so the left edge sits at the pivot (pole center)
    flagPlane.parent = flagPivot;
    flagPlane.position = new BABYLON.Vector3(cfg.FLAG_WIDTH / 2, 0, 0);

    const flagMat = new BABYLON.StandardMaterial("flagMat", scene);
    flagMat.diffuseTexture = new BABYLON.Texture("assets/flag/flag.png", scene);
    flagMat.diffuseTexture.hasAlpha = true;
    flagMat.useAlphaFromDiffuseTexture = true;
    flagMat.transparencyMode = BABYLON.Material.MATERIAL_ALPHATESTANDBLEND;
    flagMat.backFaceCulling = false;
    flagMat.specularColor = new BABYLON.Color3(0, 0, 0);
    flagPlane.material = flagMat;
    flagPlane.billboardMode = BABYLON.Mesh.BILLBOARDMODE_NONE;

    // Preload all flag textures with alpha enabled
    const flagTextures = [
      "assets/flag/flag.png",
      "assets/flag/flag-1.png",
      "assets/flag/flag-2.png",
      "assets/flag/flag-3.png",
      "assets/flag/flag-4.png",
      "assets/flag/flag-5.png",
      "assets/flag/flag-6.png",
    ].map((path) => {
      const t = new BABYLON.Texture(path, scene);
      t.hasAlpha = true;
      t.wrapU = BABYLON.Texture.CLAMP_ADDRESSMODE;
      t.wrapV = BABYLON.Texture.CLAMP_ADDRESSMODE;
      return t;
    });

    // ── Hole in the green ──
    const hole = BABYLON.MeshBuilder.CreateDisc(
      "hole",
      { radius: cfg.HOLE_RADIUS, tessellation: 24 },
      scene,
    );
    hole.position = position.clone();
    hole.position.y = cfg.HOLE_Y_OFFSET;
    hole.rotation.x = Math.PI / 2;
    const holeMat = new BABYLON.StandardMaterial("holeMat", scene);
    holeMat.diffuseColor = new BABYLON.Color3(0, 0, 0);
    holeMat.specularColor = new BABYLON.Color3(0, 0, 0);
    hole.material = holeMat;

    this.pins.push({
      mesh: pole,
      body: poleBody,
      flagMesh: flagPlane,
      flagPivot,
      flagMat,
      flagTextures,
      flagAnimTime: 0,
      flagAnimFrame: 0,
      holePosition: position.clone(),
    });
  }

  addGreen(centerPos, radius, scene) {
    const green = BABYLON.MeshBuilder.CreateDisc(
      "green",
      { radius: radius },
      scene,
    );
    green.position = centerPos.clone();
    green.position.y = CONFIG.PINS.GREEN_Y_OFFSET;
    green.rotation.x = Math.PI / 2;

    const greenMat = Utils.createMaterial(
      `greenMat_${Math.random()}`,
      scene,
      new BABYLON.Color3(0.38, 0.72, 0.18),
      new BABYLON.Color3(0.03, 0.06, 0.01),
    );
    const greenDiffuse = new BABYLON.Texture(
      CONFIG.PINS.GREEN_TEXTURE_PATH,
      scene,
    );
    greenDiffuse.wrapU = greenDiffuse.wrapV = BABYLON.Texture.WRAP_ADDRESSMODE;
    greenDiffuse.uScale = greenDiffuse.vScale = CONFIG.PINS.GREEN_UV_TILING;
    greenMat.diffuseTexture = greenDiffuse;
    const greenNormal = new BABYLON.Texture(
      CONFIG.PINS.GREEN_NORMAL_MAP_PATH,
      scene,
    );
    greenNormal.wrapU = greenNormal.wrapV = BABYLON.Texture.WRAP_ADDRESSMODE;
    greenNormal.uScale = greenNormal.vScale = CONFIG.PINS.GREEN_UV_TILING;
    greenMat.bumpTexture = greenNormal;
    green.material = greenMat;
    green.receiveShadows = true;

    // Create physics body for green at the raised position
    const greenPhysics = new BABYLON.PhysicsAggregate(
      green,
      BABYLON.PhysicsShapeType.MESH,
      { mass: 0, friction: 0.7, restitution: 0.2 },
      scene,
    );

    this.greens.push({ mesh: green, body: greenPhysics });
  }

  updateFlags(wind, dt) {
    const cfg = CONFIG.PINS;
    const windSpeedMs = wind.speed; // m/s
    const windVec = wind.getWindVector();
    // Angle the flag faces into the wind (flag blows away from wind source)
    const windAngle = Math.atan2(windVec.x, windVec.z) - Math.PI / 2;

    for (const pin of this.pins) {
      if (!pin.flagMesh) continue;

      if (windSpeedMs < cfg.FLAG_WIND_THRESHOLD) {
        // Still flag — no animation
        if (pin.flagMat.diffuseTexture !== pin.flagTextures[0]) {
          pin.flagMat.diffuseTexture = pin.flagTextures[0];
        }
        this.currentFlagFrame = 0;
      } else {
        // Animate through frames 1-6; FPS scales linearly from 4 at threshold to 12 at max wind
        const t = Math.min(
          1,
          (windSpeedMs - cfg.FLAG_WIND_THRESHOLD) /
            (CONFIG.WIND.MAX_SPEED - cfg.FLAG_WIND_THRESHOLD),
        );
        const animFps = 4 + t * (12 - 4);
        pin.flagAnimTime += dt * animFps;
        const frameIndex = 1 + (Math.floor(pin.flagAnimTime) % 6);
        if (pin.flagMat.diffuseTexture !== pin.flagTextures[frameIndex]) {
          pin.flagMat.diffuseTexture = pin.flagTextures[frameIndex];
        }
        this.currentFlagFrame = frameIndex;
      }

      // Rotate pivot so flag extends away from the pole in wind direction
      if (pin.flagPivot) pin.flagPivot.rotation.y = windAngle;
    }
  }

  checkHoleSink() {
    const ballPos = this.golfBall.getPosition();
    const ballSpeed = this.golfBall.getSpeed();

    for (const pin of this.pins) {
      const holePos = pin.holePosition;
      if (!holePos) continue;
      const dx = ballPos.x - holePos.x;
      const dz = ballPos.z - holePos.z;
      const horizDist = Math.sqrt(dx * dx + dz * dz);
      const nearGround = ballPos.y < CONFIG.PINS.HOLE_Y_OFFSET + 1.5;

      if (
        horizDist < CONFIG.PINS.HOLE_RADIUS * 0.85 &&
        nearGround &&
        ballSpeed < 6
      ) {
        // Snap ball into hole and kill velocity first
        this.golfBall.body.setLinearVelocity(BABYLON.Vector3.Zero());
        this.golfBall.body.setAngularVelocity(BABYLON.Vector3.Zero());
        this.golfBall.mesh.position.x = holePos.x;
        this.golfBall.mesh.position.z = holePos.z;
        this.golfBall.mesh.position.y = CONFIG.PINS.HOLE_Y_OFFSET - 0.2;
        this.golfBall.landed = true;
        this.eventManager.emit("pin:holesink", holePos);
      }
    }
  }

  checkPinCollisions() {
    const ballPos = this.golfBall.getPosition();
    const ballSpeed = this.golfBall.getSpeed();

    for (const pin of this.pins) {
      const distance = BABYLON.Vector3.Distance(ballPos, pin.mesh.position);

      if (
        distance < CONFIG.PINS.PIN_COLLISION_RADIUS &&
        ballSpeed > CONFIG.PINS.PIN_COLLISION_MIN_SPEED
      ) {
        this.eventManager.emit("pin:hit", pin.mesh.position);

        pin.mesh.scaling.y = CONFIG.PINS.PIN_FLASH_SCALE_Y;
        setTimeout(() => {
          pin.mesh.scaling.y = 1;
        }, CONFIG.PINS.PIN_FLASH_DURATION_MS);
      }
    }
  }

  /**
   * Find the target pin based on ball position and aim direction.
   * Returns the pin most aligned with the aim direction (within 90° cone).
   *
   * @param {BABYLON.Vector3} ballPos - Current ball position
   * @param {number} aimDirection - Aim direction angle (radians)
   * @returns {{pin: Object|null, index: number, distance: number}}
   *          pin: the pin object, index: position in pins array, distance: yardage to pin
   */
  getTargetPin(ballPos, aimDirection) {
    if (!this.pins || this.pins.length === 0) {
      return { pin: null, index: -1, distance: 0 };
    }

    // Convert aim direction to vector (opposite camera direction since ball faces away from camera)
    const aimVec = new BABYLON.Vector3(
      Math.sin(aimDirection + Math.PI),
      0,
      Math.cos(aimDirection + Math.PI),
    );

    let bestPin = null;
    let bestIndex = -1;
    let smallestAngle = Math.PI;

    for (let i = 0; i < this.pins.length; i++) {
      const pin = this.pins[i];
      const pinPos = pin.mesh.position;
      const toPin = pinPos.subtract(ballPos);
      const toPinFlat = toPin.clone();
      toPinFlat.y = 0;

      if (toPinFlat.length() === 0) continue;

      toPinFlat.normalize();

      // Calculate angle between aim direction and pin direction
      const dotProd = BABYLON.Vector3.Dot(aimVec, toPinFlat);
      const angle = Math.acos(Math.max(-1, Math.min(1, dotProd)));

      if (angle < smallestAngle) {
        smallestAngle = angle;
        bestPin = pin;
        bestIndex = i;
      }
    }

    // Return most-aligned pin's distance if within 90° cone (in front)
    if (bestPin && smallestAngle < Math.PI / 2) {
      const distance = BABYLON.Vector3.Distance(ballPos, bestPin.mesh.position);
      return { pin: bestPin, index: bestIndex, distance };
    }

    return { pin: null, index: -1, distance: 0 };
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// COORDINATORS: Split responsibilities from GolfGame
// ═════════════════════════════════════════════════════════════════════════════

// ─── SWING COORDINATOR ───────────────────────────────────────────────────────
/**
 * Coordinates the swing flow: input hit → club animation → ball physics → camera recovery
 */
class SwingCoordinator {
  constructor(game, clubSystem, golfBall, camera, ballTrail) {
    this.game = game;
    this.clubSystem = clubSystem;
    this.golfBall = golfBall;
    this.camera = camera;
    this.ballTrail = ballTrail;
  }

  /**
   * Execute a swing: animate club, apply impulse at contact, recover camera after
   */
  executeSwing(shotDirection, force, deltaX, deltaY) {
    const currentClubId = this.game.aimView?.currentClub ?? 12;
    const club = ClubData.getClub(currentClubId);

    // Reset camera flag before starting swing
    this.game.swingCameraRestored = false;

    // Zoom camera out for swing view
    this.camera.setOffsets(0, 14, 20, 7, 0);

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
          club.maxDistance,
        );
      };

      // After follow-through completes, return camera
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

// ─── CAMERA COORDINATOR ──────────────────────────────────────────────────────
/**
 * Coordinates camera view transitions and state
 */
class CameraCoordinator {
  constructor(camera) {
    this.camera = camera;
  }

  /**
   * Transition to aim mode: reset angle and view
   */
  transitionToAim() {
    this.camera.setCameraAngle(0);
    this.camera.setPlayView();
  }

  /**
   * Transition to play mode: set initial shot position
   */
  transitionToPlay(ballPosition, shotDirection) {
    this.camera.setShotStartPosition(ballPosition);
    this.camera.setCameraAngleImmediate(-shotDirection);
    this.camera.setPlayView();
  }

  /**
   * Transition to shot review (after ball lands)
   */
  transitionToShotReview() {
    this.camera.setShotReviewView();
  }
}

// ─── GAME STATE COORDINATOR ─────────────────────────────────────────────────
/**
 * Coordinates game state transitions, reset logic, and landing detection
 */
class GameStateCoordinator {
  constructor(game) {
    this.game = game;
  }

  /**
   * Transition from AIM to PLAY state (ball is clicked)
   */
  transitionAimToPlay(shotDirection) {
    this.game.aimedDirection = shotDirection;
    this.game.gameState = GameState.PLAY;
    this.game.justTransitioned = true;

    // Disable orbit controls when entering play mode
    if (this.game.aimView) {
      this.game.aimView.removeOrbitControls();
      this.game.aimView.deactivate();
    }

    this.game.golfBall.startSpinTransition();
  }

  /**
   * Handle landing state change: transition to aim mode for next shot
   */
  handleBallLanded() {
    this.game.gameState = GameState.LANDED;
    this.game.justTransitioned = true;
  }

  /**
   * Reset game: clear state, reset ball, re-activate aim view
   */
  resetGame() {
    this.game.golfBall.reset();
    this.game.ballTrail.clear();
    this.game.ballTrail.setVisible(false);
    this.game.gameState = GameState.AIM;
    this.game.golfBallFacingCamera = false;
    this.game.swingCameraRestored = false;

    if (this.game.clubSystem) {
      this.game.clubSystem.resetClubs();
    }

    if (this.game.aimView) {
      this.game.aimView.cameraRotation = 0; // Reset camera to default angle
      this.game.aimView.activate(); // Re-enable orbit controls
    }
  }

  /**
   * Handle hole sink: reset for next hole
   */
  handleHoleSink() {
    this.resetGame();
  }

  /**
   * Handle spin input during play
   */
  applySpin(spinAxis, spinAmount) {
    if (this.game.gameState !== GameState.PLAY) return;
    this.game.golfBall.applySpin(spinAxis, spinAmount);
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// SCENE & GAME ORCHESTRATION
// ═════════════════════════════════════════════════════════════════════════════

// ─── SCENE SETUP ──────────────────────────────────────────────────────────────

class SceneSetup {
  static async createEnvironment(scene) {
    // Try to load environment texture
    let envTexture = null;
    try {
      envTexture = BABYLON.CubeTexture.CreateFromPrefilteredData(
        CONFIG.ENVIRONMENT.ENV_TEXTURE_PATH,
        scene,
      );
      // Enable environment texture for both skybox AND IBL (lighting + reflections)
      if (CONFIG.ENVIRONMENT.SKYBOX_ENABLED && envTexture) {
        const skybox = scene.createDefaultSkybox(
          envTexture,
          true,
          CONFIG.ENVIRONMENT.SKYBOX_SIZE,
          CONFIG.ENVIRONMENT.SKYBOX_PBRBRIGHT,
        );
        // Rotate skybox 180 degrees so sun appears in look direction
        if (skybox) {
          skybox.rotation.y = Math.PI;
        } else {
          console.warn("✗ Skybox object not created or null");
        }
        scene.environmentTexture = envTexture; // Enable IBL for unified lighting
      }
    } catch (err) {
      // Environment texture failed to load, continue with defaults
    }

    // Add ambient light for visibility
    const ambientLight = new BABYLON.HemisphericLight(
      "ambient",
      new BABYLON.Vector3(0, 1, 0),
      scene,
    );
    ambientLight.intensity = CONFIG.LIGHTING.AMBIENT_INTENSITY;
    ambientLight.diffuse = new BABYLON.Color3(1.0, 1.0, 1.0); // neutral white lighting
    ambientLight.groundColor = new BABYLON.Color3(0.25, 0.45, 0.1); // brighter green fill from below

    // Directional sun light (required for shadow casting)
    const sunLight = new BABYLON.DirectionalLight(
      "sun",
      new BABYLON.Vector3(-0.5, -1, -0.5),
      scene,
    );
    sunLight.intensity = CONFIG.LIGHTING.SUN_INTENSITY;
    sunLight.position = new BABYLON.Vector3(100, 200, 100);

    // Shadow generator - store on scene so loadGolfBall/loadCharacter can register casters
    const shadowGenerator = new BABYLON.ShadowGenerator(1024, sunLight);
    shadowGenerator.useBlurExponentialShadowMap = true;
    shadowGenerator.bias = 0.001;
    scene.shadowGenerator = shadowGenerator;

    // Undulating terrain
    this.createUndulatingTerrain(scene);
  }

  static createUndulatingTerrain(scene) {
    const radius = 400; // Disc radius in meters (reduced from 1250 to improve performance)

    // Create cylinder with thin height to act like a disc with collision
    const ground = BABYLON.MeshBuilder.CreateCylinder(
      "undulatedGround",
      {
        height: 0.5, // Thin disc to prevent z-fighting
        diameter: radius * 2,
        tessellation: 32, // Reduced tessellation for performance
      },
      scene,
    );

    // Tiled terrain material using repeatable diffuse + normal textures
    const groundMat = Utils.createMaterial(
      "undulatedMat",
      scene,
      new BABYLON.Color3(0.25, 0.5, 0.15),
      new BABYLON.Color3(0.1, 0.1, 0.1),
      16,
    );

    const diffuseTex = new BABYLON.Texture(CONFIG.TERRAIN.TEXTURE_PATH, scene);
    diffuseTex.wrapU = BABYLON.Texture.WRAP_ADDRESSMODE;
    diffuseTex.wrapV = BABYLON.Texture.WRAP_ADDRESSMODE;
    diffuseTex.uScale = 50; // Reduce from CONFIG.TERRAIN.UV_TILING to prevent shimmer
    diffuseTex.vScale = 50;
    groundMat.diffuseTexture = diffuseTex;

    const normalTex = new BABYLON.Texture(
      CONFIG.TERRAIN.NORMAL_MAP_PATH,
      scene,
    );
    normalTex.wrapU = BABYLON.Texture.WRAP_ADDRESSMODE;
    normalTex.wrapV = BABYLON.Texture.WRAP_ADDRESSMODE;
    normalTex.uScale = 50; // Reduce from CONFIG.TERRAIN.UV_TILING to prevent shimmer
    normalTex.vScale = 50;
    groundMat.bumpTexture = normalTex;

    ground.material = groundMat;
    ground.receiveShadows = true;

    // Physics for terrain - use CYLINDER shape which works better for disc collision
    const groundAggregate = new BABYLON.PhysicsAggregate(
      ground,
      BABYLON.PhysicsShapeType.CYLINDER,
      {
        mass: 0,
        friction: CONFIG.TERRAIN.FRICTION,
        restitution: CONFIG.TERRAIN.RESTITUTION,
      },
      scene,
    );
    scene.groundPhysicsBody = groundAggregate.body;

    // Create water ring around the disc
    this.createWaterRing(scene, radius);

    return ground;
  }

  static createWaterRing(scene, innerRadius) {
    // Create a flat disc for water - 1.5x the size of ground disc, scaled smaller
    const waterDisc = BABYLON.MeshBuilder.CreateDisc(
      "waterRing",
      {
        radius: innerRadius * 1.5,
        tessellation: 64,
      },
      scene,
    );

    waterDisc.position.y = -0.5; // Lower below ground
    waterDisc.rotation.x = Math.PI / 2; // Lay flat

    // Water material
    const water = new BABYLON.WaterMaterial(
      "waterMaterial",
      scene,
      new BABYLON.Vector2(512, 512),
    );
    water.backFaceCulling = false;

    // Set up bump texture with proper wrapping
    water.bumpTexture = new BABYLON.Texture("./assets/waterbump.png", scene);
    water.bumpTexture.wrapU = BABYLON.Texture.WRAP_ADDRESSMODE;
    water.bumpTexture.wrapV = BABYLON.Texture.WRAP_ADDRESSMODE;
    water.bumpTexture.uScale = 4;
    water.bumpTexture.vScale = 4;

    water.windForce = -3; // Slower waves
    water.waveHeight = 0.08; // Smaller waves
    water.windDirection = new BABYLON.Vector2(1, 1);
    water.waterColor = new BABYLON.Color3(0.15, 0.35, 0.55);
    water.colorBlendFactor = 0.4;
    water.waveLength = 0.5; // Slower wave frequency

    // Add reflection of ground and skybox
    const groundMesh = scene.getMeshByName("undulatedGround");
    const skybox = scene.getMeshByName("hdrSkyBox");
    if (groundMesh) water.addToRenderList(groundMesh);
    if (skybox) water.addToRenderList(skybox);

    waterDisc.material = water;

    scene.waterRing = waterDisc;
  }
}

// ─── BALL TRAIL ──────────────────────────────────────────────────────────────

class BallTrail {
  constructor(scene, maxPoints = 1000, maxAge = null) {
    this.scene = scene;
    this.positions = [];
    this.timestamps = [];
    this.maxPoints = maxPoints;
    this.maxAge = maxAge;
    this.line = null;
    this.isTracing = false;
    this._visible = false;
    this.minDistanceBetweenPoints = CONFIG.TRAIL.MIN_DISTANCE_BETWEEN_POINTS;
    this.updateCounter = 0;
    this.updateFrequency = CONFIG.TRAIL.UPDATE_FREQUENCY;
  }

  startTracing() {
    this.isTracing = true;
  }

  stopTracing() {
    this.isTracing = false;
  }

  addPoint(position) {
    if (!this.isTracing) return;

    const now = Date.now();

    // Only add if far enough from last point
    if (this.positions.length > 0) {
      const lastPos = this.positions[this.positions.length - 1];
      const distance = BABYLON.Vector3.Distance(position, lastPos);
      if (distance < this.minDistanceBetweenPoints) {
        return;
      }
    }

    this.positions.push(position.clone());
    this.timestamps.push(now);

    // Remove only if exceeds max points (keep all while tracing)
    while (this.positions.length > this.maxPoints) {
      this.positions.shift();
      this.timestamps.shift();
    }

    // Only update line every N points to reduce lag
    this.updateCounter++;
    if (this.updateCounter >= this.updateFrequency) {
      this.updateLine();
      this.updateCounter = 0;
    }
  }

  updateLine() {
    if (this.line) {
      this.line.dispose();
      this.line = null;
    }

    if (this.positions.length < 2) {
      return;
    }

    // Render trail as a simple line strip.
    this.line = BABYLON.MeshBuilder.CreateLines(
      "trail",
      {
        points: this.positions,
        updatable: false,
      },
      this.scene,
    );
    this.line.color = new BABYLON.Color3(1, 0.15, 0.15);
    this.line.alpha = 0.95;
    this.line.setEnabled(this._visible);
  }

  setVisible(visible) {
    this._visible = visible;
    if (this.line) this.line.setEnabled(visible);
  }

  update(currentPosition) {
    this.addPoint(currentPosition);
  }

  clear() {
    if (this.line) {
      this.line.dispose();
      this.line = null;
    }
    this.positions = [];
    this.timestamps = [];
    this.isTracing = false;
    this.updateCounter = 0;
  }
}

// ─── CLUB SYSTEM ──────────────────────────────────────────────────────────────
// Manages club model loading, mesh visibility, and swing animations.

class ClubSystem {
  constructor(scene) {
    this.scene = scene;
    this.clubsModel = null;
    this.allMeshes = [];
    this.isLoaded = false;
    this.swingInProgress = false;
  }

  async load(ballPosition) {
    try {
      const result = await BABYLON.SceneLoader.ImportMeshAsync(
        "",
        "assets/",
        "clubs.glb",
        this.scene,
      );

      // Wrap the GLB root in a pivot node so we never overwrite its
      // built-in coordinate conversion (GLBs bake scaling/rotation into __root__)
      this.clubPivot = new BABYLON.TransformNode("clubPivot", this.scene);
      this.clubPivot.position = ballPosition.clone();
      result.meshes[0].parent = this.clubPivot;

      this.clubsModel = result.meshes[0];
      this.allMeshes = result.meshes;

      // Position is now controlled via clubPivot, leave __root__ alone
      // permanently since re-enabling a child doesn't override a disabled parent)
      for (let i = 1; i < result.meshes.length; i++) {
        const mesh = result.meshes[i];
        if (mesh && mesh.name) {
          mesh.setEnabled(false);
        }
      }

      // Stop all animations from looping
      for (const animGroup of this.scene.animationGroups) {
        animGroup.loopAnimation = false;
        animGroup.stop();
      }

      this.isLoaded = true;
    } catch (error) {
      console.error("Failed to load clubs.glb:", error);
      this.isLoaded = false;
    }
  }

  getClubTypeName(clubId) {
    if (clubId === 0) return "putter";
    if (clubId >= 1 && clubId <= 8) return "iron";
    if (clubId >= 9 && clubId <= 12) return "driver";
    return null;
  }

  getClubMeshForType(clubId) {
    // Returns the first mesh for this club type (used to reference animation target)
    const typeName = this.getClubTypeName(clubId);
    if (!typeName) return null;
    for (const mesh of this.allMeshes) {
      if (
        mesh &&
        mesh.name &&
        mesh.name.toLowerCase().includes(typeName) &&
        !mesh.name.toLowerCase().includes("axis")
      ) {
        return mesh;
      }
    }
    return null;
  }

  async swing(
    clubId,
    forceRatio,
    ballPosition,
    shotDirection,
    onContactPoint = null,
    onSwingEnd = null,
  ) {
    if (!this.isLoaded || this.swingInProgress) return;

    this.swingInProgress = true;

    // Reposition pivot to current ball position and shot direction
    if (ballPosition && this.clubPivot) {
      this.clubPivot.position = ballPosition.clone();
    }
    if (shotDirection !== undefined && this.clubPivot) {
      // Match trajectory arrow convention: Math.PI + cameraRotation = Math.PI - shotDirection
      this.clubPivot.rotation.y = -shotDirection;
    }

    // Hide all club meshes, then show only the relevant type
    const typeName = this.getClubTypeName(clubId);
    if (!typeName) {
      console.warn(`[ClubSystem] No type name for club ${clubId}`);
      this.swingInProgress = false;
      return;
    }
    for (let i = 1; i < this.allMeshes.length; i++) {
      const mesh = this.allMeshes[i];
      if (mesh?.name && !mesh.name.toLowerCase().includes("axis")) {
        const belongs = mesh.name.toLowerCase().includes(typeName);
        mesh.setEnabled(belongs);
      }
    }

    // Resolve animation name from club type
    const animationNames = {
      putter: "putterAction.001",
      iron: "ironAction.001",
      driver: "driverAction.001",
    };
    const animationName = animationNames[typeName];

    // Stop any running animations
    for (const animGroup of this.scene.animationGroups) {
      animGroup.stop();
      animGroup.reset();
    }

    const animation = this.scene.getAnimationGroupByName(animationName);
    if (!animation) {
      console.warn(`[ClubSystem] Animation not found: ${animationName}`);
      this.swingInProgress = false;
      return;
    }

    // Contact point is 80% through the animation; play forward through follow-through to end
    const CONTACT_PERCENT = 0.8;
    const animFPS = 60;
    const frameStart = animation.from;
    const frameEnd = animation.to;
    const animFrameCount = frameEnd - frameStart;
    const contactFrame = frameStart + animFrameCount * CONTACT_PERCENT;

    // Harder hit = faster-looking swing. Full power = 1.0s total, weakest = 1.8s total.
    const totalSwingDuration = 1.8 - forceRatio * 0.8;
    // Derive speedRatio from the desired total duration
    const speedRatio = animFrameCount / animFPS / totalSwingDuration;

    // Play animation forward through the full swing (backswing + follow-through)
    animation.reset();
    animation.speedRatio = speedRatio;
    animation.loopAnimation = false;
    animation.play(false);

    // Use per-frame observable to fire contact callback at exactly CONTACT_PERCENT
    // This is reliable regardless of frame rate or setTimeout drift.
    let contactFired = false;
    const frameObserver = this.scene.onBeforeRenderObservable.add(() => {
      if (contactFired) return;
      // animation.animatables[0].masterFrame gives the current frame of the group
      const animatable = animation.animatables && animation.animatables[0];
      if (!animatable) return;
      const currentFrame = animatable.masterFrame;
      if (currentFrame >= contactFrame) {
        contactFired = true;
        if (onContactPoint) {
          onContactPoint();
        }
      }
    });

    // Use the animation's own end event for the follow-through completion
    animation.onAnimationGroupEndObservable.addOnce(() => {
      // Clean up the per-frame observer
      this.scene.onBeforeRenderObservable.remove(frameObserver);

      // Ensure contact fires even if the end lands exactly on or before contactFrame
      if (!contactFired) {
        contactFired = true;
        if (onContactPoint) {
          onContactPoint();
        }
      }

      // Hide ALL meshes for this club type (skip index 0 = root)
      for (let i = 1; i < this.allMeshes.length; i++) {
        const mesh = this.allMeshes[i];
        if (
          mesh &&
          mesh.name &&
          mesh.name.toLowerCase().includes(typeName) &&
          !mesh.name.toLowerCase().includes("axis")
        ) {
          mesh.setEnabled(false);
        }
      }

      if (onSwingEnd) {
        onSwingEnd();
      }

      this.swingInProgress = false;
    });
  }

  resetClubs() {
    for (let i = 1; i < this.allMeshes.length; i++) {
      const mesh = this.allMeshes[i];
      if (mesh?.name && !mesh.name.toLowerCase().includes("axis")) {
        mesh.setEnabled(false);
      }
    }
    for (const animGroup of this.scene.animationGroups) {
      animGroup.stop();
      animGroup.reset();
    }
  }

  dispose() {
    if (this.clubsModel) {
      this.clubsModel.dispose();
    }
  }
}

// ─── PHYSICS MANAGER ──────────────────────────────────────────────────────────

class PhysicsManager {
  static async initialize(scene) {
    const havokInstance = await HavokPhysics();
    const physicsPlugin = new BABYLON.HavokPlugin(true, havokInstance);
    scene.enablePhysics(PhysicsConfig.GRAVITY, physicsPlugin);
    return physicsPlugin;
  }
}

// ─── MAIN GAME ORCHESTRATOR ────────────────────────────────────────────────
// Core game loop, state management, and system initialization.

class GolfGame {
  constructor(canvas) {
    this.canvas = canvas;
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
    this.ballStartPosition = new BABYLON.Vector3(0, 0.425, 10);
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

    // Face state tracking
    this.lastBallVelocity = new BABYLON.Vector3(0, 0, 0);
    this.wasHit = false;
    this.hitCooldown = 0;

    // Coordinators (initialized after scene setup)
    this.swingCoordinator = null;
    this.cameraCoordinator = null;
    this.gameStateCoordinator = null;
  }

  normalizeAngle(angle) {
    return Math.atan2(Math.sin(angle), Math.cos(angle));
  }

  getShotDirection() {
    if (this.camera?.camera?.getForwardRay) {
      const forward = this.camera.camera.getForwardRay(1).direction;
      if (forward && Number.isFinite(forward.x) && Number.isFinite(forward.z)) {
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

    // Setup
    await PhysicsManager.initialize(this.scene);
    if (BABYLON.PhysicsViewer) {
      this.physicsViewer = new BABYLON.PhysicsViewer(this.scene);
    }
    await SceneSetup.createEnvironment(this.scene);

    // Load models
    await this.loadGolfBall();
    await this.loadCharacter();

    // Setup pins after golfBall is loaded
    this.setupPins();

    // Setup grass after pins
    await this.setupGrass();

    // Setup systems
    this.setupCamera();
    this.circleUIManager = new CircleUIManager(); // Create unified UI manager early
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
    this.cameraCoordinator = new CameraCoordinator(this.camera);
    this.gameStateCoordinator = new GameStateCoordinator(this);

    // Setup AimView after coordinators are ready (it depends on them)
    this.setupAimView();

    this.setupRenderLoop();
  }

  async loadGolfBall() {
    const bodyMesh = BABYLON.MeshBuilder.CreateSphere(
      "ballBody",
      { diameter: CONFIG.BALL.COLLIDER_DIAMETER, segments: 8 },
      this.scene,
    );
    bodyMesh.position = this.ballStartPosition.clone();
    bodyMesh.isVisible = false;

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

    this.golfBall = new GolfBallGuy(bodyMesh, aggregate.body, null, this.scene);
  }

  async loadCharacter() {
    const result = await BABYLON.SceneLoader.ImportMeshAsync(
      "",
      "assets/",
      "gball.glb",
      this.scene,
    );

    // Parent all character meshes directly to the physics body
    // so they rotate and position with it automatically
    const bodyMesh = this.golfBall.mesh;
    result.meshes.forEach((mesh) => {
      if (mesh) {
        mesh.parent = bodyMesh;
        mesh.position = BABYLON.Vector3.Zero();
        mesh.scaling = new BABYLON.Vector3(0.5, 0.5, 0.5);
      }
    });

    // Update golfBall with character visuals and skeleton
    this.golfBall.skeleton = result.skeletons?.[0] || null;
    this.golfBall.scene = this.scene;

    // Initialize spin bone
    if (this.golfBall.skeleton && this.golfBall.skeleton.bones.length > 0) {
      this.golfBall.spinBone = this.golfBall.skeleton.bones.find((b) =>
        b.name.toLowerCase().includes("spin"),
      );
      if (!this.golfBall.spinBone) {
        this.golfBall.spinBone = this.golfBall.skeleton.bones[0];
      }
    }

    // Load face textures asynchronously
    await this.golfBall.loadFaceTextures();

    // Initialize eyelids for blinking
    this.golfBall.initializeEyelids();

    // Initialize eye gaze system
    this.golfBall.initializeEyes(this.golfBall.skeleton);

    Utils.addShadowCasters(result.meshes, this.scene.shadowGenerator);
  }

  setupCamera() {
    this.camera = new BABYLON.UniversalCamera(
      "camera",
      new BABYLON.Vector3(0, 1, 6),
      this.scene,
    );
    this.camera.attachControl(this.canvas, false);
    this.camera = new FollowCamera(
      this.camera,
      this.golfBall.mesh,
      this.golfBall,
    );
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
      // Use gameStateCoordinator to handle the transition
      this.gameStateCoordinator.transitionAimToPlay(
        this.aimView.cameraRotation,
      );
      // Use cameraCoordinator to update camera
      this.cameraCoordinator.transitionToPlay(
        this.golfBall.getPosition(),
        this.aimedDirection,
      );
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

      // Use swingCoordinator to execute the swing
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

    this.eventManager.on("input:reset", () => {
      this.gameStateCoordinator.resetGame();
      // gameStateCoordinator.resetGame() calls aimView.activate() which handles camera setup
    });
  }

  togglePhysicsDebug() {
    if (!this.physicsViewer) return;
    this.physicsDebugEnabled = !this.physicsDebugEnabled;

    const bodies = [];
    if (this.golfBall?.body) bodies.push(this.golfBall.body);
    if (this.scene.groundPhysicsBody) bodies.push(this.scene.groundPhysicsBody);
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

    const greenPositions = [
      new BABYLON.Vector3(-150, 0, -100),
      new BABYLON.Vector3(-40, 0, -200),
      new BABYLON.Vector3(80, 0, -80),
      new BABYLON.Vector3(40, 0, -280),
      new BABYLON.Vector3(-100, 0, -350),
    ];

    this.greenPositions = greenPositions;

    for (const pos of greenPositions) {
      pinManager.addGreen(pos, 30, this.scene);
      pos.y = 0.2;
      pinManager.addPin(pos, this.scene);
    }

    this.scene.pinManager = pinManager;
    this.eventManager.on("pin:hit", (pinPos) => {
      // Handle pin hit if needed
    });

    this.eventManager.on("pin:holesink", () => {
      this.gameStateCoordinator.handleHoleSink();
      // aimView.activate() (called in handleHoleSink) already sets up camera for AIM mode
    });
  }

  async setupGrass() {
    // Create and setup grass system
    this.grassSystem = new GrassSystem(this.scene, this);

    try {
      await this.grassSystem.loadFrames(CONFIG.GRASS.FRAME_COUNT); // Load animation frames from config
      // Scatter grass - instancing is efficient enough for 10x density now
      this.grassSystem.scatter(300, 12, this.greenPositions); // Lower density for perf
    } catch (err) {
      // Silently fail if grass frames not found
    }
  }

  updateBallState() {
    const landingState = this.golfBall.updateLandingState();
    if (landingState === "fullLand") {
      this.ballTrail.stopTracing();
      this.ballTrail.setVisible(true);
      this.camera.setShotReviewView();
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

    // Update character face based on ball state
    this.updateCharacterFace();
  }

  updateCharacterFace() {
    if (!this.golfBall) return;

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

    // Show hit face briefly
    if (this.hitCooldown > 0) {
      this.hitCooldown -= this.engine.getDeltaTime() / 1000;
      this.golfBall.setFace("hit", this.golfBall.HIT_FACE_DURATION);
    }
    // Show ascending face when moving up with good speed
    else if (isMoving && ballVel.y > 1) {
      this.golfBall.setFace("ascending");
    }
    // Show descending face when falling with good speed
    else if (isMoving && ballVel.y < -2) {
      this.golfBall.setFace("descending");
    }
    // Show collision face when there's significant lateral velocity after leaving ground
    else if (isMoving && Math.abs(ballVel.x) > 3) {
      this.golfBall.setFace("collision");
    }
    // Default face when still or moving slowly
    else if (!isMoving) {
      this.golfBall.setFace("default");
    }

    // Handle rotation during aim mode (face camera) and play mode (face camera for spin transition)
    if (this.camera && this.gameState === GameState.AIM) {
      // During aim mode, character rotates smoothly to face camera (once per frame until target reached)
      this.golfBall.updateRotation(0.1);
    }

    // Update face transition timer
    this.golfBall.updateFaces(this.engine.getDeltaTime() / 1000);

    // Update blinking
    this.golfBall.updateBlinking(this.engine.getDeltaTime() / 1000);

    // Store current velocity for next frame
    this.lastBallVelocity.copyFrom(ballVel);
  }

  setupCompass() {
    // CircleUIManager already created the compass SVG - just setup wind control
    this.setupWindControl();
  }

  setupWindControl() {
    const svg = this.circleUIManager.getCompassSvg();
    if (!svg) return;

    let isDragging = false;

    // Helper to update wind based on position
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

      // Calculate distance and map to speed
      const distance = Math.sqrt(deltaX * deltaX + deltaY * deltaY);
      const maxDistance = svgRect.width / 2;
      const speedRatio = Math.min(distance / (maxDistance * 0.7), 1);
      const speed =
        CONFIG.WIND.MIN_SPEED +
        (CONFIG.WIND.MAX_SPEED - CONFIG.WIND.MIN_SPEED) * speedRatio;

      // Update wind
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

    // Mouse events
    svg.addEventListener("mousedown", handleMouseDown);
    document.addEventListener("mousemove", handleMouseMove);
    document.addEventListener("mouseup", handleMouseUp);

    // Touch events for mobile
    svg.addEventListener("touchstart", handleTouchStart, { passive: false });
    document.addEventListener("touchmove", handleTouchMove, { passive: false });
    document.addEventListener("touchend", handleTouchEnd);

    // Also handle compass clicks to set wind
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
    const arrow = document.getElementById("windArrow");
    const compassSvg = document.getElementById("compassSvg");
    const speedDisplay = document.getElementById("windSpeedDisplay");
    if (arrow && speedDisplay && compassSvg) {
      // Convert wind direction to compass angle for arrow display
      // Wind: 0=South, PI/2=East, PI=North, 3PI/2=West
      // Compass: 0°=North, 90°=East, 180°=South, 270°=West
      const compassAngle =
        (180 - (this.wind.direction * 180) / Math.PI + 360) % 360;
      arrow.setAttribute("transform", `rotate(${compassAngle} 60 60)`);

      // Rotate entire compass to match camera angle (different for aim vs play mode)
      let cameraAngleDeg = 0;
      if (this.aimView && this.aimView.isActive) {
        // In aim view, use aimView's camera rotation
        cameraAngleDeg = ((this.aimView.cameraRotation * 180) / Math.PI) % 360;
      } else if (this.camera && Number.isFinite(this.camera.cameraAngle)) {
        // In play view, use the FollowCamera's angle (only if valid)
        cameraAngleDeg = ((this.camera.cameraAngle * 180) / Math.PI) % 360;
      }
      compassSvg.style.transform = `rotate(${-cameraAngleDeg}deg)`;

      speedDisplay.textContent = `${(this.wind.speed * UNITS.MS_TO_MPH).toFixed(0)} mph`;
    }
  }

  setupRenderLoop() {
    this.scene.registerBeforeRender(() => {
      // Update debug spin visualization to follow ball
      if (
        this.golfBall.debugSpinLineTimeout !== undefined &&
        this.golfBall.debugSpinLineTimeout > 0
      ) {
        this.golfBall.debugSpinLineTimeout--;

        if (
          this.golfBall.debugSpinAxis &&
          this.golfBall.debugSpinLineTimeout > 0
        ) {
          // Create line on first frame
          if (!this.golfBall.debugSpinLine) {
            this.golfBall.debugSpinLine = BABYLON.MeshBuilder.CreateTube(
              "debugSpinAxis",
              {
                path: [
                  this.golfBall.getPosition(),
                  this.golfBall
                    .getPosition()
                    .add(this.golfBall.debugSpinAxis.scale(3)),
                ],
                radius: 0.15,
              },
              this.scene,
            );
            const mat = new BABYLON.StandardMaterial(
              "debugSpinMat",
              this.scene,
            );
            mat.emissiveColor = new BABYLON.Color3(1, 0, 1); // Magenta
            this.golfBall.debugSpinLine.material = mat;
          } else {
            // Update line position to follow ball
            this.golfBall.debugSpinLine.dispose();
            this.golfBall.debugSpinLine = BABYLON.MeshBuilder.CreateTube(
              "debugSpinAxis",
              {
                path: [
                  this.golfBall.getPosition(),
                  this.golfBall
                    .getPosition()
                    .add(this.golfBall.debugSpinAxis.scale(3)),
                ],
                radius: 0.15,
              },
              this.scene,
            );
            const mat = new BABYLON.StandardMaterial(
              "debugSpinMat",
              this.scene,
            );
            mat.emissiveColor = new BABYLON.Color3(1, 0, 1); // Magenta
            this.golfBall.debugSpinLine.material = mat;
          }
        } else if (
          this.golfBall.debugSpinLineTimeout <= 0 &&
          this.golfBall.debugSpinLine
        ) {
          this.golfBall.debugSpinLine.dispose();
          this.golfBall.debugSpinLine = null;
          this.golfBall.debugSpinAxis = null;
        }
      }

      // Update wind system
      this.wind.update();
      this.updateCompass();

      // Apply wind force to airborne ball
      if (this.golfBall.isAirborne() && !this.golfBall.isLanded()) {
        const windForce = this.wind.getForceVector();
        this.golfBall.body.applyForce(windForce, this.golfBall.getPosition());
      }

      this.updateBallState();
      this.scene.pinManager?.checkPinCollisions();
      this.scene.pinManager?.checkHoleSink();
      this.scene.pinManager?.updateFlags(
        this.wind,
        this.engine.getDeltaTime() / 1000,
      );
      this.ballTrail.update(this.golfBall.getPosition());
      this.inputHandler?.updateSwipeOverlay(this.engine.getDeltaTime());
      this.uiManager.update();
      this.aimView?.isActive && this.aimView.update();
      if (this.grassSystem) {
        this.grassSystem.ballPosition = this.golfBall.getPosition();
        this.grassSystem.update(this.engine.getDeltaTime() / 1000);
      }
      if (this.cloudSystem) {
        this.cloudSystem.update(this.golfBall.getPosition(), this.wind);
      }
    });

    // Update camera AFTER physics so it reads the ball's post-step position,
    // eliminating the one-frame lag that causes jitter during ball flight.
    this.scene.onAfterPhysicsObservable.add(() => {
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

    window.addEventListener("resize", () => {
      this.engine.resize();
    });
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// APPLICATION BOOTSTRAP
// ═════════════════════════════════════════════════════════════════════════════

async function startGame() {
  try {
    const canvas = document.getElementById("renderCanvas");
    const game = new GolfGame(canvas);
    await game.initialize();
  } catch (error) {
    alert("Failed to initialize game: " + error.message);
  }
}

startGame();
