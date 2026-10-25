"use strict";
// src/shared/splash.js against a minimal fake DOM (no jsdom in this repo):
// focus handling, Escape, and the double-tap guard. Layout (the long-title
// fit) needs a real browser and is checked live.
const test = require("node:test");
const assert = require("node:assert");
const { performance } = require("node:perf_hooks");

function fakeDom() {
  const doc = { activeElement: null };
  function el(tag) {
    const e = {
      tagName: tag.toUpperCase(),
      className: "",
      style: { setProperty() {} },
      children: [],
      parent: null,
      attrs: {},
      listeners: {},
      disabled: false,
      classList: { add() {}, remove() {} },
      setAttribute(k, v) {
        e.attrs[k] = v;
      },
      removeAttribute(k) {
        delete e.attrs[k];
      },
      appendChild(c) {
        c.parent = e;
        e.children.push(c);
        return c;
      },
      append(...cs) {
        for (const c of cs) e.appendChild(c);
      },
      remove() {
        if (e.parent)
          e.parent.children = e.parent.children.filter((c) => c !== e);
        e.parent = null;
      },
      addEventListener(t, f) {
        (e.listeners[t] = e.listeners[t] || []).push(f);
      },
      focus() {
        doc.activeElement = e;
      },
      getBoundingClientRect: () => ({ top: 0, bottom: 0, height: 0 }),
      // detail: 0 for keyboard / scripted clicks, 1+ for a pointer's
      click(detail = 0) {
        for (const f of e.listeners.click || [])
          f({ detail, stopPropagation() {} });
      },
      // only the selector splash.js uses to find its "go" button
      querySelector(sel) {
        if (!sel.startsWith(".splash-btn")) return null;
        return (
          e.children.find(
            (c) =>
              /\bsplash-btn\b/.test(c.className) &&
              !/\bstop\b/.test(c.className) &&
              !c.disabled,
          ) || null
        );
      },
    };
    let text = "";
    Object.defineProperty(e, "textContent", {
      get: () => text,
      set: (v) => {
        text = String(v);
        e.children = [];
      },
    });
    return e;
  }
  doc.createElement = el;
  doc.head = el("head");
  doc.body = el("body");
  return doc;
}

// Loads a fresh splash.js into a fake page; returns it plus the page's
// window-level listeners (splash.js listens for Escape on window).
function page() {
  const doc = fakeDom();
  const winListeners = {};
  const frames = [];
  const saved = {};
  const globals = {
    document: doc,
    addEventListener(t, f) {
      (winListeners[t] = winListeners[t] || []).push(f);
    },
    removeEventListener(t, f) {
      winListeners[t] = (winListeners[t] || []).filter((g) => g !== f);
    },
    requestAnimationFrame(f) {
      frames.push(f);
    },
  };
  for (const k of Object.keys(globals)) saved[k] = globalThis[k];
  Object.assign(globalThis, globals);
  delete require.cache[require.resolve("../src/shared/splash.js")];
  const Splash = require("../src/shared/splash.js");
  const key = (k, target) => {
    const ev = {
      key: k,
      target,
      stopped: false,
      preventDefault() {},
      stopPropagation() {
        ev.stopped = true;
      },
    };
    for (const f of winListeners.keydown || []) f(ev);
    return ev.stopped;
  };
  const restore = () => Object.assign(globalThis, saved);
  // the next animation frame: the splash is drawn
  const frame = () => frames.splice(0).forEach((f) => f());
  return { doc, Splash, key, frame, restore };
}

// A finger going down on the splash; `timeStamp` (performance.now()'s clock)
// is when it happened, however much later this handler runs.
const press = (s, timeStamp) =>
  s.el.listeners.pointerdown.forEach((f) =>
    f({ timeStamp, stopPropagation() {} }),
  );

const btn = (s, label) =>
  s.el.children[0].children
    .find((c) => c.className === "splash-btns")
    .children.find((b) => b.textContent === label);

function challengeSplash(Splash, log, extra = {}) {
  return Splash.show({
    title: "Alice challenged you. Accept?",
    ...extra,
    buttons: [
      { label: "Accept", kind: "go", onClick: () => log.push("accept") },
      {
        label: "Decline",
        kind: "stop",
        cancel: true,
        onClick: (s) => {
          log.push("decline");
          s.close();
        },
      },
    ],
  });
}

// Live, Bob was typing "hello world" when Alice's challenge landed: the
// splash focused Accept, the chat box's blur sent "hello", and the space
// pressed Accept, carrying Bob into a match he never saw offered.
test("splash: never takes focus from a text field being typed in", () => {
  const { doc, Splash, restore } = page();
  try {
    const chat = doc.createElement("input");
    doc.body.appendChild(chat);
    chat.focus();
    const log = [];
    challengeSplash(Splash, log);
    assert.strictEqual(doc.activeElement, chat);
    assert.deepStrictEqual(log, []);
  } finally {
    restore();
  }
});

