// Contract 1 (agreement) with the game's own penalty rules: an out-of-bounds
// shot played from a water drop is replayed from that drop. (It used to be
// replayed from the lie before the water: CourseManager.applyPenalty never
// recorded the drop as the lie. On hole 1 that was the tee, ~200 m behind a
// drop by the green; the server refused that rest as implausible for the
// club, the shot hung until the shot timeout, and server and shooter then
// disagreed on strokes and the lie.)
//
// Dave plays blind (lookahead 0), the way a person does. Shots are chosen by
// trying them first (state restored), so the scenario doesn't depend on the
// server's random pin and wind.
// Run: node --test test/mp/penalty-drop.test.js
const test = require("node:test");
const { setTimeout } = require("node:timers");
const { startGolfServer } = require("./server.js");
const { Bot, lobby, fakeShot } = require("./bot.js");
const { SimClient, makeRng } = require("./sim-client.js");
const C = require("./checks.js");
const { ClubData } = require("../../src/game/clubs.js");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const v3 = (p) => ({ x: p.x, y: p.y, z: p.z });

// Try shots from `start` (null: the tee) and keep the best scoring one
// (score(result) > 0), leaving the ball and course.lastLie as they were.
// Tree bounces are random, so a margin-y pick replays the same way.
function findShot(sim, start, clubs, bearings, strengths, score) {
  const { course } = sim.world;
  const keep = course.lastLie.clone();
  const reset = () => {
    sim._place(start);
    course.lastLie = keep.clone();
  };
  let found = null;
  let best = 0;
  for (const id of clubs)
    for (const strength of strengths)
      for (const bearing of bearings) {
        reset();
        const pos = sim.world.ball.getPosition();
        const plan = {
          club: ClubData.getClub(id),
          target: {
            x: pos.x + Math.sin(bearing) * 50,
            y: pos.y,
            z: pos.z - Math.cos(bearing) * 50,
          },
          bearing,
          strength,
          dist: 50,
          putt: id === 0,
          trials: [],
        };
        const k = score(sim._trial(plan, bearing, strength));
        if (k > best) {
          best = k;
          found = plan;
        }
      }
  reset();
  return found;
}

const deg = (d) => (d * Math.PI) / 180;
const fan = (center, span, step) => {
  const out = [];
  for (let d = 0; d <= span; d += step)
    out.push(center + deg(d), ...(d ? [center - deg(d)] : []));
  return out;
};

test(
  "an out-of-bounds shot after a water drop is replayed from a lie the server accepts",
  { timeout: 300000 },
  async (t) => {
    const srv = await startGolfServer({
      env: { GOLF_SHOT_TIMEOUT_MS: "8000" },
    });
    t.after(() => srv.stop());
    const dave = new SimClient(srv.url, "Dave", {
      timeScale: Infinity,
      seed: 3,
      lookahead: 0,
      spinChance: 0,
      aimSigmaDeg: 0,
      powerSigma: 0,
      autoplay: false,
    });
    const sam = new Bot(srv.url, "Sam");
    t.after(() => {
      dave.dispose();
      sam.close();
    });
    await Promise.all([dave.connect(), sam.connect()]);
    await lobby([dave, sam]);
    await dave.untilMyTurn();
    await dave.ensureHole(dave.match);
    // Tree bounces draw on Math.random: reseed it at every strike, so the
    // real swing replays the try it was picked from exactly.
    const random = Math.random;
    const { ball } = dave.world;
    const applyHit = ball.applyHit.bind(ball);
    ball.applyHit = (...args) => {
      Math.random = makeRng(77);
      return applyHit(...args);
    };
    t.after(() => (Math.random = random));
    const { course } = dave.world;
    const tee = v3(course.tee);
    const pinBearing = Math.atan2(
      course.cup.x - tee.x,
      -(course.cup.z - tee.z),
    );

    // 1. Off the tee into the water by the green.
    dave._place(null);
    const wet = findShot(
      dave,
      null,
      [9, 10, 11],
      fan(pinBearing, 30, 5),
      [1.75, 1.5, 1.3, 1.1],
      (r) => {
        if (!r.penalty || r.end.y < -10) return 0;
        const d = Math.hypot(r.end.x - tee.x, r.end.z - tee.z);
        return d > 200 ? 1 / (1 + Math.abs(d - 230)) : 0;
      },
    );
    assertFound(wet, "a tee shot into the water 200+ m out");
    dave._plan = () => wet;
    await dave.takeTurn(dave.match);
    const s1 = dave.shots[0];
    t.diagnostic(`water shot: ${s1.hazard}, drop ${JSON.stringify(s1.rest)}`);
    await dave.until((b) => b.myLie?.strokes === 2, {
      label: "the water shot",
    });

    // Sam tees off close to the pin, so Dave (at the drop) is away.
    await sam.untilMyTurn();
    fakeShot(sam, { fraction: 0.97, holeWithin: 0 });
    await dave.untilMyTurn({ timeout: 10000 });
    const drop = dave.myLie.pos;

    // 2. From the drop, a wedge off the edge of the island.
    const oob = findShot(
      dave,
      drop,
      [1, 2],
      fan(0, 180, 10),
      [1.75],
      // Out of bounds, as far past the island's edge as possible.
      (r) => (r.penalty && r.end.y < -10 ? 1 + outside(r.end) : 0),
    );
    assertFound(oob, "a short-club shot off the island from the drop");
    dave._plan = () => oob;
    await dave.takeTurn(dave.match);
    const s2 = dave.shots[1];
    t.diagnostic(
      `club ${s2.club} ${s2.hazard}: game drops at ${JSON.stringify(s2.rest)}, ` +
        `${Math.hypot(s2.rest.x - drop.x, s2.rest.z - drop.z).toFixed(1)} m from the drop`,
    );
    if (s1.hazard !== "water" || s2.hazard !== "oob")
      throw new Error(
        `setup: shots played ${s1.hazard} then ${s2.hazard}, not water then oob (scenario not exercised)`,
      );
    await dave.until((b) => b.myLie?.strokes !== 2 || b.notices.length, {
      timeout: 20000,
      label: "the out-of-bounds shot",
    });
    await sleep(9000); // past the shot timeout, if the shot was refused
    C.assertClean(
      [
        ...C.checkNoErrors([dave.records()], { strict: true }),
        ...C.checkAgreement([dave.records(), sam.records()]),
      ],
      "water then out of bounds",
    );
  },
);

// Hole 1's surface bounds (server HOLES table).
function outside(p) {
  return Math.max(0, Math.abs(p.x) - 59, Math.abs(p.z) - 147.3);
}

function assertFound(plan, what) {
  if (!plan)
    throw new Error(`setup: found no ${what} (scenario not exercised)`);
}
