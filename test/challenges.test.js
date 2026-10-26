"use strict";
// The clubhouse challenge flow (src/clubhouse/challenges.js) against scripted
// server answers, as the clubhouse server sends them (worldserver
// games/clubhouse/engine.ts; its jest suite pins that side). Each test is a
// race the live clients lost before.
const test = require("node:test");
const assert = require("node:assert");
const { URL, URLSearchParams } = require("node:url");
const Challenge = require("../src/shared/challenge.js");
const ClubChallenges = require("../src/clubhouse/challenges.js");

const T0 = Date.UTC(2026, 9, 25, 12);
const KEY = "mvni9g4j.djCGELvMSvdu6jmPYiykVw";
const keyAt = (ms) => `${ms.toString(36)}.djCGELvMSvdu6jmPYiykVw`;

function fakeSplash() {
  let current = null;
  const Splash = {
    show(opts) {
      if (current) current.close();
      const s = {
        title: opts.title,
        detail: opts.detail,
        image: opts.image,
        field: opts.field,
        buttons: opts.buttons || [],
        focus: opts.focus,
        closed: false,
        update(o) {
          for (const k of ["title", "detail", "image", "field", "list"])
            if (k in o) s[k] = o[k];
          if ("buttons" in o) s.buttons = o.buttons || [];
          return s;
        },
        close() {
          s.closed = true;
          if (current === s) current = null;
        },
        press(label) {
          const b = s.buttons.find((x) => x.label === label);
          assert.ok(b, `no "${label}" on "${s.title}"`);
          if (b.onClick) b.onClick(s);
        },
      };
      current = s;
      return s;
    },
    get current() {
      return current;
    },
  };
  return Splash;
}

// A localStorage stand-in; pass one to two club() pages to make them tabs of
// the same browser.
function memoryStorage() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
  };
}

// One clubhouse page: Alice, with Bob ("b") and Cat ("c") in the room.
function club(
  t,
  { search = "", now = T0, navigator = {}, storage = memoryStorage() } = {},
) {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now });
  const sent = [];
  const busy = []; // challengeBusy flags sent, in order
  const resumed = []; // tokens sent with resume
  const net = {
    playerId: "a1",
    offline: false,
    clockSkew: null,
    sendChallenge: (id, req) => sent.push(["challenge", id, req]),
    cancelChallenge: (id) => sent.push(["cancel", id]),
    replyChallenge: (id, ok) => sent.push(["reply", id, ok]),
    requestChallengeLink: (req) => sent.push(["link", req]),
    setChallengeBusy: (b) => busy.push(b),
    resume: (token) => resumed.push(token),
  };
  const hints = [];
  const went = [];
  const replaced = [];
  const splash = fakeSplash();
  const portrait = () => Promise.resolve(null);
  const ch = ClubChallenges.create({
    net,
    token: 99,
    splash,
    hint: (h) => hints.push(h),
    nameOf: (id) => ({ b: "Bob", c: "Cat" })[id],
    portraits: { player: portrait, link: portrait, phone: portrait },
    myName: "Alice",
    goToCourse: (url) => went.push(url),
    storage,
    location: {
      origin: "http://localhost:3000",
      pathname: "/index.html",
      search,
      hash: "",
    },
    history: { replaceState: (_s, _t, url) => replaced.push(url) },
    navigator,
  });
  const msg = (type, data) => ch.onMessage({ type, data });
  return { ch, net, sent, busy, resumed, hints, went, replaced, splash, msg };
}

const goneTo = (url) => new URLSearchParams(url.split("?")[1]).get("rv");
const vsOf = (url) => new URLSearchParams(url.split("?")[1]).get("vs");