// Live, Amy was typing "i think my password is hun" when Bix challenged her;
// the press on Decline moved focus to the button, and the chat box's blur
// (which sends, for Safari's Done key) posted the half-typed line to the room.
test("splash: pressing it doesn't move focus out of a text field being typed in", () => {
  const { doc, Splash, restore } = page();
  try {
    const chat = doc.createElement("input");
    doc.body.appendChild(chat);
    const log = [];
    const s = challengeSplash(Splash, log, { focus: false });
    const field = s.el.children[0].children.find(
      (c) => c.className === "splash-field",
    );
    const mousedown = (target) => {
      const ev = {
        target,
        prevented: false,
        preventDefault: () => (ev.prevented = true),
      };
      for (const f of s.el.listeners.mousedown) f(ev);
      return ev.prevented;
    };
    chat.focus();
    assert.strictEqual(mousedown(btn(s, "Decline")), true);
    assert.strictEqual(mousedown(field), false); // a link to copy is still selectable
    doc.activeElement = null;
    assert.strictEqual(mousedown(btn(s, "Decline")), false);
  } finally {
    restore();
  }
});

test("splash: Escape typed into a text field is the field's, not a Decline", () => {
  const { doc, Splash, key, restore } = page();
  try {
    const chat = doc.createElement("textarea");
    const log = [];
    const s = challengeSplash(Splash, log);
    assert.strictEqual(key("Escape", chat), false);
    assert.deepStrictEqual(log, []);
    assert.strictEqual(s.closed, false);
    key("Escape", doc.body); // Escape anywhere else still declines
    assert.deepStrictEqual(log, ["decline"]);
    assert.strictEqual(s.closed, true);
  } finally {
    restore();
  }
});

// The clipboard refused a share link: it's shown in a read-only field to copy
// by hand, which the player taps into. Escape there still cancels.
test("splash: a link field is read-only, shown only when set, and Escape still cancels", () => {
  const { Splash, key, restore } = page();
  try {
    const log = [];
    const s = challengeSplash(Splash, log);
    const field = s.el.children[0].children.find(
      (c) => c.className === "splash-field",
    );
    assert.strictEqual(field.readOnly, true);
    assert.strictEqual(field.style.display, "none");
    s.update({ field: "https://example.test/index.html?challenge=k" });
    assert.strictEqual(
      field.value,
      "https://example.test/index.html?challenge=k",
    );
    assert.strictEqual(field.style.display, "");
    field.focus();
    key("Escape", field);
    assert.deepStrictEqual(log, ["decline"]);
  } finally {
    restore();
  }
});

test("splash: focus:false leaves focus alone; a requested splash focuses its go button", () => {
  const { doc, Splash, restore } = page();
  try {
    const log = [];
    challengeSplash(Splash, log, { focus: false });
    assert.strictEqual(doc.activeElement, null);
    const s = Splash.show({
      title: "Challenge Bob?",
      buttons: [
        { label: "Confirm", kind: "go" },
        { label: "Cancel", kind: "stop", cancel: true },
      ],
    });
    assert.strictEqual(doc.activeElement, btn(s, "Confirm"));
  } finally {
    restore();
  }
});

test("splash: a double tap on a button doesn't land on the one that replaces it", () => {
  const { Splash, restore } = page();
  const realNow = Date.now;
  let now = 1_000_000;
  Date.now = () => now;
  try {
    const log = [];
    const s = Splash.show({
      title: "Challenge Bob?",
      buttons: [
        {
          label: "Confirm",
          kind: "go",
          onClick: () => {
            log.push("confirm");
            s.update({
              title: "Waiting for Bob…",
              buttons: [
                {
                  label: "Cancel",
                  kind: "stop",
                  cancel: true,
                  onClick: () => log.push("cancel"),
                },
              ],
            });
          },
        },
        { label: "Cancel", kind: "stop", cancel: true },
      ],
    });
    btn(s, "Confirm").click(1); // already on its way when the splash came up
    assert.deepStrictEqual(log, []);
    now += 400;
    btn(s, "Confirm").click(1);
    now += 120; // the double-click's second click, on the new Cancel
    btn(s, "Cancel").click(2);
    assert.deepStrictEqual(log, ["confirm"]);
    now += 400; // a deliberate tap later works
    btn(s, "Cancel").click(1);
    assert.deepStrictEqual(log, ["confirm", "cancel"]);
  } finally {
    Date.now = realNow;
    restore();
  }
});

