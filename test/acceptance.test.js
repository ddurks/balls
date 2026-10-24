// Behavioural acceptance tests for the arcade golf ball (product contract A–F).
// Thresholds come from the contract, not from tuning constants in src/.
// Run: node --test test/acceptance.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const {
  B,
  GolfBallGuy,
  ClubData,
  R,
  createWorld,
  makeFollowCamera,
  swipeSpin,
} = require("./helpers/havok-harness.js");
const { PhysicsConfig } = require("../src/game/physics.js");
const { Wind } = require("../src/game/wind.js");

const FWD = new B.Vector3(0, 0, -1); // applyHit with aimedDirection 0 travels -Z
const hspeed = (b) => Math.hypot(b.getVelocity().x, b.getVelocity().z);
const fmt = (o) =>
  JSON.stringify(o, (_, v) => (typeof v === "number" ? +v.toFixed(4) : v));

// ─── A. Resting on slopes ──────────────────────────────────────────────────────

// Hold check from a given start condition: returns drift over `seconds`, the
// final speed and the largest upward speed seen while supposedly at rest.
async function hold(t, surface, deg, { arrive = 0, seconds = 10 } = {}) {
  const w = await createWorld(t, { surface, slopeDeg: deg });
  if (arrive) {
    w.setRolling(arrive);
    for (let i = 0; i < 8 * w.fps && w.ball.getSpeed() >= 0.01; i++) w.frame();
  }
  const start = w.ball.getPosition().clone();
  let maxUp = 0;
  w.run(seconds, () => (maxUp = Math.max(maxUp, w.ball.getVelocity().y)));
  return {
    drift: B.Vector3.Distance(start, w.ball.getPosition()),
    speed: w.ball.getSpeed(),
    maxUp,
  };
}

function assertHeld(r, label) {
  assert.ok(r.drift < 0.02, `${label}: drifted ${fmt(r)}`);
  assert.ok(r.speed < 0.01, `${label}: still creeping ${fmt(r)}`);
  assert.ok(r.maxUp <= 0.05, `${label}: popped vertically ${fmt(r)}`);
}

async function rollsAway(t, surface, deg, seconds = 5) {
  const w = await createWorld(t, { surface, slopeDeg: deg });
  const start = w.ball.getPosition().clone();
  w.run(seconds);
  return B.Vector3.Distance(start, w.ball.getPosition());
}

test("A1 green: a ball placed at rest on a 4° slope stays put", async (t) => {
  assertHeld(await hold(t, "green", 4), "green 4° placed");
});

test("A2 green: a ball arriving at 0.3 m/s down a 4° slope stops and stays put", async (t) => {
  assertHeld(await hold(t, "green", 4, { arrive: 0.3 }), "green 4° arriving");
});

test("A3 green: a ball placed on a 6° slope rolls away", async (t) => {
  const d = await rollsAway(t, "green", 6);
  assert.ok(d > 0.5, `green 6° moved only ${d.toFixed(3)} m in 5 s`);
});

test("A4 fairway: holds at 6° (placed and arriving), rolls at 10°", async (t) => {
  assertHeld(await hold(t, "fairway", 6), "fairway 6° placed");
  assertHeld(
    await hold(t, "fairway", 6, { arrive: 0.3 }),
    "fairway 6° arriving",
  );
  const d = await rollsAway(t, "fairway", 10);
  assert.ok(d > 0.5, `fairway 10° moved only ${d.toFixed(3)} m in 5 s`);
});

test("A5 rough: holds at 10° (placed and arriving)", async (t) => {
  assertHeld(await hold(t, "rough", 10), "rough 10° placed");
  assertHeld(await hold(t, "rough", 10, { arrive: 0.3 }), "rough 10° arriving");
});

test("A6 sand: a ball rolling into flat sand at 3 m/s stops within 0.5 m", async (t) => {
  const w = await createWorld(t, { surface: "sand" });
  w.setRolling(3, FWD);
  const r = w.rollOut(10);
  assert.ok(r.distance < 0.5, `sand roll ${fmt(r)}`);
});

// ─── B. Rolling resistance ─────────────────────────────────────────────────────

async function stimp(t, fps = 60, onFrame = null) {
  const w = await createWorld(t, { surface: "green", fps });
  w.setRolling(1.83, FWD); // stimpmeter exit speed, already rolling without slip
  return { w, ...w.rollOut(30, onFrame && ((i) => onFrame(w, i))) };
}

test("B1 stimp: 1.83 m/s true roll on a flat green travels 1.9–3.0 m", async (t) => {
  const r = await stimp(t);
  assert.ok(
    r.distance >= 1.9 && r.distance <= 3.0,
    `stimp ${fmt({ d: r.distance, s: r.state })}`,
  );
});

// Constant-decel rolling resistance: no speed band where the ball runs free.
test("B2 flat-green deceleration at 4 m/s is within 30% of that at 1 m/s", async (t) => {
  async function decel(v0) {
    const w = await createWorld(t, { surface: "green" });
    w.setRolling(v0, FWD);
    w.run(0.1);
    const a = hspeed(w.ball);
    w.run(0.5);
    return (a - hspeed(w.ball)) / 0.5;
  }
  const fast = await decel(4);
  const slow = await decel(1);
  assert.ok(slow > 0.05, `no measurable resistance at 1 m/s (${slow})`);
  assert.ok(
    Math.abs(fast - slow) <= 0.3 * slow,
    `decel 4 m/s=${fast.toFixed(3)} vs 1 m/s=${slow.toFixed(3)} m/s²`,
  );
});

test("B3 same 3 m/s roll: green > fairway > rough > sand, each by ≥20%", async (t) => {
  const d = {};
  for (const s of ["green", "fairway", "rough", "sand"]) {
    const w = await createWorld(t, { surface: s });
    w.setRolling(3, FWD);
    d[s] = w.rollOut(30).distance;
  }
  assert.ok(d.green >= 1.2 * d.fairway, `green vs fairway ${fmt(d)}`);
  assert.ok(d.fairway >= 1.2 * d.rough, `fairway vs rough ${fmt(d)}`);
  assert.ok(d.rough >= 1.2 * d.sand, `rough vs sand ${fmt(d)}`);
});

