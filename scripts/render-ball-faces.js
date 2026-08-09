// Renders the real Babylon gball model and expression textures into the README
// banner. Prerequisite: the dev server is running on http://localhost:3000.
const fs = require("fs");
const path = require("path");
const puppeteer = require("puppeteer");

const URL =
  process.env.URL || "http://localhost:3000/scripts/render-ball-faces.html";
const OUTPUT = path.resolve(__dirname, "../assets/ui/branding/ball-faces.png");
const SYSTEM_CHROME =
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

(async () => {
  const browser = await puppeteer.launch({
    headless: "new",
    executablePath: process.env.CHROME_PATH || SYSTEM_CHROME,
    args: ["--use-angle=swiftshader"],
  });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 2484, height: 578, deviceScaleFactor: 1 });
    await page.goto(URL, { waitUntil: "networkidle0" });
    await page.waitForFunction(
      () => globalThis.renderComplete || globalThis.renderError,
      { timeout: 30000 },
    );
    const error = await page.evaluate(() => globalThis.renderError || null);
    if (error) throw new Error(error);
    const dataUrl = await page.$eval("#renderCanvas", (canvas) =>
      canvas.toDataURL("image/png"),
    );
    fs.writeFileSync(OUTPUT, Buffer.from(dataUrl.split(",")[1], "base64"));
    console.log(`Rendered ${OUTPUT}`);
  } finally {
    await browser.close();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
