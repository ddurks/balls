"use strict";
// game.html?rv=KEY (src/game/golfnet.js rvBoot) against a real golf world
// server (test/mp/server.js), when the waiting host's socket dies without the
// server seeing it: a phone changing networks leaves the server holding a
// half-open socket while the page sees the close and redials a second later.
// An opponent arriving in that second used to be paired with the dead socket:
// the match started against a ghost, and the host's redial was told "You left
// that match", a match it never saw.
//
// Both sides are the real rvBoot on Node's WebSocket; a TCP proxy in front of
// the host drops the client side of its connection without a FIN.
const test = require("node:test");
const assert = require("node:assert");
const net = require("node:net");
const crypto = require("node:crypto");
const timers = require("node:timers");
const { URL } = require("node:url");
const Challenge = require("../../src/shared/challenge.js");
const { startGolfServer } = require("./server.js");

const mint = () =>
  `${Date.now().toString(36)}.${crypto.randomBytes(16).toString("base64url")}`;

// Each client connection gets its own upstream socket; ghost() destroys the
// client side and leaves the upstream open and silent.
function ghostProxy(port) {
  const conns = [];
  const srv = net.createServer((c) => {
    const up = net.connect(port, "127.0.0.1");
    const e = { c, up, ghost: false };
    conns.push(e);
    c.on("data", (d) => !e.ghost && up.write(d));
    up.on("data", (d) => !e.ghost && c.write(d));
    c.on("error", () => {});
    up.on("error", () => {});
    c.on("close", () => !e.ghost && up.destroy());
    up.on("close", () => !e.ghost && c.destroy());
  });
  return new Promise((resolve) =>
    srv.listen(0, "127.0.0.1", () =>
      resolve({
        url: `ws://127.0.0.1:${srv.address().port}`,
        ghost() {
          for (const e of conns) {
            e.ghost = true;
            e.c.destroy();
          }
        },
        close() {
          for (const e of conns) e.up.destroy();
          srv.close();
        },
      }),
    ),
  );
}

// One game.html tab: a fresh golfnet.js on the globals it reads at boot.
function gameTab(key, gws, name) {
  const session = new Map();
  const splash = {
    title: null,
    update(o) {
      if ("title" in o) splash.title = o.title;
      return splash;
    },
    close() {},
  };
  Object.assign(globalThis, {
    location: {
      hostname: "localhost",
      search: `?mode=course&rv=${key}&gws=${encodeURIComponent(gws)}`,
    },
    document: { readyState: "loading", addEventListener() {} },
    addEventListener() {},
    Splash: { show: (o) => splash.update(o) },
    Challenge,
    Shared: {
      roomFX: { leave() {} },
      playerName: () => name,
    },
    sessionStorage: {
      getItem: (k) => (session.has(k) ? session.get(k) : null),
      setItem: (k, v) => session.set(k, String(v)),
    },
    window: { crypto: crypto.webcrypto },
    history: { replaceState() {} },
  });
  delete require.cache[require.resolve("../../src/game/golfnet.js")];
  require("../../src/game/golfnet.js").rvBoot(key);
  return { net: globalThis.golfNet, splash };
}

async function until(cond, ms) {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) return false;
    await new Promise((r) => timers.setTimeout(r, 25));
  }
  return true;
}

test(
  "rv: an opponent arriving while the host's socket is silently dead meets the host",
  { timeout: 120000 },
  async (t) => {
    // rvBoot's own timers (the key's 15-minute TTL among them) mustn't keep
    // this file's process alive once the test is over.
    const realSetTimeout = globalThis.setTimeout;
    globalThis.setTimeout = (...a) => {
      const h = realSetTimeout(...a);
      if (h && h.unref) h.unref();
      return h;
    };
    t.after(() => (globalThis.setTimeout = realSetTimeout));
    const srv = await startGolfServer();
    t.after(() => srv.stop());
    const proxy = await ghostProxy(Number(new URL(srv.url).port));
    t.after(() => proxy.close());

    const key = mint();
    const alice = gameTab(key, proxy.url, "Alice");
    t.after(() => alice.net.close());
    assert.ok(
      await until(() => alice.net.you && alice.net.you.matchCode, 20000),
      "the host never got its lobby",
    );

    proxy.ghost(); // her page sees the close; the server doesn't
    const bob = gameTab(key, srv.url, "Bob"); // lands inside her 1 s redial wait
    t.after(() => bob.net.close());

    const settled = (n) => ["started", "failed", "left"].includes(n.rv.state);
    await until(() => settled(alice.net) && settled(bob.net), 20000);
    const seen = (tab) => ({
      state: tab.net.rv.state,
      title: tab.splash.title,
      match: tab.net.you && tab.net.you.matchCode,
      players: tab.net.you && (tab.net.you.players || []).map((p) => p.name),
    });
    t.diagnostic(JSON.stringify({ alice: seen(alice), bob: seen(bob) }));
    assert.strictEqual(alice.net.rv.state, "started", alice.splash.title);
    assert.strictEqual(bob.net.rv.state, "started", bob.splash.title);
    assert.strictEqual(alice.net.you.matchCode, bob.net.you.matchCode);
    assert.strictEqual(alice.net.you.phase, "playing");
    assert.deepStrictEqual(alice.net.you.players.map((p) => p.name).sort(), [
      "Alice",
      "Bob",
    ]);
  },
);