test("B4 a 1 m/s roll down a 2° green eventually stops in the landed state", async (t) => {
  const w = await createWorld(t, { surface: "green", slopeDeg: 2 });
  w.setRolling(1);
  const r = w.rollOut(20);
  assert.equal(
    r.state,
    "fullLand",
    `did not stop ${fmt({ ...r, v: w.ball.getSpeed() })}`,
  );
});

test("B5 a 1 m/s roll down an 8° green keeps rolling", async (t) => {
  const w = await createWorld(t, { surface: "green", slopeDeg: 8 });
  w.setRolling(1);
  w.run(6);
  assert.ok(
    !w.ball.isLanded() && w.ball.getSpeed() > 0.5,
    `stopped on 8° (v=${w.ball.getSpeed()})`,
  );
});

// The last few centimetres of a roll must not be amputated by a speed snap.
test("B6 a roll ends in fullLand with speed decaying smoothly to zero", async (t) => {
  const speeds = [];
  const r = await stimp(t, 60, (w) => speeds.push(hspeed(w.ball)));
  assert.equal(r.state, "fullLand");
  for (let i = 1; i < speeds.length; i++) {
    assert.ok(
      !(speeds[i - 1] > 0.1 && speeds[i] < 0.01),
      `speed snapped ${speeds[i - 1].toFixed(3)} → ${speeds[i].toFixed(3)} m/s at frame ${i}`,
    );
  }
});

// ─── C. Frame-rate invariance ──────────────────────────────────────────────────

function assertInvariant(d, label) {
  const lo = Math.min(...Object.values(d));
  const hi = Math.max(...Object.values(d));
  assert.ok((hi - lo) / lo < 0.03, `${label} varies by FPS ${fmt(d)}`);
}

test("C1 stimp roll distance differs < 3% across 30/60/120 FPS", async (t) => {
  const d = {};
  for (const fps of [30, 60, 120]) d[fps] = (await stimp(t, fps)).distance;
  assertInvariant(d, "stimp");
});

test("C2 full-power putt distance differs < 3% across 30/60/120 FPS", async (t) => {
  const d = {};
  for (const fps of [30, 60, 120]) {
    const w = await createWorld(t, { surface: "green", size: 200, fps });
    w.run(0.5);
    const start = w.ball.getPosition().clone();
    const putter = ClubData.CLUBS[0];
    w.ball.applyHit(0, 0, 175, 0, putter.angle, putter.v0);
    w.rollOut(60);
    d[fps] = B.Vector3.Distance(start, w.ball.getPosition());
  }
  assertInvariant(d, "full putt");
});

// ─── D. Bounce ─────────────────────────────────────────────────────────────────

async function bounceHeight(t, surface) {
  const w = await createWorld(t, { surface, fps: 120 });
  w.ball.teleport(0, 2 + R, 0);
  w.ball.landed = false;
  w.ball.touchedGround = false;
  let rebounding = false;
  let apex = 0;
  w.run(3, () => {
    if (w.ball.getVelocity().y > 0.01) rebounding = true;
    if (rebounding) apex = Math.max(apex, w.ball.getPosition().y - R);
  });
  return apex;
}

test("D1 2 m drop rebound: green < fairway < rock; sand < 3 cm", async (t) => {
  const h = {};
  for (const s of ["green", "fairway", "rock", "sand"])
    h[s] = await bounceHeight(t, s);
  assert.ok(h.green < h.fairway, `green vs fairway ${fmt(h)}`);
  assert.ok(h.fairway < h.rock, `fairway vs rock ${fmt(h)}`);
  assert.ok(h.sand < 0.03, `sand bounced ${fmt(h)}`);
});

// ─── E. Spin / Magnus ──────────────────────────────────────────────────────────
// Physical rule: the swipe is the motion of the ball surface facing the camera,
// so ω ∝ swipeWorld × cameraForward (camera-facing point r = −f: ω × r = swipe),
// and Magnus F ∝ ω × v. Behind the ball: swipe right ⇒ curves left; down ⇒ backspin.

function cameraBasis(follow) {
  const c = follow.camera;
  c.computeWorldMatrix(true);
  return {
    right: c.getDirection(B.Axis.X).normalize(),
    up: c.getDirection(B.Axis.Y).normalize(),
    fwd: c.getDirection(B.Axis.Z).normalize(),
    pos: c.position.clone(),
  };
}

const swipeWorld = (cam, dx, dy) =>
  cam.right.scale(dx).add(cam.up.scale(-dy)).normalize();

// 7-iron at half power, aim 0 (travel −Z). Optional swipe once well airborne with
// the camera at `relYaw` around the ball relative to travel. Carry/lateral are
// taken at first contact (same detector as G): a landing ball touches down a few
// µm above its resting height, so "centre back at start.y" can fire well into the roll.
async function flight(t, { swipe = null, relYaw = 0 } = {}) {
  const w = await createWorld(t, { surface: "fairway", size: 600 });
  w.run(0.5);
  const club = ClubData.CLUBS[5];
  const start = w.ball.getPosition().clone();
  w.ball.applyHit(0, 0, 175 * 0.5, 0, club.angle, club.v0);
  const contact = firstContact(w);
  let info = null;
  let apex = 0;
  for (let i = 0; i < 20 * w.fps && !contact.at; i++) {
    w.frame();
    if (
      swipe &&
      !info &&
      w.ball.getHeight() > 4 &&
      w.ball.getVelocity().y > 0
    ) {
      const follow = makeFollowCamera(w, relYaw);
      const cam = cameraBasis(follow);
      const v = w.ball.getVelocity();
      const emitted = swipeSpin(w, follow, swipe[0], swipe[1]);
      const omegaExp = B.Vector3.Cross(
        swipeWorld(cam, swipe[0], swipe[1]),
        cam.fwd,
      );
      info = {
        emitted,
        cam,
        v,
        expectedForce: B.Vector3.Cross(omegaExp, v),
        magnusDir:
          typeof w.ball.getMagnusDirection === "function"
            ? w.ball.getMagnusDirection()
            : null,
      };
    }
    apex = Math.max(apex, w.ball.getPosition().y - start.y);
  }
  contact.dispose();
  if (!contact.at) throw new Error("flight never landed");
  return {
    info,
    apex,
    lateral: contact.at.x - start.x,
    carry: -(contact.at.z - start.z),
  };
}

