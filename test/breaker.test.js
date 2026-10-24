// Red-team regressions for the one-model ball physics. Each test reproduces a
// confirmed defect through real game code paths (GolfBallGuy, setupSurface,
// applyHit, the swipe InputHandler) and asserts the arcade-golf expectation.
// Run: node --test test/breaker.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  B,
  ClubData,
  R,
  createWorld,
  makeFollowCamera,
  swipeSpin,
} = require("./helpers/havok-harness.js");
const { CourseManager, COURSE_HOLES } = require("../src/game/course.js");
const { CourseSurfaces } = require("../src/game/terrain.js");

const CLUB = Object.fromEntries(ClubData.CLUBS.map((c) => [c.name, c]));

// Run until fullLand or `seconds` elapse; returns what the game would see.
function untilRest(w, seconds) {
  let state = null;
  let i = 0;
  for (; i < seconds * w.fps && state !== "fullLand"; i++) state = w.frame();
  return {
    state,
    t: i / w.fps,
    v: w.ball.getSpeed(),
    omega: w.ball.getAngularVelocity().length(),
    omegaN: B.Vector3.Dot(w.ball.getAngularVelocity(), w.ball._contactNormal),
  };
}
const fmt = (o) =>
  JSON.stringify(o, (_, v) => (typeof v === "number" ? +v.toFixed(4) : v));

function stamp(w, mesh) {
  const course = {
    scene: w.scene,
    surfaces: {
      forSurfaceName: CourseSurfaces.prototype.forSurfaceName,
      mats: {},
    },
    surfaceMeshes: [],
    holeAggregates: [],
  };
  mesh.computeWorldMatrix(true);
  CourseManager.prototype.setupSurface.call(course, mesh);
  return course;
}

// ─── Spin about the contact normal never decays ────────────────────────────────
// Havok has no torsional (spinning) friction and the rolling law only zeroes spin
// when |ω|·R ≤ 0.1 m/s, while rest needs |ω| < 1 rad/s. A stopped ball keeping
// > ~4.7 rad/s about the normal therefore spins in place forever and the game
// never leaves PLAY. Real turf kills that spin within a fraction of a second.

test("K1 a stopped ball spinning 10 rad/s about the vertical on a flat green comes to rest", async (t) => {
  const w = await createWorld(t, { surface: "green" });
  w.run(0.5);
  w.ball.landed = false;
  w.ball.body.setAngularVelocity(new B.Vector3(0, 10, 0));
  const r = untilRest(w, 10);
  assert.equal(r.state, "fullLand", `never came to rest ${fmt(r)}`);
});

test("K2 7 iron with a sideways swipe onto a flat fairway comes to rest", async (t) => {
  const w = await createWorld(t, { surface: "fairway", size: 600 });
  const ball = w.ball;
  ball.teleport(0, R, 250);
  w.run(1);
  ball.landed = false;
  ball.touchedGround = false;
  const club = CLUB["7 Iron"];
  ball.applyHit(0, 0, 175, 0, club.angle, club.v0);
  let swiped = false;
  let state = null;
  let i = 0;
  for (; i < 60 * w.fps && state !== "fullLand"; i++) {
    state = w.frame();
    if (!swiped && ball.getHeight() > 2 && ball.getVelocity().y > 0) {
      swiped = !!swipeSpin(w, makeFollowCamera(w, 0), 120, 0);
    }
  }
  assert.ok(swiped, "swipe produced no input:spin");
  assert.equal(
    state,
    "fullLand",
    `still in PLAY after 60 s: v=${ball.getSpeed().toFixed(4)} ω=${ball.getAngularVelocity().toString()}`,
  );
});

