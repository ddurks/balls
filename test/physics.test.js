const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const B = require("babylonjs");
const Havok = require("@babylonjs/havok");

globalThis.BABYLON = B;
globalThis.window = { innerWidth: 1280, removeEventListener() {} };
globalThis.Shared = require("../src/shared/shared.js");
const { CONFIG } = require("../src/game/config.js");
require("../src/game/utils.js");
const { PhysicsManager } = require("../src/game/physics.js");
const { GolfBallGuy } = require("../src/game/character.js");
const { SURFACE_PHYSICS } = require("../src/game/course.js");

const havok = Havok({
  wasmBinary: fs.readFileSync(
    path.join(
      path.dirname(require.resolve("@babylonjs/havok")),
      "HavokPhysics.wasm",
    ),
  ),
});

const R = CONFIG.BALL.COLLIDER_DIAMETER / 2;

// A ball resting on a green tilted `slopeDeg` about Z (10° by default).
async function makeBall(t, slopeDeg = 10) {
  const engine = new B.NullEngine();
  const scene = new B.Scene(engine);
  PhysicsManager.enable(scene, new B.HavokPlugin(true, await havok));
  const ground = B.MeshBuilder.CreateGround(
    "surf_green",
    { width: 100, height: 100 },
    scene,
  );
  ground.rotation.z = (slopeDeg * Math.PI) / 180;
  ground.computeWorldMatrix(true);
  ground._surfacePhysics = SURFACE_PHYSICS.green;
  new B.PhysicsAggregate(
    ground,
    B.PhysicsShapeType.MESH,
    {
      mass: 0,
      friction: SURFACE_PHYSICS.green.friction,
      restitution: SURFACE_PHYSICS.green.restitution,
    },
    scene,
  );
  const n = B.Vector3.TransformNormal(B.Axis.Y, ground.getWorldMatrix());
  n.normalize();
  const g = new B.Vector3(0, -9.81, 0);
  const downhill = g.subtract(n.scale(B.Vector3.Dot(g, n)));
  if (downhill.length() > 1e-9) downhill.normalize();
  const mesh = B.MeshBuilder.CreateSphere(
    "ball",
    { diameter: CONFIG.BALL.COLLIDER_DIAMETER },
    scene,
  );
  mesh.position.copyFrom(n.scale(R));
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
  t.after(() => {
    scene.dispose();
    engine.dispose();
  });
  // One 60 FPS render frame, as game.updateBallState() sees it.
  const frame = () => {
    scene._advancePhysicsEngineStep(1000 / 60);
    return ball.updateLandingState();
  };
  const run = (seconds, onFrame = () => {}) => {
    for (let i = 0; i < seconds * 60; i++) onFrame(frame());
  };
  // A putt already rolling without slipping at `speed` along unit tangent `dir`.
  const roll = (speed, dir) => {
    ball.landed = false;
    const v = dir.scale(speed);
    ball.body.setLinearVelocity(v);
    ball.body.setAngularVelocity(B.Vector3.Cross(n, v).scale(1 / R));
  };
  return { ball, scene, ground, downhill, frame, run, roll };
}

const holdDeg =
  (Math.asin(SURFACE_PHYSICS.green.rollingResistance) * 180) / Math.PI;

test("a green holds a stopped ball just below asin(μr) and releases it above", async (t) => {
  const below = await makeBall(t, holdDeg - 0.5);
  below.run(0.5);
  const lie = below.ball.getPosition().clone();
  below.run(10);
  assert.ok(B.Vector3.Distance(lie, below.ball.getPosition()) < 1e-3);
  assert.ok(below.ball.isLanded(), "a held ball counts as at rest");

  const above = await makeBall(t, holdDeg + 0.5);
  const start = above.ball.getPosition().clone();
  let landed = false;
  above.run(5, (s) => (landed ||= s === "fullLand"));
  assert.ok(B.Vector3.Distance(start, above.ball.getPosition()) > 0.3);
  assert.ok(!landed, "a ball easing off an unholdable slope is not at rest");
});

test("an uphill putt stops and stays on a slope the green can hold", async (t) => {
  const { ball, downhill, run, roll } = await makeBall(t, holdDeg - 1);
  run(0.5);
  roll(0.5, downhill.negate());
  let state = null;
  run(5, (s) => (state ||= s === "fullLand" ? s : null));
  assert.equal(state, "fullLand");
  const lie = ball.getPosition().clone();
  run(5);
  assert.ok(B.Vector3.Distance(lie, ball.getPosition()) < 1e-3);
});