// First physics step, after the ball has risen > 0.5 m, where Havok reports a
// collision or the ball is within 5 mm of touching the ground.
function firstContact(w) {
  const ball = w.ball;
  const c = { at: null };
  let risen = false;
  let hit = false;
  const onHit = ball.body.getCollisionObservable().add(() => (hit = true));
  const onStep = w.scene.onAfterPhysicsObservable.add(() => {
    const p = ball.getPosition();
    const h = p.y - w.groundY(p.x, p.z);
    if (h > 0.5) risen = true;
    else if (risen && !c.at && (hit || h <= R + 0.005)) c.at = p.clone();
    hit = false;
  });
  c.dispose = () => {
    ball.body.getCollisionObservable().remove(onHit);
    w.scene.onAfterPhysicsObservable.remove(onStep);
  };
  return c;
}

const lateralAxis = new B.Vector3(1, 0, 0); // horizontal ⟂ travel (−Z)

test("E1 behind the ball: swipe RIGHT curves screen-left, swipe LEFT curves screen-right", async (t) => {
  const base = await flight(t);
  for (const [dx, want] of [
    [120, -1],
    [-120, 1],
  ]) {
    const s = await flight(t, { swipe: [dx, 0] });
    assert.ok(s.info.emitted, "swipe produced no input:spin");
    const dev = new B.Vector3(s.lateral - base.lateral, 0, 0);
    const towardRight = B.Vector3.Dot(dev, s.info.cam.right);
    assert.ok(
      Math.sign(towardRight) === want && Math.abs(towardRight) > 0.5,
      `swipe dx=${dx}: deviation along camera-right ${towardRight.toFixed(2)} m (want sign ${want})`,
    );
  }
});

test("E2 behind the ball: swipe DOWN (backspin) flies higher/longer, UP (topspin) lower/shorter", async (t) => {
  const base = await flight(t);
  const back = await flight(t, { swipe: [0, 120] });
  const top = await flight(t, { swipe: [0, -120] });
  const r = {
    base: [base.apex, base.carry],
    back: [back.apex, back.carry],
    top: [top.apex, top.carry],
  };
  assert.ok(
    back.apex > base.apex + 0.2 && back.carry > base.carry + 0.5,
    `backspin ${fmt(r)}`,
  );
  assert.ok(
    top.apex < base.apex - 0.2 && top.carry < base.carry - 0.5,
    `topspin ${fmt(r)}`,
  );
  assert.ok(back.apex > top.apex, `backspin apex not above topspin ${fmt(r)}`);
});

test("E3 rotated camera (90°, 180°): curve matches ω ∝ swipe × camForward, F ∝ ω × v", async (t) => {
  const base = await flight(t);
  const cases = [
    { relYaw: Math.PI / 2, swipe: [120, 0] },
    { relYaw: Math.PI / 2, swipe: [-120, 0] },
    { relYaw: Math.PI, swipe: [120, 0] },
    { relYaw: Math.PI, swipe: [0, 120] }, // brushing the FRONT face down = topspin
  ];
  for (const c of cases) {
    const s = await flight(t, c);
    const F = s.info.expectedForce;
    const label = `yaw ${((c.relYaw * 180) / Math.PI).toFixed(0)}° swipe ${c.swipe}`;
    if (Math.abs(F.y) > Math.abs(F.x)) {
      assert.ok(
        Math.sign(s.apex - base.apex) === Math.sign(F.y) &&
          Math.abs(s.apex - base.apex) > 0.2,
        `${label}: apex ${base.apex.toFixed(2)} → ${s.apex.toFixed(2)}, expected sign ${Math.sign(F.y)}`,
      );
    } else {
      const dev = s.lateral - base.lateral;
      const want = Math.sign(B.Vector3.Dot(F, lateralAxis));
      assert.ok(
        Math.sign(dev) === want && Math.abs(dev) > 0.5,
        `${label}: lateral deviation ${dev.toFixed(2)} m, expected sign ${want}`,
      );
    }
  }
});

// Guards against left-handed-coordinate sign errors: integrate the game's spin
// in Havok and watch the camera-facing surface point move.
test("E4 Havok rotation moves the camera-facing surface point in the swipe direction", async (t) => {
  for (const [dx, dy] of [
    [120, 0],
    [-120, 0],
    [0, 120],
    [0, -120],
  ]) {
    const w = await createWorld(t, { fps: 120 });
    w.ball.teleport(0, 20, 0);
    w.run(3 / 120);
    w.ball.landed = false;
    w.ball.body.setLinearVelocity(FWD.scale(30));
    const follow = makeFollowCamera(w, 0);
    const cam = cameraBasis(follow);
    assert.ok(swipeSpin(w, follow, dx, dy), "swipe produced no input:spin");
    // Same axis, slowed so one 1/120 s step is an unambiguous small rotation.
    const omega = w.ball.getAngularVelocity();
    assert.ok(omega.length() > 1, `no spin applied for swipe ${dx},${dy}`);
    w.ball.body.setAngularVelocity(omega.normalize().scale(6));
    const m = w.ball.mesh;
    m.computeWorldMatrix(true);
    const c0 = m.getAbsolutePosition().clone();
    const p0 = c0.add(cam.pos.subtract(c0).normalize().scale(R));
    const local = B.Vector3.TransformCoordinates(
      p0,
      m.getWorldMatrix().clone().invert(),
    );
    w.scene._advancePhysicsEngineStep(1000 / 120);
    m.computeWorldMatrix(true);
    const p1 = B.Vector3.TransformCoordinates(local, m.getWorldMatrix());
    const disp = p1.subtract(p0).subtract(m.getAbsolutePosition().subtract(c0));
    const cos = B.Vector3.Dot(disp.normalize(), swipeWorld(cam, dx, dy));
    assert.ok(
      cos > 0.8,
      `swipe ${dx},${dy}: camera-facing point moved at cos ${cos.toFixed(2)} to the swipe`,
    );
  }
});

