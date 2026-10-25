"use strict";
// game.html?rv=KEY (src/game/golfnet.js rvBoot): meeting the challenge
// opponent on the golf server, against a scripted socket. The server side of
// the rendezvous is pinned by the worldserver's golf.rendezvous jest suite.
const test = require("node:test");
const assert = require("node:assert");
const Challenge = require("../src/shared/challenge.js");

const T0 = Date.UTC(2026, 9, 25, 12);
const keyAt = (ms, tail = "djCGELvMSvdu6jmPYiykVw") =>
  `${ms.toString(36)}.${tail}`;

class FakeSocket {
  constructor(url) {
    this.url = url;
    this.readyState = 0;
    this.sent = [];
    this.closeFns = [];
    FakeSocket.all.push(this);
  }
  send(s) {
    this.sent.push(JSON.parse(s));
  }
  addEventListener(type, fn) {
    if (type === "close") this.closeFns.push(fn);
  }
  close() {
    if (this.readyState === 3) return;
    this.readyState = 3;
    for (const f of this.closeFns) f();
  }
  // server side
  open() {
    this.readyState = 1;
    this.onopen();
  }
  welcome(playerId) {
    this.onmessage({ data: JSON.stringify({ t: "welcome", playerId }) });
  }
  you(you) {
    this.onmessage({ data: JSON.stringify({ t: "gameSnapshot", you }) });
  }
  rvSent() {
    return this.sent.filter((m) => m.action === "rv");
  }
}
FakeSocket.OPEN = 1;

function fakeSplash() {
  const s = {
    title: null,
    detail: "",
    buttons: [],
    closed: false,
    update(o) {
      for (const k of ["title", "detail"]) if (k in o) s[k] = o[k];
      if ("buttons" in o) s.buttons = o.buttons || [];
      return s;
    },
    close() {
      s.closed = true;
    },
    press(label) {
      s.buttons.find((b) => b.label === label).onClick(s);
    },
  };
  return { show: (o) => s.update(o), s };
}

// One game.html tab. `session` stands in for the tab's sessionStorage, so a
// reload is another boot() with the same one.
function tab(
  t,
  { now = T0, session = new Map(), hostname = "localhost", search = "" } = {},
) {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now });
  FakeSocket.all = [];
  const splash = fakeSplash();
  const left = [];
  const winListeners = {};
  const store = (m) => ({
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
  });
  Object.assign(globalThis, {
    location: { hostname, search: "?mode=course&rv=x" + search },
    document: { readyState: "loading", addEventListener() {} },
    addEventListener: (type, fn) =>
      (winListeners[type] = winListeners[type] || []).push(fn),
    WebSocket: FakeSocket,
    Splash: splash,
    Challenge,
    Shared: {
      roomFX: { leave: (url) => left.push(url) },
      playerName: () => "Dave",
    },
    localStorage: store(new Map([["ballsName", "Dave"]])),
    sessionStorage: store(session),
    window: { crypto: require("node:crypto").webcrypto },
  });
  delete require.cache[require.resolve("../src/game/golfnet.js")];
  const { rvBoot } = require("../src/game/golfnet.js");
  const sock = () => FakeSocket.all.at(-1);
  return {
    boot: (key, vs) => rvBoot(key, vs),
    net: () => globalThis.golfNet,
    sock,
    splash: splash.s,
    left,
    session,
    fire: (type) => (winListeners[type] || []).forEach((f) => f({})),
  };
}

const actions = (sock) => sock.sent.map((m) => m.action || m.t);

test.afterEach(() => {
  for (const k of [
    "location",
    "document",
    "addEventListener",
    "WebSocket",
    "Splash",
    "Shared",
    "localStorage",
    "sessionStorage",
    "window",
    "golfNet",
  ])
    delete globalThis[k];
});

