// Contract 9 (chat persistence) live, protocol bots on a private server:
// - a lobby log past 100 lines: a fresh joiner gets exactly the newest 100, in
//   order; a member who leaves and rejoins gets the retained log back; nobody
//   is handed a line twice within one membership;
// - a rejoiner's restore of a log of the longest lines (200 four-byte code
//   points each, ~90 KB in all) comes over several snapshots, each within the
//   32 KB snapshot budget, in order and complete;
// - a burst over the rate limit keeps 5 lines, and checkChat accepts it;
// - two players who chat in one lobby, then in another: each match's log holds
//   its own lines only, and checkChat judges each match by them;
// - a member who misses more lines than the log keeps and rejoins gets the
//   newest 100 back, and checkChat takes that as no gap (lines that fell off
//   the log are gone for everyone); and a line keeps the name it was said
//   under when its speaker's " 2" goes on a rejoin (checkChat used to judge
//   every line by the speaker's last name);
// - a finished match's log is freed at dissolve and never resurfaces;
// - a reload mid-match restores the log: TODO, M1 has no reconnect (a reload
//   forfeits the match and the new connection can't get back in). Reconnect
//   is M3 in the plan's phasing; see the plan's M1 protocol notes.
// Run: node --test test/mp/chat-persistence.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const { startGolfServer } = require("./server.js");
const { setTimeout } = require("node:timers");
const { Bot, lobby } = require("./bot.js");
const C = require("./checks.js");

const PORT = 7845;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function bot(url, name) {
  const b = new Bot(url, name);
  await b.connect();
  return b;
}

