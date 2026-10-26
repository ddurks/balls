// Contracts 3 (liveness) and 1 (agreement) under chaos, with protocol bots.
// Many head-to-head matches run at once, each player behind a chaos proxy of
// its own (50-400 ms latency with jitter, some throttled). On their turns the
// bots play, dawdle past the turn timeout, open a shot and walk away from it
// (shot timeout), or claim a rest the server refuses. One player of most
// matches is cut at a chosen moment of the match's life: in the lobby, on
// their turn, right after shotStart lands, between path and shotEnd, as a
// hole changes, or as the match ends.
// Every match must reach finished (or forfeit); survivors agree with each
// other and with the server; once everyone leaves, no match is left behind.
// Run: node --test test/mp/liveness-fuzz.test.js
//   MP_FUZZ_MATCHES (default 24), MP_FUZZ_SEED (default 1)
const test = require("node:test");
const assert = require("node:assert");
const { setTimeout } = require("node:timers");
const { startGolfServer } = require("./server.js");
const { startChaosProxy } = require("./chaos-proxy.js");
const { Bot, lobby } = require("./bot.js");
const { holeById, CLUB_MAX } = require("./holes.js");
const { makeRng } = require("./sim-client.js");
const C = require("./checks.js");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MATCHES = Number(process.env.MP_FUZZ_MATCHES || 24);
const SEED = Number(process.env.MP_FUZZ_SEED || 1);
const TURN_MS = 2500;
const SHOT_MS = 2000;
const LINGER_MS = 4000;

const CUTS = [
  "none",
  "lobby",
  "my-turn",
  "after-shotStart",
  "path-then-cut-before-shotEnd",
  "hole-change",
  "match-end",
  "random-time",
  "leave-action",
  "both-cut",
];

