// Contract 10 (resources): a client that stops reading can't grow server
// memory without bound. Snapshots to a socket far behind are held, but every
// other reply is sent at once: a client that keeps sending tiny bad frames,
// each answered with a ~70-byte {t:'err'}, used to pile those replies up in
// the server's outgoing buffer, and one such client drove a memory-store
// server past 2 GB (the production box has 1 GB). Now a client that sends
// while over 1 MB behind on reading is dropped. (One this fast is now
// dropped sooner, as a flood, by golf's frame meter: frame-flood.test.js.
// golf.transport.test.ts holds the unsent-bytes cap to it with the meter off.)
// Run: node --test test/mp/non-reader.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const { execFile } = require("node:child_process");
const { setTimeout } = require("node:timers");
const { startGolfServer } = require("./server.js");
const { Bot } = require("./bot.js");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rssMB = (pid) =>
  new Promise((resolve) =>
    execFile("ps", ["-o", "rss=", "-p", String(pid)], (e, out) =>
      resolve(e ? NaN : Number(out) / 1024),
    ),
  );

test(
  "a client that floods without reading is dropped before its replies fill server memory",
  { timeout: 180000 },
  async (t) => {
    const srv = await startGolfServer();
    const mallory = new Bot(srv.url, "Mallory");
    const bystander = new Bot(srv.url, "Bystander");
    t.after(async () => {
      mallory.terminate();
      bystander.close();
      await srv.stop();
    });
    await Promise.all([mallory.connect(), bystander.connect()]);
    // Who the server still holds, by the bystander's snapshots: Mallory
    // doesn't read, so it can't see itself dropped until it writes again.
    let players = 2;
    bystander.ws.on("message", (d) => {
      const m = JSON.parse(String(d));
      if (m.t === "gameSnapshot") players = m.playerCount;
    });
    await sleep(1000);
    const before = await rssMB(srv.pid);

    // Stop reading: the server's replies pile up on its side of the socket.
    mallory.ws._socket.pause();
    let peak = before;
    let sent = 0;
    while (players > 1 && !mallory.closed && sent < 2_000_000) {
      for (let i = 0; i < 20000; i++) mallory.ws.send("x"); // 7 bytes, answered with an error
      sent += 20000;
      await sleep(5);
      peak = Math.max(peak, await rssMB(srv.pid));
    }
    // The server may still be working through what it had already read.
    for (let i = 0; i < 50 && players > 1; i++) {
      await sleep(300);
      peak = Math.max(peak, await rssMB(srv.pid));
    }
    t.diagnostic(
      `${sent} frames sent; server RSS ${before.toFixed(0)} MB -> peak ${peak.toFixed(0)} MB`,
    );
    assert.equal(players, 1, `still connected after ${sent} frames`);
    assert.ok(
      peak - before < 300,
      `server RSS peaked ${(peak - before).toFixed(0)} MB above baseline for one non-reading client`,
    );
    // Everyone else is still served.
    await bystander.nextSnapshot();
    assert.ok(!bystander.closed);
  },
);
