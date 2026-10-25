// Contract 6 (spectator fidelity), live: "the replayed path stays within eps
// of the shooter's ground-truth path", and the plan's promise that streaming
// the real path is "exact, including ... bounces". The shooter used to
// sample at a fixed 20 Hz (every 3rd frame), so a ball that struck a rock at
// speed turned between two samples, and the spectator's linear replay cut
// the corner, 1.5-1.8 m off the true path (about 1 in 1000 genuine
// full-power shots). Now a pose goes out wherever the path bends
// (path-sampler.js; offline in path-stream.test.js), and this checks it end
// to end, through the server's relay.
//
// Dave (sims, real holes, a private server) first plays to a lie near a
// rock, then, from there, a full-power shot into the rock that his own trial
// run shows a 20 Hz stream would have misrepresented (no tree canopy
// involved, so the physics replays the same). The spectator's copy of that
// shot must stay within the kit's eps (1.5 m) of what Dave's ball really did.
// Run: node --test test/mp/bounce-fidelity.test.js
//   MP_PORT (7855), MP_SEED (1)
const test = require("node:test");
const { setTimeout } = require("node:timers");
const { startGolfServer } = require("./server.js");
const { lobby } = require("./bot.js");
const { SimClient } = require("./sim-client.js");
const C = require("./checks.js");
const { ClubData } = require("../../src/game/clubs.js");
const { PhysicsConfig } = require("../../src/game/physics.js");

const PORT = Number(process.env.MP_PORT || 7855);
const SEED = Number(process.env.MP_SEED || 1);
const EPS = 1.5;
const flat = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);

// What the old stream sent: every third frame (20 Hz at 60 fps), and the last.
function every3(truth) {
  const out = truth.filter((_, i) => i % 3 === 0);
  if (out.at(-1) !== truth.at(-1)) out.push(truth.at(-1));
  return out;
}

// Max distance of the stream's linear replay from the 60 Hz truth (as
// checks.js checkPathFidelity measures it).
function replayError(sent, truth) {
  let worst = 0;
  for (const s of truth) {
    if (s[0] < sent[0][0] || s[0] > sent[sent.length - 1][0]) continue;
    const k = sent.findIndex((x) => x[0] >= s[0]);
    let p = sent[k];
    if (p[0] !== s[0]) {
      const a = sent[k - 1];
      const f = (s[0] - a[0]) / (p[0] - a[0]);
      p = [0, 1, 2, 3].map((i) => (i ? a[i] + (p[i] - a[i]) * f : s[0]));
    }
    worst = Math.max(worst, Math.hypot(p[1] - s[1], p[2] - s[2], p[3] - s[3]));
  }
  return worst;
}

// One shot flown exactly as the real swing will fly it (sim _fly, nothing
// sent), then undone. Reports the replay error of a 20 Hz stream of it and
// whether a tree canopy (random deflection) was involved.
async function tryShot(sim, start, fromTee, plan) {
  const w = sim.world;
  sim._place(fromTee ? null : start);
  w.clubSelector.currentClub = plan.club.id;
  const hit = sim._swipe(plan, plan.strength);
  if (!hit) return null;
  const shot = { spins: [], truth: [], sent: [], sentAt: [] };
  const count = w.game.currentHoleShotCount;
  const queue = sim._queuePath;
  sim._queuePath = () => {};
  sim._canopy = false;
  try {
    await sim._fly(shot, hit, { ...plan, aim: plan.bearing });
  } finally {
    sim._queuePath = queue;
  }
  const rest = w.ball.getPosition().clone();
  w.game.currentHoleShotCount = count;
  const pin = w.course.pinManager.pins[0];
  if (pin)
    Object.assign(pin, { sunk: false, captured: false, captureFrames: 0 });
  w.ball._inCup = false;
  w.course.busy = false;
  sim._sunk = false;
  return {
    err: replayError(every3(shot.truth), shot.truth),
    rest,
    hazard: shot.hazard,
    holed: shot.holed,
    canopy: sim._canopy,
  };
}

const planFor = (pos, club, bearing, strength) => ({
  club: ClubData.getClub(club),
  target: {
    x: pos.x + Math.sin(bearing) * 100,
    y: pos.y,
    z: pos.z - Math.cos(bearing) * 100,
  },
  bearing,
  strength,
  dist: 100,
  putt: club === 0,
  trials: [],
});

