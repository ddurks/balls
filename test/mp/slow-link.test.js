// Contracts 3 (liveness), 6 (bounded spectator delay) and 10 (resources) on
// a slow downlink. The server sends the match view only when it changed (the
// turn countdown alone doesn't count), so an idle match costs a few hundred
// bytes a snapshot, and it stops queueing snapshots to a socket that is far
// behind. Before that, every player got the full ~1.1-2 KB view 12 times a
// second (13-17 KB/s), and on a link a little slower than that the view fell
// further behind without bound.
// - Bots (64 kbit/s down) play the moment their view says it's their turn:
//   the slow one's view stays within 3 s of the fast one's and he never
//   loses a hole on time.
// - Sims (12 KB/s down): the spectator sees the opponent's shots within the
//   kit's bounded delay.
// - On a link the server can feel (a byte-level TCP throttle, see
//   startTcpThrottle): at 3000 B/s, below the old idle stream (~3.5 KB/s,
//   the unchanged roster in every `you`), a player's view used to settle 40 s
//   and more behind (64 KB of socket buffer on top of what the kernel held)
//   and he lost holes on time; now `you` only goes out when it changed. At
//   600 B/s, below even the ~0.8 KB/s of bare snapshots, only the server's
//   ping-timed lag gate keeps the view within seconds.
// Run: node --test test/mp/slow-link.test.js
const test = require("node:test");
const assert = require("node:assert");
const { setTimeout } = require("node:timers");
const { startGolfServer } = require("./server.js");
const { startChaosProxy, startTcpThrottle } = require("./chaos-proxy.js");
const { Bot, lobby, fakeShot } = require("./bot.js");
const { SimClient } = require("./sim-client.js");
const C = require("./checks.js");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const DOWN_BYTES_PER_SEC = 8000; // 64 kbit/s
const TURN_MS = 20000;
const MAX_LAG_MS = 3000;

// Plays as soon as its view says it's its turn (once per state).
function autoplay(bot) {
  let key = null;
  bot.onSnapshot = () => {
    if (!bot.isMyTurn()) return;
    const m = bot.match;
    const k = `${m.hole}|${m.holeResults.length}|${m.lies[bot.playerId].strokes}`;
    if (k === key) return;
    key = k;
    fakeShot(bot, { fraction: 0.5 });
  };
}

// When each distinct settled match state was first seen by this bot.
function firstSeen(bot) {
  const out = new Map();
  for (const v of C.views(bot.records())) {
    if (v.m.shotOpen) continue;
    const k = C.stable({ ...v.m, turnEndsIn: undefined });
    if (!out.has(k)) out.set(k, v.at);
  }
  return out;
}

test(
  "a slow downlink does not leave a player's view ever further behind",
  { timeout: 240000 },
  async (t) => {
    const srv = await startGolfServer({
      port: 7838,
      env: {
        GOLF_TURN_TIMEOUT_MS: String(TURN_MS),
        GOLF_FINISHED_LINGER_MS: "60000",
      },
    });
    t.after(() => srv.stop());
    const proxy = await startChaosProxy({
      target: srv.url,
      port: 7839,
      latencyMs: 80,
      jitterMs: 40,
      down: { bytesPerSec: DOWN_BYTES_PER_SEC },
      seed: 2,
    });
    t.after(() => proxy.close());
    const dave = new Bot(srv.url, "Dave");
    const sam = new Bot(proxy.url, "Sam");
    t.after(() => [dave, sam].forEach((b) => b.close()));
    await Promise.all([dave.connect(), sam.connect()]);
    await lobby([dave, sam]);
    autoplay(dave);
    autoplay(sam);

    await dave.untilPhase("finished", { timeout: 180000 });
    // Give Sam's backlog time to drain so his view of every state exists.
    await sam.untilPhase("finished", { timeout: 60000 }).catch(() => {});
    await sleep(2000);

    const d = firstSeen(dave);
    const s = firstSeen(sam);
    const lags = [];
    for (const [k, at] of d)
      if (s.has(k)) lags.push({ at, lag: s.get(k) - at });
    lags.sort((a, b) => a.at - b.at);
    const m = dave.match;
    const timeouts = m.holeResults.filter((r) => r.reason === "timeout").length;
    const bytes = sam.snaps.map((x) => x.bytes);
    const avg = bytes.reduce((a, b) => a + b, 0) / bytes.length;
    t.diagnostic(
      `snapshot avg ${avg.toFixed(0)} B x 12 Hz = ${((avg * 12) / 1000).toFixed(1)} KB/s vs link ${DOWN_BYTES_PER_SEC / 1000} KB/s`,
    );
    t.diagnostic(
      `Sam's lag behind Dave per state (ms): ${lags.map((x) => x.lag).join(" ")}`,
    );
    t.diagnostic(`result ${m.result?.text}; holes lost on time: ${timeouts}`);
    const worst = Math.max(...lags.map((x) => x.lag));
    assert.ok(
      worst <= MAX_LAG_MS,
      `Sam saw a state ${worst} ms after Dave (max ${MAX_LAG_MS})`,
    );
    assert.equal(
      timeouts,
      0,
      "a player who plays the moment he sees his turn lost holes on time",
    );
  },
);

