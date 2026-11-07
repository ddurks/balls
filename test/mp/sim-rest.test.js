// Contract 3 (liveness) and 1 (agreement) on genuine shots: every shot comes
// to rest, so the shooter sends shotEnd with its real lie. Swings from
// sim-vs-sim sweeps, replayed on the same hole, pin and wind with the same
// mid-air spin swipe, that never reached "fullLand" (0.1-0.3% of spin-swiped
// shots in sim matches): the game had no cap, and in a match the server
// expired the shot at 60 s, charged a stroke and put the ball back where it
// was hit from.
// - hole 3 chip: held in a bunker, it crept on at 1.6 cm/s. The hold pushed it
//   into the contact normal it came to rest on, kept while held, which wasn't
//   the face it then touched: part of the push ran along that face.
// - hole 3 approach: wedged against a rock on rough too steep for the turf to
//   hold, and still. Only the turf's hold counted as rest; the rock's contact
//   wasn't support.
// (Two more cases, a drive plugged in a bunker's vertical lip and one pinned
// under the fairway's edge, are gone with those edges: the course's seams are
// flush now, so neither swing finds its trap.)
// Each case is replayed a few times (the first swing after a hole loads can
// take a slightly different line). Every replay must come to rest, still
// enough for the game's own settle check, and the scenario must play out (the
// ball rests where it used to be stuck).
// And the sim itself plays a long roll-out to rest. It used to cut any shot
// off at 45 s, send the still-rolling ball's spot as its rest, and report a
// stuck shot that wasn't; its cap now outlasts the 45 s, short of the server's
// 60 s shot timer. The 52 s roll-out this was found with crawled down a seam's
// dip that the flush course no longer has (thousands of swings now find
// nothing past ~30 s), so it's a 28 s putt off hole 2's desert, found by a sweep.
// Run: node --test test/mp/sim-rest.test.js
const test = require("node:test");
const { SimClient } = require("./sim-client.js");
const { B } = require("../helpers/course-world.js");
const { ClubData } = require("../../src/game/clubs.js");
const { CONFIG } = require("../../src/game/config.js");

const CASES = [
  {
    label: "hole 3 chip that crept through a bunker",
    hole: 2,
    pinIndex: 4,
    windSeed: 2033121815,
    fromTee: false,
    from: {
      x: 10.67406940460205,
      y: 1.9406890869140625,
      z: -162.9058074951172,
    },
    club: 1,
    aim: 0.15155441984965418,
    hit: {
      deltaX: 0,
      deltaY: -83.88444885676358,
      force: 167.76889771352717,
      swipeDuration: 0.01,
    },
    spin: {
      t: 1.0264451740762441,
      dx: -83.78944639116526,
      dy: -31.20363410562277,
    },
    stuckAt: { x: 17.245, y: 0.557, z: -215.315 },
  },
  {
    label: "hole 3 approach wedged against a rock on steep rough",
    hole: 2,
    pinIndex: 1,
    windSeed: 92079960,
    fromTee: false,
    from: {
      x: -7.314054012298584,
      y: 0.8982332944869995,
      z: 48.731651306152344,
    },
    club: 10,
    aim: 0.2269241125169998,
    hit: {
      deltaX: 27.217509257350116,
      deltaY: -75.83773893892183,
      force: 161.1478260175048,
      swipeDuration: 0.01,
    },
    spin: { t: 1.0839927124693158, dx: 23.35276713129133, dy: 21.715073059313 },
    stuckAt: { x: 54.326, y: 1.81, z: -219.764 },
  },
];
const REPLAYS = 3;
const NEAR_M = 0.5;

// One swing through SimClient._fly (unpaced, nothing sent), with the
// recorded mid-air spin swipe applied at the recorded moment.
async function replay(sim, c) {
  const w = sim.world;
  const { ball } = w;
  sim._place(c.fromTee ? null : c.from);
  if (!c.fromTee)
    w.course.lastLie = new B.Vector3(c.from.x, c.from.y, c.from.z);
  // _fly draws: spin or not, dx, dy, min height.
  const draws = [0, (c.spin.dx / 150 + 1) / 2, (c.spin.dy / 110 + 1) / 2, 0];
  sim.rand = () => (draws.length ? draws.shift() : 0.5);
  const contact = 0.8 * (1.8 - Math.min(c.hit.force / (1.75 * 100), 1) * 0.8);
  let frames = 0;
  const frame = w.frame;
  w.frame = () => {
    frames++;
    return frame();
  };
  const getHeight = ball.getHeight;
  ball.getHeight = () =>
    contact + frames / w.fps >= c.spin.t - 1e-6 ? 100 : 0;
  const plan = { club: ClubData.getClub(c.club), aim: c.aim, putt: false };
  const shot = { spins: [], truth: [], sent: [], sentAt: [] };
  w.game.currentHoleShotCount = 0;
  try {
    await sim._fly(shot, c.hit, plan);
  } finally {
    w.frame = frame;
    ball.getHeight = getHeight;
  }
  const p = ball.getPosition();
  return {
    stuck: !!shot.stuck,
    seconds: +(shot.simSeconds - contact).toFixed(1),
    at: { x: +p.x.toFixed(3), y: +p.y.toFixed(3), z: +p.z.toFixed(3) },
    speed: +ball.body.getLinearVelocity().length().toFixed(4),
    spin: +ball.body.getAngularVelocity().length().toFixed(2),
    penalty: shot.penalty,
  };
}