// The cancel crosses Bob's accept on the wire: the server took the accept,
// so challengeGo reaches both, and Alice's cancel lands on nothing. Before,
// Alice dropped the go and Bob waited alone on the course for 15 minutes.
test("challenges: a cancel that lost the race to an accept still goes to the course", (t) => {
  const { ch, sent, went, splash, msg } = club(t);
  ch.tapPlayer("b");
  splash.current.press("Confirm");
  msg("challengeSent", { id: "c1", toId: "b", toName: "Bob", req: 1 });
  splash.current.press("Cancel");
  assert.deepStrictEqual(sent, [
    ["challenge", "b", 1],
    ["cancel", "c1"],
  ]);
  assert.strictEqual(ch.state, null);
  msg("challengeGo", { id: "c1", rv: KEY });
  assert.deepStrictEqual(went.map(goneTo), [KEY]);
  assert.strictEqual(splash.current.title, "Bob accepted first! Teeing it up…");
});

test("challenges: same race when Cancel beat the challenge id home", (t) => {
  const { sent, went, splash, msg, ch } = club(t);
  ch.tapPlayer("b");
  splash.current.press("Confirm");
  splash.current.press("Cancel"); // nothing to cancel yet
  msg("challengeSent", { id: "c1", toId: "b", toName: "Bob", req: 1 });
  assert.deepStrictEqual(sent.at(-1), ["cancel", "c1"]);
  msg("challengeGo", { id: "c1", rv: KEY });
  assert.deepStrictEqual(went.map(goneTo), [KEY]);
});

test("challenges: a go for a challenge that isn't ours is ignored", (t) => {
  const { went, msg, ch } = club(t);
  msg("challengeGo", { id: "c9", rv: KEY });
  assert.deepStrictEqual(went, []);
  assert.strictEqual(ch.state, null);
});

// Confirm, Cancel, Confirm before the first answer: the server holds c1 and
// refuses the second request. Before, the second wait adopted c1's id and
// the refusal ("Bob is busy") ended it, orphaning c1, which Bob then
// accepted and was stranded on the course.
test("challenges: Confirm, Cancel, Confirm: each answer goes to its own request", (t) => {
  const { ch, sent, hints, splash, msg } = club(t);
  ch.tapPlayer("b");
  splash.current.press("Confirm");
  splash.current.press("Cancel");
  ch.tapPlayer("b");
  splash.current.press("Confirm");
  msg("challengeSent", { id: "c1", toId: "b", toName: "Bob", req: 1 });
  assert.deepStrictEqual(sent.at(-1), ["cancel", "c1"]); // the orphan is called off
  assert.strictEqual(ch.state.kind, "wait"); // the second wait isn't c1's
  assert.strictEqual(ch.state.id, null);
  msg("challengeEnd", { id: null, reason: "slow", req: 2 });
  assert.strictEqual(ch.state, null);
  assert.deepStrictEqual(hints, ["Slow down a sec"]);
  assert.strictEqual(splash.current, null);
});

test("challenges: a refusal of an earlier request doesn't end the current one", (t) => {
  const { ch, splash, msg } = club(t);
  ch.tapPlayer("b");
  splash.current.press("Confirm");
  splash.current.press("Cancel");
  ch.tapPlayer("c");
  splash.current.press("Confirm");
  msg("challengeEnd", { id: null, reason: "busy", req: 1 });
  assert.strictEqual(ch.state.kind, "wait");
  assert.strictEqual(ch.state.name, "Cat");
  msg("challengeSent", { id: "c2", toId: "c", toName: "Cat", req: 2 });
  assert.strictEqual(ch.state.id, "c2");
  msg("challengeEnd", { id: "c2", reason: "declined" });
  assert.strictEqual(ch.state, null);
});

test("challenges: a pair backoff refusal reads as one", (t) => {
  const { ch, hints, splash, msg } = club(t);
  ch.tapPlayer("b");
  splash.current.press("Confirm");
  msg("challengeEnd", { id: null, reason: "later", req: 1 });
  assert.deepStrictEqual(hints, ["Give Bob a minute"]);
});