test("E5 getMagnusDirection(): swipe right behind the ball points camera-left and matches the curve", async (t) => {
  assert.equal(
    typeof GolfBallGuy.prototype.getMagnusDirection,
    "function",
    "GolfBallGuy.prototype.getMagnusDirection() missing",
  );
  const base = await flight(t);
  const s = await flight(t, { swipe: [120, 0] });
  const d = s.info.magnusDir;
  assert.ok(d && Math.abs(d.length() - 1) < 1e-3, `not normalized: ${fmt(d)}`);
  const expected = s.info.expectedForce.normalize();
  assert.ok(
    B.Vector3.Dot(d, expected) > 0.9,
    `magnus ${fmt(d)} vs ω×v ${fmt(expected)}`,
  );
  assert.ok(
    B.Vector3.Dot(d, s.info.cam.right) < 0,
    `arrow points camera-right ${fmt(d)}`,
  );
  assert.equal(
    Math.sign(d.x),
    Math.sign(s.lateral - base.lateral),
    "arrow disagrees with actual curve",
  );
});

// ─── F. Regression guards ──────────────────────────────────────────────────────

async function settledOnSlope(t, deg = 3) {
  const w = await createWorld(t, { surface: "green", slopeDeg: deg });
  w.setRolling(0.5);
  const r = w.rollOut(20);
  assert.equal(r.state, "fullLand", "roll on the slope never settled");
  return w;
}

test("F1 a ball that rolled to rest on a 3° green stays at its lie while aiming", async (t) => {
  const w = await settledOnSlope(t);
  const lie = w.ball.getPosition().clone();
  w.run(10);
  assert.ok(B.Vector3.Distance(lie, w.ball.getPosition()) < 1e-3);
  assert.ok(w.ball.isLanded());
});

test("F2 the next putt from a sloped lie launches at the requested speed", async (t) => {
  const w = await settledOnSlope(t);
  const start = w.ball.getPosition().clone();
  w.ball.applyHit(0, 0, 87.5, Math.PI / 2, 0, 17); // across the slope
  assert.equal(w.ball.isLanded(), false);
  assert.ok(
    Math.abs(hspeed(w.ball) - 8.5) < 0.1,
    `launch ${fmt(w.ball.getVelocity())}`,
  );
  w.frame();
  assert.ok(B.Vector3.Distance(start, w.ball.getPosition()) > 0.04);
});

test("F3 a settled ball teleported into a cup falls under gravity and is never parked", async (t) => {
  const w = await settledOnSlope(t);
  const p = w.ball.getPosition();
  w.ball._inCup = true;
  w.ball.teleport(p.x, p.y + 0.3, p.z);
  const top = p.y;
  w.run(1);
  assert.ok(
    w.ball.getPosition().y < top + 0.05,
    `did not fall (y=${w.ball.getPosition().y})`,
  );
  assert.equal(w.ball.body.getMotionType(), B.PhysicsMotionType.DYNAMIC);
});

// ─── G. Full-shot roll-out after landing ───────────────────────────────────────
// Real turf eats much of a landing ball's horizontal speed (pitch mark, Coulomb
// friction during the bounce), so full shots release a realistic distance.

const CLUB = Object.fromEntries(ClubData.CLUBS.map((c) => [c.name, c]));
const FIELD = 1600; // big enough to measure even a runaway roll

// Full-power, spin-free (unless swiped), windless strike the way the game does it:
// settle the lie, then applyHit with the club's loft and launch speed (aim 0 → −Z).
// Roll-out = horizontal rest distance − horizontal first-contact distance.
// `swipe`: one swipe at the first frame > 4 m up and rising (G). `swipes`: a list
// fired at fixed sim times SWIPE_T0 + k·SWIPE_DT (H) — multiples of 1/30 s, so the
// swipe instant is identical at 30/60/120 FPS and FPS comparisons stay fair.
const SWIPE_T0 = 0.5;
const SWIPE_DT = 0.1;
// H8 extras: `power` (0–1), `t0` (first swipe time, s), `wind` ({ direction,
// speed } for the real Wind class), `slopeDeg` (+ = green descends toward the golfer).
async function fullShot(
  t,
  clubName,
  {
    surface = "fairway",
    fps = 30,
    swipe = null,
    swipes = [],
    power = 1,
    t0 = SWIPE_T0,
    wind = null,
    slopeDeg = 0,
  } = {},
) {
  const w = await createWorld(t, { surface, size: FIELD, fps, slopeDeg });
  const ball = w.ball;
  if (wind) ball.wind = Object.assign(new Wind(), wind);
  ball.teleport(0, w.groundY(0, FIELD / 2 - 20) + R / w.n.y, FIELD / 2 - 20);
  w.run(1);
  const club = CLUB[clubName];
  const tee = ball.getPosition().clone();
  ball.landed = false;
  ball.touchedGround = false;
  ball.applyHit(0, 0, 175 * power, 0, club.angle, club.v0);
  const hdist = (p) => Math.hypot(p.x - tee.x, p.z - tee.z);
  const along = (p) => -(p.z - tee.z); // toward the target
  const touch = firstContact(w);
  const tr = trackGround(w, touch);
  let swiped = !swipe;
  let state = null;
  let apex = 0;
  let camRight = null;
  for (let i = 0; i < 40 * fps && state !== "fullLand"; i++) {
    state = w.frame();
    apex = Math.max(apex, ball.getPosition().y - tee.y);
    if (!swiped && ball.getHeight() > 4 && ball.getVelocity().y > 0) {
      swiped = !!swipeSpin(w, makeFollowCamera(w, 0), swipe[0], swipe[1]);
      assert.ok(swiped, "swipe produced no input:spin");
    }
    const k = Math.round(((i + 1) / fps - t0) / SWIPE_DT);
    if (
      k >= 0 &&
      k < swipes.length &&
      Math.abs((i + 1) / fps - t0 - k * SWIPE_DT) < 1e-6
    ) {
      assert.ok(ball.getHeight() > 4, `swipe ${k} not airborne`);
      if (k === 0)
        assert.ok(ball.getVelocity().y > 0, "first swipe after apex");
      const follow = makeFollowCamera(w, 0);
      camRight = camRight || follow.camera.getDirection(B.Axis.X).normalize();
      assert.ok(
        swipeSpin(w, follow, swipes[k][0], swipes[k][1]),
        "swipe produced no input:spin",
      );
    }
  }
  touch.dispose();
  tr.dispose();
  const contact = touch.at;
  assert.ok(contact, `${clubName} never touched down`);
  const rest = ball.getPosition().clone();
  const carry = hdist(contact);
  const total = hdist(rest);
  return {
    club: clubName,
    surface,
    fps,
    carry,
    total,
    roll: total - carry,
    settled: state === "fullLand",
    apex,
    carryAlong: along(contact),
    lateral: contact.x - tee.x,
    restLateral: rest.x - tee.x,
    rollAlong: along(rest) - along(contact), // negative = spun back toward the golfer
    maxBackSpeed: tr.maxBack,
    hop: tr.hop,
    groundCurve: tr.curve(rest),
    restTime: state === "fullLand" ? tr.time : Infinity,
    camRight,
  };
}

