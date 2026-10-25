// Contract 6 (spectator fidelity) at its source, offline: what a shooter
// streams of its ball's path (path-sampler.js, as sim-client.js uses it).
// - A fast ball that strikes a rock between two samples of a fixed 20 Hz
//   stream turned back there, and a spectator's linear replay cut the corner,
//   1.5-1.8 m off the real path. Now a pose goes out wherever the path bends,
//   so the replay stays within a few cm of every frame, bounces included.
// - A fixed 20 Hz stream of one-sample frames cost ~2.3 KB/s; on an uplink
//   at the plan's ~1 KB/s budget it queued up, the spectator fell 5-12 s
//   behind, and a long roll-out's shotEnd reached the server after its 60 s
//   shot timer. Now a moving ball's stream, sampled where the path bends and
//   batched 4 frames a second, stays well inside that budget (live:
//   slow-uplink.test.js).
// Run: node --test test/mp/path-stream.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const { PathSampler } = require("./path-sampler.js");
const { SimClient } = require("./sim-client.js");
const { ClubData } = require("../../src/game/clubs.js");

const FPS = 60;
const EPS = 1.5; // checks.js checkPathFidelity's bound on a replay's error
const BUDGET = 1000; // B/s while a ball moves (the plan)
// What a path frame costs on the wire beyond its samples: the envelope
// {"t":"action","action":"path","data":{"samples":[...]}} and a client
// frame's WebSocket header (masked, 16-bit length).
const frameBytes = (samples) =>
  JSON.stringify({ t: "action", action: "path", data: { samples } }).length + 8;

/** Max distance of the linear replay of `sent` from every pose of `truth`. */
function replayError(sent, truth) {
  let worst = 0;
  let j = 0;
  for (const s of truth) {
    if (s[0] < sent[0][0] || s[0] > sent[sent.length - 1][0]) continue;
    while (sent[j + 1] && sent[j + 1][0] < s[0]) j++;
    const a = sent[j];
    const b = sent[j + 1] ?? a;
    const k = b[0] > a[0] ? (s[0] - a[0]) / (b[0] - a[0]) : 0;
    const d = [1, 2, 3].map((i) => a[i] + (b[i] - a[i]) * k - s[i]);
    worst = Math.max(worst, Math.hypot(...d));
  }
  return worst;
}

/** Every pose through `sampler` (the last one as the shot's end). */
function sampleAll(poses, sampler = new PathSampler()) {
  const out = [];
  poses.forEach((p, i) =>
    out.push(...(i === poses.length - 1 ? sampler.end(p) : sampler.push(p))),
  );
  return out;
}

// What the old stream sent: every third frame (20 Hz at 60 fps), and the
// last, rounded as sent (mm, and 4 places for the rotation).
const r = (v, n) => Math.round(v * 10 ** n) / 10 ** n;
function every3(truth) {
  const out = truth.filter((_, i) => i % 3 === 0);
  if (out.at(-1) !== truth.at(-1)) out.push(truth.at(-1));
  return out.map((s) => s.map((v, i) => r(v, i < 4 ? 3 : 4)));
}

/**
 * Bytes per second of shot time of the path frames a real-time sim sends:
 * one frame each 1/frameHz s with the samples picked since. `worst`: the
 * most in any `windowS` seconds.
 */
function streamCost(sent, { frameHz = 4, windowS = 5 } = {}) {
  const frames = new Map();
  for (const s of sent) {
    const k = Math.floor(s[0] * frameHz);
    if (!frames.has(k)) frames.set(k, []);
    frames.get(k).push(s);
  }
  const costs = [...frames].map(([k, ss]) => [k / frameHz, frameBytes(ss)]);
  const span = sent.at(-1)[0] - sent[0][0];
  const total = costs.reduce((n, [, b]) => n + b, 0);
  let worst = 0;
  for (const [t0] of costs) {
    const inWindow = costs
      .filter(([t]) => t >= t0 && t < t0 + windowS)
      .reduce((n, [, b]) => n + b, 0);
    worst = Math.max(worst, inWindow / Math.min(windowS, span));
  }
  return { perSecond: total / span, worst };
}

const pose = (t, x, y, z) => [t, x, y, z, 0, 0, 0, 1];

test("PathSampler: a straight roll costs one pose a maxGap", () => {
  const truth = Array.from({ length: 10 * FPS + 1 }, (_, i) =>
    pose(i / FPS, i * 0.05, 0, 0),
  );
  const sent = sampleAll(truth);
  assert.ok(replayError(sent, truth) < 1e-9);
  assert.ok(sent.length <= 10 / 0.25 + 2, `${sent.length} poses`);
  for (let i = 1; i < sent.length; i++)
    assert.ok(sent[i][0] - sent[i - 1][0] <= 0.25 + 1e-9);
});

test("PathSampler: a bounce between two 20 Hz samples is sampled where it turned", () => {
  // 100 m/s into a wall at x = 32.5 (t = 0.325 s, between the 20 Hz samples
  // at 0.30 and 0.35, both at x = 30), straight back out.
  const truth = Array.from({ length: FPS + 1 }, (_, i) => {
    const t = i / FPS;
    return pose(t, Math.min(100 * t, 65 - 100 * t), 1, 0);
  });
  assert.ok(replayError(every3(truth), truth) > EPS);
  const sent = sampleAll(truth);
  assert.ok(replayError(sent, truth) <= 0.05);
  assert.ok(
    sent.some((s) => s[1] > 31.6),
    "a pose at the turn",
  );
});

