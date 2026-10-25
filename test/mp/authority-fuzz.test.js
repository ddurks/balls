// Contract item 2 (authority): protocol bots throw
// out-of-turn, duplicate, reordered, malformed and wrong-phase actions at a
// live golf server and check that every one is refused without moving state.
// Run: node --test test/mp/authority-fuzz.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const { setTimeout } = require("node:timers");
const { startGolfServer } = require("./server.js");
const { Bot, setupMatch } = require("./bot.js");
const { holeById } = require("./holes.js");
const C = require("./checks.js");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PORT = 7820;

// Lets every action sent so far land and a snapshot or two go out.
const settle = (bot) => bot.nextSnapshot().then(() => bot.nextSnapshot());
const stateOf = (bot) =>
  C.stable({
    ...bot.match,
    turnEndsIn: undefined,
    shotOpen: bot.match.shotOpen,
  });

test("authority fuzz battery", { timeout: 180000 }, async (t) => {
  const srv = await startGolfServer({
    port: PORT,
    env: {
      GOLF_TURN_TIMEOUT_MS: "60000",
      GOLF_SHOT_TIMEOUT_MS: "60000",
      GOLF_FINISHED_LINGER_MS: "3000",
    },
  });
  t.after(() => srv.stop());

  const {
    bots: [dave, sam],
  } = await setupMatch(srv.url, ["Dave", "Sam"]);
  const outsider = new Bot(srv.url, "Mallory");
  await outsider.connect();
  t.after(() => [dave, sam, outsider].forEach((b) => b.close()));

  await dave.untilMyTurn();
  const before = stateOf(dave);

  await t.test("out-of-turn shotStart is refused", async () => {
    sam.shotStart(12, 0);
    assert.equal(await sam.untilNotice(/Not your turn/), "Not your turn");
    await settle(dave);
    assert.equal(stateOf(dave), before);
  });

  await t.test("shotEnd with no shot open is refused", async () => {
    dave.shotEnd(holeById(dave.match.holeId).tee);
    assert.match(await dave.untilNotice(/./), /No shot in play/);
    sam.shotEnd(holeById(dave.match.holeId).tee);
    assert.match(await sam.untilNotice(/./), /No shot in play/);
    await settle(dave);
    assert.equal(stateOf(dave), before);
  });

  await t.test("outsider actions never reach the match", async () => {
    outsider.shotStart(0, 0);
    assert.match(await outsider.untilNotice(/./), /Match not in play/);
    outsider.shotEnd({ x: 0, y: 0, z: 0 });
    assert.match(await outsider.untilNotice(/./), /Match not in play/);
    outsider.path([[0.1, 0, 0, 0, 0, 0, 0, 1]]);
    outsider.mchat("hello from outside");
    outsider.chatPlain("plain hello from outside");
    outsider.start();
    outsider.ready(true);
    outsider.leave();
    await settle(dave);
    assert.equal(stateOf(dave), before);
    assert.ok(!dave.chatLog().some((l) => /outside/.test(l.text)));
    assert.equal(dave.broadcasts.length + sam.broadcasts.length, 0);
  });

  await t.test("malformed shotStart data is refused", async () => {
    const turnSeq = dave.match.turnSeq;
    const bad = [
      undefined,
      null,
      42,
      "x",
      [],
      { club: -1, aim: 0, turnSeq },
      { club: 13, aim: 0, turnSeq },
      { club: 1.5, aim: 0, turnSeq },
      { club: "3", aim: 0, turnSeq },
      { club: 3, turnSeq },
      { club: 3, aim: "0", turnSeq },
      { club: 3, aim: null, turnSeq },
      { club: 3, aim: 0 },
      { club: 3, aim: 0, turnSeq: String(turnSeq) },
      { club: 3, aim: 0, turnSeq: turnSeq + 0.5 },
    ];
    for (const data of bad) {
      dave.action("shotStart", data === undefined ? {} : { data });
      assert.match(
        await dave.untilNotice(/./),
        /Bad shot data/,
        JSON.stringify(data),
      );
    }
    // Infinity and NaN can't be written in JSON, but 1e999 parses to Infinity.
    dave.sendRaw(
      `{"t":"action","action":"shotStart","data":{"club":3,"aim":1e999,"turnSeq":${turnSeq}}}`,
    );
    assert.match(await dave.untilNotice(/./), /Bad shot data/);
    dave.sendRaw(
      `{"t":"action","action":"shotStart","data":{"club":1e999,"aim":0,"turnSeq":${turnSeq}}}`,
    );
    assert.match(await dave.untilNotice(/./), /Bad shot data/);
    // A turn other than the one in play: an earlier one, or one not dealt yet.
    for (const stale of [turnSeq - 1, turnSeq + 1]) {
      dave.shotStart(3, 0, stale);
      assert.match(await dave.untilNotice(/./), /That turn is over/);
    }
    await settle(dave);
    assert.equal(stateOf(dave), before);
  });

  await t.test("second shotStart while one is open is refused", async () => {
    dave.shotStart(12, 0);
    await dave.until((b) => b.match.shotOpen, { label: "shot open" });
    const open = dave.match.shotOpen;
    dave.shotStart(0, 1);
    assert.match(await dave.untilNotice(/./), /Shot already in play/);
    await settle(dave);
    assert.deepEqual(dave.match.shotOpen, open);
  });

  await t.test(
    "malformed / tampered shotEnd leaves the shot open",
    async () => {
      const hole = holeById(dave.match.holeId);
      const pin = dave.match.pin;
      const tee = hole.tee;
      const ok = { x: tee.x, y: tee.y, z: tee.z - 50 };
      const cases = [
        [{}, /Bad shot data/],
        [{ restPos: null }, /Bad shot data/],
        [{ restPos: { x: 0, y: 0 } }, /Bad shot data/],
        [{ restPos: { x: "0", y: 0, z: 0 } }, /Bad shot data/],
        [{ restPos: ok, holed: "true" }, /Bad shot data/],
        [{ restPos: ok, holed: 1 }, /Bad shot data/],
        [{ restPos: ok, penalty: -1 }, /Bad shot data/],
        [{ restPos: ok, penalty: 3 }, /Bad shot data/],
        [{ restPos: ok, penalty: 1.5 }, /Bad shot data/],
        [{ restPos: ok, penalty: "1" }, /Bad shot data/],
        [{ restPos: pin, holed: true, penalty: 1 }, /Bad shot data/],
        [{ restPos: { x: hole.bounds.maxX + 6, y: 0, z: 0 } }, /out of bounds/],
        [{ restPos: { x: 0, y: hole.bounds.minY - 6, z: 0 } }, /out of bounds/],
        [
          { restPos: { x: 0, y: hole.bounds.maxY + 16, z: 0 } },
          /out of bounds/,
        ],
        [{ restPos: { x: 0, y: 0, z: hole.bounds.minZ - 6 } }, /out of bounds/],
        [
          { restPos: { x: pin.x + 2, y: pin.y, z: pin.z }, holed: true },
          /Not in the cup/,
        ],
      ];
      for (const [data, re] of cases) {
        dave.action("shotEnd", { data: { ...data, strokes: 0 } });
        assert.match(await dave.untilNotice(/./), re, JSON.stringify(data));
      }
      dave.sendRaw(
        '{"t":"action","action":"shotEnd","data":{"restPos":{"x":1e999,"y":0,"z":0}}}',
      );
      assert.match(await dave.untilNotice(/./), /Bad shot data/);
      await settle(dave);
      assert.ok(dave.match.shotOpen, "shot still open");
      assert.equal(dave.myLie.strokes, 0);
      assert.equal(dave.myLie.pos, null);
    },
  );

  await t.test("opponent can't close the shooter's shot", async () => {
    sam.shotEnd({ x: 0, y: 0, z: 0 });
    assert.match(await sam.untilNotice(/./), /No shot in play/);
    await settle(dave);
    assert.ok(dave.match.shotOpen);
  });

  await t.test(
    "bad path frames are dropped, good ones relayed once",
    async () => {
      const n0 = sam.broadcasts.length;
      const good = (t) => [t, 0, 1, 100, 0, 0, 0, 1];
      dave.path([good(0.1)]); // relayed
      dave.path([good(0.1)]); // duplicate t
      dave.path([good(0.05)]); // reordered
      dave.path([good(0.2), good(0.15)]); // decreasing within a frame
      dave.path([good(0.3), [0.31, 0, 1, 100, 0, 0, 0]]); // 7 numbers
      dave.path([[0.4, 0, 1, 100, 0, 0, 0, 1.2]]); // |q| > 1.01
      dave.path([[0.5, 9999, 1, 100, 0, 0, 0, 1]]); // x far out
      dave.path([[0.6, 0, 9999, 100, 0, 0, 0, 1]]); // y far up
      dave.path([[700, 0, 1, 100, 0, 0, 0, 1]]); // t > 600
      dave.path([[-1, 0, 1, 100, 0, 0, 0, 1]]); // t < 0
      dave.path([]);
      dave.path(Array.from({ length: 33 }, (_, i) => good(1 + i * 0.01)));
      dave.action("path", { data: { samples: "nope" } });
      dave.action("path", { data: null });
      dave.sendRaw(
        '{"t":"action","action":"path","data":{"samples":[[0.7,1e999,1,100,0,0,0,1]]}}',
      );
      sam.path([good(5)]); // not the shooter
      outsider.path([good(6)]);
      dave.path([good(0.25)]); // still above the last accepted t: relayed
      await settle(sam);
      await settle(sam);
      // Frames of one shot queued together may ride as one relay entry.
      const got = sam.broadcasts
        .slice(n0)
        .flatMap((b) => b.data.samples.map((s) => s[0]));
      assert.deepEqual(got, [0.1, 0.25]);
      assert.equal(dave.broadcasts.length, 0, "shooter never gets own frames");
      assert.equal(outsider.broadcasts.length, 0);
    },
  );

  await t.test(
    "a path flood is relayed in full, merged and paced; a shot is capped at 2400 samples",
    async () => {
      // No frame is dropped for coming fast: frames that bunch up in transit
      // are the shooter's honest backlog (past the connection's 100 frames a
      // second they are read late, in order). Each snapshot carries at most
      // 128 samples.
      const n0 = sam.broadcasts.length;
      const ts = Array.from({ length: 300 }, (_, i) => 10 + i * 0.01);
      for (const t of ts) dave.path([[t, 0, 1, 100, 0, 0, 0, 1]]);
      const relayed = () =>
        sam.broadcasts
          .slice(n0)
          .flatMap((b) => b.data.samples.map((s) => s[0]));
      await sam.until((b) => relayed().length >= ts.length, {
        label: "the flood relayed",
      });
      assert.deepEqual(relayed(), ts);
      const perSnapshot = new Map();
      for (const b of sam.broadcasts.slice(n0)) {
        assert.ok(b.data.samples.length <= 32);
        perSnapshot.set(
          b.at,
          (perSnapshot.get(b.at) ?? 0) + b.data.samples.length,
        );
      }
      for (const n of perSnapshot.values())
        assert.ok(n <= 128, `${n} samples in one snapshot`);

      let tt = 20;
      for (let i = 0; i < 100; i++)
        dave.path(
          Array.from({ length: 32 }, () => [
            (tt += 0.001),
            0,
            1,
            100,
            0,
            0,
            0,
            1,
          ]),
        );
      await sleep(3000);
      await settle(sam);
      const total = sam.broadcasts
        .filter((b) => b.data.shot === dave.match.shotOpen.id)
        .reduce((n, b) => n + b.data.samples.length, 0);
      assert.ok(
        total <= 2400 && total > 2400 - 32,
        `total samples relayed ${total}`,
      );
    },
  );

  await t.test(
    "valid close counts exactly one stroke; duplicate shotEnd refused",
    async () => {
      const hole = holeById(dave.match.holeId);
      const rest = { x: hole.tee.x, y: hole.tee.y, z: hole.tee.z - 100 };
      const n0notices = dave.notices.length;
      dave.action("shotEnd", {
        data: { restPos: rest, holed: false, penalty: 0, strokes: -5 },
      });
      dave.shotEnd(rest);
      await dave.until((b) => !b.match.shotOpen && b.myLie.strokes > 0, {
        label: "closed",
      });
      await dave.until((b) => b.notices.length > n0notices, {
        label: "dup notice",
      });
      assert.match(dave.notices[n0notices].text, /No shot in play/);
      await settle(dave);
      assert.equal(dave.myLie.strokes, 1);
      assert.equal(dave.match.turn, sam.playerId);
      // late path after close is dropped
      const n0 = sam.broadcasts.length;
      dave.path([[99, 0, 1, 0, 0, 0, 0, 1]]);
      await settle(sam);
      assert.equal(sam.broadcasts.length, n0);
    },
  );

  await t.test("implausible distance for the club is refused", async () => {
    await sam.untilMyTurn();
    const hole = holeById(sam.match.holeId);
    sam.shotStart(0, 0); // putter: 22 * 1.5 + 100 = 133 m
    await sam.until((b) => b.match.shotOpen);
    sam.shotEnd({ x: hole.tee.x, y: hole.tee.y, z: hole.tee.z - 140 });
    assert.match(await sam.untilNotice(/./), /Implausible distance/);
    sam.shotEnd({ x: hole.tee.x, y: hole.tee.y, z: hole.tee.z - 130 });
    await sam.until((b) => !b.match.shotOpen, { label: "closed" });
  });

  await t.test("penalty adds strokes and the cap holds at 10", async () => {
    for (
      let i = 0;
      i < 12 && dave.you.phase === "playing" && dave.match.hole === 0;
      i++
    ) {
      await dave.until(
        () => dave.isMyTurn() || sam.isMyTurn() || dave.match.hole !== 0,
        {
          label: "someone's turn",
        },
      );
      await settle(sam);
      const me = [dave, sam].find((b) => b.isMyTurn() && b.match.hole === 0);
      if (!me) break;
      const lie = me.myLie;
      const from = lie.pos ?? holeById(me.match.holeId).tee;
      me.shotStart(5, 0);
      await me.until((b) => b.match.shotOpen);
      me.shotEnd(from, false, 2);
      await me.until((b) => !b.match.shotOpen || b.match.hole !== 0, {
        label: "closed",
      });
      await settle(me);
      for (const l of Object.values(me.match.hole === 0 ? me.match.lies : {}))
        assert.ok(l.strokes <= 10);
    }
    const r = dave.match.holeResults[0];
    assert.ok(r, "hole 1 finished");
    for (const s of Object.values(r.strokes))
      assert.ok(s <= 10, `strokes ${s}`);
  });

  await t.test("actions after finish are refused", async () => {
    sam.leave();
    await dave.untilPhase("finished");
    dave.shotStart(0, 0);
    assert.match(await dave.untilNotice(/./), /Match not in play/);
    dave.shotEnd({ x: 0, y: 0, z: 0 });
    assert.match(await dave.untilNotice(/./), /Match not in play/);
    const code = dave.code;
    outsider.join(code);
    assert.match(await outsider.untilNotice(/./), /already teed off/);
    dave.start();
    dave.ready(true);
    await settle(dave);
    assert.equal(dave.you.phase, "finished");
    await dave.until((b) => b.you?.matchCode === null, {
      timeout: 8000,
      label: "dissolved",
    });
  });
});
