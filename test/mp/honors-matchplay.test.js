// Contracts 4 (honors / away) and 5 (match-play math), live, scripted with
// protocol bots so every outcome is exact: 1 cm tie band on both sides, holed
// and picked-up players skipped, decided holes, stroke cap via penalties,
// timeout concessions, halves, dormie, early finish and the final result text.
// Run: node --test test/mp/honors-matchplay.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const { startGolfServer } = require("./server.js");
const { setupMatch } = require("./bot.js");
const { SERVER_HOLES } = require("./holes.js");
const C = require("./checks.js");

const PORT = 7847;
const TURN_MS = 1200;

// Shoot from wherever the server has us; resolve once the server reflected it.
async function shoot(b, { at, holed = false, penalty = 0 }) {
  await b.untilMyTurn({ timeout: 10000 });
  const m = b.match;
  const before = C.stable([m.lies, m.hole, m.holeResults.length, b.you.phase]);
  const n = b.notices.length;
  b.shotStart(12, 0);
  b.shotEnd(at(m), holed, penalty);
  await b.until(
    (x) =>
      x.notices.length > n ||
      C.stable([
        x.match.lies,
        x.match.hole,
        x.match.holeResults.length,
        x.you.phase,
      ]) !== before,
    { label: "shot reflected" },
  );
  assert.deepEqual(
    b.notices.slice(n).map((x) => x.text),
    [],
    `${b.name}: shot refused`,
  );
}
// The turn as the server reports it right after `b`'s own shot (b's view is current).
const turnName = (b) => b.match.names[b.match.turn] ?? null;
const off = (dx, dz) => (m) => ({
  x: m.pin.x + dx,
  y: m.pin.y,
  z: m.pin.z + dz,
});
const cup = off(0.3, 0);
const tee = (m) => ({ ...SERVER_HOLES[m.hole].tee });

async function audit(bots) {
  await Promise.all(bots.map((b) => b.untilPhase("finished")));
  const recs = bots.map((b) => b.records());
  C.assertClean([
    ...C.checkLiveness(recs),
    ...C.checkAgreement(recs),
    ...C.checkHonors(recs[0]),
    ...C.checkHonors(recs[1]),
    ...C.checkMatchPlay(recs[0]),
    ...C.checkMatchPlay(recs[1]),
    ...C.checkChat(recs),
    ...C.checkNoErrors(recs),
  ]);
}
const sys = (b) =>
  b
    .chatLog()
    .filter((l) => !l.from)
    .map((l) => l.text);

