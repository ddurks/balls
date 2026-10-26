// Contracts 3 (liveness) and 1 (agreement): randomized sim
// matches (real physics) behind byte-level TCP links or the WS chaos proxy,
// with short timeouts, random link settings, and one cut or leave at a random
// moment of the match's life. Pairs that both survive a match play a rematch
// on the same connections (create / join straight from the finished match).
// Every match must reach finished (or a forfeit), each client's views must
// never go back in time, survivors must end on the same view, and each sim's
// shots must agree with what the server recorded.
// Run: node --test test/mp/sim-cut-fuzz.test.js
//   MP_FUZZ_MATCHES (6), MP_FUZZ_SEED (1), MP_FUZZ_PAR (3), MP_TIME_SCALE (8), MP_PORT (any free port)
const test = require("node:test");
const { setTimeout } = require("node:timers");
const { startGolfServer } = require("./server.js");
const { startTcpLink } = require("./tcp-link.js");
const { startChaosProxy } = require("./chaos-proxy.js");
const { lobby } = require("./bot.js");
const { SimClient, makeRng } = require("./sim-client.js");
const C = require("./checks.js");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MATCHES = Number(process.env.MP_FUZZ_MATCHES || 6);
const SEED = Number(process.env.MP_FUZZ_SEED || 1);
const PAR = Number(process.env.MP_FUZZ_PAR || 3);
const TIME_SCALE = Number(process.env.MP_TIME_SCALE || 8);
const PORT = Number(process.env.MP_PORT) || undefined;
const TURN_MS = Number(process.env.MP_TURN_MS || 9000);
const SHOT_MS = Number(process.env.MP_SHOT_MS || 7000);
const LINGER_MS = 30000;

const CUTS = [
  "none",
  "spectating-midshot",
  "own-midpath",
  "after-shotEnd",
  "hole-transition",
  "match-end",
  "leave-own-shot",
  "leave-opp-shot",
  "stall-around-turn",
  "rematch",
];

/** Monotonic views: per code, turnSeq never decreases, holeResults never shrink, phase never goes back. */
function checkMonotonic(rec) {
  const v = [];
  const per = new Map();
  const rank = { playing: 0, finished: 1 };
  for (const s of rec.snaps) {
    const m = s.you?.match;
    if (!m) continue;
    const p = per.get(s.you.matchCode);
    if (
      p &&
      (m.turnSeq < p.turnSeq ||
        m.holeResults.length < p.holeResults.length ||
        rank[m.phase] < rank[p.phase] ||
        m.hole < p.hole)
    )
      v.push(
        `${rec.name}: view went back in ${s.you.matchCode}: ${C.stable({ ...p, turnEndsIn: undefined })} -> ${C.stable({ ...m, turnEndsIn: undefined })}`,
      );
    per.set(s.you.matchCode, m);
  }
  return v;
}

async function mkLink(kind, srv, rand, seed) {
  const lat = 50 + Math.floor(rand() * 350);
  const jit = Math.floor(rand() * 200);
  const down = rand() < 0.4 ? 6000 + Math.floor(rand() * 24000) : Infinity;
  const up = rand() < 0.3 ? 4000 + Math.floor(rand() * 12000) : Infinity;
  if (kind === "tcp") {
    const l = await startTcpLink(srv.url, {
      seed,
      up: { latencyMs: lat / 2, jitterMs: jit / 2, bytesPerSec: up },
      down: { latencyMs: lat / 2, jitterMs: jit / 2, bytesPerSec: down },
    });
    return {
      url: l.url,
      desc: `tcp ${lat}+${jit} up ${up} down ${down}`,
      cut: () => l.reset(),
      stall: (ms) => l.stall(ms),
      close: () => l.close(),
    };
  }
  const p = await startChaosProxy({
    target: srv.url,
    latencyMs: lat,
    jitterMs: jit,
    up: { bytesPerSec: up },
    down: { bytesPerSec: down },
    seed,
  });
  return {
    url: p.url,
    proxy: p,
    desc: `ws ${lat}+${jit} up ${up} down ${down}`,
    cut: () => p.disconnect(null, "fuzz"),
    stall: (ms) => {
      p.set({ latencyMs: ms });
      setTimeout(() => p.set({ latencyMs: lat }), 300);
    },
    close: () => p.close(),
  };
}