// The incoming splash must not be answerable by the key the player was
// about to press (it took focus from the chat box, and a space accepted).
test("challenges: an incoming challenge doesn't take keyboard focus", (t) => {
  const { ch, splash, msg, sent } = club(t);
  msg("challenge", { id: "c5", fromId: "c", fromName: "Cat" });
  assert.strictEqual(splash.current.title, "Cat challenged you. Accept?");
  assert.strictEqual(splash.current.focus, false);
  splash.current.press("Accept");
  assert.deepStrictEqual(sent, [["reply", "c5", true]]);
  assert.strictEqual(ch.state.kind, "incoming");
});

// Alice's socket drops and ClubhouseNet redials under a new player id: the
// server ended her challenge with the old id, and nothing will ever reach
// the new one about it. Before, "Waiting for Bob…" stayed up forever.
test("challenges: a new connection drops what was pending on the old one", (t) => {
  const { ch, net, hints, splash, msg } = club(t);
  ch.connected();
  ch.tapPlayer("b");
  splash.current.press("Confirm");
  msg("challengeSent", { id: "c1", toId: "b", toName: "Bob", req: 1 });
  ch.connected(); // the same welcome again (idempotent join): nothing lost
  assert.strictEqual(ch.state.id, "c1");
  net.playerId = "a2";
  ch.connected();
  assert.strictEqual(ch.state, null);
  assert.deepStrictEqual(hints, ["Lost the clubhouse connection"]);
  assert.strictEqual(splash.current, null);

  msg("challenge", { id: "c7", fromId: "c", fromName: "Cat" });
  net.playerId = "a3";
  ch.connected();
  assert.strictEqual(ch.state, null);
});

test("challenges: a challenge the server never closes lapses on its own", (t) => {
  const { ch, hints, splash, msg } = club(t);
  ch.tapPlayer("b");
  splash.current.press("Confirm");
  msg("challengeSent", { id: "c1", toId: "b", toName: "Bob", req: 1 });
  t.mock.timers.tick(ClubChallenges.LAPSE_MS - 1);
  assert.strictEqual(ch.state.kind, "wait");
  t.mock.timers.tick(1);
  assert.strictEqual(ch.state, null);
  assert.deepStrictEqual(hints, ["Bob didn't answer"]);

  msg("challenge", { id: "c2", fromId: "c", fromName: "Cat" });
  t.mock.timers.tick(ClubChallenges.LAPSE_MS);
  assert.strictEqual(ch.state, null);
});

// Peeking at the phone used to mint a key every time, sharing the challenge
// rate limit: a quick second look popped the splash and shut it again with
// "Slow down a sec".
test("challenges: the wall phone reuses its key for a quick second look", (t) => {
  const { ch, sent, splash, msg } = club(t);
  ch.tapPhone();
  assert.deepStrictEqual(sent, [["link", 1]]);
  msg("challengeLink", { rv: KEY, req: 1 });
  assert.strictEqual(ch.state.key, KEY);
  splash.current.press("Cancel");
  t.mock.timers.tick(30_000);
  ch.tapPhone();
  assert.strictEqual(sent.length, 1);
  assert.strictEqual(ch.state.key, KEY);
  splash.current.press("Cancel");
  t.mock.timers.tick(ClubChallenges.LINK_REUSE_MS);
  ch.tapPhone(); // stale by now: a fresh one
  assert.deepStrictEqual(sent.at(-1), ["link", 2]);
  assert.strictEqual(ch.state.key, null);
});

test("challenges: re-opening the phone while its key is on the way waits for it", (t) => {
  const { ch, sent, splash, msg } = club(t);
  ch.tapPhone();
  splash.current.press("Cancel");
  ch.tapPhone();
  assert.deepStrictEqual(sent, [["link", 1]]);
  msg("challengeLink", { rv: KEY, req: 1 });
  assert.strictEqual(ch.state.kind, "phone");
  assert.strictEqual(ch.state.key, KEY);
  assert.strictEqual(splash.current.closed, false);
});

test("challenges: a phone waiting on a key asks again on a new connection", (t) => {
  const { ch, net, sent } = club(t);
  ch.connected();
  ch.tapPhone();
  net.playerId = "a2";
  ch.connected();
  assert.deepStrictEqual(sent, [
    ["link", 1],
    ["link", 2],
  ]);
  assert.strictEqual(ch.state.kind, "phone");
});