// Same defect with no swipe at all: on the real hole-2 green, an ordinary putt
// picks up spin about the normal crossing the mesh's creases (the roll axis of
// one facet has a component along the next facet's normal) and never rests.
test("K3 an ordinary putt on the real hole 2 green comes to rest", async (t) => {
  const w = await createWorld(t, { surface: "green", size: 1 });
  require("babylonjs-loaders");
  const glb = fs.readFileSync(
    path.join(__dirname, "..", "assets", COURSE_HOLES[1].glb),
  );
  const res = await B.SceneLoader.ImportMeshAsync(
    "",
    "",
    new Uint8Array(glb),
    w.scene,
    null,
    ".glb",
  );
  const root = res.meshes.find((m) => m.name === "__root__");
  root.computeWorldMatrix(true);
  const bb = root.getHierarchyBoundingVectors(true);
  root.position.x -= (bb.min.x + bb.max.x) / 2;
  root.position.z -= (bb.min.z + bb.max.z) / 2;
  root.computeWorldMatrix(true);
  const surf = res.meshes.filter((m) => m.name.startsWith("surf_"));
  for (const m of surf) stamp(w, m);
  const [x, z] = [9.7, -65.56];
  const hit = w.scene.pickWithRay(
    new B.Ray(new B.Vector3(x, 300, z), new B.Vector3(0, -1, 0), 600),
    (m) => m.name.startsWith("surf_green"),
  );
  assert.ok(hit && hit.hit, "start point is not on the green");
  const n = hit.getNormal(true, false);
  w.ball.teleport(
    x + n.x * R,
    hit.pickedPoint.y + n.y * R + 0.0005,
    z + n.z * R,
  );
  w.run(3 / w.fps);
  w.ball.landed = true;
  w.ball.applyHit(0, 0, 77.2, 0.157, 0, CLUB.Putter.v0);
  const r = untilRest(w, 40);
  assert.equal(r.state, "fullLand", `putt never came to rest ${fmt(r)}`);
});

// ─── Valley crease steeper than the hold angle ─────────────────────────────────
// The rolling law decides hold/brake against ONE contact normal (the last stamped
// event). In a V crease whose faces are both steeper than asin(μr), neither face
// alone "holds", so the ball rocks across the crease forever (a ±2 cm limit cycle
// at ~0.2 m/s with constant energy) instead of settling in the bottom.

function vCrease(scene, name, deg, half = 3, len = 6) {
  const h = half * Math.tan((deg * Math.PI) / 180);
  const vd = new B.VertexData();
  vd.positions = [
    -half,
    h,
    -len,
    0,
    0,
    -len,
    0,
    0,
    len,
    -half,
    h,
    len,
    half,
    h,
    -len,
    half,
    h,
    len,
  ];
  vd.indices = [0, 1, 2, 0, 2, 3, 1, 4, 5, 1, 5, 2];
  const m = new B.Mesh(name, scene);
  vd.applyToMesh(m);
  return m;
}

test("K4 a ball released into a 6° green valley crease settles at the bottom", async (t) => {
  const w = await createWorld(t, { surface: "green", size: 1 });
  w.ground.physicsBody.dispose(); // only the crease below the ball
  stamp(w, vCrease(w.scene, "surf_green_crease", 6));
  const a = (6 * Math.PI) / 180;
  w.ball.teleport(0.5, 0.5 * Math.tan(a) + R / Math.cos(a) + 0.002, 0);
  w.ball.landed = false;
  w.ball.touchedGround = true;
  const r = untilRest(w, 15);
  assert.equal(
    r.state,
    "fullLand",
    `rocked in the crease for 15 s ${fmt({ ...r, x: w.ball.getPosition().x })}`,
  );
});

// ─── Fast landing on a green runs on almost without loss ───────────────────────
// Green turfDrag is 0 (to keep putts, up to 7.3 m/s, pure μr), so a ball that lands
// on a green at full-shot speed rolls at 5/7·μr·g ≈ 0.63 m/s² from ~19 m/s: a driver
// runs ~250 m and a 3 wood ~95 m. Real/arcade: it hops and skids off the back, a
// few tens of metres at most.
test("K5 a full driver landing on a flat green rolls out less than 60 m", async (t) => {
  const FIELD = 1600;
  const w = await createWorld(t, { surface: "green", size: FIELD, fps: 60 });
  const ball = w.ball;
  ball.teleport(0, R, FIELD / 2 - 20);
  w.run(1);
  const tee = ball.getPosition().clone();
  ball.landed = false;
  ball.touchedGround = false;
  const club = CLUB.Driver;
  ball.applyHit(0, 0, 175, 0, club.angle, club.v0);
  let carry = null;
  let state = null;
  for (let i = 0; i < 90 * w.fps && state !== "fullLand"; i++) {
    state = w.frame();
    if (state === "firstContact" && carry === null)
      carry = tee.z - ball.getPosition().z;
  }
  const total = tee.z - ball.getPosition().z;
  assert.ok(carry !== null, "never landed");
  assert.ok(
    total - carry < 60,
    `driver carry ${carry.toFixed(1)} m then rolled ${(total - carry).toFixed(1)} m on the green`,
  );
});

