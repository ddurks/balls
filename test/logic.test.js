"use strict";
// Unit tests for the framework-free gameplay logic. Runs with `node --test`
// (Node's built-in runner — no dependencies to install).
//
// game.js is a browser script that expects a global `BABYLON`; we stub the tiny
// slice the pure logic touches (Vector3) and rely on game.js guarding its DOM
// bootstrap so require() doesn't try to boot the menu.
const test = require("node:test");
const assert = require("node:assert");

// CONFIG reads window.innerWidth at module load for responsive UI scaling.
globalThis.window = { innerWidth: 1280, addEventListener() {} };

globalThis.BABYLON = {
  Vector3: class {
    constructor(x = 0, y = 0, z = 0) {
      this.x = x;
      this.y = y;
      this.z = z;
    }
    set(x, y, z) {
      this.x = x;
      this.y = y;
      this.z = z;
      return this;
    }
    scale(s) {
      return new globalThis.BABYLON.Vector3(this.x * s, this.y * s, this.z * s);
    }
    length() {
      return Math.hypot(this.x, this.y, this.z);
    }
  },
};

// game.js expects the shared helpers as globals (loaded before it in the
// browser via <script>s); provide them the same way for the Node tests.
globalThis.Shared = require("../shared.js");
globalThis.Balls = require("../balls.js");

const { Utils, ClubData, Wind, CONFIG, ClubSelector } = require("../game.js");

test("rotate2D rotates a unit vector by 90°", () => {
  const r = Utils.rotate2D(1, 0, Math.PI / 2);
  assert.ok(Math.abs(r.x - 0) < 1e-9, `x=${r.x}`);
  assert.ok(Math.abs(r.z - 1) < 1e-9, `z=${r.z}`);
});

test("rotate2D is identity at angle 0", () => {
  const r = Utils.rotate2D(3, -4, 0);
  assert.strictEqual(r.x, 3);
  assert.strictEqual(r.z, -4);
});

test("metersToYards scales up and rounds", () => {
  assert.strictEqual(Utils.metersToYards(0), 0);
  assert.ok(Utils.metersToYards(100) > 100); // a yard is shorter than a metre
  assert.strictEqual(typeof Utils.metersToYards(50), "number");
});

test("ClubData.getClub clamps out-of-range ids", () => {
  assert.strictEqual(ClubData.getClub(0).name, "Putter");
  assert.strictEqual(ClubData.getClub(12).name, "Driver");
  assert.strictEqual(ClubData.getClub(999).name, "Driver"); // clamp high
  assert.strictEqual(ClubData.getClub(-5).name, "Putter"); // clamp low
});

test("ClubData distances increase from Putter to the longest wood", () => {
  const putter = ClubData.getClub(0).maxDistance;
  const driver = ClubData.getClub(12).maxDistance;
  assert.ok(driver > putter);
});

test("findBestClubForDistance treats its argument as METRES", () => {
  const sel = new ClubSelector();
  // Each club's exact maxDistance (metres) should select that same club.
  assert.strictEqual(sel.findBestClubForDistance(11), 0); // Putter (11 m)
  assert.strictEqual(sel.findBestClubForDistance(109), 4); // 8 Iron (109 m)
  assert.strictEqual(sel.findBestClubForDistance(175), 7); // 5 Iron (175 m)
  assert.strictEqual(sel.findBestClubForDistance(306), 12); // Driver (306 m)
});

test("findBestClubForDistance picks the nearest club by carry", () => {
  const sel = new ClubSelector();
  // 100 m sits between Pitching Wedge (66) and 9 Iron (88)… nearest is 8 Iron
  // (109). Regression guard: passing yards (≈109 yd for a 100 m shot) would
  // wrongly jump a club longer.
  assert.strictEqual(sel.findBestClubForDistance(100), 4); // 8 Iron, not Hybrid
  assert.strictEqual(sel.findBestClubForDistance(0), 0); // clamps to Putter
});

test("Wind vector points due-north at direction 0", () => {
  const w = new Wind();
  w.direction = 0;
  w.speed = 10;
  const v = w.getWindVector();
  assert.ok(Math.abs(v.x) < 1e-9, `x=${v.x}`);
  assert.ok(Math.abs(v.z - 10) < 1e-9, `z=${v.z}`);
});

test("Wind force is the wind vector scaled by FORCE_MULTIPLIER", () => {
  const w = new Wind();
  w.direction = 0;
  w.speed = 10;
  const f = w.getForceVector();
  assert.ok(Math.abs(f.z - 10 * CONFIG.WIND.FORCE_MULTIPLIER) < 1e-9);
});
