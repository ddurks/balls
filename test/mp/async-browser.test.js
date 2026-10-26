// Async play in the real game page: headless Chrome (puppeteer driving the
// installed Chrome, CHROME_PATH to override) against a private golf server,
// the opponent a protocol bot. The seat link the opponent would text, opened
// in a fresh browser on its turn: the page takes the seat (resume with the
// link's key), watches the opponent's hole (the review, with its Skip
// button), skips it, and gets the ball. The match id without the seat key
// is told whose match it is. Screenshots go to a temp dir (logged).
// Run: node --test test/mp/async-browser.test.js
/* global window, document, location -- page.evaluate bodies run in the page */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { setTimeout } = require("node:timers");
const express = require("express");
const puppeteer = require("puppeteer");
const { startGolfServer } = require("./server.js");
const { Bot, lobby, fakeShot } = require("./bot.js");

const CHROME =
  process.env.CHROME_PATH ||
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const ROOT = path.join(__dirname, "..", "..");
// The page's readiness is waited for below; a cold headless Chrome can take
// longer than goto's 30 s default to fire load.
const GOTO = { waitUntil: "domcontentloaded", timeout: 120000 };

test(
  "a match link in the browser: back in the seat, the review, then our turn",
  { timeout: 300000, skip: !fs.existsSync(CHROME) && "no Chrome" },
  async (t) => {
    const srv = await startGolfServer({
      env: { GOLF_TURN_TIMEOUT_MS: "600000" },
    });
    const web = await new Promise((resolve) => {
      const s = express().use(express.static(ROOT)).listen(0, "127.0.0.1");
      s.on("listening", () => resolve(s));
    });
    const browser = await puppeteer.launch({
      headless: "new",
      executablePath: CHROME,
      args: ["--use-angle=swiftshader"],
    });
    const bots = [];
    const shots = fs.mkdtempSync(path.join(os.tmpdir(), "golf-async-"));
    t.after(async () => {
      bots.forEach((b) => b.close());
      await browser.close();
      web.close();
      await srv.stop();
      console.log(`screenshots: ${shots}`);
    });

    // Dave and Sam tee off; Sam leaves; Dave finishes the hole: Sam's turn.
    const dave = new Bot(srv.url, "Dave");
    const sam = new Bot(srv.url, "Sam");
    bots.push(dave, sam);
    await Promise.all([dave.connect(), sam.connect()]);
    await lobby([dave, sam]);
    const id = dave.match.id;
    const samSeat = dave.match.seats[sam.playerId];
    const shot = async (b, opts) => {
      await b.untilMyTurn();
      const seq = b.match.turnSeq;
      fakeShot(b, opts);
      await b.until((x) => x.match.turnSeq > seq, { label: "shot result" });
    };
    await shot(dave, { fraction: 0.5, frames: 12 });
    await shot(sam, { fraction: 0.2 });
    sam.close();
    await dave.untilMyTurn();
    while (dave.isMyTurn()) await shot(dave, { fraction: 0.6, frames: 12 });

    const base =
      `http://localhost:${web.address().port}/game.html?mode=course` +
      `&gws=${encodeURIComponent(srv.url)}&match=${id}`;
    const page = await browser.newPage();
    await page.setViewport({ width: 800, height: 600 });
    await page.goto(`${base}&seat=${samSeat}`, GOTO);
    await page.waitForFunction(() => window.golfNet?.you?.matchCode, {
      timeout: 60000,
    });
    await dave.until((x) => Object.values(x.match.present).every(Boolean), {
      label: "Sam back, for Dave",
    });
    await page.waitForFunction(() => window.game?.match?.replay, {
      timeout: 120000,
    });
    assert.ok(
      await page.evaluate(() =>
        [...document.querySelectorAll("button")].some((b) =>
          b.textContent.includes("Skip replay"),
        ),
      ),
      "a Skip button while the review plays",
    );
    assert.equal(await page.evaluate(() => window.game.match.canAim()), false);
    await new Promise((r) => setTimeout(r, 1500));
    await page.screenshot({ path: path.join(shots, "1-review.png") });
    await page.evaluate(() =>
      [...document.querySelectorAll("button")]
        .find((b) => b.textContent.includes("Skip replay"))
        .click(),
    );
    await page.waitForFunction(() => window.game.match.canAim(), {
      timeout: 60000,
    });
    assert.equal(
      await page.evaluate(() =>
        [...document.querySelectorAll("button")].some((b) =>
          b.textContent.includes("Skip replay"),
        ),
      ),
      false,
    );
    assert.match(
      await page.evaluate(() => location.search),
      new RegExp(`match=${id}.*seat=${samSeat}`),
    );
    await page.screenshot({ path: path.join(shots, "2-our-turn.png") });

    // The match without a seat key.
    const other = await browser.createBrowserContext();
    const page2 = await other.newPage();
    await page2.goto(base, GOTO);
    await page2.waitForFunction(
      () =>
        document.querySelector(".splash-title")?.textContent ===
        "This match is between Dave and Sam",
      { timeout: 60000 },
    );
    await page2.screenshot({ path: path.join(shots, "3-not-yours.png") });
    await other.close();
  },
);
