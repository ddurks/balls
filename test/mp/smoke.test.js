// Live smoke: a private golf server, two sim clients (real physics on the
// real holes) playing a whole match, one of them behind the chaos proxy with
// mild latency, and a protocol-bot match running alongside for isolation.
// Then every contract check over what everyone received.
// Run: npm run test:mp   (MP_TIME_SCALE=1 plays in real time; default 4)
const test = require("node:test");
const { setTimeout } = require("node:timers");
const { startGolfServer } = require("./server.js");
const { startChaosProxy } = require("./chaos-proxy.js");
const { setupMatch, fakeShot } = require("./bot.js");
const { SimClient } = require("./sim-client.js");
const C = require("./checks.js");

const TIME_SCALE = Number(process.env.MP_TIME_SCALE || 4);
const LINGER_MS = 4000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Physics-free bots playing their own match at a human-ish pace.
async function playFake(bots, { gapMs = 1500, until }) {
  const host = bots[0];
  let n = 0;
  while (host.you?.phase === "playing" && !until()) {
    const me = bots.find((b) => b.isMyTurn());
    if (!me) {
      await host.nextSnapshot();
      continue;
    }
    const before = C.stable(me.match.lies);
    fakeShot(me, { fraction: 0.6 });
    if (++n % 4 === 0) me.mchat(`${me.name} side match line ${n} zq${n}x`);
    await me.until(
      (b) =>
        b.you?.phase !== "playing" ||
        C.stable(b.match.lies) !== before ||
        b.notices.length,
      { timeout: 10000 },
    );
    await sleep(gapMs);
  }
}

test(
  "two sim clients play a full match on a private server and the contract holds",
  { timeout: 20 * 60 * 1000 },
  async (t) => {
    const srv = await startGolfServer({
      env: { GOLF_FINISHED_LINGER_MS: String(LINGER_MS) },
    });
    t.after(() => srv.stop());
    const proxy = await startChaosProxy({
      target: srv.url,
      latencyMs: 60,
      jitterMs: 40,
      seed: 7,
    });
    t.after(() => proxy.close());

    const dave = new SimClient(srv.url, "Dave", {
      timeScale: TIME_SCALE,
      seed: 11,
    });
    const sam = new SimClient(proxy.url, "Sam", {
      timeScale: TIME_SCALE,
      seed: 22,
    });
    t.after(() => {
      dave.dispose();
      sam.dispose();
    });
    await Promise.all([dave.connect(), sam.connect()]);

    dave.create();
    const code = await dave.untilMatch();
    sam.join(code);
    await sam.untilMatch();
    dave.mchat("lobby hello from Dave dv1x");
    sam.chatPlain("plain chat from Sam sm2x\nwith a newline");
    dave.ready();
    sam.ready();
    await dave.until(
      (b) => b.you.players.length === 2 && b.you.players.every((p) => p.ready),
      { label: "both ready" },
    );
    dave.start();
    await Promise.all([dave.untilPhase("playing"), sam.untilPhase("playing")]);

    const side = await setupMatch(srv.url, ["Alex", "Jo"]);
    t.after(() => side.bots.forEach((b) => b.close()));
    const simDone = () => dave.you?.phase !== "playing";
    const sideRun = playFake(side.bots, { until: simDone });

    await dave.until((b) => b.match?.hole >= 1 || b.you?.phase !== "playing", {
      timeout: 10 * 60 * 1000,
      label: "hole 2",
    });
    sam.mchat("good luck on the next one sm3x");
    const minutes = 15 * 60 * 1000;
    await Promise.all([
      dave.untilPhase("finished", { timeout: minutes }),
      sam.untilPhase("finished", { timeout: minutes }),
    ]);
    dave.mchat("gg Sam dv4x");
    await sam.untilChat(/gg Sam dv4x/);
    await sideRun;

    const recs = [dave.records(), sam.records()];
    const sideRecs = side.bots.map((b) => b.records());
    // Every shot, the match-ending one included: frames still queued when
    // the last shotEnd lands go out after the finish.
    const paths = [
      C.checkPathFidelity(recs[0], recs[1]),
      C.checkPathFidelity(recs[1], recs[0]),
    ];
    const resources = C.checkResources([...recs, ...sideRecs]);
    const m = dave.match;
    t.diagnostic(
      `result: ${m.result.text}; holes ${m.holeResults.map((r) => C.stable(r.strokes)).join(" ")}`,
    );
    t.diagnostic(
      `shots: Dave ${dave.shots.length}, Sam ${sam.shots.length}; spins ${[...dave.shots, ...sam.shots].filter((s) => s.spins.length).length}; penalties ${[...dave.shots, ...sam.shots].filter((s) => s.penalty).length}`,
    );
    t.diagnostic(`paths: ${C.stable(paths.map((p) => p.stats))}`);
    t.diagnostic(`snapshots: ${C.stable(resources.stats)}`);

    C.assertClean([
      ...C.checkNoErrors([...recs, ...sideRecs]),
      ...C.checkLiveness(recs),
      ...C.checkAgreement(recs),
      ...C.checkHonors(recs[0]),
      ...C.checkHonors(recs[1]),
      ...C.checkMatchPlay(recs[0]),
      ...C.checkMatchPlay(recs[1]),
      ...C.checkChat(recs),
      ...C.checkSharedConditions(recs),
      ...C.checkIsolation([{ recs }, { recs: sideRecs }]),
      ...paths.flat(),
      ...resources,
    ]);

    // The finished match lingers, then is freed for everyone in it.
    await Promise.all(
      [dave, sam].map((b) =>
        b.until((x) => x.you && !x.code, {
          timeout: LINGER_MS + 10000,
          label: "the match to dissolve",
        }),
      ),
    );

    await t.test(
      "both clients build the same trees and rocks",
      { todo: "CourseManager.addExtraRocks places rocks with Math.random" },
      () => C.assertClean(C.checkSameDecor(recs), "decor"),
    );
  },
);