// Per-physics-step ground behaviour after first contact. The roll phase starts
// once the ball has stayed within 5 mm of the turf for 0.25 s (bounces done).
function trackGround(w, touch) {
  const ball = w.ball;
  const g = { maxBack: 0, hop: 0, time: 0, rollStart: null, rollDir: null };
  let low = 0;
  const obs = w.scene.onAfterPhysicsObservable.add(() => {
    if (!touch.at) return;
    g.time += PhysicsConfig.STEP_SECONDS;
    const p = ball.getPosition();
    const v = ball.getVelocity();
    g.maxBack = Math.max(g.maxBack, v.z); // travel is −Z, so +z is backwards
    const h = p.y - w.groundY(p.x, p.z) - R;
    if (g.rollStart) g.hop = Math.max(g.hop, h);
    else if (h <= 0.005) {
      if (++low * PhysicsConfig.STEP_SECONDS >= 0.25) {
        g.rollStart = p.clone();
        g.rollDir = new B.Vector3(v.x, 0, v.z);
      }
    } else low = 0;
  });
  g.dispose = () => w.scene.onAfterPhysicsObservable.remove(obs);
  // Perpendicular distance of the rest point from the line the roll started on.
  g.curve = (rest) => {
    if (!g.rollStart || g.rollDir.length() < 1e-3) return 0;
    const d = g.rollDir.normalizeToNew();
    const r = rest.subtract(g.rollStart);
    return Math.abs(r.x * d.z - r.z * d.x);
  };
  return g;
}

function assertRoll(r, lo, hi) {
  assert.ok(r.settled, `did not come to rest in 40 s ${fmt(r)}`);
  assert.ok(
    r.roll >= lo && r.roll <= hi,
    `roll-out outside ${lo}–${hi} m ${fmt(r)}`,
  );
}

test("G1 fairway, no spin: driver rolls 15–45 m, 7 iron 3–12 m, pitching wedge 0.5–6 m", async (t) => {
  assertRoll(await fullShot(t, "Driver"), 15, 45);
  assertRoll(await fullShot(t, "7 Iron"), 3, 12);
  assertRoll(await fullShot(t, "Pitching Wedge"), 0.5, 6);
});

test("G2 green landing, no spin: 7 iron rolls 2–10 m, lob wedge 0–4 m", async (t) => {
  assertRoll(await fullShot(t, "7 Iron", { surface: "green" }), 2, 10);
  assertRoll(await fullShot(t, "Lob Wedge", { surface: "green" }), 0, 4);
});

test("G3 driver roll-out: rough < 50% of fairway; sand < 3 m", async (t) => {
  const fairway = await fullShot(t, "Driver");
  const rough = await fullShot(t, "Driver", { surface: "rough" });
  const sand = await fullShot(t, "Driver", { surface: "sand" });
  assert.ok(
    rough.settled && sand.settled,
    `did not settle ${fmt({ rough, sand })}`,
  );
  assert.ok(
    rough.roll < 0.5 * fairway.roll,
    `rough ${fmt(rough)} vs fairway ${fmt(fairway)}`,
  );
  assert.ok(sand.roll < 3, `sand ${fmt(sand)}`);
});

test("G4 carry (first contact) within 5% of the club's distance: driver, 7 iron", async (t) => {
  for (const name of ["Driver", "7 Iron"]) {
    const r = await fullShot(t, name);
    const target = CLUB[name].maxDistance;
    assert.ok(
      Math.abs(r.carry - target) <= 0.05 * target,
      `${name} carry vs ${target} m ${fmt(r)}`,
    );
  }
});

test("G5 pitching wedge onto a green: backspin swipe bites, topspin releases", async (t) => {
  const base = await fullShot(t, "Pitching Wedge", { surface: "green" });
  const back = await fullShot(t, "Pitching Wedge", {
    surface: "green",
    swipe: [0, 120],
  });
  const top = await fullShot(t, "Pitching Wedge", {
    surface: "green",
    swipe: [0, -120],
  });
  const r = { base: base.roll, back: back.roll, top: top.roll };
  assert.ok(
    base.settled && back.settled && top.settled,
    `did not settle ${fmt({ base, back, top })}`,
  );
  assert.ok(back.roll < base.roll - 0.25, `backspin roll-out ${fmt(r)}`);
  assert.ok(top.roll > base.roll + 0.25, `topspin roll-out ${fmt(r)}`);
});

