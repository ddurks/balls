// Match play hands every client the same per-hole windSeed; Wind.fromSeed must
// turn it into the same wind on every client and every build, so the mapping
// is pinned to known values here. Changing it desyncs clients across a deploy.
// Run: node --test test/wind-seed.test.js
const test = require("node:test");
const assert = require("node:assert/strict");

globalThis.window = globalThis.window || { innerWidth: 1280 };
const { CONFIG } = require("../src/game/config.js");
const { Wind } = require("../src/game/wind.js");

test("Wind.fromSeed is pinned to known values", () => {
  assert.deepEqual(Wind.fromSeed(1), {
    direction: 3.94002177001874,
    speed: 0.02735721180215478,
  });
  assert.deepEqual(Wind.fromSeed(42), {
    direction: 3.776846262155295,
    speed: 4.482905589975417,
  });
  assert.deepEqual(Wind.fromSeed(2147483646), {
    direction: 6.243251634456113,
    speed: 3.810898973606527,
  });
});

test("Wind.fromSeed spans the generateNewWind ranges", () => {
  const dirs = [];
  const speeds = [];
  for (let seed = 1; seed <= 2000; seed++) {
    const w = Wind.fromSeed(seed * 1048573);
    assert.ok(w.direction >= 0 && w.direction < Math.PI * 2);
    assert.ok(
      w.speed >= CONFIG.WIND.MIN_SPEED && w.speed < CONFIG.WIND.MAX_SPEED,
    );
    dirs.push(w.direction);
    speeds.push(w.speed);
  }
  const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
  assert.ok(Math.abs(mean(dirs) - Math.PI) < 0.2, "directions are skewed");
  assert.ok(
    Math.abs(
      mean(speeds) - (CONFIG.WIND.MIN_SPEED + CONFIG.WIND.MAX_SPEED) / 2,
    ) < 0.4,
    "speeds are skewed",
  );
});

test("setFromSeed sets the instance's wind", () => {
  const w = new Wind();
  w.setFromSeed(42);
  assert.deepEqual(
    { direction: w.direction, speed: w.speed },
    Wind.fromSeed(42),
  );
});