test("rv: arrives with the key and this tab's own token, then waits", (t) => {
  const { boot, net, sock, splash } = tab(t);
  const key = keyAt(T0);
  boot(key);
  sock().open();
  sock().welcome("p1");
  const [rv] = sock().rvSent();
  assert.strictEqual(rv.message, key);
  assert.ok(Number.isSafeInteger(rv.direction) && rv.direction > 0);
  assert.strictEqual(net().rv.state, "waiting");
  sock().you({ matchCode: "ABCD", phase: "lobby" });
  assert.strictEqual(net().rv.state, "waiting");
  sock().you({ matchCode: "ABCD", phase: "playing" });
  assert.strictEqual(net().rv.state, "started");
  assert.strictEqual(splash.closed, true);
});

// The server starts a rendezvous match on the host's word once the opponent
// is in: a host it only thinks is connected (a half-open socket) never gives
// it, so the opponent isn't paired with a dead socket.
test("rv: as host, says go once its opponent is in, once per opponent", (t) => {
  const { boot, net, sock } = tab(t);
  const key = keyAt(T0);
  boot(key);
  sock().open();
  sock().welcome("p1");
  const lobby = (...ids) =>
    sock().you({
      matchCode: "ABCD",
      phase: "lobby",
      hostId: "p1",
      players: ids.map((id) => ({ id, ready: true })),
    });
  lobby("p1");
  assert.strictEqual(sock().rvSent().length, 1);
  lobby("p1", "p2");
  const [, go] = sock().rvSent();
  assert.deepStrictEqual(go, sock().rvSent()[0]); // the same key and token
  lobby("p1", "p2"); // a feed line: still the same opponent
  assert.strictEqual(sock().rvSent().length, 2);
  lobby("p1", "p3"); // that one dropped, another connection of theirs is in
  assert.strictEqual(sock().rvSent().length, 3);
  sock().you({ matchCode: "ABCD", phase: "playing", hostId: "p1" });
  assert.strictEqual(net().rv.state, "started");
});

test("rv: the joining side leaves the start to the host, until it is the host", (t) => {
  const { boot, sock } = tab(t);
  boot(keyAt(T0));
  sock().open();
  sock().welcome("p2");
  const lobby = (hostId, ...ids) =>
    sock().you({
      matchCode: "ABCD",
      phase: "lobby",
      hostId,
      players: ids.map((id) => ({ id, ready: true })),
    });
  lobby("p1", "p1", "p2");
  assert.strictEqual(sock().rvSent().length, 1);
  lobby("p2", "p2"); // the host's old socket was dropped: we host now
  assert.strictEqual(sock().rvSent().length, 1);
  lobby("p2", "p2", "p1b"); // and its redial joined us
  assert.strictEqual(sock().rvSent().length, 2);
});

test("rv: after a redial the host says go again", (t) => {
  const { boot, sock } = tab(t);
  boot(keyAt(T0));
  sock().open();
  sock().welcome("p1");
  const lobby = () =>
    sock().you({
      matchCode: "ABCD",
      phase: "lobby",
      hostId: "p1",
      players: [{ id: "p1" }, { id: "p2" }],
    });
  lobby();
  sock().close(); // the go may have gone down with it
  t.mock.timers.tick(1000);
  sock().open();
  sock().welcome("p1"); // a server that kept our id (tests only)
  lobby();
  assert.strictEqual(sock().rvSent().length, 2);
});

// A redial or a reload must come back as the same side, or the server pairs
// the host with its own lingering old socket.
test("rv: the token survives a reload of the tab, and differs per key", (t) => {
  const session = new Map();
  const key = keyAt(T0);
  let a = tab(t, { session });
  a.boot(key);
  a.sock().open();
  a.sock().welcome("p1");
  const first = a.sock().rvSent()[0].direction;
  t.mock.timers.reset();
  a = tab(t, { session });
  a.boot(key);
  a.sock().open();
  a.sock().welcome("p2");
  assert.strictEqual(a.sock().rvSent()[0].direction, first);
  t.mock.timers.reset();
  a = tab(t, { session });
  a.boot(keyAt(T0, "x".repeat(22)));
  a.sock().open();
  a.sock().welcome("p3");
  assert.notStrictEqual(a.sock().rvSent()[0].direction, first);
});