test("challenges: tapping a player while the phone is up does nothing", (t) => {
  const { ch, sent } = club(t);
  ch.tapPhone();
  ch.tapPlayer("b");
  assert.strictEqual(ch.state.kind, "phone");
  assert.deepStrictEqual(sent, [["link", 1]]);
});

// A challenge link is judged on the server's clock: this phone runs 16
// minutes fast, which used to read a fresh link as expired.
test("challenges: a link's expiry goes by the server clock", (t) => {
  const fast = 16 * 60 * 1000;
  const key = keyAt(T0);
  const search = `?challenge=${key}&from=Bob&ws=ws%3A%2F%2Flocalhost%3A7910`;
  const { ch, net, splash, went, replaced } = club(t, {
    search,
    now: T0 + fast,
  });
  ch.start();
  assert.strictEqual(splash.current, null); // waiting for the server clock
  net.clockSkew = -fast;
  ch.snapshot();
  assert.strictEqual(splash.current.title, "Bob challenged you. Accept?");
  splash.current.press("Accept");
  assert.deepStrictEqual(replaced, [
    "/index.html?ws=ws%3A%2F%2Flocalhost%3A7910",
  ]);
  assert.strictEqual(went.length, 1);
  const q = new URLSearchParams(went[0].split("?")[1]);
  assert.strictEqual(q.get("rv"), key);
  assert.strictEqual(q.get("ws"), "ws://localhost:7910");
  ch.snapshot(); // later snapshots don't reopen it
  assert.strictEqual(ch.state.kind, "go");
});

test("challenges: a link the server clock calls expired says so, even if this clock disagrees", (t) => {
  const key = keyAt(T0);
  const slow = 20 * 60 * 1000;
  const { ch, net, splash } = club(t, {
    search: `?challenge=${key}&from=Bob`,
    now: T0 + 60_000,
  });
  ch.start();
  net.clockSkew = slow;
  ch.snapshot();
  assert.strictEqual(splash.current.title, "Bob's challenge expired");
});

test("challenges: offline, a link falls back on this device's clock", (t) => {
  const { ch, splash } = club(t, {
    search: `?challenge=${keyAt(T0)}&from=Bob`,
    now: T0 + 60_000,
  });
  ch.start();
  assert.strictEqual(ch.state.kind, "link"); // holds off player taps meanwhile
  t.mock.timers.tick(4000);
  assert.strictEqual(splash.current.title, "Bob challenged you. Accept?");
  splash.current.press("Decline");
  assert.strictEqual(ch.state, null);
});

// A share often lands in your own chat thread. Opened there (another tab of
// the same browser), the link offered "Alice challenged you. Accept?", and
// accepting paired the waiting tab with the new one, spending the key meant
// for the friend.
test("challenges: your own link opened in another tab isn't yours to accept", (t) => {
  const storage = memoryStorage();
  const key = keyAt(T0);
  const phone = club(t, { storage });
  phone.ch.tapPhone();
  phone.msg("challengeLink", { rv: key, req: 1 });
  t.mock.timers.reset();
  const { ch, net, splash, went, replaced } = club(t, {
    search: `?challenge=${key}&from=Alice`,
    storage,
  });
  ch.start();
  net.clockSkew = 0;
  ch.snapshot();
  assert.strictEqual(splash.current.title, "That's your own challenge link");
  assert.deepStrictEqual(
    splash.current.buttons.map((b) => b.label),
    ["OK"],
  );
  splash.current.press("OK");
  assert.deepStrictEqual(went, []);
  assert.deepStrictEqual(replaced, ["/index.html"]);
  assert.strictEqual(ch.state, null);
  // a friend's link in the same browser is still theirs to accept
  t.mock.timers.reset();
  const other = club(t, {
    search: `?challenge=${keyAt(T0 + 1)}&from=Bob`,
    storage,
  });
  other.ch.start();
  other.net.clockSkew = 0;
  other.ch.snapshot();
  assert.strictEqual(other.splash.current.title, "Bob challenged you. Accept?");
});

