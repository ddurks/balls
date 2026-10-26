// Contract 6 (spectator fidelity), live with sim clients on private servers:
// every sample of a genuine shot reaches the spectator, in order.
// - A max-power drive hit backwards or sideways off the hole-1 tee flies far
//   past the island before the game calls it out of bounds (ball below
//   y -15); its flight must still be relayed, not dropped as out of range.
// - The shooter's uplink stalls for a second mid-flight (TCP holds the bytes,
//   then delivers the backlog at once, as a Wi-Fi or mobile hiccup does): the
//   bunched-up frames are the shooter's in-spec 20 Hz stream and must all
//   arrive. The proxy loses nothing (dropRate 0, order kept).
// Run: node --test test/mp/path-fidelity.test.js
const test = require("node:test");
const { setTimeout } = require("node:timers");
const { startGolfServer } = require("./server.js");
const { startChaosProxy } = require("./chaos-proxy.js");
const { lobby } = require("./bot.js");
const { SimClient } = require("./sim-client.js");
const C = require("./checks.js");
const { ClubData } = require("../../src/game/clubs.js");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

for (const deg of [180, 90]) {
  test(
    `a max-power drive aimed ${deg} deg off the line streams its whole path`,
    { timeout: 120000 },
    async (t) => {
      const srv = await startGolfServer();
      t.after(() => srv.stop());
      const opts = {
        timeScale: 1,
        seed: 5,
        lookahead: 0,
        spinChance: 0,
        aimSigmaDeg: 0,
        powerSigma: 0,
      };
      const dave = new SimClient(srv.url, "Dave", opts);
      const sam = new SimClient(srv.url, "Sam", { ...opts, autoplay: false });
      t.after(() => {
        dave.dispose();
        sam.dispose();
      });
      // Full swing with the driver, pointed away from the green.
      dave._plan = (pos) => {
        const b = (deg * Math.PI) / 180;
        const target = {
          x: pos.x + Math.sin(b) * 300,
          y: pos.y,
          z: pos.z - Math.cos(b) * 300,
        };
        return {
          club: ClubData.getClub(12),
          target,
          bearing: b,
          strength: 1.75,
          dist: 300,
          putt: false,
          trials: [],
        };
      };
      await Promise.all([dave.connect(), sam.connect()]);
      await lobby([dave, sam]);
      await sam.until((b) => b.match?.lies[dave.playerId]?.strokes > 0, {
        timeout: 60000,
        label: "Dave's drive to count",
      });
      await sleep(300);
      const shot = dave.shots[0];
      t.diagnostic(
        `penalty ${shot.penalty} (${shot.hazard}); last sample ${JSON.stringify(shot.sent[shot.sent.length - 1])}`,
      );
      C.assertClean(
        C.checkPathFidelity(dave.records(), sam.records(), {
          shots: (s) => s === shot,
        }),
        "drive path",
      );
    },
  );
}

test(
  "a 1 s upstream stall mid-flight loses no path samples",
  { timeout: 180000 },
  async (t) => {
    const srv = await startGolfServer();
    t.after(() => srv.stop());
    const proxy = await startChaosProxy({
      target: srv.url,
      latencyMs: 50,
      seed: 1,
    });
    t.after(() => proxy.close());
    // Sam (behind the proxy) hosts, so Sam has the honor on hole 1.
    const sam = new SimClient(proxy.url, "Sam", { timeScale: 1, seed: 2 });
    const dave = new SimClient(srv.url, "Dave", {
      timeScale: 1,
      seed: 1,
      autoplay: false,
    });
    t.after(() => {
      dave.dispose();
      sam.dispose();
    });
    await Promise.all([dave.connect(), sam.connect()]);
    await lobby([sam, dave]);

    // Ten frames into Sam's tee shot, the uplink stalls for one second.
    let frames = 0;
    proxy.onMessage(({ dir, json }) => {
      if (dir !== "up" || json?.action !== "path") return undefined;
      if (++frames === 10) {
        proxy.set({ up: { latencyMs: 1000 } });
        setTimeout(() => proxy.set({ up: { latencyMs: 50 } }), 1000);
      }
      return undefined;
    });
    await dave.until((b) => b.match?.lies[sam.playerId]?.strokes > 0, {
      timeout: 90000,
      label: "Sam's tee shot to count",
    });
    await sleep(300);
    const shot = sam.shots[0];
    const st = proxy.stats()[0].up;
    t.diagnostic(
      `Sam sent ${shot.sent.length} samples in ${frames} frames; proxy dropped ${st.dropped}`,
    );
    C.assertClean(
      C.checkPathFidelity(sam.records(), dave.records(), {
        shots: (s) => s === shot,
        maxDelayMs: 5000, // the stall itself delays samples; only loss is checked
      }),
      "tee shot path",
    );
  },
);
