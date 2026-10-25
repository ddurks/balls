"use strict";
// Shared.playerName (src/shared/shared.js): the one name a player goes by in
// the clubhouse, on a challenge link and on the course. Nothing sets ballsName
// yet, so every player was a guest whose number re-rolled on each page load:
// "Guest170 challenged you" turned out to be Guest378 on the course.
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

// A fresh page: shared.js evaluated again, with this browser's storage.
function page(ls) {
  globalThis.localStorage = ls;
  delete require.cache[require.resolve("../src/shared/shared.js")];
  return require("../src/shared/shared.js");
}

test.afterEach(() => delete globalThis.localStorage);

test("player name: a guest keeps one name from page to page", () => {
  const ls = storage();
  const first = page(ls).playerName();
  assert.match(first, /^Guest\d{3}$/);
  for (let i = 0; i < 5; i++) assert.strictEqual(page(ls).playerName(), first);
});

test("player name: a chosen name wins", () => {
  const ls = storage({ ballsName: "  Dave ", ballsGuestName: "Guest123" });
  assert.strictEqual(page(ls).playerName(), "Dave");
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
  assert.match(n, /^Guest\d{3}$/);
  assert.strictEqual(Shared.playerName(), n);
});
