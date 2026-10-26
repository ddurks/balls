// Contracts 3 (liveness) and 1 (agreement), randomized, with
// protocol bots behind byte-level TCP links the server can feel (latency and
// jitter both ways, throttled up- and downlinks, stalls), so its ping-timed
// lag gate and backlog gate are in play. Cuts are a TCP reset or a silent
// half-open link, at every moment of a match's life.
// Run: node --test test/mp/tcp-fuzz.test.js
//   MP_FUZZ_MATCHES (default 32), MP_FUZZ_SEED (default 1)
const test = require("node:test");
const { setTimeout } = require("node:timers");
const { startGolfServer } = require("./server.js");
const { startTcpLink } = require("./tcp-link.js");
const { Bot, lobby } = require("./bot.js");
const { holeById, CLUB_MAX } = require("./holes.js");
const { makeRng } = require("./sim-client.js");
const C = require("./checks.js");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MATCHES = Number(process.env.MP_FUZZ_MATCHES || 32);
const SEED = Number(process.env.MP_FUZZ_SEED || 1);
const PORT = Number(process.env.MP_PORT) || undefined;
const TURN_MS = Number(process.env.MP_TURN_MS || 3000);
const SHOT_MS = Number(process.env.MP_SHOT_MS || 2500);
// Results stay up this long before a finished match is freed. A client on
// the slowest link here (900 B/s down) can see the match seconds late (the lag
// gate bounds it at ~7 s at 600 B/s), so a shorter linger can free the match
// before its last view, the result, ever reaches that client.
const LINGER_MS = 12000;
// A half-open socket leaves its seat once its pings go unanswered this long,
// well past what the slowest link here takes to answer one (stalls included).
const PING_TIMEOUT_MS = 20000;

const CUTS = [
  "none",
  "lobby-reset",
  "my-turn-reset",
  "my-turn-halfopen",
  "after-shotStart-reset",
  "after-shotStart-halfopen",
  "path-no-shotEnd-reset",
  "hole-change-reset",
  "match-end-reset",
  "stall-past-turn",
  "stall-mid-shot",
  "leave-mid-shot",
  "both-reset",
  "both-halfopen-playing",
  "none-slow",
];

function drive(bot, rand, log, hooks) {
  let acted = null;
  bot.onSnapshot = () => {
    hooks.onSnap?.(bot);
    if (!bot.isMyTurn()) return;
    const m = bot.match;
    if (acted === m.turnSeq) return;
    acted = m.turnSeq;
    const r = rand();
    const turnSeq = m.turnSeq;
    if (r < 0.08) {
      log.push(`${bot.name} idles turn ${turnSeq}`);
      return;
    }
    const from = m.lies[bot.playerId].pos ?? holeById(m.holeId).tee;
    const pin = m.pin;
    const d = Math.hypot(pin.x - from.x, pin.z - from.z);
    const holed = d <= 3;
    const f = holed ? 1 : 0.4 + rand() * 0.4;
    const rest = {
      x: from.x + (pin.x - from.x) * f,
      y: from.y + (pin.y - from.y) * f,
      z: from.z + (pin.z - from.z) * f,
    };
    const reach = Math.hypot(rest.x - from.x, rest.z - from.z);
    const fits = CLUB_MAX.findIndex((x) => x >= reach);
    bot.shotStart(
      fits < 0 ? 12 : fits,
      Math.atan2(pin.x - from.x, -(pin.z - from.z)),
      turnSeq,
    );
    hooks.onShotStart?.(bot);
    if (r < 0.14) {
      log.push(`${bot.name} abandons shot turn ${turnSeq}`);
      return;
    }
    const frames = 2 + Math.floor(rand() * 20);
    const gap = rand() * 1200;
    (async () => {
      for (let i = 1; i <= frames; i++) {
        const k = i / frames;
        bot.path([
          [
            0.05 * i,
            from.x + (rest.x - from.x) * k,
            from.y + (rest.y - from.y) * k + Math.sin(k * Math.PI) * 20,
            from.z + (rest.z - from.z) * k,
            0,
            0,
            0,
            1,
          ],
        ]);
        if (gap) await sleep(gap / frames);
      }
      if (hooks.beforeShotEnd?.(bot)) return;
      bot.shotEnd(rest, holed, 0);
    })();
  };
}

