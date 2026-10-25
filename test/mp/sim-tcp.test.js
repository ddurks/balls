// Contracts 3 and 1 with two sim clients (real physics) behind byte-level
// TCP links the server can feel (latency + jitter both ways, throttled
// up/downlinks, stalls, silent half-open cuts), with short turn and shot
// timeouts. Every match must finish (or be forfeited) and the survivors'
// views and shots must agree with the server.
// Run: node --test test/mp/sim-tcp.test.js
//   MP_ONLY=<scenario substring>, MP_TIME_SCALE (8), MP_PORT (7833), MP_SEED
const test = require("node:test");
const { setTimeout } = require("node:timers");
const { startGolfServer } = require("./server.js");
const { startTcpLink } = require("./tcp-link.js");
const { lobby } = require("./bot.js");
const { SimClient } = require("./sim-client.js");
const C = require("./checks.js");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const TIME_SCALE = Number(process.env.MP_TIME_SCALE || 8);
const ONLY = process.env.MP_ONLY || "";
const PORT = Number(process.env.MP_PORT || 7833);
const SEED = Number(process.env.MP_SEED || 0);

async function setup(t, { env, links, seeds, sim = {} }) {
  const srv = await startGolfServer({
    port: PORT,
    env: { GOLF_FINISHED_LINGER_MS: "60000", ...env },
  });
  t.after(() => srv.stop());
  const ls = [];
  for (const [i, l] of links.entries()) {
    const link = await startTcpLink(srv.url, { seed: 10 + i + SEED, ...l });
    ls.push(link);
    t.after(() => link.close());
  }
  const dave = new SimClient(ls[0].url, "Dave", {
    timeScale: TIME_SCALE,
    seed: seeds[0] + SEED,
    ...sim,
  });
  const sam = new SimClient(ls[1].url, "Sam", {
    timeScale: TIME_SCALE,
    seed: seeds[1] + SEED,
    ...sim,
  });
  t.after(() => {
    dave.dispose();
    sam.dispose();
  });
  await Promise.all([
    dave.connect({ timeout: 30000 }),
    sam.connect({ timeout: 30000 }),
  ]);
  return { srv, links: ls, dave, sam };
}

const finished = (s, timeout = 10 * 60 * 1000) =>
  s.until((b) => b.you?.phase === "finished" || b.closed, {
    timeout,
    allowClosed: true,
    label: `${s.name} finished`,
  });

function summary(t, sims) {
  for (const s of sims) {
    const vs = C.views(s.records());
    const m = vs[vs.length - 1]?.m;
    const out = s.shots.map((x) => C.shotOutcome(s.records(), x).outcome);
    t.diagnostic(
      `${s.name}: ${m?.phase} ${m?.result?.text ?? ""}; holes ${(m?.holeResults ?? []).map((r) => `${C.stable(r.strokes)} ${r.reason}`).join(" ")}; shots ${s.shots.length} ${JSON.stringify(out)}; notices ${s.notices.map((n) => n.text).join(" | ")}`,
    );
  }
}

function fullChecks(recs, { survivors = recs } = {}) {
  return [
    ...C.checkLiveness(survivors),
    ...C.checkAgreement(recs),
    ...survivors.flatMap((r) => C.checkHonors(r)),
    ...survivors.flatMap((r) => C.checkMatchPlay(r)),
    ...C.checkChat(survivors),
    ...C.checkNoErrors(recs, { strict: false }),
  ];
}

const real = (lat, jit, upBps, downBps) => ({
  up: { latencyMs: lat / 2, jitterMs: jit / 2, bytesPerSec: upBps },
  down: { latencyMs: lat / 2, jitterMs: jit / 2, bytesPerSec: downBps },
});

