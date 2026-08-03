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
  YELLOW: "#E1E44E",
  GREEN_DARK: "#476A23",
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
    ENV_TEXTURE_PATH: "assets/3d/puresky.env",
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
    TEXTURE_PATH: "assets/texture/ground.png",
    NORMAL_MAP_PATH: "assets/texture/groundnormals.png",
  },
  BALL: {
    COLLIDER_DIAMETER: 0.0427, // real golf ball = 42.7 mm (1 unit = 1 m)
    MASS: 0.045,
    FRICTION: 0.9,
    RESTITUTION: 0.3, // turf-like: real balls barely bounce on grass (was 0.6 = hard court)
    LINEAR_DAMPING: 0.3,
    ANGULAR_DAMPING: 1.2,
  },
  // Swing/hit + landing-detection tuning. Single home for these values; the
  // PhysicsConfig accessor class reads them from here so there's no second copy.
  PHYSICS: {
    HIT_FORWARD_FORCE: 100, // reduced for finesse gameplay
    HIT_UPWARD_FORCE: 60,
    SPIN_MULTIPLIER: 400,
    SPIN_ANIMATION_SPEED: 0.3,
    MIN_SWIPE_DISTANCE: 3,
    AIRBORNE_HEIGHT: 2,
    GROUND_CONTACT_HEIGHT: 1.5,
    LANDED_SPEED_THRESHOLD: 0.5,
  },
  CAMERA: {
    FOV_AIM: 1.5,
    FOV_PLAY: 1.5,
    FOLLOW_SMOOTH: 0.1,
    POSITION_LERP_SPEED: 0.25, // gentle ease — used for the shot-review reveal
    // Tight follow during live play. The airborne ball's path is noise-free
    // (constant gravity + constant wind + damping, one physics step per frame),
    // so we can track it closely without any jitter — which lets us drop the old
    // hard distance-clamp that was pinning the camera to the ball's velocity
    // direction and causing the shake. ~0.19 m of lag at driver speed.
    POSITION_LERP_SPEED_PLAY: 2.0,
    ANGLE_LERP_SPEED: 0.08,
  },
  GRASS: {
    VIEW_RADIUS: 16, // grass radius (m) around the CAMERA
    BLADES_PER_CELL: 200, // blades per CELL_SIZE² chunk (~12/m²)
    CELL_SIZE: 4, // chunk size (m); grass only rebuilds when the camera crosses one
    BLADE_SIZE: 0.08, // crossed-quad blade ≈ 8 cm (matches the 42.7 mm ball scale)
    FREEZE_ABOVE_SPEED: 8, // m/s: stop rebuilding grass while the ball flies (anti-jitter)
    GREEN_EXCLUSION_RADIUS: 31, // keep grass this far from each pin/green
    TERRAIN_RADIUS: 183, // practice-mode flat-disc radius
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
    CAMERA_DISTANCE: 0.25,
    CAMERA_HEIGHT: 0.075,
    CAMERA_HEIGHT_MIN: 0.075,
    CAMERA_HEIGHT_MAX: 0.5,
    MOUSE_ROTATION_SENSITIVITY: 0.005,
    MOUSE_HEIGHT_SENSITIVITY: 0.001,
    CLICK_DETECTION_THRESHOLD: 5,
  },
  TRAJECTORY: {
    ARROW_LENGTH: 12,
    ARROW_RADIUS: 0.15,
    ARROW_Y_OFFSET: 0.05,
  },
  FOLLOW_CAMERA: {
    // PLAY view = the strike-swipe and in-flight/spin-swipe camera. Kept as close
    // as AIM_VIEW so the ball is the same prominent size (easy to swipe on to
    // strike and to spin). The brief "watch the club" zoom-out lives separately in
    // SwingCoordinator.executeSwing.
    PLAY_VIEW_OFFSET_X: 0,
    PLAY_VIEW_OFFSET_Y: 0.075,
    PLAY_VIEW_OFFSET_Z: 0.25,
    PLAY_VIEW_LOOK_OFFSET_Y: 0.05,
    PLAY_VIEW_LOOK_OFFSET_Z: 0,
    FULL_SHOT_VIEW_MIN_HEIGHT: 0.8,
    FULL_SHOT_VIEW_MIN_Z: 1.5,
    FULL_SHOT_VIEW_LOOK_Z: -3,
    FULL_SHOT_VIEW_SCALE_X: 0.05,
    FULL_SHOT_VIEW_SCALE_Y: 0.08,
    FULL_SHOT_VIEW_SCALE_Z: 0.12,
    FULL_SHOT_VIEW_SCALE_LOOK_Z: 0.12,
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
    PIN_HEIGHT: 2.13, // real flagstick = 7 ft
    PIN_DIAMETER: 0.013, // real flagstick ≈ 1/2"
    PIN_Y_OFFSET: 1.065, // = PIN_HEIGHT / 2 so the base sits on the green
    GREEN_Y_OFFSET: 0.001,
    GREEN_TEXTURE_PATH: "assets/texture/puttingground.png",
    GREEN_NORMAL_MAP_PATH: "assets/texture/puttinggroundnormals.png",
    GREEN_UV_TILING: 10,
    PIN_COLLISION_RADIUS: 0.06,
    PIN_COLLISION_MIN_SPEED: 0.5,
    PIN_FLASH_SCALE_Y: 2,
    PIN_FLASH_DURATION_MS: 100,
    FLAG_WIDTH: 0.36,
    FLAG_HEIGHT: 0.3,
    HOLE_RADIUS: 0.054, // real cup = 108 mm diameter
    HOLE_Y_OFFSET: 0.35,
    FLAG_WIND_THRESHOLD: 2.235, // ~5 mph in m/s
  },
  TRAIL: {
    MAX_POINTS: 60,
    MAX_AGE_MS: 3000,
    MIN_DISTANCE_BETWEEN_POINTS: 4,
    UPDATE_FREQUENCY: 1,
    TRAIL_RADIUS: 0.02,
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
  BOIDS: {
    COUNT: 25,
    CYLINDER_RADIUS: 200,
    CYLINDER_MIN_HEIGHT: 8,
    CYLINDER_MAX_HEIGHT: 160,
    VISUAL_RANGE: 25,
    MIN_AVOID_DISTANCE: 15,
    MAX_SPEED: 1.2, // per-60fps-frame; integration is now delta-timed
    MAX_FORCE: 0.06, // steering-force clamp → smooth turns (no jerk)
    CENTERING_FACTOR: 0.0006,
    AVOID_FACTOR: 0.05,
    MATCHING_FACTOR: 0.05,
    SEPARATION_WEIGHT: 1.2,
    SIZE: 4,
    WANDER_STRENGTH: 0.015,
    CLIMB_ANIMATION_BOOST: 1.5,
    DESCENT_ANIMATION_DAMPEN: 0.6,
    ROTATE_SMOOTH: 5, // orientation lerp rate (higher = snappier)
    // Landing / perching
    LAND_CHANCE: 0.045, // base per-second chance a flying bird starts landing
    LAND_JOIN_BONUS: 0.12, // small extra chance near an already-landed group
    GROUP_RANGE: 40, // horizontal range for "join the group" landings
    GROUP_CAP: 4, // stop adding join-bonus once a group reaches this many
    ARRIVAL_RADIUS: 16, // start decelerating within this of the landing spot
    TOUCHDOWN_DIST: 1.5, // perch once this close to the spot
    PERCH_SECONDS_MIN: 4,
    PERCH_SECONDS_MAX: 14,
    TAKEOFF_KICK: 0.55, // initial upward velocity on takeoff
    TAKEOFF_HEIGHT: 16, // climb this far above the surface before free flight
    CLIMB_FORCE: 0.05,
    STARTLE_RADIUS: 14, // ball this close makes perched/landing birds bolt
    // Floating on water (bottom of the bird rides at the surface, bobbing)
    WATER_FLOAT: 0.06, // mean height of the bird's underside above the water
    WATER_BOB_AMP: 0.1,
    WATER_BOB_SPEED: 1.6,
    WATER_DRIFT: 0.6, // slow horizontal drift while floating (units/sec)
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
    // Reused scratch — applied to the ball every airborne frame, so avoid the two
    // Vector3 allocations (getWindVector + scale) the old path did per frame.
    const v = this._forceScratch || (this._forceScratch = new BABYLON.Vector3());
    const s = this.speed * CONFIG.WIND.FORCE_MULTIPLIER;
    v.set(-Math.sin(this.direction) * s, 0, Math.cos(this.direction) * s);
    return v;
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
    cloud.isPickable = false; // Clouds are decorative, don't need picking

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

// ─── 3D BOID FLOCKING SYSTEM ───────────────────────────────────────────────
// Implements flocking behavior with birds that stay within a cylindrical bounds.

class Boid3D {
  constructor(position, scene, entries) {
    this.scene = scene;
    this.position = position.clone();
    const s = CONFIG.BOIDS.MAX_SPEED;
    this.velocity = new BABYLON.Vector3(
      (Math.random() - 0.5) * s,
      (Math.random() - 0.5) * 0.3,
      (Math.random() - 0.5) * s,
    );
    this.acceleration = new BABYLON.Vector3();

    // Flight state machine: flying → landing → perched → takeoff → flying
    this.state = "flying";
    this.landTarget = new BABYLON.Vector3();
    this.hasTarget = false;
    this.onWater = false;
    this.perchTimer = 0;
    this.bobPhase = Math.random() * Math.PI * 2;
    this.driftAngle = Math.random() * Math.PI * 2;

    // Smoothed orientation (radians) — birds bank into turns and level out to perch.
    this.yaw = Math.atan2(this.velocity.x, this.velocity.z) + Math.PI;
    this.pitch = 0;
    this.roll = 0;

    this.wanderAngle = Math.random() * Math.PI * 2;
    this.animSpeedVariation = 0.8 + Math.random() * 0.4; // per-bird desync (±20%)
    this._tmp = new BABYLON.Vector3();

    // Fully-independent instance of the GLTF (mesh + skeleton + retargeted
    // animation groups). instantiateModelsToScene remaps every animation to THIS
    // bird's own nodes, so playback is truly independent (unlike a manual clone,
    // whose GLTF node targets couldn't be retargeted → all birds locked in sync).
    this.entries = entries;
    // Wrap the instance's __root__ (which carries the glTF handedness) under our
    // own control node so we can position/rotate the bird without disturbing it.
    this.mesh = new BABYLON.TransformNode(`bird_${Math.random()}`, scene);
    for (const rn of entries.rootNodes) rn.parent = this.mesh;
    this.mesh.position = this.position.clone();
    this.mesh.rotationQuaternion = null;
    this.mesh.rotation = BABYLON.Vector3.Zero();

    this.skeleton = entries.skeletons?.[0] || null;
    const groups = entries.animationGroups || [];
    this.idleAnimation = groups.find((g) => /idle/i.test(g.name)) || null;
    this.flapAnimation = groups.find((g) => /flap/i.test(g.name)) || null;
    this.idleAnimation?.stop();
    this.flapAnimation?.stop();
    // Cross-fade between idle/flap instead of snapping.
    Boid3D.enableBlend(this.idleAnimation);
    Boid3D.enableBlend(this.flapAnimation);

    this.currentAnimationType = null;
    this.playAnimationOfType("flap");
  }

  static enableBlend(animGroup) {
    if (!animGroup) return;
    for (const ta of animGroup.targetedAnimations) {
      ta.animation.enableBlending = true;
      ta.animation.blendingSpeed = 0.06;
    }
  }

  applyForce(force) {
    this.acceleration.addInPlace(force);
  }

  playAnimationOfType(animationType) {
    if (this.currentAnimationType === animationType) return;
    const animGroup =
      animationType === "idle" ? this.idleAnimation : this.flapAnimation;
    if (!animGroup) return;
    // Don't reset() — that snaps targets to frame 0 and defeats the cross-fade.
    // Stop the other group (leaves its pose in place) and start this one; the
    // per-animation blending eases from that pose. Start at a random frame so
    // birds don't beat their wings in unison.
    if (animationType === "idle") this.flapAnimation?.stop();
    else this.idleAnimation?.stop();
    animGroup.loopAnimation = true;
    animGroup.start(true, 1.0, animGroup.from, animGroup.to);
    // Offset the phase so birds don't beat their wings in unison (the pose still
    // cross-fades smoothly because the animations have blending enabled).
    if (animGroup.to > animGroup.from) {
      animGroup.goToFrame(
        animGroup.from + Math.random() * (animGroup.to - animGroup.from),
      );
    }
    this.currentAnimationType = animationType;
  }

  updateAnimation() {
    const want = this.state === "perched" ? "idle" : "flap";
    const grp = want === "idle" ? this.idleAnimation : this.flapAnimation;
    // Switch type, or restart if the group somehow stopped (keeps wings moving).
    if (this.currentAnimationType !== want || (grp && !grp.isPlaying)) {
      this.currentAnimationType = null;
      this.playAnimationOfType(want);
    }
    if (this.state === "perched") {
      if (this.idleAnimation)
        this.idleAnimation.speedRatio = this.animSpeedVariation;
      return;
    }
    if (this.flapAnimation) {
      let m = 1.0;
      if (this.velocity.y > 0.2) m = CONFIG.BOIDS.CLIMB_ANIMATION_BOOST;
      else if (this.velocity.y < -0.2)
        m = CONFIG.BOIDS.DESCENT_ANIMATION_DAMPEN;
      this.flapAnimation.speedRatio = m * this.animSpeedVariation;
    }
  }

  // Smoothly turn to face travel direction, banking into turns; level when perched.
  orient(dt) {
    const k = 1 - Math.exp(-CONFIG.BOIDS.ROTATE_SMOOTH * dt);
    let targetYaw = this.yaw;
    let targetPitch = 0;
    let targetRoll = 0;
    const hLen = Math.hypot(this.velocity.x, this.velocity.z);
    if (this.state !== "perched" && hLen > 0.02) {
      targetYaw = Math.atan2(this.velocity.x, this.velocity.z) + Math.PI;
      targetPitch = Math.max(
        -Math.PI / 3,
        Math.min(Math.PI / 3, Math.atan2(this.velocity.y, hLen)),
      );
    }
    // shortest-path yaw delta (drives both the turn and the bank)
    let dyaw = targetYaw - this.yaw;
    while (dyaw > Math.PI) dyaw -= 2 * Math.PI;
    while (dyaw < -Math.PI) dyaw += 2 * Math.PI;
    if (this.state !== "perched") {
      targetRoll = Math.max(-0.5, Math.min(0.5, dyaw * 2.5));
    }
    this.yaw += dyaw * k;
    this.pitch += (targetPitch - this.pitch) * k;
    this.roll += (targetRoll - this.roll) * k;
    this.mesh.rotation.set(this.pitch, this.yaw, this.roll);
  }

  dispose() {
    this.entries?.animationGroups?.forEach((g) => {
      g.stop();
      g.dispose();
    });
    this.entries?.skeletons?.forEach((s) => s.dispose());
    this.entries?.rootNodes?.forEach((n) => n.dispose());
    this.mesh.dispose();
  }
}

/**
 * A small flock of birds that fly, flock (separation/alignment/cohesion), and
 * every so often peel off to land — on the ground or on the water, where they
 * float and gently bob. Motion is a delta-timed steering model with a clamped
 * steering force, so turns and landings are smooth rather than jerky.
 */
class BirdFlockSystem {
  constructor(scene, groundCenterX = 0, groundCenterZ = 0) {
    this.scene = scene;
    this.boids = [];
    this.groundCenterX = groundCenterX;
    this.groundCenterZ = groundCenterZ;
    this.birdTemplate = null;
    this.isLoaded = false;
    this.bottomOffset = 0.7; // mesh origin → underside; refined at load
    // Reusable temp vectors — no per-frame allocations in the neighbor loops.
    this._diff = new BABYLON.Vector3();
    this._align = new BABYLON.Vector3();
    this._center = new BABYLON.Vector3();
    this._steer = new BABYLON.Vector3();
    this._desired = new BABYLON.Vector3();
    this._down = new BABYLON.Vector3(0, -1, 0);
  }

  async load() {
    try {
      // Keep the model in a container and stamp independent instances from it —
      // instantiateModelsToScene properly clones + retargets skeleton animations.
      this.container = await BABYLON.SceneLoader.LoadAssetContainerAsync(
        "assets/3d/",
        "ballsbird.glb",
        this.scene,
      );
      this.container.animationGroups.forEach((g) => g.stop());

      // Underside offset (level pose) so perched birds sit tangent to the surface.
      const probe = this.container.instantiateModelsToScene(
        (n) => "birdProbe_" + n,
        false,
      );
      const proot = probe.rootNodes[0];
      proot.computeWorldMatrix(true);
      const bb = proot.getHierarchyBoundingVectors(true);
      this.bottomOffset = proot.getAbsolutePosition().y - bb.min.y;
      if (!isFinite(this.bottomOffset)) this.bottomOffset = 0.7;
      probe.dispose();

      this.init();
      this.isLoaded = true;
    } catch (error) {
      console.error("Failed to load ballsbird.glb:", error);
      this.isLoaded = false;
    }
  }

  init() {
    if (!this.container) return;
    const c = CONFIG.BOIDS;
    for (let i = 0; i < c.COUNT; i++) {
      const angle = Math.random() * Math.PI * 2;
      const radius = Math.random() * c.CYLINDER_RADIUS;
      const height =
        c.CYLINDER_MIN_HEIGHT +
        Math.random() * (c.CYLINDER_MAX_HEIGHT - c.CYLINDER_MIN_HEIGHT);
      const x = this.groundCenterX + Math.cos(angle) * radius;
      const z = this.groundCenterZ + Math.sin(angle) * radius;
      const entries = this.container.instantiateModelsToScene(
        (n) => `bird${i}_${n}`,
        false,
      );
      this.boids.push(
        new Boid3D(new BABYLON.Vector3(x, height, z), this.scene, entries),
      );
    }
  }

  // ── surface lookup for landing: raycast against ground/water meshes (both
  //    modes) via intersectsMesh so it works even on non-pickable meshes. ──
  sampleSurface(x, z) {
    const ray = new BABYLON.Ray(
      new BABYLON.Vector3(x, 600, z),
      this._down,
      1200,
    );
    let bestY = -Infinity;
    let water = false;
    for (const m of this.scene.meshes) {
      const n = m.name;
      if (!m.isEnabled()) continue;
      if (n !== "groundDisc" && n !== "waterRing" && !n.startsWith("surf_"))
        continue;
      const info = ray.intersectsMesh(m);
      if (info.hit && info.pickedPoint.y > bestY) {
        bestY = info.pickedPoint.y;
        water = n.toLowerCase().includes("water");
      }
    }
    return bestY === -Infinity ? null : { y: bestY, isWater: water };
  }

  update(dt = 1 / 60, ballPosition = null, ballVelocity = null) {
    if (!this.boids.length) return;
    const c = CONFIG.BOIDS;
    // Clamp dt so a frame hitch can't fast-forward timers or mass-trigger
    // landings (LAND_CHANCE*dt). Harmless at a normal frame rate.
    dt = Math.min(dt, 0.05);
    const f = dt * 60; // frame-equivalent step (≤3)

    for (const boid of this.boids) {
      boid.acceleration.setAll(0);

      switch (boid.state) {
        case "flying":
          this.flock(boid);
          this.wander(boid);
          this.keepWithinBounds(boid);
          this.steer(boid, f);
          this.maybeStartLanding(boid, dt);
          break;

        case "landing":
          this.seek(boid, boid.landTarget, true);
          this.separationOnly(boid);
          this.steer(boid, f);
          if (this.startled(boid, ballPosition)) {
            this.takeOff(boid);
          } else if (this.arrived(boid)) {
            this.perch(boid);
          }
          break;

        case "perched":
          this.updatePerched(boid, dt, ballPosition);
          break;

        case "takeoff":
          this.separationOnly(boid);
          boid.acceleration.y += c.CLIMB_FORCE;
          this.steer(boid, f);
          if (boid.position.y > boid.landTarget.y + c.TAKEOFF_HEIGHT) {
            boid.state = "flying";
            boid.hasTarget = false;
          }
          break;
      }

      boid.updateAnimation();
      boid.mesh.position.copyFrom(boid.position);
      boid.orient(dt);
    }
  }

  // Integrate steering: clamp the force (smooth turns), then velocity, then move.
  steer(boid, f) {
    const c = CONFIG.BOIDS;
    const aLen = boid.acceleration.length();
    if (aLen > c.MAX_FORCE) boid.acceleration.scaleInPlace(c.MAX_FORCE / aLen);
    boid.velocity.addInPlace(boid.acceleration.scale(f));
    const sp = boid.velocity.length();
    if (sp > c.MAX_SPEED) boid.velocity.scaleInPlace(c.MAX_SPEED / sp);
    boid.position.addInPlace(boid.velocity.scale(f));
  }

  // Reynolds seek (with arrival slow-down) toward a point.
  seek(boid, target, arrive) {
    const c = CONFIG.BOIDS;
    target.subtractToRef(boid.position, this._desired);
    const d = this._desired.length();
    if (d < 1e-3) return;
    let speed = c.MAX_SPEED;
    if (arrive && d < c.ARRIVAL_RADIUS)
      speed = c.MAX_SPEED * (d / c.ARRIVAL_RADIUS);
    this._desired.scaleInPlace(speed / d);
    this._desired.subtractInPlace(boid.velocity);
    boid.applyForce(this._desired);
  }

  wander(boid) {
    boid.wanderAngle += (Math.random() - 0.5) * 0.3;
    boid._tmp.set(
      Math.cos(boid.wanderAngle),
      (Math.random() - 0.5) * 0.4,
      Math.sin(boid.wanderAngle),
    );
    boid._tmp.scaleInPlace(CONFIG.BOIDS.WANDER_STRENGTH);
    boid.applyForce(boid._tmp);
  }

  flock(boid) {
    const c = CONFIG.BOIDS;
    const avoidSq = c.MIN_AVOID_DISTANCE * c.MIN_AVOID_DISTANCE;
    const rangeSq = c.VISUAL_RANGE * c.VISUAL_RANGE;
    const sep = this._steer;
    const align = this._align;
    const coh = this._center;
    sep.setAll(0);
    align.setAll(0);
    coh.setAll(0);
    let sepN = 0;
    let n = 0;

    for (const other of this.boids) {
      if (other === boid) continue;
      const distSq = BABYLON.Vector3.DistanceSquared(
        boid.position,
        other.position,
      );
      if (distSq > 0 && distSq < avoidSq) {
        boid.position.subtractToRef(other.position, this._diff);
        this._diff.scaleInPlace(c.SEPARATION_WEIGHT / Math.sqrt(distSq));
        sep.addInPlace(this._diff);
        sepN++;
      }
      if (distSq > 0 && distSq < rangeSq) {
        align.addInPlace(other.velocity);
        coh.addInPlace(other.position);
        n++;
      }
    }

    if (sepN > 0) {
      sep.scaleInPlace(c.AVOID_FACTOR);
      boid.applyForce(sep);
    }
    if (n > 0) {
      align
        .scaleInPlace(1 / n)
        .subtractInPlace(boid.velocity)
        .scaleInPlace(c.MATCHING_FACTOR);
      boid.applyForce(align);
      coh
        .scaleInPlace(1 / n)
        .subtractInPlace(boid.position)
        .scaleInPlace(c.CENTERING_FACTOR);
      boid.applyForce(coh);
    }
  }

  separationOnly(boid) {
    const c = CONFIG.BOIDS;
    const avoidSq = c.MIN_AVOID_DISTANCE * c.MIN_AVOID_DISTANCE;
    const sep = this._steer;
    sep.setAll(0);
    let sepN = 0;
    for (const other of this.boids) {
      if (other === boid) continue;
      const distSq = BABYLON.Vector3.DistanceSquared(
        boid.position,
        other.position,
      );
      if (distSq > 0 && distSq < avoidSq) {
        boid.position.subtractToRef(other.position, this._diff);
        this._diff.scaleInPlace(c.SEPARATION_WEIGHT / Math.sqrt(distSq));
        sep.addInPlace(this._diff);
        sepN++;
      }
    }
    if (sepN > 0) {
      sep.scaleInPlace(c.AVOID_FACTOR);
      boid.applyForce(sep);
    }
  }

  keepWithinBounds(boid) {
    const c = CONFIG.BOIDS;
    const dx = boid.position.x - this.groundCenterX;
    const dz = boid.position.z - this.groundCenterZ;
    const dist = Math.sqrt(dx * dx + dz * dz);
    const turn = 0.25;
    if (dist > c.CYLINDER_RADIUS) {
      boid.velocity.x -= (dx / dist) * turn;
      boid.velocity.z -= (dz / dist) * turn;
    }
    if (boid.position.y < c.CYLINDER_MIN_HEIGHT) boid.velocity.y += turn;
    if (boid.position.y > c.CYLINDER_MAX_HEIGHT) boid.velocity.y -= turn;
  }

  // Occasionally peel off to land. Birds near an already-landed group are more
  // likely to join it — producing natural flock landings.
  maybeStartLanding(boid, dt) {
    const c = CONFIG.BOIDS;
    let chance = c.LAND_CHANCE;
    let anchor = null;
    let nearby = 0;
    for (const other of this.boids) {
      if (other === boid) continue;
      if (other.state !== "perched" && other.state !== "landing") continue;
      const dx = boid.position.x - other.position.x;
      const dz = boid.position.z - other.position.z;
      if (dx * dx + dz * dz < c.GROUP_RANGE * c.GROUP_RANGE) {
        nearby++;
        if (!anchor) anchor = other;
      }
    }
    // Nudge toward joining only while the group is still small, so flocks land
    // in modest clusters rather than the whole flock piling onto one spot.
    if (nearby > 0 && nearby < c.GROUP_CAP) chance += c.LAND_JOIN_BONUS;
    else anchor = null;
    if (Math.random() >= chance * dt) return;

    let tx = boid.position.x;
    let tz = boid.position.z;
    if (anchor) {
      tx = anchor.landTarget.x + (Math.random() - 0.5) * 12;
      tz = anchor.landTarget.z + (Math.random() - 0.5) * 12;
    }
    const surf = this.sampleSurface(tx, tz);
    if (!surf) return; // nothing to land on (over the void) — keep flying
    // Offset by the mesh's bottom so the bird's underside rests on the surface.
    boid.landTarget.set(tx, surf.y + this.bottomOffset, tz);
    boid.onWater = surf.isWater;
    boid.hasTarget = true;
    boid.state = "landing";
  }

  arrived(boid) {
    const c = CONFIG.BOIDS;
    const dx = boid.position.x - boid.landTarget.x;
    const dz = boid.position.z - boid.landTarget.z;
    const dy = boid.position.y - boid.landTarget.y;
    return (
      Math.sqrt(dx * dx + dz * dz) < c.TOUCHDOWN_DIST &&
      Math.abs(dy) < c.TOUCHDOWN_DIST
    );
  }

  perch(boid) {
    const c = CONFIG.BOIDS;
    boid.state = "perched";
    boid.velocity.setAll(0);
    boid.position.copyFrom(boid.landTarget);
    boid.perchTimer =
      c.PERCH_SECONDS_MIN +
      Math.random() * (c.PERCH_SECONDS_MAX - c.PERCH_SECONDS_MIN);
  }

  updatePerched(boid, dt, ballPosition) {
    const c = CONFIG.BOIDS;
    boid.velocity.setAll(0);
    if (boid.onWater) {
      // Slowly drift on the water and bob with the ripples.
      boid.driftAngle += (Math.random() - 0.5) * 0.05;
      boid.landTarget.x += Math.cos(boid.driftAngle) * c.WATER_DRIFT * dt;
      boid.landTarget.z += Math.sin(boid.driftAngle) * c.WATER_DRIFT * dt;
      boid.bobPhase += c.WATER_BOB_SPEED * dt;
      boid.position.x = boid.landTarget.x;
      boid.position.z = boid.landTarget.z;
      boid.position.y =
        boid.landTarget.y +
        c.WATER_FLOAT +
        Math.sin(boid.bobPhase) * c.WATER_BOB_AMP;
      // gentle heading sway as it floats
      boid.yaw += Math.cos(boid.bobPhase * 0.5) * 0.004;
    } else {
      boid.position.copyFrom(boid.landTarget);
    }
    boid.perchTimer -= dt;
    if (boid.perchTimer <= 0 || this.startled(boid, ballPosition)) {
      this.takeOff(boid);
    }
  }

  takeOff(boid) {
    boid.state = "takeoff";
    boid.velocity.y = CONFIG.BOIDS.TAKEOFF_KICK;
    // nudge outward a touch so it doesn't climb straight back into neighbors
    boid.velocity.x += (Math.random() - 0.5) * CONFIG.BOIDS.MAX_SPEED * 0.5;
    boid.velocity.z += (Math.random() - 0.5) * CONFIG.BOIDS.MAX_SPEED * 0.5;
  }

  startled(boid, ballPosition) {
    if (!ballPosition) return false;
    const r = CONFIG.BOIDS.STARTLE_RADIUS;
    const dx = boid.position.x - ballPosition.x;
    const dz = boid.position.z - ballPosition.z;
    return dx * dx + dz * dz < r * r;
  }

  dispose() {
    this.boids.forEach((boid) => boid.dispose());
    this.boids = [];
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
    // Iterate a copy and isolate faults: a throwing listener shouldn't abort the
    // remaining handlers for this event (and off() during emit stays safe).
    for (const callback of this.listeners[eventName].slice()) {
      try {
        callback(data);
      } catch (e) {
        console.error(`Listener for "${eventName}" threw:`, e);
      }
    }
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
  // maxDistance = the club's estimate in metres (shown as yards in the UI).
  // v0 = full-power launch speed (m/s) at the club's loft, CALIBRATED so carry ≈
  //   maxDistance on the range with no wind. Regenerate after changing maxDistance
  //   (or ball physics) with: node scripts/club-calibrate.js
  static CLUBS = [
    { id: 0, name: "Putter", angle: 0, maxDistance: 11, v0: 11.5 },
    { id: 1, name: "Lob Wedge", angle: 60, maxDistance: 55, v0: 40 },
    { id: 2, name: "Pitching Wedge", angle: 45, maxDistance: 66, v0: 37.7 },
    { id: 3, name: "9 Iron", angle: 42, maxDistance: 88, v0: 45.4 },
    { id: 4, name: "8 Iron", angle: 39, maxDistance: 109, v0: 52.4 },
    { id: 5, name: "7 Iron", angle: 37, maxDistance: 131, v0: 59.6 },
    { id: 6, name: "6 Iron", angle: 34, maxDistance: 153, v0: 66.4 },
    { id: 7, name: "5 Iron", angle: 31, maxDistance: 175, v0: 73 },
    { id: 8, name: "4 Iron", angle: 28, maxDistance: 197, v0: 80.2 },
    { id: 9, name: "Hybrid", angle: 20, maxDistance: 241, v0: 93.3 },
    { id: 10, name: "3 Wood", angle: 16, maxDistance: 263, v0: 102.1 },
    { id: 11, name: "5 Wood", angle: 19, maxDistance: 252, v0: 96.9 },
    { id: 12, name: "Driver", angle: 12, maxDistance: 306, v0: 117 },
  ];

  static getClub(id) {
    return this.CLUBS[Math.max(0, Math.min(id, this.CLUBS.length - 1))];
  }
}

// ─── TRAJECTORY ARROW ──────────────────────────────────────────────────────

// ─── PIN INDICATOR ARROW ──────────────────────────────────────────────────
// Floating arrow above pin that bobs up and down

class PinIndicatorArrow {
  constructor(scene) {
    this.scene = scene;
    this.arrow = null;
    this.arrowTemplate = null;
    this.pinPosition = null;
    this.isLoaded = false;
    this.bobTimer = 0;
    this.bobSpeed = 2; // cycles per second
    this.bobHeight = 0.3;
    this.loadArrowModel();
  }

  async loadArrowModel() {
    try {
      const result = await BABYLON.SceneLoader.ImportMeshAsync(
        "",
        "assets/3d/",
        "arrow.glb",
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
      console.error("Failed to load arrow.glb for pin indicator:", error);
    }
  }

  create(pinPosition) {
    if (!this.isLoaded || !this.arrowTemplate) return;
    this.pinPosition = pinPosition.clone();

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

    this.arrow = this.arrowTemplate.clone("pinIndicatorArrow_instance");
    this.arrow.scaling.scaleInPlace(0.107); // Phase 1: match real golf-ball scale
    this.arrow.setEnabled(true);
    this.arrow.rotation = new BABYLON.Vector3(Math.PI / 2, 0, 0); // Point downward
    this.arrow.rotationQuaternion = null;
    this.arrow.getChildMeshes().forEach((mesh) => {
      mesh.setEnabled(true);
    });

    // Set arrow color to cyan
    this.applyColor(new BABYLON.Color3(0, 1, 1));

    if (this.scene.shadowGenerator) {
      const meshes = [this.arrow, ...this.arrow.getChildMeshes()];
      meshes.forEach((mesh) => {
        if (mesh) {
          this.scene.shadowGenerator.addShadowCaster(mesh, true);
        }
      });
    }

    this.bobTimer = 0;
  }

  applyColor(color) {
    if (!this.arrow) return;
    const meshes = [this.arrow, ...this.arrow.getChildMeshes()];
    meshes.forEach((mesh) => {
      if (mesh && mesh.material) {
        if (mesh.material instanceof BABYLON.StandardMaterial) {
          mesh.material.emissiveColor = color;
        }
      }
    });
  }

  update(deltaTime) {
    if (!this.arrow || !this.pinPosition) return;

    // Bob up and down
    this.bobTimer += deltaTime * this.bobSpeed;
    const bobAmount = Math.sin(this.bobTimer * Math.PI * 2) * this.bobHeight;

    const pos = this.pinPosition.clone();
    pos.y += 2.6 + bobAmount; // sits just above the 2.13 m flag, + bob

    this.arrow.position = pos;
    this.arrow.rotation.x = Math.PI / 2; // Keep pointing downward
    this.arrow.rotation.y = 0;
    this.arrow.rotation.z = 0;
  }

  dispose() {
    if (this.arrow) {
      this.arrow.dispose();
      this.arrow = null;
    }
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
    this.currentColor = new BABYLON.Color3(0xe1 / 255, 0xe4 / 255, 0x4e / 255); // Default yellow #E1E44E
    this.pendingColor = null; // Color to apply after arrow is created
    this.loadArrowModel();
  }

  async loadArrowModel() {
    try {
      const result = await BABYLON.SceneLoader.ImportMeshAsync(
        "",
        "assets/3d/",
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
      // Remove from shadow casters before disposing
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

    // Clone the arrow model
    this.arrow = this.arrowTemplate.clone("trajectoryArrow_instance");
    this.arrow.scaling.scaleInPlace(0.107); // Phase 1: match real golf-ball scale
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

    // Register arrow as shadow caster (after material is applied)
    if (this.scene.shadowGenerator) {
      const meshes = [this.arrow, ...this.arrow.getChildMeshes()];
      meshes.forEach((mesh) => {
        if (mesh) {
          this.scene.shadowGenerator.addShadowCaster(mesh, true);
        }
      });
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
      const color = this.currentColor.clone();

      meshes.forEach((mesh) => {
        if (!mesh) return;

        // Create or update material
        let mat = mesh.material;
        if (!mat || !(mat instanceof BABYLON.StandardMaterial)) {
          mat = new BABYLON.StandardMaterial(
            "arrowMat_" + Math.random(),
            this.scene,
          );
          mesh.material = mat;
        }

        // ─── CEL SHADING ──────────────────────────────────────────────
        // Flat, cartoon-like appearance with reduced specular highlights
        mat.diffuseColor = color;
        mat.specularColor = new BABYLON.Color3(0, 0, 0); // No specular
        mat.ambientColor = new BABYLON.Color3(0.6, 0.6, 0.6); // Muted ambient
        mat.emissiveColor = color.scale(0.3); // Subtle glow for depth

        // ─── OUTLINE ──────────────────────────────────────────────────
        // Black outline for cel-shaded effect
        mesh.outlineWidth = 0.15;
        mesh.outlineColor = new BABYLON.Color3(0, 0, 0);
        mat.backFaceCulling = false; // Needed for outline rendering
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
    this.cameraRotation = 0; // Face toward center from north side

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

    // Auto-aim at current hole, or pick new one if first shot
    if (!this.game?.currentHolePin) {
      // Find nearest pin for new hole
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

    // Auto-aim at current hole
    if (this.game?.currentHolePin) {
      const ballPos = this.ballMesh.position;
      const pinPos = this.game.currentHolePin.holePosition;
      const direction = pinPos.subtract(ballPos);
      const angleToPin = Math.atan2(direction.x, direction.z);
      this.golfBallGuy.targetRotation = angleToPin; // Character faces pin directly
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
    this.camera.setTarget(ballPos.add(new BABYLON.Vector3(0, 0.05, 0)));

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
      return new BABYLON.Color3(0x68 / 255, 0x8d / 255, 0x46 / 255); // #688D46
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

  // Sourced from CONFIG.PHYSICS so tuning lives in one place (this class is just
  // a typed accessor kept for its many existing call sites).
  static HIT_FORWARD_FORCE = CONFIG.PHYSICS.HIT_FORWARD_FORCE;
  static HIT_UPWARD_FORCE = CONFIG.PHYSICS.HIT_UPWARD_FORCE;
  static SPIN_MULTIPLIER = CONFIG.PHYSICS.SPIN_MULTIPLIER;
  static SPIN_ANIMATION_SPEED = CONFIG.PHYSICS.SPIN_ANIMATION_SPEED;

  static MIN_SWIPE_DISTANCE = CONFIG.PHYSICS.MIN_SWIPE_DISTANCE;
  static AIRBORNE_HEIGHT = CONFIG.PHYSICS.AIRBORNE_HEIGHT;
  static GROUND_CONTACT_HEIGHT = CONFIG.PHYSICS.GROUND_CONTACT_HEIGHT;
  static LANDED_SPEED_THRESHOLD = CONFIG.PHYSICS.LANDED_SPEED_THRESHOLD;
}

// ─── CHARACTER (GOLF BALL WITH ANIMATIONS) ─────────────────────────────────
// Ball physics, face expressions, blinking, and eye gaze system.

class GolfBallGuy {
  // Rolling resistance: only brake once the ball is already slow, and use a
  // constant decel. ~3.0 m/s² stops slopes up to ~18°; steeper banks still roll.
  static ROLL_BRAKE_SPEED = 2.5;
  static ROLL_BRAKE_DECEL = 3.0;
  // Anti-tunnel guard: a real-size (42.7 mm) ball at ~100 m/s moves far more than
  // its own radius per physics step, so on a fast terrain impact (tee-shot into a
  // rise, or a hard landing) it can punch straight through the thin triangle-MESH
  // terrain. No substep rate is high enough to catch that reliably, so we sweep it
  // back on top each frame instead. Only meaningful above this speed.
  static TUNNEL_GUARD_MIN_SPEED = 6;
  // Above this height over the terrain the ball can't tunnel through it, so we skip
  // the (costly) per-frame terrain ray-pick — it only matters in the last metre or
  // two before the surface. Comfortably clears one frame's fall at drive speed.
  static TUNNEL_GUARD_MAX_HEIGHT = 3;
  static _surfPred = (m) =>
    m.name && m.name.startsWith("surf_") && !m.name.startsWith("surf_water");

  constructor(mesh, physicsBody, skeleton, scene) {
    // Physics properties
    this.mesh = mesh;
    this.body = physicsBody;
    this.startPosition = mesh.position.clone();
    this.landed = true;
    this.touchedGround = false;
    // Terrain height directly under the ball (0 for the flat practice ground).
    // Course mode updates this each frame so airborne/contact tests are measured
    // relative to the ground below, not absolute world Y.
    this.heightRef = 0;

    // Teleport support: reset() flips disablePreStep off so the body follows the
    // mesh for a few physics steps; updateLandingState() restores it afterward.
    this._teleportRestoreFrames = 0;
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
    return this.mesh.position.y - this.heightRef;
  }

  getVelocity() {
    let vel = BABYLON.Vector3.Zero();
    this.body.getLinearVelocityToRef(vel);
    return vel;
  }

  getSpeed() {
    // Reuse a scratch vector — getSpeed runs several times per frame and returns
    // only a scalar, so there's no need to allocate a fresh Vector3 each call.
    const v = this._speedScratch || (this._speedScratch = new BABYLON.Vector3());
    this.body.getLinearVelocityToRef(v);
    return v.length();
  }

  getAngularVelocity() {
    let angVel = BABYLON.Vector3.Zero();
    this.body.getAngularVelocityToRef(angVel);
    return angVel;
  }

  /**
   * Rolling resistance. A physics sphere rolls down any slope forever (sliding
   * friction can't stop a rolling ball — only rolling resistance can). So when
   * the ball is on the ground and already slow, bleed off horizontal speed with
   * a CONSTANT deceleration (not proportional damping, which only asymptotes).
   * On a gentle undulation this beats gravity → the ball fully stops; on a steep
   * bank gravity wins → it keeps rolling. Makes the ball settle instead of creep.
   */
  applyRollingResistance(dt) {
    if (this.isAirborne()) return;
    // Scratch vectors reused every frame instead of allocating (this runs each
    // render frame while the ball is settling on an undulation).
    const v = this._rrLin || (this._rrLin = new BABYLON.Vector3());
    const av = this._rrAng || (this._rrAng = new BABYLON.Vector3());
    this.body.getLinearVelocityToRef(v);
    const hs = Math.hypot(v.x, v.z);
    if (hs < 1e-3 || hs > GolfBallGuy.ROLL_BRAKE_SPEED) return;
    const newHs = hs - GolfBallGuy.ROLL_BRAKE_DECEL * dt;
    if (newHs < 0.06) {
      // Fully stopped: kill motion so static friction can hold it on the slope.
      v.set(0, Math.min(0, v.y), 0);
      this.body.setLinearVelocity(v);
      av.set(0, 0, 0);
      this.body.setAngularVelocity(av);
    } else {
      const s = newHs / hs;
      v.set(v.x * s, v.y, v.z * s);
      this.body.setLinearVelocity(v);
      this.body.getAngularVelocityToRef(av);
      av.scaleInPlace(s);
      this.body.setAngularVelocity(av);
    }
  }

  // Swept anti-tunnel guard (see TUNNEL_GUARD_MIN_SPEED). If the ball ended a step
  // below the terrain surface at its x,z, it tunneled through — bounce it off the
  // surface (reflect velocity by restitution) and lift it back on top.
  preventTunneling() {
    if (!this.body || this._teleportRestoreFrames > 0) return;
    if (this.getSpeed() < GolfBallGuy.TUNNEL_GUARD_MIN_SPEED) return;
    // Skip the terrain ray-pick while the ball is well above the ground — it can't
    // tunnel from up there, and picking every frame of the whole flight is what
    // spikes frame times (and makes the follow camera look jittery). getHeight() is
    // an O(1) height-grid read, so this early-out is essentially free.
    if (this.getHeight() > GolfBallGuy.TUNNEL_GUARD_MAX_HEIGHT) return;
    const p = this.mesh.getAbsolutePosition();
    const r = CONFIG.BALL.COLLIDER_DIAMETER / 2;
    const ray =
      this._tgRay ||
      (this._tgRay = new BABYLON.Ray(
        new BABYLON.Vector3(),
        new BABYLON.Vector3(0, -1, 0),
        80,
      ));
    ray.origin.set(p.x, p.y + 3, p.z);
    const hit = this.scene.pickWithRay(ray, GolfBallGuy._surfPred);
    if (!hit || !hit.hit) return;
    const surfaceY = hit.pickedPoint.y;
    if (p.y >= surfaceY + r - 0.03) return; // on/above the surface — nothing to do
    // Reflect the into-surface velocity component (a bounce), then lift on top.
    const v = this._tgV || (this._tgV = new BABYLON.Vector3());
    this.body.getLinearVelocityToRef(v);
    let n = hit.getNormal(true);
    if (!n) n = new BABYLON.Vector3(0, 1, 0);
    const vn = v.x * n.x + v.y * n.y + v.z * n.z;
    if (vn < 0) {
      const e = CONFIG.BALL.RESTITUTION;
      v.x -= (1 + e) * vn * n.x;
      v.y -= (1 + e) * vn * n.y;
      v.z -= (1 + e) * vn * n.z;
      this.body.setLinearVelocity(v);
    }
    this.mesh.position.y = surfaceY + r + 0.01;
    this.body.disablePreStep = false;
    this._teleportRestoreFrames = 2;
    this.mesh.computeWorldMatrix(true);
  }

  applyHit(
    deltaX,
    deltaY,
    force,
    aimedDirection = 0,
    clubLaunchAngle = 0,
    clubLaunchSpeed = 40,
  ) {
    const swipeStrength = Math.min(
      force / 100,
      CONFIG.GOLF_BALL.MAX_HIT_STRENGTH,
    );
    // Distance is driven by a per-club launch SPEED (calibrated so full-power
    // carry ≈ the club's estimate — see scripts/club-distance-test.js), launched
    // at the club's loft. The old model derived speed from ad-hoc force constants
    // × sqrt(distance) for forward and × sin(loft) for lift, which were coupled to
    // neither each other nor the target — so short/high-loft clubs flew ~2.5× their
    // number and the whole set bunched into a narrow band.
    const powerRatio = swipeStrength / CONFIG.GOLF_BALL.MAX_HIT_STRENGTH; // 0..1
    const theta = (clubLaunchAngle * Math.PI) / 180;
    const speed = clubLaunchSpeed * powerRatio;
    const vForward = speed * Math.cos(theta);
    const vUp = speed * Math.sin(theta);
    // Sideways component of the swipe curves the shot. Kept on the same Δv scale as
    // the old force path (force→impulse/mass·dt) so left/right feel is unchanged.
    const vLateral =
      (-deltaX *
        CONFIG.GOLF_BALL.HIT_HORIZONTAL_DEVIATION_FACTOR *
        CONFIG.SWIPE_OVERLAY.PHYSICS_STEP_SECONDS) /
      CONFIG.BALL.MASS;

    const localVel = new BABYLON.Vector3(vLateral, vUp, -vForward);
    const { x: rotX, z: rotZ } = Utils.rotate2D(
      localVel.x,
      localVel.z,
      aimedDirection,
    );
    const launchVel = new BABYLON.Vector3(rotX, localVel.y, rotZ);

    const impactPoint = this.getPosition().add(
      new BABYLON.Vector3(
        CONFIG.GOLF_BALL.IMPACT_POINT_OFFSET_X,
        CONFIG.GOLF_BALL.IMPACT_POINT_OFFSET_Y,
        CONFIG.GOLF_BALL.IMPACT_POINT_OFFSET_Z,
      ),
    );

    // From rest, an impulse J = m·Δv delivers Δv = launchVel exactly, so the launch
    // speed is the calibrated value regardless of frame length (frame-rate safe).
    this.body.applyImpulse(launchVel.scale(CONFIG.BALL.MASS), impactPoint);
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
  }

  updateLandingState() {
    // Restore physics control a few steps after a teleport (see reset()).
    if (this._teleportRestoreFrames > 0) {
      this._teleportRestoreFrames--;
      if (this._teleportRestoreFrames === 0 && this.body) {
        this.body.disablePreStep = true;
      }
    }
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
    // Teleport the physics body to the new spot: let it read the mesh transform
    // for a few physics steps, then hand position control back to the simulation.
    if (this.body) {
      this.body.disablePreStep = false;
      this._teleportRestoreFrames = 3;
      this.mesh.computeWorldMatrix(true);
    }
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
    this.camera.maxZ = 3000; // Increased for better shot overview visibility
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
    const newPosition = this._camPos || (this._camPos = new BABYLON.Vector3());
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

// ─── GRASS SYSTEM ──────────────────────────────────────────────────────────
// GPU thin-instanced grass. Each texture variant is ONE mesh drawn in a single
// call from a matrix buffer — no per-blade scene nodes, no per-frame billboarding.
// Blades are crossed quads (an "X" from above) so they read as volume from any
// angle without facing the camera. Grass is generated in fixed CELL_SIZE chunks
// around the CAMERA and only rebuilt when the camera crosses a chunk boundary.

class GrassSystem {
  constructor(scene) {
    this.scene = scene;
    this.grassMeshes = []; // one crossed-quad template per grass texture
    this.chunks = new Map(); // "cx,cz" -> { mats: Float32Array[] } (per variant)
    this.activeKeys = new Set();
    this.lastCenter = null; // last center chunk {cx, cz}; gates rebuilds
    // Course-mode hooks (null in practice → flat disc at y=0).
    // groundYAt(x,z) → terrain height for the blade; playableAt(x,z) → whether
    // grass is allowed there (fairway/rough only, not water/sand/off-hole).
    this.groundYAt = null;
    this.playableAt = null;
  }

  async initialize() {
    // One crossed-quad template per grass texture. Variety comes from the texture
    // plus a random per-blade yaw baked into each instance matrix (which subsumes
    // the old mirror-flip variant). Each template is thin-instanced → one draw call.
    for (let i = 0; i < 3; i++) {
      this.grassMeshes.push(this.makeBladeTemplate(i));
    }
  }

  // Two planes crossed at 90°, merged into one mesh with its base at y=0, so a blade
  // reads as volume from any direction and never needs to be billboarded.
  makeBladeTemplate(index) {
    const s = CONFIG.GRASS.BLADE_SIZE;
    const a = BABYLON.MeshBuilder.CreatePlane(
      `grassPlaneA_${index}`,
      { width: s, height: s },
      this.scene,
    );
    const b = BABYLON.MeshBuilder.CreatePlane(
      `grassPlaneB_${index}`,
      { width: s, height: s },
      this.scene,
    );
    a.position.y = s / 2; // lift so the merged blade's base sits on the ground
    b.position.y = s / 2;
    b.rotation.y = Math.PI / 2; // cross the second quad → an "X" seen from above
    const blade = BABYLON.Mesh.MergeMeshes([a, b], true, true); // bakes transforms

    const tex = new BABYLON.Texture(
      `./assets/grass/grass${index + 1}.png`,
      this.scene,
    );
    tex.hasAlpha = true;
    tex.uWrapMode = BABYLON.Texture.CLAMP_ADDRESSMODE;
    tex.vWrapMode = BABYLON.Texture.CLAMP_ADDRESSMODE;
    tex.uOffset = 0.01;
    tex.vOffset = 0.01;
    tex.uScale = 0.98;
    tex.vScale = 0.98;

    const mat = new BABYLON.StandardMaterial(`grassMat_${index}`, this.scene);
    mat.diffuseTexture = tex;
    mat.useAlphaFromDiffuseTexture = true;
    // Alpha-TEST (cutout), not alpha-BLEND: no transparency sorting / overdraw.
    mat.transparencyMode = BABYLON.Material.MATERIAL_ALPHATEST;
    mat.alphaCutOff = 0.4;
    mat.backFaceCulling = false; // both faces of each quad visible
    mat.specularColor = new BABYLON.Color3(0, 0, 0); // grass isn't shiny

    blade.name = `grassBlade_${index}`;
    blade.material = mat;
    blade.isPickable = false;
    blade.thinInstanceEnablePicking = false;
    // Instances cover the whole field; the template's own bounds are tiny, so keep
    // it always active rather than letting frustum culling drop the entire field.
    blade.alwaysSelectAsActiveMesh = true;
    blade.setEnabled(false);
    return blade;
  }

  // Deterministic PRNG (mulberry32) so a chunk that stays in view regenerates the
  // SAME blades every rebuild — no shuffling / pop-in. Seeded by chunk coords.
  static _rng(seed) {
    let t = seed >>> 0;
    return () => {
      t = (t + 0x6d2b79f5) >>> 0;
      let x = Math.imul(t ^ (t >>> 15), 1 | t);
      x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
      return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
    };
  }

  // Build one chunk's blade matrices, split per texture variant (Float32Array each).
  buildChunk(cx, cz, pinPositions) {
    const S = CONFIG.GRASS.CELL_SIZE;
    const density = CONFIG.GRASS.BLADES_PER_CELL;
    const exclSq =
      CONFIG.GRASS.GREEN_EXCLUSION_RADIUS * CONFIG.GRASS.GREEN_EXCLUSION_RADIUS;
    const terrainRSq = CONFIG.GRASS.TERRAIN_RADIUS * CONFIG.GRASS.TERRAIN_RADIUS;
    const nVar = this.grassMeshes.length;
    const rng = GrassSystem._rng(Math.imul(cx, 73856093) ^ Math.imul(cz, 19349663));
    const out = Array.from({ length: nVar }, () => []);
    const scale = new BABYLON.Vector3();
    const quat = new BABYLON.Quaternion();
    const pos = new BABYLON.Vector3();
    const mat = new BABYLON.Matrix();
    for (let i = 0; i < density; i++) {
      const x = cx * S + rng() * S;
      const z = cz * S + rng() * S;
      // Course mode: only grow on playable turf. Practice mode: the flat disc.
      if (this.playableAt) {
        if (!this.playableAt(x, z)) continue;
      } else if (x * x + z * z > terrainRSq) {
        continue;
      }
      let skip = false; // keep grass off greens
      for (const p of pinPositions) {
        const dx = x - p.x,
          dz = z - p.z;
        if (dx * dx + dz * dz < exclSq) {
          skip = true;
          break;
        }
      }
      if (skip) continue;
      const y = this.groundYAt ? this.groundYAt(x, z) : 0;
      const sc = 0.8 + rng() * 0.6; // per-blade size variation
      scale.set(sc, sc, sc);
      BABYLON.Quaternion.RotationYawPitchRollToRef(rng() * Math.PI * 2, 0, 0, quat);
      pos.set(x, y, z);
      BABYLON.Matrix.ComposeToRef(scale, quat, pos, mat);
      const arr = out[Math.floor(rng() * nVar)];
      for (let k = 0; k < 16; k++) arr.push(mat.m[k]);
    }
    return out.map((a) => Float32Array.from(a));
  }

  // Concatenate every active chunk's matrices per variant and upload as one buffer.
  rebuildBuffers() {
    for (let v = 0; v < this.grassMeshes.length; v++) {
      let total = 0;
      for (const key of this.activeKeys) {
        total += this.chunks.get(key).mats[v].length;
      }
      const mesh = this.grassMeshes[v];
      if (total === 0) {
        mesh.thinInstanceCount = 0;
        mesh.setEnabled(false);
        continue;
      }
      const buf = new Float32Array(total);
      let off = 0;
      for (const key of this.activeKeys) {
        const a = this.chunks.get(key).mats[v];
        buf.set(a, off);
        off += a.length;
      }
      mesh.thinInstanceSetBuffer("matrix", buf, 16, true);
      mesh.setEnabled(true);
    }
  }

  update(refPos, pinPositions = []) {
    if (!this.grassMeshes.length) return;
    const S = CONFIG.GRASS.CELL_SIZE;
    const cx = Math.floor(refPos.x / S);
    const cz = Math.floor(refPos.z / S);
    // Nothing to do until the reference crosses into a new chunk. This early-out is
    // what makes grass ~free per frame: no scene nodes to touch, no billboarding.
    if (this.lastCenter && this.lastCenter.cx === cx && this.lastCenter.cz === cz) {
      return;
    }
    this.lastCenter = { cx, cz };

    const R = Math.ceil(CONFIG.GRASS.VIEW_RADIUS / S);
    const need = new Set();
    for (let dx = -R; dx <= R; dx++) {
      for (let dz = -R; dz <= R; dz++) {
        const key = `${cx + dx},${cz + dz}`;
        need.add(key);
        if (!this.chunks.has(key)) {
          this.chunks.set(key, {
            mats: this.buildChunk(cx + dx, cz + dz, pinPositions),
          });
        }
      }
    }
    // Drop chunks that left the view so the cache stays bounded.
    for (const key of this.chunks.keys()) {
      if (!need.has(key)) this.chunks.delete(key);
    }
    this.activeKeys = need;
    this.rebuildBuffers();
  }

  // Clear all grass (e.g. between holes — the terrain height/playable mask changed).
  reset() {
    this.chunks.clear();
    this.activeKeys = new Set();
    this.lastCenter = null;
    for (const mesh of this.grassMeshes) {
      mesh.thinInstanceCount = 0;
      mesh.setEnabled(false);
    }
  }

  dispose() {
    for (const mesh of this.grassMeshes) {
      mesh.dispose(false, true); // also dispose material + textures
    }
    this.grassMeshes = [];
    this.chunks.clear();
    this.activeKeys = new Set();
    this.lastCenter = null;
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
    const full = this.simFlightRange(club.v0, loftRad, dt, linearDamping, gAbs);
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

  solveSwipeStrengthForDistance(worldDistance, dt, linearDamping, gAbs, club) {
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

    const strength = Math.max(minStrength, Math.min(maxStrength, high));
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
    window.addEventListener("keydown", (e) => this.handleKeyDown(e));
  }

  handlePointerDown(event) {
    this.pointerActive = true;
    this.touchStartX = event.clientX;
    this.touchStartY = event.clientY;
    this.touchStartTime = Date.now();
    this.game.justTransitioned = false; // Reset transition guard on new pointer down

    // In shot review mode, allow orbit controls but block game actions
    if (this.isShotReviewMode() && this.golfBall.isLanded()) {
      this.overviewOrbiting = true;
      this.lastPointerX = event.clientX;
      this.clearInputPreview();
      return;
    }

    // Block all other input if controls are disabled
    if (this.game?.isControlsDisabled) return;

    // In aim mode, don't trigger hit/spin, let orbit controls handle it
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

      if (
        !this.game?.isControlsDisabled &&
        this.golfBall.isLanded() &&
        distance < PhysicsConfig.MIN_SWIPE_DISTANCE
      ) {
        this.eventManager.emit("input:reset");
      }
      return;
    }

    if (this.game?.isControlsDisabled) return;

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
    if (this.game?.isControlsDisabled) return;
    if (event.code === "Space") {
      this.eventManager.emit("input:reset");
    }
  }
}

// ─── UNIFIED CIRCLE UI MANAGER ──────────────────────────────────────────────

class CircleUIManager {
  static FLAG_PATHS = [
    "assets/flag/flag.png",
    "assets/flag/flag-1.png",
    "assets/flag/flag-2.png",
    "assets/flag/flag-3.png",
    "assets/flag/flag-4.png",
    "assets/flag/flag-5.png",
    "assets/flag/flag-6.png",
  ];

  static flagImages = new Map();
  static flagDataUrls = new Map();
  static flagAssetsPromise = null;

  static ensureFlagAssetsLoaded() {
    if (CircleUIManager.flagAssetsPromise) {
      return CircleUIManager.flagAssetsPromise;
    }

    CircleUIManager.flagAssetsPromise = Promise.all(
      CircleUIManager.FLAG_PATHS.map(
        (path, index) =>
          new Promise((resolve, reject) => {
            const img = new Image();

            img.onload = () => {
              const canvas = document.createElement("canvas");
              canvas.width = img.width;
              canvas.height = img.height;
              const ctx = canvas.getContext("2d");

              if (!ctx) {
                reject(new Error(`Failed to create flag canvas for ${path}`));
                return;
              }

              ctx.drawImage(img, 0, 0);
              CircleUIManager.flagImages.set(index, img);
              CircleUIManager.flagDataUrls.set(
                index,
                canvas.toDataURL("image/png"),
              );
              resolve();
            };

            img.onerror = () => {
              reject(new Error(`Failed to load flag asset: ${path}`));
            };

            img.src = path;
          }),
      ),
    );

    return CircleUIManager.flagAssetsPromise;
  }

  constructor(modeToggleCallback = null) {
    this.modeToggleCallback = modeToggleCallback;

    CircleUIManager.ensureFlagAssetsLoaded().catch((error) => {
      console.warn(error.message);
    });
    // Set CSS variables so scale-dependent sizes are correct
    const scale = CONFIG.SCREEN.UI_SCALE;
    const root = document.documentElement;
    root.style.setProperty("--ui-size", 150 * scale + "px");
    root.style.setProperty("--ui-margin", 15 * scale + "px");
    root.style.setProperty("--ui-border-width", 6 * scale + "px");
    root.style.setProperty("--ui-btn-size", 40 * scale + "px");
    root.style.setProperty("--ui-gap", 12 * scale + "px");
    root.style.setProperty("--ui-mb-flag", 4 * scale + "px");
    root.style.setProperty("--ui-flag-w", 112 * scale + "px");
    root.style.setProperty("--ui-flag-h", 88 * scale + "px");
    root.style.setProperty("--ui-pin-fs", 36 * scale + "px");
    root.style.setProperty("--ui-yardage-fs", 28 * scale + "px");
    root.style.setProperty("--ui-wind-fs", 32 * scale + "px");
    root.style.setProperty("--ui-power-emoji-fs", 44 * scale + "px");
    root.style.setProperty("--ui-power-fs", 26 * scale + "px");
    root.style.setProperty("--ui-power-gap", 2 * scale + "px");
    root.style.setProperty("--ui-club-btn-fs", 24 * scale + "px");
    root.style.setProperty("--ui-club-icon-fs", 64 * scale + "px");
    root.style.setProperty("--ui-club-name-fs", 24 * scale + "px");
    root.style.setProperty("--ui-club-dist-fs", 12 * scale + "px");

    // Wire up to pre-existing DOM elements from index.html
    this.circles = {
      topLeft: document.getElementById("circleStats"),
      topRight: document.getElementById("circleCompass"),
      bottomLeft: document.getElementById("circlePower"),
      bottomRight: document.getElementById("circleClub"),
    };
    this.clubButtonsContainer = document.getElementById("clubSelectorWrapper");

    this._statsFlagImg = document.getElementById("statsFlagImg");
    this._lastFlagFrame = -1; // Track last frame to avoid unnecessary updates
    this._statsPinNumber = document.getElementById("statsPinNumber");
    this.powerPercent = document.getElementById("powerPercent");
    this.powerArc = document.getElementById("powerArc");
    this._powerCircumference = 383; // 2π * 61, fixed for viewBox="0 0 150 150"
    this.clubName = document.getElementById("clubName");
    this.clubDistance = document.getElementById("clubDistance");
    this.clubIcon = document.getElementById("clubIcon");

    this._attachPressEffect(this.circles.topLeft);
    this._attachPressEffect(document.getElementById("compassCircle"));
    this._attachPressEffect(this.circles.bottomLeft);
    this._attachPressEffect(this.circles.bottomRight);

    // Add click handler for club circle to toggle between AIM and PLAY modes
    const clubCircle = this.circles.bottomRight;
    if (clubCircle && this.modeToggleCallback) {
      clubCircle.addEventListener("click", () => {
        this.modeToggleCallback();
      });
    }
  }

  _attachPressEffect(el) {
    el.addEventListener("pointerdown", () => el.classList.add("pressed"));
    el.addEventListener("pointerup", () => el.classList.remove("pressed"));
    el.addEventListener("pointerleave", () => el.classList.remove("pressed"));
    el.addEventListener("pointercancel", () => el.classList.remove("pressed"));
  }

  // Update stats circle (play mode) - just yardage
  showStatsCircle() {
    const stats = document.getElementById("circleStats");
    if (stats) stats.style.display = "flex";
  }

  hideStatsCircle() {
    const stats = document.getElementById("circleStats");
    if (stats) stats.style.display = "none";
  }

  updateStats(speed, spin, height, distance, flagFrame, pinNumber) {
    document.getElementById("circleYardage").textContent = distance.toFixed(0);

    // Update flag via cached data URLs (no network requests, pure memory)
    if (this._statsFlagImg && flagFrame !== this._lastFlagFrame) {
      this._lastFlagFrame = flagFrame;
      const frameIndex = Math.max(0, Math.min(flagFrame, 6)); // Clamp 0-6
      const dataUrl = CircleUIManager.flagDataUrls.get(frameIndex);

      if (dataUrl) {
        this._statsFlagImg.style.backgroundImage = `url('${dataUrl}')`;
      }
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

    // Update club icon based on club type
    if (this.clubIcon) {
      let iconPath = "assets/clubs/iron.png"; // default
      if (clubName.includes("Driver") || clubName.includes("Wood")) {
        iconPath = "assets/clubs/driver.png";
      } else if (clubName.includes("Putter")) {
        iconPath = "assets/clubs/putter.png";
      }
      this.clubIcon.src = iconPath;
    }
  }

  // Hide/show circles based on mode
  showPowerCircle() {
    if (this.circles.bottomLeft) this.circles.bottomLeft.style.display = "flex";
  }
  hidePowerCircle() {
    if (this.circles.bottomLeft) this.circles.bottomLeft.style.display = "none";
  }

  showCompassCircle() {
    const circle = document.getElementById("compassCircle");
    const wind = document.getElementById("windSpeedDisplay");
    if (circle) circle.style.display = "flex";
    if (wind) wind.style.display = "block";
  }

  hideCompassCircle() {
    const circle = document.getElementById("compassCircle");
    const wind = document.getElementById("windSpeedDisplay");
    if (circle) circle.style.display = "none";
    if (wind) wind.style.display = "none";
  }

  showClubCircle() {
    const up = document.getElementById("clubUp");
    const circle = document.getElementById("circleClub");
    const down = document.getElementById("clubDown");
    if (up) up.style.display = "block";
    if (circle) circle.style.display = "flex";
    if (down) down.style.display = "block";
  }

  hideClubCircle() {
    const up = document.getElementById("clubUp");
    const circle = document.getElementById("circleClub");
    const down = document.getElementById("clubDown");
    if (up) up.style.display = "none";
    if (circle) circle.style.display = "none";
    if (down) down.style.display = "none";
  }

  hideAllCircles() {
    // Hide all UI circles during review
    Object.values(this.circles).forEach((circle) => {
      if (circle) circle.style.display = "none";
    });
    if (this.clubButtonsContainer)
      this.clubButtonsContainer.style.display = "none";
  }

  showAllCircles() {
    // Re-enable UI circles based on current game state
    Object.values(this.circles).forEach((circle) => {
      if (circle) circle.style.display = "flex";
    });
    if (this.clubButtonsContainer)
      this.clubButtonsContainer.style.display = "flex";
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
      if (circle) circle.style.display = "none";
    });
    if (this.clubButtonsContainer)
      this.clubButtonsContainer.style.display = "none";
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
  static flagTexturesCache = null; // shared cache for all flag textures

  constructor(scene, golfBall, eventManager = null) {
    this.scene = scene;
    this.golfBall = golfBall;
    this.eventManager = eventManager || new EventManager();
    this.pins = [];
    this.greens = [];
    this.currentFlagFrame = 0; // shared frame index (0=still, 1-6=animated)

    // Spatial culling distances for collision/sink checks
    this.COLLISION_CHECK_RADIUS = CONFIG.PINS.PIN_COLLISION_RADIUS * 3; // 3x collision radius for early detection
    this.SINK_CHECK_RADIUS = CONFIG.PINS.HOLE_RADIUS * 5; // 5x hole radius for precision

    // Initialize texture cache if this is the first PinManager instance
    if (!PinManager.flagTexturesCache) {
      PinManager.flagTexturesCache = this._initFlagTextureCache(scene);
    }
  }

  _initFlagTextureCache(scene) {
    const textures = CircleUIManager.FLAG_PATHS.map((_, index) => {
      const t = new BABYLON.DynamicTexture(
        `flagTexture_${index}`,
        { width: 256, height: 128 },
        scene,
        true,
      );
      t.hasAlpha = true;
      t.wrapU = BABYLON.Texture.CLAMP_ADDRESSMODE;
      t.wrapV = BABYLON.Texture.CLAMP_ADDRESSMODE;
      const ctx = t.getContext();
      ctx.clearRect(0, 0, 256, 128);
      t.update();
      return t;
    });

    CircleUIManager.ensureFlagAssetsLoaded()
      .then(() => {
        textures.forEach((texture, index) => {
          const image = CircleUIManager.flagImages.get(index);
          if (!image) return;

          const ctx = texture.getContext();
          ctx.clearRect(0, 0, 256, 128);
          ctx.drawImage(image, 0, 0, 256, 128);
          texture.update();
        });
      })
      .catch((error) => {
        console.warn(error.message);
      });

    return textures;
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
    pole.isPickable = true; // MUST be pickable - used for click detection in AimView

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
    flagPlane.isPickable = false; // Flag is child of pole, doesn't need picking

    const flagMat = new BABYLON.StandardMaterial("flagMat", scene);
    // Use first texture from cache
    flagMat.diffuseTexture = PinManager.flagTexturesCache[0];
    flagMat.diffuseTexture.hasAlpha = true;
    flagMat.useAlphaFromDiffuseTexture = true;
    flagMat.transparencyMode = BABYLON.Material.MATERIAL_ALPHATESTANDBLEND;
    flagMat.backFaceCulling = false;
    flagMat.specularColor = new BABYLON.Color3(0, 0, 0);
    flagPlane.material = flagMat;
    flagPlane.billboardMode = BABYLON.Mesh.BILLBOARDMODE_NONE;

    // Use cached flag textures (already loaded once)
    const flagTextures = PinManager.flagTexturesCache;

    // ── Hole in the green ──
    const hole = BABYLON.MeshBuilder.CreateDisc(
      "hole",
      { radius: cfg.HOLE_RADIUS, tessellation: 24 },
      scene,
    );
    hole.position = position.clone();
    hole.position.y = cfg.HOLE_Y_OFFSET;
    hole.rotation.x = Math.PI / 2;
    hole.isPickable = false; // Hole is decorative, doesn't need picking

    const holeMat = new BABYLON.StandardMaterial("holeMat", scene);
    holeMat.diffuseColor = new BABYLON.Color3(0, 0, 0);
    holeMat.specularColor = new BABYLON.Color3(0, 0, 0);
    hole.material = holeMat;

    this.pins.push({
      mesh: pole,
      body: poleBody,
      poleMat, // per-pin — must be disposed with the pin
      stripeTexture, // per-pin DynamicTexture — must be disposed with the pin
      flagMesh: flagPlane,
      flagPivot,
      flagMat, // per-pin (its diffuseTexture is the shared flagTexturesCache)
      flagTextures,
      hole, // per-pin cup disc mesh
      holeMat, // per-pin
      flagAnimTime: 0,
      flagAnimFrame: 0,
      holePosition: position.clone(),
    });
  }

  addGreen(centerPos, radius, scene) {
    // Create a slightly concave green using a squashed sphere
    const green = BABYLON.MeshBuilder.CreateSphere(
      "green",
      { diameter: radius * 2, segments: 32 },
      scene,
    );
    // Squash vertically to create a subtle bowl shape
    green.scaling = new BABYLON.Vector3(1, 0.01, 1);
    green.position = centerPos.clone();
    green.position.y = 0.001; // Flush with ground
    green.isPickable = false; // Disable picking - greens are decorative

    const greenMat = Utils.createMaterial(
      `greenMat_${Math.random()}`,
      scene,
      new BABYLON.Color3(0.38, 0.72, 0.18),
      new BABYLON.Color3(0.01, 0.02, 0.005), // Very low specular for matte grass
      2, // Very low power for natural grass finish
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

    // Physics: a thin invisible CYLINDER with real thickness instead of a ~2000-tri
    // MESH collider on the squashed sphere. Much cheaper (no triangle soup + wasted
    // underside), and the thickness prevents fast landings from tunnelling through.
    const colThickness = 1.0;
    const greenTopY = green.position.y + radius * 0.01; // squashed-sphere apex
    const greenCol = BABYLON.MeshBuilder.CreateCylinder(
      "greenCol",
      { diameter: radius * 2, height: colThickness, tessellation: 24 },
      scene,
    );
    greenCol.position = new BABYLON.Vector3(
      centerPos.x,
      greenTopY - colThickness / 2,
      centerPos.z,
    );
    greenCol.isVisible = false;
    greenCol.isPickable = false;
    const greenPhysics = new BABYLON.PhysicsAggregate(
      greenCol,
      BABYLON.PhysicsShapeType.CYLINDER,
      { mass: 0, friction: 3.0, restitution: 0.1 },
      scene,
    );

    this.greens.push({ mesh: green, body: greenPhysics, collider: greenCol });
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

    // Only check pins within sink detection radius (spatial culling)
    for (const pin of this.pins) {
      const holePos = pin.holePosition;
      if (!holePos) continue;
      if (pin.sunk) continue; // already sunk — don't re-snap/re-emit every frame

      // Skip pins too far away
      const distance3D = BABYLON.Vector3.Distance(ballPos, holePos);
      if (distance3D > this.SINK_CHECK_RADIUS) {
        continue;
      }

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
        this.golfBall.mesh.position.y = CONFIG.PINS.HOLE_Y_OFFSET - 0.25;
        this.golfBall.landed = true;
        pin.sunk = true;
        this.eventManager.emit("pin:holesink", holePos);
      }
    }
  }

  checkPinCollisions() {
    const ballPos = this.golfBall.getPosition();
    const ballSpeed = this.golfBall.getSpeed();

    // Only check pins within collision detection radius (spatial culling)
    for (const pin of this.pins) {
      const distance = BABYLON.Vector3.Distance(ballPos, pin.mesh.position);

      // Skip pins too far away
      if (distance > this.COLLISION_CHECK_RADIUS) {
        continue;
      }

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
    // Camera angle convention is opposite to aimView, so negate it.
    // setCameraAngleImmediate normalizes BOTH cameraAngle and targetCameraAngle;
    // don't re-assign the raw (un-normalized) value or the follow-cam lerps a
    // full 360° spin when the pin is dead ahead (cameraRotation ≈ 2π).
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
    this.game._awaitingSettle = false; // new shot cancels any pending settle→aim
    this.game.currentHoleShotCount++; // Increment shot count for current hole

    // Update UI for play mode
    if (this.game.circleUIManager) {
      this.game.circleUIManager.showStatsCircle();
      this.game.circleUIManager.showPowerCircle();
      this.game.circleUIManager.hideClubCircle();
      // Keep compass visible at all times
      this.game.circleUIManager.showCompassCircle();
    }

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
   * Reset current shot: go back to AIM for another attempt on this hole
   * Keeps previous shots' trails visible
   */
  resetShot() {
    this.game.golfBall.reset();
    this.game.ballTrail.clear();
    this.game.ballTrail.setVisible(false);
    // DON'T clear archived trails - we want to see previous shots
    this.game.gameState = GameState.AIM;
    this.game.golfBallFacingCamera = false;
    this.game.swingCameraRestored = false;

    if (this.game.clubSystem) {
      this.game.clubSystem.resetClubs();
    }

    // Update UI for aim mode
    if (this.game.circleUIManager) {
      this.game.circleUIManager.hidePowerCircle();
    }

    if (this.game.aimView) {
      this.game.aimView.cameraRotation = 0; // Face toward center from north side
      this.game.aimView.activate(); // Re-enable orbit controls
    }
  }

  /**
   * Reset for next hole: clear everything for a fresh start
   */
  resetForNextHole() {
    this.game.golfBall.reset();
    this.game.ballTrail.clear();
    this.game.ballTrail.setVisible(false);
    this.game.clearArchivedTrails(); // Clear all shot trails from this hole
    this.game.gameState = GameState.AIM;
    this.game.golfBallFacingCamera = false;
    this.game.swingCameraRestored = false;

    if (this.game.clubSystem) {
      this.game.clubSystem.resetClubs();
    }

    // Update UI for aim mode
    if (this.game.circleUIManager) {
      this.game.circleUIManager.hidePowerCircle();
    }

    if (this.game.aimView) {
      this.game.aimView.cameraRotation = 0; // Face toward center from north side
      this.game.aimView.activate(); // Re-enable orbit controls
    }
  }

  /**
   * Toggle between AIM and PLAY modes (when clicking club circle)
   */
  toggleMode() {
    if (this.game.gameState === GameState.AIM) {
      // Click club circle while in AIM mode → go to PLAY (like clicking ball)
      // But we need to know the aimed direction - use the current aimView camera rotation
      if (this.game.aimView) {
        this.transitionAimToPlay(this.game.aimView.cameraRotation);
      }
    } else if (this.game.gameState === GameState.PLAY) {
      // Click club circle while in PLAY mode → reset current shot (go back to AIM)
      this.resetShot();
    }
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
  static async createEnvironment(scene, opts = {}) {
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

    // Ground disc with distant horizon dressing.
    // Course mode skips the flat playable disc (each hole ships its own terrain)
    // but keeps the distant hills + water backdrop.
    if (opts.skipGround) {
      this.createRollingHillsRing(scene, 183);
      this.createTallerHillsRing(scene, 183);
      this.createWaterRing(scene, 183);
    } else {
      this.createGroundDisc(scene);
    }

    // Initialize and load bird flock system
    scene.birdFlockSystem = new BirdFlockSystem(scene, 0, 0);
    await scene.birdFlockSystem.load();
  }

  static createGroundDisc(scene) {
    const radius = 183; // 400 yard diameter (200 yard radius)

    // Create a large flat ground disc
    const ground = BABYLON.MeshBuilder.CreateDisc(
      "groundDisc",
      {
        radius: radius,
        tessellation: 64,
      },
      scene,
    );

    // Lay it flat
    ground.rotation.x = Math.PI / 2;
    ground.position.y = 0;

    // Tiled terrain material using repeatable diffuse + normal textures
    const groundMat = Utils.createMaterial(
      "groundDiscMat",
      scene,
      new BABYLON.Color3(0.25, 0.5, 0.15),
      new BABYLON.Color3(0.02, 0.02, 0.02), // Much darker specular for matte
      4, // Lower power for matte finish
    );

    const diffuseTex = new BABYLON.Texture(CONFIG.TERRAIN.TEXTURE_PATH, scene);
    diffuseTex.wrapU = BABYLON.Texture.WRAP_ADDRESSMODE;
    diffuseTex.wrapV = BABYLON.Texture.WRAP_ADDRESSMODE;
    diffuseTex.uScale = 50;
    diffuseTex.vScale = 50;
    groundMat.diffuseTexture = diffuseTex;

    const normalTex = new BABYLON.Texture(
      CONFIG.TERRAIN.NORMAL_MAP_PATH,
      scene,
    );
    normalTex.wrapU = BABYLON.Texture.WRAP_ADDRESSMODE;
    normalTex.wrapV = BABYLON.Texture.WRAP_ADDRESSMODE;
    normalTex.uScale = 50;
    normalTex.vScale = 50;
    groundMat.bumpTexture = normalTex;

    ground.material = groundMat;
    ground.receiveShadows = true;
    ground.isPickable = false; // Disable picking - terrain doesn't need raycasting

    // Physics for terrain - create a separate collision body for reliable ground
    // Use a thin box as an invisible collision layer
    const collisionBox = BABYLON.MeshBuilder.CreateBox(
      "groundCollision",
      {
        width: radius * 2 * 1.1, // Slightly larger than disc
        height: 1, // Thin enough to not interfere but enough for collision
        depth: radius * 2 * 1.1,
      },
      scene,
    );
    collisionBox.position.y = -0.5; // Position so top surface is at y=0
    collisionBox.visibility = 0; // Invisible

    const groundAggregate = new BABYLON.PhysicsAggregate(
      collisionBox,
      BABYLON.PhysicsShapeType.BOX,
      {
        mass: 0,
        friction: CONFIG.TERRAIN.FRICTION,
        restitution: CONFIG.TERRAIN.RESTITUTION,
      },
      scene,
    );
    scene.groundPhysicsBody = groundAggregate.body;

    // Add a low-poly distant horizon just beyond the playable disc.
    this.createRollingHillsRing(scene, radius);

    // Add a second ring of taller random hills
    this.createTallerHillsRing(scene, radius);

    // Create water disc around the ground - extends to middle of first hills
    this.createWaterRing(scene, radius);

    return ground;
  }

  static createRollingHillsRing(scene, groundRadius) {
    const segments = 32;
    const innerRadius = groundRadius + 120;
    const outerRadius = groundRadius + 320;
    const baseHeight = -10;
    const maxRise = 55;
    const innerPath = [];
    const outerPath = [];

    for (let index = 0; index <= segments; index++) {
      const angle = (index / segments) * Math.PI * 2;
      const cosAngle = Math.cos(angle);
      const sinAngle = Math.sin(angle);
      const rollingHeight =
        0.55 +
        0.22 * Math.sin(angle * 2.3 + 0.4) +
        0.15 * Math.sin(angle * 5.1 - 0.9) +
        0.08 * Math.cos(angle * 9.2 + 0.7);

      innerPath.push(
        new BABYLON.Vector3(
          cosAngle * innerRadius,
          baseHeight + 6,
          sinAngle * innerRadius,
        ),
      );

      outerPath.push(
        new BABYLON.Vector3(
          cosAngle * outerRadius,
          baseHeight + Math.max(0, rollingHeight) * maxRise,
          sinAngle * outerRadius,
        ),
      );
    }

    const hillsRing = BABYLON.MeshBuilder.CreateRibbon(
      "rollingHillsRing",
      {
        pathArray: [innerPath, outerPath],
        closePath: true,
        closeArray: false,
        sideOrientation: BABYLON.Mesh.DOUBLESIDE,
      },
      scene,
    );

    hillsRing.convertToFlatShadedMesh();
    hillsRing.receiveShadows = false;
    hillsRing.isPickable = false;
    // Let Babylon frustum cull hills (they're far away and large)

    const hillsMaterial = Utils.createMaterial(
      "rollingHillsMat",
      scene,
      new BABYLON.Color3(0.34, 0.47, 0.28),
      BABYLON.Color3.Black(),
      1,
    );
    hillsMaterial.backFaceCulling = false;

    hillsRing.material = hillsMaterial;

    return hillsRing;
  }

  static createTallerHillsRing(scene, groundRadius) {
    // Create a second ring of taller random hills beyond the first hills ring
    const segments = 32;
    const innerRadius = groundRadius + 320; // Start where first hills end
    const outerRadius = groundRadius + 620; // Extend further out
    const baseHeight = -10;
    const maxRise = 120; // Taller than first ring (which is 55)
    const innerPath = [];
    const outerPath = [];

    for (let index = 0; index <= segments; index++) {
      const angle = (index / segments) * Math.PI * 2;
      const cosAngle = Math.cos(angle);
      const sinAngle = Math.sin(angle);

      // More chaotic, taller random variations
      const rollingHeight =
        0.7 +
        0.35 * Math.sin(angle * 1.7 + 1.2) +
        0.25 * Math.sin(angle * 4.3 - 1.5) +
        0.15 * Math.cos(angle * 7.9 + 2.1) +
        0.12 * Math.sin(angle * 11.2 - 0.8);

      innerPath.push(
        new BABYLON.Vector3(
          cosAngle * innerRadius,
          baseHeight + 12,
          sinAngle * innerRadius,
        ),
      );

      outerPath.push(
        new BABYLON.Vector3(
          cosAngle * outerRadius,
          baseHeight + Math.max(0, rollingHeight) * maxRise,
          sinAngle * outerRadius,
        ),
      );
    }

    const tallHillsRing = BABYLON.MeshBuilder.CreateRibbon(
      "tallerHillsRing",
      {
        pathArray: [innerPath, outerPath],
        closePath: true,
        closeArray: false,
        sideOrientation: BABYLON.Mesh.DOUBLESIDE,
      },
      scene,
    );

    tallHillsRing.convertToFlatShadedMesh();
    tallHillsRing.receiveShadows = false;
    tallHillsRing.isPickable = false;
    // Let Babylon frustum cull hills (they're far away and large)

    const tallHillsMaterial = Utils.createMaterial(
      "tallerHillsMat",
      scene,
      new BABYLON.Color3(0.28, 0.38, 0.2), // Slightly darker shade
      BABYLON.Color3.Black(),
      1,
    );
    tallHillsMaterial.backFaceCulling = false;

    tallHillsRing.material = tallHillsMaterial;

    return tallHillsRing;
  }

  static createWaterRing(scene, groundRadius) {
    // Create water disc extending to the middle of the hills
    // First hills go from (groundRadius + 120) to (groundRadius + 320)
    // Middle is at (groundRadius + 220)
    const waterRadius = groundRadius + 220;

    const waterDisc = BABYLON.MeshBuilder.CreateDisc(
      "waterRing",
      {
        radius: waterRadius,
        tessellation: 128,
      },
      scene,
    );

    // Lay it flat, separated to avoid z-fighting
    waterDisc.rotation.x = Math.PI / 2;
    waterDisc.position.y = -2.0;

    // Custom water material with diffuse and normal maps
    const waterMat = new BABYLON.PBRMaterial("sonicWater", scene);

    // Load textures
    const diffuseTex = new BABYLON.Texture("./assets/texture/water.png", scene);
    diffuseTex.wrapU = BABYLON.Texture.WRAP_ADDRESSMODE;
    diffuseTex.wrapV = BABYLON.Texture.WRAP_ADDRESSMODE;
    diffuseTex.uScale = 4;
    diffuseTex.vScale = 4;
    waterMat.albedoTexture = diffuseTex;

    const normalTex = new BABYLON.Texture(
      "./assets/texture/waternormals.png",
      scene,
    );
    normalTex.wrapU = BABYLON.Texture.WRAP_ADDRESSMODE;
    normalTex.wrapV = BABYLON.Texture.WRAP_ADDRESSMODE;
    normalTex.uScale = 4;
    normalTex.vScale = 4;
    waterMat.bumpTexture = normalTex;

    // PBR water: high metallic and low roughness for Sonic water shine
    waterMat.metallic = 0.8;
    waterMat.roughness = 0.2;
    waterMat.alpha = 0.85;
    waterMat.backFaceCulling = false;

    waterDisc.material = waterMat;
    waterDisc.isPickable = false; // Disable picking - decorative water doesn't need raycasting
    scene.waterRing = waterDisc;

    // Store animation state on the water disc
    waterDisc.waterAnimTime = 0;
    waterDisc.diffuseTex = diffuseTex;
    waterDisc.normalTex = normalTex;

    // Add fog for mist effect on the outer water ring
    scene.fogMode = BABYLON.Scene.FOGMODE_NONE;
  }
}

// ─── MONEY PARTICLE SYSTEM ───────────────────────────────────────────────────

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
    if (this.positions.length < 2) {
      return;
    }

    // Update ONE updatable LinesMesh in place rather than disposing + rebuilding
    // a fresh mesh (new vertex buffer + GC) on every point. The buffer is a fixed
    // maxPoints size; unused tail slots repeat the tip (degenerate segments), so
    // the vertex count never changes and we can pass `instance:`.
    const pts = this.positions;
    const cap = this.maxPoints;
    const buf = this._lineBuf || (this._lineBuf = new Array(cap));
    const tip = pts[pts.length - 1];
    for (let i = 0; i < cap; i++) buf[i] = i < pts.length ? pts[i] : tip;

    if (!this.line) {
      this.line = BABYLON.MeshBuilder.CreateLines(
        "trail",
        { points: buf, updatable: true },
        this.scene,
      );
      this.line.color = new BABYLON.Color3(1, 0.15, 0.15);
      this.line.alpha = 0.95;
      this.line.isPickable = false;
    } else {
      this.line = BABYLON.MeshBuilder.CreateLines(
        "trail",
        { points: buf, instance: this.line },
        this.scene,
      );
    }
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
        "assets/3d/",
        "clubs.glb",
        this.scene,
      );

      // Wrap the GLB root in a pivot node so we never overwrite its
      // built-in coordinate conversion (GLBs bake scaling/rotation into __root__)
      this.clubPivot = new BABYLON.TransformNode("clubPivot", this.scene);
      this.clubPivot.position = ballPosition.clone();
      // Match the real golf-ball scale (clubs.glb is authored at the old ~0.4 m
      // ball size); shrink the whole rig ~9.4× so the club fits the 42.7 mm ball.
      this.clubPivot.scaling = new BABYLON.Vector3(0.107, 0.107, 0.107);
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

      // Stop club animations from looping (skip bird animations)
      for (const animGroup of this.scene.animationGroups) {
        if (
          animGroup.name.startsWith("idle") ||
          animGroup.name.startsWith("flap")
        )
          continue;
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

    // Stop any running club animations (skip bird animations)
    for (const animGroup of this.scene.animationGroups) {
      if (
        animGroup.name.startsWith("idle") ||
        animGroup.name.startsWith("flap")
      )
        continue;
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
      if (
        animGroup.name.startsWith("idle") ||
        animGroup.name.startsWith("flap")
      )
        continue;
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
    // (No sub-stepping: the Havok V2 plugin steps the world once per frame by the
    // frame delta and ignores the engine's subTimeStep, so setSubTimeStep(1/240)
    // was a no-op. Tunneling of the real-size ball is handled by the swept guard
    // GolfBallGuy.preventTunneling(), not by a higher physics rate.)
    return physicsPlugin;
  }
}

// ─── MAIN GAME ORCHESTRATOR ────────────────────────────────────────────────
// Core game loop, state management, and system initialization.

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

    // Face state tracking
    this.lastBallVelocity = new BABYLON.Vector3(0, 0, 0);
    this.wasHit = false;
    this.hitCooldown = 0;

    // Coordinators (initialized after scene setup)
    this.swingCoordinator = null;
    this.cameraCoordinator = null;

    // Compass transition tracking for smooth mode switches
    this.compassTransitionFrames = 0;
    this.compassTransitionDuration = 3; // frames to blend rotation sources
    this.compassElements = null; // Cache DOM elements
    this.lastCompassAngle = null; // Cache last arrow angle
    this.lastCompassRotate = null; // Cache last compass rotation
    this.lastWindSpeedDisplay = null; // Cache last wind speed display
    this.gameStateCoordinator = null;

    // Pin tracking for auto-aim
    this.lastPinPosition = null;
    this.pinIndicatorArrow = null;

    // Hole tracking
    this.currentHolePin = null;
    this.currentHoleShotCount = 0;
    this.holeSinkProcessed = false; // Guard against repeated holesink events

    // Trail archiving for multi-shot hole review
    this.shotTrails = []; // Store trails from each shot in the hole

    // Control state during review
    this.isControlsDisabled = false; // Disable all input during shot review
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

    // Initialize pin indicator arrow
    this.pinIndicatorArrow = new PinIndicatorArrow(this.scene);

    // Setup
    await PhysicsManager.initialize(this.scene);
    if (BABYLON.PhysicsViewer) {
      this.physicsViewer = new BABYLON.PhysicsViewer(this.scene);
    }
    const courseMode = this.mode === "course";
    await SceneSetup.createEnvironment(this.scene, { skipGround: courseMode });

    // Load models
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

    // Initialize grass system
    this.grassSystem = new GrassSystem(this.scene);
    await this.grassSystem.initialize();

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

    // Wire club circle click to mode toggle
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
    bodyMesh.isPickable = false; // Ball is invisible, doesn't need raycasting

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
    let result;
    try {
      result = await BABYLON.SceneLoader.ImportMeshAsync(
        "",
        "assets/3d/",
        "gball.glb",
        this.scene,
      );
    } catch (e) {
      // Non-fatal: the ball still has its physics body + collider mesh, it just
      // won't have the character face/skeleton. Don't kill the whole game.
      console.warn("Character model (gball.glb) failed to load; continuing without it.", e);
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
      // Start compass transition blend
      this.compassTransitionFrames = 0;
      // Ensure aimView is fully deactivated after transitioning
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
      this.gameStateCoordinator.resetShot();
      // resetShot() abandons current shot and returns to AIM mode
    });
  }

  disableControls() {
    // Disable gameplay controls but keep orbit controls active for camera movement
    this.isControlsDisabled = true;

    // Keep aimView ACTIVE for orbit controls during review
    // Don't deactivate it - we want the camera to be orbitable

    // Hide all UI circles during review
    if (this.circleUIManager) {
      this.circleUIManager.hideAllCircles();
    }
  }

  enableControls() {
    // Re-enable controls
    this.isControlsDisabled = false;

    // Re-enable UI circles
    if (this.circleUIManager) {
      this.circleUIManager.showAllCircles();
    }
  }

  showShotReviewMessage(holeNumber, shotCount) {
    // Disable all controls during review
    this.disableControls();

    // Create container div positioned at center
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

    // Create message
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
      this.scene.pinManager?.pins?.forEach((p) => (p.sunk = false));
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

    // Generate random pin positions outside a 100-yard radius from player
    const playerPos = this.ballStartPosition; // (0, 0, 150)
    const minDistance = 91.44; // 100 yards in meters
    const discRadius = 183; // Match ground disc radius
    const numPins = 5;
    const greenPositions = [];

    while (greenPositions.length < numPins) {
      // Random angle and distance from origin
      const angle = Math.random() * Math.PI * 2;
      const maxDistance = discRadius - 25; // 25m buffer from edge
      const distance =
        minDistance + Math.random() * (maxDistance - minDistance - 30); // Leave buffer for green radius

      const x = Math.cos(angle) * distance;
      const z = Math.sin(angle) * distance;
      const pos = new BABYLON.Vector3(x, 0, z);

      // Check if far enough from player
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
      pinManager.addGreen(pos, 12, this.scene);
      pos.y = 0.2;
      pinManager.addPin(pos, this.scene);
    }

    this.scene.pinManager = pinManager;
    this.eventManager.on("pin:hit", (pinPos) => {
      // Handle pin hit if needed
    });

    this.eventManager.on("pin:holesink", (holePos) => {
      // Guard against repeated holesink events from ball vibrating in hole
      if (this.holeSinkProcessed) return;
      this.holeSinkProcessed = true;
      // Disable orbit controls before transitioning to shot review
      if (this.aimView) {
        this.aimView.isActive = false;
        this.aimView.removeOrbitControls();
      }
      // Show all archived trails for the hole overview
      this.showArchivedTrails();
      // Transition to shot review view when hole is sunk
      this.camera.setShotReviewView();

      if (this.scene.pinManager && this.scene.pinManager.pins) {
        const holeNumber =
          this.scene.pinManager.pins.findIndex(
            (pin) => BABYLON.Vector3.Distance(pin.holePosition, holePos) < 1,
          ) + 1;
        this.eventManager.emit("game:showShotReview", {
          holeNumber,
          shotCount: this.currentHoleShotCount,
        });
      }
      this.currentHolePin = null; // Reset hole tracking
      this.currentHoleShotCount = 0;
      // Play resumes when the player clicks "Continue" on the review overlay
      // (showShotReviewMessage → resetForNextHole).
    });

    // Listen for shot review event
    this.eventManager.on("game:showShotReview", (reviewData) => {
      this.showShotReviewMessage(reviewData.holeNumber, reviewData.shotCount);
    });
  }

  updateBallState() {
    const landingState = this.golfBall.updateLandingState();
    if (landingState === "fullLand") {
      this.ballTrail.stopTracing();
      this.ballTrail.setVisible(false); // Hide trail after landing
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

    // Enter aim mode only after the ball has stopped completely for 1 second.
    if (this._awaitingSettle && this.gameState !== GameState.AIM) {
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

    // Update character face based on ball state
    this.updateCharacterFace();
  }

  updateCharacterFace() {
    if (!this.golfBall) return;

    // Skip expensive face updates during PLAY mode (optimize for moving ball)
    // Keep face at last known state during play, update in AIM mode
    if (this.gameState === GameState.PLAY) {
      // Still update face transitions and blinking for consistency
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

  archiveCurrentTrail() {
    // Store the current ball trail with a unique color for this shot
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

    // Clone the trail line mesh with the new color
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
    // Dispose of all archived trails for this hole
    for (const { trail } of this.shotTrails) {
      if (trail) {
        trail.dispose();
      }
    }
    this.shotTrails = [];
    this.holeSinkProcessed = false; // Reset guard for next hole
  }

  showArchivedTrails() {
    // Show all archived trails for hole sink overview
    for (const { trail } of this.shotTrails) {
      if (trail) {
        trail.setEnabled(true);
      }
    }
  }

  setupCompass() {
    // CircleUIManager already created the compass SVG - just setup wind control
    this.setupWindControl();
  }

  setupWindControl() {
    const svg = this.circleUIManager.getCompassSvg();
    if (!svg) return;
    // Course mode: wind is a fixed per-hole condition, not a player control —
    // the compass still displays it, but dragging/clicking it does nothing.
    if (this.mode === "course") return;

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
    // Skip compass updates during PLAY mode for performance
    if (this.gameState === GameState.PLAY) return;

    // Cache DOM elements on first call
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

    // Determine rotation source with smooth transition between modes
    let cameraAngleDeg = 0;
    const isTransitioning =
      this.compassTransitionFrames < this.compassTransitionDuration;

    if (isTransitioning) {
      // During transition, blend between aimView and camera angle
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
      // In aim view, use aimView's camera rotation
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

    // Slow circular flow
    const flowSpeed = 0.3; // Slow circular animation
    const circularFlow = waterRing.waterAnimTime * flowSpeed;

    waterRing.diffuseTex.uOffset = Math.cos(circularFlow) * 0.15;
    waterRing.diffuseTex.vOffset = Math.sin(circularFlow) * 0.15;
    waterRing.normalTex.uOffset = Math.cos(circularFlow) * 0.075;
    waterRing.normalTex.vOffset = Math.sin(circularFlow) * 0.075;
  }

  setupRenderLoop() {
    this.scene.registerBeforeRender(() => {
      // Update wind system
      this.wind.update();
      this.updateCompass();

      // Apply wind force to airborne ball
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
      // Grow grass around the CAMERA, not the ball, and NOT while the ball is moving
      // fast: in flight the camera chases the ball across a chunk boundary every few
      // frames, and each rebuild's buffer alloc + GPU upload (~5 ms) spikes the frame
      // — which, against the smoothed follow-cam, reads as the ball jittering. Gated
      // on speed (not isAirborne(), which is unreliable at rest when heightRef lags);
      // grass resumes as the ball slows to a stop.
      if (this.golfBall.getSpeed() < CONFIG.GRASS.FREEZE_ABOVE_SPEED) {
        this.grassSystem?.update(
          this.camera?.camera?.position || this.golfBall.getPosition(),
          pinPositions,
        );
      }
      if (this.cloudSystem) {
        this.cloudSystem.update(this.golfBall.getPosition(), this.wind);
      }

      // Update bird flock system
      if (this.scene.birdFlockSystem) {
        this.scene.birdFlockSystem.update(
          this.engine.getDeltaTime() / 1000,
          this.golfBall.getPosition(),
          this.golfBall.getVelocity(),
        );
      }

      // Update pin indicator arrow
      if (this.pinIndicatorArrow && this.lastPinPosition) {
        if (!this.pinIndicatorArrow.arrow) {
          this.pinIndicatorArrow.create(this.lastPinPosition);
        }
        this.pinIndicatorArrow.update(this.engine.getDeltaTime() / 1000);
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
// COURSE MODE — 3-hole match play (loads Blender-authored hole .glb files)
// ═════════════════════════════════════════════════════════════════════════════

// Per-hole definition. Tee, pin/cup and tree placements come from marker meshes
// baked into each .glb; only par/name/notes live here.
// Bump when hole .glb geometry is rebuilt (assets are served immutable-cached).
const HOLE_ASSET_VERSION = "flattee2";
const COURSE_HOLES = [
  { id: 1, glb: "assets/3d/holes/hole1.glb", par: 4, name: "Wet and Wild" },
  { id: 2, glb: "assets/3d/holes/hole2.glb", par: 3, name: "Rock and Roll" },
  { id: 3, glb: "assets/3d/holes/hole3.glb", par: 5, name: "On a Bender" },
];

// Physics + friction per surface type. Golf-ball-scale tuning: rough grabs, greens
// roll true, sand plugs, the desert rock face bounces balls back toward the green.
const SURFACE_PHYSICS = {
  // Grass friction ordering: green fastest (least), fairway medium, rough grabbiest.
  green: { friction: 0.9, restitution: 0.1 }, // least → true, fast roll
  fairway: { friction: 1.8, restitution: 0.3 }, // middle
  rough: { friction: 4.5, restitution: 0.2 }, // most → ball stops
  sand: { friction: 10.0, restitution: 0.05 }, // plush bunker sand: plugs
  desert: { friction: 2.8, restitution: 0.35 }, // firm rocky hardpan
  rock: { friction: 0.5, restitution: 0.6 }, // rock face: lucky bounces
};

/**
 * Loads decor.glb once and stamps instanced copies (trees/rocks) so many
 * placements share geometry. Sources are parked far below the course.
 */
class CourseDecor {
  constructor(scene) {
    this.scene = scene;
    this.sources = {};
  }

  async load() {
    let res;
    try {
      res = await BABYLON.SceneLoader.ImportMeshAsync(
        "",
        "assets/3d/",
        "decor.glb",
        this.scene,
      );
    } catch (e) {
      // Non-fatal: without decor sources, place() returns null and holes simply
      // render with no trees/rocks rather than the whole round failing to load.
      console.warn("Decor model (decor.glb) failed to load; holes will have no trees/rocks.", e);
      return;
    }
    for (const name of ["tree1", "tree2", "tree3", "rock1", "rock2", "rock3"]) {
      const node =
        res.meshes.find((m) => m.name === name) ||
        (res.transformNodes || []).find((n) => n.name === name);
      if (!node) continue;
      node.setParent(null); // bake the glTF handedness transform into the node
      node.position = new BABYLON.Vector3(0, -1000, 0); // park source off-course
      node.setEnabled(true);
      this.sources[name] = node;
    }
  }

  place(type, position, yaw = 0, scale = 1) {
    const src = this.sources[type];
    if (!src) return null;
    const inst = src.instantiateHierarchy(null, { doNotInstantiate: false });
    if (!inst) return null;
    inst.position = position.clone();
    inst.rotation = new BABYLON.Vector3(0, yaw, 0);
    inst.rotationQuaternion = null;
    inst.scaling = new BABYLON.Vector3(scale, scale, scale);
    inst.setEnabled(true);
    inst.getChildMeshes().forEach((m) => {
      m.isPickable = false;
      m.receiveShadows = true;
    });
    return inst;
  }
}

/**
 * Shared world-projected (triplanar) materials so hole terrain matches the
 * existing grass/water/sand look without needing UVs baked into the glb.
 */
class CourseSurfaces {
  constructor(scene) {
    this.scene = scene;
    this.mats = {};
  }

  // Terrain meshes carry planar world (x,y) UVs, so tiling = 1/tileWorld units.
  _tex(path, tileWorld) {
    const t = new BABYLON.Texture(path, this.scene);
    t.wrapU = t.wrapV = BABYLON.Texture.WRAP_ADDRESSMODE;
    t.uScale = t.vScale = 1 / tileWorld;
    return t;
  }

  _std(name, texPath, tileWorld, color, normalPath) {
    const m = new BABYLON.StandardMaterial(name, this.scene);
    m.diffuseColor = color;
    m.specularColor = new BABYLON.Color3(0.02, 0.02, 0.02);
    m.specularPower = 8;
    m.diffuseTexture = this._tex(texPath, tileWorld);
    if (normalPath) m.bumpTexture = this._tex(normalPath, tileWorld);
    return m;
  }

  build() {
    const C = BABYLON.Color3;
    const T = CONFIG.TERRAIN;
    const P = CONFIG.PINS;
    // rough = dark painted-grass texture; fairway/green = brighter putting texture.
    // Fine tiling (small world size per tile) so the painted grass reads at ball scale.
    this.mats.rough = this._std(
      "courseRough",
      T.TEXTURE_PATH,
      2.5,
      new C(0.42, 0.62, 0.28),
      T.NORMAL_MAP_PATH,
    );
    this.mats.fairway = this._std(
      "courseFairway",
      P.GREEN_TEXTURE_PATH,
      2.5,
      new C(0.62, 0.8, 0.42),
      P.GREEN_NORMAL_MAP_PATH,
    );
    this.mats.green = this._std(
      "courseGreen",
      P.GREEN_TEXTURE_PATH,
      1.6,
      new C(0.5, 0.82, 0.28),
      P.GREEN_NORMAL_MAP_PATH,
    );
    this.mats.sand = this._std(
      "courseSand",
      "assets/texture/sand.png",
      3,
      new C(0.96, 0.9, 0.76),
      null,
    );
    this.mats.desert = this._std(
      "courseDesert",
      "assets/texture/sand.png",
      3.5,
      new C(0.94, 0.87, 0.72),
      null,
    );
    this.mats.rock = new BABYLON.StandardMaterial("courseRock", this.scene);
    this.mats.rock.diffuseColor = new C(0.46, 0.44, 0.41);
    this.mats.rock.specularColor = new C(0.05, 0.05, 0.05);

    // Water: bright translucent like the distant water ring
    const water = new BABYLON.PBRMaterial("courseWater", this.scene);
    water.albedoTexture = this._tex("assets/texture/water.png", 10);
    water.bumpTexture = this._tex("assets/texture/waternormals.png", 10);
    water.metallic = 0.6;
    water.roughness = 0.25;
    water.alpha = 0.82;
    water.transparencyMode = BABYLON.Material.MATERIAL_ALPHABLEND;
    water.backFaceCulling = true; // only ever viewed from above — skip the underside
    this.mats.water = water;
    return this.mats;
  }

  // Surface-name → material/physics key. These `surf_*` substrings are a CONTRACT
  // with the hole authoring pipeline: course_design/hole_gen.py writes the mesh
  // names (surf_rough/fairway/green/sand/desert/rockface/water, marker_tee/pin,
  // tree_*/rock_*) and the runtime decodes them here + in buildHeightGrid,
  // BirdFlockSystem.sampleSurface, and CourseManager.loadHole. Rename on one side
  // → update the other, or physics/decor/birds silently break.
  forSurfaceName(name) {
    const n = name.toLowerCase();
    if (n.includes("underwater")) return "rough"; // submerged basin floor
    if (n.includes("water")) return "water";
    if (n.includes("green")) return "green";
    if (n.includes("fairway")) return "fairway";
    if (n.includes("desert")) return "desert";
    if (n.includes("sand")) return "sand";
    if (n.includes("rock")) return "rock"; // rock face backstop
    return "rough"; // rough + rough_underwater
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
          Math.max(0, Math.min(1, local)),
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

/** Small top-of-screen hole banner + transient flash messages. */
class CourseHUD {
  constructor() {
    CourseUI.ensureStyles();
    this.banner = document.createElement("div");
    this.banner.className = "course-banner";
    this.banner.style.display = "none";
    this.flashEl = document.createElement("div");
    this.flashEl.className = "course-flash";
    this.flashEl.style.display = "none";
    document.body.appendChild(this.banner);
    document.body.appendChild(this.flashEl);
    this._flashTimer = null;
  }

  setHole(holeNum, par, name) {
    this.banner.innerHTML =
      `<span class="cb-num">HOLE ${holeNum}</span>` +
      `<span class="cb-par">PAR ${par}</span>` +
      `<span class="cb-name">${name}</span>`;
    this.banner.style.display = "flex";
  }

  flash(text, ms = 2200) {
    this.flashEl.textContent = text;
    this.flashEl.style.display = "block";
    this.flashEl.classList.remove("cf-show");
    void this.flashEl.offsetWidth; // restart animation
    this.flashEl.classList.add("cf-show");
    clearTimeout(this._flashTimer);
    this._flashTimer = setTimeout(() => {
      this.flashEl.style.display = "none";
    }, ms);
  }

  hide() {
    this.banner.style.display = "none";
  }
}

// Shared style injection + score naming for the course UI.
class CourseUI {
  static _styled = false;
  static ensureStyles() {
    if (CourseUI._styled) return;
    CourseUI._styled = true;
    const css = `
    .course-banner{position:absolute;top:14px;left:50%;transform:translateX(-50%);
      z-index:1400;display:flex;gap:14px;align-items:center;padding:8px 22px;
      border-radius:999px;font-family:'Trebuchet MS',Arial,sans-serif;font-weight:bold;
      color:#eafff0;background:linear-gradient(180deg,rgba(40,120,60,.92),rgba(20,80,38,.92));
      border:2px solid rgba(255,255,255,.5);
      box-shadow:0 6px 20px rgba(0,0,0,.35),inset 0 2px 8px rgba(255,255,255,.4);
      text-shadow:0 1px 2px rgba(0,0,0,.5);pointer-events:none;}
    .course-banner .cb-num{font-size:20px;letter-spacing:1px;}
    .course-banner .cb-par{font-size:15px;opacity:.9;background:rgba(255,255,255,.18);
      padding:2px 10px;border-radius:999px;}
    .course-banner .cb-name{font-size:15px;color:#d6f5c0;font-style:italic;}
    .course-flash{position:absolute;top:38%;left:50%;transform:translate(-50%,-50%);
      z-index:1600;font-family:'Trebuchet MS',Arial,sans-serif;font-weight:bold;font-size:46px;
      color:#eafff0;text-shadow:0 2px 10px rgba(0,0,0,.6),0 0 24px rgba(80,220,120,.6);
      pointer-events:none;text-align:center;}
    .course-flash.cf-show{animation:cfpop .5s cubic-bezier(.2,1.4,.4,1);}
    @keyframes cfpop{0%{transform:translate(-50%,-50%) scale(.4);opacity:0}
      60%{transform:translate(-50%,-52%) scale(1.08);opacity:1}
      100%{transform:translate(-50%,-50%) scale(1);opacity:1}}

    .balls-overlay{position:absolute;inset:0;z-index:2000;display:flex;align-items:center;
      justify-content:center;background:radial-gradient(circle at 50% 30%,rgba(135,207,235,.6),rgba(90,150,200,.75));
      font-family:'Trebuchet MS',Arial,sans-serif;-webkit-backdrop-filter:blur(2px);backdrop-filter:blur(2px);}
    .aero-card{background:linear-gradient(180deg,rgba(255,255,255,.96),rgba(232,245,235,.94));
      border:2px solid rgba(255,255,255,.85);border-radius:32px;padding:30px 40px 34px;min-width:320px;
      box-shadow:0 20px 60px rgba(0,60,20,.35),inset 0 3px 12px rgba(255,255,255,.9);
      text-align:center;position:relative;overflow:hidden;}
    .aero-card::before{content:'';position:absolute;top:0;left:0;right:0;height:46%;
      background:linear-gradient(180deg,rgba(255,255,255,.65),rgba(255,255,255,0));
      border-radius:32px 32px 60% 60%/32px 32px 30% 30%;pointer-events:none;}
    .aero-title{font-size:40px;font-weight:bold;color:#1e7a34;letter-spacing:1px;margin:0 0 4px;
      text-shadow:0 1px 0 #fff,0 2px 6px rgba(30,122,52,.25);}
    .aero-sub{font-size:15px;color:#3a7a4c;margin:0 0 22px;opacity:.85;}
    .aero-btn{display:inline-block;cursor:pointer;user-select:none;border:none;margin:6px;
      font-family:inherit;font-weight:bold;font-size:19px;color:#fff;padding:13px 30px;border-radius:999px;
      background:linear-gradient(180deg,#4fc46a,#2e8b48);
      box-shadow:0 6px 16px rgba(20,90,40,.4),inset 0 2px 6px rgba(255,255,255,.6);
      text-shadow:0 1px 2px rgba(0,0,0,.35);transition:transform .08s ease,filter .08s ease;}
    .aero-btn:hover{filter:brightness(1.07);}
    .aero-btn:active{transform:translateY(2px) scale(.98);filter:brightness(.95);}
    .aero-btn.secondary{background:linear-gradient(180deg,#e9f3ec,#c9ddce);color:#1e7a34;
      text-shadow:0 1px 0 rgba(255,255,255,.7);}
    .aero-stepper{display:flex;align-items:center;justify-content:center;gap:14px;margin:6px 0 20px;
      color:#1e7a34;font-weight:bold;font-size:18px;}
    .aero-step{width:38px;height:38px;border-radius:50%;border:none;cursor:pointer;font-size:22px;font-weight:bold;
      color:#fff;background:linear-gradient(180deg,#4fc46a,#2e8b48);
      box-shadow:0 3px 8px rgba(20,90,40,.4),inset 0 2px 4px rgba(255,255,255,.6);}
    .aero-step:disabled{opacity:.4;cursor:default;}
    .aero-modes{display:flex;gap:14px;justify-content:center;}

    .score-card{max-width:560px;width:88%;}
    .score-title{font-size:34px;}
    table.scorecard{border-collapse:separate;border-spacing:0;width:100%;margin:6px 0 20px;
      border-radius:16px;overflow:hidden;box-shadow:0 4px 12px rgba(0,60,20,.15);}
    table.scorecard th,table.scorecard td{padding:10px 8px;font-size:16px;text-align:center;}
    table.scorecard thead th{background:linear-gradient(180deg,#2e8b48,#1e6e36);color:#eafff0;
      font-weight:bold;text-shadow:0 1px 2px rgba(0,0,0,.4);}
    table.scorecard tbody td{color:#1e6e36;font-weight:bold;background:rgba(255,255,255,.85);
      border-bottom:1px solid rgba(30,110,54,.12);}
    table.scorecard tbody td.label{text-align:left;color:#2a7a44;}
    table.scorecard tr.total td{background:rgba(224,244,230,.95);font-size:18px;color:#12572a;}
    `;
    const s = document.createElement("style");
    s.textContent = css;
    document.head.appendChild(s);
  }

  static scoreName(strokes, par) {
    const d = strokes - par;
    if (strokes === 1) return "Hole in One!";
    if (d <= -3) return "Albatross!";
    if (d === -2) return "Eagle!";
    if (d === -1) return "Birdie!";
    if (d === 0) return "Par";
    if (d === 1) return "Bogey";
    if (d === 2) return "Double Bogey";
    return `+${d}`;
  }
}

/** Start menu: Practice sandbox vs 3-hole Course (with a player-count slot). */
class BallsMenu {
  static init(startFn) {
    CourseUI.ensureStyles();
    BallsMenu.startFn = startFn;
    BallsMenu.players = 1;
    BallsMenu.showModeSelect();
  }

  static _overlay(contentHtml) {
    const existing = document.getElementById("ballsMenu");
    if (existing) existing.remove();
    const o = document.createElement("div");
    o.id = "ballsMenu";
    o.className = "balls-overlay";
    o.innerHTML = `<div class="aero-card">${contentHtml}</div>`;
    document.body.appendChild(o);
    return o;
  }

  static showModeSelect() {
    const o = BallsMenu._overlay(`
      <div class="aero-title">BALLS GOLF</div>
      <div class="aero-sub">Be the ball.</div>
      <div class="aero-modes">
        <button class="aero-btn" id="mCourse">▶ Course</button>
        <button class="aero-btn secondary" id="mPractice">Practice</button>
      </div>
    `);
    o.querySelector("#mCourse").onclick = () => BallsMenu.showCourseStart();
    o.querySelector("#mPractice").onclick = () => {
      o.remove();
      BallsMenu.startFn({ mode: "practice" });
    };
  }

  static showCourseStart() {
    const o = BallsMenu._overlay(`
      <div class="aero-title">MATCH PLAY</div>
      <div class="aero-sub">3 holes &nbsp;·&nbsp; lowest total wins</div>
      <div class="aero-stepper">
        <button class="aero-step" id="pMinus">−</button>
        <span>Players: <span id="pCount">1</span></span>
        <button class="aero-step" id="pPlus">+</button>
      </div>
      <button class="aero-btn" id="cPlay">▶ Play</button>
      <div style="margin-top:8px"><button class="aero-btn secondary" id="cBack">Back</button></div>
    `);
    const countEl = o.querySelector("#pCount");
    const minus = o.querySelector("#pMinus");
    const plus = o.querySelector("#pPlus");
    const sync = () => {
      countEl.textContent = BallsMenu.players;
      minus.disabled = BallsMenu.players <= 1;
      plus.disabled = BallsMenu.players >= 4;
    };
    sync();
    minus.onclick = () => {
      BallsMenu.players = Math.max(1, BallsMenu.players - 1);
      sync();
    };
    plus.onclick = () => {
      BallsMenu.players = Math.min(4, BallsMenu.players + 1);
      sync();
    };
    o.querySelector("#cBack").onclick = () => BallsMenu.showModeSelect();
    o.querySelector("#cPlay").onclick = () => {
      o.remove();
      BallsMenu.startFn({ mode: "course", players: BallsMenu.players });
    };
  }
}

/** End-of-round scoreboard: traditional white/green, Frutiger-Aero, rounded. */
class Scoreboard {
  static show(players, holes) {
    CourseUI.ensureStyles();
    const totalPar = holes.reduce((s, h) => s + h.par, 0);
    let head = `<tr><th class="label">Hole</th>`;
    holes.forEach((h) => (head += `<th>${h.id}</th>`));
    head += `<th>Tot</th></tr>`;
    let parRow = `<tr><td class="label">Par</td>`;
    holes.forEach((h) => (parRow += `<td>${h.par}</td>`));
    parRow += `<td>${totalPar}</td></tr>`;
    let rows = "";
    players.forEach((p) => {
      let tot = 0;
      let r = `<tr><td class="label">${p.name}</td>`;
      holes.forEach((h, i) => {
        const s = p.scores[i];
        tot += s || 0;
        r += `<td>${s != null ? s : "–"}</td>`;
      });
      r += `<td>${tot}</td></tr>`;
      rows += r;
    });
    // winner
    const totals = players.map((p) =>
      p.scores.reduce((s, v) => s + (v || 0), 0),
    );
    const best = Math.min(...totals);
    const winners = players
      .filter((_, i) => totals[i] === best)
      .map((p) => p.name);
    const winLine =
      players.length > 1
        ? `<div class="aero-sub">🏆 ${winners.join(" & ")} win${winners.length > 1 ? "" : "s"} (${best})</div>`
        : `<div class="aero-sub">${best - totalPar === 0 ? "Even par" : (best - totalPar > 0 ? "+" : "") + (best - totalPar)} for the round</div>`;

    const o = document.createElement("div");
    o.id = "ballsScoreboard";
    o.className = "balls-overlay";
    o.innerHTML = `<div class="aero-card score-card">
      <div class="aero-title score-title">SCORECARD</div>
      ${winLine}
      <table class="scorecard"><thead>${head}${parRow}</thead>
      <tbody class="players">${rows}</tbody></table>
      <button class="aero-btn" id="sbAgain">▶ Play Again</button>
      <button class="aero-btn secondary" id="sbMenu">Main Menu</button>
    </div>`;
    document.body.appendChild(o);
    o.querySelector("#sbAgain").onclick = () => location.reload();
    o.querySelector("#sbMenu").onclick = () => location.reload();
    // tag total row styling
    const trs = o.querySelectorAll("tbody.players tr");
    trs.forEach((tr) => tr.classList.add("player-row"));
  }
}

/**
 * Orchestrates the round: loads holes, builds physics/materials/decor, runs the
 * drone flyover, cycles player turns, detects water + hole-outs, tallies scores.
 * Built for N players; starts with 1.
 */
class CourseManager {
  constructor(game) {
    this.game = game;
    this.scene = game.scene;
    this.holeIndex = 0;
    this.currentPlayer = 0;
    this.players = [];
    // per-hole transient state
    this.holeNodes = [];
    this.holeAggregates = [];
    this.surfaceMeshes = [];
    this.tee = null;
    this.cup = null;
    this.waterlineY = -100;
    this.holeComplete = false;
    this.busy = true; // input locked (menu/drone/transitions)
    this._pickCache = null;
  }

  async init() {
    const players = Math.max(1, this.game.options.players || 1);
    for (let i = 0; i < players; i++) {
      this.players.push({ name: `Player ${i + 1}`, scores: [] });
    }
    this.decor = new CourseDecor(this.scene);
    await this.decor.load();
    this.surfaces = new CourseSurfaces(this.scene);
    this.surfaces.build();
    this.hud = new CourseHUD();

    this.pinManager = new PinManager(
      this.scene,
      this.game.golfBall,
      this.game.eventManager,
    );
    this.scene.pinManager = this.pinManager;

    this.game.eventManager.on("ball:landed", (pos) => this.onBallLanded(pos));
    this.game.eventManager.on("pin:holesink", (holePos) =>
      this.onHoleSink(holePos),
    );
    this.scene.onBeforeRenderObservable.add(() => this.frame());
  }

  async start() {
    // Grass follows course terrain + only grows on playable turf
    if (this.game.grassSystem) {
      this.game.grassSystem.groundYAt = (x, z) => this.groundY(x, z);
      this.game.grassSystem.playableAt = (x, z) => this.grassAllowed(x, z);
    }
    await this.loadHole(0);
  }

  // ---- terrain height field (sampled once per hole via rays, then O(1) lookups) ----
  // Per-blade raycasting every frame caused big frame drops during ball flight, so
  // the grass system + ball heightRef read this cheap grid instead. This lets grass
  // follow the ball continuously like the practice range (no batch pop-in on landing).
  buildHeightGrid() {
    const cell = 3; // finer than before so the fairway/rough boundary is crisp
    let minX = 1e9,
      maxX = -1e9,
      minZ = 1e9,
      maxZ = -1e9;
    for (const m of this.surfaceMeshes) {
      const bb = m.getBoundingInfo().boundingBox;
      minX = Math.min(minX, bb.minimumWorld.x);
      maxX = Math.max(maxX, bb.maximumWorld.x);
      minZ = Math.min(minZ, bb.minimumWorld.z);
      maxZ = Math.max(maxZ, bb.maximumWorld.z);
    }
    const nx = Math.ceil((maxX - minX) / cell) + 1;
    const nz = Math.ceil((maxZ - minZ) / cell) + 1;
    const height = new Float32Array(nx * nz);
    const playable = new Uint8Array(nx * nz);
    // sample the ground below (exclude the water surface so height = the bed)
    const solids = this.surfaceMeshes.filter(
      (m) => !m.name.toLowerCase().includes("water"),
    );
    const down = new BABYLON.Vector3(0, -1, 0);
    for (let i = 0; i < nx; i++) {
      for (let j = 0; j < nz; j++) {
        const x = minX + i * cell,
          z = minZ + j * cell;
        const ray = new BABYLON.Ray(new BABYLON.Vector3(x, 300, z), down, 600);
        const hit = this.scene.pickWithRay(ray, (m) => solids.includes(m));
        const idx = i * nz + j;
        if (hit && hit.hit) {
          height[idx] = hit.pickedPoint.y;
          const n = hit.pickedMesh.name.toLowerCase();
          // Grass only on rough turf, and never on the submerged bed under water.
          playable[idx] =
            n.includes("rough") && hit.pickedPoint.y > this.waterlineY + 0.4
              ? 1
              : 0;
        }
      }
    }
    // Erode the playable mask by one cell so grass never straddles a boundary
    // (fairway / sand / water / hole edge). A cell survives only if it and all
    // four orthogonal neighbours are rough — keeps every blade strictly inside
    // the rough with a thin first-cut margin, so nothing leaks onto the fairway.
    const eroded = new Uint8Array(nx * nz);
    for (let i = 1; i < nx - 1; i++) {
      for (let j = 1; j < nz - 1; j++) {
        const idx = i * nz + j;
        if (
          playable[idx] &&
          playable[(i - 1) * nz + j] &&
          playable[(i + 1) * nz + j] &&
          playable[i * nz + (j - 1)] &&
          playable[i * nz + (j + 1)]
        ) {
          eroded[idx] = 1;
        }
      }
    }
    this.hg = { minX, minZ, cell, nx, nz, height, playable: eroded };
  }

  groundY(x, z) {
    const hg = this.hg;
    if (!hg) return 0;
    const fx = (x - hg.minX) / hg.cell,
      fz = (z - hg.minZ) / hg.cell;
    let i = Math.max(0, Math.min(hg.nx - 2, Math.floor(fx)));
    let j = Math.max(0, Math.min(hg.nz - 2, Math.floor(fz)));
    const tx = Math.max(0, Math.min(1, fx - i)),
      tz = Math.max(0, Math.min(1, fz - j));
    const H = (a, b) => hg.height[a * hg.nz + b];
    return (
      H(i, j) * (1 - tx) * (1 - tz) +
      H(i + 1, j) * tx * (1 - tz) +
      H(i, j + 1) * (1 - tx) * tz +
      H(i + 1, j + 1) * tx * tz
    );
  }

  grassAllowed(x, z) {
    const hg = this.hg;
    if (!hg) return false;
    const i = Math.max(
      0,
      Math.min(hg.nx - 1, Math.round((x - hg.minX) / hg.cell)),
    );
    const j = Math.max(
      0,
      Math.min(hg.nz - 1, Math.round((z - hg.minZ) / hg.cell)),
    );
    return hg.playable[i * hg.nz + j] === 1;
  }

  // ---- hole lifecycle ----
  async loadHole(index) {
    this.busy = true;
    this.holeIndex = index;
    this.holeComplete = false;
    this.game.wind?.reset?.(); // fresh (non-editable) wind condition per hole
    const cfg = COURSE_HOLES[index];

    // Cache-bust: hole .glb files are served immutable, so version the request
    // to pick up rebuilt geometry. Force the glb loader since the query hides the ext.
    let res;
    try {
      res = await BABYLON.SceneLoader.ImportMeshAsync(
        "",
        "",
        cfg.glb + "?v=" + HOLE_ASSET_VERSION,
        this.scene,
        null,
        ".glb",
      );
    } catch (e) {
      console.error(`Hole ${index + 1} geometry (${cfg.glb}) failed to load.`, e);
      this.busy = false;
      return;
    }

    let teeMarker = null;
    let pinMarker = null;
    let root = null;
    const decorMarkers = [];
    const surfMeshes = [];

    for (const mesh of res.meshes) {
      const name = mesh.name;
      if (name === "__root__") {
        root = mesh;
        this.holeNodes.push(mesh);
        continue;
      }
      if (name.startsWith("marker_tee")) {
        teeMarker = mesh;
        continue;
      }
      if (name.startsWith("marker_pin")) {
        pinMarker = mesh;
        continue;
      }
      if (name.startsWith("tree_") || name.startsWith("rock_")) {
        decorMarkers.push(mesh); // <tree|rock>_<type>_<idx>
        continue;
      }
      if (name.startsWith("surf_")) {
        surfMeshes.push(mesh);
        continue;
      }
    }

    // Center the hole on the origin so it sits inside the distant scenery/mountain
    // ring (esp. the long par 5). Do this BEFORE building colliders.
    if (root) {
      root.computeWorldMatrix(true);
      const b = root.getHierarchyBoundingVectors(true);
      root.position.x -= (b.min.x + b.max.x) / 2;
      root.position.z -= (b.min.z + b.max.z) / 2;
      root.computeWorldMatrix(true);
    }
    for (const m of surfMeshes) m.computeWorldMatrix(true);
    for (const m of surfMeshes) this.setupSurface(m);

    // Waterline (for water-hazard detection + keeping grass off submerged bed) —
    // read from the water plane geometry BEFORE building the height grid.
    const waterMesh = this.surfaceMeshes.find((m) =>
      m.name.toLowerCase().startsWith("surf_water"),
    );
    this.waterlineY = waterMesh
      ? waterMesh.getBoundingInfo().boundingBox.centerWorld.y
      : -100;

    this.buildHeightGrid(); // cheap height/playable lookup for grass + ball
    this.game.grassSystem?.reset(); // drop last hole's grass (terrain changed)

    // A hole is unplayable without its tee/pin markers — bail cleanly rather than
    // throwing a TypeError deep in the render loop if the .glb is malformed.
    if (!teeMarker || !pinMarker) {
      console.error(`Hole ${index + 1} is missing marker_tee/marker_pin; skipping.`);
      this.busy = false;
      return;
    }

    // Tee / pin world positions from markers, then discard markers
    teeMarker.computeWorldMatrix(true);
    pinMarker.computeWorldMatrix(true);
    this.tee = teeMarker.getAbsolutePosition().clone();
    this.cup = pinMarker.getAbsolutePosition().clone();

    // Trees + rocks (instanced from decor.glb)
    this.treeZones = [];
    for (const dm of decorMarkers) {
      dm.computeWorldMatrix(true);
      const parts = dm.name.split("_"); // <tree|rock>_<type>_<idx>
      const type = parts[1] || "tree1";
      const pos = dm.getAbsolutePosition().clone();
      const isTree = dm.name.startsWith("tree_");
      let s = Math.abs(dm.absoluteScaling.x) || 1;
      if (isTree) s *= 3; // trees 3x bigger (relative to the pin)
      // Sink the trunk base a little into the turf so it never peeks/floats over
      // undulating ground (bigger tree → deeper plant).
      if (isTree) pos.y -= 0.5 + 0.25 * s;
      const yaw =
        (dm.rotationQuaternion
          ? dm.rotationQuaternion.toEulerAngles().y
          : dm.rotation.y) || 0;
      const inst = this.decor.place(type, pos, yaw, s);
      if (inst) this.holeNodes.push(inst);
      if (isTree) {
        // Pass-through canopy that slows the ball (no solid trunk collision)
        this.treeZones.push({
          x: pos.x,
          z: pos.z,
          r: 2.4 * s,
          y0: pos.y - 0.5,
          y1: pos.y + 7 * s,
        });
      } else {
        this.addDecorCollider(dm.name, pos, s); // rocks stay solid
      }
      dm.dispose();
    }
    teeMarker.dispose();
    pinMarker.dispose();

    // Cup / flag / sink detection. Point auto-aim at THIS hole's cup (otherwise
    // it keeps aiming at the previous hole's now-disposed pin).
    this.pinManager.addPin(this.cup.clone(), this.scene);
    this.game.currentHolePin =
      this.pinManager.pins[this.pinManager.pins.length - 1];

    // Position ball + drone flyover
    this.placeBallAtTee();
    this.hud.setHole(cfg.id, cfg.par, cfg.name);
    this.game.isControlsDisabled = true;
    this.game.aimView?.deactivate?.();

    const drone = new DroneCamera(this.scene);
    await drone.fly(
      this.tee.clone(),
      this.cup.clone(),
      this.game.camera.camera,
    );

    this.beginTurn();
  }

  // Invisible collider so trees (trunk) and rocks actually block/deflect the ball.
  addDecorCollider(markerName, pos, scale) {
    let col, shape, opts;
    if (markerName.startsWith("tree_")) {
      const h = 5 * scale;
      col = BABYLON.MeshBuilder.CreateCylinder(
        "trunkCol",
        { height: h, diameter: 0.9 * scale, tessellation: 6 },
        this.scene,
      );
      col.position = new BABYLON.Vector3(pos.x, pos.y + h / 2, pos.z);
      shape = BABYLON.PhysicsShapeType.CYLINDER;
      opts = { mass: 0, friction: 0.7, restitution: 0.4 };
    } else {
      const r = 1.1 * scale;
      col = BABYLON.MeshBuilder.CreateSphere(
        "rockCol",
        { diameter: 2 * r, segments: 6 },
        this.scene,
      );
      col.position = new BABYLON.Vector3(pos.x, pos.y + 0.6 * r, pos.z);
      shape = BABYLON.PhysicsShapeType.SPHERE;
      opts = { mass: 0, friction: 0.8, restitution: 0.45 };
    }
    col.isVisible = false;
    col.isPickable = false;
    const agg = new BABYLON.PhysicsAggregate(col, shape, opts, this.scene);
    this.holeAggregates.push(agg);
    this.holeNodes.push(col);
  }

  setupSurface(mesh) {
    const type = this.surfaces.forSurfaceName(mesh.name);
    mesh.material = this.surfaces.mats[type];
    mesh.isPickable = true; // used by surface ray + grass sampling
    mesh.receiveShadows = true;
    this.surfaceMeshes.push(mesh);
    if (type !== "water") {
      const phys = SURFACE_PHYSICS[type] || SURFACE_PHYSICS.rough;
      const agg = new BABYLON.PhysicsAggregate(
        mesh,
        BABYLON.PhysicsShapeType.MESH,
        { mass: 0, friction: phys.friction, restitution: phys.restitution },
        this.scene,
      );
      this.holeAggregates.push(agg);
    }
  }

  placeBallAtTee(yOffset = 0.05) {
    const pos = this.tee.clone();
    // Rest on the real pad surface — the marker can sit well below the pad.
    pos.y = this.teeSurfaceY() + yOffset;
    this.game.ballStartPosition = pos.clone();
    this.game.golfBall.startPosition = pos.clone();
    this.game.golfBall.reset();
    this.lastLie = pos.clone();
  }

  // Actual pad-surface height at the tee (the marker can sit below the pad).
  teeSurfaceY() {
    const ray = new BABYLON.Ray(
      new BABYLON.Vector3(this.tee.x, this.tee.y + 50, this.tee.z),
      new BABYLON.Vector3(0, -1, 0),
      100,
    );
    const hit = this.scene.pickWithRay(
      ray,
      (m) => m.name && m.name.startsWith("surf_"),
    );
    return hit && hit.hit ? hit.pickedPoint.y : this.tee.y;
  }

  // Real-size wooden tee peg (~5 cm) for driver tee shots on the longer holes.
  makeTeePeg(pos, pegH) {
    const peg = BABYLON.MeshBuilder.CreateCylinder(
      "teePeg",
      { height: pegH, diameterTop: 0.05, diameterBottom: 0.012, tessellation: 10 },
      this.scene,
    );
    peg.position = new BABYLON.Vector3(pos.x, this.teeSurfaceY() + pegH / 2, pos.z);
    const mat = new BABYLON.StandardMaterial("teePegMat", this.scene);
    mat.diffuseColor = new BABYLON.Color3(0.95, 0.9, 0.82);
    mat.specularColor = new BABYLON.Color3(0.1, 0.1, 0.1);
    peg.material = mat;
    peg.isPickable = false;
    peg.receiveShadows = true;
    // Collider so the ball rests teed-up until struck.
    this.teePegAgg = new BABYLON.PhysicsAggregate(
      peg,
      BABYLON.PhysicsShapeType.CYLINDER,
      { mass: 0, friction: 0.6, restitution: 0.1 },
      this.scene,
    );
    return peg;
  }

  disposeTeePeg() {
    if (this.teePegAgg) {
      try {
        this.teePegAgg.dispose();
      } catch (e) {}
      this.teePegAgg = null;
    }
    if (this.teePeg) {
      this.teePeg.dispose();
      this.teePeg = null;
    }
  }

  beginTurn() {
    this.busy = false; // player may act
    this.game.currentHoleShotCount = 0;
    this.holeSinkGuardReset();
    this.disposeTeePeg();

    // Tee the ball up when the shot warrants a wood/driver (by distance to pin).
    const distYd =
      BABYLON.Vector3.Distance(this.tee, this.cup) * UNITS.M_TO_YARDS;
    const bestClub =
      this.game.aimView?.clubSelector?.findBestClubForDistance(distYd) ?? 0;
    const useTee = bestClub >= 10; // 3 Wood / 5 Wood / Driver
    const pegH = 0.05; // visible tee height ≈ 5 cm
    this.placeBallAtTee(useTee ? pegH + 0.03 : 0.05);
    if (useTee) this.teePeg = this.makeTeePeg(this.tee, pegH);

    // Aim the camera down the hole toward the pin (behind-ball view).
    // Normalize to [-pi,pi] so the aim→strike camera lerp doesn't wrap the long way.
    const dx = this.cup.x - this.tee.x;
    const dz = this.cup.z - this.tee.z;
    const bearing = this.game.normalizeAngle(Math.atan2(dx, dz) + Math.PI);
    this.game.gameState = GameState.AIM;
    this.game.isControlsDisabled = false;
    if (this.game.aimView) {
      this.game.aimView.cameraRotation = bearing;
      this.game.aimView.activate();
      // Default the tee shot to a driver (and lock it until the player re-aims).
      if (useTee && this.game.aimView.clubSelector) {
        this.game.aimView.clubSelector.currentClub = 12;
        this.game.aimView.clubSelector.manuallySelectedClub = true;
      }
    }
    this.game.circleUIManager?.showStatsCircle();
    this.game.circleUIManager?.showCompassCircle();
  }

  holeSinkGuardReset() {
    this.game.holeSinkProcessed = false;
    this.game.clearArchivedTrails?.();
  }

  // ---- per-frame ----
  frame() {
    if (!this.game.golfBall) return;
    const ball = this.game.golfBall;
    // Keep airborne/landing tests relative to the terrain under the ball
    const bp = ball.getPosition();
    if (this.hg) ball.heightRef = this.groundY(bp.x, bp.z);

    // Out of bounds: ball rolled/flew off the hole terrain (an island) and is
    // falling into the void — take a penalty drop instead of falling forever.
    if (!this.busy && !this.holeComplete && bp.y < -15) {
      this.applyPenalty("Out of bounds — +1");
      return;
    }

    // Trees: when the ball enters a canopy it's deflected out ONCE — losing
    // energy and kicking out in a random-but-forward-biased direction — instead
    // of being continuously slowed (which used to freeze it inside the tree).
    let zoneNow = null;
    if (this.treeZones) {
      for (const z of this.treeZones) {
        if (bp.y < z.y1 && bp.y > z.y0) {
          const dx = bp.x - z.x,
            dz = bp.z - z.z;
          if (dx * dx + dz * dz < z.r * z.r) {
            zoneNow = z;
            break;
          }
        }
      }
    }
    if (zoneNow && zoneNow !== this._treeZone) this.treeBounce(ball);
    this._treeZone = zoneNow;

    // Remove the tee peg once the ball has been struck off it. Compare in the
    // horizontal plane only (the tee marker can sit below the ball's rest height).
    if (
      this.teePeg &&
      this.tee &&
      Math.hypot(bp.x - this.tee.x, bp.z - this.tee.z) > 0.3
    ) {
      this.disposeTeePeg();
    }
  }

  // Deflect the ball out of a tree it just entered: lose most of its energy and
  // kick out at a random angle biased toward its original heading, with a small
  // upward pop and some spin — like clattering through the branches.
  treeBounce(ball) {
    const v = ball.getVelocity();
    const hs = Math.hypot(v.x, v.z);
    if (hs < 2) return; // too slow to bounce out meaningfully
    const keep = 0.3 + Math.random() * 0.25; // lose ~45–70% of horizontal speed
    const newHs = hs * keep;
    const heading =
      Math.atan2(v.x, v.z) + (Math.random() - 0.5) * Math.PI * 0.5; // ±45° bias forward
    const nvy = Math.max(1.0, v.y * 0.3) + Math.random() * 2.0; // pop up out of the tree
    ball.body.setLinearVelocity(
      new BABYLON.Vector3(
        Math.sin(heading) * newHs,
        nvy,
        Math.cos(heading) * newHs,
      ),
    );
    ball.body.setAngularVelocity(
      new BABYLON.Vector3(
        (Math.random() - 0.5) * 12,
        (Math.random() - 0.5) * 12,
        (Math.random() - 0.5) * 12,
      ),
    );
    ball.landed = false;
    ball.touchedGround = false;
  }

  // ---- events ----
  onBallLanded(pos) {
    if (this.busy || this.holeComplete) return;
    // Water hazard: resting below the waterline
    if (pos.y < this.waterlineY - 0.15) {
      this.applyWaterPenalty();
      return;
    }
    this.lastLie = pos.clone();
  }

  applyPenalty(msg) {
    this.game.currentHoleShotCount += 1; // penalty stroke
    this.hud.flash(msg, 1800);
    const drop = (this.lastLie || this.tee).clone();
    drop.y += 0.5;
    this.game.golfBall.startPosition = drop.clone();
    this.game.golfBall.reset();
    this.game._awaitingSettle = false;
    this.game.gameState = GameState.AIM;
    this.game.aimView?.activate();
  }

  applyWaterPenalty() {
    this.applyPenalty("💦 Water — +1");
  }

  onHoleSink(holePos) {
    if (this.holeComplete) return;
    this.holeComplete = true;
    this.busy = true;
    const par = COURSE_HOLES[this.holeIndex].par;
    const strokes = Math.max(1, this.game.currentHoleShotCount);
    this.players[this.currentPlayer].scores[this.holeIndex] = strokes;
    this.hud.flash(CourseUI.scoreName(strokes, par), 2600);
    setTimeout(() => this.advance(), 2800);
  }

  advance() {
    // Next player on the same hole?
    if (this.currentPlayer < this.players.length - 1) {
      this.currentPlayer += 1;
      this.holeComplete = false;
      this.busy = false;
      this.hud.flash(
        `${this.players[this.currentPlayer].name} — tee off`,
        1600,
      );
      this.beginTurn();
      return;
    }
    // Otherwise advance to the next hole
    this.currentPlayer = 0;
    if (this.holeIndex < COURSE_HOLES.length - 1) {
      this.disposeHole();
      this.loadHole(this.holeIndex + 1);
    } else {
      this.hud.hide();
      Scoreboard.show(this.players, COURSE_HOLES);
    }
  }

  disposeHole() {
    this.disposeTeePeg();
    this.treeZones = [];
    this.game.currentHolePin = null; // avoid auto-aiming at the old cup
    for (const agg of this.holeAggregates) {
      try {
        agg.dispose();
      } catch (e) {}
    }
    this.holeAggregates = [];
    for (const node of this.holeNodes) {
      try {
        node.getChildMeshes?.().forEach((m) => m.dispose());
        node.dispose();
      } catch (e) {}
    }
    this.holeNodes = [];
    this.surfaceMeshes = [];
    // dispose pins/flags/cups
    if (this.pinManager?.pins) {
      for (const pin of this.pinManager.pins) {
        try {
          pin.body?.dispose?.();
          pin.mesh?.dispose();
          pin.flagMesh?.dispose();
          pin.flagPivot?.dispose();
          pin.hole?.dispose();
          // Materials/textures aren't freed by mesh.dispose() — do it explicitly.
          // flagMat's texture is the shared static cache, so dispose the material
          // but NOT its diffuseTexture.
          pin.poleMat?.dispose();
          pin.flagMat?.dispose();
          pin.holeMat?.dispose();
          pin.stripeTexture?.dispose();
        } catch (e) {}
      }
      this.pinManager.pins = [];
    }
    this._pickCache = null;
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// APPLICATION BOOTSTRAP
// ═════════════════════════════════════════════════════════════════════════════

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

// Show the start menu (Practice sandbox vs 3-hole Course). BallsMenu is defined
// in the course module appended below. Guarded so this file can be require()d in
// Node (no DOM) for unit tests without auto-booting the menu.
if (typeof document !== "undefined") {
  // The clubhouse (index.html) is the game's root; its doors link here as
  // game.html?mode=course|practice. With a mode in the URL we boot straight
  // into that mode and skip the Practice/Course menu; otherwise show the menu.
  const urlMode = new URLSearchParams(location.search).get("mode");
  if (urlMode === "course" || urlMode === "practice") {
    BallsMenu.startFn = startGame; // wire for any in-game "back to menu" paths
    startGame({ mode: urlMode });
  } else {
    BallsMenu.init(startGame);
  }
  // "back to clubhouse" affordance, always available on the golf page
  const back = document.createElement("button");
  back.id = "toClubhouse";
  back.textContent = "← Clubhouse";
  back.onclick = () => (location.href = "index.html");
  Object.assign(back.style, {
    position: "fixed", top: "12px", left: "50%", transform: "translateX(-50%)",
    zIndex: "3000", padding: "8px 14px", borderRadius: "18px", cursor: "pointer",
    border: "3px solid #476a23", background: "rgba(144,200,150,0.92)",
    color: "#123", fontFamily: "Arial, sans-serif", fontWeight: "bold", fontSize: "15px",
  });
  document.body.appendChild(back);
}

// Node-only export seam: lets the framework-free gameplay logic (unit math, club
// selection, wind, config) be unit-tested with `node --test`. No-op in browsers,
// where `module` is undefined.
if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    CONFIG,
    GameState,
    Utils,
    ClubData,
    ClubSelector,
    Wind,
    PhysicsConfig,
  };
}