// ─── restoreSlowRoll over-returns just above the hold angle ────────────────────
// The rolling law promises 5/7·g·(sinθ − μr) once a slope can't be held. Just
// above asin(μr) the slow-contact give-back adds ~0.0025 m/s² on top, so the ball
// creeps away 30–100% faster than the law (green 5.3°: +31%; 5.2°: +105%).
test("K6 green 5.3°: a released ball covers the rolling law's distance within 15% over 10 s", async (t) => {
  const deg = 5.3;
  const w = await createWorld(t, { surface: "green", slopeDeg: deg });
  w.run(0.2);
  w.ball.landed = false;
  const p0 = w.ball.getPosition().clone();
  w.run(10);
  const d = B.Vector3.Distance(p0, w.ball.getPosition());
  const { SURFACE_PHYSICS } = require("../src/game/course.js");
  const a =
    (5 / 7) *
    9.81 *
    (Math.sin((deg * Math.PI) / 180) - SURFACE_PHYSICS.green.rollingResistance);
  const law = 0.5 * a * 10 * 10;
  assert.ok(
    Math.abs(d - law) <= 0.15 * law,
    `moved ${d.toFixed(3)} m vs law ${law.toFixed(3)} m`,
  );
});

// ─── Round 2 ───────────────────────────────────────────────────────────────────

async function loadHole(w, index) {
  require("babylonjs-loaders");
  const glb = fs.readFileSync(
    path.join(__dirname, "..", "assets", COURSE_HOLES[index].glb),
  );
  const res = await B.SceneLoader.ImportMeshAsync(
    "",
    "",
    new Uint8Array(glb),
    w.scene,
    null,
    ".glb",
  );
  const root = res.meshes.find((m) => m.name === "__root__");
  root.computeWorldMatrix(true);
  const bb = root.getHierarchyBoundingVectors(true);
  root.position.x -= (bb.min.x + bb.max.x) / 2;
  root.position.z -= (bb.min.z + bb.max.z) / 2;
  root.computeWorldMatrix(true);
  for (const m of res.meshes.filter((m) => m.name.startsWith("surf_")))
    stamp(w, m);
}

function surfaceY(w, x, z) {
  const hit = w.scene.pickWithRay(
    new B.Ray(new B.Vector3(x, 300, z), new B.Vector3(0, -1, 0), 600),
    (m) => m.name.startsWith("surf_") && !m.name.includes("water"),
  );
  return hit && hit.hit ? hit.pickedPoint.y : null;
}

// A full driver from the hole 3 tee area lands on the rough at ~37 m/s (vy −16.6)
// where a 28° facet meets the ground plane. Havok reports the contact (two events,
// one per facet) but the ball ends that step 2 cm under the surface still moving
// down at 9 m/s, and falls through the course on the next step. preventTunneling
// never runs: it skips any step with a collision event. Repro state recorded from
// a real shot (course sweep), replayed here.
test("K7 a driver landing on hole 3's rough does not fall through the terrain", async (t) => {
  const w = await createWorld(t, { surface: "green", size: 1, fps: 120 });
  await loadHole(w, 2);
  const ball = w.ball;
  const v = new B.Vector3(-3.65, -16.59, -33.57);
  const p = new B.Vector3(-41.2, 3.17, -74.99).subtract(v.scale(0.04));
  ball.teleport(p.x, p.y, p.z);
  w.run(3 / 120);
  ball.mesh.position.copyFrom(p);
  ball.teleport(p.x, p.y, p.z);
  ball._teleportRestoreFrames = 1;
  ball.body.setLinearVelocity(v);
  ball.landed = false;
  ball.touchedGround = false;
  let lowest = Infinity;
  for (let i = 0; i < 60; i++) {
    w.frame();
    const q = ball.getPosition();
    const sy = surfaceY(w, q.x, q.z);
    if (sy !== null) lowest = Math.min(lowest, q.y - sy);
  }
  assert.ok(
    lowest > -0.05,
    `ball centre went ${(-lowest).toFixed(2)} m below the terrain surface`,
  );
});

