// Contracts 4, 5, 7, 8, 9 at once: three sim-client matches (real physics,
// real holes, streamed paths) in parallel on one server, one player of each
// behind its own chaos proxy (latency, jitter, a slow downlink), plus
// protocol-bot matches chatting and streaming alongside. Every sim match is
// audited (honors, match play, agreement, chat, shared conditions, path
// fidelity) and nothing may cross between any of the matches.
// Run: node --test test/mp/parallel-sims.test.js
//   (MP_PAR_SIMS=3 MP_PAR_BOTS=8 MP_TIME_SCALE=8)
const test = require("node:test");
const { setTimeout } = require("node:timers");
const { startGolfServer } = require("./server.js");
const { startChaosProxy } = require("./chaos-proxy.js");
const { setupMatch, fakeShot, lobby } = require("./bot.js");
const { SimClient } = require("./sim-client.js");
const C = require("./checks.js");

const SIMS = Number(process.env.MP_PAR_SIMS || 3);
const BOTS = Number(process.env.MP_PAR_BOTS || 8);
const TS = Number(process.env.MP_TIME_SCALE || 8);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function playFake(bots, i, until) {
  const host = bots[0];
  let n = 0;
  while (host.you?.phase === "playing" && !until()) {
    const me = bots.find((b) => b.isMyTurn());
    if (!me) {
      await host.nextSnapshot();
      continue;
    }
    const before = C.stable(me.match.lies);
    fakeShot(me, { fraction: 0.55, frames: 6 });
    if (++n % 3 === 0) me.mchat(`bot match ${i} line ${n} bq${i}x${n}`);
    await me.until(
      (b) =>
        b.you?.phase !== "playing" ||
        C.stable(b.match.lies) !== before ||
        b.notices.length,
      { timeout: 15000 },
    );
    await sleep(400);
  }
}

test(
  `${SIMS} sim matches + ${BOTS} bot matches in parallel`,
  { timeout: 40 * 60 * 1000 },
  async (t) => {
    const srv = await startGolfServer({
      env: { GOLF_FINISHED_LINGER_MS: "60000", GOLF_TURN_TIMEOUT_MS: "120000" },
    });
    const cleanup = [];
    t.after(async () => {
      for (const f of cleanup.reverse()) await f();
      await srv.stop();
    });
    const sims = [];
    for (let i = 0; i < SIMS; i++) {
      const proxy = await startChaosProxy({
        target: srv.url,
        latencyMs: 80 + 60 * i,
        jitterMs: 50,
        down: { bytesPerSec: 30000 },
        seed: 100 + i,
      });
      cleanup.push(() => proxy.close());
      const a = new SimClient(srv.url, `Dave${i}`, {
        timeScale: TS,
        seed: 10 + i,
      });
      const b = new SimClient(proxy.url, `Sam${i}`, {
        timeScale: TS,
        seed: 20 + i,
      });
      cleanup.push(() => {
        a.dispose();
        b.dispose();
      });
      sims.push([a, b]);
    }
    await Promise.all(sims.flat().map((s) => s.connect()));
    for (const [i, pair] of sims.entries()) {
      await lobby(pair, { start: false });
      pair[1].mchat(`sim lobby ${i} sl${i}x`);
      pair[0].start();
    }
    await Promise.all(sims.flat().map((s) => s.untilPhase("playing")));
    const botMatches = await Promise.all(
      Array.from({ length: BOTS }, (_, i) =>
        setupMatch(srv.url, [`BD${i}`, `BS${i}`]),
      ),
    );
    cleanup.push(() =>
      botMatches.forEach((m) => m.bots.forEach((b) => b.close())),
    );
    const simsDone = () => sims.every(([a]) => a.you?.phase !== "playing");
    const botRuns = botMatches.map((m, i) => playFake(m.bots, i, simsDone));

    await Promise.all(
      sims.flatMap(([a, b], i) => [
        a.untilPhase("finished", { timeout: 35 * 60 * 1000 }),
        b.untilPhase("finished", { timeout: 35 * 60 * 1000 }),
        a
          .until((x) => x.match?.hole >= 1 || x.you?.phase !== "playing", {
            timeout: 35 * 60 * 1000,
          })
          .then(() => b.mchat(`sim ${i} mid-match sm${i}x`)),
      ]),
    );
    sims.forEach(([a], i) => a.mchat(`sim ${i} gg sg${i}x`));
    await Promise.all(
      sims.map(([, b], i) => b.untilChat(new RegExp(`sg${i}x`))),
    );
    await Promise.all(botRuns);

    const v = [];
    const groups = [];
    for (const [i, [a, b]] of sims.entries()) {
      const recs = [a.records(), b.records()];
      groups.push({ recs });
      const m = a.match;
      t.diagnostic(
        `sim ${i}: ${m.result.text}; ${m.holeResults.map((r) => C.stable(r.strokes)).join(" ")}; shots ${a.shots.length}+${b.shots.length}`,
      );
      v.push(
        ...C.checkNoErrors(recs, { strict: false }).map(
          (x) => `sim ${i}: ${x}`,
        ),
        ...C.checkLiveness(recs).map((x) => `sim ${i}: ${x}`),
        ...C.checkAgreement(recs).map((x) => `sim ${i}: ${x}`),
        ...C.checkHonors(recs[0]).map((x) => `sim ${i}: ${x}`),
        ...C.checkHonors(recs[1]).map((x) => `sim ${i}: ${x}`),
        ...C.checkMatchPlay(recs[0]).map((x) => `sim ${i}: ${x}`),
        ...C.checkMatchPlay(recs[1]).map((x) => `sim ${i}: ${x}`),
        ...C.checkChat(recs).map((x) => `sim ${i}: ${x}`),
        ...C.checkSharedConditions(recs).map((x) => `sim ${i}: ${x}`),
        ...C.checkPathFidelity(recs[0], recs[1], {
          requireComplete: false,
        }).map((x) => `sim ${i}: ${x}`),
        ...C.checkPathFidelity(recs[1], recs[0], {
          requireComplete: false,
        }).map((x) => `sim ${i}: ${x}`),
      );
      for (const r of recs)
        for (const n of r.notices)
          v.push(`sim ${i}: ${r.name} notice "${n.text}"`);
    }
    for (const [i, m] of botMatches.entries()) {
      const recs = m.bots.map((b) => b.records());
      groups.push({ code: m.code, recs });
      v.push(
        ...C.checkChat(recs, { code: m.code }).map((x) => `bots ${i}: ${x}`),
      );
    }
    v.push(...C.checkIsolation(groups));
    C.assertClean(v, "parallel sims");
  },
);
