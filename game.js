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
    IS_SMALL_SCREEN: window.innerWidth < 1024,
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
    // Havok combines friction by MINIMUM, so THIS value caps grip on every grass
    // surface — green/fairway/rough are all set ≥0.9, so min() picks the ball's every
    // time. 0.9 made shots bite/check instead of releasing into roll; ~0.4 is realistic
    // turf µ. (A rolling ball doesn't slip, so friction doesn't set roll-out distance —
    // ROLL_BRAKE_DECEL does; friction governs the landing skid/check and spin bite.)
    FRICTION: 0.4,
    RESTITUTION: 0.5, // soft-turf COR — bounces without being a superball (0.3 was dead, 0.6 = hard court)
    LINEAR_DAMPING: 0.3, // air-drag model for flight carry (club distances are calibrated to this — do not retune for roll)
    // Spin barely decays in air on a real ball. High angular damping instead acts,
    // through rolling-without-slip friction coupling, as a hidden STRONG rolling
    // brake that kills roll — worst for putts (pure roll). Keep it near zero and let
    // ROLL_BRAKE_DECEL be the one, tunable rolling-resistance knob (was 1.2 → froze putts).
    ANGULAR_DAMPING: 0.1,
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
    // Speed below which a grounded ball is declared "landed" — which HARD-ZEROES
    // its velocity. At 0.5 m/s (1.1 mph) that amputated the last ~0.2 m of every
    // roll and made slow trickle-ins impossible. 0.15 lets the ball roll out; the
    // rolling-resistance brake (ROLL_BRAKE_DECEL) does the actual settling at 0.06 m/s.
    LANDED_SPEED_THRESHOLD: 0.15,
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
    BUILD_BUDGET: 4, // max chunks (re)built + uploaded per frame — streams the ring's leading edge in without a spike
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
  // Eyelid blink timings moved to balls.js (Balls.BLINK), shared with clubhouse.
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
    HOLE_Y_OFFSET: 0.35, // practice-mode fallback only; course cups are surface-relative
    FLAG_WIND_THRESHOLD: 2.235, // ~5 mph in m/s
    // Real cavity cup (course mode): the ball must roll over the mouth slowly, drop
    // in, and settle before the hole counts.
    CUP_DEPTH: 0.1, // regulation 4" cup depth (m)
    CUP_CAPTURE_SPEED: 1.7, // ball must be at/below this over the mouth to drop in (faster rolls over)
    CUP_SETTLE_SPEED: 0.25, // "stays in": holed once it comes to rest this slow inside the cavity
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
    HORIZON_DISTANCE: 300,
    HORIZON_HEIGHT: 100,
    MIN_HEIGHT: 30,
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
    // Uniform scale for the ballsbird.glb model. It's authored ~2.5 m long, which
    // dwarfed the world once everything went real-scale (42.7 mm ball); 0.25 brings
    // it to a believable ~0.6 m bird. Tune up for more presence, down for smaller.
    MODEL_SCALE: 0.25,
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
    STARTLE_RADIUS: 1, // ball this close (m) makes perched/landing birds bolt — small, to match the 42.7 mm ball so birds can perch right near it
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
    this.direction = Math.random() * Math.PI * 2;
    this.speed =
      CONFIG.WIND.MIN_SPEED +
      Math.random() * (CONFIG.WIND.MAX_SPEED - CONFIG.WIND.MIN_SPEED);
  }

  getWindVector() {
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
    const v =
      this._forceScratch || (this._forceScratch = new BABYLON.Vector3());
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
    } catch (error) {}
  }

  createCloud(index) {
    const cloud = BABYLON.MeshBuilder.CreatePlane(
      `cloud_${index}`,
      { width: CONFIG.CLOUDS.CLOUD_SIZE, height: CONFIG.CLOUDS.CLOUD_SIZE },
      this.scene,
    );

    cloud.billboardMode = BABYLON.Mesh.BILLBOARDMODE_ALL;
    cloud.isPickable = false;

    const mat = new BABYLON.StandardMaterial(`cloudMat_${index}`, this.scene);

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

    cloud.rotation.z = Math.random() * Math.PI * 2;

    const spread = CONFIG.CLOUDS.HORIZON_DISTANCE;
    const minHeight = CONFIG.CLOUDS.MIN_HEIGHT;
    const maxHeight = CONFIG.CLOUDS.HORIZON_HEIGHT * 1.5;

    cloud.position = new BABYLON.Vector3(
      (Math.random() - 0.5) * spread * 2,
      minHeight + Math.random() * (maxHeight - minHeight),
      (Math.random() - 0.5) * spread * 2,
    );

    this.clouds.push({
      mesh: cloud,
    });
  }

  update(ballPos, wind) {
    if (!this.cloudTextures.length) {
      return;
    }

    this.clouds.forEach((cloud, idx) => {
      const windVector = wind.getWindVector();

      const effectiveVelocity = windVector;

      const moveDistance = 1 / 60;
      cloud.mesh.position.x += effectiveVelocity.x * moveDistance;
      cloud.mesh.position.z += effectiveVelocity.z * moveDistance;

      const driftX = cloud.mesh.position.x - ballPos.x;
      const driftZ = cloud.mesh.position.z - ballPos.z;
      const driftDist = Math.sqrt(driftX * driftX + driftZ * driftZ);

      // Recycle cloud when it drifts too far - respawn on opposite side
      if (driftDist > CONFIG.CLOUDS.HORIZON_DISTANCE * 3) {
        const driftAngle = Math.atan2(driftZ, driftX);

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
    this.mesh.scaling.setAll(CONFIG.BOIDS.MODEL_SCALE); // real-scale bird (see MODEL_SCALE)
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
      targetRoll = Shared.clamp(dyaw * 2.5, -0.5, 0.5);
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
    this.bottomOffset = 0.7 * CONFIG.BOIDS.MODEL_SCALE; // mesh origin → underside; refined at load
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
      this.container = await Shared.loadModel("ballsbird.glb", this.scene, {
        container: true,
      });
      this.container.animationGroups.forEach((g) => g.stop());

      // Underside offset (level pose) so perched birds sit tangent to the surface.
      const probe = this.container.instantiateModelsToScene(
        (n) => "birdProbe_" + n,
        false,
      );
      const proot = probe.rootNodes[0];
      proot.scaling.setAll(CONFIG.BOIDS.MODEL_SCALE); // measure at the birds' real scale
      proot.computeWorldMatrix(true);
      const bb = proot.getHierarchyBoundingVectors(true);
      this.bottomOffset = proot.getAbsolutePosition().y - bb.min.y;
      if (!isFinite(this.bottomOffset))
        this.bottomOffset = 0.7 * CONFIG.BOIDS.MODEL_SCALE;
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
  createMaterial(name, scene, color, specular = null, power = 16) {
    const mat = new BABYLON.StandardMaterial(name, scene);
    mat.diffuseColor = color;
    if (specular) {
      mat.specularColor = specular;
      mat.specularPower = power;
    }
    return mat;
  },

  rotate2D(x, z, angle) {
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    return {
      x: x * cos - z * sin,
      z: x * sin + z * cos,
    };
  },

  addShadowCasters(meshes, shadowGenerator) {
    meshes.forEach((m) => {
      if (m) shadowGenerator?.addShadowCaster(m, true);
    });
  },

  metersToYards(meters) {
    return Math.round(meters * UNITS.M_TO_YARDS);
  },

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
    return this.CLUBS[Shared.clamp(id, 0, this.CLUBS.length - 1)];
  }
}

// ─── TRAJECTORY ARROW ──────────────────────────────────────────────────────

class TrajectoryArrow {
  constructor(scene, ballPos) {
    this.scene = scene;
    this.ballPos = ballPos;
    this.arrow = null;
    this.arrowTemplate = null;
    this.lastArrowAngle = -1;
    this.isLoaded = false;
    this.currentColor = new BABYLON.Color3(0xe1 / 255, 0xe4 / 255, 0x4e / 255);
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

// ─── CLUB SELECTOR ──────────────────────────────────────────────────────────

class ClubSelector {
  constructor(circleUIManager = null) {
    this.circleUIManager = circleUIManager;
    this.currentClub = 12; // Default to driver
    this.manuallySelectedClub = false; // True if user manually picked a club
    this.clubButtonsAttached = false;
  }

  reset() {
    this.currentClub = 12;
    this.manuallySelectedClub = false;
    this.clubButtonsAttached = false;
  }

  /**
   * Find best club for a given distance.
   * @param {number} distance target distance in METRES (compared directly
   *   against ClubData.maxDistance, which is in metres). Callers must NOT
   *   pass yards.
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

  getPredictedDistanceForClub(club) {
    return club.maxDistance;
  }

  autoSelectClubIfNeeded(distance) {
    if (!this.manuallySelectedClub) {
      this.currentClub = this.findBestClubForDistance(distance);
      return true;
    }
    return false;
  }

  selectClub(clubId) {
    this.currentClub = Shared.clamp(clubId, 0, 12);
    this.manuallySelectedClub = true;
  }

  enableAutoSelect() {
    this.manuallySelectedClub = false;
  }

  updateUI() {
    if (!this.circleUIManager) return;

    const club = ClubData.getClub(this.currentClub);
    const prevClub = ClubData.getClub((this.currentClub - 1 + 13) % 13);
    const nextClub = ClubData.getClub((this.currentClub + 1) % 13);
    const mk = (c) => ({
      name: c.name,
      yds: Math.round(Utils.metersToYards(c.maxDistance)) + "'",
    });

    this.circleUIManager.updateClub(mk(club), mk(prevClub), mk(nextClub));

    // Attach carousel listeners once: tapping the preview above/below rolls it in.
    if (!this.clubButtonsAttached) {
      const buttons = this.circleUIManager.getClubButtons();
      if (buttons) {
        if (buttons.prevBtn) {
          buttons.prevBtn.onclick = (e) => {
            e.stopPropagation();
            this.rollTo("prev");
          };
        }
        if (buttons.nextBtn) {
          buttons.nextBtn.onclick = (e) => {
            e.stopPropagation();
            this.rollTo("next");
          };
        }
        this.clubButtonsAttached = true;
      }
    }
  }

  // Animate the carousel one step, then commit the new selection + re-render.
  rollTo(which) {
    if (this._rolling) return;
    this._rolling = true;
    this.circleUIManager.animateClubRoll(which, () => {
      const next =
        which === "prev"
          ? (this.currentClub - 1 + 13) % 13
          : (this.currentClub + 1) % 13;
      this.selectClub(next);
      this.updateUI();
      this._rolling = false;
    });
  }

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

class GolfBallGuy {
  // Rolling resistance: only brake once the ball is already slow, and use a
  // constant decel. 0.6 m/s² ≈ a medium-fast green (Stimp ~9): a lag putt rolls a
  // realistic distance and settles. (3.0 was ~5× real green resistance and, with the
  // old 1.2 angular damping, made putting almost impossible — the ball died in ~1 m.)
  // Trade-off: 0.6 only holds the ball on slopes up to ~3.5°; steeper banks keep
  // rolling, which is realistic — a ball won't sit still on a steep green either.
  static ROLL_BRAKE_SPEED = 2.5;
  static ROLL_BRAKE_DECEL = 0.6;
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
    this._inCup = false; // sitting in a real cavity cup — exempt from preventTunneling
    this.pendingSpinAmount = 0;
    this.pendingSpinAxis = BABYLON.Vector3.Zero();

    this.skeleton = skeleton;
    this.spinBone = null;
    this.scene = scene;

    this.faceMesh = null;
    this.faceMaterial = null;
    this.faceTextures = {};
    this.currentFace = "default";
    this.faceTransitionTimer = 0;
    this.nextFace = null;

    this.HIT_FACE_DURATION = 0.3;
    this.COLLISION_FACE_DURATION = 0.4;

    this.spinTransitionActive = false;
    this.spinTransitionTimer = 0;
    this.spinTransitionDuration = 0.4;

    this.targetRotation = 0;
    this.facingAimDirection = false;

    // Blinking system — the state machine lives in balls.js; this.blink and
    // this.blinkMorphIdx are set up in initializeEyelids once the model loads.
    this.eyelidsMesh = null;
    this.blink = null;
    this.blinkMorphIdx = null;

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
    const v =
      this._speedScratch || (this._speedScratch = new BABYLON.Vector3());
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
    if (!this.body || this._teleportRestoreFrames > 0 || this._inCup) return;
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
    const powerRatio = swipeStrength / CONFIG.GOLF_BALL.MAX_HIT_STRENGTH;
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
        this.faceTextures[name] = Balls.faceTexture(this.scene, filename);
      } catch (e) {}
    }

    if (this.faceMaterial) {
      if (this.faceMaterial.albedoTexture) {
        this.faceTextures["default"] = this.faceMaterial.albedoTexture;
      } else if (this.faceMaterial.diffuseTexture) {
        this.faceTextures["default"] = this.faceMaterial.diffuseTexture;
      }
      // Locker-room drawn face replaces the resting smile as "default", so the
      // flight expressions (grimace/elated/woah/o) still override + restore it.
      const styleFace = BallsStyle.loadStyle().face;
      if (styleFace) {
        const t = BallsStyle.faceTextureFromDataURL(this.scene, styleFace);
        if (t) {
          this.faceTextures["default"] = t;
          if (this.faceMaterial.albedoTexture !== undefined) {
            this.faceMaterial.albedoTexture = t;
          } else if (this.faceMaterial.diffuseTexture) {
            this.faceMaterial.diffuseTexture = t;
          }
        }
      }
    }
  }

  // Locker-room hat + ball skin (the face part lives in loadFaceTextures).
  applyStyle(style) {
    const st = BallsStyle.normalizeStyle(style);
    BallsStyle.applySkin(this.scene, this.scene.meshes, st.skin, st.skinImg);
    if (this.hatMount) this.hatMount.dispose(false, true);
    this.hatMount = null;
    const hat = BallsStyle.buildHat(this.scene, st.hat);
    if (hat) {
      this.hatMount = new BABYLON.TransformNode("hatMount", this.scene);
      // Parent the hat to the spin bone's node so it tracks the head exactly —
      // during flight the whole character tumbles via this bone, and the node
      // already carries the model's 0.0254 scale. (Parenting to the body mesh
      // instead and mirroring the spin drifts off: the bone's bind pose is
      // rotated 180° about Y, so a LOCAL-space spin axis maps to a mirrored
      // world axis and the hat and head diverge.) Fall back to the body mesh
      // if the skeleton is missing.
      const boneNode =
        this.spinBone && this.spinBone.getTransformNode
          ? this.spinBone.getTransformNode()
          : null;
      if (boneNode) {
        this.hatMount.parent = boneNode;
        this.hatMount.rotationQuaternion = BABYLON.Quaternion.RotationAxis(
          BABYLON.Axis.Y,
          Math.PI,
        ); // undo the bone's 180°-Y bind so the hat faces forward
      } else {
        this.hatMount.parent = this.mesh;
        this.hatMount.scaling.setAll(0.0254); // gball model units -> metres
      }
      hat.parent = this.hatMount;
      for (const m of hat.getChildMeshes(false)) m.isPickable = false;
      Utils.addShadowCasters(
        hat.getChildMeshes(false),
        this.scene.shadowGenerator,
      );
    }
  }

  initializeEyelids() {
    if (!this.mesh) return;

    // Find the eyelids mesh WITHIN the ball's own hierarchy. A scene-wide search
    // grabs the bird flock's eyelids (bird0_eyelids…, spawned on the course) first,
    // so the ball would end up blinking a bird instead of itself.
    this.eyelidsMesh = this.mesh
      .getChildMeshes(false)
      .find(
        (m) =>
          m.name &&
          m.name.toLowerCase().includes("eyelid") &&
          m.morphTargetManager,
      );

    const mgr = this.eyelidsMesh && this.eyelidsMesh.morphTargetManager;
    if (mgr) {
      this.blink = Balls.newBlinkState();
      this.blinkMorphIdx = Balls.findBlinkMorphIndex(mgr);
    }
  }

  initializeEyes(skeleton) {
    if (!skeleton || skeleton.bones.length === 0) return;

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

    const charPos = this.getPosition();
    const dirToCamera = cameraPosition.subtract(charPos);
    dirToCamera.normalize();

    let targetYaw = Math.atan2(dirToCamera.x, dirToCamera.z);
    let targetPitch = -Math.asin(dirToCamera.y);

    targetYaw = Math.max(
      -CONFIG.EYES.MAX_YAW,
      Math.min(CONFIG.EYES.MAX_YAW, targetYaw),
    );
    targetPitch = Math.max(
      -CONFIG.EYES.MAX_PITCH,
      Math.min(CONFIG.EYES.MAX_PITCH, targetPitch),
    );

    const f = 1 - Math.exp(-CONFIG.EYES.LERP_SPEED * dt);
    this.eyeYaw += (targetYaw - this.eyeYaw) * f;
    this.eyePitch += (targetPitch - this.eyePitch) * f;

    const gazeQ = BABYLON.Quaternion.FromEulerAngles(
      this.eyePitch,
      this.eyeYaw,
      0,
    );

    if (this.eyeL && this.eyeLRest) {
      this.eyeL.rotationQuaternion = gazeQ.multiply(this.eyeLRest);
    }
    if (this.eyeR && this.eyeRRest) {
      this.eyeR.rotationQuaternion = gazeQ.multiply(this.eyeRRest);
    }
  }

  updateBlinking(dt) {
    const mgr = this.eyelidsMesh && this.eyelidsMesh.morphTargetManager;
    if (
      !mgr ||
      !this.blink ||
      this.blinkMorphIdx == null ||
      this.blinkMorphIdx < 0
    )
      return;
    const target = mgr.getTarget(this.blinkMorphIdx);
    if (target) target.influence = Balls.updateBlink(this.blink, dt);
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
    // The hat is parented to this bone's node (see applyStyle), so it tumbles
    // with the head automatically — no separate rotation needed.
    this.spinBone.rotate(spinAxis, spinSpeed, BABYLON.Space.LOCAL);
  }

  hasSpinBone() {
    return this.spinBone !== null;
  }

  // === ROTATION METHODS ===
  setFacingAim(aimDirection) {
    this.targetRotation = aimDirection + Math.PI;
    this.facingAimDirection = true;
  }

  setFacingCamera(cameraPosition) {
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
    this._inCup = false;
  }

  // Teleport the physics body to a new spot (e.g. dropping into the cup): let the
  // body read the mesh transform for a couple of physics steps, then hand control
  // back to the simulation (same dance as reset()).
  teleport(x, y, z, zeroVel = true) {
    this.mesh.position.set(x, y, z);
    if (zeroVel && this.body) {
      this.body.setLinearVelocity(BABYLON.Vector3.Zero());
      this.body.setAngularVelocity(BABYLON.Vector3.Zero());
    }
    if (this.body) {
      this.body.disablePreStep = false;
      this._teleportRestoreFrames = 2;
      this.mesh.computeWorldMatrix(true);
    }
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
    // One PERSISTENT thin-instance matrix buffer per variant, sized for the whole
    // WxW ring of chunks. Each chunk owns a fixed slot in it (toroidal addressing),
    // so a chunk crossing rewrites only the handful of slots that changed and
    // uploads just those sub-ranges — no realloc, no full re-upload, no flight spike.
    this.buffers = null; // Float32Array[] (per variant); allocated in initialize()
    this.cap = 0; // matrices reserved per slot per variant (= BLADES_PER_CELL)
    this.R = 0; // ring radius in chunks
    this.W = 0; // ring width = 2R+1
    this.G = 0; // total slots = W²
    this.built = null; // per-slot {cx,cz} currently uploaded, or null
    this.desired = null; // per-slot {cx,cz,d} it SHOULD show (d = dist² to center)
    this.queue = []; // slot indices awaiting (re)build, nearest-first
    this.center = null; // last center chunk {cx,cz}
    this.camPos = new BABYLON.Vector3(); // shared uCamPos ref; refreshed each update()
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
    // Fixed ring geometry. cap = BLADES_PER_CELL so a slot can hold a whole chunk's
    // blades in ANY single variant (a chunk splits its blades randomly across the 3
    // variants, so per-variant counts vary) — no overflow, no drops. Unused entries
    // stay all-zero, which transforms to a degenerate point the GPU discards for free
    // (no fragments). If ever vertex-bound, cap could be tightened toward
    // BLADES_PER_CELL/3 by dropping the rare per-variant overflow.
    this.cap = CONFIG.GRASS.BLADES_PER_CELL;
    this.R = Math.ceil(CONFIG.GRASS.VIEW_RADIUS / CONFIG.GRASS.CELL_SIZE);
    this.W = 2 * this.R + 1;
    this.G = this.W * this.W;
    const capFloats = this.cap * 16;
    this.buffers = this.grassMeshes.map((mesh) => {
      const buf = new Float32Array(this.G * capFloats); // all-zero → all degenerate
      // staticBuffer=false → dynamic GL buffer we can partial-update per slot.
      mesh.thinInstanceSetBuffer("matrix", buf, 16, false);
      mesh.setEnabled(true);
      return buf;
    });
    this.built = new Array(this.G).fill(null);
    this.desired = new Array(this.G);
    this.queue = [];
    this.center = null;
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

    // CustomMaterial = StandardMaterial + GLSL injection hooks. We inject a vertex
    // fade so a blade's height ramps to zero as it approaches the outer edge of the
    // grass ring: chunks streaming in at the leading edge rise from the ground
    // instead of popping in at full height, and the hard chunk boundary — where a
    // not-yet-built chunk could show a gap — is masked because blades there are
    // already ~zero height. Runs entirely on the GPU, no per-frame CPU cost.
    const mat = new BABYLON.CustomMaterial(`grassMat_${index}`, this.scene);
    mat.diffuseTexture = tex;
    mat.useAlphaFromDiffuseTexture = true;
    // Alpha-TEST (cutout), not alpha-BLEND: no transparency sorting / overdraw.
    mat.transparencyMode = BABYLON.Material.MATERIAL_ALPHATEST;
    mat.alphaCutOff = 0.4;
    mat.backFaceCulling = false; // both faces of each quad visible
    mat.specularColor = new BABYLON.Color3(0, 0, 0); // grass isn't shiny
    // uCamPos is the shared Vector3 refreshed each frame in update(); CustomMaterial
    // re-reads and re-uploads the passed reference on every bind, so mutating that
    // one vector updates all three grass materials — no per-frame observer needed.
    mat.AddUniform("uCamPos", "vec3", this.camPos);
    // Fully faded a bit inside VIEW_RADIUS so blades vanish BEFORE the leading chunk
    // boundary they'd otherwise reveal. world3.xz = this thin-instance's world
    // translation (the blade's base) — the assembled `finalWorld` isn't available
    // yet at this injection point, but the raw instance attribute is.
    const fadeStart = (CONFIG.GRASS.VIEW_RADIUS * 0.6).toFixed(2);
    const fadeEnd = (CONFIG.GRASS.VIEW_RADIUS * 0.95).toFixed(2);
    mat.Vertex_Before_PositionUpdated(`
      #ifdef INSTANCES
        float _gd = length(world3.xz - uCamPos.xz);
        positionUpdated.y *= 1.0 - smoothstep(${fadeStart}, ${fadeEnd}, _gd);
      #endif
    `);

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
    const terrainRSq =
      CONFIG.GRASS.TERRAIN_RADIUS * CONFIG.GRASS.TERRAIN_RADIUS;
    const nVar = this.grassMeshes.length;
    const rng = GrassSystem._rng(
      Math.imul(cx, 73856093) ^ Math.imul(cz, 19349663),
    );
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
      BABYLON.Quaternion.RotationYawPitchRollToRef(
        rng() * Math.PI * 2,
        0,
        0,
        quat,
      );
      pos.set(x, y, z);
      BABYLON.Matrix.ComposeToRef(scale, quat, pos, mat);
      const arr = out[Math.floor(rng() * nVar)];
      for (let k = 0; k < 16; k++) arr.push(mat.m[k]);
    }
    return out.map((a) => Float32Array.from(a));
  }

  // Toroidal slot for a world chunk: consecutive chunks wrap onto fixed buffer
  // slots, so when the ring recenters only the newly-exposed chunks change slots.
  _slot(cx, cz) {
    const W = this.W;
    const sx = ((cx % W) + W) % W;
    const sz = ((cz % W) + W) % W;
    return sz * W + sx;
  }

  // Recompute which chunk each slot should show, and queue the mismatched slots
  // (nearest-first) for streaming. The WxW neighbourhood maps bijectively onto all
  // G slots, so every slot gets exactly one desired chunk.
  _reindex(cx, cz) {
    const R = this.R;
    for (let dz = -R; dz <= R; dz++) {
      for (let dx = -R; dx <= R; dx++) {
        const wcx = cx + dx,
          wcz = cz + dz;
        this.desired[this._slot(wcx, wcz)] = {
          cx: wcx,
          cz: wcz,
          d: dx * dx + dz * dz,
        };
      }
    }
    const q = [];
    for (let s = 0; s < this.G; s++) {
      const b = this.built[s],
        d = this.desired[s];
      if (!b || b.cx !== d.cx || b.cz !== d.cz) q.push(s);
    }
    q.sort((a, b) => this.desired[a].d - this.desired[b].d);
    this.queue = q;
  }

  // Write one chunk's blades into its slot and upload ONLY that slot's sub-range.
  _buildSlot(slot, cx, cz, pinPositions) {
    const mats = this.buildChunk(cx, cz, pinPositions); // per-variant Float32Array
    const capFloats = this.cap * 16;
    const base = slot * capFloats;
    for (let v = 0; v < this.grassMeshes.length; v++) {
      const buf = this.buffers[v];
      const src = mats[v];
      buf.set(src, base); // real blades at the front of the slot
      buf.fill(0, base + src.length, base + capFloats); // rest degenerate
      // Upload just this slot's `cap` matrices (starting matrix index = slot*cap).
      this.grassMeshes[v].thinInstancePartialBufferUpdate(
        "matrix",
        this.cap,
        slot * this.cap,
      );
    }
    this.built[slot] = { cx, cz };
  }

  update(refPos, pinPositions = []) {
    if (!this.buffers) return;
    this.camPos.copyFrom(refPos); // drives the vertex distance-fade this frame
    const S = CONFIG.GRASS.CELL_SIZE;
    const cx = Math.floor(refPos.x / S);
    const cz = Math.floor(refPos.z / S);
    // Re-target slots only when the reference crosses into a new chunk.
    if (!this.center || this.center.cx !== cx || this.center.cz !== cz) {
      this.center = { cx, cz };
      this._reindex(cx, cz);
    }
    // Stream a bounded number of chunks per frame — this is what removes both the
    // in-flight rebuild spike and the batch pop-in when the ball comes to rest.
    let budget = CONFIG.GRASS.BUILD_BUDGET;
    while (budget > 0 && this.queue.length) {
      const slot = this.queue.shift();
      const d = this.desired[slot];
      this._buildSlot(slot, d.cx, d.cz, pinPositions);
      budget--;
    }
  }

  // Clear all grass (e.g. between holes — the terrain height/playable mask changed).
  reset() {
    if (!this.buffers) return;
    this.built.fill(null);
    this.queue = [];
    this.center = null;
    for (let v = 0; v < this.grassMeshes.length; v++) {
      this.buffers[v].fill(0); // every slot degenerate → old hole's grass vanishes
      this.grassMeshes[v].thinInstanceBufferUpdated("matrix"); // one upload (transition)
    }
  }

  dispose() {
    for (const mesh of this.grassMeshes) {
      mesh.dispose(false, true); // also dispose material + textures
    }
    this.grassMeshes = [];
    this.buffers = null;
    this.built = null;
    this.desired = null;
    this.queue = [];
    this.center = null;
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

    deltaX = Shared.clamp(deltaX, -(swipeLen - 1), swipeLen - 1);
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

    this.circles = {
      topLeft: document.getElementById("circleStats"),
      topRight: document.getElementById("circleCompass"),
      bottomLeft: document.getElementById("circlePower"),
      bottomRight: document.getElementById("circleClub"),
    };
    this.clubButtonsContainer = document.getElementById("clubSelectorWrapper");

    this._statsFlagImg = document.getElementById("statsFlagImg");
    this._lastFlagFrame = -1;
    this._statsPinNumber = document.getElementById("statsPinNumber");
    this.powerPercent = document.getElementById("powerPercent");
    this.powerArc = document.getElementById("powerArc");
    this._powerCircumference = 383; // 2π * 61, fixed for viewBox="0 0 150 150"
    this.clubIcon = document.getElementById("clubIcon");
    this.clubAbbr = document.getElementById("clubAbbr");
    this.clubYds = document.getElementById("clubYds");
    this._statsPar = document.getElementById("statsPar");
    this.clubPrev = document.getElementById("clubPrev");
    this.clubNext = document.getElementById("clubNext");
    this.clubPrevIcon = this.clubPrev?.querySelector(".club-mini-icon");
    this.clubNextIcon = this.clubNext?.querySelector(".club-mini-icon");
    this.clubPrevAbbr = this.clubPrev?.querySelector(".club-mini-abbr");
    this.clubNextAbbr = this.clubNext?.querySelector(".club-mini-abbr");
    this.clubPrevYds = this.clubPrev?.querySelector(".club-mini-yds");
    this.clubNextYds = this.clubNext?.querySelector(".club-mini-yds");
    this._rollAnimating = false;

    this._attachPressEffect(this.circles.topLeft);
    this._attachPressEffect(document.getElementById("compassCircle"));
    this._attachPressEffect(this.circles.bottomLeft);
    this._attachPressEffect(this.circles.bottomRight);

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

  showStatsCircle() {
    const stats = document.getElementById("circleStats");
    if (stats) stats.style.display = "flex";
  }

  hideStatsCircle() {
    const stats = document.getElementById("circleStats");
    if (stats) stats.style.display = "none";
  }

  updateStats(speed, spin, height, distance, flagFrame, pinNumber, par = null) {
    document.getElementById("circleYardage").textContent = distance.toFixed(0);

    // Course mode: par sits between the flag and the distance; hidden in practice.
    if (this._statsPar) {
      if (par != null) {
        this._statsPar.textContent = "PAR " + par;
        this._statsPar.style.display = "block";
      } else {
        this._statsPar.style.display = "none";
      }
    }

    // Update flag via cached data URLs (no network requests, pure memory)
    if (this._statsFlagImg && flagFrame !== this._lastFlagFrame) {
      this._lastFlagFrame = flagFrame;
      const frameIndex = Shared.clamp(flagFrame, 0, 6);
      const dataUrl = CircleUIManager.flagDataUrls.get(frameIndex);

      if (dataUrl) {
        this._statsFlagImg.style.backgroundImage = `url('${dataUrl}')`;
      }
    }

    if (this._statsPinNumber && pinNumber !== undefined) {
      this._statsPinNumber.textContent = pinNumber;
    }
  }

  updatePower(powerPercent) {
    const percent = Shared.clamp(powerPercent, 0, 100);
    if (this.powerPercent) this.powerPercent.textContent = percent.toFixed(0);
    if (this.powerArc && this._powerCircumference) {
      const offset = this._powerCircumference * (1 - percent / 100);
      this.powerArc.style.strokeDashoffset = offset;
      this.powerArc.style.stroke = PALETTE.YELLOW;
    }
  }

  static iconForClub(clubName) {
    if (clubName.includes("Driver") || clubName.includes("Wood"))
      return "assets/clubs/driver.png";
    if (clubName.includes("Putter")) return "assets/clubs/putter.png";
    return "assets/clubs/iron.png";
  }

  // Short badge for the preview minis: D / 3W / 5W / P / S (lob) / PW / H, or the
  // bare number for irons.
  static abbrevForClub(name) {
    if (name === "Driver") return "D";
    if (name === "Putter") return "P";
    if (name === "Lob Wedge") return "S";
    if (name === "Sand Wedge") return "SW";
    if (name === "Pitching Wedge") return "PW";
    if (name === "Hybrid") return "H";
    const iron = /^(\d+)\s*Iron/i.exec(name);
    if (iron) return iron[1];
    const wood = /^(\d+)\s*Wood/i.exec(name);
    if (wood) return wood[1] + "W";
    return name.slice(0, 2).toUpperCase();
  }

  // Circumcentre of three points — the arc the carousel rotates along.
  static _circumcenter(a, b, c) {
    const d = 2 * (a.x * (b.y - c.y) + b.x * (c.y - a.y) + c.x * (a.y - b.y));
    if (Math.abs(d) < 1e-6) return { x: b.x, y: b.y };
    const a2 = a.x * a.x + a.y * a.y,
      b2 = b.x * b.x + b.y * b.y,
      c2 = c.x * c.x + c.y * c.y;
    return {
      x: (a2 * (b.y - c.y) + b2 * (c.y - a.y) + c2 * (a.y - b.y)) / d,
      y: (a2 * (c.x - b.x) + b2 * (a.x - c.x) + c2 * (b.x - a.x)) / d,
    };
  }

  // Update the club carousel: the selected club (full size, in the corner) plus
  // half-size previous/next previews (icon + short badge) above and to the left.
  // sel/prev/next are { name, yds } — all three circles show icon + abbrev + yardage.
  updateClub(sel, prev, next) {
    const paint = (icon, abbr, yds, club) => {
      if (!club) return;
      if (icon) icon.src = CircleUIManager.iconForClub(club.name);
      if (abbr) abbr.textContent = CircleUIManager.abbrevForClub(club.name);
      if (yds) yds.textContent = club.yds;
    };
    paint(this.clubIcon, this.clubAbbr, this.clubYds, sel);
    paint(this.clubPrevIcon, this.clubPrevAbbr, this.clubPrevYds, prev);
    paint(this.clubNextIcon, this.clubNextAbbr, this.clubNextYds, next);
  }

  // Rotate the carousel one step. The clicked preview (`which` = "prev" = above,
  // "next" = left) swings along the quarter-circle arc into the corner and grows to
  // the selected size; the selected club swings + shrinks into the opposite preview
  // slot; the club that leaves the 3-window POPS out; the newly-revealed club FADES
  // in. Motion uses the Web Animations API so it runs on the compositor (smooth even
  // while the 3D scene renders). onDone re-renders the static state at settle; the
  // swap is masked because every circle is a pixel-identical scale of the others.
  animateClubRoll(which, onDone) {
    const P = this.clubPrev,
      C = this.circles.bottomRight,
      N = this.clubNext;
    if (!P || !C || !N || this._rollAnimating) {
      onDone();
      return;
    }
    this._rollAnimating = true;
    const ctr = (el) => {
      const r = el.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width };
    };
    const cP = ctr(P),
      cC = ctr(C),
      cN = ctr(N);
    const O = CircleUIManager._circumcenter(cP, cC, cN);
    const rad = Math.hypot(cC.x - O.x, cC.y - O.y);
    const ang = (p) => Math.atan2(p.y - O.y, p.x - O.x);
    const full = cC.w,
      mini = cP.w;
    // Keyframes for a circle swinging along the arc from its own centre to `toAng`,
    // scaling from s0 to s1 (relative to its own width).
    const arc = (from, toAng, s0, s1) => {
      let d = toAng - ang(from);
      while (d > Math.PI) d -= 2 * Math.PI;
      while (d < -Math.PI) d += 2 * Math.PI;
      const frames = [];
      for (let i = 0; i <= 12; i++) {
        const e = i / 12,
          th = ang(from) + d * e;
        const x = O.x + rad * Math.cos(th),
          y = O.y + rad * Math.sin(th);
        const sc = (s0 + (s1 - s0) * e) / from.w;
        frames.push({
          transform: `translate(${(x - from.x).toFixed(2)}px, ${(y - from.y).toFixed(2)}px) scale(${sc.toFixed(4)})`,
        });
      }
      return frames;
    };
    const clicked = which === "prev" ? P : N;
    const clickedFrom = which === "prev" ? cP : cN;
    const exiter = which === "prev" ? N : P; // the club leaving the window
    const clubTo = which === "prev" ? ang(cN) : ang(cP); // where the selected swings to
    const T = 340,
      opts = {
        duration: T,
        easing: "cubic-bezier(0.34, 0, 0.26, 1)",
        fill: "forwards",
      };
    const a1 = clicked.animate(arc(clickedFrom, ang(cC), mini, full), opts);
    const a2 = C.animate(arc(cC, clubTo, full, mini), opts);
    exiter.style.opacity = "0"; // POP out — no fade

    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      [a1, a2].forEach((a) => {
        try {
          a.cancel();
        } catch (e) {}
      });
      for (const el of [P, C, N]) {
        el.style.transform = "";
        el.style.opacity = "";
      }
      onDone(); // commit the new selection + re-render the static 3-club state
      clicked.animate([{ opacity: 0 }, { opacity: 1 }], {
        duration: 200,
        easing: "ease-out",
      }); // the newly-revealed club FADES in
      this._rollAnimating = false;
    };
    Promise.all([a1.finished, a2.finished])
      .then(finish)
      .catch(() => {});
    setTimeout(finish, T + 250); // safety if the WAAPI promises never settle
  }

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
    const prev = document.getElementById("clubPrev");
    const circle = document.getElementById("circleClub");
    const next = document.getElementById("clubNext");
    if (prev) prev.style.display = "flex";
    if (circle) circle.style.display = "flex";
    if (next) next.style.display = "flex";
  }

  hideClubCircle() {
    const prev = document.getElementById("clubPrev");
    const circle = document.getElementById("circleClub");
    const next = document.getElementById("clubNext");
    if (prev) prev.style.display = "none";
    if (circle) circle.style.display = "none";
    if (next) next.style.display = "none";
  }

  hideAllCircles() {
    Object.values(this.circles).forEach((circle) => {
      if (circle) circle.style.display = "none";
    });
    if (this.clubButtonsContainer)
      this.clubButtonsContainer.style.display = "none";
  }

  showAllCircles() {
    Object.values(this.circles).forEach((circle) => {
      if (circle) circle.style.display = "flex";
    });
    if (this.clubButtonsContainer)
      this.clubButtonsContainer.style.display = "flex";
  }

  getCompassSvg() {
    return document.getElementById("compassSvg");
  }

  getClubButtons() {
    if (!this.clubButtonsContainer) return null;
    return {
      prevBtn: this.clubButtonsContainer.querySelector("#clubPrev"),
      nextBtn: this.clubButtonsContainer.querySelector("#clubNext"),
    };
  }

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

    // Course mode: the flag shows the HOLE number and the stats circle shows the
    // hole's PAR. Practice: the aimed-at pin index and no par.
    const cm = this.game?.courseManager;
    const hole = cm ? COURSE_HOLES[cm.holeIndex] : null;
    let pinNumber;
    let par = null;
    if (hole) {
      pinNumber = hole.id;
      par = hole.par;
    } else {
      const targetPin = this.getTargetPin();
      pinNumber = targetPin !== null ? targetPin + 1 : 1;
    }

    if (this.circleUIManager) {
      this.circleUIManager.updateStats(
        speed,
        spin,
        height,
        distanceToPin,
        flagFrame,
        pinNumber,
        par,
      );
    }
  }

  getDistanceToNearestPin() {
    if (!this.game?.scene?.pinManager?.pins?.length) {
      return 0;
    }

    const ballPos = this.golfBall.getPosition();
    const pinManager = this.game.scene.pinManager;

    if (this.game.gameState === GameState.AIM && this.game.aimView) {
      const { distance, pin } = pinManager.getTargetPin(
        ballPos,
        this.game.aimView.cameraRotation,
      );
      if (pin) return distance;
    }

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
  static flagTexturesCache = null;

  constructor(scene, golfBall, eventManager = null) {
    this.scene = scene;
    this.golfBall = golfBall;
    this.eventManager = eventManager || new EventManager();
    this.pins = [];
    this.greens = [];
    this.currentFlagFrame = 0; // shared frame index (0=still, 1-6=animated)

    this.COLLISION_CHECK_RADIUS = CONFIG.PINS.PIN_COLLISION_RADIUS * 3; // 3x collision radius for early detection
    this.SINK_CHECK_RADIUS = CONFIG.PINS.HOLE_RADIUS * 5; // 5x hole radius for precision

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

  addPin(position, scene, opts = {}) {
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
    flagPlane.isPickable = false;

    const flagMat = new BABYLON.StandardMaterial("flagMat", scene);
    flagMat.diffuseTexture = PinManager.flagTexturesCache[0];
    flagMat.diffuseTexture.hasAlpha = true;
    flagMat.useAlphaFromDiffuseTexture = true;
    flagMat.transparencyMode = BABYLON.Material.MATERIAL_ALPHATESTANDBLEND;
    flagMat.backFaceCulling = false;
    flagMat.specularColor = new BABYLON.Color3(0, 0, 0);
    flagPlane.material = flagMat;
    flagPlane.billboardMode = BABYLON.Mesh.BILLBOARDMODE_NONE;

    const flagTextures = PinManager.flagTexturesCache;

    // ── The cup ──
    // Course mode gets a REAL cavity (open-top cylinder well: dark wall + floor
    // colliders) at the pin's actual surface height, so the ball drops in and
    // rests below the lip. Practice keeps the flat decorative disc at the legacy
    // absolute HOLE_Y_OFFSET (its squashed-sphere green isn't surface-sampled).
    const holeMat = new BABYLON.StandardMaterial("holeMat", scene);
    holeMat.diffuseColor = new BABYLON.Color3(0, 0, 0);
    holeMat.specularColor = new BABYLON.Color3(0, 0, 0);
    // Pure black no matter the scene lights, visible from either side (the old
    // practice disc faced DOWN and was backface-culled — an invisible hole).
    holeMat.disableLighting = true;
    holeMat.emissiveColor = new BABYLON.Color3(0, 0, 0);
    holeMat.backFaceCulling = false;

    let hole = null;
    let cupWall = null,
      cupFloor = null,
      cupWallAgg = null,
      cupFloorAgg = null;
    if (opts.cavity) {
      const surfaceY = position.y;
      const r = cfg.HOLE_RADIUS;
      // Dark inner wall (open cylinder) — visually the hole + contains a bouncing ball.
      cupWall = BABYLON.MeshBuilder.CreateCylinder(
        "cupWall",
        {
          diameter: r * 2,
          height: cfg.CUP_DEPTH,
          tessellation: 20,
          cap: BABYLON.Mesh.NO_CAP,
        },
        scene,
      );
      cupWall.position = new BABYLON.Vector3(
        position.x,
        surfaceY - cfg.CUP_DEPTH / 2,
        position.z,
      );
      cupWall.material = holeMat;
      cupWall.isPickable = false;
      cupWallAgg = new BABYLON.PhysicsAggregate(
        cupWall,
        BABYLON.PhysicsShapeType.MESH,
        { mass: 0, friction: 1.0, restitution: 0.05 },
        scene,
      );
      // Cup floor the ball rests on. Made thick (extends well below) so a ball
      // that drops in fast can't tunnel through it — preventTunneling is disabled
      // while the ball is in the cup, so the floor itself must be the backstop.
      const floorH = 0.4;
      cupFloor = BABYLON.MeshBuilder.CreateCylinder(
        "cupFloor",
        { diameter: r * 2, height: floorH, tessellation: 20 },
        scene,
      );
      cupFloor.position = new BABYLON.Vector3(
        position.x,
        surfaceY - cfg.CUP_DEPTH + 0.01 - floorH / 2,
        position.z,
      );
      cupFloor.material = holeMat;
      cupFloor.isPickable = false;
      cupFloorAgg = new BABYLON.PhysicsAggregate(
        cupFloor,
        BABYLON.PhysicsShapeType.CYLINDER,
        { mass: 0, friction: 1.0, restitution: 0.05 },
        scene,
      );
      // Visible mouth: a flat black disc a hair above the green. The cavity is
      // buried inside the (uncut) green mesh, so without this the hole doesn't
      // show against the surface at all.
      hole = BABYLON.MeshBuilder.CreateDisc(
        "holeMouth",
        { radius: r, tessellation: 24 },
        scene,
      );
      hole.position = new BABYLON.Vector3(
        position.x,
        surfaceY + 0.005,
        position.z,
      );
      hole.rotation.x = -Math.PI / 2; // face up
      hole.isPickable = false;
      hole.material = holeMat;
    } else {
      hole = BABYLON.MeshBuilder.CreateDisc(
        "hole",
        { radius: cfg.HOLE_RADIUS, tessellation: 24 },
        scene,
      );
      hole.position = position.clone();
      // Sit a hair above the green surface when the caller knows it (practice
      // passes the squashed-sphere apex); the legacy absolute offset floated
      // the disc 0.23 m in the air.
      hole.position.y = (opts.surfaceY ?? cfg.HOLE_Y_OFFSET) + 0.005;
      hole.rotation.x = -Math.PI / 2; // face up
      hole.isPickable = false;
      hole.material = holeMat;
    }

    this.pins.push({
      mesh: pole,
      body: poleBody,
      poleMat, // per-pin — must be disposed with the pin
      stripeTexture, // per-pin DynamicTexture — must be disposed with the pin
      flagMesh: flagPlane,
      flagPivot,
      flagMat, // per-pin (its diffuseTexture is the shared flagTexturesCache)
      flagTextures,
      hole, // black mouth disc (practice flat cup, or over the course cavity)
      holeMat, // per-pin
      cavity: !!opts.cavity,
      surfaceY: position.y, // green surface height at the cup mouth
      captured: false, // ball has dropped into the cavity, awaiting settle
      captureFrames: 0,
      cupWall,
      cupFloor,
      cupWallAgg,
      cupFloorAgg,
      flagAnimTime: 0,
      flagAnimFrame: 0,
      holePosition: position.clone(),
    });
  }

  addGreen(centerPos, radius, scene) {
    // Flat green pad, styled like the course's greens: same putting texture at
    // the course's world-scale tiling (~1.6 m per tile), same brighter palette
    // and low sheen, and a flat top that actually matches the flat collider
    // below (the old squashed-sphere mound curved away under the ball near the
    // edges). Height keeps the legacy apex (0.001 + radius/100) so the hole
    // disc, sink thresholds and camera floor stay put.
    const padH = radius * 0.01;
    const green = BABYLON.MeshBuilder.CreateCylinder(
      "green",
      { diameter: radius * 2, height: padH, tessellation: 48 },
      scene,
    );
    green.position = centerPos.clone();
    green.position.y = 0.001 + padH / 2;
    green.isPickable = false;

    const greenMat = Utils.createMaterial(
      `greenMat_${Math.random()}`,
      scene,
      new BABYLON.Color3(0.5, 0.82, 0.28), // courseGreen palette
      new BABYLON.Color3(0.02, 0.02, 0.02),
      8,
    );
    // Cylinder caps map UV 0..1 across the diameter; scale so one tile spans
    // ~1.6 world metres, matching CourseSurfaces' green tiling.
    const tiling = (radius * 2) / 1.6;
    const greenDiffuse = new BABYLON.Texture(
      CONFIG.PINS.GREEN_TEXTURE_PATH,
      scene,
    );
    greenDiffuse.wrapU = greenDiffuse.wrapV = BABYLON.Texture.WRAP_ADDRESSMODE;
    greenDiffuse.uScale = greenDiffuse.vScale = tiling;
    greenMat.diffuseTexture = greenDiffuse;
    const greenNormal = new BABYLON.Texture(
      CONFIG.PINS.GREEN_NORMAL_MAP_PATH,
      scene,
    );
    greenNormal.wrapU = greenNormal.wrapV = BABYLON.Texture.WRAP_ADDRESSMODE;
    greenNormal.uScale = greenNormal.vScale = tiling;
    greenMat.bumpTexture = greenNormal;
    green.material = greenMat;
    green.receiveShadows = true;

    // Physics: a thin invisible CYLINDER with real thickness instead of a ~2000-tri
    // MESH collider on the squashed sphere. Much cheaper (no triangle soup + wasted
    // underside), and the thickness prevents fast landings from tunnelling through.
    const colThickness = 1.0;
    const greenTopY = green.position.y + padH / 2; // top of the pad
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
    // Roll like the course greens (SURFACE_PHYSICS.green): true and fast.
    const greenPhysics = new BABYLON.PhysicsAggregate(
      greenCol,
      BABYLON.PhysicsShapeType.CYLINDER,
      {
        mass: 0,
        friction: SURFACE_PHYSICS.green.friction,
        restitution: SURFACE_PHYSICS.green.restitution,
      },
      scene,
    );

    this.greens.push({ mesh: green, body: greenPhysics, collider: greenCol });
    return greenTopY; // surface height at the pin, for placing the hole disc
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

      const distance3D = BABYLON.Vector3.Distance(ballPos, holePos);
      if (distance3D > this.SINK_CHECK_RADIUS) {
        continue;
      }

      if (pin.cavity) {
        this._sinkCavity(pin, ballPos, ballSpeed);
        continue;
      }

      // Legacy proximity trigger (practice mode): snap the ball into the flat cup.
      const dx = ballPos.x - holePos.x;
      const dz = ballPos.z - holePos.z;
      const horizDist = Math.sqrt(dx * dx + dz * dz);
      const nearGround = ballPos.y < CONFIG.PINS.HOLE_Y_OFFSET + 1.5;

      if (
        horizDist < CONFIG.PINS.HOLE_RADIUS * 0.85 &&
        nearGround &&
        ballSpeed < 6
      ) {
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

  // Real cavity cup: a slow ball over the mouth drops in; the hole counts only
  // once the ball comes to rest on the cup floor ("fall in AND stay in"). A ball
  // moving faster than CUP_CAPTURE_SPEED just rolls over the mouth (lips out).
  _sinkCavity(pin, ballPos, ballSpeed) {
    const cfg = CONFIG.PINS;
    const holePos = pin.holePosition;
    const surfaceY = pin.surfaceY;
    const r = CONFIG.BALL.COLLIDER_DIAMETER / 2;
    const dx = ballPos.x - holePos.x;
    const dz = ballPos.z - holePos.z;
    const horizDist = Math.sqrt(dx * dx + dz * dz);

    if (!pin.captured) {
      const overMouth = horizDist < cfg.HOLE_RADIUS * 0.9;
      // Rolling on the green at the mouth (not a shot flying high over it).
      const atSurface =
        ballPos.y < surfaceY + r + 0.06 && ballPos.y > surfaceY - cfg.CUP_DEPTH;
      if (overMouth && atSurface && ballSpeed <= cfg.CUP_CAPTURE_SPEED) {
        // Drop it in, centred just below the lip; gravity then seats it on the floor.
        this.golfBall._inCup = true; // stop preventTunneling from lifting it back out
        this.golfBall.teleport(holePos.x, surfaceY - r - 0.005, holePos.z);
        pin.captured = true;
        pin.captureFrames = 0;
      }
      return;
    }

    // Captured: bounced back out above the lip? let it try again.
    if (ballPos.y > surfaceY + r) {
      pin.captured = false;
      pin.captureFrames = 0;
      this.golfBall._inCup = false;
      return;
    }
    // Wait out the teleport-restore frames, then hole out once it has fallen below
    // the lip and come to rest on the cup floor ("stay in").
    pin.captureFrames++;
    if (
      pin.captureFrames > 3 &&
      ballPos.y < surfaceY - r &&
      ballSpeed < cfg.CUP_SETTLE_SPEED
    ) {
      this.golfBall.landed = true;
      pin.sunk = true;
      this.eventManager.emit("pin:holesink", holePos);
    }
  }

  checkPinCollisions() {
    const ballPos = this.golfBall.getPosition();
    const ballSpeed = this.golfBall.getSpeed();

    // Only check pins within collision detection radius (spatial culling)
    for (const pin of this.pins) {
      const distance = BABYLON.Vector3.Distance(ballPos, pin.mesh.position);

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

      const dotProd = BABYLON.Vector3.Dot(aimVec, toPinFlat);
      const angle = Math.acos(Shared.clamp(dotProd, -1, 1));

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
    let envTexture = null;
    try {
      envTexture = BABYLON.CubeTexture.CreateFromPrefilteredData(
        CONFIG.ENVIRONMENT.ENV_TEXTURE_PATH,
        scene,
      );
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
        scene.environmentTexture = envTexture;
      }
    } catch (err) {}

    const ambientLight = new BABYLON.HemisphericLight(
      "ambient",
      new BABYLON.Vector3(0, 1, 0),
      scene,
    );
    ambientLight.intensity = CONFIG.LIGHTING.AMBIENT_INTENSITY;
    ambientLight.diffuse = new BABYLON.Color3(1.0, 1.0, 1.0);
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

    scene.birdFlockSystem = new BirdFlockSystem(scene, 0, 0);
    await scene.birdFlockSystem.load();
  }

  static createGroundDisc(scene) {
    const radius = 183; // 400 yard diameter (200 yard radius)

    const ground = BABYLON.MeshBuilder.CreateDisc(
      "groundDisc",
      {
        radius: radius,
        tessellation: 64,
      },
      scene,
    );

    ground.rotation.x = Math.PI / 2;
    ground.position.y = 0;

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
    ground.isPickable = false;

    // Physics for terrain - create a separate collision body for reliable ground
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
    collisionBox.visibility = 0;

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

    this.createRollingHillsRing(scene, radius);
    this.createTallerHillsRing(scene, radius);
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
    const segments = 32;
    const innerRadius = groundRadius + 320;
    const outerRadius = groundRadius + 620;
    const baseHeight = -10;
    const maxRise = 120; // Taller than first ring (which is 55)
    const innerPath = [];
    const outerPath = [];

    for (let index = 0; index <= segments; index++) {
      const angle = (index / segments) * Math.PI * 2;
      const cosAngle = Math.cos(angle);
      const sinAngle = Math.sin(angle);

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
      new BABYLON.Color3(0.28, 0.38, 0.2),
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

    const waterMat = new BABYLON.PBRMaterial("sonicWater", scene);

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
    waterDisc.isPickable = false;
    scene.waterRing = waterDisc;

    waterDisc.waterAnimTime = 0;
    waterDisc.diffuseTex = diffuseTex;
    waterDisc.normalTex = normalTex;

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

    if (this.positions.length > 0) {
      const lastPos = this.positions[this.positions.length - 1];
      const distance = BABYLON.Vector3.Distance(position, lastPos);
      if (distance < this.minDistanceBetweenPoints) {
        return;
      }
    }

    this.positions.push(position.clone());
    this.timestamps.push(now);

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
      const result = await Shared.loadModel("clubs.glb", this.scene);

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

    if (ballPosition && this.clubPivot) {
      this.clubPivot.position = ballPosition.clone();
    }
    if (shotDirection !== undefined && this.clubPivot) {
      // Match trajectory arrow convention: Math.PI + cameraRotation = Math.PI - shotDirection
      this.clubPivot.rotation.y = -shotDirection;
    }

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
    const speedRatio = animFrameCount / animFPS / totalSwingDuration;

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

    animation.onAnimationGroupEndObservable.addOnce(() => {
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

    await PhysicsManager.initialize(this.scene);
    if (BABYLON.PhysicsViewer) {
      this.physicsViewer = new BABYLON.PhysicsViewer(this.scene);
    }
    const courseMode = this.mode === "course";
    await SceneSetup.createEnvironment(this.scene, { skipGround: courseMode });

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
    this.eventManager.on("pin:holesink", (holePos) => this.onHoleSink(holePos));

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

    this.golfBall = new GolfBallGuy(bodyMesh, aggregate.body, null, this.scene);
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
      this.eventManager.emit("game:showShotReview", { holeNumber, shotCount });
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
    document.addEventListener("touchmove", handleTouchMove, { passive: false });
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

// ═════════════════════════════════════════════════════════════════════════════
// COURSE MODE — 3-hole match play (loads Blender-authored hole .glb files)
// ═════════════════════════════════════════════════════════════════════════════

// Per-hole definition. Tee, pin/cup and tree placements come from marker meshes
// baked into each .glb; only par/name/notes live here.
// Bump when hole .glb geometry is rebuilt (assets are served immutable-cached).
const HOLE_ASSET_VERSION = "solid-prisms2";
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
      res = await Shared.loadModel("decor.glb", this.scene);
    } catch (e) {
      // Non-fatal: without decor sources, place() returns null and holes simply
      // render with no trees/rocks rather than the whole round failing to load.
      console.warn(
        "Decor model (decor.glb) failed to load; holes will have no trees/rocks.",
        e,
      );
      return;
    }
    for (const name of ["tree1", "tree2", "tree3", "rock1", "rock2", "rock3"]) {
      const node =
        res.meshes.find((m) => m.name === name) ||
        (res.transformNodes || []).find((n) => n.name === name);
      if (!node) continue;
      node.setParent(null); // bake the glTF handedness transform into the node
      node.setEnabled(true);
      // Natural (scale-1) height, so rocks can be sunk halfway into the turf when
      // placed (their origin sits at the base). Union the node + its child meshes.
      const srcMeshes = node.getChildMeshes ? node.getChildMeshes(false) : [];
      if (node.getBoundingInfo) srcMeshes.push(node);
      let lo = Infinity,
        hi = -Infinity;
      for (const cm of srcMeshes) {
        cm.computeWorldMatrix(true);
        const cbb = cm.getBoundingInfo().boundingBox;
        lo = Math.min(lo, cbb.minimumWorld.y);
        hi = Math.max(hi, cbb.maximumWorld.y);
      }
      node._decorHeight = hi > lo ? hi - lo : 2;
      node.position = new BABYLON.Vector3(0, -1000, 0); // park source off-course
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

/** Small top-of-screen hole banner + transient flash messages. */
class CourseHUD {
  constructor() {
    CourseUI.ensureStyles();
    this.flashEl = document.createElement("div");
    this.flashEl.className = "course-flash";
    this.flashEl.style.display = "none";
    document.body.appendChild(this.flashEl);
    this._flashTimer = null;
  }

  // The hole number + par now live in the top-left stats circle; the old center
  // banner (and per-hole title) is gone. Kept as a no-op so callers don't break.
  setHole() {}

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

  hide() {}
}

// Shared style injection + score naming for the course UI.
class CourseUI {
  static _styled = false;
  static ensureStyles() {
    if (CourseUI._styled) return;
    CourseUI._styled = true;
    const css = `
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
    .balls-overlay.splash-in{animation:sbSplash .6s cubic-bezier(.16,1.1,.3,1) both;}
    @keyframes sbSplash{from{-webkit-clip-path:circle(0% at 50% 50%);clip-path:circle(0% at 50% 50%);}
      to{-webkit-clip-path:circle(150% at 50% 50%);clip-path:circle(150% at 50% 50%);}}
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

    /* round end screen: the card is a circle, so its content lives inside the
       inscribed square (.score-inner ~70%×70%), which stays clear of the curve. */
    .score-card{width:min(94vmin,600px);height:min(94vmin,600px);max-width:none;min-width:0;
      border-radius:50%;padding:0;display:flex;align-items:center;justify-content:center;
      background:#eef0ea url('assets/golfball_dimples.jpg') center/cover;}
    .score-inner{width:70%;max-height:70%;overflow:auto;display:flex;flex-direction:column;
      align-items:center;scrollbar-width:none;}
    .score-inner::-webkit-scrollbar{display:none;}
    /* orb sheen that follows the circle instead of the rounded-rect top gloss */
    .score-card::before{inset:0;height:auto;border-radius:50%;
      background:radial-gradient(circle at 50% 24%,rgba(255,255,255,.55),rgba(255,255,255,0) 62%);}
    .score-title{font-size:30px;margin-bottom:2px;}
    .score-card .aero-sub{margin:2px 0 12px;}
    table.scorecard{border-collapse:separate;border-spacing:0;width:100%;margin:6px 0 20px;
      border-radius:16px;overflow:hidden;box-shadow:0 4px 12px rgba(0,60,20,.15);}
    table.scorecard th,table.scorecard td{padding:7px 5px;font-size:14px;text-align:center;}
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

/** Modal overlay helper for the end-of-round Scoreboard. (The old Practice/Course
 *  start menu is gone — the clubhouse doors enter each mode directly.) */
class BallsMenu {
  static _overlay(
    contentHtml,
    { id = "ballsMenu", cardClass = "aero-card" } = {},
  ) {
    const existing = document.getElementById(id);
    if (existing) existing.remove();
    const o = document.createElement("div");
    o.id = id;
    o.className = "balls-overlay";
    o.innerHTML = `<div class="${cardClass}">${contentHtml}</div>`;
    document.body.appendChild(o);
    return o;
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

    const o = BallsMenu._overlay(
      `<div class="score-inner">
        <div class="aero-title score-title">SCORECARD</div>
        ${winLine}
        <table class="scorecard"><thead>${head}${parRow}</thead>
        <tbody class="players">${rows}</tbody></table>
        <button class="aero-btn" id="sbClubhouse">Clubhouse</button>
      </div>`,
      { id: "ballsScoreboard", cardClass: "aero-card score-card" },
    );
    o.classList.add("splash-in"); // end screen opens via an expanding circle
    // The clubhouse (index.html) is the game's root — head back to the lobby.
    // The "course" stamp spawns us just inside the lobby's COURSE door, as if
    // walking back in off the links (see Shared.roomFX + clubhouse arrival).
    o.querySelector("#sbClubhouse").onclick = () =>
      Shared.roomFX.leave("index.html", { from: "course" });
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
    // Holing out is handled by GolfGame.onHoleSink (shared cinematic), which
    // calls this.onHoleComplete() for the course-specific score + advance tail.
    this.scene.onBeforeRenderObservable.add(() => this.frame());
  }

  async start() {
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
    const solid = new Uint8Array(nx * nz); // ray hit terrain (0 = void off the island)
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
          solid[idx] = 1;
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
    this.hg = { minX, minZ, cell, nx, nz, height, playable: eroded, solid };
  }

  groundY(x, z) {
    const hg = this.hg;
    if (!hg) return 0;
    const fx = (x - hg.minX) / hg.cell,
      fz = (z - hg.minZ) / hg.cell;
    let i = Shared.clamp(Math.floor(fx), 0, hg.nx - 2);
    let j = Shared.clamp(Math.floor(fz), 0, hg.nz - 2);
    const tx = Shared.clamp(fx - i, 0, 1),
      tz = Shared.clamp(fz - j, 0, 1);
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

    // Show the loading logo ON TOP for the whole load, every hole. Hole 0 arrives
    // from the clubhouse behind a black arrival cover, and later holes behind the
    // between-hole cover (advance() wiped to black) — showBoot() lifts the logo
    // above both, so the player sees the logo instead of plain black. The reveal
    // (below) is a logo opacity-fade, which can't freeze the way the width/height
    // iris does when the new hole's first render stalls the main thread.
    Shared.showBoot();
    const reveal = () => {
      Shared.roomFX.clearCovers(); // drop the black cover(s) sitting behind the logo…
      Shared.hideBoot(); //           …then fade the logo out to reveal the hole
    };

    // Cache-bust: hole .glb files are served immutable, so version the request
    // to pick up rebuilt geometry. Force the glb loader since the query hides the ext.
    let res;
    try {
      res = await Shared.loadModel(cfg.glb, this.scene, {
        root: "",
        version: HOLE_ASSET_VERSION,
      });
    } catch (e) {
      console.error(
        `Hole ${index + 1} geometry (${cfg.glb}) failed to load.`,
        e,
      );
      await reveal();
      this.busy = false;
      return;
    }

    let teeMarker = null;
    const pinMarkers = [];
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
        pinMarkers.push(mesh); // flat-spot pin pool (marker_pin_0..N)
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
    if (!teeMarker || pinMarkers.length === 0) {
      console.error(
        `Hole ${index + 1} is missing marker_tee/marker_pin; skipping.`,
      );
      await reveal();
      this.busy = false;
      return;
    }

    // Tee world position from marker.
    teeMarker.computeWorldMatrix(true);
    this.tee = teeMarker.getAbsolutePosition().clone();

    // Pick this hole's pin from the flat-spot pool: random each round, unless the
    // hole forces a specific spot via COURSE_HOLES[index].pinIndex (purposeful).
    // Chosen once per hole load, so every hot-seat player plays the same pin.
    const pinIdx = (n) => {
      const m = /marker_pin_(\d+)/.exec(n);
      return m ? +m[1] : 0;
    };
    pinMarkers.sort((a, b) => pinIdx(a.name) - pinIdx(b.name));
    const forced = COURSE_HOLES[index]?.pinIndex;
    const chosen = Number.isInteger(forced)
      ? pinMarkers[Shared.clamp(forced, 0, pinMarkers.length - 1)]
      : pinMarkers[Math.floor(Math.random() * pinMarkers.length)];
    chosen.computeWorldMatrix(true);
    this.cup = chosen.getAbsolutePosition().clone();
    // Anchor the cup to the EXACT green surface at the pin via a downward ray (the
    // marker sits off the undulating surface, and the coarse height grid can be a
    // couple cm off — the tee peg uses the same trick), so the cavity lines up with
    // the turf. Fall back to the height grid if the ray misses.
    const cupRay = new BABYLON.Ray(
      new BABYLON.Vector3(this.cup.x, this.cup.y + 50, this.cup.z),
      new BABYLON.Vector3(0, -1, 0),
      100,
    );
    const cupHit = this.scene.pickWithRay(
      cupRay,
      (m) => m.name && m.name.startsWith("surf_"),
    );
    this.cup.y =
      cupHit && cupHit.hit
        ? cupHit.pickedPoint.y
        : this.groundY(this.cup.x, this.cup.z);

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
      // undulating ground (bigger tree → deeper plant); bury each rock halfway
      // under the turf for realism (rock origin sits at its base). The collider
      // stays at ground level (groundPos) so collision is unchanged.
      const groundPos = pos.clone();
      if (isTree) {
        pos.y -= 0.5 + 0.25 * s;
      } else {
        const rh = this.decor.sources[type]?._decorHeight || 2;
        pos.y -= 0.5 * rh * s;
      }
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
        this.addDecorCollider(dm.name, groundPos, s); // collider on the exposed half
      }
      dm.dispose();
    }
    teeMarker.dispose();
    for (const pm of pinMarkers) pm.dispose();

    // Cup / flag / sink detection. Point auto-aim at THIS hole's cup (otherwise
    // it keeps aiming at the previous hole's now-disposed pin).
    this.pinManager.addPin(this.cup.clone(), this.scene, { cavity: true });
    this.game.currentHolePin =
      this.pinManager.pins[this.pinManager.pins.length - 1];

    this.placeBallAtTee();
    this.hud.setHole(cfg.id, cfg.par, cfg.name);
    this.game.isControlsDisabled = true;
    this.game.aimView?.deactivate?.();

    // Hold the logo until every mesh + texture is ready (no flash of just the ball
    // + water). Race a 4 s safety so a stuck texture can't keep the logo up forever.
    await Promise.race([
      this.scene.whenReadyAsync(),
      new Promise((r) => setTimeout(r, 4000)),
    ]);
    const drone = new DroneCamera(this.scene);
    const flyDone = drone.fly(
      this.tee.clone(),
      this.cup.clone(),
      this.game.camera.camera,
    );
    // Let the first couple of frames render behind the logo so the shader-compile
    // hitch on the new hole's materials happens hidden, not during the reveal.
    await new Promise((r) =>
      requestAnimationFrame(() => requestAnimationFrame(r)),
    );
    reveal();
    await flyDone;

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
      {
        height: pegH,
        diameterTop: 0.05,
        diameterBottom: 0.012,
        tessellation: 10,
      },
      this.scene,
    );
    peg.position = new BABYLON.Vector3(
      pos.x,
      this.teeSurfaceY() + pegH / 2,
      pos.z,
    );
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
    // Metres, to match ClubData.maxDistance (findBestClubForDistance compares
    // against it directly). Passing yards here biased tee shots toward woods.
    const distToPin = BABYLON.Vector3.Distance(this.tee, this.cup);
    const bestClub =
      this.game.aimView?.clubSelector?.findBestClubForDistance(distToPin) ?? 0;
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
      this.applyWaterPenalty(pos);
      return;
    }
    this.lastLie = pos.clone();
  }

  applyPenalty(msg, dropPos = null) {
    this.game.currentHoleShotCount += 1; // penalty stroke
    this.hud.flash(msg, 1800);
    const drop = (dropPos || this.lastLie || this.tee).clone();
    drop.y += 0.5;
    this.game.golfBall.startPosition = drop.clone();
    this.game.golfBall.reset();
    this.game._awaitingSettle = false;
    this.game.gameState = GameState.AIM;
    this.game.aimView?.activate();
  }

  applyWaterPenalty(pos) {
    // Drop on the nearest flat dry ground that doesn't gain distance on the
    // hole, rather than replaying from the previous lie / tee.
    this.applyPenalty("💦 Water — +1", this.findWaterDrop(pos));
  }

  // Nearest height-grid cell to the water entry point that is dry, roughly
  // level, on real terrain (not the void off the island's edge) and no closer
  // to the cup than where the ball went in. Returns null when nothing
  // qualifies — the caller then falls back to the last lie.
  findWaterDrop(entry) {
    const hg = this.hg;
    if (!hg || !hg.solid || !this.cup || !entry) return null;
    const DRY = 0.2; // min clearance above the waterline (m)
    const FLAT = 0.35; // max height step to any neighbour cell (3 m away) ≈ 12%
    const entryCupSq =
      (entry.x - this.cup.x) ** 2 + (entry.z - this.cup.z) ** 2;
    const H = (i, j) => hg.height[i * hg.nz + j];
    const S = (i, j) => hg.solid[i * hg.nz + j];
    let best = null;
    let bestSq = Infinity;
    for (let i = 1; i < hg.nx - 1; i++) {
      for (let j = 1; j < hg.nz - 1; j++) {
        // The cell and its 4 neighbours must all be real ground — this also
        // keeps the drop a full cell away from the island's edge.
        if (
          !S(i, j) ||
          !S(i - 1, j) ||
          !S(i + 1, j) ||
          !S(i, j - 1) ||
          !S(i, j + 1)
        )
          continue;
        const h = H(i, j);
        if (h < this.waterlineY + DRY) continue; // submerged / beach line
        if (
          Math.abs(H(i - 1, j) - h) > FLAT ||
          Math.abs(H(i + 1, j) - h) > FLAT ||
          Math.abs(H(i, j - 1) - h) > FLAT ||
          Math.abs(H(i, j + 1) - h) > FLAT
        )
          continue; // too sloped to count as flat
        const x = hg.minX + i * hg.cell;
        const z = hg.minZ + j * hg.cell;
        const cupSq = (x - this.cup.x) ** 2 + (z - this.cup.z) ** 2;
        if (cupSq < entryCupSq) continue; // would gain ground on the hole
        const dSq = (x - entry.x) ** 2 + (z - entry.z) ** 2;
        if (dSq < bestSq) {
          bestSq = dSq;
          best = new BABYLON.Vector3(x, h, z);
        }
      }
    }
    return best;
  }

  // Course tail of holing out, invoked by GolfGame.onHoleSink after the shared
  // cinematic. Re-entry is already guarded by GolfGame.holeSinkProcessed.
  onHoleComplete(shotCount) {
    this.holeComplete = true;
    this.busy = true;
    const par = COURSE_HOLES[this.holeIndex].par;
    const strokes = Math.max(1, shotCount);
    this.players[this.currentPlayer].scores[this.holeIndex] = strokes;
    this.hud.flash(CourseUI.scoreName(strokes, par), 2600);
    // Show the make result, then advance to the next hole (no shot overview for
    // now). clearArchivedTrails releases this hole's trails before the teardown.
    setTimeout(() => {
      this.game.clearArchivedTrails();
      this.advance();
    }, 2200);
  }

  async advance() {
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
      // Circle-wipe to black BEFORE tearing down the old hole so the swap (dispose
      // + load) is hidden; loadHole reopens the iris once the new hole is ready.
      this.busy = true;
      await Shared.roomFX.irisClose();
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
    if (this.pinManager?.pins) {
      for (const pin of this.pinManager.pins) {
        try {
          pin.body?.dispose?.();
          pin.mesh?.dispose();
          pin.flagMesh?.dispose();
          pin.flagPivot?.dispose();
          pin.hole?.dispose();
          pin.cupWallAgg?.dispose?.();
          pin.cupFloorAgg?.dispose?.();
          pin.cupWall?.dispose();
          pin.cupFloor?.dispose();
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
    CourseManager,
    GolfGame,
  };
}