test("challenges: an ordinary visit has no link to open", (t) => {
  const { ch, net, splash } = club(t, { search: "?ws=x" });
  ch.start();
  net.clockSkew = 0;
  ch.snapshot();
  t.mock.timers.tick(5000);
  assert.strictEqual(splash.current, null);
  assert.strictEqual(ch.state, null);
});

// Dan opened Yul's challenge link; while "Yul challenged you. Accept?" was up,
// Xan tapped him. Xan's prompt replaced the offer, and once Dan declined it
// the offer was gone for good, with Yul waiting alone on the course.
test("challenges: a tap challenge can't sweep a friend's link offer away", (t) => {
  const { ch, net, sent, busy, splash, msg } = club(t, {
    search: `?challenge=${keyAt(T0)}&from=Yul`,
    now: T0 + 60_000,
  });
  ch.start();
  assert.deepStrictEqual(busy, [true]); // the server refuses tap challenges meanwhile
  net.clockSkew = 0;
  ch.snapshot();
  assert.strictEqual(splash.current.title, "Yul challenged you. Accept?");
  // one sent before our busy flag landed
  msg("challenge", { id: "x1", fromId: "c", fromName: "Xan" });
  assert.deepStrictEqual(sent, [["reply", "x1", "busy"]]);
  assert.strictEqual(splash.current.title, "Yul challenged you. Accept?");
  splash.current.press("Decline");
  assert.deepStrictEqual(busy, [true, false]);
  assert.strictEqual(ch.state, null);
});

test("challenges: the wall phone is busy too, until it's put down", (t) => {
  const { ch, sent, busy, splash, msg } = club(t);
  ch.tapPhone();
  assert.deepStrictEqual(busy, [true]);
  msg("challenge", { id: "x1", fromId: "c", fromName: "Cat" });
  assert.deepStrictEqual(sent.at(-1), ["reply", "x1", "busy"]);
  assert.strictEqual(ch.state.kind, "phone");
  splash.current.press("Cancel");
  assert.deepStrictEqual(busy, [true, false]);
  // a challenge that arrives as we leave for the course is answered at once
  ch.tapPlayer("b");
  splash.current.press("Confirm");
  msg("challengeSent", { id: "c1", toId: "b", toName: "Bob", req: 2 });
  msg("challengeGo", { id: "c1", rv: KEY });
  msg("challenge", { id: "x2", fromId: "c", fromName: "Cat" });
  assert.deepStrictEqual(sent.at(-1), ["reply", "x2", "busy"]);
  assert.deepStrictEqual(busy, [true, false]);
});

test("challenges: every connection names this tab and restates busy", (t) => {
  const { ch, net, busy, resumed } = club(t);
  ch.connected();
  assert.deepStrictEqual(resumed, [99]);
  assert.deepStrictEqual(busy, []);
  ch.tapPhone();
  net.playerId = "a2";
  ch.connected();
  assert.deepStrictEqual(resumed, [99, 99]);
  assert.deepStrictEqual(busy, [true, true]);
});

// Alice's socket dropped just as Bob accepted: the go went down with it, she
// redialed with "Lost the clubhouse connection", and Bob waited alone on the
// course. The server now re-sends that go to her tab on the new connection.
test("challenges: a go re-sent after a reconnect still takes the challenger to the course", (t) => {
  const { ch, net, hints, went, splash, msg } = club(t);
  ch.connected();
  ch.tapPlayer("b");
  splash.current.press("Confirm");
  msg("challengeSent", { id: "c1", toId: "b", toName: "Bob", req: 1 });
  net.playerId = "a2";
  ch.connected();
  assert.deepStrictEqual(hints, ["Lost the clubhouse connection"]);
  assert.strictEqual(ch.state, null);
  msg("challengeGo", { id: "c1", rv: KEY });
  assert.deepStrictEqual(went.map(goneTo), [KEY]);
  assert.deepStrictEqual(went.map(vsOf), ["Bob"]);
  assert.strictEqual(splash.current.title, "Bob accepted! Teeing it up…");
});

