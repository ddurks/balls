// Verify isolated carry / flat-green putter roll at full power.
// Run: node scripts/club-distance-test.js (no server or browser required).
const assert = require("node:assert/strict");
const { createPhysicsLab } = require("./physics-audit.js");
const { ClubData } = require("../src/game/clubs.js");

(async () => {
  const lab = await createPhysicsLab();
  try {
    for (const club of ClubData.CLUBS) {
      const result = lab.shot(club, 1, 120);
      const distance = club.angle === 0 ? result.total : result.carry;
      console.log(`${club.name}: ${distance} m / ${club.maxDistance} m`);
      assert.ok(
        Math.abs(distance / club.maxDistance - 1) <= 0.02,
        `${club.name} is more than 2% off estimate`,
      );
    }
  } finally {
    lab.dispose();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
