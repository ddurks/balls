// Contracts 3 (liveness), 8 (isolation) and 10 (resources): one client can't
// stall every match on the server with oversized frames. The worldserver's
// socket takes frames up to 10 MB (other worlds upload bootstraps that big),
// and everything it does with one runs on the event loop every match shares.
// It used to cost seconds and gigabytes: a bootstrap upload of a few million
// bad entries was validated entry by entry (~2.5 s and over 2 GB for 8 MB)
// before golf even refused it, and the golf engine normalized a whole 10 MB
// chat line or join name (~0.5 s each). Now golf refuses any frame over
// 64 KB before it is read, refuses an upload on its type alone, and cuts
// text before reading it, so the same bytes cost what they cost in a field
// nothing reads.
//
// A bystander match (Dave vs Sam) is watched while a client alone in a lobby
// of its own (on a thread of its own: test/mp/flooder.js) sends frames, at most
// two in flight: 9.8 MB ones (an action the engine ignores as the control,
// then match chat, bootstrap uploads and join names), then ones just under
// the cap (~60 KB chat lines and uploads of 30,000 bad entries); and new
// clients join with ~60 KB names.
// Run: node --test test/mp/huge-text.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const { execFile } = require("node:child_process");
const { setTimeout, setInterval, clearInterval } = require("node:timers");
const { startGolfServer } = require("./server.js");
const { Bot, setupMatch } = require("./bot.js");
const { startFlooder } = require("./flooder.js");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const BIG = "a ".repeat(4.9e6); // 9.8 MB, under the socket's 10 MB cap
const NEAR = "a ".repeat(30000); // 60 KB, under golf's 64 KB frame cap
const action = (action, message) =>
  JSON.stringify({ t: "action", action, message });
const upload = (n) =>
  `{"t":"bootstrapUpload","worldId":"w","version":1,"positions":[${Array(n).fill("1").join(",")}]}`;
const FRAMES = 20;

const rssMB = (pid) =>
  new Promise((resolve) =>
    execFile("ps", ["-o", "rss=", "-p", String(pid)], (e, out) =>
      resolve(e ? NaN : Number(out) / 1024),
    ),
  );

// The bystander's snapshot rate and worst gap, from its last snapshot before
// `flood` to 300 ms after it (a flood can be over before the next snapshot
// is due), and the server's RSS growth meanwhile.
async function measure(srv, bystander, flood) {
  const base = await rssMB(srv.pid);
  let peak = base;
  const poll = setInterval(
    () => rssMB(srv.pid).then((m) => (peak = Math.max(peak, m || 0))),
    50,
  );
  const t0 = Date.now();
  await flood();
  const t1 = Date.now();
  await sleep(300);
  clearInterval(poll);
  const all = bystander.snaps.map((s) => s.at);
  const from = Math.max(0, all.findIndex((at) => at >= t0) - 1);
  const at = all.slice(from);
  let maxGapMs = 0;
  for (let i = 1; i < at.length; i++)
    maxGapMs = Math.max(maxGapMs, at[i] - at[i - 1]);
  const span = at.length > 1 ? at[at.length - 1] - at[0] : Infinity;
  return {
    ms: t1 - t0,
    perSec: Number((((at.length - 1) * 1000) / span).toFixed(1)),
    maxGapMs,
    rssGrowthMB: Math.round(peak - base),
  };
}

test(
  "a flood of oversized frames doesn't stall another match",
  { timeout: 240000 },
  async (t) => {
    const srv = await startGolfServer({
      env: { GOLF_TURN_TIMEOUT_MS: "600000" },
    });
    const open = [];
    t.after(async () => {
      open.forEach((b) => b.close());
      await srv.stop();
    });
    const {
      bots: [dave, sam],
    } = await setupMatch(srv.url, ["Dave", "Sam"]);
    open.push(dave, sam);
    const atk = await startFlooder(srv.url, "Atk");
    t.after(() => atk.stop());
    await sleep(500);

    const control = await measure(srv, dave, () =>
      atk.flood(action("noop", BIG)),
    );
    t.diagnostic(`control (ignored action): ${JSON.stringify(control)}`);
    assert.ok(
      control.perSec >= 8,
      "the control run already starved: machine too busy to judge",
    );
    const bounded = (label, r) => {
      t.diagnostic(`${label}: ${JSON.stringify(r)}`);
      assert.ok(
        r.perSec >= 8 && r.maxGapMs < 300,
        `${label} starved another match: ${JSON.stringify(r)} (control ${JSON.stringify(control)})`,
      );
      assert.ok(
        r.rssGrowthMB < Math.max(600, control.rssGrowthMB * 2),
        `${label}: server grew ${r.rssGrowthMB} MB (control ${control.rssGrowthMB} MB)`,
      );
    };

    await t.test(
      "frames of 9.8 MB are refused before they are read",
      async () => {
        for (const [label, frame] of [
          ["mchat", action("mchat", BIG)],
          ["bootstrap upload", upload(4.9e6)],
          ["join name", JSON.stringify({ t: "join", name: BIG })],
        ]) {
          await sleep(1000);
          let errs;
          const r = await measure(srv, dave, async () => {
            ({ errs } = await atk.flood(frame));
          });
          bounded(label, r);
          assert.deepEqual(errs, Array(FRAMES).fill("FRAME_TOO_LARGE"), label);
        }
        const { chat, names } = await atk.state();
        assert.deepEqual(chat, []);
        assert.deepEqual(names, ["Atk"]);
      },
    );

    await t.test(
      "an upload just under the cap is refused by its type, unvalidated",
      async () => {
        await sleep(1000);
        const n = 100; // ~40 ms each if validated: seconds of stall in all
        let errs;
        const r = await measure(srv, dave, async () => {
          ({ errs } = await atk.flood(upload(30000), { n }));
        });
        bounded("bootstrap upload under the cap", r);
        assert.deepEqual(errs, Array(n).fill("BOOTSTRAP_DENIED"));
      },
    );

    await t.test(
      "20 match-chat lines of 60 KB are cut, or refused, unread",
      async () => {
        await sleep(1000);
        const r = await measure(srv, dave, () =>
          atk.flood(action("mchat", NEAR)),
        );
        bounded("mchat under the cap", r);
        // The lines were read (the first five, cut to 200), the rest refused.
        const { chat, notices } = await atk.state();
        assert.deepEqual(chat, Array(5).fill("a ".repeat(100).trim()));
        assert.ok(notices.includes("Slow down"));
      },
    );

    await t.test("6 joins with a 60 KB name", async () => {
      await sleep(1000);
      const joined = [];
      const names = await measure(srv, dave, async () => {
        for (let i = 0; i < 6; i++) {
          const b = new Bot(srv.url, NEAR);
          open.push(b);
          await b.connect({ timeout: 60000 });
          joined.push(b);
        }
      });
      bounded("join names under the cap", names);
      assert.equal(dave.you.phase, "playing");
      const host = joined[0];
      host.create();
      await host.untilMatch();
      assert.equal(host.you.players[0].name, "a ".repeat(12).trim());
    });
  },
);
