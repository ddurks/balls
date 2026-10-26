// Contracts 3 and 1, randomized, with real physics: several sim matches at
// once on one server, each player behind a chaos proxy with random latency
// (50-400 ms), jitter, sometimes a throttled downlink, random latency spikes
// (stalls that TCP would deliver late), short turn and shot timeouts, and in
// some matches one player cut at a random moment. Every match must finish;
// both players (or the survivor) must agree with the server.
// Run: node --test test/mp/sim-fuzz.test.js
//   MP_SEED (default 2), MP_SIMS (matches, default 3), MP_TIME_SCALE (8)
const test = require("node:test");
const { setTimeout } = require("node:timers");
const { startGolfServer } = require("./server.js");
const { startChaosProxy } = require("./chaos-proxy.js");
const { lobby } = require("./bot.js");
const { SimClient, makeRng } = require("./sim-client.js");
const C = require("./checks.js");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// MP_SEED=1 tripped the kit race in sim-stale-lookahead.test.js.
const SEED = Number(process.env.MP_SEED || 2);
const N = Number(process.env.MP_SIMS || 3);
const TIME_SCALE = Number(process.env.MP_TIME_SCALE || 8);
const PORT = Number(process.env.MP_PORT) || undefined;

async function one(i, srv, rand, t) {
  const mk = async (k) => {
    const lat = 50 + Math.floor(rand() * 300);
    return startChaosProxy({
      target: srv.url,
      latencyMs: lat,
      jitterMs: Math.floor(rand() * Math.min(150, 400 - lat)),
      down: {
        bytesPerSec:
          rand() < 0.3 ? 10000 + Math.floor(rand() * 20000) : Infinity,
      },
      seed: SEED * 100 + i * 2 + k,
    });
  };
  const proxies = [await mk(0), await mk(1)];
  const sims = [
    new SimClient(proxies[0].url, `D${i}`, {
      timeScale: TIME_SCALE,
      seed: SEED * 1000 + i * 2,
    }),
    new SimClient(proxies[1].url, `S${i}`, {
      timeScale: TIME_SCALE,
      seed: SEED * 1000 + i * 2 + 1,
    }),
  ];
  const cut = rand() < 0.5 ? Math.floor(rand() * 2) : null;
  const cutAfterMs = 3000 + rand() * 40000;
  const info = { i, cut, cutAfterMs: Math.round(cutAfterMs), spikes: 0 };
  try {
    await Promise.all(sims.map((s) => s.connect()));
    await lobby(sims);
    const t0 = Date.now();
    let stop = false;
    // Latency spikes: one side's link stalls 1-6 s now and then.
    const spiker = (async () => {
      while (!stop) {
        await sleep(2000 + rand() * 6000);
        if (stop) break;
        const k = Math.floor(rand() * 2);
        const dir = rand() < 0.5 ? "up" : "down";
        const was = proxies[k].cfg[dir].latencyMs;
        proxies[k].set({ [dir]: { latencyMs: 1000 + rand() * 5000 } });
        await sleep(200);
        proxies[k].set({ [dir]: { latencyMs: was } });
        info.spikes++;
      }
    })();
    if (cut !== null)
      setTimeout(() => {
        info.cutAt = Date.now() - t0;
        proxies[cut].disconnect(null, "fuzz cut");
      }, cutAfterMs);
    await Promise.all(
      sims.map((s) =>
        s.until((b) => b.closed || C.resting(b), {
          timeout: 12 * 60 * 1000,
          allowClosed: true,
          label: "finished",
        }),
      ),
    );
    stop = true;
    await spiker;
  } catch (e) {
    info.error = String(e.stack || e);
  }
  return { info, sims, proxies };
}

test(
  "sim fuzz: chaos, stalls and cuts never leave a match unfinished or out of agreement",
  { timeout: 20 * 60 * 1000 },
  async (t) => {
    const srv = await startGolfServer({
      port: PORT,
      env: {
        GOLF_TURN_TIMEOUT_MS: "8000",
        GOLF_SHOT_TIMEOUT_MS: "4000",
        GOLF_FINISHED_LINGER_MS: "120000",
      },
    });
    t.after(() => srv.stop());
    const rand = makeRng(SEED);
    const runs = await Promise.all(
      Array.from({ length: N }, (_, i) => one(i, srv, rand, t)),
    );
    const v = [];
    for (const { info, sims, proxies } of runs) {
      const tag = `match ${info.i} ${JSON.stringify(info)}`;
      if (info.error) v.push(`${tag}: ${info.error}`);
      const recs = sims.map((s) => s.records());
      const alive = sims.map((s) => !s.closed);
      const code = C.lastCode(recs[0]) ?? C.lastCode(recs[1]);
      // A cut player's records stop at the cut: drop the shot it was in.
      for (const r of recs) {
        const at = r.closeInfo?.at ?? Infinity;
        r.shots = r.shots.filter(
          (s) => s.endSentAt != null && s.endSentAt < at - 2000,
        );
      }
      const survivors = recs.filter((_, k) => alive[k]);
      v.push(
        ...C.checkLiveness(survivors, { code }).map((x) => `${tag}: ${x}`),
      );
      v.push(...C.checkAgreement(recs, { code }).map((x) => `${tag}: ${x}`));
      for (const r of survivors) {
        v.push(...C.checkHonors(r, { code }).map((x) => `${tag}: ${x}`));
        v.push(...C.checkMatchPlay(r, { code }).map((x) => `${tag}: ${x}`));
      }
      v.push(...C.checkChat(recs, { code }).map((x) => `${tag}: ${x}`));
      v.push(
        ...C.checkNoErrors(recs, { strict: false }).map((x) => `${tag}: ${x}`),
      );
      const last = (r) => {
        const vs = C.views(r, code);
        return vs[vs.length - 1]?.m;
      };
      if (survivors.length === 2) {
        const [a, b] = survivors.map((r) =>
          C.stable({ ...last(r), turnEndsIn: undefined }),
        );
        if (a !== b) v.push(`${tag}: final views differ`);
      }
      t.diagnostic(
        `${tag}: ${sims.map((s) => `${s.name}${s.closed ? "(cut)" : ""} ${last(s.records())?.result?.text ?? last(s.records())?.phase}`).join(", ")}; shots ${sims.map((s) => s.shots.length).join("/")}; outcomes ${recs
          .flatMap((r) =>
            r.shots.map((s) => (C.shotOutcome(r, s).outcome ?? "-")[0]),
          )
          .join("")}`,
      );
      sims.forEach((s) => s.dispose());
      await Promise.all(proxies.map((p) => p.close()));
    }
    C.assertClean(v, "sim fuzz");
  },
);