// This device's clock runs 16 minutes fast: the key looks expired to it,
// but not to the server. Before, the splash said "Nobody showed up" at once
// while the welcome flipped the state back to waiting and hosted anyway.
test("rv: a skewed device clock doesn't give up on a key the server still takes", (t) => {
  const { boot, net, sock, splash } = tab(t, { now: T0 + 16 * 60_000 });
  boot(keyAt(T0));
  sock().open();
  sock().welcome("p1");
  assert.strictEqual(net().rv.state, "waiting");
  assert.strictEqual(splash.title, "Waiting for your opponent…");
  t.mock.timers.tick(Challenge.RV_TTL_MS - 1);
  assert.strictEqual(net().rv.state, "waiting");
  t.mock.timers.tick(1);
  assert.strictEqual(net().rv.state, "failed");
  assert.strictEqual(splash.title, "Nobody showed up");
});

test("rv: the server's refusal is what the player sees", (t) => {
  const { boot, net, sock, splash } = tab(t);
  boot(keyAt(T0));
  sock().open();
  sock().welcome("p1");
  sock().you({ matchCode: null, notice: "You left that match" });
  assert.strictEqual(net().rv.state, "failed");
  assert.strictEqual(splash.title, "You left that match");
  assert.deepStrictEqual(
    splash.buttons.map((b) => b.label),
    ["Clubhouse"],
  );
});

// The host's word to start went out and its connection died before the
// match reached it: the server forfeited a seat this page never saw taken.
test("rv: a redial whose seat went with the old connection says so, not that we left", (t) => {
  const { boot, net, sock, splash } = tab(t);
  boot(keyAt(T0));
  sock().open();
  sock().welcome("p1");
  sock().close();
  t.mock.timers.tick(1000);
  sock().open();
  sock().welcome("p1b");
  sock().you({ matchCode: null, notice: "You left that match" });
  assert.strictEqual(net().rv.state, "failed");
  assert.strictEqual(splash.title, "Lost the connection as the match started");
});

test("rv: a welcome after giving up or leaving doesn't host a match", (t) => {
  const { boot, net, sock, splash, left } = tab(t);
  boot(keyAt(T0));
  sock().open();
  splash.press("Leave");
  assert.strictEqual(net().rv.state, "left");
  sock().welcome("p1");
  assert.strictEqual(net().rv.state, "left");
  assert.deepStrictEqual(sock().rvSent(), []);
  assert.strictEqual(left.length, 1);
});

// A deploy can keep the golf server down longer than five quick redials.
// Before, the waiting player gave up for good and the opponent who arrived
// after the restart hosted a match nobody would join.
test("rv: keeps redialing through a long outage while the key lives", (t) => {
  const { boot, net, sock, splash } = tab(t);
  boot(keyAt(T0));
  sock().open();
  sock().welcome("p1");
  const token = sock().rvSent()[0].direction;
  sock().you({ matchCode: "ABCD", phase: "lobby" });
  for (let i = 0; i < 12; i++) {
    sock().close(); // the server is down: every dial fails
    assert.strictEqual(net().rv.state, "connecting");
    assert.strictEqual(net().you, null);
    t.mock.timers.tick(8000);
  }
  assert.strictEqual(splash.detail, "Reconnecting to the course…");
  sock().open();
  sock().welcome("p9");
  assert.strictEqual(net().rv.state, "waiting");
  assert.strictEqual(splash.detail, "");
  assert.deepStrictEqual(sock().rvSent()[0].direction, token);
});

