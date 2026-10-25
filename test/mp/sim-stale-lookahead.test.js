// Kit: SimClient decides to take its turn from the view it had when the turn
// came up, then spends its lookahead (several simulated tries, real CPU
// time) before swinging. If the server moves on meanwhile (the opponent
// forfeits, or the turn times out), the sim used to swing from the stale
// view anyway: the server refused the shotStart ("Match not in play" / "That
// turn is over"), the record kept the shot, and checkAgreement reported a
// correct server ("no view after the shot ends its turn"). Now the sim looks
// again after its tries, and checks.js orders a shot against the views by
// arrival, counting a swing on a view already past its turn as never opened.
// Seen live in sim-fuzz.test.js (MP_SEED=1).
// Run: node --test test/mp/sim-stale-lookahead.test.js
const test = require("node:test");
const { setTimeout } = require("node:timers");
const { startGolfServer } = require("./server.js");
const { Bot, lobby } = require("./bot.js");
const { SimClient } = require("./sim-client.js");
const C = require("./checks.js");

test(
  "kit: a sim whose view goes stale during its lookahead doesn't swing on it",
  { timeout: 120000 },
  async (t) => {
    const srv = await startGolfServer({ port: 7835 });
    t.after(() => srv.stop());
    // Dave hosts, so he has the honor on hole 1; plenty of tries makes the
    // lookahead take a while.
    const dave = new SimClient(srv.url, "Dave", {
      timeScale: 8,
      seed: 3,
      lookahead: 12,
    });
    const sam = new Bot(srv.url, "Sam");
    t.after(() => {
      dave.dispose();
      sam.close();
    });
    await Promise.all([dave.connect(), sam.connect()]);
    // Sam walks out just after Dave's turn comes up, while Dave is still
    // trying his shot out.
    let left = false;
    sam.onSnapshot = () => {
      if (left || sam.match?.turn !== dave.playerId) return;
      left = true;
      setTimeout(() => sam.leave(), 40);
    };
    await lobby([dave, sam]);
    await dave.untilPhase("finished");
    // Let a swing that was already under way go out and get its answer.
    await new Promise((r) => setTimeout(r, 4000));
    const rec = dave.records();
    const fin = C.views(rec).find((v) => v.m.phase === "finished");
    t.diagnostic(
      `finished view at +${fin.at - rec.snaps[0].at} ms; Dave's shots opened at ${dave.shots.map((s) => `+${s.openedAt - rec.snaps[0].at}`).join(", ") || "none"}; notices ${dave.notices.map((n) => n.text).join(" | ")}`,
    );
    C.assertClean([
      ...C.checkAgreement([rec]),
      ...C.checkNoErrors([rec], { strict: true }),
    ]);
  },
);

// The same race with a turn timeout: Dave's lookahead outlasts his turn (a
// slow phone; here the tries are padded to take longer than the timeout).
// The server concedes hole 1 for him, his late swing is refused, and the
// check then judges that swing by a later view, as if it had been played.
test(
  "kit: a swing refused because the turn ran out during lookahead isn't judged as played",
  { timeout: 120000 },
  async (t) => {
    const srv = await startGolfServer({
      port: 7835,
      env: { GOLF_TURN_TIMEOUT_MS: "3000" },
    });
    t.after(() => srv.stop());
    const dave = new SimClient(srv.url, "Dave", { timeScale: 8, seed: 3 });
    const sam = new Bot(srv.url, "Sam"); // never plays: his turns time out too
    t.after(() => {
      dave.dispose();
      sam.close();
    });
    await Promise.all([dave.connect(), sam.connect()]);
    const refine = dave._refine.bind(dave);
    let padded = false;
    dave._refine = async (...a) => {
      await refine(...a);
      if (!padded) {
        padded = true;
        await new Promise((r) => setTimeout(r, 4000));
      }
    };
    await lobby([dave, sam]);
    await dave.untilPhase("finished", { timeout: 60000 });
    const rec = dave.records();
    t.diagnostic(
      `notices ${dave.notices.map((n) => n.text).join(" | ")}; outcomes ${rec.shots.map((s) => C.shotOutcome(rec, s).outcome).join(",")}; result ${dave.match.result.text}`,
    );
    C.assertClean(C.checkAgreement([rec, sam.records()]));
  },
);