// Live, on the 3D clubhouse in a phone-sized headless Chrome: the incoming
// splash was first drawn 1.2 s after show(), and a walk tap whose finger went
// down 87 ms after that had its click handled 900 ms later. Judged by when
// the handler ran, it looked deliberate and accepted the challenge.
test("splash: a tap is judged by when the splash was drawn and when the finger went down", (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
  const { Splash, frame, restore } = page();
  t.after(restore);
  const log = [];
  const s = challengeSplash(Splash, log, { focus: false });
  t.mock.timers.tick(1200); // a slow frame: not on screen yet
  frame();
  t.mock.timers.tick(900); // the page is busy...
  press(s, performance.now() - 813); // ...with a press from 87 ms after it was drawn
  btn(s, "Accept").click(1);
  assert.deepStrictEqual(log, []);
  t.mock.timers.tick(100);
  press(s, performance.now()); // a tap long after it was drawn
  btn(s, "Accept").click(1);
  assert.deepStrictEqual(log, ["accept"]);
});

test("splash: keyboard presses aren't held back by the double-tap guard", () => {
  const { doc, Splash, key, restore } = page();
  try {
    const log = [];
    const s = challengeSplash(Splash, log);
    btn(s, "Accept").click(0); // Enter / Space on the focused button
    key("Escape", doc.body);
    assert.deepStrictEqual(log, ["accept", "decline"]);
  } finally {
    restore();
  }
});

// The real challenge flow (src/clubhouse/challenges.js) on this splash.
function room(t) {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 5_000_000 });
  const { Splash, restore } = page();
  t.after(restore);
  require("../src/shared/challenge.js");
  delete require.cache[require.resolve("../src/clubhouse/challenges.js")];
  const ClubChallenges = require("../src/clubhouse/challenges.js");
  const sent = [];
  const went = [];
  const portrait = () => new Promise(() => {});
  const ch = ClubChallenges.create({
    net: {
      playerId: "a1",
      offline: false,
      clockSkew: 0,
      sendChallenge: (id, req) => sent.push(["challenge", id, req]),
      cancelChallenge: (id) => sent.push(["cancel", id]),
      replyChallenge: (id, ok) => sent.push(["reply", id, ok]),
      requestChallengeLink: (req) => sent.push(["link", req]),
      setChallengeBusy() {},
      resume() {},
    },
    token: 7,
    splash: Splash,
    hint() {},
    nameOf: (id) => ({ b: "Bob", c: "Cat" })[id],
    portraits: { player: portrait, link: portrait, phone: portrait },
    myName: "Alice",
    goToCourse: (url) => went.push(url),
    location: {
      origin: "http://localhost:3000",
      pathname: "/index.html",
      search: "",
      hash: "",
    },
    history: { replaceState() {} },
    navigator: {},
  });
  const incoming = () =>
    ch.onMessage({
      type: "challenge",
      data: { id: "c7", fromId: "c", fromName: "Cat" },
    });
  return { ch, Splash, sent, went, incoming };
}

// Live (real mouse, 60-250 ms): Cat's challenge replaced Alice's own
// "Challenge Bob?" while her click was on its way to Confirm. Accept sits in
// the same spot, so she went to the course with Cat, never having seen the
// offer.
test("splash: a click meant for Confirm doesn't accept the challenge that just replaced it", (t) => {
  const { ch, Splash, sent, went, incoming } = room(t);
  ch.tapPlayer("b");
  const ask = Splash.current;
  t.mock.timers.tick(2000);
  assert.ok(btn(ask, "Confirm"));
  incoming();
  const offer = Splash.current;
  assert.notStrictEqual(offer, ask);
  t.mock.timers.tick(250);
  btn(offer, "Accept").click(1);
  btn(offer, "Decline").click(1); // nor a Cancel in flight declines it unseen
  assert.deepStrictEqual(sent, []);
  assert.deepStrictEqual(went, []);
  t.mock.timers.tick(150); // once it's been up a moment, a tap is a tap
  btn(offer, "Accept").click(1);
  assert.deepStrictEqual(sent, [["reply", "c7", true]]);
});

// Live on a phone: a walk tap landing 80 ms after the challenge popped up
// took Ben into a match with Ali.
test("splash: a walk tap already on its way doesn't accept a challenge that just popped up", (t) => {
  const { Splash, sent, went, incoming } = room(t);
  incoming();
  t.mock.timers.tick(80);
  btn(Splash.current, "Accept").click(1);
  assert.deepStrictEqual(sent, []);
  assert.deepStrictEqual(went, []);
});