test("challenges: so does the accepter's, when their socket dropped after Accept", (t) => {
  const { ch, net, went, splash, msg } = club(t);
  ch.connected();
  msg("challenge", { id: "c5", fromId: "c", fromName: "Cat" });
  splash.current.press("Accept");
  net.playerId = "a2";
  ch.connected();
  msg("challengeGo", { id: "c5", rv: KEY });
  assert.deepStrictEqual(went.map(vsOf), ["Cat"]);
  // and after the 8 s fallback gave up on it too
  t.mock.timers.reset();
  const b = club(t);
  b.msg("challenge", { id: "c6", fromId: "c", fromName: "Cat" });
  b.splash.current.press("Accept");
  t.mock.timers.tick(8000);
  assert.strictEqual(b.ch.state, null);
  b.msg("challengeGo", { id: "c6", rv: KEY });
  assert.deepStrictEqual(b.went.map(goneTo), [KEY]);
});

test("challenges: only a go we were waiting on, and only for a while", (t) => {
  const { ch, net, went, msg, splash } = club(t);
  ch.connected();
  msg("challenge", { id: "c7", fromId: "c", fromName: "Cat" }); // never answered
  net.playerId = "a2";
  ch.connected();
  msg("challengeGo", { id: "c7", rv: KEY });
  assert.deepStrictEqual(went, []);
  ch.tapPlayer("b");
  splash.current.press("Confirm");
  msg("challengeSent", { id: "c8", toId: "b", toName: "Bob", req: 1 });
  net.playerId = "a3";
  ch.connected();
  t.mock.timers.tick(ClubChallenges.GO_HONOUR_MS);
  msg("challengeGo", { id: "c8", rv: KEY });
  assert.deepStrictEqual(went, []);
});

test("challenges: a tap challenge tells the course who's coming; a link doesn't", (t) => {
  const { ch, went, splash, msg } = club(t);
  ch.tapPlayer("b");
  splash.current.press("Confirm");
  msg("challengeSent", { id: "c1", toId: "b", toName: "Bob", req: 1 });
  msg("challengeGo", { id: "c1", rv: KEY });
  assert.deepStrictEqual(went.map(vsOf), ["Bob"]);
  t.mock.timers.reset();
  const l = club(t, {
    search: `?challenge=${keyAt(T0)}&from=Yul`,
    now: T0 + 60_000,
  });
  l.ch.start();
  t.mock.timers.tick(4000);
  l.splash.current.press("Accept");
  assert.deepStrictEqual(l.went.map(vsOf), [null]);
});

// Landscape phone: the link to copy by hand shrank to about 7 px.
test("challenges: a refused clipboard shows the link in a field, portrait out of the way", async (t) => {
  const { ch, splash, msg } = club(t, {
    navigator: {
      clipboard: { writeText: () => Promise.reject(new Error("no")) },
    },
  });
  ch.tapPhone();
  msg("challengeLink", { rv: KEY, req: 1 });
  splash.current.press("Send link");
  for (let i = 0; i < 3; i++) await null; // the clipboard's refusal
  const s = splash.current;
  assert.strictEqual(s.title, "Copy this link");
  assert.strictEqual(s.image, undefined); // hidden (null is a placeholder)
  assert.strictEqual(s.detail, "");
  assert.strictEqual(new URL(s.field).searchParams.get("challenge"), KEY);
  assert.deepStrictEqual(
    s.buttons.map((b) => b.label),
    ["Go wait", "Cancel"],
  );
});