// One match: Dave hunts for the rock shot. Returns the records and the shot,
// or null if the match ended without a lie near enough to a rock.
async function attempt(t, url, seed) {
  const exact = {
    timeScale: Infinity,
    lookahead: 1,
    spinChance: 0,
    aimSigmaDeg: 0,
    puttAimSigmaDeg: 0,
    powerSigma: 0,
    puttPowerSigma: 0,
  };
  const dave = new SimClient(url, "Dave", { ...exact, seed });
  const sam = new SimClient(url, "Sam", {
    timeScale: Infinity,
    seed: seed + 1,
  });
  try {
    await Promise.all([dave.connect(), sam.connect()]);
    const course = dave.world.course;
    const bounce = course.treeBounce.bind(course);
    course.treeBounce = (b) => {
      dave._canopy = true;
      return bounce(b);
    };

    // Dave's turns: from near a rock, look for a full-power shot into it
    // that a 20 Hz stream would misrepresent; otherwise lay up beside a rock.
    const bounced = [];
    dave._refine = async (plan, start, fromTee) => {
      const rocks = dave.world.decor.filter((d) => !d.isTree);
      let best = null;
      for (const r of rocks.filter((x) => flat(x.pos, start) < 30)) {
        const base = Math.atan2(r.pos.x - start.x, -(r.pos.z - start.z));
        for (const db of [-0.06, -0.03, 0, 0.03, 0.06])
          for (const club of [12, 10, 9, 8])
            for (const strength of [1.75, 1.45, 1.15, 0.9]) {
              const p = planFor(start, club, base + db, strength);
              const o = await tryShot(dave, start, fromTee, p);
              if (!o || o.canopy || o.holed) continue;
              if (!best || o.err > best.o.err) best = { p, o };
            }
      }
      if (best && best.o.err > EPS + 0.1) {
        Object.assign(plan, best.p);
        bounced.push({ turnSeq: dave.match.turnSeq, predicted: best.o.err });
        return;
      }
      // The trial that rests closest to 12 m short of a rock, on dry land.
      let lay = null;
      for (const r of rocks) {
        const d = flat(r.pos, start);
        if (d < 20 || d > 200) continue;
        const base = Math.atan2(r.pos.x - start.x, -(r.pos.z - start.z));
        const want = d - 12;
        const club = dave.world.clubSelector.suggestClub(want, false);
        const strength = dave._input.solveSwipeStrengthForDistance(
          want,
          PhysicsConfig.STEP_SECONDS,
          PhysicsConfig.BALL_LINEAR_DAMPING,
          Math.abs(PhysicsConfig.GRAVITY.y),
          ClubData.getClub(club),
        );
        for (const k of [0.85, 1, 1.15]) {
          const p = planFor(start, club, base, Math.min(1.75, strength * k));
          const o = await tryShot(dave, start, fromTee, p);
          if (!o || o.canopy || o.hazard || o.holed) continue;
          const gap = Math.abs(flat(o.rest, r.pos) - 12);
          if (!lay || gap < lay.gap) lay = { p, gap };
        }
      }
      if (lay) Object.assign(plan, lay.p);
    };

    await lobby([dave, sam]);
    const swung = () =>
      bounced.length &&
      dave.shots.some(
        (s) => s.endSentAt != null && s.turnSeq === bounced[0].turnSeq,
      );
    await dave.until((d) => swung() || d.you?.phase === "finished", {
      timeout: 8 * 60 * 1000,
      label: "Dave's rock shot",
    });
    if (!swung()) return null;
    const shot = dave.shots.find((s) => s.turnSeq === bounced[0].turnSeq);
    await sam.until(
      (s) => s.match?.phase !== "playing" || s.match.turnSeq > shot.turnSeq,
      { timeout: 60000, label: "the shot to resolve" },
    );
    await new Promise((r) => setTimeout(r, 500));
    t.diagnostic(
      `seed ${seed}: rock shot hole ${shot.hole + 1} from ${C.stable(shot.from)} club ${shot.club}: a 20 Hz stream would stray ${bounced[0].predicted.toFixed(3)} m (played: ${replayError(every3(shot.truth), shot.truth).toFixed(3)} m); the stream strays ${replayError(shot.sent, shot.truth).toFixed(3)} m`,
    );
    // The real swing can take a hair's different line than its trial and
    // miss the rock's face: then this match didn't test it.
    if (replayError(every3(shot.truth), shot.truth) <= EPS) return null;
    return { recs: [dave.records(), sam.records()], shot };
  } finally {
    dave.dispose();
    sam.dispose();
  }
}

test(
  "a rock bounce replays within eps of the shooter's path",
  { timeout: 30 * 60 * 1000 },
  async (t) => {
    const srv = await startGolfServer({
      port: PORT,
      env: { GOLF_TURN_TIMEOUT_MS: "120000" },
    });
    t.after(() => srv.stop());
    let got = null;
    for (let i = 0; i < 4 && !got; i++)
      got = await attempt(t, srv.url, SEED + 10 * i);
    if (!got) throw new Error("no rock strike between samples in 4 matches");
    const v = C.checkPathFidelity(got.recs[0], got.recs[1], {
      eps: EPS,
      shots: (s) => s === got.shot,
    });
    t.diagnostic(`path stats ${JSON.stringify(v.stats)}`);
    C.assertClean(v, "rock bounce replay");
  },
);