// The support-normal memory survives teleport()/reset(): a ball that last rested
// in a valley crease (memory spans both faces → "upright") and is then reset onto
// a plain 8° green — steeper than the green's 5.2° hold — is held there for good,
// because a held ball stops recording new normals. Penalty drops, tee placement
// and hole resets all go through reset().
test("K8 after resting in a crease, a ball reset onto a plain 8° green rolls away", async (t) => {
  const w = await createWorld(t, { surface: "green", size: 1 });
  w.ground.physicsBody.dispose();
  stamp(w, vCrease(w.scene, "surf_green_crease", 12));
  const slope = B.MeshBuilder.CreateGround(
    "surf_green_slope",
    { width: 10, height: 10 },
    w.scene,
  );
  slope.position.set(50, 0, 0);
  slope.rotation.z = (8 * Math.PI) / 180;
  stamp(w, slope);
  const a = (12 * Math.PI) / 180;
  w.ball.teleport(0.3, 0.3 * Math.tan(a) + R / Math.cos(a) + 0.001, 0);
  w.run(0.05);
  w.ball.landed = false;
  w.ball.touchedGround = true;
  assert.equal(
    untilRest(w, 20).state,
    "fullLand",
    "never rested in the crease",
  );
  const s = Math.sin(a * (8 / 12));
  const c = Math.cos(a * (8 / 12));
  w.ball.startPosition = new B.Vector3(50 - s * (R + 2e-4), c * (R + 2e-4), 0);
  w.ball.reset();
  const start = w.ball.getPosition().clone();
  w.run(3);
  const moved = B.Vector3.Distance(start, w.ball.getPosition());
  assert.ok(
    moved > 0.5,
    `held on 8° green by stale support: moved ${(moved * 100).toFixed(1)} cm in 3 s, landed=${w.ball.isLanded()}`,
  );
});

// restoreSlowRoll still pumps energy into a ball rocking across a crease: on a
// 14° fairway V it sustains a ±12 mm, ~0.1 m/s limit cycle for ~18 s (fullLand at
// 22.3 s at any FPS); with the refund disabled the same ball rests in 4.3 s.
test("K9 a ball released into a 14° fairway valley crease comes to rest within 8 s", async (t) => {
  const w = await createWorld(t, { surface: "fairway", size: 1 });
  w.ground.physicsBody.dispose();
  stamp(w, vCrease(w.scene, "surf_fairway_crease", 14));
  const a = (14 * Math.PI) / 180;
  w.ball.teleport(0.5, 0.5 * Math.tan(a) + R / Math.cos(a) + 0.001, 0);
  w.run(3 / 60);
  w.ball.landed = false;
  w.ball.touchedGround = true;
  const r = untilRest(w, 8);
  assert.equal(r.state, "fullLand", `still rocking after 8 s ${fmt(r)}`);
});

// ─── Round 3 ───────────────────────────────────────────────────────────────────

// K7 passes only at its exact phase: the same hole-3 landing started 0.03 s
// earlier along its path still ends 1.5 m under the turf. Havok slows the ball to
// 5.9 m/s in the step it ends 3 cm through the surface, so preventTunneling — which
// gates on the speed AFTER the step (TUNNEL_GUARD_MIN_SPEED 6) — never looks.
test("K10 the hole-3 rough landing at another phase does not fall through either", async (t) => {
  const w = await createWorld(t, { surface: "green", size: 1, fps: 120 });
  await loadHole(w, 2);
  const ball = w.ball;
  const v = new B.Vector3(-3.65, -16.59, -33.57);
  const p = new B.Vector3(-41.2, 3.17, -74.99).subtract(v.scale(0.03));
  ball.teleport(p.x, p.y, p.z);
  w.run(3 / 120);
  ball.mesh.position.copyFrom(p);
  ball.teleport(p.x, p.y, p.z);
  ball._teleportRestoreFrames = 1;
  ball.body.setLinearVelocity(v);
  ball.landed = false;
  ball.touchedGround = false;
  let lowest = Infinity;
  for (let i = 0; i < 60; i++) {
    w.frame();
    const q = ball.getPosition();
    const sy = surfaceY(w, q.x, q.z);
    if (sy !== null) lowest = Math.min(lowest, q.y - sy);
  }
  assert.ok(
    lowest > -0.05,
    `ball centre went ${(-lowest).toFixed(2)} m below the terrain surface`,
  );
});