test("an uphill putt that stops on a slope steeper than the hold rolls back", async (t) => {
  const { ball, downhill, run, roll } = await makeBall(t, holdDeg + 3);
  run(0.1);
  const start = ball.getPosition().clone();
  roll(1, downhill.negate());
  let landed = false;
  run(4, (s) => (landed ||= s === "fullLand"));
  const back = B.Vector3.Dot(ball.getPosition().subtract(start), downhill);
  assert.ok(back > 0.2, `ended ${back.toFixed(3)} m downhill of the start`);
  assert.ok(!landed, "the turnaround was mistaken for rest");
});

test("the next putt from a settled lie launches at the requested speed", async (t) => {
  const { ball, scene, run } = await makeBall(t, 3);
  run(1);
  assert.ok(ball.isLanded());
  ball.applyHit(0, 0, 87.5, 0, 0, 17);
  assert.equal(ball.isLanded(), false);
  assert.ok(
    Math.abs(ball.getVelocity().z + 8.5) < 0.02,
    JSON.stringify({ v: ball.getVelocity() }),
  );
  scene._advancePhysicsEngineStep(1000 / 60);
  assert.ok(ball.getPosition().z < -0.04);
});

test("teleporting a settled ball upward lets it fall under gravity", async (t) => {
  const { ball, run } = await makeBall(t, 3);
  run(1);
  ball.teleport(0, 2, 0);
  run(10 / 60);
  assert.ok(ball.getPosition().y < 1.95);
});

test("a slow airborne ball is not declared at rest at the top of its arc", async (t) => {
  const { ball, frame } = await makeBall(t);
  ball.body.setGravityFactor(0); // hang at the apex
  ball.mesh.position.y = 0.5;
  ball.mesh.computeWorldMatrix(true);
  ball.teleport(0, 0.5, 0);
  for (let i = 0; i < 30; i++) assert.notEqual(frame(), "fullLand");
  assert.equal(ball.isLanded(), false);
});

test("a putt still rolling is not declared at rest", async (t) => {
  const { ball, run, roll } = await makeBall(t, 0);
  run(0.5);
  roll(0.3, new B.Vector3(0, 0, -1));
  let state = null;
  run(0.3, (s) => (state ||= s));
  assert.notEqual(state, "fullLand");
  assert.ok(ball.getPosition().z < -0.05);
});

test("rest detection still works on a surface with no rolling law", async (t) => {
  const { ground, run } = await makeBall(t, 0);
  ground._surfacePhysics = undefined; // like the cup floor or a tee peg
  let state = null;
  run(2, (s) => (state ||= s === "fullLand" ? s : null));
  assert.equal(state, "fullLand");
});

test("an initial lie stays put and reset drops the ball under gravity", async (t) => {
  const { ball, run } = await makeBall(t, 3);
  ball.landed = true;
  run(0.5);
  const start = ball.getPosition().clone();
  run(2);
  assert.ok(B.Vector3.Distance(start, ball.getPosition()) < 1e-3);
  ball.startPosition.y = 2;
  ball.reset();
  run(10 / 60);
  assert.ok(ball.getPosition().y < 1.95);
});

test("sphere sweep recovers a crossed slope using collision geometry", async (t) => {
  const { ball, ground } = await makeBall(t);
  // Deliberately misleading shading normals must not change the bounce.
  const normals = ground
    .getVerticesData(B.VertexBuffer.NormalKind)
    .map((_, i) => (i % 3 === 0 ? -1 : 0));
  ground.setVerticesData(B.VertexBuffer.NormalKind, normals);
  ball._stepStart.set(0, 1, 0);
  ball.mesh.position.set(1, -1, -1);
  ball.mesh.computeWorldMatrix(true);
  ball.body.setLinearVelocity(new B.Vector3(30, -60, -30));
  ball.preventTunneling();
  assert.ok(
    ball.getPosition().y > -0.01,
    "recovered at the first crossed surface",
  );
  assert.ok(ball.getPosition().x < 0.6, "did not lift at the endpoint");
  assert.ok(
    ball.getVelocity().x > 0,
    "forward momentum survives a gentle slope",
  );
  assert.ok(ball.getVelocity().z < 0);
  assert.ok(
    ball.getSpeed() < Math.hypot(30, -60, -30),
    "bounce cannot add energy",
  );
});

