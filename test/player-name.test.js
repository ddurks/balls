"use strict";
// PlayerName (src/shared/name.js), read by the rest as Shared.playerName: the
// one name a player goes by in the clubhouse, on a challenge link, on the
// course and on the leaderboard. A made-up default used to re-roll on each
// page load ("Guest170 challenged you" turned out to be Guest378 on the
// course); now one is kept until the title screen sets a name.
const test = require("node:test");
const assert = require("node:assert");

function storage(init = {}) {
  const m = new Map(Object.entries(init));
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    m,
  };
}

// A fresh page: name.js and shared.js evaluated again, with this storage.
function page(ls) {
  globalThis.localStorage = ls;
  delete globalThis.PlayerName;
  for (const f of ["../src/shared/name.js", "../src/shared/shared.js"])
    delete require.cache[require.resolve(f)];
  require("../src/shared/name.js");
  return require("../src/shared/shared.js");
}

test.afterEach(() => {
  delete globalThis.localStorage;
  delete globalThis.PlayerName;
});

test("player name: a default (ball###) keeps one name from page to page", () => {
  const ls = storage();
  const first = page(ls).playerName();
  assert.match(first, /^ball\d{3}$/);
  for (let i = 0; i < 5; i++) assert.strictEqual(page(ls).playerName(), first);
});

test("player name: an old made-up Guest name gives way to a ball### default", () => {
  const ls = storage({ ballsGuestName: "Guest123" });
  assert.match(page(ls).playerName(), /^ball\d{3}$/);
});

test("player name: a chosen name wins", () => {
  const ls = storage({ ballsName: "  Dave ", ballsGuestName: "ball123" });
  assert.strictEqual(page(ls).playerName(), "Dave");
});

test("player name: set keeps a trimmed name, at most 16; blank keeps the default", () => {
  const ls = storage();
  page(ls);
  const { PlayerName } = globalThis;
  const def = PlayerName.get();
  assert.strictEqual(PlayerName.chosen(), "");
  assert.strictEqual(PlayerName.set("   "), def);
  assert.strictEqual(PlayerName.chosen(), "");
  assert.strictEqual(
    PlayerName.set("  Wanda Sykes the Third  "),
    "Wanda Sykes the",
  );
  assert.strictEqual(page(ls).playerName(), "Wanda Sykes the");
});

test("player name: with storage blocked, still one name per page", () => {
  const Shared = page({
    getItem() {
      throw new Error("blocked");
    },
    setItem() {
      throw new Error("blocked");
    },
  });
  const n = Shared.playerName();
  assert.match(n, /^ball\d{3}$/);
  assert.strictEqual(Shared.playerName(), n);
});
