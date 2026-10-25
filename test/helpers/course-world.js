// A real course hole in Node, for headless game clients (test/mp/sim-client.js).
// Built on the Havok harness's globals, then driven through the game's own
// CourseManager: loadHole() runs for real (GLB, centring, surface stamping,
// height grid, waterline, pin pool, cavity cup, trees + rocks with their
// colliders, the tee peg), so a ball shot here plays the hole the browser does.
// Only browser-only bits are shimmed: asset fetches read files from assets/,
// the drone flyover and render-readiness waits resolve at once, and the cup's
// stripe texture draws onto a stub canvas.
const fs = require("node:fs");
const path = require("node:path");
const { setImmediate } = require("node:timers");
const H = require("./havok-harness.js");
const B = H.B;
require("babylonjs-loaders");
const { CONFIG, GameState } = require("../../src/game/config.js");
const { EventManager } = require("../../src/game/utils.js");
const { PhysicsConfig, PhysicsManager } = require("../../src/game/physics.js");
const { Wind } = require("../../src/game/wind.js");
const { ClubSelector } = require("../../src/game/clubs.js");
const { CourseDecor, CourseSurfaces } = require("../../src/game/terrain.js");
const { CourseManager, COURSE_HOLES } = require("../../src/game/course.js");
const { PinManager } = require("../../src/game/ui.js");

const ROOT = path.join(__dirname, "..", "..");

// ---- headless shims (process-wide, idempotent) ------------------------------
function installShims() {
  if (globalThis.__courseWorldShims) return;
  globalThis.__courseWorldShims = true;
  globalThis.Shared.loadModel = async (file, scene) => {
    const buf = fs.readFileSync(path.join(ROOT, "assets", file));
    return B.SceneLoader.ImportMeshAsync(
      "",
      "",
      new Uint8Array(buf),
      scene,
      null,
      ".glb",
    );
  };
  // The drone flyover is camera-only and needs rendered frames to finish.
  globalThis.DroneCamera = class {
    fly() {
      return Promise.resolve();
    }
  };
  if (!globalThis.requestAnimationFrame)
    globalThis.requestAnimationFrame = (cb) => setImmediate(() => cb(0));
  // PinManager.addPin paints its pole stripes on a 2D canvas. The stub DOM
  // exists only for that call: Babylon changes behaviour process-wide when it
  // sees a global document.
  const addPin = PinManager.prototype.addPin;
  const ctx = new Proxy({}, { get: () => () => {} });
  const stubDocument = {
    createElement: () => ({ width: 0, height: 0, getContext: () => ctx }),
  };
  PinManager.prototype.addPin = function (...args) {
    if (globalThis.document) return addPin.apply(this, args);
    globalThis.document = stubDocument;
    try {
      return addPin.apply(this, args);
    } finally {
      delete globalThis.document;
    }
  };
  B.Logger.LogLevels = B.Logger.ErrorLogLevel;
  // Flag frames are textures only the renderer reads.
  PinManager.flagTexturesCache = Array.from({ length: 7 }, () => ({
    hasAlpha: false,
    dispose() {},
  }));
}

// The ball exactly as GolfGame.loadGolfBall builds it.
function createBall(scene, wind) {
  const mesh = B.MeshBuilder.CreateSphere(
    "ballBody",
    { diameter: CONFIG.BALL.COLLIDER_DIAMETER, segments: 8 },
    scene,
  );
  mesh.position = new B.Vector3(0, 0.425, 150);
  mesh.isVisible = false;
  mesh.isPickable = false;
  const aggregate = new B.PhysicsAggregate(
    mesh,
    B.PhysicsShapeType.SPHERE,
    {
      mass: PhysicsConfig.BALL_MASS,
      friction: PhysicsConfig.BALL_FRICTION,
      restitution: PhysicsConfig.BALL_RESTITUTION,
    },
    scene,
  );
  aggregate.body.setLinearDamping(PhysicsConfig.BALL_LINEAR_DAMPING);
  aggregate.body.setAngularDamping(PhysicsConfig.BALL_ANGULAR_DAMPING);
  const ball = new H.GolfBallGuy(mesh, aggregate.body, null, scene);
  ball.updateSpinAura = () => {};
  ball.wind = wind;
  return ball;
}

