// physics.js — PhysicsConfig, PhysicsManager.
// Split out of game.js; loaded as a plain <script> before game.js (see game.html),
// and require()-able in Node for unit tests. Cross-module refs resolve via globals.
(function (global) {
  // ─── PHYSICS CONFIGURATION ──────────────────────────────────────────────────

  class PhysicsConfig {
    static STEP_SECONDS = 1 / 120;
    static GRAVITY = new BABYLON.Vector3(0, -9.81, 0);
    static BALL_MASS = CONFIG.BALL.MASS;
    static BALL_FRICTION = CONFIG.BALL.FRICTION;
    static BALL_RESTITUTION = CONFIG.BALL.RESTITUTION;
    static BALL_LINEAR_DAMPING = CONFIG.BALL.LINEAR_DAMPING;
    static BALL_ANGULAR_DAMPING = CONFIG.BALL.ANGULAR_DAMPING;

    // Sourced from CONFIG.PHYSICS so tuning lives in one place (this class is just
    // a typed accessor kept for its many existing call sites).
    static HIT_FORWARD_FORCE = CONFIG.PHYSICS.HIT_FORWARD_FORCE;
    static HIT_UPWARD_FORCE = CONFIG.PHYSICS.HIT_UPWARD_FORCE;
    static SPIN_MULTIPLIER = CONFIG.PHYSICS.SPIN_MULTIPLIER;

    static MIN_SWIPE_DISTANCE = CONFIG.PHYSICS.MIN_SWIPE_DISTANCE;
  }

  // ─── PHYSICS MANAGER ──────────────────────────────────────────────────────────

  class PhysicsManager {
    static async initialize(scene) {
      const havokInstance = await HavokPhysics();
      const physicsPlugin = new BABYLON.HavokPlugin(true, havokInstance);
      PhysicsManager.enable(scene, physicsPlugin);
      return physicsPlugin;
    }

    // Shared by the game and the Node test/audit harnesses so their worlds match.
    static enable(scene, physicsPlugin) {
      scene.enablePhysics(PhysicsConfig.GRAVITY, physicsPlugin);
      const engine = scene.getPhysicsEngine();
      engine.setTimeStep(PhysicsConfig.STEP_SECONDS);
      // Babylon's scene accumulator takes milliseconds; the plugin takes seconds.
      engine.setSubTimeStep(PhysicsConfig.STEP_SECONDS * 1000);
      // Havok's default 100 rad/s angular cap stops a 42.7 mm ball rolling above
      // ~2.1 m/s (it skids instead) and silently clamps swipe spin. Set before any
      // body exists: the limit is only picked up by bodies created afterwards.
      engine.setVelocityLimits(300, 2000);
    }
  }

  Object.assign(global, { PhysicsConfig, PhysicsManager });
  if (typeof module !== "undefined" && module.exports)
    module.exports = { PhysicsConfig, PhysicsManager };
})(typeof globalThis !== "undefined" ? globalThis : this);
