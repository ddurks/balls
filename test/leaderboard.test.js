// src/clubhouse/leaderboard.js: positions and score text, Masters style.
const test = require("node:test");
const assert = require("node:assert/strict");
const Leaderboard = require("../src/clubhouse/leaderboard.js");

test("leaderboard: ties share a position, the next one skips past them", () => {
  const nets = [-2, 0, 0, 1, 1, 1, 4].map((net) => ({ net }));
  assert.deepEqual(Leaderboard.positions(nets), [
    "1",
    "T2",
    "T2",
    "T4",
    "T4",
    "T4",
    "7",
  ]);
});

test("leaderboard: under par is negative, even is E, over has a plus", () => {
  assert.equal(Leaderboard.netText(-3), "-3");
  assert.equal(Leaderboard.netText(0), "E");
  assert.equal(Leaderboard.netText(2), "+2");
});