test("G6 driver total distance differs < 3% across 30/60/120 FPS", async (t) => {
  const d = {};
  for (const fps of [30, 60, 120])
    d[fps] = (await fullShot(t, "Driver", { fps })).total;
  assertInvariant(d, "driver total");
});

// ─── H. Arcade swipe control ───────────────────────────────────────────────────
// Firm swipe = 120 px, mild = 40 px (screen, +y down), camera behind, no wind.
// Landing point = first contact; spin-back = how far the rest point is BEHIND it.

const FIRM_R = [120, 0];
const FIRM_L = [-120, 0];
const FIRM_BACK = [0, 120];
const FIRM_TOP = [0, -120];
const MILD_BACK = [0, 40];
const spinBack = (r) => -r.rollAlong;
const curve = (r, base) => r.lateral - base.lateral;

test("H1 one firm sideways swipe curves a full 7 iron 20–30 m, the true way; a driver curves more", async (t) => {
  const base = await fullShot(t, "7 Iron");
  const s = await fullShot(t, "7 Iron", { swipes: [FIRM_R] });
  const dev = curve(s, base);
  assert.ok(
    Math.sign(dev * s.camRight.x) === -1,
    `swipe right did not curve camera-left ${fmt({ dev, camRight: s.camRight })}`,
  );
  assert.ok(
    Math.abs(dev) >= 20 && Math.abs(dev) <= 30,
    `7 iron curve ${dev.toFixed(2)} m, want 20–30`,
  );
  const dBase = await fullShot(t, "Driver");
  const d = await fullShot(t, "Driver", { swipes: [FIRM_R] });
  assert.ok(
    Math.abs(curve(d, dBase)) > Math.abs(dev),
    `driver ${curve(d, dBase).toFixed(2)} m vs 7 iron ${dev.toFixed(2)} m`,
  );
});

test("H2 sideways swipes stack (2× ≥ 1.4 of one), cap (5× ≤ 2.2 of one) and cancel", async (t) => {
  const base = await fullShot(t, "7 Iron");
  const c = {};
  for (const [k, sw] of [
    ["one", [FIRM_R]],
    ["two", [FIRM_R, FIRM_R]],
    ["five", Array(5).fill(FIRM_R)],
    ["rl", [FIRM_R, FIRM_L]],
  ]) {
    c[k] = Math.abs(curve(await fullShot(t, "7 Iron", { swipes: sw }), base));
  }
  assert.ok(c.two >= 1.4 * c.one, `no stacking ${fmt(c)}`);
  assert.ok(c.five <= 2.2 * c.one, `no cap ${fmt(c)}`);
  assert.ok(c.rl < 0.3 * c.one, `right+left did not cancel ${fmt(c)}`);
});

// Spin-back targets per club: the lob wedge lands steepest and bites hardest;
// the pitching wedge (45°) lands flatter (coordinator decision).
const H3_WEDGES = {
  "Lob Wedge": { firm: [5, 10], mild: 1.5 },
  "Pitching Wedge": { firm: [1, 8], mild: 2.5 },
};

test("H3 firm backspin onto a green: wedges spin back, mild stops near the pitch, 5 iron checks", async (t) => {
  const m = {};
  for (const club of Object.keys(H3_WEDGES)) {
    m[club] = {
      firmBack: spinBack(
        await fullShot(t, club, { surface: "green", swipes: [FIRM_BACK] }),
      ),
      mildRest: (
        await fullShot(t, club, { surface: "green", swipes: [MILD_BACK] })
      ).rollAlong,
    };
  }
  m.iron5 = {
    noSpin: (await fullShot(t, "5 Iron", { surface: "green" })).rollAlong,
    firm: (
      await fullShot(t, "5 Iron", { surface: "green", swipes: [FIRM_BACK] })
    ).rollAlong,
  };
  const all = fmt(m);
  const fails = [];
  for (const [club, want] of Object.entries(H3_WEDGES)) {
    const { firmBack, mildRest } = m[club];
    if (!(firmBack >= want.firm[0] && firmBack <= want.firm[1]))
      fails.push(
        `${club} firm spin-back ${firmBack.toFixed(2)} m, want ${want.firm.join("–")}`,
      );
    if (!(Math.abs(mildRest) <= want.mild))
      fails.push(
        `${club} mild rest ${mildRest.toFixed(2)} m from pitch, want ±${want.mild}`,
      );
  }
  if (!(m.iron5.firm <= 0.4 * m.iron5.noSpin))
    fails.push("5 iron did not check (firm roll-out > 40% of no-spin)");
  if (!(m.iron5.firm >= -2)) fails.push("5 iron spun back > 2 m");
  assert.deepEqual(fails, [], `H3 ${all}`);
});

test("H4 lob-wedge spin-back: fairway ≤ 70% of green; rough and sand ≤ 1 m", async (t) => {
  const b = {};
  for (const s of ["green", "fairway", "rough", "sand"]) {
    b[s] = spinBack(
      await fullShot(t, "Lob Wedge", { surface: s, swipes: [FIRM_BACK] }),
    );
  }
  const fails = [];
  if (!(b.green > 1)) fails.push("precondition: no spin-back on green");
  if (!(b.fairway <= 0.7 * b.green))
    fails.push("fairway spin-back > 70% of green");
  if (!(b.rough <= 1)) fails.push("rough spin-back > 1 m");
  if (!(b.sand <= 1)) fails.push("sand spin-back > 1 m");
  assert.deepEqual(fails, [], `H4 ${fmt(b)}`);
});

// Pre-H baseline (7 iron, full, fairway, 30 FPS, measured 2026-10-24): change vs
// a no-swipe shot. Arcade ground spin must not come from stronger in-air Magnus.
const H5_TODAY = {
  back: { carry: 2.02, apex: 3.06 },
  top: { carry: -3.05, apex: -2.64 },
};

