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
globalThis.Shared = require("../src/shared/shared.js");
globalThis.Balls = require("../src/shared/balls.js");

// game.js is now split into per-system modules (see game.html load order);
// require them in the same order so each module's globals are set before the
// next one's load-time refs (config before physics), then pull out what we test.
require("../src/game/config.js");
require("../src/game/utils.js");
require("../src/game/wind.js");
require("../src/game/clouds.js");
require("../src/game/birds.js");
require("../src/game/clubs.js");
require("../src/game/aim.js");
require("../src/game/physics.js");
require("../src/game/character.js");
require("../src/game/camera.js");
require("../src/game/terrain.js");
require("../src/game/input.js");
require("../src/game/ui.js");
require("../src/game/coordinators.js");
require("../src/game/scene.js");
require("../src/game/course.js");
require("../src/game/game.js");
const { CONFIG } = require("../src/game/config.js");
const { Utils } = require("../src/game/utils.js");
const { Wind } = require("../src/game/wind.js");
const { ClubData, ClubSelector } = require("../src/game/clubs.js");
const { CourseManager } = require("../src/game/course.js");

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
  assert.strictEqual(ClubData.getClub(999).name, "Driver");
  assert.strictEqual(ClubData.getClub(-5).name, "Putter");
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
  assert.strictEqual(sel.findBestClubForDistance(0), 0);
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

// ---- water-hazard drop (findWaterDrop) ----
// Runs the real method against a fabricated height grid — no scene needed.
// Grid: 9×9 cells, 3 m apart, x/z ∈ [0..24]. Terrain is a flat plateau at
// y=1 with a water channel (bed y=-1) across columns x=9..15; waterline y=0.
// Cup sits east of the channel, entry point is mid-channel.
const V3 = globalThis.BABYLON.Vector3;
function fakeCourse({ heightAt, solidAt = null, cup, waterlineY = 0 }) {
  const nx = 9,
    nz = 9,
    cell = 3;
  const height = new Float32Array(nx * nz);
  const solid = new Uint8Array(nx * nz);
  for (let i = 0; i < nx; i++) {
    for (let j = 0; j < nz; j++) {
      height[i * nz + j] = heightAt(i, j);
      solid[i * nz + j] = solidAt ? solidAt(i, j) : 1;
    }
  }
  return {
    hg: { minX: 0, minZ: 0, cell, nx, nz, height, playable: solid, solid },
    waterlineY,
    cup: new V3(cup.x, 0, cup.z),
  };
}
const findDrop = (self, entry) =>
  CourseManager.prototype.findWaterDrop.call(self, entry);

test("findWaterDrop picks the nearest dry flat cell no closer to the cup", () => {
  const self = fakeCourse({
    heightAt: (i) => (i >= 3 && i <= 5 ? -1 : 1), // channel bed below waterline
    cup: { x: 24, z: 12 },
  });
  const drop = findDrop(self, new V3(12, -1, 12));
  assert.ok(drop, "expected a drop spot");
  // East bank (x=18+) is closer to the cup than the entry → must land on the
  // west bank. x=6 borders the channel cliff (not flat), so x=3 is nearest.
  assert.strictEqual(drop.x, 3);
  assert.strictEqual(drop.z, 12); // straight across from the entry
  assert.strictEqual(drop.y, 1); // on the plateau, above the waterline
  const cupSq = (x, z) => (x - 24) ** 2 + (z - 12) ** 2;
  assert.ok(cupSq(drop.x, drop.z) >= cupSq(12, 12), "gained ground on the cup");
});

test("findWaterDrop rejects steep cells even when they are dry", () => {
  // Same channel, but the west plateau is a steep staircase (1.5 m per cell);
  // only the east side is flat — and it's all closer to the cup, so no drop.
  const self = fakeCourse({
    heightAt: (i) => (i >= 3 && i <= 5 ? -1 : i < 3 ? 1 + (3 - i) * 1.5 : 1),
    cup: { x: 24, z: 12 },
  });
  assert.strictEqual(findDrop(self, new V3(12, -1, 12)), null);
});

