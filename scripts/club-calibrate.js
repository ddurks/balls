// Calibrates each club's full-power launch speed (v0) against the REAL engine so
// that carry ≈ the club's estimate (maxDistance), with no wind on the practice
// range. Binary-searches v0 per club by firing real applyHit shots headlessly and
// measuring carry. Prints a copy-pasteable v0 column to paste into ClubData.CLUBS.
//
// Prereq: dev server running (npm start). Run: node scripts/club-calibrate.js
const puppeteer = require("puppeteer");
const URL = process.env.URL || "http://localhost:3000/game.html?mode=practice";

// Fire one full-power straight shot at (angle, launchSpeed); resolve distances.
function measureInPage({ angle, speed, isPutt }) {
  return new Promise((resolve) => {
    const g = window.game;
    const gb = g.golfBall;
    const V0 = () => new BABYLON.Vector3(0, 0, 0);
    g.wind.speed = 0;
    gb.body.setLinearVelocity(V0());
    gb.body.setAngularVelocity(V0());
    gb.reset();
    let phase = "settle",
      settle = 0,
      frames = 0;
    let start = null,
      y0 = 0,
      apex = 0,
      carry = null,
      total = null,
      fellOff = false;
    const obs = g.scene.onAfterRenderObservable.add(() => {
      frames++;
      const p = gb.mesh.getAbsolutePosition();
      if (phase === "settle") {
        if (++settle < 18) return;
        start = { x: p.x, y: p.y, z: p.z };
        y0 = p.y;
        g.wind.speed = 0;
        gb.landed = false;
        gb.touchedGround = false;
        gb.applyHit(0, 0, 175, 0, angle, speed);
        phase = "fly";
        return;
      }
      const horiz = Math.hypot(p.x - start.x, p.z - start.z);
      const h = p.y - y0;
      if (h > apex) apex = h;
      if (carry === null && apex > 0.3 && h <= 0 && frames > 2) carry = horiz;
      if (h < -2) fellOff = true;
      const spd = gb.getSpeed();
      if (
        total === null &&
        (gb.isLanded() || (spd < 0.2 && apex < 0.3 && frames > 20))
      )
        total = horiz;
      if (total !== null || fellOff || frames > 3000) {
        if (carry === null) carry = horiz;
        if (total === null) total = horiz;
        g.scene.onAfterRenderObservable.remove(obs);
        resolve({ carry, total, apex, fellOff });
      }
    });
  });
}

(async () => {
  const browser = await puppeteer.launch({
    channel: "chrome",
    headless: "new",
    args: [
      "--use-gl=angle",
      "--use-angle=swiftshader",
      "--enable-webgl",
      "--ignore-gpu-blocklist",
      "--no-sandbox",
    ],
  });
  const page = await browser.newPage();
  await page.goto(URL, { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForFunction(
    () => window.game && window.game.golfBall && window.game.golfBall.body,
    { timeout: 45000, polling: 200 },
  );
  await new Promise((r) => setTimeout(r, 1000));

  const clubs = await page.evaluate(() =>
    ClubData.CLUBS.map((c) => ({
      id: c.id,
      name: c.name,
      angle: c.angle,
      D: c.maxDistance,
    })),
  );

  const out = [];
  for (const c of clubs) {
    const isPutt = c.angle === 0;
    const metric = (r) => (isPutt ? r.total : r.carry);
    // bracket around a formula guess, then binary search v0
    const sin2 = Math.max(0.15, Math.sin((2 * c.angle * Math.PI) / 180));
    const guess = Math.sqrt((c.D * 9.81) / sin2) * 1.4;
    let lo = Math.max(5, guess * 0.45),
      hi = guess * 1.25;
    let best = null,
      bestSpeed = null;
    for (let i = 0; i < 8; i++) {
      const speed = (lo + hi) / 2;
      const r = await page.evaluate(measureInPage, {
        angle: c.angle,
        speed,
        isPutt,
      });
      const dist = metric(r);
      if (dist < c.D) lo = speed;
      else hi = speed;
      best = r;
      bestSpeed = speed;
    }
    // final measure at the converged speed
    const speed = (lo + hi) / 2;
    const r = await page.evaluate(measureInPage, {
      angle: c.angle,
      speed,
      isPutt,
    });
    out.push({
      ...c,
      v0: +speed.toFixed(1),
      carry: +r.carry.toFixed(0),
      total: +r.total.toFixed(0),
      apex: +r.apex.toFixed(0),
    });
    console.log(
      `${c.name.padEnd(15)} v0=${String(speed.toFixed(1)).padStart(6)}  carry=${String(r.carry.toFixed(0)).padStart(4)}m  target=${String(c.D).padStart(4)}m  (${Math.round((metric(r) / c.D) * 100)}%)`,
    );
  }

  console.log(
    "\n// calibrated full-power launch speeds (m/s) — paste v0 into ClubData.CLUBS:",
  );
  for (const c of out) {
    console.log(
      `  id ${String(c.id).padStart(2)} ${c.name.padEnd(15)} v0: ${c.v0},`,
    );
  }
  await browser.close();
})().catch((e) => {
  console.error("CALIBRATE FAILED:", e.message);
  process.exit(1);
});
