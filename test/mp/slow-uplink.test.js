// Contracts 6 (bounded spectator delay) and 1 (agreement) for a shooter on a
// slow uplink, with the server's default shot timer and real-time play.
// The plan budgets "~1 KB/s while a ball is moving". The shooter used to
// stream one ~116-byte `path` frame per sample at 20 Hz (~2.3 KB/s), so on
// an uplink below that the frames queued behind each other:
// - the spectator saw the ball further and further behind (5-12 s into an
//   ordinary 5-13 s shot, on 1.2 KB/s);
// - the shotEnd queued behind the whole backlog, so on an uplink of the
//   plan's 1 KB/s a long genuine roll-out (hole 2's slopes roll out for
//   30-50 s) reached the server after its 60 s shot timer: the server
//   charged a stroke and put the ball back on the tee, while the shooter's
//   ball lay 100+ m down the hole.
// The stream now samples where the path bends and batches 4 frames a second
// (path-sampler.js; ~500 B/s, offline in path-stream.test.js), and fits.
// Run: node --test test/mp/slow-uplink.test.js
//   MP_UP_BPS (1200), MP_EXPIRY_UP_BPS (1000), MP_SEED (1); ports 7854, 7857
const test = require("node:test");
const { setTimeout } = require("node:timers");
const { startGolfServer } = require("./server.js");
const { startTcpLink } = require("./tcp-link.js");
const { lobby } = require("./bot.js");
const { SimClient } = require("./sim-client.js");
const C = require("./checks.js");
const { ClubData } = require("../../src/game/clubs.js");

const UP_BPS = Number(process.env.MP_UP_BPS || 1200);
// The plan's own budget for a moving ball.
const EXPIRY_UP_BPS = Number(process.env.MP_EXPIRY_UP_BPS || 1000);
const SEED = Number(process.env.MP_SEED || 1);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function setup(t, port, env = {}) {
  const srv = await startGolfServer({ port, env });
  t.after(() => srv.stop());
  const link = await startTcpLink(srv.url, {
    up: { latencyMs: 40, bytesPerSec: UP_BPS },
    down: { latencyMs: 40 },
    seed: SEED,
  });
  t.after(() => link.close());
  return { srv, link };
}

test(
  `a shooter on a ${UP_BPS} B/s uplink streams within the delay bound`,
  { timeout: 15 * 60 * 1000 },
  async (t) => {
    const { srv, link } = await setup(t, 7854);
    // Dave hosts (honor on hole 1) and plays over the slow uplink.
    const dave = new SimClient(link.url, "Dave", { timeScale: 1, seed: SEED });
    const sam = new SimClient(srv.url, "Sam", { timeScale: 1, seed: SEED + 1 });
    t.after(() => {
      dave.dispose();
      sam.dispose();
    });
    await Promise.all([
      dave.connect({ timeout: 30000 }),
      sam.connect({ timeout: 30000 }),
    ]);
    await lobby([dave, sam]);
    const done = (d) => d.shots.filter((s) => s.endSentAt != null).length;
    await dave.until((d) => done(d) >= 3 || d.you?.phase === "finished", {
      timeout: 12 * 60 * 1000,
      label: "Dave's first three shots",
    });
    // Let the last shot resolve on the server and reach both views.
    await sam.until(
      (s) =>
        s.match?.phase !== "playing" ||
        s.match.turnSeq > dave.shots[dave.shots.length - 1].turnSeq,
      { timeout: 120000, label: "Dave's last shot to resolve" },
    );
    await sleep(1000);
    dave.opts.autoplay = false;
    sam.opts.autoplay = false;
    const recs = [dave.records(), sam.records()];
    for (const s of recs[0].shots.filter((x) => x.endSentAt != null))
      t.diagnostic(
        `Dave hole ${s.hole + 1}: ${s.sent.length} samples, sim ${s.simSeconds?.toFixed(1)} s -> ${C.shotOutcome(recs[0], s).outcome}`,
      );
    const v = C.checkPathFidelity(recs[0], recs[1], {
      requireComplete: false,
      maxDelayMs: 1500,
    });
    t.diagnostic(`path stats ${JSON.stringify(v.stats)}`);
    C.assertClean(v, "slow uplink");
  },
);

