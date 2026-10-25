// Contracts 1 / 2 (agreement, authority) at the hole transition under
// latency: a shot played on one hole must not be counted on the next. Sam
// swings on hole 1 just as his network stalls (TCP holds the bytes and
// delivers them later, in order). His turn times out, conceding hole 1; Dave
// tees off on hole 2; then Sam's buffered hole-1 shotStart / path / shotEnd
// arrive. shotStart names the turn it was played in (turnSeq), so the server
// refuses it, drops the path and the shotEnd, and nothing moves.
// Run: node --test test/mp/stale-shot.test.js
const test = require("node:test");
const assert = require("node:assert");
const { setTimeout } = require("node:timers");
const { startGolfServer } = require("./server.js");
const { startChaosProxy } = require("./chaos-proxy.js");
const { Bot, lobby, fakeShot } = require("./bot.js");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const TURN_MS = 3000;
const STALL_MS = TURN_MS + 3000;

test(
  "a shot delayed past its turn's timeout is not counted on the next hole",
  { timeout: 60000 },
  async (t) => {
    const srv = await startGolfServer({
      port: 7836,
      env: {
        GOLF_TURN_TIMEOUT_MS: String(TURN_MS),
        GOLF_SHOT_TIMEOUT_MS: "20000",
      },
    });
    t.after(() => srv.stop());
    const proxy = await startChaosProxy({
      target: srv.url,
      port: 7837,
      seed: 1,
    });
    t.after(() => proxy.close());

    const dave = new Bot(srv.url, "Dave");
    const sam = new Bot(proxy.url, "Sam");
    t.after(() => [dave, sam].forEach((b) => b.close()));
    await Promise.all([dave.connect(), sam.connect()]);
    await lobby([dave, sam]);

    // Dave plays promptly whenever it's his turn.
    let daveKey = null;
    dave.onSnapshot = () => {
      if (!dave.isMyTurn()) return;
      const m = dave.match;
      const key = `${m.hole}|${m.lies[dave.playerId].strokes}`;
      if (key === daveKey) return;
      daveKey = key;
      fakeShot(dave);
    };

    // Hole 1: Dave has the honor; then it's Sam's turn.
    await sam.until((b) => b.match.hole === 0 && b.isMyTurn(), {
      label: "Sam's turn on hole 1",
    });
    // The proxy applies latency when a message reaches it, so hold the stall
    // until Sam's shotEnd has entered the pipe; later bytes queue behind it.
    proxy.set({ up: { latencyMs: STALL_MS } });
    const held = new Promise((resolve) => {
      const off = proxy.onMessage(({ dir, json }) => {
        if (dir === "up" && json?.action === "shotEnd")
          setTimeout(() => (off(), resolve()), 0);
      });
    });
    const sent = fakeShot(sam); // Sam's hole-1 shot, held by the network
    await held;
    proxy.set({ up: { latencyMs: 0 } });

    // The stall outlasts Sam's turn: hole 1 is conceded, Dave tees off on 2.
    await dave.until(
      (b) => b.match.hole === 1 && b.match.lies[dave.playerId].strokes >= 1,
      {
        label: "Dave's tee shot on hole 2",
      },
    );
    const conceded = dave.match.holeResults[0];
    assert.equal(conceded.reason, "timeout");

    // Let the held bytes land.
    await sleep(STALL_MS);
    await dave.nextSnapshot();
    const m = dave.match;
    const samHole2 = m.lies[sam.playerId];
    const relayedAsHole2 = dave
      .pathsFrom(sam.playerId)
      .filter(
        (b) => b.at > dave.snaps.find((s) => s.you?.match?.hole === 1).at,
      );
    t.diagnostic(`Sam's hole-1 rest ${JSON.stringify(sent.rest)}`);
    t.diagnostic(`Sam's hole-2 lie per server ${JSON.stringify(samHole2)}`);
    t.diagnostic(
      `hole-1 path frames relayed to Dave during hole 2: ${relayedAsHole2.length}`,
    );

    assert.equal(m.hole, 1);
    assert.deepEqual(
      { strokes: samHole2.strokes, pos: samHole2.pos },
      { strokes: 0, pos: null },
      "Sam never played on hole 2, yet the server counts his hole-1 shot there",
    );
    assert.equal(
      relayedAsHole2.length,
      0,
      "hole-1 path frames relayed as a hole-2 shot",
    );
  },
);

// The same with no stall at all: a 400 ms uplink and a swing in the last
// moment of the turn. The shot reaches the server just after the deadline;
// Dave, a quick opponent, has already teed off on hole 2, so it opens as
// Sam's hole-2 tee shot. Its hole-1 rest is then refused or, as above,
// accepted as a hole-2 lie; refused, the shot sits open until the shot
// timeout charges Sam a stroke on a hole he never played.
test(
  "a shot that misses its turn's deadline by a few hundred ms is not counted on the next hole",
  { timeout: 60000 },
  async (t) => {
    const srv = await startGolfServer({
      port: 7836,
      env: {
        GOLF_TURN_TIMEOUT_MS: String(TURN_MS),
        GOLF_SHOT_TIMEOUT_MS: "20000",
      },
    });
    t.after(() => srv.stop());
    const proxy = await startChaosProxy({
      target: srv.url,
      port: 7837,
      up: { latencyMs: 400 },
      seed: 1,
    });
    t.after(() => proxy.close());

    const dave = new Bot(srv.url, "Dave");
    const sam = new Bot(proxy.url, "Sam");
    t.after(() => [dave, sam].forEach((b) => b.close()));
    await Promise.all([dave.connect(), sam.connect()]);
    await lobby([dave, sam]);
    let daveKey = null;
    dave.onSnapshot = () => {
      if (!dave.isMyTurn()) return;
      const m = dave.match;
      const key = `${m.hole}|${m.lies[dave.playerId].strokes}`;
      if (key === daveKey) return;
      daveKey = key;
      fakeShot(dave);
    };

    const m0 = await sam.until(
      (b) => b.match.hole === 0 && b.isMyTurn() && b.match,
      { label: "Sam's turn on hole 1" },
    );
    await sleep(Math.max(0, m0.turnEndsIn - 100)); // swing with 0.1 s on the clock
    const sent = fakeShot(sam);
    await dave.until(
      (b) => b.match.hole === 1 && b.match.lies[dave.playerId].strokes >= 1,
      {
        label: "Dave's tee shot on hole 2",
      },
    );
    await sleep(1000);
    await dave.nextSnapshot();
    const lie = dave.match.lies[sam.playerId];
    const shot = dave.match.shotOpen;
    t.diagnostic(
      `hole 1: ${dave.match.holeResults[0]?.reason}; Sam's hole-1 rest ${JSON.stringify(sent.rest)}`,
    );
    t.diagnostic(
      `hole 2 per server: Sam ${JSON.stringify(lie)}, open shot ${JSON.stringify(shot)}, Sam's notices ${JSON.stringify(sam.notices.map((n) => n.text))}`,
    );
    assert.equal(dave.match.holeResults[0]?.reason, "timeout");
    assert.ok(
      !(shot && shot.playerId === sam.playerId) && lie.strokes === 0,
      "Sam's late hole-1 shot was opened (or counted) as his hole-2 shot",
    );
  },
);