// Watch what a sim sends and gets, to cut at a moment of the match's life.
function arm(kind, victim, other, link, rand, log) {
  let fired = false;
  const fire = (why, fn = () => link.cut()) => {
    if (fired) return;
    fired = true;
    log.push(`${victim.name}: ${why} at ${Date.now()}`);
    fn();
  };
  const origSend = victim.send.bind(victim);
  let paths = 0;
  let endSent = false;
  victim.send = (msg) => {
    const r = origSend(msg);
    const a = msg?.action;
    const hole = victim.match?.hole ?? 0;
    if (kind === "own-midpath" && a === "path" && hole >= 1 && ++paths === 4)
      setTimeout(() => fire("cut mid-path"), 100);
    if (kind === "after-shotEnd" && a === "shotEnd" && hole >= 1)
      endSent = true;
    if (kind === "leave-own-shot" && a === "shotStart" && hole >= 1)
      setTimeout(
        () => fire("leave mid own shot", () => victim.leave()),
        200 + rand() * 600,
      );
    return r;
  };
  let lastHole = null;
  const prevSnap = victim.onSnapshot;
  victim.onSnapshot = (b) => {
    const m = b.match;
    if (m) {
      if (
        kind === "spectating-midshot" &&
        m.shotOpen &&
        m.shotOpen.playerId !== b.playerId &&
        m.hole >= 1
      )
        fire("cut while spectating");
      if (
        kind === "leave-opp-shot" &&
        m.shotOpen &&
        m.shotOpen.playerId !== b.playerId &&
        m.hole >= 1
      )
        fire("leave while spectating", () => b.leave());
      if (kind === "after-shotEnd" && endSent) fire("cut after shotEnd");
      if (
        kind === "hole-transition" &&
        lastHole !== null &&
        m.hole !== lastHole
      )
        fire("cut at hole change");
      if (kind === "match-end" && m.phase === "finished")
        fire("cut at match end");
      if (
        kind === "stall-around-turn" &&
        m.phase === "playing" &&
        m.turn === b.playerId &&
        m.hole >= 1 &&
        !fired
      ) {
        fired = true;
        const ms = 2000 + rand() * 9000;
        log.push(`${b.name}: stall ${Math.round(ms)} ms on my turn`);
        link.stall(ms);
      }
      lastHole = m.hole;
    }
    prevSnap(b);
  };
}

const finishedOrClosed = (s, code) =>
  s.until(
    (b) =>
      b.closed ||
      (b.code === code && C.resting(b)) ||
      (b.code !== code && b.sent.some((x) => x.msg?.action === "leave")),
    {
      timeout: 10 * 60 * 1000,
      allowClosed: true,
      label: `${s.name} finished ${code}`,
    },
  );