test("recovery judges by where the step ended, not by contact events", async (t) => {
  const { ball, ground } = await makeBall(t);
  const n = B.Vector3.TransformNormal(B.Axis.Y, ground.getWorldMatrix());
  n.normalize();
  // Havok resolved the impact: the step ended on the surface. No second bounce.
  ball._stepStart.set(0, 1, 0);
  ball.mesh.position.copyFrom(n.scale(R));
  ball.body.setLinearVelocity(new B.Vector3(0, -60, -30));
  ball._collidedThisStep = true;
  const before = ball.getVelocity();
  ball.preventTunneling();
  assert.ok(B.Vector3.Distance(before, ball.getVelocity()) < 1e-6);
  // A contact was reported but the step still ended through the surface.
  ball._stepStart.set(0, 1, 0);
  ball.mesh.position.set(0, -1, -1);
  ball._collidedThisStep = true;
  ball.preventTunneling();
  assert.ok(ball.getPosition().y > -0.01, "recovered on top of the surface");
  assert.ok(B.Vector3.Dot(ball.getVelocity(), n) > 0, "bounced off it");
});

test("native green impacts use the green's restitution", async (t) => {
  const { ball, scene } = await makeBall(t);
  ball.teleport(0, 0.5, 0);
  ball.body.setLinearVelocity(new B.Vector3(0, -3, 0));
  let rebound = 0;
  for (let i = 0; i < 80; i++) {
    scene._advancePhysicsEngineStep(1000 / 120);
    rebound = Math.max(rebound, ball.getVelocity().y);
  }
  assert.ok(rebound > 0.05 && rebound < 0.8, `rebound ${rebound} m/s`);
});

// ---- launch spin and wind, through the shared Havok harness ----
const harness = require("./helpers/havok-harness.js");
const { Wind } = require("../src/game/wind.js");

// Full-power shot from a flat fairway, optionally in a 10 m/s crosswind; returns
// the peak |ω| in flight, the sideways drift at landing and the roll direction.
async function windShot(t, clubName, windForce = null) {
  const w = await harness.createWorld(t, { surface: "fairway", size: 1600 });
  w.ball.teleport(0, R, 780);
  w.run(1);
  if (windForce) {
    w.ball.wind = new Wind();
    w.ball.wind.direction = Math.PI / 2;
    w.ball.wind.speed = 10;
  }
  const club = harness.ClubData.CLUBS.find((c) => c.name === clubName);
  const tee = w.ball.getPosition().clone();
  w.ball.applyHit(0, 0, 175, 0, club.angle, club.v0);
  let spin = 0;
  let land = null;
  let landDir = null;
  let state = null;
  for (let i = 0; i < 40 * w.fps && state !== "fullLand"; i++) {
    state = w.frame();
    if (!land && !w.ball._onGround)
      spin = Math.max(spin, w.ball.getAngularVelocity().length());
    if (state === "firstContact" && !land) {
      land = w.ball.getPosition().clone();
      landDir = w.ball._stepStartVel.clone();
      landDir.y = 0;
      landDir.normalize();
    }
  }
  const roll = w.ball.getPosition().subtract(land);
  roll.y = 0;
  const rollAngle =
    (Math.acos(B.Vector3.Dot(roll.normalize(), landDir)) * 180) / Math.PI;
  return { spin, drift: land.x - tee.x, rollAngle };
}

test("a no-swipe drive flies without spin", async (t) => {
  const r = await windShot(t, "Driver");
  assert.ok(r.spin < 0.5, `peak spin in flight ${r.spin.toFixed(2)} rad/s`);
});

test("crosswind drift scales with airspeed: full shots as tuned, roll-out straight", async (t) => {
  for (const name of ["Driver", "7 Iron"]) {
    const r = await windShot(t, name, true);
    // The tuned drift: the same wind as a constant force all the way down.
    const fullSpeed = CONFIG.WIND.FULL_FORCE_SPEED;
    CONFIG.WIND.FULL_FORCE_SPEED = 1e-9;
    const constant = await windShot(t, name, true);
    CONFIG.WIND.FULL_FORCE_SPEED = fullSpeed;
    assert.ok(
      Math.abs(r.drift / constant.drift - 1) <= 0.15,
      `${name} drift ${r.drift.toFixed(1)} m vs tuned ${constant.drift.toFixed(1)} m`,
    );
    assert.ok(
      r.rollAngle < 20,
      `${name} rolled ${r.rollAngle.toFixed(1)}° off its landing line`,
    );
  }
});