test(
  `a long genuine roll-out over a ${EXPIRY_UP_BPS} B/s uplink is not expired`,
  { timeout: 20 * 60 * 1000 },
  async (t) => {
    // Turns are long so Dave's search for the shot never runs out the turn;
    // the shot timer is the server's default.
    const { srv, link } = await setup(t, 7857, {
      GOLF_TURN_TIMEOUT_MS: "600000",
    });
    // Hole 1 is played at full speed over a fast link; hole 2 in real time
    // over the slow uplink.
    link.set({ up: { bytesPerSec: Infinity } });
    const dave = new SimClient(link.url, "Dave", {
      timeScale: Infinity,
      seed: SEED,
      lookahead: 1,
      spinChance: 0,
      aimSigmaDeg: 0,
      powerSigma: 0,
    });
    const sam = new SimClient(srv.url, "Sam", {
      timeScale: Infinity,
      seed: SEED + 1,
    });
    t.after(() => {
      dave.dispose();
      sam.dispose();
    });
    await Promise.all([dave.connect(), sam.connect()]);

    // Dave's tee shot on hole 2: the longest-rolling of a grid of swings,
    // each flown for real (and undone) in his own world with the hole's wind.
    let chosen = null;
    const refine = dave._refine.bind(dave);
    dave._refine = async (plan, start, fromTee) => {
      if (!(fromTee && dave.match.hole === 1))
        return refine(plan, start, fromTee);
      const w = dave.world;
      const cup = w.course.cup;
      const base = Math.atan2(cup.x - start.x, -(cup.z - start.z));
      const queue = dave._queuePath;
      dave._queuePath = () => {};
      let best = null;
      try {
        for (let db = -0.6; db <= 0.61; db += 0.1)
          for (const id of [12, 10, 9, 7, 5, 3, 1])
            for (const strength of [1.75, 1.3, 0.9, 0.6]) {
              dave._place(null);
              const bearing = base + db;
              const p = {
                club: ClubData.getClub(id),
                target: {
                  x: start.x + Math.sin(bearing) * 100,
                  y: start.y,
                  z: start.z - Math.cos(bearing) * 100,
                },
                bearing,
                strength,
                dist: 100,
                putt: false,
                trials: [],
              };
              w.clubSelector.currentClub = id;
              const hit = dave._swipe(p, strength);
              if (!hit) continue;
              const shot = { spins: [], truth: [], sent: [], sentAt: [] };
              const count = w.game.currentHoleShotCount;
              await dave._fly(shot, hit, { ...p, aim: bearing });
              w.game.currentHoleShotCount = count;
              w.course.busy = false;
              if (shot.penalty || shot.holed || shot.stuck) continue;
              if (!best || shot.simSeconds > best.secs)
                best = { p, secs: shot.simSeconds, n: shot.sent.length };
            }
      } finally {
        dave._queuePath = queue;
      }
      Object.assign(plan, best.p);
      chosen = { ...best, turnSeq: dave.match.turnSeq };
      // From here Dave plays in real time over the slow uplink.
      dave.opts.timeScale = 1;
      link.set({ up: { bytesPerSec: EXPIRY_UP_BPS } });
    };

    await lobby([dave, sam]);
    await dave.until(
      (d) =>
        (chosen &&
          d.shots.some(
            (s) => s.turnSeq === chosen.turnSeq && s.endSentAt != null,
          )) ||
        d.you?.phase === "finished",
      { timeout: 15 * 60 * 1000, label: "Dave's hole 2 tee shot" },
    );
    if (!chosen) throw new Error("the match ended before Dave teed off on 2");
    const shot = dave.shots.find((s) => s.turnSeq === chosen.turnSeq);
    // Both views past the shot's turn (Dave's lags: his pongs queue behind
    // the same backlog).
    for (const c of [sam, dave])
      await c.until(
        (x) => x.match?.phase !== "playing" || x.match.turnSeq > shot.turnSeq,
        { timeout: 180000, label: `${c.name}: the shot to resolve` },
      );
    await sleep(1000);
    dave.opts.autoplay = false;
    sam.opts.autoplay = false;
    const recs = [dave.records(), sam.records()];
    t.diagnostic(
      `chosen: club ${chosen.p.club.id} strength ${chosen.p.strength} rolls ${chosen.secs.toFixed(1)} s (${chosen.n} samples); played ${shot.simSeconds.toFixed(1)} s, rest ${C.stable(shot.rest)}, shotEnd left ${((shot.endSentAt - shot.openedAt) / 1000).toFixed(1)} s after shotStart`,
    );
    const v = [];
    const expired = sam
      .chatLog()
      .find(
        (l) =>
          !l.from &&
          l.text === "Dave's shot timed out: stroke, replay from the lie",
      );
    if (expired)
      v.push(
        `Dave's genuine ${shot.simSeconds.toFixed(1)} s roll-out on hole 2 was expired by the server ("${expired.text}"): stroke, ball back on the tee, though it lies at ${C.stable(shot.rest)}`,
      );
    for (const n of dave.notices) v.push(`Dave notice "${n.text}"`);
    // Scored where it rests: the server's lie is the shooter's rest.
    v.push(...C.checkAgreement(recs));
    C.assertClean(v, "slow uplink, long roll-out");
  },
);
