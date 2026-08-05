// physics.js — PhysicsConfig, PhysicsManager.
// Split out of game.js; loaded as a plain <script> before game.js (see game.html),
// and require()-able in Node for unit tests. Cross-module refs resolve via globals.
(function (global) {
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

  Object.assign(global, { PhysicsConfig, PhysicsManager });
  if (typeof module !== "undefined" && module.exports)
    module.exports = { PhysicsConfig, PhysicsManager };
})(typeof globalThis !== "undefined" ? globalThis : this);
