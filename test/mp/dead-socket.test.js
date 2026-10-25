// Contract 3 (liveness): a member whose network dies silently (no FIN, no
// RST: a phone leaving Wi-Fi) leaves the match once the server's pings have
// gone unanswered for GOLF_PING_TIMEOUT_MS (45 s by default; 6 s here), just
// as if it had closed. Before, nothing removed it short of the kernel giving
// up on the socket (~15 min of retransmits on Linux), and meanwhile:
// - a guest who came back on a new connection was numbered "Sam 2" beside
//   its own ghost, and the lobby of three could never start;
// - a dead host stayed host, so the ready guest could never start;
// - a challenge's dead host captured the opponent in a lobby that waited on
//   the host's word to start, which never came.
// A member that is merely quiet on a slow link answers its pings and stays.
// Each cut is tcp-link.js halfOpen(): the link stops forwarding, both
// sockets stay open.
// Run: node --test test/mp/dead-socket.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { setTimeout } = require("node:timers");
const { startGolfServer } = require("./server.js");
const { startTcpLink } = require("./tcp-link.js");
const { Bot, lobby } = require("./bot.js");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PORT = 7843;
const PING_TIMEOUT_MS = 6000;
// The ping in flight when the link dies was sent up to ~0.6 s earlier; the
// rest is slack for a loaded machine.
const WITHIN_MS = PING_TIMEOUT_MS + 6000;

test(
  "a member whose network died silently is dropped once its pings go unanswered",
  { timeout: 5 * 60 * 1000 },
  async (t) => {
    const srv = await startGolfServer({
      port: PORT,
      env: {
        GOLF_PING_TIMEOUT_MS: String(PING_TIMEOUT_MS),
        GOLF_TURN_TIMEOUT_MS: "600000",
      },
    });
    const open = [];
    t.after(async () => {
      for (const x of open) await x.close();
      await srv.stop();
    });
    const link = async (cfg = {}) => {
      const l = await startTcpLink(srv.url, {
        up: { latencyMs: 40 },
        down: { latencyMs: 40 },
        ...cfg,
      });
      open.push(l);
      return l;
    };
    const bot = async (url, name) => {
      const b = new Bot(url, name);
      open.push(b);
      await b.connect();
      return b;
    };

    await t.test(
      "a guest's ghost leaves the lobby, so its rejoin makes two and the match starts",
      async () => {
        const l = await link();
        const dave = await bot(srv.url, "Dave");
        const sam = await bot(l.url, "Sam");
        const code = await lobby([dave, sam], { start: false });
        l.halfOpen(); // Sam's network is gone; his page redials on a new one
        const deadAt = Date.now();
        const sam2 = await bot(srv.url, "Sam");
        sam2.join(code);
        await sam2.untilMatch();
        sam2.ready(true);
        assert.deepEqual(
          sam2.you.players.map((p) => p.name),
          ["Dave", "Sam", "Sam 2"],
        );
        await dave.until(
          (b) =>
            b.you.players.length === 2 && b.you.players.every((p) => p.ready),
          { timeout: WITHIN_MS, label: "the ghost to leave" },
        );
        t.diagnostic(`ghost gone after ${Date.now() - deadAt} ms`);
        assert.ok(Date.now() - deadAt >= PING_TIMEOUT_MS - 1000);
        assert.ok(dave.feed.some((f) => f.text === "Sam disconnected"));
        dave.start();
        await dave.untilPhase("playing");
        assert.deepEqual(Object.values(dave.match.names), ["Dave", "Sam 2"]);
      },
    );

    await t.test(
      "a host's ghost leaves the lobby and the waiting guest becomes host",
      async () => {
        const l = await link();
        const dave = await bot(l.url, "Dave");
        const sam = await bot(srv.url, "Sam");
        await lobby([dave, sam], { start: false });
        l.halfOpen();
        await sam.until(
          (b) => b.you.hostId === sam.playerId && b.you.players.length === 1,
          { timeout: WITHIN_MS, label: "the host to pass to Sam" },
        );
        assert.ok(sam.feed.some((f) => f.text === "Sam is now the host"));
      },
    );

    await t.test(
      "a challenge's dead host leaves; its redial is paired and the match starts",
      async () => {
        const key = `${Date.now().toString(36)}.${crypto.randomBytes(16).toString("base64url")}`;
        const l = await link();
        const dave = await bot(l.url, "Dave");
        const sam = await bot(srv.url, "Sam");
        dave.action("rv", { message: key, direction: 11 });
        await dave.untilMatch();
        // While Dave waits, his network dies; his waiting page sends nothing,
        // so it doesn't notice. Sam arrives and is seated with the ghost.
        l.halfOpen();
        await sleep(1500);
        sam.action("rv", { message: key, direction: 22 });
        await sam.untilMatch();
        assert.equal(sam.you.players.length, 2);
        await sam.until(
          (b) => b.you.hostId === sam.playerId && b.you.players.length === 1,
          { timeout: WITHIN_MS, label: "the dead host to leave" },
        );
        assert.equal(sam.you.phase, "lobby");
        // Dave's page redials with its token: Sam's page, the host now, sees
        // him arrive and says the key again, and the challenge starts.
        const dave2 = await bot(srv.url, "Dave");
        dave2.action("rv", { message: key, direction: 11 });
        await dave2.untilMatch();
        await sam.until((b) => b.you.players.length === 2);
        sam.action("rv", { message: key, direction: 22 });
        await Promise.all([dave2, sam].map((b) => b.untilPhase("playing")));
        assert.deepEqual(
          Object.keys(sam.match.names).sort(),
          [sam.playerId, dave2.playerId].sort(),
        );
      },
    );

    await t.test(
      "a player whose network dies mid-match forfeits it once the pings go unanswered",
      async () => {
        const l = await link();
        const dave = await bot(srv.url, "Dave");
        const sam = await bot(l.url, "Sam");
        await lobby([dave, sam]);
        l.halfOpen();
        const deadAt = Date.now();
        await dave.untilPhase("finished", { timeout: WITHIN_MS });
        t.diagnostic(`forfeit after ${Date.now() - deadAt} ms`);
        assert.deepEqual(dave.match.result, {
          winner: dave.playerId,
          text: "Dave wins by forfeit",
          reason: "forfeit",
        });
        await dave.untilChat(/^Sam disconnected$/);
      },
    );

    await t.test(
      "a member that is only quiet, on a slow link, answers its pings and stays",
      async () => {
        const l = await link({
          up: { latencyMs: 150, jitterMs: 100, bytesPerSec: 2000 },
          down: { latencyMs: 150, jitterMs: 100, bytesPerSec: 3000 },
        });
        const dave = await bot(srv.url, "Dave");
        const sam = await bot(l.url, "Sam");
        await lobby([dave, sam], { start: false });
        // Dave chats away; Sam's link carries it all, slowly, and Sam says
        // nothing at all.
        for (let i = 0; i < 6; i++) {
          dave.mchat(`line ${i} ${"x".repeat(150)}`);
          await sleep((2 * PING_TIMEOUT_MS) / 6);
        }
        await sam.untilChat(/^line 5 /, { timeout: 15000 });
        assert.equal(dave.you.players.length, 2);
        assert.ok(!sam.closed);
        assert.equal(sam.sent.filter((s) => s.msg?.t === "action").length, 2); // join, ready
      },
    );
  },
);
