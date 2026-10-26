// Contract 3 (liveness) with half-open connections: a player's network dies
// without a FIN (phone off a cliff, laptop lid shut), so the server keeps the
// socket and never sees a disconnect. The match must still finish on the
// turn and shot timeouts, and once both players are gone silently the match
// must still be freed after the linger.
// Run: node --test test/mp/half-open.test.js
const test = require("node:test");
const assert = require("node:assert");
const { setTimeout } = require("node:timers");
const { startGolfServer } = require("./server.js");
const { startChaosProxy } = require("./chaos-proxy.js");
const { Bot, lobby, fakeShot } = require("./bot.js");
const C = require("./checks.js");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function autoplay(bot) {
  let acted = null;
  bot.onSnapshot = () => {
    if (!bot.isMyTurn() || acted === bot.match.turnSeq) return;
    acted = bot.match.turnSeq;
    fakeShot(bot, { fraction: 0.5 });
  };
}

async function matchCount(url) {
  const p = new Bot(url, "Probe");
  await p.connect();
  let raw = null;
  p.ws.on("message", (d) => {
    const m = JSON.parse(d.toString());
    if (m.t === "gameSnapshot") raw = m;
  });
  await p.nextSnapshot();
  await p.nextSnapshot();
  p.close();
  return raw;
}

for (const when of ["my-turn", "mid-shot"]) {
  test(
    `half-open player (${when}): the match still finishes and is freed`,
    { timeout: 120000 },
    async (t) => {
      const srv = await startGolfServer({
        env: {
          GOLF_TURN_TIMEOUT_MS: "2000",
          GOLF_SHOT_TIMEOUT_MS: "1500",
          GOLF_FINISHED_LINGER_MS: "2000",
        },
      });
      t.after(() => srv.stop());
      const pd = await startChaosProxy({
        target: srv.url,
        latencyMs: 80,
        jitterMs: 80,
        seed: 1,
      });
      const ps = await startChaosProxy({
        target: srv.url,
        latencyMs: 250,
        jitterMs: 150,
        seed: 2,
      });
      t.after(() => Promise.all([pd.close(), ps.close()]));
      const dave = new Bot(pd.url, "Dave");
      const sam = new Bot(ps.url, "Sam");
      await Promise.all([dave.connect(), sam.connect()]);
      autoplay(dave);
      let gone = false;
      const silence = async () => {
        if (gone) return;
        gone = true;
        // Everything lost both ways from now on, and no FIN either way.
        ps.blackholeUntil = { up: Infinity, down: Infinity };
      };
      if (when === "my-turn") {
        sam.onSnapshot = () => {
          if (sam.isMyTurn()) silence();
        };
      } else {
        let shots = 0;
        sam.onSnapshot = () => {
          if (!sam.isMyTurn() || gone) return;
          if (++shots === 2) {
            sam.shotStart(5, 0); // opens; nothing after it ever arrives
            setTimeout(silence, 400);
          } else fakeShot(sam, { fraction: 0.5 });
        };
      }
      await lobby([dave, sam]);
      await dave.untilPhase("finished", { timeout: 60000 });
      const m = dave.match;
      t.diagnostic(
        `${m.result.text}; ${m.holeResults.map((r) => `${C.stable(r.strokes)} ${r.reason}`).join(" ")}`,
      );
      C.assertClean([
        ...C.checkLiveness([dave.records()]),
        ...C.checkMatchPlay(dave.records()),
        ...C.checkHonors(dave.records()),
      ]);
      // Dave walks away too, but cleanly; Sam's socket is still half-open.
      dave.close();
      await sleep(3500);
      const snap = await matchCount(srv.url);
      t.diagnostic(
        `server after: players ${snap.playerCount} (Sam half-open + probe), matches ${snap.matchCount}`,
      );
      assert.strictEqual(
        snap.matchCount,
        0,
        "the finished match was never freed",
      );
    },
  );
}