test(
  "honors and match play (contracts 4, 5)",
  { timeout: 240000 },
  async (t) => {
    const srv = await startGolfServer({
      port: PORT,
      env: {
        GOLF_TURN_TIMEOUT_MS: String(TURN_MS),
        GOLF_SHOT_TIMEOUT_MS: "20000",
        GOLF_FINISHED_LINGER_MS: "20000",
      },
    });
    const all = [];
    t.after(async () => {
      all.forEach((b) => b.close());
      await srv.stop();
    });
    const match = async () => {
      const s = await setupMatch(srv.url, ["Dave", "Sam"]);
      all.push(...s.bots);
      return s.bots;
    };

    await t.test(
      "away: the 1 cm tie band, both sides, then holed and picked-up players are skipped",
      async () => {
        const [dave, sam] = await match();
        // 3-4-5 triangles keep the distances exact after 1 mm rounding.
        await shoot(dave, { at: off(0, 50) }); // D1 50.000
        await shoot(sam, { at: off(30.003, 40.004) }); // S1 50.005: level, tee order wins
        assert.equal(turnName(sam), "Dave");
        await shoot(dave, { at: off(0, 49.99) }); // D2 49.990: Sam is 1.5 cm farther
        assert.equal(turnName(dave), "Sam");
        await shoot(sam, { at: off(0, 49.995) }); // S2: 5 mm farther than Dave, level again
        assert.equal(turnName(sam), "Dave");
        await shoot(dave, { at: cup, holed: true }); // D3 holed; Sam on 2 can still halve
        assert.equal(turnName(dave), "Sam");
        assert.equal(dave.match.lies[sam.playerId].pickedUp, false);
        await shoot(sam, { at: off(0, 2) }); // S3 misses: 4 > 3, the hole is decided
        await dave.until((b) => b.match.hole === 1);
        assert.equal(dave.match.holeResults[0].winner, dave.playerId);
        assert.ok(sys(dave).includes("Dave wins hole 1 with a 3. Dave 1 UP"));
        assert.deepEqual(dave.match.teeOrder, [dave.playerId, sam.playerId]);
        // Hole 2: the farther player keeps playing; a holed player is skipped; halved in 3.
        await shoot(dave, { at: off(0, 20) }); // D1
        await shoot(sam, { at: off(0, 40) }); // S1
        assert.equal(turnName(sam), "Sam");
        await shoot(sam, { at: off(0, 20.02) }); // S2: still 2 cm farther
        assert.equal(turnName(sam), "Sam");
        await shoot(sam, { at: cup, holed: true }); // S3 holed; Dave on 1 can halve
        assert.equal(turnName(sam), "Dave");
        await shoot(dave, { at: off(0, 2) }); // D2
        assert.equal(turnName(dave), "Dave");
        await shoot(dave, { at: cup, holed: true }); // D3: halved in 3
        await dave.until((b) => b.match.hole === 2);
        assert.ok(
          sys(dave).includes("Hole 2 halved in 3. Dave 1 UP (dormie)"),
          JSON.stringify(sys(dave).slice(-3)),
        );
        assert.deepEqual(
          dave.match.teeOrder,
          [dave.playerId, sam.playerId],
          "a half keeps the honor",
        );
        // Hole 3: Dave stalls on the tee and concedes: match halved.
        await dave.untilPhase("finished", { timeout: TURN_MS * 6 });
        assert.equal(dave.match.result.text, "Match halved");
        assert.ok(sys(dave).includes("Dave ran out of time, Sam wins hole 3"));
        await audit([dave, sam]);
      },
    );

    await t.test(
      "the stroke cap via penalties, then a 2 UP finish",
      async () => {
        const [dave, sam] = await match();
        // Hole 1: Sam stalls on the tee after Dave teed off.
        await shoot(dave, { at: off(0, 40) });
        await dave.until((b) => b.match.hole === 1, { timeout: TURN_MS * 6 });
        assert.ok(
          sys(dave).includes(
            "Sam ran out of time, Dave wins hole 1. Dave 1 UP",
          ),
        );
        // Hole 2: Dave has the honor; both pick up at 10 through penalties -> no "in N".
        assert.deepEqual(dave.match.teeOrder, [dave.playerId, sam.playerId]);
        // Both re-tee from the same spot, so the level-lie rule hands Dave every
        // turn until he is out, then Sam plays out.
        while (dave.match.hole === 1) {
          const me = [dave, sam].find((b) => b.isMyTurn());
          if (!me) {
            await dave.nextSnapshot();
            continue;
          }
          if (process.env.DEBUG_RULES)
            console.log("shoot", me.name, C.stable(me.match.lies));
          await shoot(me, { at: tee, penalty: 2 });
          await dave.nextSnapshot();
        }
        assert.ok(
          sys(dave).includes("Hole 2 halved. Dave 1 UP (dormie)"),
          JSON.stringify(sys(dave).slice(-4)),
        );
        assert.equal(dave.match.holeResults[1].strokes[dave.playerId], 10);
        // Hole 3: Dave wins -> 2 UP with none left.
        await dave.until((b) => b.match.hole === 2);
        if (process.env.DEBUG_RULES)
          console.log(
            "hole3",
            dave.match.names[dave.match.turn],
            dave.match.teeOrder.map((id) => dave.match.names[id]),
            sys(dave).slice(-3),
          );
        await shoot(dave, { at: off(0, 3) });
        await shoot(sam, { at: off(0, 4) });
        await shoot(sam, { at: off(0, 3.5) });
        await shoot(sam, { at: off(0, 2.5) }); // Sam 3 strokes and nearer; Dave (1) is away
        await shoot(dave, { at: cup, holed: true }); // Dave 2; Sam 3+1 > 2 is out
        await dave.untilPhase("finished");
        assert.equal(dave.match.result.text, "Dave wins 2 UP");
        await audit([dave, sam]);
      },
    );

    await t.test("2 & 1 ends the match after hole 2", async () => {
      const [dave, sam] = await match();
      await shoot(dave, { at: cup, holed: true });
      await shoot(sam, { at: off(0, 20) });
      await dave.until((b) => b.match.hole === 1);
      await shoot(dave, { at: cup, holed: true });
      await shoot(sam, { at: off(0, 20) });
      await dave.untilPhase("finished");
      assert.equal(dave.match.result.text, "Dave wins 2 & 1");
      assert.equal(dave.match.holeResults.length, 2);
      assert.equal(sys(dave).at(-1), "Dave wins 2 & 1");
      await audit([dave, sam]);
    });
    await t.test(
      "forfeit: the player who is up drops mid-shot; the opponent wins and nothing stays queued",
      async () => {
        const [dave, sam] = await match();
        await shoot(dave, { at: cup, holed: true });
        await shoot(sam, { at: off(0, 20) });
        await dave.until((b) => b.match.hole === 1);
        assert.equal(dave.match.status, "Dave 1 UP");
        await dave.untilMyTurn();
        dave.shotStart(12, 0);
        const from = SERVER_HOLES[1].tee;
        for (let i = 1; i <= 6; i++)
          dave.path([
            [0.05 * i, from.x, from.y + i, from.z - 3 * i, 0, 0, 0, 1],
          ]);
        dave.terminate(); // dropped mid-shot
        await sam.untilPhase("finished");
        const r = sam.match.result;
        assert.deepEqual(
          {
            winner: r.winner,
            text: r.text,
            reason: r.reason,
            status: sam.match.status,
            score: sam.match.score[dave.playerId],
          },
          {
            winner: sam.playerId,
            text: "Sam wins by forfeit",
            reason: "forfeit",
            status: "Sam wins by forfeit",
            score: 1,
          },
        );
        assert.deepEqual(sys(sam).slice(-2), [
          "Dave disconnected",
          "Sam wins by forfeit",
        ]);
        assert.equal(sam.match.names[dave.playerId], "Dave");
        assert.equal(sam.match.turn, null);
        assert.equal(sam.match.shotOpen, null);
        // Nothing else arrives for a dead shot once the match is over.
        const n = sam.broadcasts.length;
        await sam.nextSnapshot();
        await sam.nextSnapshot();
        assert.equal(sam.broadcasts.length, n);
        const recs = [sam.records()];
        C.assertClean([
          ...C.checkMatchPlay(recs[0]),
          ...C.checkHonors(recs[0]),
          ...C.checkChat(recs),
          ...C.checkLiveness(recs),
        ]);
      },
    );

    await t.test(
      "forfeit by leave on the last hole; a later leave of the finished match changes nothing",
      async () => {
        const [dave, sam] = await match();
        await shoot(dave, { at: cup, holed: true });
        await shoot(sam, { at: off(0, 20) });
        await dave.until((b) => b.match.hole === 1);
        await shoot(dave, { at: off(0, 20) });
        await shoot(sam, { at: cup, holed: true });
        await dave.until((b) => b.match.hole === 2);
        assert.equal(dave.match.status, "ALL SQUARE");
        sam.leave();
        await dave.untilPhase("finished");
        assert.equal(dave.match.result.text, "Dave wins by forfeit");
        const before = C.stable({ ...dave.match, turnEndsIn: 0 });
        dave.leave();
        await dave.until((b) => !b.code);
        assert.equal(
          C.stable({ ...C.views(dave.records()).pop().m, turnEndsIn: 0 }),
          before,
        );
        const recs = [dave.records()];
        C.assertClean([
          ...C.checkMatchPlay(recs[0]),
          ...C.checkHonors(recs[0]),
          ...C.checkChat(recs),
        ]);
      },
    );
  },
);
