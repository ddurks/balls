// Contracts 9 (bounded, normalized match chat) and 10 (bounded snapshots),
// live with protocol bots on a private server: whatever a client sends as its
// name, chat or lobby churn, every line stays normalized and short and every
// other member's snapshot stays small. And contract 5: two players in a match
// never read the same, even when one name only adds an invisible character,
// spells an accent another way (é precomposed, or e + a combining acute) or
// borrows a Cyrillic or Greek letter drawn like a Latin one, and the number
// that tells them apart doesn't follow a player out of that match.
// Run: node --test test/mp/names-and-bounds.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const { setTimeout } = require("node:timers");
const { startGolfServer } = require("./server.js");
const { Bot, lobby } = require("./bot.js");
const C = require("./checks.js");

const PORT = 7846;
const MAX_SNAPSHOT = 32 * 1024;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// eslint-disable-next-line no-control-regex
const C0_C1 = /[\u0000-\u001f\u007f-\u009f]/;
// What a reader sees: format characters, default-ignorables and the blank
// Braille cell draw nothing.
const seen = (s) =>
  s.replace(/[\p{Cf}\p{Default_Ignorable_Code_Point}\u2800]/gu, "");

test(
  "names, chat and lobby churn stay bounded and normalized",
  { timeout: 120000 },
  async (t) => {
    const srv = await startGolfServer({
      port: PORT,
      env: { GOLF_TURN_TIMEOUT_MS: "1500", GOLF_FINISHED_LINGER_MS: "20000" },
    });
    const all = [];
    t.after(async () => {
      all.forEach((b) => b.close());
      await srv.stop();
    });
    const mk = async (n) => {
      const b = new Bot(srv.url, n);
      await b.connect();
      all.push(b);
      return b;
    };
    const maxBytes = (b, from = 0) =>
      Math.max(...b.snaps.slice(from).map((s) => s.bytes));

    await t.test(
      "a player's name can't break the system chat lines",
      async () => {
        // A newline + a fake result, a bell, and 20k characters of padding.
        const evil = "  Sam\nDave2 wins by forfeit\u0007" + "x".repeat(20000);
        const dave = await mk("Dave2");
        const sam = await mk(evil);
        await lobby([dave, sam]);
        // Nobody shoots: turn timeouts concede holes, which writes name lines.
        await dave.untilPhase("finished", { timeout: 30000 });
        await sleep(200);
        const log = dave.chatLog().filter((l) => !l.from);
        const bad = log.filter(
          (l) =>
            Array.from(l.text).length > 200 ||
            C0_C1.test(l.text) ||
            l.text !== l.text.trim(),
        );
        assert.deepEqual(bad, []);
        assert.equal(
          dave.match.names[sam.playerId],
          "Sam Dave2 wins by forfei",
        ); // 24 code points
        assert.ok(!log.some((l) => l.text === "Dave2 wins by forfeit"));
        assert.deepEqual(C.checkChat([dave.records(), sam.records()]), []);
        assert.ok(
          maxBytes(dave) <= MAX_SNAPSHOT,
          `snapshot of ${maxBytes(dave)} bytes`,
        );
      },
    );

    await t.test(
      "a name near golf's frame cap costs the other members nothing; one past it is refused",
      async () => {
        const host = await mk("Host");
        host.create();
        const code = await host.untilMatch();
        const big = await mk("N".repeat(60000)); // a join frame under 64 KB
        big.join(code);
        await big.untilMatch();
        await sleep(1000);
        const names = host.you.players.map((p) => p.name);
        assert.deepEqual(names, ["Host", "N".repeat(24)]);
        assert.ok(maxBytes(host) < 2048, `snapshot of ${maxBytes(host)} bytes`);
        // A 1 MiB join frame is refused before it is read: no player at all.
        const huge = new Bot(srv.url, "N".repeat(1 << 20));
        all.push(huge);
        const joined = huge.connect({ timeout: 10000 }).then(
          () => true,
          () => false,
        );
        await huge.until((b) => b.other.some((o) => o.msg?.t === "err"), {
          label: "refusal",
        });
        huge.terminate();
        assert.equal(await joined, false);
        assert.deepEqual(
          huge.other.map((o) => o.msg?.code),
          ["FRAME_TOO_LARGE"],
        );
      },
    );

    await t.test(
      "a ready-toggle flood can't inflate another member's snapshot",
      async () => {
        const host = await mk("Hal");
        host.create();
        const code = await host.untilMatch();
        const g = await mk("Griefer");
        g.join(code);
        await g.untilMatch();
        await sleep(300);
        const n0 = host.snaps.length;
        const f0 = host.feed.length;
        for (let i = 0; i < 20000; i++) g.ready(i % 2 === 0);
        await sleep(2000);
        const perSnap = host.snaps
          .slice(n0)
          .map((s) => s.you?.feed?.length ?? 0);
        t.diagnostic(
          `feed lines delivered: ${host.feed.length - f0}; most in one snapshot: ${Math.max(...perSnap)}`,
        );
        assert.ok(Math.max(...perSnap) <= 20);
        assert.ok(
          maxBytes(host, n0) < 4096,
          `snapshot of ${maxBytes(host, n0)} bytes`,
        );
      },
    );

    for (const [label, twin] of [
      ["a zero-width space", "Dave\u200b"],
      ["a word joiner", "\u2060Dave"],
      ["a Hangul filler", "Dave\u3164"],
      ["a variation selector", "Dave\ufe0f"],
    ])
      await t.test(
        `an opponent who joins as Dave + ${label} is numbered`,
        async () => {
          const dave = await mk("Dave");
          const twinBot = await mk(twin);
          await lobby([dave, twinBot]);
          const names = Object.values(dave.match.names).map(seen);
          const line = dave.chatLog().find((l) => /^Match play/.test(l.text));
          assert.notEqual(
            names[0],
            names[1],
            `both read as ${JSON.stringify(names[0])}; "${seen(line.text)}"`,
          );
          assert.equal(seen(line.text), "Match play, 3 holes: Dave vs Dave 2");
        },
      );

    for (const [label, taken, twin] of [
      ["the same accent spelled another way", "Jos\u00e9", "Jose\u0301"],
      ["a Cyrillic a", "Dave", "D\u0430ve"],
    ])
      await t.test(
        `an opponent whose name differs from yours only by ${label} is numbered`,
        async () => {
          const host = await mk(taken);
          const guest = await mk(twin);
          await lobby([host, guest]);
          const line = host.chatLog().find((l) => /^Match play/.test(l.text));
          assert.equal(line.text, `Match play, 3 holes: ${taken} vs ${twin} 2`);
          assert.deepEqual(Object.values(host.match.names), [
            taken,
            `${twin} 2`,
          ]);
        },
      );

    await t.test(
      "a number that told two names apart stays in that match",
      async () => {
        const daveA = await mk("Dave");
        const daveB = await mk("Dave");
        const sam = await mk("Sam");
        const eve = await mk("Dave 2");
        const nameIn = (b) =>
          b.you.players.find((p) => p.id === b.playerId).name;
        await lobby([daveA, daveB], { start: false });
        assert.equal(nameIn(daveB), "Dave 2");
        daveB.leave();
        await daveB.until((b) => !b.code);
        // daveB hosts Sam, with no other Dave about.
        const code2 = await lobby([daveB, sam]);
        assert.deepEqual(
          daveB.you.players.map((p) => p.name),
          ["Dave", "Sam"],
        );
        const intro = await sam.untilChat(/^Match play/);
        assert.equal(intro.text, "Match play, 3 holes: Dave vs Sam");
        // daveB walks out and joins a player whose own name is "Dave 2".
        daveB.leave();
        await daveB.until((b) => b.code !== code2);
        await lobby([eve, daveB], { start: false });
        assert.deepEqual(
          eve.you.players.map((p) => p.name),
          ["Dave 2", "Dave"],
        );
      },
    );

    await t.test(
      "a name or chat line of only invisible letters is replaced or dropped",
      async () => {
        const sam = await mk("Sam");
        const ghost = await mk("\u3164\u3164");
        await lobby([sam, ghost], { start: false });
        ghost.mchat("\u3164\u115f\u1160");
        ghost.mchat("\ud800".repeat(200)); // unpaired surrogates: nothing to draw
        sam.mchat("visible");
        await Promise.all([sam, ghost].map((b) => b.untilChat(/visible/)));
        const name = sam.you.players.find((p) => p.id === ghost.playerId).name;
        assert.equal(name, "Player");
        const blank = sam.chatLog().filter((l) => !seen(l.text).trim());
        assert.deepEqual(blank, []);
        assert.deepEqual(C.checkChat([sam.records(), ghost.records()]), []);
      },
    );

    await t.test(
      "mchat drops C1 controls, bidi overrides and invisible-only lines",
      async () => {
        const ann = await mk("Ann");
        ann.create();
        await ann.untilMatch();
        ann.mchat("a\u0085b\u009bc"); // NEL and CSI are control characters (Cc)
        ann.mchat("\u200b\u200b\u200b"); // nothing visible
        ann.mchat("gg \u202ewp"); // a right-to-left override
        await sleep(400);
        assert.deepEqual(
          ann.chatLog().map((l) => l.text),
          ["a b c", "gg wp"],
        );
        assert.deepEqual(C.checkChat([ann.records()]), []);
      },
    );
  },
);