// Leave used to only hang up, which the server took for a dropped connection:
// the key went back to unused and whoever came next (the friend with the link,
// the accepter whose course loaded slower) hosted a match nobody would join.
test("rv: Leave while waiting tells the server before hanging up", (t) => {
  const { boot, net, sock, splash, left } = tab(t);
  boot(keyAt(T0));
  const s = sock();
  s.open();
  s.welcome("p1");
  s.you({ matchCode: "ABCD", phase: "lobby" });
  splash.press("Leave");
  assert.deepStrictEqual(actions(s), ["auth", "join", "rv", "leave"]);
  assert.strictEqual(s.readyState, 3);
  assert.strictEqual(net().rv.state, "left");
  assert.strictEqual(left.length, 1);
});

test("rv: closing or leaving the page while waiting is leaving too", (t) => {
  const { boot, sock, fire } = tab(t);
  boot(keyAt(T0));
  sock().open();
  sock().welcome("p1");
  fire("pagehide");
  assert.deepStrictEqual(actions(sock()), ["auth", "join", "rv", "leave"]);
});

// A reload of the waiting page: until pagehide (a second or more into the
// reload on a busy page) the old page still held its place as host, so an
// opponent arriving then started the match and the dying page forfeited it.
test("rv: a reload calls the wait off as soon as it begins", (t) => {
  const { boot, sock, fire } = tab(t);
  boot(keyAt(T0));
  sock().open();
  sock().welcome("p1");
  fire("beforeunload");
  assert.deepStrictEqual(actions(sock()), ["auth", "join", "rv", "leave"]);
});

test("rv: once the match is on, leaving the page is no withdrawal", (t) => {
  const { boot, sock, fire } = tab(t);
  boot(keyAt(T0));
  sock().open();
  sock().welcome("p1");
  sock().you({ matchCode: "ABCD", phase: "playing" });
  fire("beforeunload");
  fire("pagehide");
  assert.deepStrictEqual(actions(sock()), ["auth", "join", "rv"]);
});

// The close handler only cared while meeting: after the start a dropped
// socket left golfNet saying started/playing on a match the server had
// already forfeited, with nothing on screen.
test("rv: a match whose connection drops says so, and golfNet stops claiming it", (t) => {
  const { boot, net, sock, splash } = tab(t);
  boot(keyAt(T0));
  sock().open();
  sock().welcome("p1");
  sock().you({ matchCode: "ABCD", phase: "playing" });
  assert.strictEqual(net().rv.state, "started");
  sock().close();
  assert.strictEqual(net().rv.state, "failed");
  assert.strictEqual(net().you, null);
  assert.strictEqual(splash.title, "Lost the connection to the match");
  assert.deepStrictEqual(
    splash.buttons.map((b) => b.label),
    ["Clubhouse"],
  );
  assert.strictEqual(FakeSocket.all.length, 1); // no rejoin in M1: no redial
});

test("rv: a finished match's connection dropping changes nothing", (t) => {
  const { boot, net, sock, splash } = tab(t);
  boot(keyAt(T0));
  sock().open();
  sock().welcome("p1");
  sock().you({ matchCode: "ABCD", phase: "playing" });
  sock().you({ matchCode: "ABCD", phase: "finished" });
  const title = splash.title;
  sock().close();
  assert.strictEqual(net().rv.state, "started");
  assert.strictEqual(net().you.phase, "finished");
  assert.strictEqual(splash.title, title);
});

// A tap challenge's opponent was in the room seconds ago. If their clubhouse
// socket dropped just as the accept landed (or their page closed), they never
// come; before, this side waited out the key's 15 minutes.
test("rv: a clubhouse challenge's opponent who doesn't turn up is called a no-show", (t) => {
  const { boot, net, sock, splash } = tab(t);
  const { ARRIVE_MS } = require("../src/game/golfnet.js");
  boot(keyAt(T0), "Alice");
  sock().open();
  sock().welcome("p1");
  sock().you({ matchCode: "ABCD", phase: "lobby" });
  t.mock.timers.tick(ARRIVE_MS - 1);
  assert.strictEqual(net().rv.state, "waiting");
  t.mock.timers.tick(1);
  assert.strictEqual(net().rv.state, "failed");
  assert.strictEqual(splash.title, "Alice didn't make it");
  assert.deepStrictEqual(actions(sock()).at(-1), "leave"); // calls it off
  assert.deepStrictEqual(
    splash.buttons.map((b) => b.label),
    ["Clubhouse"],
  );
});