async function runPair(i, srv, rand) {
  const kinds = [rand() < 0.5 ? "tcp" : "ws", rand() < 0.5 ? "tcp" : "ws"];
  const links = [
    await mkLink(kinds[0], srv, rand, SEED * 1000 + i * 2 + 1),
    await mkLink(kinds[1], srv, rand, SEED * 1000 + i * 2 + 2),
  ];
  const seeds = [SEED * 100 + i * 2 + 1, SEED * 100 + i * 2 + 2];
  const sims = [
    new SimClient(links[0].url, `D${i}`, {
      timeScale: TIME_SCALE,
      seed: seeds[0],
    }),
    new SimClient(links[1].url, `S${i}`, {
      timeScale: TIME_SCALE,
      seed: seeds[1],
    }),
  ];
  const kind = CUTS[(i + SEED) % CUTS.length];
  const vi = Math.floor(rand() * 2);
  const log = [];
  const out = {
    i,
    kind,
    victim: sims[vi].name,
    links: links.map((l) => l.desc),
    log,
    codes: [],
    v: [],
  };
  try {
    await Promise.all(sims.map((s) => s.connect({ timeout: 30000 })));
    if (kind !== "none" && kind !== "rematch")
      arm(kind, sims[vi], sims[1 - vi], links[vi], rand, log);
    const code = await lobby(sims);
    out.codes.push(code);
    await Promise.all(sims.map((s) => finishedOrClosed(s, code)));
    if (kind === "rematch" || kind === "none") {
      // Straight from the finished match: the guest hosts this time.
      sims[1].create();
      const code2 = await sims[1].until(
        (b) => b.code && b.code !== code && b.code,
        { label: "rematch code" },
      );
      sims[0].join(code2);
      await sims[0].until((b) => b.code === code2, { label: "joined rematch" });
      for (const s of sims) s.ready(true);
      await Promise.all(
        sims.map((s) =>
          s.until(
            (x) =>
              x.you?.players?.length === 2 &&
              x.you.players.every((p) => p.ready),
            {
              label: "rematch ready",
            },
          ),
        ),
      );
      sims[1].start();
      await Promise.all(sims.map((s) => s.untilPhase("playing")));
      out.codes.push(code2);
      await Promise.all(sims.map((s) => finishedOrClosed(s, code2)));
    }
  } catch (e) {
    out.v.push(`error ${e.stack || e}`);
  }
  await sleep(1500);
  const recs = sims.map((s) => s.records());
  const tag = `pair ${i} [${kind}, victim ${out.victim}, ${out.links.join(" | ")}]`;
  for (const code of out.codes) {
    const alive = sims.filter(
      (s, k) =>
        !s.closed &&
        !(kind.startsWith("leave") && k === vi) &&
        C.views(s.records(), code).length,
    );
    const ar = alive.map((s) => s.records());
    // A cut sim's records stop at the cut: its open shot has no answer.
    const shotsOk = (r, k) => {
      const s = sims[k];
      const cutAt =
        s.closeInfo?.at ??
        s.sent.find((x) => x.msg?.action === "leave")?.at ??
        Infinity;
      return {
        ...r,
        shots: (r.shots || []).filter(
          (x) => x.endSentAt != null && x.endSentAt < cutAt - 1500,
        ),
      };
    };
    const vrecs = recs.map(shotsOk);
    out.v.push(
      ...[
        ...C.checkLiveness(ar, { code }),
        ...C.checkAgreement(vrecs, { code }),
        ...ar.flatMap((r) => C.checkHonors(r, { code })),
        ...ar.flatMap((r) => C.checkMatchPlay(r, { code })),
      ].map((x) => `${tag} ${code}: ${x}`),
    );
    if (ar.length === 2) {
      const last = ar.map((r) => {
        const vs = C.views(r, code);
        return C.stable({ ...vs[vs.length - 1].m, turnEndsIn: undefined });
      });
      if (last[0] !== last[1])
        out.v.push(
          `${tag} ${code}: final views differ\n  ${last[0]}\n  ${last[1]}`,
        );
    }
  }
  for (const r of recs) {
    out.v.push(...checkMonotonic(r).map((x) => `${tag}: ${x}`));
    for (const e of r.errors) out.v.push(`${tag}: ${r.name} sim error ${e}`);
    for (const o of r.other)
      if (o.msg?.t === "err")
        out.v.push(`${tag}: ${r.name} server error ${JSON.stringify(o.msg)}`);
  }
  out.summary = recs.map((r) =>
    out.codes
      .map((code) => {
        const vs = C.views(r, code);
        const m = vs[vs.length - 1]?.m;
        return `${r.name}@${code}: ${m?.phase} ${m?.result?.text ?? ""} [${(m?.holeResults ?? []).map((h) => h.reason).join(",")}]`;
      })
      .join("; "),
  );
  for (const s of sims) s.dispose();
  for (const l of links) await l.close();
  return out;
}

test(
  "sim fuzz: randomized sim matches under chaos, cuts and rematches",
  { timeout: 60 * 60 * 1000 },
  async (t) => {
    const srv = await startGolfServer({
      port: PORT,
      env: {
        GOLF_TURN_TIMEOUT_MS: String(TURN_MS),
        GOLF_SHOT_TIMEOUT_MS: String(SHOT_MS),
        GOLF_FINISHED_LINGER_MS: String(LINGER_MS),
      },
    });
    t.after(() => srv.stop());
    const rand = makeRng(SEED);
    const results = [];
    let next = 0;
    await Promise.all(
      Array.from({ length: PAR }, async () => {
        while (next < MATCHES) {
          const i = next++;
          const r = await runPair(
            i,
            srv,
            makeRng(Math.floor(rand() * 1e9) + i),
          );
          results.push(r);
          t.diagnostic(
            `pair ${r.i} ${r.kind} victim ${r.victim} | ${r.links.join(" | ")} | ${r.summary.join(" || ")} | ${r.log.join("; ")}`,
          );
        }
      }),
    );
    C.assertClean(
      results.flatMap((r) => r.v),
      "sim cut fuzz",
    );
  },
);
