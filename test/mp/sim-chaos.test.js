// Contracts 3 (liveness) and 1 (agreement) with real physics under chaos.
// Two sim clients, each behind its own chaos proxy, play whole matches with
// short turn and shot timeouts, through latency spikes, uplink and downlink
// stalls (TCP holds the bytes and delivers them late, in order) and cuts at
// chosen moments. Every match must finish (or be forfeited) and the
// survivors' views and shots must agree with the server.
// Run: node --test test/mp/sim-chaos.test.js
//   MP_ONLY=<scenario name substring> runs a subset; MP_TIME_SCALE (8).
const test = require("node:test");
const { setTimeout } = require("node:timers");
const { startGolfServer } = require("./server.js");
const { startChaosProxy } = require("./chaos-proxy.js");
const { lobby } = require("./bot.js");
const { SimClient } = require("./sim-client.js");
const C = require("./checks.js");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const TIME_SCALE = Number(process.env.MP_TIME_SCALE || 8);
const ONLY = process.env.MP_ONLY || "";
const BASE_PORT = Number(process.env.MP_PORT) || undefined;

async function setup(
  t,
  { port, env, chaos = [{}, {}], seeds = [1, 2], sim = {} },
) {
  const srv = await startGolfServer({
    port,
    env: { GOLF_FINISHED_LINGER_MS: "60000", ...env },
  });
  t.after(() => srv.stop());
  const proxies = [];
  for (const [i, c] of chaos.entries()) {
    const p = await startChaosProxy({ target: srv.url, seed: 100 + i, ...c });
    proxies.push(p);
    t.after(() => p.close());
  }
  const dave = new SimClient(proxies[0].url, "Dave", {
    timeScale: TIME_SCALE,
    seed: seeds[0],
    ...sim,
  });
  const sam = new SimClient(proxies[1].url, "Sam", {
    timeScale: TIME_SCALE,
    seed: seeds[1],
    ...sim,
  });
  t.after(() => {
    dave.dispose();
    sam.dispose();
  });
  await Promise.all([dave.connect(), sam.connect()]);
  return { srv, proxies, dave, sam };
}

const finished = (s, timeout = 12 * 60 * 1000) =>
  s.until((b) => b.you?.phase === "finished" || (b.closed && true), {
    timeout,
    allowClosed: true,
    label: `${b_name(s)} finished`,
  });
const b_name = (s) => s.name;

function summary(t, sims) {
  for (const s of sims) {
    const vs = C.views(s.records());
    const m = vs[vs.length - 1]?.m;
    t.diagnostic(
      `${s.name}: ${m?.phase} ${m?.result?.text ?? ""}; holes ${(
        m?.holeResults ?? []
      )
        .map((r) => `${C.stable(r.strokes)} ${r.reason}`)
        .join(
          " ",
        )}; shots ${s.shots.length}; notices ${s.notices.map((n) => n.text).join(" | ")}`,
    );
  }
}

// Path fidelity (contract 6) is another breaker's ground: here only a loose
// bound, and none at all across deliberate stalls.
function fullChecks(recs, { survivors = recs, paths = true } = {}) {
  const lastShot = (rec) => rec.shots?.[rec.shots.length - 1];
  return [
    ...C.checkLiveness(survivors),
    ...C.checkAgreement(recs),
    ...recs.flatMap((r) => C.checkHonors(r)),
    ...recs.flatMap((r) => C.checkMatchPlay(r)),
    ...C.checkChat(recs),
    ...C.checkNoErrors(recs, { strict: false }),
    ...(recs.length === 2 && paths
      ? [
          ...C.checkPathFidelity(recs[0], recs[1], {
            requireComplete: false,
            maxDelayMs: 5000,
            shots: (s) => s !== lastShot(recs[0]),
          }),
          ...C.checkPathFidelity(recs[1], recs[0], {
            requireComplete: false,
            maxDelayMs: 5000,
            shots: (s) => s !== lastShot(recs[1]),
          }),
        ]
      : []),
  ];
}

