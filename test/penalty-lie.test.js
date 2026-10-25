// CourseManager penalties: a drop is the new lie. After a water drop, a ball
// knocked out of bounds is replayed from that drop, not from the lie before
// the water (on hole 1 that was the tee, 200+ m back). The match server
// refuses a rest that far from where the shot was played, so both players'
// games and the server disagreed until this was fixed.
const test = require("node:test");
const assert = require("node:assert/strict");
const { createCourse, B } = require("./helpers/course-world.js");

test("an out-of-bounds shot after a water drop is replayed from the drop", async (t) => {
  const w = await createCourse();
  t.after(() => w.dispose());
  await w.loadHole(0, 0);
  const { course, ball, game } = w;
  course.beginTurn();
  const tee = course.lastLie.clone();

  // The tee shot found the water by the green: the game drops it 200+ m out.
  const drop = new B.Vector3(course.cup.x + 12, 2, course.cup.z + 20);
  game.currentHoleShotCount = 1;
  course.applyPenalty("💦 Water — +1", drop);
  assert.equal(game.currentHoleShotCount, 2);
  assert.ok(
    B.Vector3.Distance(course.lastLie, drop) < 1e-9,
    "the drop is the lie",
  );
  assert.ok(B.Vector3.Distance(tee, drop) > 200);

  // The next shot leaves the island and falls past the out-of-bounds line.
  game.currentHoleShotCount = 3;
  ball.teleport(80, -20, 0);
  course.frame();
  assert.equal(game.currentHoleShotCount, 4, "out of bounds costs a stroke");
  const at = ball.startPosition;
  assert.ok(
    Math.hypot(at.x - drop.x, at.z - drop.z) < 1e-9,
    `replayed from ${at} instead of the water drop ${drop}`,
  );
});
