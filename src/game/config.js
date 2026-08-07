// config.js — GameState, CameraViewMode, PALETTE, UNITS, CONFIG.
// Split out of game.js; loaded as a plain <script> before game.js (see game.html),
// and require()-able in Node for unit tests. Cross-module refs resolve via globals.
(function (global) {
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
      // Air drag (above) also over-brakes a ball ROLLING on the ground, so it stops
      // instead of releasing into roll. Apply this much lower damping once grounded
      // (ROLL_BRAKE_DECEL + slope still settle it); flight keeps LINEAR_DAMPING so
      // carry stays calibrated. Lower = more roll-out (and longer putts).
      ROLL_LINEAR_DAMPING: 0.08,
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
      // Strength of the player's mid-flight spin-swipe, ADDED on top of the strike's
      // loft backspin (see applySpin). Scaled so a firm swipe imparts bite-capable
      // spin comparable to a wedge's loft — swipe down = more backspin (more bite),
      // up = topspin (kills the check, runs out), sideways = curve. Total spin from
      // all sources is clamped to STRIKE_SPIN_MAX.
      SPIN_MULTIPLIER: 6000,
      // Backspin the LOFT imparts at the strike (rad/s ≈ loft° × power × this) — the
      // real source of "bite". High-loft wedges spin hard AND land steeply (low
      // horizontal speed at landing), so friction can check/draw them back; low-loft
      // clubs spin little and land shallow, so they run out. The sphere collider
      // tolerates high spin fine. Capped by _MAX. Higher = more bite.
      STRIKE_SPIN_FACTOR: 13,
      STRIKE_SPIN_MAX: 850,
      // Magnus: aerodynamic force F = MAGNUS_COEFF × (ω × v) applied while airborne.
      // Backspin lifts (carry/float), topspin drops, sidespin curves (slice/hook).
      // This adds lift → carry, so club v0s get recalibrated once this is dialed.
      MAGNUS_COEFF: 0.000025,
      SPIN_ANIMATION_SPEED: 0.3,
      MIN_SWIPE_DISTANCE: 3,
      AIRBORNE_HEIGHT: 2,
      GROUND_CONTACT_HEIGHT: 1.5,
      // Speed below which a grounded ball is declared "landed" — which HARD-ZEROES
      // its velocity. At 0.5 m/s (1.1 mph) that amputated the last ~0.2 m of every
      // roll and made slow trickle-ins impossible. 0.15 lets the ball roll out; the
      // rolling-resistance brake (ROLL_BRAKE_DECEL) does the actual settling at 0.06 m/s.
      LANDED_SPEED_THRESHOLD: 0.15,
      // A manually-spun ball can momentarily have near-zero LINEAR speed while its
      // spin is still converting to roll; don't declare it stopped (which zeroes the
      // velocity and kills the roll-out) until its ANGULAR speed is also low. A ball
      // rolling without slipping at the linear threshold spins at ~7 rad/s, so 15
      // clears normal settling but blocks a fast manual spin.
      LANDED_ANGULAR_THRESHOLD: 15,
      // Spin aura: the player-applied spin amount (0..~1.2) that maxes the aura to
      // flaming red, and the glow sphere's diameter relative to the ball collider.
      SPIN_AURA_MAX: 1.1,
      SPIN_AURA_SCALE: 2.0,
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
      BLADES_PER_CELL: 400, // blades per CELL_SIZE² chunk (~25/m²)
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
      // Motion is tuned to REAL scale, matching the 1:1 world (0.6 m bird):
      // velocities/forces are per-60fps-frame units, so MAX_SPEED 0.2 ≈ 12 m/s
      // cruise and MAX_FORCE 0.004 ≈ 14 m/s² → ~10 m banked turns. (The old
      // 1.2/0.06 dated from the pre-rescale giant world: 72 m/s with snap turns
      // — the birds whipped around like insects.)
      COUNT: 40,
      CYLINDER_RADIUS: 120,
      // Flight band 20–45 m: low enough to read as birds, not specks (the old
      // ceiling was 160 m), high enough to clear the 3×-scale treetops (~19 m).
      CYLINDER_MIN_HEIGHT: 20,
      CYLINDER_MAX_HEIGHT: 45,
      VISUAL_RANGE: 18,
      // ~5 body lengths for a 0.6 m bird; must stay BELOW the landing-cluster
      // scatter in maybeStartLanding or separation blocks group touchdowns.
      MIN_AVOID_DISTANCE: 3,
      MAX_SPEED: 0.2, // per-60fps-frame; integration is now delta-timed
      MAX_FORCE: 0.004, // steering-force clamp → smooth turns (no jerk)
      CENTERING_FACTOR: 0.0002,
      AVOID_FACTOR: 0.05,
      MATCHING_FACTOR: 0.05,
      SEPARATION_WEIGHT: 1.2,
      // Uniform scale for the ballsbird.glb model. It's authored ~2.5 m long, which
      // dwarfed the world once everything went real-scale (42.7 mm ball); 0.25 brings
      // it to a believable ~0.6 m bird. Tune up for more presence, down for smaller.
      MODEL_SCALE: 0.25,
      WANDER_STRENGTH: 0.002,
      CLIMB_ANIMATION_BOOST: 1.5,
      DESCENT_ANIMATION_DAMPEN: 0.6,
      ROTATE_SMOOTH: 5, // orientation lerp rate (higher = snappier)
      // Landing / perching — land a bit more often and linger longer, so close-up
      // ground encounters are common now that the flock lives lower.
      LAND_CHANCE: 0.06, // base per-second chance a flying bird starts landing
      LAND_JOIN_BONUS: 0.12, // small extra chance near an already-landed group
      GROUP_RANGE: 20, // horizontal range for "join the group" landings
      GROUP_CAP: 6, // stop adding join-bonus once a group reaches this many
      ARRIVAL_RADIUS: 10, // start decelerating within this of the landing spot
      TOUCHDOWN_DIST: 1.0, // perch once this close to the spot
      PERCH_SECONDS_MIN: 4,
      PERCH_SECONDS_MAX: 20,
      TAKEOFF_KICK: 0.09, // initial upward velocity on takeoff (~5 m/s hop)
      TAKEOFF_HEIGHT: 10, // climb this far above the surface before free flight
      CLIMB_FORCE: 0.003,
      STARTLE_RADIUS: 1, // ball this close (m) makes perched/landing birds bolt — small, to match the 42.7 mm ball so birds can perch right near it
      // Floating on water (bottom of the bird rides at the surface, bobbing)
      WATER_FLOAT: 0.06, // mean height of the bird's underside above the water
      WATER_BOB_AMP: 0.1,
      WATER_BOB_SPEED: 1.6,
      WATER_DRIFT: 0.6, // slow horizontal drift while floating (units/sec)
    },
  };

  Object.assign(global, { GameState, CameraViewMode, PALETTE, UNITS, CONFIG });
  if (typeof module !== "undefined" && module.exports)
    module.exports = { GameState, CameraViewMode, PALETTE, UNITS, CONFIG };
})(typeof globalThis !== "undefined" ? globalThis : this);