const KINDS = process.env.MP_KINDS ? process.env.MP_KINDS.split(",") : CUTS;

async function runMatch(i, srv, rand) {
  const kind = KINDS[i % KINDS.length];
  const lat = () => 50 + Math.floor(rand() * 350);
  const jit = () => Math.floor(rand() * 150);
  const pick = (xs) => xs[Math.floor(rand() * xs.length)];
  const slow = kind === "none-slow";
  const linkCfg = () => ({
    up: {
      latencyMs: lat() / 2,
      jitterMs: jit() / 2,
      bytesPerSec: slow ? pick([1500, 3000]) : pick([Infinity, 8000, 3000]),
    },
    down: {
      latencyMs: lat() / 2,
      jitterMs: jit() / 2,
      bytesPerSec: slow
        ? pick([900, 1500, 2500])
        : pick([Infinity, 20000, 6000, 2500]),
    },
    seed: i * 7 + 1,
  });
  const cfgs = [linkCfg(), linkCfg()];
  const links = [
    await startTcpLink(srv.url, cfgs[0]),
    await startTcpLink(srv.url, cfgs[1]),
  ];
  const bots = [new Bot(links[0].url, `H${i}`), new Bot(links[1].url, `G${i}`)];
  const victimIx = Math.floor(rand() * 2);
  const victim = bots[victimIx];
  const vlink = links[victimIx];
  const log = [];
  const out = { i, kind, victimIx, cfgs, log, bots, links, cut: null };
  const cut = (how, why) => {
    if (out.cut) return;
    out.cut = { how, why, at: Date.now() };
    if (how === "reset") vlink.reset();
    else if (how === "halfopen") vlink.halfOpen();
  };
  const hooks = bots.map(() => ({}));
  const vh = hooks[victimIx];
  let lastHole = null;
  switch (kind) {
    case "my-turn-reset":
    case "my-turn-halfopen":
      vh.onSnap = (b) => {
        if (b.isMyTurn() && b.match.hole >= 1)
          cut(kind.endsWith("reset") ? "reset" : "halfopen", "my turn");
      };
      break;
    case "after-shotStart-reset":
    case "after-shotStart-halfopen":
      vh.onShotStart = (b) => {
        if (b.match.hole >= 0 && rand() < 0.5)
          // Long enough for shotStart to land, before shotEnd goes.
          setTimeout(
            () =>
              cut(kind.endsWith("reset") ? "reset" : "halfopen", "shot open"),
            900,
          );
      };
      break;
    case "path-no-shotEnd-reset":
      vh.beforeShotEnd = () => {
        if (rand() < 0.5) return false;
        setTimeout(() => cut("reset", "path sent, no shotEnd"), 700);
        return true;
      };
      break;
    case "hole-change-reset":
      vh.onSnap = (b) => {
        const m = b.match;
        if (
          m &&
          lastHole !== null &&
          m.hole !== lastHole &&
          m.phase === "playing"
        )
          cut("reset", "hole change");
        if (m) lastHole = m.hole;
      };
      break;
    case "match-end-reset":
      vh.onSnap = (b) => {
        if (b.match?.phase === "finished") cut("reset", "match end");
      };
      break;
    case "stall-past-turn":
      vh.onSnap = (b) => {
        if (b.isMyTurn() && !out.stalled) {
          out.stalled = true;
          vlink.stall(TURN_MS + 1500);
        }
      };
      break;
    case "stall-mid-shot":
      vh.onShotStart = () => {
        if (out.stalled) return;
        out.stalled = true;
        setTimeout(() => vlink.stall(SHOT_MS + 1500), 300);
      };
      break;
    case "leave-mid-shot":
      vh.onShotStart = (b) => {
        if (rand() < 0.4) setTimeout(() => b.leave(), 500);
      };
      break;
  }
  try {
    await Promise.all(bots.map((b) => b.connect({ timeout: 20000 })));
    bots.forEach((b, k) =>
      drive(b, makeRng(Math.floor(rand() * 1e9)), log, hooks[k]),
    );
    if (kind === "lobby-reset") {
      setTimeout(() => cut("reset", "lobby"), 200 + rand() * 1500);
    }
    if (kind === "both-reset") {
      setTimeout(() => links.forEach((l) => l.reset()), 2000 + rand() * 8000);
      out.cut = { how: "reset", why: "both" };
    }
    if (kind === "both-halfopen-playing") {
      out.cut = { how: "halfopen", why: "both" };
    }
    try {
      await lobby(bots);
    } catch (e) {
      out.lobbyError = String(e.message);
      return out;
    }
    if (kind === "both-halfopen-playing")
      setTimeout(
        () => links.forEach((l) => l.halfOpen()),
        1000 + rand() * 6000,
      );
    // A half-open bot never hears another word, so poll rather than wait on
    // its messages.
    const latched = new Set();
    const done = (x, k) => latched.has(k) || (isDone(x, k) && latched.add(k));
    const isDone = (x, k) =>
      x.closed ||
      x.you?.phase === "finished" ||
      (out.cut &&
        out.cut.how === "halfopen" &&
        (k === victimIx || out.cut.why === "both")) ||
      (kind === "leave-mid-shot" &&
        k === victimIx &&
        x.sent.some((m) => m.msg?.action === "leave"));
    const deadline = Date.now() + 120000;
    while (bots.map(done).includes(false) && Date.now() < deadline)
      await sleep(100);
    bots.forEach((b, k) => {
      if (!done(b, k))
        out.stuck = (out.stuck || []).concat(
          `${b.name}: not finished after 120 s`,
        );
    });
  } catch (e) {
    out.error = String(e.stack || e);
  }
  return out;
}

