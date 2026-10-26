// Runs test/mp/*.test.js a few files at a time, printing each file's verdict
// as it finishes (node --test prints files in order, so one slow file hides
// the rest), and kills any file that outlives its deadline: a hung file costs
// minutes, not the whole run. Browser files run alone at the end; headless
// Chrome rendering in software starves next to the sim files.
// Usage: node scripts/test-mp.js [name-substring ...]
//   MP_JOBS (4), MP_FILE_TIMEOUT_S (600)
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { setTimeout, clearTimeout } = require("node:timers");

const DIR = path.join(__dirname, "..", "test", "mp");
const JOBS = Number(process.env.MP_JOBS || 4);
const CAP_MS = Number(process.env.MP_FILE_TIMEOUT_S || 600) * 1000;
const only = process.argv.slice(2);
const files = fs
  .readdirSync(DIR)
  .filter((f) => f.endsWith(".test.js"))
  .filter((f) => !only.length || only.some((s) => f.includes(s)))
  .sort();
const alone = files.filter((f) => /browser/.test(f));
// The longest files (minutes each) start first so they don't trail the run.
const SLOW = /sim-chaos|slow-link|sim-tcp|slow-uplink|tcp-fuzz/;
const pooled = files
  .filter((f) => !alone.includes(f))
  .sort((a, b) => SLOW.test(b) - SLOW.test(a));

const t0 = Date.now();
let done = 0;
const failed = [];

function run(file) {
  return new Promise((resolve) => {
    const start = Date.now();
    let out = "";
    const child = spawn(process.execPath, ["--test", path.join(DIR, file)], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    let hung = false;
    const timer = setTimeout(() => {
      hung = true;
      child.kill("SIGKILL");
    }, CAP_MS);
    child.on("close", (code) => {
      clearTimeout(timer);
      const s = Math.round((Date.now() - start) / 1000);
      const n = (k) => out.match(new RegExp(`ℹ ${k} (\\d+)`))?.[1] ?? "?";
      const verdict = hung ? "HUNG" : code === 0 ? "PASS" : "FAIL";
      done++;
      console.log(
        `[${done}/${files.length}] ${verdict} ${file} (${s}s, pass ${n("pass")} fail ${n("fail")})`,
      );
      if (verdict !== "PASS") failed.push({ file, verdict, out });
      resolve();
    });
  });
}

async function pool(list, jobs) {
  const queue = [...list];
  await Promise.all(
    Array.from({ length: Math.min(jobs, queue.length) }, async () => {
      while (queue.length) await run(queue.shift());
    }),
  );
}

(async () => {
  console.log(`${files.length} files, ${JOBS} at a time`);
  await pool(pooled, JOBS);
  await pool(alone, 1);
  for (const f of failed) {
    const at = f.out.indexOf("✖ failing tests:");
    console.log(`\n=== ${f.verdict} ${f.file}`);
    console.log((at < 0 ? f.out.slice(-3000) : f.out.slice(at)).trim());
  }
  const s = Math.round((Date.now() - t0) / 1000);
  console.log(
    `\n${files.length - failed.length}/${files.length} files passed in ${s}s`,
  );
  process.exitCode = failed.length ? 1 : 0;
})();
