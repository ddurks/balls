// Async play live, protocol bots on a private golf server whose matches are
// kept in a (fake) DynamoDB, as the real ddb match store keeps them:
// - a live match where one player closes the tab: the other finishes their
//   own hole, the turn then waits on the one who left (untimed), who opens
//   the match "the next day" on a fresh connection with the same token,
//   gets a replay of the opponent's hole, plays theirs, and the turn passes
//   back (the first player's replay is then of the previous hole);
// - each player's match list says whose turn it is;
// - a reload mid-live-match takes the same seat with the chat log intact;
// - a server restart keeps the match, chat and all;
// - a link opened by anyone else is refused a seat, politely.
// Run: node --test test/mp/async-play.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const { startGolfServer } = require("./server.js");
const { startDdbFake } = require("./ddb-fake.js");
const { Bot, lobby, fakeShot } = require("./bot.js");

const TOKEN = {
  dave: "dave-0123456789abcdef",
  sam: "sam-0123456789abcdef",
  eve: "eve-0123456789abcdef",
};

test(
  "async play (live server, ddb match store)",
  { timeout: 240000 },
  async (t) => {
    const ddb = await startDdbFake();
    const env = { ...ddb.env, GOLF_TURN_TIMEOUT_MS: "60000" };
    let srv = await startGolfServer({ env });
    const all = [];
    t.after(async () => {
      all.forEach((b) => b.close());
      await srv.stop();
      await ddb.stop();
    });
    const bot = async (name, token) => {
      const b = new Bot(srv.url, name, { token });
      all.push(b);
      await b.connect();
      return b;
    };
    // One shot on b's turn, then the server's answer to it.
    const shot = async (b, opts) => {
      await b.untilMyTurn();
      const seq = b.match.turnSeq;
      fakeShot(b, opts);
      await b.until(
        (x) => x.match.turnSeq > seq || x.match.phase !== "playing",
        {
          label: "the shot's result",
        },
      );
    };
    const startPair = async () => {
      const dave = await bot("Dave", TOKEN.dave);
      const sam = await bot("Sam", TOKEN.sam);
      await lobby([dave, sam]);
      return { dave, sam, id: dave.match.id };
    };

    await t.test(
      "live, then async: the one left finishes, the one back watches and plays, the turn goes back",
      async () => {
        const { dave, sam, id } = await startPair();
        assert.match(id, /^[A-Za-z0-9_-]{12}$/);
        await dave.untilMyTurn();
        await shot(dave, { fraction: 0.5 });
        await shot(sam, { fraction: 0.2 });
        assert.equal(dave.match.turn, sam.playerId, "Sam is away: live order");
        dave.mchat("see you tomorrow");
        await sam.untilChat(/see you tomorrow/);
        const samOld = sam.playerId;
        sam.close();

        await dave.untilMyTurn({ label: "Dave plays on" });
        assert.equal(dave.match.present[samOld], false);
        assert.equal(dave.match.turnEndsIn, null, "no clock on a lone player");
        while (dave.isMyTurn()) await shot(dave, { fraction: 0.6 });
        assert.equal(dave.match.lies[dave.playerId].holed, true);
        assert.equal(dave.match.turn, samOld, "the turn waits on Sam");
        assert.equal(dave.match.phase, "playing");
        dave.close();

        // The next day: a fresh page, the same browser.
        const sam2 = await bot("Sam", TOKEN.sam);
        sam2.resume(id);
        await sam2.untilMyTurn();
        const replay =
          sam2.you.replay ?? sam2.snaps.find((s) => s.you?.replay)?.you.replay;
        assert.equal(replay.length, 1);
        assert.equal(replay[0].hole, 0);
        const daveShots = replay[0].shots;
        assert.ok(daveShots.length >= 2, "Dave's shots after Sam's tee shot");
        assert.ok(
          daveShots.every(
            (s) => s.samples.length && s.player !== sam2.playerId,
          ),
        );
        assert.equal(daveShots.at(-1).restPos, null, "the last one holed");
        assert.ok(sam2.chatLog().some((l) => l.text === "see you tomorrow"));
        assert.equal(sam2.match.lies[sam2.playerId].strokes, 1);

        // Short ones until Sam can't halve the hole: Dave wins it, and has the honor.
        while (sam2.isMyTurn() && sam2.match.hole === 0)
          await shot(sam2, { fraction: 0.05, holeWithin: 0 });
        await sam2.until((x) => x.match.hole === 1, { label: "hole 2" });
        const daveSeat = sam2.match.teeOrder[0];
        assert.notEqual(daveSeat, sam2.playerId);
        assert.equal(sam2.match.turn, daveSeat, "the turn went back to Dave");
        assert.equal(sam2.match.holeResults[0].winner, daveSeat);

        // Each one's list says so.
        const sam3 = await bot("Sam", TOKEN.sam);
        sam3.listMatches();
        const samList = await sam3.until((x) => x.you?.matches, {
          label: "Sam's matches",
        });
        const daveList = await (async () => {
          const d = await bot("Dave", TOKEN.dave);
          d.listMatches();
          return d.until((x) => x.you?.matches, { label: "Dave's matches" });
        })();
        assert.deepEqual(
          samList.find((m) => m.id === id),
          {
            id,
            vs: "Dave",
            myTurn: false,
            hole: 2,
            status: "Dave 1 UP",
            finished: false,
          },
        );
        assert.equal(daveList.find((m) => m.id === id).myTurn, true);

        // Dave, back, watches Sam's hole 1 (the previous hole) before teeing off.
        const dave2 = await bot("Dave", TOKEN.dave);
        dave2.resume(id);
        await dave2.untilMyTurn();
        const dReplay = dave2.snaps.find((s) => s.you?.replay)?.you.replay;
        assert.deepEqual(
          dReplay.map((h) => h.hole),
          [0],
        );
        assert.ok(dReplay[0].shots.length >= 1);
        assert.deepEqual(dave2.match.present, {
          [dave2.playerId]: true,
          [sam2.playerId]: true,
        });
        assert.ok(dave2.match.turnEndsIn > 0, "both here: live, on the clock");
        [sam2, sam3, dave2].forEach((b) => b.close());
      },
    );

    await t.test(
      "a reload mid-live-match takes the same seat, chat log intact",
      async () => {
        const { dave, sam, id } = await startPair();
        dave.mchat("hi Sam");
        sam.mchat("hi Dave");
        await dave.untilChat(/hi Dave/);
        const before = sam.chatLog().map((l) => [l.seq, l.text]);
        await dave.untilMyTurn();
        await shot(dave, { fraction: 0.5 });
        sam.close(); // the reload
        const sam2 = await bot("Sam", TOKEN.sam);
        sam2.resume(id);
        await sam2.untilMatch();
        await sam2.untilChat(/is back$/);
        const after = sam2.chatLog().map((l) => [l.seq, l.text]);
        assert.deepEqual(after.slice(0, before.length), before);
        const seqs = after.map(([seq]) => seq);
        assert.deepEqual(
          seqs,
          [...seqs].sort((a, b) => a - b),
          "in order",
        );
        assert.equal(new Set(seqs).size, seqs.length, "no duplicates");
        await dave.until((x) => x.match.present[sam2.playerId] === true, {
          label: "Sam back for Dave",
        });
        await sam2.untilMyTurn();
        await shot(sam2, { fraction: 0.5 });
        assert.equal(sam2.match.lies[sam2.playerId].strokes, 1);
        [dave, sam2].forEach((b) => b.close());
      },
    );

    await t.test(
      "anyone else with the link is told whose match it is",
      async () => {
        const { dave, sam, id } = await startPair();
        const eve = await bot("Eve", TOKEN.eve);
        eve.resume(id);
        assert.equal(
          await eve.untilNotice(/./),
          "This match is between Dave and Sam",
        );
        assert.equal(eve.code, null);
        const anon = await bot("Anon");
        anon.resume(id);
        assert.equal(
          await anon.untilNotice(/./),
          "This match is between Dave and Sam",
        );
        [dave, sam, eve, anon].forEach((b) => b.close());
      },
    );

    await t.test("a server restart keeps the match, chat and all", async () => {
      const { dave, sam, id } = await startPair();
      await dave.untilMyTurn();
      await shot(dave, { fraction: 0.5 });
      sam.mchat("before the restart");
      await dave.untilChat(/before the restart/);
      const lie = dave.match.lies[dave.playerId];
      const hole = dave.match.hole;
      await srv.stop();
      srv = await startGolfServer({ env });
      const dave2 = await bot("Dave", TOKEN.dave);
      const sam2 = await bot("Sam", TOKEN.sam);
      dave2.resume(id);
      sam2.resume(id);
      await Promise.all([dave2.untilMatch(), sam2.untilMatch()]);
      await sam2.untilChat(/before the restart/);
      const m = dave2.match;
      assert.equal(m.id, id);
      assert.equal(m.hole, hole);
      assert.deepEqual(m.lies[dave2.playerId], lie);
      await sam2.untilMyTurn();
      await shot(sam2, { fraction: 0.5 });
      assert.equal(sam2.match.lies[sam2.playerId].strokes, 1);
      assert.ok(
        [...ddb.items.keys()].some((k) => k === `MATCH#${id}|DATA`),
        "kept in the ddb store",
      );
      [dave2, sam2].forEach((b) => b.close());
    });
  },
);
