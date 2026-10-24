// Shared Havok harness for behavioural ball tests. Mirrors the game's runtime
// wiring so tests exercise real code paths:
//  - surfaces are stamped by CourseManager.prototype.setupSurface itself (so any
//    per-surface property the course adds is picked up automatically);
//  - the ball is built exactly like test/physics.test.js / scripts/physics-audit.js;
//  - frame() = course.frame() heightRef update + fixed-substep physics advance +
//    game.updateBallState()'s updateLandingState(), at an arbitrary render FPS;
//  - the world is configured by PhysicsManager.enable, like the game's;
//  - flight forces (Magnus; wind is left unset) run in the ball's own per-step hook.
const fs = require("node:fs");
const path = require("node:path");
const B = require("babylonjs");
const Havok = require("@babylonjs/havok");

globalThis.BABYLON = B;
globalThis.window = { innerWidth: 1280, removeEventListener() {} };
globalThis.Shared = require("../../src/shared/shared.js");
const { CONFIG, GameState } = require("../../src/game/config.js");
const { EventManager } = require("../../src/game/utils.js");
const { PhysicsConfig, PhysicsManager } = require("../../src/game/physics.js");
const { GolfBallGuy } = require("../../src/game/character.js");
const { CourseSurfaces } = require("../../src/game/terrain.js");
const { CourseManager } = require("../../src/game/course.js");
const { FollowCamera } = require("../../src/game/camera.js");
const { InputHandler } = require("../../src/game/input.js");
const { ClubData } = require("../../src/game/clubs.js");

const havok = Havok({
  wasmBinary: fs.readFileSync(
    path.join(
      path.dirname(require.resolve("@babylonjs/havok")),
      "HavokPhysics.wasm",
    ),
  ),
});

const R = CONFIG.BALL.COLLIDER_DIAMETER / 2;

// surface: green|fairway|rough|sand|rock. slopeDeg tilts the plane; downhill is
// returned as a unit tangent so tests don't depend on Babylon's handedness.
async function createWorld(
  t,
  { surface = "green", slopeDeg = 0, size = 120, fps = 60 } = {},
) {
  const engine = new B.NullEngine();
  const scene = new B.Scene(engine);
  PhysicsManager.enable(scene, new B.HavokPlugin(true, await havok));

  const meshName = surface === "rock" ? "surf_rockface" : `surf_${surface}`;
  const ground = B.MeshBuilder.CreateGround(
    meshName,
    { width: size, height: size },
    scene,
  );
  ground.rotation.x = (slopeDeg * Math.PI) / 180;
  ground.computeWorldMatrix(true);
  const course = {
    scene,
    surfaces: {
      forSurfaceName: CourseSurfaces.prototype.forSurfaceName,
      mats: {},
    },
    surfaceMeshes: [],
    holeAggregates: [],
  };
  CourseManager.prototype.setupSurface.call(course, ground);

  const n = B.Vector3.TransformNormal(
    B.Axis.Y,
    ground.getWorldMatrix(),
  ).normalize();
  if (n.y < 0) n.scaleInPlace(-1);
  const g = PhysicsConfig.GRAVITY;
  const downhill = g.subtract(n.scale(B.Vector3.Dot(g, n)));
  if (downhill.length() > 1e-9) downhill.normalize();
  else downhill.set(0, 0, -1);
  const groundY = (x, z) => -(n.x * x + n.z * z) / n.y;

  const mesh = B.MeshBuilder.CreateSphere(
    "ball",
    { diameter: CONFIG.BALL.COLLIDER_DIAMETER },
    scene,
  );
  mesh.position.copyFrom(n.scale(R));
  mesh.computeWorldMatrix(true);
  const aggregate = new B.PhysicsAggregate(
    mesh,
    B.PhysicsShapeType.SPHERE,
    {
      mass: CONFIG.BALL.MASS,
      friction: CONFIG.BALL.FRICTION,
      restitution: CONFIG.BALL.RESTITUTION,
    },
    scene,
  );
  aggregate.body.setLinearDamping(CONFIG.BALL.LINEAR_DAMPING);
  aggregate.body.setAngularDamping(CONFIG.BALL.ANGULAR_DAMPING);
  const ball = new GolfBallGuy(mesh, aggregate.body, null, scene);
  ball.updateSpinAura = () => {};
  ball.landed = false;
  ball.touchedGround = true;

  const world = {
    scene,
    ball,
    ground,
    n,
    downhill,
    groundY,
    fps,
    frame() {
      const p = ball.getPosition();
      ball.heightRef = groundY(p.x, p.z);
      scene._advancePhysicsEngineStep(1000 / fps);
      return ball.updateLandingState();
    },
    // Put the ball on the surface at horizontal (x,z), rolling without slip at
    // `speed` along unit tangent `dir` (ω = n × v / R).
    setRolling(speed, dir = downhill, x = 0, z = 0) {
      const v = dir.scale(speed);
      ball.teleport(x, groundY(x, z) + R / n.y, z, true);
      ball.landed = false;
      ball.touchedGround = true;
      ball.body.setLinearVelocity(v);
      ball.body.setAngularVelocity(B.Vector3.Cross(n, v).scale(1 / R));
    },
    // Run until the game reports fullLand (or the ball is in the landed state).
    rollOut(maxSeconds = 30, onFrame = null) {
      const start = ball.getPosition().clone();
      let state = null;
      for (let i = 0; i < maxSeconds * fps; i++) {
        state = world.frame();
        if (onFrame) onFrame(i);
        if (state === "fullLand") break;
      }
      return { state, distance: B.Vector3.Distance(start, ball.getPosition()) };
    },
    run(seconds, onFrame = null) {
      for (let i = 0; i < Math.round(seconds * fps); i++) {
        const s = world.frame();
        if (onFrame) onFrame(i, s);
      }
    },
  };
  t.after(() => {
    scene.dispose();
    engine.dispose();
  });
  return world;
}

// A real FollowCamera in PLAY view, snapped (no smoothing lag) to `yaw`.
function makeFollowCamera(world, yaw) {
  const cam = new B.UniversalCamera("cam", new B.Vector3(0, 1, 5), world.scene);
  const follow = new FollowCamera(cam, world.ball.mesh, world.ball);
  follow.setPlayView();
  follow.setCameraAngleImmediate(yaw);
  follow.update(10);
  cam.computeWorldMatrix(true);
  return follow;
}

// Real InputHandler pointer path for an in-flight spin swipe (screen px, +y down).
function swipeSpin(world, follow, dx, dy) {
  const events = new EventManager();
  let emitted = null;
  events.on("input:spin", (d) => (emitted = d));
  const game = {
    gameState: GameState.PLAY,
    camera: follow,
    justTransitioned: false,
    isControlsDisabled: false,
  };
  const input = new InputHandler(
    { addEventListener() {} },
    world.ball,
    game,
    events,
  );
  input.handlePointerDown({ clientX: 640, clientY: 360 });
  input.handlePointerMove({ clientX: 640 + dx, clientY: 360 + dy });
  input.handlePointerUp({ clientX: 640 + dx, clientY: 360 + dy });
  if (emitted) world.ball.applySpin(emitted.spinAxis, emitted.spinAmount);
  return emitted;
}

module.exports = {
  B,
  GolfBallGuy,
  ClubData,
  R,
  createWorld,
  makeFollowCamera,
  swipeSpin,
};