test("H5 vertical swipes shape flight no more than before; sideways swipe keeps carry", async (t) => {
  const base = await fullShot(t, "7 Iron");
  const d = {};
  for (const [k, sw] of [
    ["back", FIRM_BACK],
    ["top", FIRM_TOP],
  ]) {
    const s = await fullShot(t, "7 Iron", { swipes: [sw] });
    d[k] = { carry: s.carryAlong - base.carryAlong, apex: s.apex - base.apex };
  }
  for (const k of ["back", "top"]) {
    for (const m of ["carry", "apex"]) {
      const today = H5_TODAY[k][m];
      assert.ok(
        Math.abs(d[k][m] - today) <= 0.3 * Math.abs(today),
        `${k} ${m} Δ ${d[k][m].toFixed(2)} vs pre-H ${today} ±30%`,
      );
    }
  }
  assert.ok(
    d.back.carry > 0 && d.back.apex > 0 && d.top.carry < 0 && d.top.apex < 0,
    `E2 ordering lost ${fmt(d)}`,
  );
  const side = await fullShot(t, "7 Iron", { swipes: [FIRM_R] });
  const dc = Math.abs(side.carryAlong - base.carryAlong) / base.carryAlong;
  assert.ok(
    dc <= 0.05,
    `sideways swipe changed carry by ${(dc * 100).toFixed(1)}%`,
  );
});

test("H6 spun-back balls stay sane; sidespin does not curve a rolling ball", async (t) => {
  for (const club of ["Lob Wedge", "Pitching Wedge", "5 Iron"]) {
    const r = await fullShot(t, club, {
      surface: "green",
      swipes: [FIRM_BACK],
    });
    const o = { club, back: r.maxBackSpeed, hop: r.hop, rest: r.restTime };
    assert.ok(r.maxBackSpeed <= 4, `backwards too fast ${fmt(o)}`);
    assert.ok(r.hop <= 0.05, `hopped after landing ${fmt(o)}`);
    assert.ok(r.restTime <= 10, `not at rest within 10 s ${fmt(o)}`);
  }
  for (const club of ["7 Iron", "Driver"]) {
    const r = await fullShot(t, club, { swipes: [FIRM_R] });
    assert.ok(
      r.groundCurve <= 1,
      `${club} curved ${r.groundCurve.toFixed(2)} m while rolling`,
    );
  }
});

test("H7 sidespin curve and wedge spin-back differ < 5% across 30/60/120 FPS", async (t) => {
  const dev = {};
  const back = {};
  for (const fps of [30, 60, 120]) {
    dev[fps] = curve(
      await fullShot(t, "7 Iron", { fps, swipes: [FIRM_R] }),
      await fullShot(t, "7 Iron", { fps }),
    );
    back[fps] = spinBack(
      await fullShot(t, "Lob Wedge", {
        fps,
        surface: "green",
        swipes: [FIRM_BACK],
      }),
    );
  }
  for (const [label, d] of [
    ["curve", dev],
    ["spin-back", back],
  ]) {
    const v = Object.values(d);
    const spread = Math.max(...v) - Math.min(...v);
    assert.ok(
      spread <= 0.05 * Math.max(...v.map(Math.abs)),
      `${label} varies by FPS ${fmt(d)}`,
    );
  }
});

// ─── H8. Spin control is robust (not fitted to one setup) ──────────────────────
// Each test measures everything first, then reports every violation at once.

function assertNone(t, fails, data) {
  t.diagnostic(fmt(data)); // numbers visible even when passing
  assert.deepEqual(fails, [], fmt(data));
}
const LW = "Lob Wedge";
const PW = "Pitching Wedge";
const onGreen = (o = {}) => ({ surface: "green", swipes: [FIRM_BACK], ...o });
const within = (v, lo, hi) => v >= lo && v <= hi;

test("H8a backspin spin-back holds across swipe timing and strike power", async (t) => {
  const want = { [LW]: [3, 12], [PW]: [-0.5, 8] };
  const m = {};
  const fails = [];
  for (const club of [LW, PW]) {
    for (const t0 of [0.3, 0.6, 1.0]) {
      for (const power of [0.8, 0.9, 1]) {
        const key = `${club} t0=${t0} p=${power}`;
        m[key] = spinBack(await fullShot(t, club, onGreen({ t0, power })));
        if (!within(m[key], ...want[club]))
          fails.push(
            `${key}: ${m[key].toFixed(2)} m, want ${want[club].join("…")}`,
          );
      }
    }
  }
  assertNone(t, fails, m);
});

// Wind class convention: direction 0 blows toward +Z, i.e. into a shot aimed −Z.
test("H8b lob-wedge spin-back survives a 3 m/s head- and tailwind", async (t) => {
  const m = {};
  const fails = [];
  for (const [label, direction] of [
    ["head", 0],
    ["tail", Math.PI],
  ]) {
    const r = await fullShot(t, LW, onGreen({ wind: { direction, speed: 3 } }));
    m[label] = {
      spinBack: spinBack(r),
      back: r.maxBackSpeed,
      rest: r.restTime,
    };
    if (!within(spinBack(r), 2, 12))
      fails.push(
        `${label}wind spin-back ${spinBack(r).toFixed(2)} m, want 2–12`,
      );
    if (r.maxBackSpeed > 4)
      fails.push(`${label}wind reverse ${r.maxBackSpeed.toFixed(2)} m/s > 4`);
    if (!(r.restTime <= 10)) fails.push(`${label}wind not at rest within 10 s`);
  }
  assertNone(t, fails, m);
});

