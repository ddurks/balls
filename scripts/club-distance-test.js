// Club carry-distance test harness.
//
// Drives the REAL shot code (GolfBallGuy.applyHit) in a headless Chrome running
// the game's own render loop, so the physics is identical to live play. For each
// club it fires a full-power, dead-straight shot with NO wind on the practice
// range and measures the carry ("on a fly"), i.e. the horizontal distance at the
// moment the ball descends back through its launch height. That's terrain-
// independent, so a driver overflying the range disc still measures correctly.
//
// Prereq: the dev server must be running (npm start) on http://localhost:3000.
// Run:    node scripts/club-distance-test.js
// Env:    URL=... HEADLESS=false  (headful for debugging)

const puppeteer = require("puppeteer");

const URL =
  process.env.URL || "http://localhost:3000/game.html?mode=practice";
const HEADLESS = process.env.HEADLESS === "false" ? false : "new";

// Runs in the PAGE. Fires one full-power straight shot for `clubId`, no wind,
// and resolves with the measured distances. `force` 175 saturates swipeStrength
// at MAX_HIT_STRENGTH, so this is a max shot; deltaX/deltaY 0 => no spin/curve.
function measureClubInPage(clubId) {
  return new Promise((resolve) => {
    const g = window.game;
    const gb = g.golfBall;
    const club = ClubData.getClub(clubId);
    const V0 = () => new BABYLON.Vector3(0, 0, 0);

    g.wind.speed = 0; // no wind
    gb.body.setLinearVelocity(V0());
    gb.body.setAngularVelocity(V0());
    gb.reset(); // teleport back to the tee/origin

    let phase = "settle";
    let settle = 0;
    let frames = 0;
    let start = null;
    let y0 = 0;
    let apex = 0;
    let carry = null;
    let total = null;
    let launch = { speed: 0, angle: 0 };
    let fellOff = false;

    const obs = g.scene.onAfterRenderObservable.add(() => {
      frames++;
      const p = gb.mesh.getAbsolutePosition();

      if (phase === "settle") {
        if (++settle < 18) return; // let the teleport land + ball come to rest
        start = { x: p.x, y: p.y, z: p.z };
        y0 = p.y;
        g.wind.speed = 0;
        gb.landed = false;
        gb.touchedGround = false;
        gb.applyHit(0, 0, 175, 0, club.angle, club.v0);
        const v = gb.getVelocity();
        launch = {
          speed: Math.hypot(v.x, v.y, v.z),
          angle: (Math.atan2(v.y, Math.hypot(v.x, v.z)) * 180) / Math.PI,
        };
        phase = "fly";
        return;
      }

      const horiz = Math.hypot(p.x - start.x, p.z - start.z);
      const h = p.y - y0;
      if (h > apex) apex = h;

      // Carry = first return to launch height after actually getting airborne.
      if (carry === null && apex > 0.3 && h <= 0 && frames > 2) carry = horiz;
      if (h < -2) fellOff = true; // flew off the range disc into the void

      const spd = gb.getSpeed();
      const stoppedRolling = spd < 0.2 && apex < 0.3 && frames > 20; // putts
      if (total === null && (gb.isLanded() || stoppedRolling)) total = horiz;

      if (total !== null || fellOff || frames > 3000) {
        if (carry === null) carry = horiz;
        if (total === null) total = horiz;
        g.scene.onAfterRenderObservable.remove(obs);
        resolve({
          id: clubId,
          name: club.name,
          loft: club.angle,
          estYd: Math.round(Utils.metersToYards(club.maxDistance)),
          carryM: +carry.toFixed(1),
          carryYd: Math.round(Utils.metersToYards(carry)),
          totalM: +total.toFixed(1),
          totalYd: Math.round(Utils.metersToYards(total)),
          apexM: +apex.toFixed(1),
          launchSpeed: +launch.speed.toFixed(1),
          launchAngle: +launch.angle.toFixed(1),
          fellOff,
        });
      }
    });
  });
}

function pad(s, n, right = false) {
  s = String(s);
  return right ? s.padStart(n) : s.padEnd(n);
}

(async () => {
  const browser = await puppeteer.launch({
    channel: "chrome",
    headless: HEADLESS,
    args: [
      "--use-gl=angle",
      "--use-angle=swiftshader",
      "--enable-webgl",
      "--ignore-gpu-blocklist",
      "--no-sandbox",
    ],
  });
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push("PAGEERROR: " + e.message));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });

  await page.goto(URL, { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForFunction(
    () => window.game && window.game.golfBall && window.game.golfBall.body,
    { timeout: 45000, polling: 200 },
  );
  // Small settle so the first shot isn't fired mid-load.
  await new Promise((r) => setTimeout(r, 1000));

  const clubCount = await page.evaluate(() => ClubData.CLUBS.length);
  const results = [];
  for (let id = 0; id < clubCount; id++) {
    const r = await page.evaluate(measureClubInPage, id);
    results.push(r);
    const flag = r.fellOff ? " (flew off range — total N/A)" : "";
    console.log(
      `  ${pad(r.name, 15)} carry ${pad(r.carryYd + "yd", 7, true)}  vs est ${pad(
        r.estYd + "yd",
        6,
        true,
      )}${flag}`,
    );
  }

  console.log("\n" + "=".repeat(78));
  console.log("CLUB CARRY TEST — full power, dead straight, no wind (practice range)\n");
  const H = [
    pad("Club", 15),
    pad("Loft", 5, true),
    pad("Est(yd)", 8, true),
    pad("Carry", 7, true),
    pad("Carry%", 7, true),
    pad("Total", 7, true),
    pad("Apex", 6, true),
    pad("v0", 6, true),
    pad("angle", 6, true),
  ].join(" ");
  console.log(H);
  console.log("-".repeat(78));
  for (const r of results) {
    const pct = r.estYd ? Math.round((r.carryYd / r.estYd) * 100) : 0;
    console.log(
      [
        pad(r.name, 15),
        pad(r.loft + "°", 5, true),
        pad(r.estYd, 8, true),
        pad(r.carryYd, 7, true),
        pad(pct + "%", 7, true),
        pad(r.fellOff ? "off" : r.totalYd, 7, true),
        pad(r.apexM + "m", 6, true),
        pad(r.launchSpeed, 6, true),
        pad(r.launchAngle + "°", 6, true),
      ].join(" "),
    );
  }
  console.log("=".repeat(78));

  // Flag clubs whose carry is more than 12% off their estimate.
  const off = results.filter((r) => {
    const pct = r.estYd ? (r.carryYd / r.estYd) * 100 : 100;
    return Math.abs(pct - 100) > 12;
  });
  if (off.length) {
    console.log("\nClubs off estimate by >12% (carry vs est):");
    for (const r of off) {
      const pct = Math.round((r.carryYd / r.estYd) * 100);
      console.log(`  ${pad(r.name, 15)} ${r.carryYd}yd / ${r.estYd}yd = ${pct}%`);
    }
  } else {
    console.log("\nAll clubs within 12% of estimate on carry.");
  }
  if (errors.length) console.log("\nConsole/page errors:", errors.slice(0, 10));

  await browser.close();
})().catch((e) => {
  console.error("TEST FAILED:", e.message);
  process.exit(1);
});