// A bot that acts on its turns per `rand`; never plays one turn twice.
function drive(bot, rand, log) {
  let acted = null;
  bot.onSnapshot = () => {
    if (!bot.isMyTurn()) return;
    const m = bot.match;
    if (acted === m.turnSeq) return;
    acted = m.turnSeq;
    const r = rand();
    const turnSeq = m.turnSeq;
    if (r < 0.1) {
      log.push(`${bot.name} idles turn ${turnSeq}`);
      return; // turn timeout concedes the hole
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
    if (r < 0.18) {
      log.push(`${bot.name} abandons shot turn ${turnSeq}`);
      return; // shot timeout
    }
    const frames = 1 + Math.floor(rand() * 4);
    const gap = rand() * 300;
    const bad = r < 0.24;
    (async () => {
      for (let i = 1; i <= frames; i++) {
        const k = i / frames;
        bot.path([
          [
            0.05 * i,
            from.x + (rest.x - from.x) * k,
            from.y + (rest.y - from.y) * k,
            from.z + (rest.z - from.z) * k,
            0,
            0,
            0,
            1,
          ],
        ]);
        if (gap) await sleep(gap / frames);
      }
      if (bad) {
        log.push(`${bot.name} claims a far rest turn ${turnSeq}`);
        bot.shotEnd({ x: rest.x, y: rest.y, z: rest.z + 900 }, false, 0);
        return; // refused; the shot stays open until it times out
      }
      bot.shotEnd(rest, holed, 0);
    })();
  };
}

function armCut(kind, proxy, victim, rand) {
  let lastHole = null;
  let shotSeen = false;
  const cut = (why) => {
    proxy.disconnect(null, why);
    return "disconnect";
  };
  if (kind === "none") return;
  if (kind === "leave-action") {
    const ms = 1000 + rand() * 8000;
    setTimeout(() => victim.leave(), ms);
    return;
  }
  if (kind === "random-time") {
    const ms = 300 + rand() * 9000;
    setTimeout(() => proxy.disconnect(null, `random ${Math.round(ms)}`), ms);
    return;
  }
  proxy.onMessage(({ dir, json }) => {
    if (!victim.playerId) return undefined;
    const you = dir === "down" && json?.t === "gameSnapshot" ? json.you : null;
    const m = you?.match;
    switch (kind) {
      case "lobby":
        if (you?.phase === "lobby" && you.players?.length === 2)
          return cut("lobby");
        break;
      case "my-turn":
        if (m?.phase === "playing" && m.turn === victim.playerId && m.hole >= 1)
          return cut("my turn");
        break;
      case "after-shotStart":
        if (
          m?.shotOpen?.playerId === victim.playerId &&
          m.hole >= 0 &&
          rand() < 0.5
        )
          return cut("shot open");
        break;
      case "path-then-cut-before-shotEnd":
        if (dir === "up" && json?.action === "path") shotSeen = true;
        if (
          dir === "up" &&
          json?.action === "shotEnd" &&
          shotSeen &&
          rand() < 0.4
        )
          return cut("before shotEnd");
        break;
      case "hole-change":
        if (
          m &&
          lastHole !== null &&
          m.hole !== lastHole &&
          m.phase === "playing"
        )
          return cut("hole change");
        if (m) lastHole = m.hole;
        break;
      case "match-end":
        if (m?.phase === "finished") return cut("match end");
        break;
    }
    return undefined;
  });
}

async function runMatch(i, srv, rand) {
  const lat = 50 + Math.floor(rand() * 250);
  const jit = Math.floor(rand() * 150);
  const slow = rand() < 0.3 ? 4000 + Math.floor(rand() * 12000) : Infinity;
  const mk = (seed) =>
    startChaosProxy({
      target: srv.url,
      latencyMs: lat,
      jitterMs: jit,
      down: { bytesPerSec: slow },
      seed,
    });
  const proxies = [await mk(i * 2 + 1), await mk(i * 2 + 2)];
  const bots = [
    new Bot(proxies[0].url, `H${i}`),
    new Bot(proxies[1].url, `G${i}`),
  ];
  const log = [];
  const kind = CUTS[i % CUTS.length];
  const victimIx = Math.floor(rand() * 2);
  const out = { i, kind, victimIx, lat, jit, slow, log, bots, proxies };
  try {
    await Promise.all(bots.map((b) => b.connect()));
    for (const b of bots) drive(b, makeRng(Math.floor(rand() * 1e9)), log);
    if (kind === "both-cut") {
      const ms = 1000 + rand() * 8000;
      setTimeout(() => proxies.forEach((p) => p.disconnect(null, "both")), ms);
    } else armCut(kind, proxies[victimIx], bots[victimIx], rand);
    try {
      await lobby(bots);
    } catch (e) {
      out.lobbyError = String(e.message);
    }
    // Every connected bot must see its match finish (or, if it was cut,
    // stop). The worst case is every turn idled: 3 holes, each conceded on
    // the first turn; plus shot timeouts. 120 s is far beyond that.
    if (out.lobbyError) {
      // Cut in the lobby: the survivor is left alone in it, or never got in.
      const left = bots.find(
        (b, k) => !b.closed && !(kind === "leave-action" && k === victimIx),
      );
      if (left && kind !== "both-cut")
        await left
          .until((x) => !C.lobbyCutPending(x.records()), {
            timeout: 15000,
            label: "the lobby cut to settle",
          })
          .catch(
            (e) =>
              (out.stuck = [
                `${e.message}: ${C.lobbyCutPending(left.records())}`,
              ]),
          );
      return out;
    }
    await Promise.all(
      bots.map((b) =>
        b
          .until(
            (x) =>
              x.closed ||
              C.settled(x.match) ||
              (kind === "leave-action" &&
                x === bots[victimIx] &&
                x.sent.some((m) => m.msg?.action === "leave") &&
                !x.code),
            {
              timeout: 120000,
              allowClosed: true,
              label: "finished",
            },
          )
          .catch(
            (e) => (out.stuck = (out.stuck || []).concat(String(e.message))),
          ),
      ),
    );
  } catch (e) {
    out.error = String(e.stack || e);
  }
  return out;
}

test(
  "fuzz: every match reaches finished under chaos and cuts",
  { timeout: 20 * 60 * 1000 },
  async (t) => {
    const srv = await startGolfServer({
      env: {
        GOLF_TURN_TIMEOUT_MS: String(TURN_MS),
        GOLF_SHOT_TIMEOUT_MS: String(SHOT_MS),
        GOLF_FINISHED_LINGER_MS: String(LINGER_MS),
      },
    });
    t.after(() => srv.stop());
    const rand = makeRng(SEED);
    const runs = await Promise.all(
      Array.from({ length: MATCHES }, (_, i) => runMatch(i, srv, rand)),
    );
    const v = [];
    for (const r of runs) {
      const tag = `match ${r.i} [${r.kind}, cut ${r.bots[r.victimIx].name}, ${r.lat}+${r.jit} ms, ${r.slow} B/s]`;
      if (r.error) v.push(`${tag}: error ${r.error}`);
      if (r.stuck) v.push(`${tag}: stuck ${r.stuck.join("; ")}`);
      const recs = r.bots.map((b) => b.records());
      // A bot that left by action is still connected but out of the match.
      const alive = r.bots.filter(
        (b, k) => !b.closed && !(r.kind === "leave-action" && k === r.victimIx),
      );
      const lastView = (b) => {
        const vs = C.views(b.records(), C.lastCode(b.records()));
        return vs[vs.length - 1]?.m ?? null;
      };
      for (const b of alive) {
        const m = lastView(b);
        if (r.lobbyError && !m) continue; // cut in the lobby: no match to finish
        if (!C.settled(m))
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
        } else if (alive.length === 1 && r.kind !== "match-end") {
          const m = lastView(alive[0]);
          if (
            m?.result &&
            m.result.reason === "forfeit" &&
            m.result.winner !== alive[0].playerId
          )
            v.push(
              `${tag}: forfeit won by ${m.result.winner}, not the survivor`,
            );
        }
      }
      for (const b of r.bots)
        for (const o of b.other)
          if (o.msg?.t === "err")
            v.push(`${tag}: ${b.name} server error ${JSON.stringify(o.msg)}`);
    }
    const counts = {};
    for (const r of runs) {
      const res = r.bots
        .map((b) => {
          const vs = C.views(b.records(), C.lastCode(b.records()));
          return vs[vs.length - 1]?.m?.result?.reason ?? "-";
        })
        .join("/");
      counts[`${r.kind} ${res}`] = (counts[`${r.kind} ${res}`] || 0) + 1;
    }
    t.diagnostic(JSON.stringify(counts));
    for (const r of runs) {
      r.bots.forEach((b) => b.close());
    }
    await sleep(LINGER_MS + 1500);
    // Everyone gone: the server must hold no match.
    const probe = new Bot(srv.url, "Probe");
    await probe.connect();
    const s = await probe.nextSnapshot();
    const raw = probe.snaps[probe.snaps.length - 1];
    probe.close();
    await Promise.all(runs.flatMap((r) => r.proxies.map((p) => p.close())));
    t.diagnostic(
      `after: ${JSON.stringify(raw.keys)} snap ${JSON.stringify(s.you)}`,
    );
    const last = await (async () => {
      const b2 = new Bot(srv.url, "Probe2");
      await b2.connect();
      let snap;
      b2.ws.on("message", (d) => {
        const m = JSON.parse(d.toString());
        if (m.t === "gameSnapshot") snap = m;
      });
      await sleep(300);
      b2.close();
      return snap;
    })();
    if (last?.matchCount !== 0)
      v.push(
        `server still holds ${last?.matchCount} match(es) after everyone left`,
      );
    C.assertClean(v, "fuzz");
    assert.ok(true);
  },
);
