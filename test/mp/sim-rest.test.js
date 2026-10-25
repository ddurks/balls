// Contract 3 (liveness) and 1 (agreement) on genuine shots: every shot comes
// to rest, so the shooter sends shotEnd with its real lie. Swings from
// sim-vs-sim sweeps, replayed on the same hole, pin and wind with the same
// mid-air spin swipe, that never reached "fullLand" (0.1-0.3% of spin-swiped
// shots in sim matches): the game had no cap, and in a match the server
// expired the shot at 60 s, charged a stroke and put the ball back where it
// was hit from.
// - hole 1 drive: plugs in a bunker's vertical lip, still spinning at ~80 rad/s.
//   Sand holds a ball at any tilt, and the hold kept "real spin" for contact
//   friction to act on, but with no weight on that face there was none.
// - hole 3 chip: held in a bunker, it crept on at 1.6 cm/s. The hold pushed it
//   into the contact normal it came to rest on, kept while held, which wasn't
//   the face it then touched: part of the push ran along that face.
// - hole 3 approach: wedged against a rock on rough too steep for the turf to
//   hold, and still. Only the turf's hold counted as rest; the rock's contact
//   wasn't support.
// - hole 3 drive: caught under the edge of the fairway's mesh where it lies
//   over the rough, pinned and still. Nothing the rolling law models holds it
//   there; a ball that crawls slower than turf's catch speed for 2 s is now
//   at rest whatever holds it.
// Each case is replayed a few times (the first swing after a hole loads can
// take a slightly different line). Every replay must come to rest, still
// enough for the game's own settle check, and the scenario must play out (the
// ball rests where it used to be stuck).
// And the sim itself plays a genuine shot to rest: a 9 iron off hole 2's
// rough that runs out down the slope rolls for 52.5 s (crawling its last
// metres at ~5 cm/s, above the game's 2 cm/s backstop). The sim used to cut
// any shot off at 45 s, send the still-rolling ball's spot as its rest, and
// report a stuck shot that wasn't.
// Run: node --test test/mp/sim-rest.test.js
const test = require("node:test");
const { SimClient } = require("./sim-client.js");
const { B } = require("../helpers/course-world.js");
const { ClubData } = require("../../src/game/clubs.js");
const { CONFIG } = require("../../src/game/config.js");

const CASES = [
  {
    label: "hole 1 drive that plugs in a bunker's lip, spinning",
    hole: 0,
    pinIndex: 2,
    windSeed: 995982218,
    fromTee: true,
    club: 12,
    aim: -0.002612188790923387,
    hit: {
      deltaX: 63.38146292259512,
      deltaY: -28.223705551736828,
      force: 138.76292584519024,
      swipeDuration: 0.01,
    },
    spin: {
      t: 1.015857490242352,
      dx: -50.453913887031376,
      dy: -55.29384617228061,
    },
    stuckAt: { x: -27.942, y: 0.621, z: -104.744 },
  },
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
  {
    label: "hole 3 drive caught under the fairway's edge",
    hole: 2,
    pinIndex: 0,
    windSeed: 60310685,
    fromTee: true,
    club: 10,
    aim: -0.014986581834868645,
    hit: {
      deltaX: -100,
      deltaY: -35.1567916624939,
      force: 175,
      swipeDuration: 0.01,
    },
    spin: { t: 0.9333333333333338, dx: 90.077443420887, dy: 16.6308737359941 },
    stuckAt: { x: 50.08, y: 2.166, z: -60.927 },
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

test("the sim plays a genuine 52 s roll-out to rest, not cut off as stuck", async (t) => {
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
  w.wind.setFromSeed(497971582);
  // A height-grid cell on the rough right of the fairway, as a sweep found it.
  const x = 22.10289001464844;
  const z = 31.10020446777344;
  sim._place({ x, y: w.course.groundY(x, z) + 0.03, z });
  w.course.lastLie = w.ball.getPosition().clone();
  const bearing = -0.14442905568428394;
  const plan = {
    club: ClubData.getClub(3),
    target: { x: 8.997318267822266, y: -0.10478242836401819, z: -59 },
    bearing,
    strength: 1.75,
    dist: 0,
    putt: false,
    trials: [],
    aim: bearing,
    power: 1,
  };
  w.clubSelector.currentClub = 3;
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
  // The scenario played out: a roll-out longer than the old 45 s cap, ending
  // inside the server's 60 s shot timer.
  if (!(shot.simSeconds > 46 && shot.simSeconds < sim.opts.maxShotSeconds))
    throw new Error(`the shot took ${shot.simSeconds.toFixed(1)} s`);
});
