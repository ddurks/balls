// Isolated carry and flat-green roll calibration; no browser/server required.
// Run: node scripts/club-calibrate.js. Prints values for src/game/clubs.js.
const { createPhysicsLab } = require("./physics-audit.js");
const { ClubData } = require("../src/game/clubs.js");

(async () => {
  const lab = await createPhysicsLab();
  try {
    const clubs = ClubData.CLUBS.map((club) => ({ ...club }));
    for (const club of clubs) {
      const distance = (speed) => {
        const result = lab.shot({ ...club, v0: speed }, 1, 120);
        return club.angle === 0 ? result.total : result.carry;
      };
      // Preserve clubs already within 2%; avoid retuning the whole set for noise.
      if (Math.abs(distance(club.v0) / club.maxDistance - 1) > 0.02) {
        let low = 0;
        let high = club.v0;
        while (distance(high) < club.maxDistance) high *= 1.25;
        for (let i = 0; i < 14; i++) {
          const mid = (low + high) / 2;
          if (distance(mid) < club.maxDistance) low = mid;
          else high = mid;
        }
        club.v0 = +((low + high) / 2).toFixed(1);
      }
      console.log(
        JSON.stringify({
          id: club.id,
          name: club.name,
          v0: club.v0,
          target: club.maxDistance,
          measured: distance(club.v0),
        }),
      );
    }
  } finally {
    lab.dispose();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