async function rawSnapshot(url) {
  const b = new Bot(url, "Probe");
  await b.connect();
  let snap;
  b.ws.on("message", (d) => {
    const m = JSON.parse(d.toString());
    if (m.t === "gameSnapshot") snap = m;
  });
  await sleep(400);
  b.close();
  return snap;
}

test(
  "tcp fuzz: every match reaches finished under real-link chaos and cuts",
  { timeout: 20 * 60 * 1000 },
  async (t) => {
    const srv = await startGolfServer({
      port: PORT,
      env: {
        GOLF_TURN_TIMEOUT_MS: String(TURN_MS),
        GOLF_SHOT_TIMEOUT_MS: String(SHOT_MS),
        GOLF_FINISHED_LINGER_MS: String(LINGER_MS),
        GOLF_PING_TIMEOUT_MS: String(PING_TIMEOUT_MS),
      },
    });
    t.after(() => srv.stop());
    const rand = makeRng(SEED);
    const runs = await Promise.all(
      Array.from({ length: MATCHES }, (_, i) => runMatch(i, srv, rand)),
    );
    const v = [];
    const counts = {};
    for (const r of runs) {
      const tag = `match ${r.i} [${r.kind}, victim ${r.bots[r.victimIx].name}, cut ${JSON.stringify(r.cut)}, links ${JSON.stringify(r.cfgs.map((c) => [c.up.bytesPerSec, c.down.bytesPerSec]))}]`;
      if (r.error) v.push(`${tag}: error ${r.error}`);
      if (r.stuck) v.push(`${tag}: stuck ${r.stuck.join("; ")}`);
      const recs = r.bots.map((b) => b.records());
      const cutIx = new Set();
      if (r.cut) {
        if (r.cut.why === "both") cutIx.add(0).add(1);
        else cutIx.add(r.victimIx);
      }
      if (
        r.kind === "leave-mid-shot" &&
        r.bots[r.victimIx].sent.some((m) => m.msg?.action === "leave")
      )
        cutIx.add(r.victimIx);
      const lastView = (b) => {
        const vs = C.views(b.records(), C.lastCode(b.records()));
        return vs[vs.length - 1]?.m ?? null;
      };
      const alive = r.bots.filter((b, k) => !cutIx.has(k) && !b.closed);
      for (const b of alive) {
        const m = lastView(b);
        if (r.lobbyError && !m) continue;
        if (!m || m.phase !== "finished" || !m.result)
          v.push(
            `${tag}: ${b.name} alive but view phase ${m?.phase} result ${JSON.stringify(m?.result)}`,
          );
      }
      const code = r.bots.map((b) => C.lastCode(b.records())).find(Boolean);
      if (code && !r.lobbyError) {
        v.push(...C.checkAgreement(recs, { code }).map((x) => `${tag}: ${x}`));
        if (alive.length === 2) {
          v.push(
            ...C.checkMatchPlay(recs[0], { code }).map((x) => `${tag}: ${x}`),
          );
          v.push(
            ...C.checkHonors(recs[0], { code }).map((x) => `${tag}: ${x}`),
          );
          const [a, b] = alive.map((x) =>
            C.stable({ ...lastView(x), turnEndsIn: undefined }),
          );
          if (a !== b) v.push(`${tag}: final views differ\n  ${a}\n  ${b}`);
        }
        for (const b of alive) {
          const m = lastView(b);
          if (
            m?.result?.reason === "forfeit" &&
            m.result.winner !== b.playerId &&
            r.kind !== "match-end-reset"
          )
            v.push(
              `${tag}: forfeit won by ${m.result.winner}, not the survivor ${b.name}`,
            );
        }
      }
      for (const b of r.bots)
        for (const o of b.other)
          if (o.msg?.t === "err")
            v.push(`${tag}: ${b.name} server error ${JSON.stringify(o.msg)}`);
      if (r.stuck)
        for (const b of r.bots) {
          const vs = C.views(b.records(), C.lastCode(b.records()));
          const gaps = b.snaps
            .slice(1)
            .map((s, k) => [s.at - b.snaps[k].at, k])
            .sort((x, y) => y[0] - x[0])
            .slice(0, 5);
          t.diagnostic(
            `${tag} ${b.name}: snaps ${b.snaps.length}, views ${vs.length}, last view at ${vs.at(-1)?.at - (b.snaps[0]?.at ?? 0)} ms phase ${vs.at(-1)?.m.phase}; finished seen at ${(vs.find((x) => x.m.phase === "finished")?.at ?? NaN) - (b.snaps[0]?.at ?? 0)} ms; gaps ${JSON.stringify(gaps)}; log ${r.log.join("; ")}`,
          );
        }
      const res = r.bots
        .map((b) => lastView(b)?.result?.reason ?? "-")
        .join("/");
      counts[`${r.kind} ${res}`] = (counts[`${r.kind} ${res}`] || 0) + 1;
    }
    t.diagnostic(JSON.stringify(counts));
    // Everyone still connected cleanly leaves; half-open sockets stay, and
    // their matches must still be freed (finished, then the linger), and
    // their seats once their pings go unanswered.
    for (const r of runs) r.bots.forEach((b) => b.close());
    await sleep(Math.max(LINGER_MS, PING_TIMEOUT_MS) + 3000);
    const snap = await rawSnapshot(srv.url);
    t.diagnostic(
      `after: players ${snap?.playerCount} matches ${snap?.matchCount}`,
    );
    if (snap?.matchCount !== 0)
      v.push(
        `server still holds ${snap?.matchCount} match(es) after everyone left`,
      );
    if (snap?.playerCount !== 1)
      v.push(
        `server still seats ${snap?.playerCount - 1} player(s) besides the probe after everyone left`,
      );
    await Promise.all(runs.flatMap((r) => r.links.map((l) => l.close())));
    C.assertClean(v, "tcp fuzz");
  },
);