test("match chat persistence (contract 9)", { timeout: 300000 }, async (t) => {
  const srv = await startGolfServer({
    port: PORT,
    env: {
      GOLF_FINISHED_LINGER_MS: "2500",
      GOLF_TURN_TIMEOUT_MS: "30000",
      GOLF_SHOT_TIMEOUT_MS: "30000",
    },
  });
  const all = [];
  t.after(async () => {
    all.forEach((b) => b.close());
    await srv.stop();
  });
  const mk = async (n) => {
    const b = await bot(srv.url, n);
    all.push(b);
    return b;
  };

  await t.test(
    "a >100 line lobby log: newest 100 to a joiner, restored on rejoin",
    async () => {
      const host = await mk("Host");
      host.create();
      const code = await host.untilMatch();
      const keeper = await mk("Keeper");
      keeper.join(code);
      await keeper.untilMatch();
      let sent = 0;
      // Rotating guests: each connection has its own 5-per-5s budget.
      for (let round = 0; sent < 130; round++) {
        const g = await mk(`G${round}`);
        g.join(code);
        await g.untilMatch();
        for (let i = 0; i < 5; i++)
          g.mchat(`line ${String(++sent).padStart(3, "0")} from G${round}`);
        await g.until((b) =>
          b
            .chatLog()
            .some(
              (l) =>
                l.text ===
                `line ${String(sent).padStart(3, "0")} from G${round}`,
            ),
        );
        g.leave();
        await g.until((b) => !b.code);
      }
      const late = await mk("Late");
      late.join(code);
      await late.untilMatch();
      const first = late.chatDeliveries.find((d) => d.code === code);
      assert.equal(
        first.lines.length,
        100,
        "joiner gets exactly the retained 100",
      );
      const seqs = first.lines.map((l) => l.seq);
      assert.deepEqual(
        seqs,
        [...seqs].sort((a, b) => a - b),
      );
      assert.equal(seqs[99] - seqs[0], 99);
      assert.equal(
        first.lines[99].text,
        `line ${String(sent).padStart(3, "0")} from G${Math.ceil(sent / 5) - 1}`,
      );
      // The long-time member saw every line exactly once, in order.
      const k = C.chatLog(keeper.records(), code);
      assert.equal(k.length, sent);
      const kv = C.checkChat([keeper.records(), late.records()], {
        code,
        allowRedelivery: false,
      });
      assert.deepEqual(
        kv.filter((v) => !/missing|starts at seq/.test(v)),
        [],
      );
      // Rejoin restores the retained log.
      keeper.leave();
      await keeper.until((b) => !b.code);
      const n = keeper.chatDeliveries.length;
      keeper.join(code);
      await keeper.until((b) => b.chatDeliveries.length > n);
      const re = keeper.chatDeliveries[n];
      assert.equal(re.lines.length, 100);
      assert.deepEqual(
        re.lines.map((l) => l.seq),
        seqs.map((s) => s),
      );
    },
  );

  await t.test(
    "a restore of the longest lines comes in snapshots within budget",
    async () => {
      const smile = "\u{1f600}";
      const members = [];
      for (const n of ["A", "B", "C", "D"])
        members.push(await mk(smile.repeat(23) + n)); // 24 code points
      const code = await lobby(members, { start: false });
      const [a, , , d] = members;
      for (let round = 0; round < 5; round++) {
        const t0 = Date.now();
        for (const [k, m] of members.entries())
          for (let i = 0; i < 5; i++)
            m.mchat(`${round}${k}${i} ${smile.repeat(196)}`);
        await a.until((b) => b.chatLog().length >= 20 * (round + 1), {
          label: `round ${round}`,
        });
        await sleep(5050 - (Date.now() - t0)); // the next 5 per sender
      }
      const log = C.chatLog(a.records(), code);
      assert.equal(log.length, 100);
      d.leave();
      await d.until((b) => !b.code);
      const n = d.snaps.length;
      d.join(code);
      await d.until(
        (b) =>
          b.snaps
            .slice(n)
            .reduce((k, s) => k + (s.you?.chat?.length ?? 0), 0) >= 100,
        { label: "the whole log" },
      );
      const restore = d.snaps.slice(n).filter((s) => s.you?.chat);
      t.diagnostic(
        `restore: ${restore.length} snapshots of ${restore.map((s) => s.bytes).join(", ")} bytes`,
      );
      assert.ok(restore.length > 1, "a ~90 KB log in one snapshot");
      for (const s of restore)
        assert.ok(
          s.bytes <= 32 * 1024,
          `a restore snapshot of ${s.bytes} bytes`,
        );
      assert.deepEqual(
        restore.flatMap((s) => s.you.chat.map((l) => l.seq)),
        log.map((l) => l.seq),
      );
      assert.deepEqual(
        C.checkChat(
          members.map((m) => m.records()),
          { code, allowRedelivery: true },
        ),
        [],
      );
      for (const m of members) m.leave();
    },
  );

  await t.test(
    "a burst over the rate limit keeps 5 lines, and the kit accepts the refusals",
    async () => {
      const ann = await mk("Ann");
      ann.create();
      await ann.untilMatch();
      for (let i = 1; i <= 8; i++) ann.mchat(`burst line ${i}`);
      await ann.untilNotice(/Slow down/);
      await sleep(500);
      assert.deepEqual(
        ann.chatLog().map((l) => l.text),
        [1, 2, 3, 4, 5].map((i) => `burst line ${i}`),
      );
      assert.deepEqual(C.checkChat([ann.records()]), []);
      ann.leave();
    },
  );

  await t.test(
    "chatting in one match, then another: each log, and each check, is its own",
    async () => {
      const dave = await mk("Dave3");
      const sam = await mk("Sam3");
      const first = await lobby([dave, sam], { start: false });
      dave.mchat("hello from the first lobby");
      await sam.untilChat(/first lobby/);
      sam.leave();
      dave.leave();
      await Promise.all([dave, sam].map((b) => b.until((x) => !x.code)));
      const second = await lobby([dave, sam], { start: false });
      assert.notEqual(second, first);
      sam.mchat("hello from the second lobby");
      await Promise.all([dave, sam].map((b) => b.untilChat(/second lobby/)));
      await sleep(200);
      const recs = [dave, sam].map((b) => b.records());
      for (const r of recs) {
        assert.deepEqual(
          C.chatLog(r, first).map((l) => l.text),
          ["hello from the first lobby"],
        );
        assert.deepEqual(
          C.chatLog(r, second).map((l) => l.text),
          ["hello from the second lobby"],
        );
      }
      assert.deepEqual(C.checkChat(recs, { code: first }), []);
      assert.deepEqual(C.checkChat(recs, { code: second }), []);
    },
  );

  await t.test(
    "a finished match's log is freed and never resurfaces",
    async () => {
      const dave = await mk("Dave");
      const sam = await mk("Sam");
      const code = await lobby([dave, sam]);
      dave.mchat("secret from the first match qx1");
      await sam.untilChat(/qx1/);
      // Forfeit: quickest way to finished.
      sam.leave();
      await dave.untilPhase("finished");
      await dave.until((b) => !b.code, { timeout: 10000, label: "dissolve" });
      dave.create();
      const code2 = await dave.untilMatch();
      await sleep(300);
      assert.notEqual(code2, code);
      const lines = C.chatLog(dave.records(), code2);
      assert.ok(!lines.some((l) => /qx1/.test(l.text)), "old line resurfaced");
      // And the old code is gone.
      const other = await mk("Other");
      other.join(code);
      await other.untilNotice(/No match with that code/);
    },
  );

  await t.test(
    "a rejoin after the log rolled over gets it back from its oldest line, no gap",
    async () => {
      const host = await mk("Host");
      host.create();
      const code = await host.untilMatch();
      const pat = await mk("Pat");
      pat.join(code);
      await pat.untilMatch();
      host.mchat("before pat leaves");
      await pat.untilChat(/before pat leaves/);
      pat.leave();
      await pat.until((b) => !b.code);
      // 105 lines while Pat is away, from rotating guests (each connection
      // has its own 5-per-5s budget).
      let n = 0;
      for (let round = 0; n < 105; round++) {
        const g = await mk(`R${round}`);
        g.join(code);
        await g.untilMatch();
        for (let i = 0; i < 5; i++) g.mchat(`line ${++n} while pat is away`);
        await g.untilChat(new RegExp(`^line ${n} while`));
        g.leave();
        await g.until((b) => !b.code);
      }
      pat.join(code);
      await pat.until((b) =>
        b.chatLog(code).some((l) => /^line 105 while/.test(l.text)),
      );
      const last = host.chatLog(code).at(-1).seq;
      const seqs = pat.chatDeliveries
        .filter((d) => d.code === code)
        .flatMap((d) => d.lines.map((l) => l.seq));
      // Line 1, then the newest 100, in order, once each.
      assert.deepEqual(seqs, [
        1,
        ...Array.from({ length: 100 }, (_, i) => last - 99 + i),
      ]);
      assert.deepEqual(
        C.checkChat([host.records(), pat.records()], {
          code,
          allowRedelivery: true,
        }),
        [],
      );
    },
  );

  await t.test(
    "a line keeps the name it was said under when its speaker's number goes",
    async () => {
      const host = await mk("Host");
      const dave = await mk("Dave");
      const dave2 = await mk("Dave"); // numbered "Dave 2" in the match
      host.create();
      const code = await host.untilMatch();
      dave.join(code);
      await dave.untilMatch();
      dave2.join(code);
      await dave2.untilMatch();
      const nameOf = (b) =>
        host.you.players.find((p) => p.id === b.playerId)?.name;
      assert.equal(nameOf(dave2), "Dave 2");
      dave2.mchat("hello from the second dave");
      await host.untilChat(/second dave/);
      dave.leave();
      await host.until((b) => b.you.players.length === 2);
      dave2.leave();
      await dave2.until((b) => b.code === null);
      dave2.join(code);
      await host.until(() => nameOf(dave2) === "Dave");
      dave2.mchat("and now i am just dave");
      await Promise.all([host, dave2].map((b) => b.untilChat(/just dave/)));
      // Each line names its speaker as they were when they said it.
      assert.deepEqual(
        host
          .chatLog(code)
          .filter((l) => l.from === dave2.playerId)
          .map((l) => l.name),
        ["Dave 2", "Dave"],
      );
      assert.deepEqual(
        C.checkChat([host.records(), dave2.records()], {
          code,
          allowRedelivery: true,
        }),
        [],
      );
    },
  );

  await t.test(
    "a reload mid-match restores the match chat log",
    { todo: "needs reconnect (M3): a disconnect mid-match forfeits it" },
    async () => {
      const dave = await mk("Dave2");
      const sam = await mk("Sam2");
      const code = await lobby([dave, sam]);
      dave.mchat("before the reload rl1");
      sam.mchat("me too rl2");
      await dave.untilChat(/rl2/);
      // Sam's tab reloads: same person, new connection.
      sam.terminate();
      const sam2 = await mk("Sam2");
      sam2.join(code);
      await sam2.until((b) => b.code || b.notices.length, {
        label: "rejoin outcome",
      });
      await sleep(300);
      const restored = C.chatLog(sam2.records(), code).map((l) => l.text);
      assert.equal(
        dave.you.phase,
        "playing",
        `the reload ended the match: ${dave.match?.result?.text}; Sam2 notices ${JSON.stringify(sam2.notices.map((n) => n.text))}`,
      );
      assert.ok(
        restored.includes("before the reload rl1") &&
          restored.includes("me too rl2"),
        `log not restored after reload: ${JSON.stringify(restored)}`,
      );
    },
  );
});