// The golf server down for 100 s (a deploy) while both players of a tap
// challenge load: ARRIVE_MS ran from page load, so each was told the OTHER
// "didn't make it" under a stale "Reconnecting to the course…", and when the
// server came back neither arrived.
test("rv: a golf outage doesn't run down the opponent's time to arrive", (t) => {
  const { boot, net, sock, splash } = tab(t);
  const { ARRIVE_MS } = require("../src/game/golfnet.js");
  boot(keyAt(T0), "Bob");
  for (let ms = 0; ms < ARRIVE_MS + 10_000; ms += 250) {
    if (sock().readyState === 0) sock().close(); // every dial fails
    t.mock.timers.tick(250);
  }
  assert.strictEqual(net().rv.state, "connecting");
  assert.strictEqual(splash.title, "Waiting for your opponent…");
  t.mock.timers.tick(8000); // the server is back
  sock().open();
  sock().welcome("p1");
  assert.deepStrictEqual(actions(sock()), ["auth", "join", "rv"]);
  assert.strictEqual(splash.detail, "");
  // and from here on Bob has his full time
  t.mock.timers.tick(ARRIVE_MS - 1);
  assert.strictEqual(net().rv.state, "waiting");
  t.mock.timers.tick(1);
  assert.strictEqual(splash.title, "Bob didn't make it");
});

test("rv: arrival time spent waiting before a drop still counts after it", (t) => {
  const { boot, net, sock, splash } = tab(t);
  const { ARRIVE_MS } = require("../src/game/golfnet.js");
  boot(keyAt(T0), "Bob");
  sock().open();
  sock().welcome("p1");
  t.mock.timers.tick(ARRIVE_MS - 5000);
  sock().close();
  t.mock.timers.tick(60_000); // redials failing meanwhile
  for (const s of FakeSocket.all) if (s.readyState === 0) s.close();
  t.mock.timers.tick(8000);
  sock().open();
  sock().welcome("p2");
  t.mock.timers.tick(4999);
  assert.strictEqual(net().rv.state, "waiting");
  t.mock.timers.tick(1);
  assert.strictEqual(splash.title, "Bob didn't make it");
});

test("rv: a key that runs out while the course is unreachable says so, not who's to blame", (t) => {
  const { boot, net, sock, splash } = tab(t, { now: T0 + 14 * 60_000 });
  boot(keyAt(T0), "Bob");
  for (let ms = 0; ms < 70_000; ms += 250) {
    if (sock().readyState === 0) sock().close();
    t.mock.timers.tick(250);
  }
  assert.strictEqual(net().rv.state, "failed");
  assert.strictEqual(splash.title, "Can't reach the course");
  assert.strictEqual(splash.detail, ""); // not under "Reconnecting to the course…"
});

test("rv: the course server override is honoured on a dev host only", (t) => {
  const search = "&gws=" + encodeURIComponent("wss://evil.example");
  let a = tab(t, { search });
  a.boot(keyAt(T0));
  assert.strictEqual(a.sock().url, "wss://evil.example");
  t.mock.timers.reset();
  a = tab(t, { hostname: "balls.drawvid.com", search });
  a.boot(keyAt(T0));
  assert.strictEqual(a.sock().url, "wss://balls-golf.drawvid.com");
});

test("rv: a malformed key fails without dialing", (t) => {
  const { boot, net, splash } = tab(t);
  boot("not-a-key");
  assert.strictEqual(net().rv.state, "failed");
  assert.strictEqual(splash.title, "That challenge link is broken");
  assert.strictEqual(FakeSocket.all.length, 0);
});