/**
 * One headless course session: a scene + Havok world + ball + CourseManager,
 * reused across holes like the game's (disposeHole between them).
 * world.decor lists every tree/rock collider the current hole built.
 */
async function createCourse({ fps = 60 } = {}) {
  installShims();
  const engine = new B.NullEngine();
  const scene = new B.Scene(engine);
  PhysicsManager.enable(scene, new B.HavokPlugin(true, await H.havok));
  // Readiness only gates the reveal of a rendered frame.
  scene.whenReadyAsync = () => Promise.resolve();

  const wind = new Wind();
  const ball = createBall(scene, wind);
  const events = new EventManager();
  const clubSelector = new ClubSelector(null);
  const game = {
    scene,
    mode: "course",
    options: { players: 1 },
    golfBall: ball,
    wind,
    eventManager: events,
    camera: { camera: null },
    gameState: GameState.AIM,
    isControlsDisabled: false,
    currentHoleShotCount: 0,
    holeSinkProcessed: false,
    currentHolePin: null,
    aimView: {
      clubSelector,
      cameraRotation: 0,
      isActive: false,
      get currentClub() {
        return clubSelector.currentClub;
      },
      activate() {},
      deactivate() {},
      removeOrbitControls() {},
    },
    normalizeAngle: (a) => Math.atan2(Math.sin(a), Math.cos(a)),
    clearArchivedTrails() {
      game.holeSinkProcessed = false;
    },
  };
  const course = new CourseManager(game);
  game.courseManager = course;
  // CourseManager.init minus rendering: decor sources, physics-only surface
  // stamping (no textures), a silent HUD, the real pin manager + canopy hook.
  course.decor = new CourseDecor(scene);
  await course.decor.load();
  course.surfaces = {
    forSurfaceName: CourseSurfaces.prototype.forSurfaceName,
    mats: {},
  };
  course.hud = { setHole() {}, flash() {}, hide() {} };
  course.pinManager = new PinManager(scene, ball, events);
  scene.pinManager = course.pinManager;
  events.on("ball:landed", (pos) => course.onBallLanded(pos));
  scene
    .getPhysicsEngine()
    .getPhysicsPlugin()
    .onTriggerCollisionObservable.add((ev) => course.onCanopyTrigger(ev));
  course.addDecorCollider = function (type, isTree, pos, yaw, scale) {
    world.decor.push({ type, isTree, pos: pos.clone(), yaw, scale });
    return CourseManager.prototype.addDecorCollider.apply(this, arguments);
  };

  const world = {
    B,
    engine,
    scene,
    ball,
    wind,
    events,
    game,
    course,
    clubSelector,
    fps,
    holeIndex: -1,
    decor: [],
    // pinIndex forces the hole's pin (match play gets it from the server).
    async loadHole(index, pinIndex) {
      if (world.holeIndex >= 0) course.disposeHole();
      world.decor = [];
      course.holes = COURSE_HOLES.map((h, i) =>
        i === index ? { ...h, pinIndex } : h,
      );
      await course.loadHole(index, pinIndex);
      world.holeIndex = index;
    },
    // One rendered frame of the game loop, in its order: physics, the course
    // frame (heightRef, out of bounds), GolfGame.updateBallState's landing
    // (a shot coming to rest emits ball:landed: water hazard), hole sink.
    frame() {
      scene._advancePhysicsEngineStep(1000 / fps);
      course.frame();
      const state = ball.updateLandingState();
      if (state === "fullLand" && ball.inShot) {
        ball.inShot = false;
        events.emit("ball:landed", ball.getPosition().clone());
      }
      scene.pinManager.checkHoleSink();
      return state;
    },
    dispose() {
      scene.dispose();
      engine.dispose();
    },
  };
  return world;
}

module.exports = { createCourse, COURSE_HOLES, B };