// Full shot the H way: aim 0 (−Z), swipes at sim times 0.5 + 0.1·k (30 FPS).
async function swipedShot(t, clubName, surface, swipes) {
  const FIELD = 1600;
  const w = await createWorld(t, { surface, size: FIELD, fps: 30 });
  const ball = w.ball;
  ball.teleport(0, R, FIELD / 2 - 20);
  w.run(1);
  ball.landed = false;
  ball.touchedGround = false;
  const club = CLUB[clubName];
  ball.applyHit(0, 0, 175, 0, club.angle, club.v0);
  let landT = null;
  let landZ = null;
  let maxBack = 0;
  let state = null;
  let i = 0;
  for (; i < 60 * w.fps && state !== "fullLand"; i++) {
    state = w.frame();
    const k = Math.round(((i + 1) / w.fps - 0.5) / 0.1);
    if (
      landT === null &&
      k >= 0 &&
      k < swipes.length &&
      Math.abs((i + 1) / w.fps - 0.5 - k * 0.1) < 1e-6
    ) {
      assert.ok(swipeSpin(w, makeFollowCamera(w, 0), ...swipes[k]), "no spin");
    }
    if (state === "firstContact" && landT === null) {
      landT = (i + 1) / w.fps;
      landZ = ball.getPosition().z;
    }
    if (landT !== null) maxBack = Math.max(maxBack, ball.getVelocity().z);
  }
  return {
    state,
    sinceLanding: landT === null ? null : (i + 1) / w.fps - landT,
    spinBack: landZ === null ? null : ball.getPosition().z - landZ,
    maxBack,
    omega: ball.getAngularVelocity().length(),
  };
}

// One firm sideways swipe leaves ~850 rad/s about the vertical at landing. The
// torsional decay (15π/32·μ·g·a/R² ≈ 63 rad/s² on a green) was sized for the old
// 100 rad/s swipes, so a lob wedge that stops dead sits pirouetting for ~14 s
// (5 side swipes: ~22 s) before rest, and the game waits in PLAY. H6 allows 10 s.
test("K11 a lob wedge with one firm sideways swipe onto a green rests within 10 s of landing", async (t) => {
  const r = await swipedShot(t, "Lob Wedge", "green", [[120, 0]]);
  assert.equal(r.state, "fullLand", `never rested ${fmt(r)}`);
  assert.ok(
    r.sinceLanding <= 10,
    `rested ${r.sinceLanding.toFixed(1)} s after landing ${fmt(r)}`,
  );
});

// Three firm backspin swipes (well under STRIKE_SPIN_MAX) land a lob wedge with
// ~1670 rad/s: it reverses on the first bounce at 7 m/s and rolls 32 m back — a
// reverse rocket. H6's sanity bound (≤ 4 m/s backwards) and H3's firm spin-back
// range (≤ 10 m) should hold for stacked swipes too, or the cap should.
test("K12 three stacked firm backspin swipes: lob wedge reverses ≤ 4 m/s and spins back ≤ 10 m", async (t) => {
  const r = await swipedShot(t, "Lob Wedge", "green", [
    [0, 120],
    [0, 120],
    [0, 120],
  ]);
  assert.ok(
    r.maxBack <= 4,
    `backwards at ${r.maxBack.toFixed(2)} m/s ${fmt(r)}`,
  );
  assert.ok(r.spinBack <= 10, `spun back ${r.spinBack.toFixed(2)} m ${fmt(r)}`);
});