test("findWaterDrop never lands in the void off the island", () => {
  // West side looks dry+flat by height but the rays never hit ground there.
  const self = fakeCourse({
    heightAt: (i) => (i >= 3 && i <= 5 ? -1 : 1),
    solidAt: (i) => (i < 3 ? 0 : 1),
    cup: { x: 24, z: 12 },
  });
  assert.strictEqual(findDrop(self, new V3(12, -1, 12)), null);
});

test("findWaterDrop returns null without a height grid (falls back to last lie)", () => {
  assert.strictEqual(
    findDrop({ hg: null, cup: new V3(0, 0, 0) }, new V3(1, 0, 1)),
    null,
  );
});

// ---- avatar style (style.js) ----
const BallsStyle = require("../src/shared/style.js");

test("cycle wraps in both directions", () => {
  assert.strictEqual(BallsStyle.cycle(0, -1, 6), 5);
  assert.strictEqual(BallsStyle.cycle(5, 1, 6), 0);
  assert.strictEqual(BallsStyle.cycle(2, 1, 6), 3);
});

test("normalizeStyle clamps garbage to a valid style", () => {
  const st = BallsStyle.normalizeStyle({
    hat: "3",
    skin: 99,
    face: 123,
    skinImg: "nope",
  });
  assert.strictEqual(st.hat, 3); // numeric string accepted
  assert.strictEqual(st.skin, 0); // out of range -> default
  assert.strictEqual(st.face, null); // not a dataURL string
  assert.strictEqual(st.skinImg, null); // not a dataURL string
  const st2 = BallsStyle.normalizeStyle(null);
  assert.deepStrictEqual(st2, { hat: 0, skin: 0, face: null, skinImg: null });
});

test("saveStyle/loadStyle round-trip through a storage object", () => {
  const store = new Map();
  const fake = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  };
  const face = "data:image/png;base64,iVBORw0KGgo=";
  const skinImg = "data:image/jpeg;base64,/9j/4AAQ";
  BallsStyle.saveStyle({ hat: 2, skin: 4, face, skinImg }, fake);
  assert.deepStrictEqual(BallsStyle.loadStyle(fake), {
    hat: 2,
    skin: 4,
    face,
    skinImg,
  });
  // clearing the images removes their keys
  BallsStyle.saveStyle({ hat: 2, skin: 4, face: null, skinImg: null }, fake);
  assert.strictEqual(store.has("ballsFace"), false);
  assert.strictEqual(store.has("ballsSkinImg"), false);
});

test("saveStyle drops an oversized face dataURL", () => {
  const store = new Map();
  const fake = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  };
  const big = "data:image/png;base64," + "A".repeat(BallsStyle.FACE_MAX_BYTES);
  BallsStyle.saveStyle({ hat: 0, skin: 0, face: big }, fake);
  assert.strictEqual(BallsStyle.loadStyle(fake).face, null);
});

// ---- camera floor governor (cameraFloorY) ----
// Runs the real method against fake mode state — no scene needed.
const floorAt = (self, x, z) =>
  require("../src/game/game.js").GolfGame.prototype.cameraFloorY.call(
    self,
    x,
    z,
  );

test("cameraFloorY on the course clamps to terrain height", () => {
  const self = {
    courseManager: { hg: {}, groundY: () => 2, waterlineY: -1 },
  };
  assert.ok(Math.abs(floorAt(self, 0, 0) - 2.06) < 1e-9);
});

test("cameraFloorY never goes below the water surface", () => {
  // Pond: the bed (groundY) is below the waterline — the waterline wins.
  const self = {
    courseManager: { hg: {}, groundY: () => -5, waterlineY: -1 },
  };
  assert.ok(Math.abs(floorAt(self, 0, 0) - -0.94) < 1e-9);
});

test("cameraFloorY in practice rises over the green pads", () => {
  const self = { greenPositions: [{ x: 0, z: 0 }] };
  // on the pad (anywhere within its 12 m radius): pad top (0.121) + clearance
  assert.ok(Math.abs(floorAt(self, 0, 0) - 0.181) < 1e-3);
  assert.ok(Math.abs(floorAt(self, 8, 0) - 0.181) < 1e-3);
  // off the green: flat range floor + clearance
  assert.ok(Math.abs(floorAt(self, 50, 0) - 0.06) < 1e-9);
});