test("H8c stacked backspin swipes saturate on the ground", async (t) => {
  const m = {};
  const fails = [];
  for (const club of [LW, PW]) {
    for (const n of [1, 2, 3, 5]) {
      const r = await fullShot(
        t,
        club,
        onGreen({ swipes: Array(n).fill(FIRM_BACK) }),
      );
      const key = `${club} ×${n}`;
      m[key] = { spinBack: spinBack(r), back: r.maxBackSpeed };
      if (r.maxBackSpeed > 4)
        fails.push(`${key}: reverse ${r.maxBackSpeed.toFixed(2)} m/s > 4`);
      if (spinBack(r) > 14)
        fails.push(`${key}: spin-back ${spinBack(r).toFixed(2)} m > 14`);
    }
  }
  const one = m[`${LW} ×1`].spinBack;
  const five = m[`${LW} ×5`].spinBack;
  if (!(five <= 1.5 * one))
    fails.push(
      `${LW}: 5 swipes ${five.toFixed(2)} m > 1.5× one swipe ${one.toFixed(2)} m`,
    );
  assertNone(t, fails, m);
});

test("H8d lob-wedge spin-back on 2° greens: no runaway downhill, still bites uphill", async (t) => {
  const down = await fullShot(t, LW, onGreen({ slopeDeg: 2 })); // spins back DOWN the slope
  const up = await fullShot(t, LW, onGreen({ slopeDeg: -2 })); // spins back UP the slope
  const m = {
    downhillBack: {
      spinBack: spinBack(down),
      back: down.maxBackSpeed,
      rest: down.restTime,
    },
    uphillBack: {
      spinBack: spinBack(up),
      back: up.maxBackSpeed,
      rest: up.restTime,
    },
  };
  const fails = [];
  if (down.maxBackSpeed > 4)
    fails.push(`downhill-back reverse ${down.maxBackSpeed.toFixed(2)} m/s > 4`);
  if (spinBack(down) > 16)
    fails.push(`downhill-back spin-back ${spinBack(down).toFixed(2)} m > 16`);
  if (!(spinBack(up) >= 2))
    fails.push(`uphill-back spin-back ${spinBack(up).toFixed(2)} m < 2`);
  assertNone(t, fails, m);
});

// Measures pirouetting, not roll-out length: a fast driver roll on a green takes
// > 6 s even without spin, so every case is compared to the same shot unswiped;
// the absolute 6 s limit applies to the shorter-rolling lob wedge and 7 iron.
test("H8e sidespun balls come to rest no later than the same shot without spin", async (t) => {
  const m = {};
  const fails = [];
  for (const club of [LW, "7 Iron", "Driver"]) {
    for (const surface of ["green", "fairway"]) {
      const plain = (await fullShot(t, club, { surface })).restTime;
      m[`${club} ${surface} ×0`] = plain;
      for (const n of [1, 5]) {
        const r = await fullShot(t, club, {
          surface,
          swipes: Array(n).fill(FIRM_R),
        });
        const key = `${club} ${surface} ×${n}`;
        m[key] = r.restTime;
        if (!(r.restTime <= plain + 1.5))
          fails.push(
            `${key}: rest ${r.restTime.toFixed(2)} s vs ${plain.toFixed(2)} s unspun (+1.5 allowed)`,
          );
        if (club !== "Driver" && !(r.restTime <= 6))
          fails.push(
            `${key}: rest ${r.restTime.toFixed(2)} s after landing > 6`,
          );
      }
    }
  }
  assertNone(t, fails, m);
});

// ─── H9. Topspin is capped on landing like backspin ────────────────────────────
// Run-out = signed roll along the target line after first contact; gain = topspin
// run-out − the same shot's no-swipe run-out.

test("H9 firm topspin adds roll-out, but bounded, saturating and surface-sensitive", async (t) => {
  const runOut = async (club, surface, n = 0) =>
    (await fullShot(t, club, { surface, swipes: Array(n).fill(FIRM_TOP) }))
      .rollAlong;
  const m = {};
  const gain = {};
  const cases = [
    [PW, "green"],
    [PW, "fairway"],
    ["7 Iron", "green"],
    ["7 Iron", "fairway"],
    ["7 Iron", "rough"],
    ["7 Iron", "sand"],
    ["Driver", "fairway"],
  ];
  for (const [club, surface] of cases) {
    const key = `${club} ${surface}`;
    const plain = await runOut(club, surface);
    const one = await runOut(club, surface, 1);
    m[key] = { noSpin: plain, top1: one };
    gain[key] = one - plain;
  }
  for (const key of [`${PW} green`, "7 Iron fairway"]) {
    const [club, surface] = key.split(/ (?=\S+$)/);
    m[key].top5 = await runOut(club, surface, 5);
    m[key].gain5 = m[key].top5 - m[key].noSpin;
  }
  const fails = [];
  for (const key of [
    `${PW} green`,
    `${PW} fairway`,
    "7 Iron green",
    "7 Iron fairway",
  ]) {
    if (!(gain[key] > 1))
      fails.push(`H9a ${key}: topspin gain ${gain[key].toFixed(2)} m ≤ 1`);
  }
  for (const [key, cap] of [
    [`${PW} green`, 12],
    ["7 Iron green", 12],
    ["Driver fairway", 15],
  ]) {
    if (!(gain[key] <= cap))
      fails.push(`H9b ${key}: topspin gain ${gain[key].toFixed(2)} m > ${cap}`);
  }
  for (const key of [`${PW} green`, "7 Iron fairway"]) {
    if (!(m[key].gain5 <= 1.3 * gain[key]))
      fails.push(
        `H9c ${key}: 5 swipes gain ${m[key].gain5.toFixed(2)} m > 1.3× one swipe ${gain[key].toFixed(2)} m`,
      );
  }
  if (!(gain["7 Iron rough"] <= 0.4 * gain["7 Iron fairway"]))
    fails.push(
      `H9d rough gain ${gain["7 Iron rough"].toFixed(2)} m > 40% of fairway ${gain["7 Iron fairway"].toFixed(2)} m`,
    );
  if (!(gain["7 Iron sand"] <= 1))
    fails.push(`H9d sand gain ${gain["7 Iron sand"].toFixed(2)} m > 1`);
  assertNone(t, fails, { m, gain });
});