const scenarios = [
  {
    name: "tcp-latency-throttle-short-timeouts",
    async run(t) {
      const { dave, sam } = await setup(t, {
        env: { GOLF_TURN_TIMEOUT_MS: "6000", GOLF_SHOT_TIMEOUT_MS: "3000" },
        links: [real(100, 100, 8000, 12000), real(400, 150, 4000, 5000)],
        seeds: [61, 62],
      });
      await lobby([dave, sam]);
      await Promise.all([finished(dave), finished(sam)]);
      summary(t, [dave, sam]);
      C.assertClean(fullChecks([dave.records(), sam.records()]));
    },
  },
  {
    name: "tcp-slow-uplink-shots-expire",
    // Sam's path frames outrun his uplink: his shotEnd and his pongs queue
    // behind them, so shots expire on the server while his ball still rolls,
    // and his own view stalls on the lag gate while he streams.
    async run(t) {
      const { dave, sam } = await setup(t, {
        env: { GOLF_TURN_TIMEOUT_MS: "8000", GOLF_SHOT_TIMEOUT_MS: "4000" },
        links: [real(80, 40, Infinity, Infinity), real(150, 60, 1200, 20000)],
        seeds: [71, 72],
      });
      await lobby([dave, sam]);
      await Promise.all([finished(dave), finished(sam)]);
      summary(t, [dave, sam]);
      C.assertClean(fullChecks([dave.records(), sam.records()]));
    },
  },
  {
    name: "tcp-stalls-everywhere",
    // Every few seconds one side's link stalls (both directions) for 0.5-7 s:
    // around turns, mid-shot, across hole changes.
    async run(t) {
      const { dave, sam, links } = await setup(t, {
        env: { GOLF_TURN_TIMEOUT_MS: "5000", GOLF_SHOT_TIMEOUT_MS: "3500" },
        links: [real(120, 80, 20000, 20000), real(250, 120, 10000, 10000)],
        seeds: [81, 82],
      });
      let stop = false;
      const rnd = require("./sim-client.js").makeRng(99 + SEED);
      (async () => {
        while (!stop) {
          await sleep(1500 + rnd() * 4000);
          if (stop) break;
          links[Math.floor(rnd() * 2)].stall(500 + rnd() * 6500);
        }
      })();
      t.after(() => (stop = true));
      await lobby([dave, sam]);
      await Promise.all([finished(dave), finished(sam)]);
      stop = true;
      summary(t, [dave, sam]);
      C.assertClean(fullChecks([dave.records(), sam.records()]));
    },
  },
  ...["shotStart", "path", "shotEnd"].map((what) => ({
    name: `tcp-halfopen-after-${what}`,
    // Sam's network dies silently right after his Nth `what` goes out on hole
    // 2: no FIN, no RST. Dave must still see the match through to the end.
    async run(t) {
      const { dave, sam, links } = await setup(t, {
        env: { GOLF_TURN_TIMEOUT_MS: "5000", GOLF_SHOT_TIMEOUT_MS: "4000" },
        links: [real(100, 60, 20000, 20000), real(300, 100, 6000, 9000)],
        seeds: [91, 92],
      });
      const orig = sam.send.bind(sam);
      let cut = false;
      sam.send = (msg) => {
        const r = orig(msg);
        if (!cut && msg?.action === what && sam.match?.hole >= 1) {
          cut = true;
          // Let it reach the server first.
          setTimeout(() => links[1].halfOpen(), 600);
        }
        return r;
      };
      await lobby([dave, sam]);
      await finished(dave);
      summary(t, [dave, sam]);
      const recs = [dave.records(), sam.records()];
      C.assertClean(
        fullChecks(recs, { survivors: [recs[0]] }).filter(
          (x) => !x.startsWith("Sam shot"),
        ),
      );
    },
  })),
];

for (const s of scenarios) {
  if (ONLY && !s.name.includes(ONLY)) continue;
  test(`liveness sims over tcp: ${s.name}`, { timeout: 12 * 60 * 1000 }, (t) =>
    s.run(t),
  );
}
