// Contracts 2 (authority), 8 (isolation) and 10 (resources): the golf world
// owns all world state and takes no bootstrap (golf.config.json:
// world.bootstrapRequired false). The worldserver's shared-world handshake
// used to ask the first connection for one anyway, accept ~2 MB of the
// client's own strings, push them to every player in every match and replay
// them to everyone who connected later. Now the first connection is asked for
// nothing, an upload is refused (one that size before it is even read: golf
// takes no frame over 64 KB), and nobody else receives a byte of it.
// Run: node --test test/mp/no-bootstrap.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const { setTimeout } = require("node:timers");
const { startGolfServer } = require("./server.js");
const { Bot, setupMatch } = require("./bot.js");
const C = require("./checks.js");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MARK = "mallory-says-hi-to-every-match";
const BOOTSTRAP = /^bootstrap/;

test(
  "the golf world asks nobody for a bootstrap and relays no upload",
  { timeout: 90000 },
  async (t) => {
    const srv = await startGolfServer();
    const bots = [];
    t.after(async () => {
      bots.forEach((b) => b.close());
      await srv.stop();
    });

    // First on an empty world, then in a lobby of her own.
    const mallory = new Bot(srv.url, "Mallory");
    bots.push(mallory);
    await mallory.connect();
    mallory.create();
    const code = await mallory.untilMatch();

    // An unrelated match already in play elsewhere on the server.
    const a = await setupMatch(srv.url, ["Dave", "Sam"]);
    bots.push(...a.bots);

    // ~1.9 MB of her own strings, just under bootstrapMaxBytes; then the
    // same in a frame golf reads (under its 64 KB cap).
    const upload = (n) => ({
      t: "bootstrapUpload",
      worldId: "w",
      version: 1,
      payload: {
        seed: 1,
        instances: [
          {
            kind: "prop",
            positions: Array.from({ length: n }, (_, i) => ({
              x: i,
              y: 0,
              z: 0,
              type: `${MARK} ${"x".repeat(340)}`,
            })),
          },
        ],
      },
    });
    // The big one closes the socket it came on (1009), so it comes from a
    // second connection of hers.
    const mallory2 = new Bot(srv.url, "Mallory");
    bots.push(mallory2);
    await mallory2.connect();
    mallory2.send(upload(4900));
    await mallory2.until((b) => b.closed, {
      label: "the close",
      allowClosed: true,
    });
    assert.equal(mallory2.closeInfo.code, 1009);
    mallory.send(upload(100));
    const refused = await mallory.until(
      (b) => {
        const errs = b.other.filter((o) => o.msg?.t === "err");
        return errs.length >= 1 && errs.map((o) => o.msg.code);
      },
      { label: "the refusal" },
    );
    assert.deepEqual(refused, ["BOOTSTRAP_DENIED"]);

    // A player who connects later, to a match of their own.
    const late = new Bot(srv.url, "Late");
    bots.push(late);
    await late.connect();
    late.create();
    await late.untilMatch();
    await sleep(500);

    const got = [...bots].map((b) => ({
      name: b.name,
      handshake: b.other.filter((o) => BOOTSTRAP.test(o.msg?.t ?? "")).length,
      leakedBytes: b.other
        .filter((o) => JSON.stringify(o.msg).includes(MARK))
        .reduce((n, o) => n + JSON.stringify(o.msg).length, 0),
    }));
    t.diagnostic(JSON.stringify(got));
    assert.deepEqual(
      got.filter((g) => g.handshake || g.leakedBytes),
      [],
      "bootstrap traffic in the golf world",
    );
    C.assertClean(
      C.checkIsolation([
        { code: a.code, recs: a.bots.map((b) => b.records()) },
        { code: late.code, recs: [late.records()] },
      ]),
      "isolation",
    );
    assert.equal(mallory.code, code, "still in her own lobby");
  },
);
