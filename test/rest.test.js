// Every ball that has stopped is called at rest (GolfBallGuy's "fullLand"),
// and is still enough for the game to hand back the swing; nothing spins in
// place or creeps on for good. Each case is the bare mechanism of a shot that
// never ended in sim-vs-sim matches (test/mp/sim-rest.test.js replays those);
// the last checks that the 2 s backstop for a crawl can't end a ball that is
// only slow because it is starting to roll.
const test = require("node:test");
const assert = require("node:assert/strict");
const { B, R, createWorld } = require("./helpers/havok-harness.js");
const { CONFIG } = require("../src/game/config.js");
const { CourseSurfaces } = require("../src/game/terrain.js");
const { CourseManager } = require("../src/game/course.js");

// A mesh stamped as a course surface, by the course's own setupSurface.
function stamp(world, mesh) {
  CourseManager.prototype.setupSurface.call(
    {
      scene: world.scene,
      surfaces: {
        forSurfaceName: CourseSurfaces.prototype.forSurfaceName,
        mats: {},
      },
      surfaceMeshes: [],
      holeAggregates: [],
    },
    mesh,
  );
}

// Still enough for GolfGame.updateBallState to go back to AIM.
function assertStill(ball) {
  assert.ok(ball.getSpeed() < 0.03, `moving at ${ball.getSpeed()} m/s`);
  const spin = ball.getAngularVelocity().length();
  assert.ok(
    spin < CONFIG.PHYSICS.LANDED_ANGULAR_THRESHOLD,
    `spinning at ${spin} rad/s`,
  );
}

test("a ball plugged in a bunker's vertical lip stops spinning and comes to rest", async (t) => {
  const w = await createWorld(t, { surface: "sand" });
  // A sand wall facing +x at x = 0, and a ball plugged in it 0.3 m up (sand
  // holds a ball at any tilt), still spinning from the shot: nothing presses
  // it into a vertical face for friction to take the spin.
  const wall = B.MeshBuilder.CreateBox(
    "surf_sand_lip",
    { width: 0.4, height: 2, depth: 4 },
    w.scene,
  );
  wall.position.set(-0.2, 1, 0);
  wall.computeWorldMatrix(true);
  stamp(w, wall);
  const { ball } = w;
  ball.teleport(R, 0.3, 0, true);
  w.run(0.05); // the teleport hands the body back to the solver
  ball.setOnGround(true);
  ball._contactPhysics = wall._surfacePhysics;
  const face = new B.Vector3(1, 0, 0);
  for (const n of ball._supportNormals) n.copyFrom(face);
  ball._contactNormal.copyFrom(face);
  ball.landed = false;
  ball.touchedGround = true;
  ball.inShot = true;
  ball.body.setLinearVelocity(B.Vector3.Zero());
  ball.body.setAngularVelocity(new B.Vector3(0, 0, 80));
  const { state } = w.rollOut(10);
  assert.equal(state, "fullLand");
  assertStill(ball);
  assert.ok(ball.getPosition().y > 0.25, "it stayed plugged in the lip");
});

test("a held ball isn't pushed along the contact it came to rest on", async (t) => {
  const w = await createWorld(t, { surface: "sand" });
  const { ball } = w;
  w.setRolling(0);
  w.rollOut(3);
  // Held, it keeps the contact normal it stopped on (Havok's wander at rest).
  // Here that is a 20° face it no longer touches: a push into it would run
  // partly along the flat sand it sits on.
  const tilted = new B.Vector3(Math.sin(0.35), Math.cos(0.35), 0);
  for (const n of ball._supportNormals) n.copyFrom(tilted);
  ball._contactNormal.copyFrom(tilted);
  ball.landed = false;
  ball.inShot = true;
  const before = ball.getPosition().clone();
  const { state } = w.rollOut(10);
  assert.equal(state, "fullLand");
  assertStill(ball);
  const moved = B.Vector3.Distance(before, ball.getPosition());
  assert.ok(moved < 0.005, `crept ${moved} m`);
});

test("a ball wedged against a rock on rough too steep to hold comes to rest", async (t) => {
  // Rough holds 14.5°; this slope is 18°.
  const w = await createWorld(t, { surface: "rough", slopeDeg: 18 });
  const { ball, downhill, n } = w;
  // A rock (a decor collider: no course surface) with its face across the
  // slope at z = 0, and the ball rolling into it from 5 cm up the slope.
  const rock = B.MeshBuilder.CreateBox(
    "decorCol_rock",
    { width: 0.6, height: 0.6, depth: 0.6 },
    w.scene,
  );
  rock.position.set(0, w.groundY(0, 0.3), 0.3);
  rock.computeWorldMatrix(true);
  new B.PhysicsAggregate(rock, B.PhysicsShapeType.BOX, { mass: 0 }, w.scene);
  w.setRolling(0.05, downhill, 0, -0.05);
  ball.inShot = true;
  const { state } = w.rollOut(10);
  assert.equal(state, "fullLand");
  assertStill(ball);
  const p = ball.getPosition();
  assert.ok(
    Math.abs(p.z + R) < 0.005,
    `rests at z ${p.z}, not against the rock`,
  );
  assert.ok(B.Vector3.Dot(p, n) < R + 0.01, "on the ground");
});

test("a ball kept to a crawl by something the rolling law doesn't model is at rest after 2 s", async (t) => {
  // Fairway holds 8.6°: on 12° the turf alone never holds a ball.
  const w = await createWorld(t, { surface: "fairway", slopeDeg: 12 });
  const { ball, downhill, n } = w;
  w.setRolling(0);
  ball.inShot = true;
  // Whatever holds it (on the course: two surface meshes it is caught
  // between) lets it crawl at 1.5 cm/s, under turf's catch speed, still
  // pressed onto the slope.
  w.scene.onBeforePhysicsObservable.add(() => {
    if (ball.isLanded()) return;
    const v = ball.body.getLinearVelocity();
    const press = Math.min(0, B.Vector3.Dot(v, n));
    ball.body.setLinearVelocity(downhill.scale(0.015).add(n.scale(press)));
  });
  let frames = 0;
  const { state } = w.rollOut(10, () => frames++);
  assert.equal(state, "fullLand");
  const seconds = frames / w.fps;
  assert.ok(seconds >= 2 && seconds < 2.2, `called at rest after ${seconds} s`);
  assertStill(ball);
});

test("a ball easing off a slope it can't hold is not called at rest", async (t) => {
  // The green holds 5.2°; at 6° a ball set down still slips away, slowly.
  const w = await createWorld(t, { surface: "green", slopeDeg: 6 });
  const { ball } = w;
  w.setRolling(0);
  ball.inShot = true;
  let landedAt = null;
  w.run(3, (i, s) => {
    if (s === "fullLand" && landedAt === null) landedAt = i;
  });
  assert.equal(landedAt, null, `called at rest after ${landedAt / w.fps} s`);
  assert.ok(ball.getSpeed() > 0.1, `only ${ball.getSpeed()} m/s after 3 s`);
});
