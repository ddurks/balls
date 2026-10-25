// Contracts 4, 5, 7 with real physics: two sim clients, Sam behind 200±120 ms
// of chaos latency. Dave goes idle on hole 1 (turn timeout concedes it), then
// resumes; both must load every hole with the server's pin, version and wind,
// and honors / match play / chat must check out.
// Run: node --test test/mp/sim-timeout.test.js
const test = require("node:test");
const { startGolfServer } = require("./server.js");
const { startChaosProxy } = require("./chaos-proxy.js");
const { lobby } = require("./bot.js");
const { SimClient } = require("./sim-client.js");
const C = require("./checks.js");

const TIME_SCALE = Number(process.env.MP_TIME_SCALE || 8);

test(
  "sim: a conceded hole keeps conditions shared and the rules intact",
  { timeout: 15 * 60 * 1000 },
  async (t) => {
    const srv = await startGolfServer({
      port: 7841,
      env: { GOLF_TURN_TIMEOUT_MS: "4000", GOLF_FINISHED_LINGER_MS: "30000" },
    });
    t.after(() => srv.stop());
    const proxy = await startChaosProxy({
      target: srv.url,
      latencyMs: 200,
      jitterMs: 120,
      seed: 9,
    });
    t.after(() => proxy.close());
    const dave = new SimClient(srv.url, "Dave", {
      timeScale: TIME_SCALE,
      seed: 31,
    });
    const sam = new SimClient(proxy.url, "Sam", {
      timeScale: TIME_SCALE,
      seed: 32,
    });
    t.after(() => {
      dave.dispose();
      sam.dispose();
    });
    await Promise.all([dave.connect(), sam.connect()]);
    dave.opts.autoplay = false; // Dave has the honor and sits on it
    await lobby([dave, sam]);
    await dave.until((b) => b.match?.hole >= 1, {
      timeout: 60000,
      label: "hole 1 conceded",
    });
    dave.opts.autoplay = true;
    dave._kick();
    await Promise.all([
      dave.untilPhase("finished", { timeout: 12 * 60 * 1000 }),
      sam.untilPhase("finished", { timeout: 12 * 60 * 1000 }),
    ]);
    const recs = [dave.records(), sam.records()];
    const m = dave.match;
    t.diagnostic(
      `result: ${m.result.text}; holes ${m.holeResults.map((r) => `${C.stable(r.strokes)} ${r.reason}`).join(" ")}`,
    );
    C.assertClean([
      ...C.checkLiveness(recs),
      ...C.checkAgreement(recs),
      ...C.checkHonors(recs[0]),
      ...C.checkHonors(recs[1]),
      ...C.checkMatchPlay(recs[0]),
      ...C.checkMatchPlay(recs[1]),
      ...C.checkChat(recs),
      // A paused sim doesn't load the hole it's conceding, so hole 1 is Sam's alone.
      ...C.checkSharedConditions(
        recs.map((r) => ({ ...r, holes: r.holes.filter((h) => h.hole > 0) })),
      ),
    ]);
  },
);
