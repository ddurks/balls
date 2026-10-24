const test = require("node:test");
const assert = require("node:assert/strict");
const { createPhysicsLab } = require("../scripts/physics-audit.js");
const { ClubData } = require("../src/game/clubs.js");
const { CONFIG } = require("../src/game/config.js");
const { PhysicsConfig } = require("../src/game/physics.js");
const { InputHandler } = require("../src/game/input.js");

function input() {
  const handler = Object.create(InputHandler.prototype);
  handler.game = { aimView: { currentClub: 0 } };
  return handler;
}

function strengthFor(handler, distance) {
  return handler.solveSwipeStrengthForDistance(
    distance,
    PhysicsConfig.STEP_SECONDS,
    CONFIG.BALL.LINEAR_DAMPING,
    9.81,
    ClubData.CLUBS[0],
  );
}

test("guided putts round-trip through swipe input and reach flat-green targets", async (t) => {
  const lab = await createPhysicsLab();
  t.after(() => lab.dispose());
  const handler = input();
  for (const distance of [0.1, 0.25, 0.5, 1, 2, 3, 5, 8, 12, 18, 22]) {
    const strength = strengthFor(handler, distance);
    const vector = handler.buildIdealSwipeVector(
      { local: { x: 0, z: -distance } },
      0,
      strength,
    );
    const pixels =
      Math.hypot(vector.deltaX, vector.deltaY) * handler.getHitSwipeScale();
    assert.ok(pixels > PhysicsConfig.MIN_SWIPE_DISTANCE);
    const force = handler.getHitForceFromDistance(pixels);
    assert.ok(Math.abs(force / 100 - strength) < 1e-10);
    for (const fps of [30, 60, 120]) {
      const result = lab.shot(ClubData.CLUBS[0], force / 175, fps);
      assert.ok(
        Math.abs(result.total - distance) < 0.08,
        `${distance} m guide rolled ${result.total} m at ${fps} FPS`,
      );
    }
  }
});

test("putt guidance responds to centimetre changes instead of reusing half-metre cache", () => {
  const handler = input();
  assert.ok(strengthFor(handler, 0.22) > strengthFor(handler, 0.2));
});

test("putter gets twice the swipe travel without changing other club input", () => {
  const handler = input();
  const putt = handler.getHitForceFromDistance(100);
  handler.game.aimView.currentClub = 12;
  assert.equal(handler.getHitForceFromDistance(100), putt * 2);
});