// After "copied" the splash used to close for the 1.5 s before the hop, and
// a door tapped in that gap took the challenger to a plain room while the
// friend who opened the link waited alone on the course.
test("challenges: a copied link keeps the splash up until the hop, and the room knows we're leaving", async (t) => {
  const { ch, went, splash, msg } = club(t, {
    navigator: { clipboard: { writeText: () => Promise.resolve() } },
  });
  ch.tapPhone();
  msg("challengeLink", { rv: KEY, req: 1 });
  const s = splash.current;
  s.press("Send link");
  assert.strictEqual(ch.leaving, false); // not until the link is out
  for (let i = 0; i < 3; i++) await null;
  assert.strictEqual(splash.current, s);
  assert.strictEqual(s.closed, false);
  assert.strictEqual(s.title, "Challenge link copied!");
  assert.deepStrictEqual(s.buttons, []);
  assert.strictEqual(ch.leaving, true);
  t.mock.timers.tick(1499);
  assert.deepStrictEqual(went, []);
  t.mock.timers.tick(1);
  assert.deepStrictEqual(went.map(goneTo), [KEY]);
  assert.strictEqual(s.title, "Teeing it up…");
});

// A share sheet like the browsers': one at a time, closed by the player.
function shareSheet() {
  let open = null;
  const calls = [];
  return {
    calls,
    share(data) {
      calls.push(data.url);
      if (open)
        return Promise.reject(
          Object.assign(new Error("An earlier share has not yet completed."), {
            name: "InvalidStateError",
          }),
        );
      return new Promise((resolve, reject) => {
        open = { resolve, reject };
      });
    },
    close(sent) {
      const o = open;
      open = null;
      if (sent) o.resolve();
      else
        o.reject(
          Object.assign(new Error("Share canceled"), { name: "AbortError" }),
        );
    },
  };
}

// A double tap on Send link called share twice; the second was refused
// (InvalidStateError) and taken for "no sharing here": the link was copied
// and the player sent to the course while the first sheet was still open,
// whether or not they then sent it.
test("challenges: a double tap on Send link, then closing the share sheet, stays put", async (t) => {
  const sheet = shareSheet();
  const { ch, went, hints, splash, msg } = club(t, {
    navigator: {
      share: (d) => sheet.share(d),
      clipboard: { writeText: () => Promise.resolve() },
    },
  });
  ch.tapPhone();
  msg("challengeLink", { rv: KEY, req: 1 });
  const phone = splash.current;
  phone.press("Send link");
  phone.press("Send link");
  assert.strictEqual(sheet.calls.length, 1);
  sheet.close(false);
  for (let i = 0; i < 5; i++) await null;
  t.mock.timers.tick(2000);
  for (let i = 0; i < 5; i++) await null;
  assert.deepStrictEqual(went, [], `hints: ${hints.join(" | ")}`);
  assert.strictEqual(phone.closed, false);
  assert.strictEqual(ch.state.kind, "phone");
  phone.press("Send link"); // and Send link works again
  assert.strictEqual(sheet.calls.length, 2);
  sheet.close(true);
  for (let i = 0; i < 3; i++) await null;
  assert.deepStrictEqual(went.map(goneTo), [KEY]);
});

test("challenges: a share sheet already open elsewhere is no reason to copy", async (t) => {
  const sheet = shareSheet();
  sheet.share({ url: "elsewhere" }); // another sheet is up
  let copies = 0;
  const { ch, went, splash, msg } = club(t, {
    navigator: {
      share: (d) => sheet.share(d),
      clipboard: { writeText: () => (copies++, Promise.resolve()) },
    },
  });
  ch.tapPhone();
  msg("challengeLink", { rv: KEY, req: 1 });
  splash.current.press("Send link");
  for (let i = 0; i < 5; i++) await null;
  t.mock.timers.tick(2000);
  assert.strictEqual(copies, 0);
  assert.deepStrictEqual(went, []);
  assert.strictEqual(splash.current.title, "Challenge a friend?");
});

// Sanity: the helpers above agree with the real key format.
test("challenges: test keys are well-formed", () => {
  assert.ok(Challenge.isKey(KEY));
  assert.strictEqual(Challenge.keyMintedAt(keyAt(T0)), T0);
});