test(
  "a spectator on a 12 KB/s downlink sees the opponent's shots within a bounded delay",
  { timeout: 300000 },
  async (t) => {
    const srv = await startGolfServer({ port: 7854 });
    t.after(() => srv.stop());
    const proxy = await startChaosProxy({
      target: srv.url,
      latencyMs: 80,
      down: { bytesPerSec: 12000 },
      seed: 1,
    });
    t.after(() => proxy.close());
    const dave = new SimClient(srv.url, "Dave", { timeScale: 4, seed: 801 });
    const sam = new SimClient(proxy.url, "Sam", { timeScale: 4, seed: 802 });
    t.after(() => {
      dave.dispose();
      sam.dispose();
    });
    await Promise.all([dave.connect(), sam.connect()]);
    await lobby([dave, sam]);
    await dave.until((b) => b.shots.filter((s) => s.endSentAt).length >= 1, {
      timeout: 120000,
      label: "Dave's tee shot",
    });
    await new Promise((r) => setTimeout(r, 75000));
    const v = C.checkPathFidelity(dave.records(), sam.records(), {
      requireComplete: false,
    });
    t.diagnostic(`path delay to Sam: ${C.stable(v.stats)}`);
    C.assertClean(v, "spectator delay");
  },
);

// Plays as soon as its view says it's its turn, once per turn.
function autoplayTurns(bot) {
  let seq = null;
  bot.onSnapshot = () => {
    if (!bot.isMyTurn() || bot.match.turnSeq === seq) return;
    seq = bot.match.turnSeq;
    fakeShot(bot, { fraction: 0.5 });
  };
}

/**
 * How far `behind`'s view trailed `ahead`'s: for each settled state `ahead`
 * saw, until `behind` saw it or a later one (a held link skips states: the
 * view is latest-wins). Not caught up by `end`: counted to `end`.
 */
function maxViewLag(ahead, behind, end) {
  const order = [...firstSeen(ahead)];
  const seen = firstSeen(behind);
  let caught = Infinity;
  let worst = 0;
  for (let k = order.length - 1; k >= 0; k--) {
    const [key, at] = order[k];
    if (seen.has(key)) caught = Math.min(caught, seen.get(key));
    worst = Math.max(worst, Math.min(caught, end) - at);
  }
  return worst;
}

for (const { bps, windowMs, maxLagMs } of [
  { bps: 3000, windowMs: 180000, maxLagMs: 3000 },
  { bps: 600, windowMs: 60000, maxLagMs: 10000 },
])
  test(
    `on a ${bps} B/s TCP downlink the view stays within ${maxLagMs / 1000} s and no hole is lost on time`,
    { timeout: windowMs + 120000 },
    async (t) => {
      const srv = await startGolfServer({
        env: {
          GOLF_TURN_TIMEOUT_MS: "30000",
          GOLF_FINISHED_LINGER_MS: "120000",
        },
      });
      t.after(() => srv.stop());
      const thr = await startTcpThrottle(srv.url, bps);
      t.after(() => thr.close());
      const dave = new Bot(srv.url, "Dave");
      const sam = new Bot(thr.url, "Sam");
      t.after(() => [dave, sam].forEach((b) => b.close()));
      await Promise.all([dave.connect(), sam.connect({ timeout: 30000 })]);
      await lobby([dave, sam]);
      autoplayTurns(dave);
      autoplayTurns(sam);
      await dave.untilPhase("finished", { timeout: windowMs }).catch(() => {}); // the slowest link is judged on a window of play
      const end = Date.now();
      const lag = maxViewLag(dave, sam, end);
      const lost = dave
        .chatLog()
        .filter((l) => !l.from && l.text.startsWith("Sam ran out of time"));
      t.diagnostic(
        `${dave.match.holeResults.length} holes in ${((end - dave.snaps[0].at) / 1000).toFixed(0)} s (${dave.match.result?.text ?? "still playing"}); Sam's view up to ${lag} ms behind Dave's`,
      );
      assert.ok(lag <= maxLagMs, `Sam's view fell ${lag} ms behind Dave's`);
      assert.deepEqual(
        lost.map((l) => l.text),
        [],
        "lost a hole on time",
      );
      assert.deepEqual(C.checkAgreement([dave.records(), sam.records()]), []);
    },
  );