test("PathSampler: a path that bends every frame is held to `rate` poses a second", () => {
  const truth = Array.from({ length: 5 * FPS + 1 }, (_, i) =>
    pose(i / FPS, i * 0.3, (i % 2) * 0.5, 0),
  );
  const sent = sampleAll(truth, new PathSampler({ rate: 10, burst: 10 }));
  assert.ok(sent.length <= 10 + 10 * 5 + 2, `${sent.length} poses in 5 s`);
});

test("PathSampler: the stream ends on the end pose, once", () => {
  const s = new PathSampler();
  const a = pose(0, 0, 0, 0);
  const b = pose(0.1, 1, 0, 0);
  assert.deepEqual(s.push(a), [a]);
  assert.deepEqual(s.push(b), []);
  // Out of play somewhere never pushed as a frame (a water landing spot):
  // the frame before it turned, then the spot.
  const water = pose(0.2, 1.5, -1, 0);
  assert.deepEqual(s.end(water), [b, water]);
  // A last frame that was pushed goes out once.
  const s2 = new PathSampler();
  s2.push(a);
  s2.push(b);
  assert.deepEqual(s2.end(b), [b]);
  assert.deepEqual(s2.end(b), []);
});

// One genuine swing on a real hole, flown by SimClient._fly (unpaced, nothing
// sent): its 60 Hz truth and the poses it streamed.
async function fly(t, { hole, pin, wind, at, club, strength, bearing }) {
  const sim = new SimClient("ws://127.0.0.1:1", "Dave", {
    timeScale: Infinity,
    spinChance: 0,
  });
  sim._queuePath = () => {};
  t.after(() => sim.dispose());
  await sim.buildWorld();
  const w = sim.world;
  await w.loadHole(hole, pin);
  w.wind.setFromSeed(wind);
  let canopy = false;
  const bounce = w.course.treeBounce.bind(w.course);
  w.course.treeBounce = (b) => ((canopy = true), bounce(b));
  sim._place({ x: at.x, y: w.course.groundY(at.x, at.z) + 0.03, z: at.z });
  w.course.lastLie = w.ball.getPosition().clone();
  const plan = {
    club: ClubData.getClub(club),
    target: {
      x: at.x + Math.sin(bearing) * 100,
      y: 0,
      z: at.z - Math.cos(bearing) * 100,
    },
    bearing,
    strength,
    dist: 0,
    putt: false,
    trials: [],
    aim: bearing,
    power: 1,
  };
  w.clubSelector.currentClub = club;
  const hit = sim._swipe(plan, strength);
  assert.ok(hit, "swipe produced no hit");
  const shot = { spins: [], truth: [], sent: [], sentAt: [] };
  await sim._fly(shot, hit, plan);
  return { ...shot, canopy };
}

// A driver off hole 3's fairway into a rock 14 m ahead (found by an offline
// sweep): it strikes the rock at ~0.93 s, between two 20 Hz samples.
const ROCK_SHOT = {
  hole: 2,
  pin: 0,
  wind: 12345,
  at: { x: 30.06484604103345, z: 8.07106908652583 },
  club: 12,
  strength: 1.75,
  bearing: -0.7453981633974481,
};
// A 9 iron off hole 2's rough that rolls out for 52.5 s (sim-rest.test.js).
const LONG_ROLL = {
  hole: 1,
  pin: 4,
  wind: 497971582,
  at: { x: 22.10289001464844, z: 31.10020446777344 },
  club: 3,
  strength: 1.75,
  bearing: -0.14442905568428394,
};

test("a ball that strikes a rock between two 20 Hz samples replays within cm of its path", async (t) => {
  const shot = await fly(t, ROCK_SHOT);
  assert.ok(!shot.canopy && !shot.penalty, "the shot played out as found");
  const old = replayError(every3(shot.truth), shot.truth);
  const err = replayError(shot.sent, shot.truth);
  const cost = streamCost(shot.sent);
  t.diagnostic(
    `20 Hz replay strays ${old.toFixed(3)} m; the stream's ${err.toFixed(3)} m, ${shot.sent.length} poses in ${shot.simSeconds.toFixed(1)} s, ${cost.perSecond.toFixed(0)} B/s`,
  );
  assert.ok(old > EPS, `the 20 Hz stream strays only ${old.toFixed(3)} m`);
  // The sampler's 5 cm, plus the ms its t is rounded to at speed.
  assert.ok(err < 0.15, `the stream strays ${err.toFixed(3)} m`);
  assert.ok(cost.worst < 0.8 * BUDGET, JSON.stringify(cost));
});

test("a long roll-out streams inside the budget all the way", async (t) => {
  const shot = await fly(t, LONG_ROLL);
  const cost = streamCost(shot.sent);
  const old = streamCost(every3(shot.truth), { frameHz: 20 });
  t.diagnostic(
    `${shot.sent.length} poses in ${shot.simSeconds.toFixed(1)} s: ${cost.perSecond.toFixed(0)} B/s (worst 5 s ${cost.worst.toFixed(0)}); 20 Hz one-pose frames: ${old.perSecond.toFixed(0)} B/s`,
  );
  assert.ok(shot.simSeconds > 46, "the roll-out played out as found");
  assert.ok(replayError(shot.sent, shot.truth) < 0.15);
  assert.ok(cost.worst < 0.8 * BUDGET, JSON.stringify(cost));
  assert.ok(old.perSecond > 2 * BUDGET); // what it used to cost
});