const scenarios = [
  {
    name: "chaos-short-timeouts",
    // 50-400 ms both ways, a throttled downlink for Sam; shots that run long
    // time out, idle stretches concede.
    async run(t, port) {
      const { dave, sam } = await setup(t, {
        port,
        env: { GOLF_TURN_TIMEOUT_MS: "6000", GOLF_SHOT_TIMEOUT_MS: "3000" },
        chaos: [
          { latencyMs: 50, jitterMs: 200 },
          { latencyMs: 150, jitterMs: 250, down: { bytesPerSec: 9000 } },
        ],
        seeds: [11, 12],
      });
      await lobby([dave, sam]);
      await Promise.all([finished(dave), finished(sam)]);
      summary(t, [dave, sam]);
      C.assertClean(fullChecks([dave.records(), sam.records()]));
    },
  },
  {
    name: "expiring-shots",
    // The shot timeout is shorter than many real shots, so a good share of
    // them expire on the server while the shooter's ball is still rolling.
    async run(t, port) {
      const seed = Number(process.env.MP_SEED || 51);
      const { dave, sam } = await setup(t, {
        port,
        env: {
          GOLF_TURN_TIMEOUT_MS: "5000",
          GOLF_SHOT_TIMEOUT_MS: process.env.MP_SHOT_MS || "1500",
        },
        chaos: [
          { latencyMs: 50, jitterMs: 350 },
          { latencyMs: 200, jitterMs: 200, down: { bytesPerSec: 12000 } },
        ],
        seeds: [seed, seed + 1],
      });
      await lobby([dave, sam]);
      await Promise.all([finished(dave), finished(sam)]);
      summary(t, [dave, sam]);
      const recs = [dave.records(), sam.records()];
      const out = recs.flatMap((r) =>
        r.shots.map((s) => C.shotOutcome(r, s).outcome),
      );
      t.diagnostic(`outcomes: ${JSON.stringify(out)}`);
      C.assertClean(fullChecks(recs, { paths: false }));
    },
  },
  {
    name: "uplink-stall-midshot",
    // Sam's uplink stalls for longer than the shot timeout on each of his
    // first shots: shotStart lands, then path and shotEnd arrive late.
    async run(t, port) {
      const { dave, sam, proxies } = await setup(t, {
        port,
        env: { GOLF_TURN_TIMEOUT_MS: "15000", GOLF_SHOT_TIMEOUT_MS: "4000" },
        chaos: [
          { latencyMs: 60, jitterMs: 60 },
          { latencyMs: 80, jitterMs: 80 },
        ],
        seeds: [21, 22],
      });
      let stalls = 0;
      proxies[1].onMessage(({ dir, json }) => {
        if (dir === "up" && json?.action === "shotStart" && stalls < 3) {
          stalls++;
          setTimeout(() => proxies[1].set({ up: { latencyMs: 6500 } }), 50);
          setTimeout(() => proxies[1].set({ up: { latencyMs: 80 } }), 400);
        }
        return undefined;
      });
      await lobby([dave, sam]);
      await Promise.all([finished(dave), finished(sam)]);
      summary(t, [dave, sam]);
      C.assertClean(
        fullChecks([dave.records(), sam.records()], { paths: false }),
      );
    },
  },
  {
    name: "downlink-stall",
    // Sam's downlink stalls 9 s, three times: his view is stale while the
    // server moves on (his turn can run out, Dave plays on).
    async run(t, port) {
      const { dave, sam, proxies } = await setup(t, {
        port,
        env: { GOLF_TURN_TIMEOUT_MS: "7000", GOLF_SHOT_TIMEOUT_MS: "15000" },
        chaos: [
          { latencyMs: 60, jitterMs: 60 },
          { latencyMs: 120, jitterMs: 120 },
        ],
        seeds: [31, 32],
      });
      await lobby([dave, sam]);
      for (let i = 0; i < 3; i++) {
        await sleep(4000 + i * 3000);
        if (dave.you?.phase !== "playing") break;
        proxies[1].set({ down: { latencyMs: 9000 } });
        await sleep(400);
        proxies[1].set({ down: { latencyMs: 120 } });
      }
      await Promise.all([finished(dave), finished(sam)]);
      summary(t, [dave, sam]);
      C.assertClean(
        fullChecks([dave.records(), sam.records()], { paths: false }),
      );
    },
  },
  ...[
    [
      "cut-lobby-ready",
      ({ dir, json }) => dir === "up" && json?.action === "ready",
    ],
    [
      "cut-after-shotStart",
      ({ dir, json }, sam) =>
        dir === "down" && json?.you?.match?.shotOpen?.playerId === sam.playerId,
    ],
    [
      "cut-before-shotEnd",
      ({ dir, json }) => dir === "up" && json?.action === "shotEnd",
    ],
    [
      "cut-after-shotEnd",
      // shotEnd has gone up; cut on the next message down.
      (() => {
        let sent = false;
        return ({ dir, json }) => {
          if (dir === "up" && json?.action === "shotEnd") sent = true;
          return sent && dir === "down";
        };
      })(),
    ],
    [
      "cut-hole-transition",
      (() => {
        let hole = null;
        return ({ dir, json }) => {
          const m = dir === "down" ? json?.you?.match : null;
          if (!m) return false;
          const hit = hole !== null && m.hole !== hole;
          hole = m.hole;
          return hit;
        };
      })(),
    ],
    [
      "cut-match-end",
      ({ dir, json }) =>
        dir === "down" && json?.you?.match?.phase === "finished",
    ],
  ].map(([name, pred]) => ({
    name,
    async run(t, port) {
      const { dave, sam, proxies } = await setup(t, {
        port,
        env: { GOLF_TURN_TIMEOUT_MS: "20000", GOLF_SHOT_TIMEOUT_MS: "15000" },
        chaos: [
          { latencyMs: 100, jitterMs: 150 },
          { latencyMs: 250, jitterMs: 150, down: { bytesPerSec: 20000 } },
        ],
        seeds: [41, 42],
      });
      const cut = proxies[1].disconnectWhen((m) => pred(m, sam));
      if (name === "cut-lobby-ready") {
        dave.create();
        const code = await dave.untilMatch();
        sam.join(code);
        await sam.untilMatch();
        sam.ready(true);
        await cut;
        await dave.until((b) => b.you?.players?.length === 1, {
          label: "Sam gone from the lobby",
        });
        t.diagnostic(`lobby after cut: ${JSON.stringify(dave.you)}`);
        return;
      }
      await lobby([dave, sam]);
      await finished(dave);
      await sleep(500);
      summary(t, [dave, sam]);
      // Sam's records stop at the cut: a shot he was playing then has no
      // server answer, which is the cut, not a disagreement.
      const samRec = sam.records();
      const cutAt = samRec.closeInfo?.at ?? Infinity;
      samRec.shots = samRec.shots.filter(
        (s) => s.endSentAt != null && s.endSentAt < cutAt - 1000,
      );
      const recs = [dave.records(), samRec];
      // Sam stops receiving at the cut, so only his shots, as Dave saw them.
      C.assertClean([
        ...fullChecks(recs, { survivors: [recs[0]], paths: false }),
        ...C.checkPathFidelity(recs[1], recs[0], {
          requireComplete: false,
          maxDelayMs: 5000,
        }),
      ]);
      const m = dave.match;
      if (
        name !== "cut-match-end" &&
        m.result.reason === "forfeit" &&
        m.result.winner !== dave.playerId
      )
        throw new Error(`forfeit won by ${m.result.winner}`);
    },
  })),
];

for (const [i, s] of scenarios.entries()) {
  if (ONLY && !s.name.includes(ONLY)) continue;
  test(`liveness sims: ${s.name}`, { timeout: 15 * 60 * 1000 }, (t) =>
    s.run(t, BASE_PORT && BASE_PORT + (i % 8)),
  );
}