for (const c of CASES)
  test(
    `a genuine shot comes to rest: ${c.label}`,
    { timeout: 300000 },
    async (t) => {
      const sim = new SimClient("ws://127.0.0.1:1", "Replay", {
        timeScale: Infinity,
        spinChance: 1,
      });
      sim._queuePath = () => {};
      t.after(() => sim.dispose());
      await sim.buildWorld();
      await sim.world.loadHole(c.hole, c.pinIndex);
      sim.world.wind.setFromSeed(c.windSeed);
      const runs = [];
      for (let i = 0; i < REPLAYS; i++) runs.push(await replay(sim, c));
      t.diagnostic(JSON.stringify(runs));
      const fail = (why, rs) => {
        throw new Error(`${why}: ${JSON.stringify(rs)}`);
      };
      const stuck = runs.filter((r) => r.stuck);
      if (stuck.length)
        fail(
          `${stuck.length} of ${REPLAYS} replays never came to rest in ${sim.opts.maxShotSeconds} s`,
          stuck,
        );
      // Still enough for the game to hand the player the next swing.
      const restless = runs.filter(
        (r) =>
          r.speed >= 0.03 || r.spin >= CONFIG.PHYSICS.LANDED_ANGULAR_THRESHOLD,
      );
      if (restless.length) fail("came to rest still moving", restless);
      const near = (r) =>
        Math.hypot(
          r.at.x - c.stuckAt.x,
          r.at.y - c.stuckAt.y,
          r.at.z - c.stuckAt.z,
        ) < NEAR_M;
      if (!runs.some(near))
        fail(
          `no replay reached the spot it used to stick at, ${JSON.stringify(c.stuckAt)}`,
          runs,
        );
    },
  );

test("the sim plays a genuine long roll-out to rest, not cut off as stuck", async (t) => {
  // Defaults (the sim's own shot cap), except no mid-air spin: the swing had none.
  const sim = new SimClient("ws://127.0.0.1:1", "Dave", {
    timeScale: Infinity,
    spinChance: 0,
  });
  sim._queuePath = () => {}; // offline: nothing is sent
  t.after(() => sim.dispose());
  await sim.buildWorld();
  const w = sim.world;
  await w.loadHole(1, 4);
  w.wind.setFromSeed(186155557);
  // A spot on hole 2's desert, as a sweep found it.
  const x = 20.222043693065643;
  const z = -10.402905464172363;
  sim._place({ x, y: w.course.groundY(x, z) + 0.03, z });
  w.course.lastLie = w.ball.getPosition().clone();
  const bearing = 2.298444231748581;
  const plan = {
    club: ClubData.getClub(0),
    target: {
      x: x + Math.sin(bearing) * 100,
      y: 0,
      z: z - Math.cos(bearing) * 100,
    },
    bearing,
    strength: 0.3081337302923203,
    dist: 0,
    putt: false,
    trials: [],
    aim: bearing,
    power: 1,
  };
  w.clubSelector.currentClub = 0;
  const hit = sim._swipe(plan, plan.strength);
  if (!hit) throw new Error("swipe produced no hit");
  const shot = { spins: [], truth: [], sent: [], sentAt: [] };
  await sim._fly(shot, hit, plan);
  const v = w.ball.body.getLinearVelocity().length();
  t.diagnostic(
    `ended at ${shot.simSeconds.toFixed(1)} s, stuck ${!!shot.stuck}, speed ${v.toFixed(3)} m/s`,
  );
  if (shot.stuck)
    throw new Error(
      `cut off at ${shot.simSeconds.toFixed(1)} s while still rolling at ${v.toFixed(3)} m/s`,
    );
  // The scenario played out (a long crawl to rest), under a cap past the old
  // 45 s and inside the server's 60 s shot timer.
  if (!(shot.simSeconds > 25 && shot.simSeconds < sim.opts.maxShotSeconds))
    throw new Error(`the shot took ${shot.simSeconds.toFixed(1)} s`);
  if (!(sim.opts.maxShotSeconds > 45 && sim.opts.maxShotSeconds < 60))
    throw new Error(`the sim's shot cap is ${sim.opts.maxShotSeconds} s`);
});