// Real range green 5 (2.3° at the pitch): an 85%-power pitching wedge with ONE
// firm backspin swipe reverses at 4.4 m/s and spins back 17.7 m, off the green
// onto the fairway (no swipe: rolls 4.5 m forward and stays on). Flat-green H3/H6
// pass, but on the real contoured greens a single firm swipe usually leaves the
// green (range: 11/17 green landings end on the fairway; holes: 2–17 m back).
test("K13 range green: one firm backspin pitching wedge reverses ≤ 4 m/s and spins back ≤ 8 m", async (t) => {
  const { PRACTICE_RANGE } = require("../src/game/course.js");
  const w = await createWorld(t, { surface: "green", size: 1, fps: 30 });
  require("babylonjs-loaders");
  const glb = fs.readFileSync(
    path.join(__dirname, "..", "assets", PRACTICE_RANGE.glb),
  );
  const res = await B.SceneLoader.ImportMeshAsync(
    "",
    "",
    new Uint8Array(glb),
    w.scene,
    null,
    ".glb",
  );
  const root = res.meshes.find((m) => m.name === "__root__");
  root.computeWorldMatrix(true);
  const bb = root.getHierarchyBoundingVectors(true);
  root.position.x -= (bb.min.x + bb.max.x) / 2;
  root.position.z -= (bb.min.z + bb.max.z) / 2;
  root.computeWorldMatrix(true);
  for (const m of res.meshes.filter((m) => m.name.startsWith("surf_")))
    stamp(w, m);
  const [x, z, power, aim] = [
    4.004676151242795, 2.2863766491859323, 0.8539124727267364,
    -0.1423463732593308,
  ];
  const hit = w.scene.pickWithRay(
    new B.Ray(new B.Vector3(x, 300, z), new B.Vector3(0, -1, 0), 600),
    (m) => m.name.startsWith("surf_") && !m.name.includes("water"),
  );
  const n = hit.getNormal(true, false);
  const ball = w.ball;
  ball.teleport(
    x + n.x * (R + 0.002),
    hit.pickedPoint.y + n.y * (R + 0.002) + 0.0005,
    z + n.z * (R + 0.002),
  );
  ball.landed = false;
  ball.touchedGround = true;
  w.run(20 / 30);
  ball.landed = true;
  ball.touchedGround = false;
  const club = CLUB["Pitching Wedge"];
  ball.applyHit(0, 0, 175 * power, aim, club.angle, club.v0);
  const v0 = ball.getVelocity();
  const dir = new B.Vector3(v0.x, 0, v0.z).normalize();
  let contact = null;
  let maxBack = 0;
  let swiped = false;
  let state = null;
  for (let i = 0; i < 40 * 30 && state !== "fullLand"; i++) {
    state = w.frame();
    if (!swiped && Math.abs((i + 1) / 30 - 0.5) < 1e-6)
      swiped = !!swipeSpin(w, makeFollowCamera(w, aim), 0, 120);
    if (state === "firstContact" && !contact)
      contact = ball.getPosition().clone();
    if (contact) {
      const vv = ball.getVelocity();
      maxBack = Math.max(maxBack, -(vv.x * dir.x + vv.z * dir.z));
    }
  }
  assert.ok(swiped && contact, "no swipe or no landing");
  const p = ball.getPosition();
  const back = -((p.x - contact.x) * dir.x + (p.z - contact.z) * dir.z);
  assert.ok(
    maxBack <= 4 && back <= 8,
    `reversed at ${maxBack.toFixed(2)} m/s, spun back ${back.toFixed(2)} m`,
  );
});

// ─── Round 4 ───────────────────────────────────────────────────────────────────

// Regenerated hole 2 ("greens2"): the green's back edge and the rock-face backstop
// leave void slits up to ~0.4 m wide (also at (-9.5,-80.5), (-8.4,-82.8), (-2.0,-82.9);
// hole 3 has a 0.35 m one at (24.5,-219.8)). A ball reaching one — e.g. a full 6
// iron that runs through the green (2 of 24 approach shots in the sweep) — drops
// through the course to the out-of-bounds penalty.
test("K16 a ball coming to rest at hole 2's back edge (-3.40, -82.97) does not fall through the course", async (t) => {
  const w = await createWorld(t, { surface: "green", size: 1, fps: 60 });
  await loadHole(w, 1);
  const [x, z] = [-3.4, -82.97];
  let y = null;
  for (let r = 0.05; y === null && r < 1; r += 0.05)
    for (let a = 0; a < 8 && y === null; a++)
      y = surfaceY(w, x + Math.cos(a) * r, z + Math.sin(a) * r);
  assert.ok(y !== null, "no terrain near the probe point");
  w.ball.teleport(x, y + R + 0.01, z);
  w.ball.landed = false;
  w.ball.touchedGround = false;
  let lowest = Infinity;
  for (let i = 0; i < 120; i++) {
    w.frame();
    lowest = Math.min(lowest, w.ball.getPosition().y);
  }
  assert.ok(
    lowest > y - 0.5,
    `ball fell to y=${lowest.toFixed(2)} (surface ${y.toFixed(2)})`,
  );
});
