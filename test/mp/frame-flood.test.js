// Contracts 10 (resources) and 3 (liveness): one client can't exhaust the
// event loop every match shares by sending small frames as fast as it can.
// A client that keeps reading its replies (so the non-reader drop, which only
// fires while >1 MB is unsent to it, never does) and sends tiny in-spec frames
// (so the 64 KB frame cap never does) could push ~170k frames a second, each a
// JSON.parse, a zod parse and often a reply: `ping`, any `action`, `chat`,
// junk that fails validation. Only `in`, RTC signaling and bootstrap uploads
// were rate-limited. The server's loop stalled 2-4 s at a time, freezing every
// match's snapshots, path relays and turn timers.
// Now golf reads at most 100 frames a second from one connection, before
// anything is parsed: past that its socket isn't read until the next second
// (frames already read wait, in order), and one that has read ten seconds'
// worth ahead, or runs past its budget ten seconds in a row, is dropped.
//
// Measured from the server's side: a bystander connection (alone in this
// process) pings every 150 ms and times the pong, a probe of the server's
// loop. The flooder runs in a process of its own (frame-flood-child.js), so
// a stall is the server's, not contention here. Idle the pong is back in a
// few ms; it must stay so whatever the flood.
// Run: node --test test/mp/frame-flood.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { fork } = require("node:child_process");
const { setInterval, clearInterval } = require("node:timers");
const { setTimeout: sleep } = require("node:timers/promises");
const WebSocket = require("ws");
const { startGolfServer } = require("./server.js");

const CHILD = path.join(__dirname, "frame-flood-child.js");
const PORTS = [7823, 7824, 7825, 7826, 7827, 7828, 7829];
// Idle this probe sees ~1-20 ms, and metered the same; unmetered, 250 ms
// (an action flood) to 4 s (junk frames, each logged).
const RTT_LIMIT_MS = 250;

async function startOnAnyPort(env) {
  let lastErr;
  for (const port of PORTS) {
    try {
      return await startGolfServer({ port, env });
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr;
}

// A lone bystander probing the server's event-loop latency: ping every 150 ms,
// record each pong's round trip.
function rttProbe(url) {
  const ws = new WebSocket(url);
  const rtts = [];
  let sentAt = null;
  let timer = null;
  ws.on("message", (d) => {
    let m;
    try {
      m = JSON.parse(d.toString());
    } catch {
      return;
    }
    if (m.t === "pong" && sentAt != null) {
      rtts.push(Date.now() - sentAt);
      sentAt = null;
    }
  });
  ws.on("error", () => {});
  ws.on("open", () => {
    ws.send(JSON.stringify({ t: "auth", token: "" }));
    ws.send(JSON.stringify({ t: "join", name: "Probe" }));
    timer = setInterval(() => {
      if (ws.readyState !== WebSocket.OPEN || sentAt != null) return;
      sentAt = Date.now();
      ws.send('{"t":"ping"}');
    }, 150);
  });
  return {
    rtts,
    stop() {
      clearInterval(timer);
      ws.close();
    },
  };
}

async function worstRttDuringFlood(url, kind) {
  const probe = rttProbe(url);
  await sleep(1500); // warm up; confirm the loop is healthy first
  const ctrl = Math.max(0, ...probe.rtts.splice(0));
  const child = fork(CHILD, [url, kind, "4000"], { stdio: "ignore" });
  await new Promise((r) => child.on("exit", r));
  await sleep(400); // let any queued pong land
  const during = Math.max(0, ...probe.rtts.splice(0));
  probe.stop();
  return { ctrl, during };
}

test(
  "a single reading client flooding small frames stalls no other match",
  { timeout: 120000 },
  async (t) => {
    const srv = await startOnAnyPort({ GOLF_TURN_TIMEOUT_MS: "600000" });
    t.after(() => srv.stop());

    await t.test("flood of valid ping frames", async () => {
      const { ctrl, during } = await worstRttDuringFlood(srv.url, "ping");
      t.diagnostic(`ping flood: control ${ctrl} ms, during ${during} ms`);
      assert.ok(
        ctrl < 200,
        `server already unhealthy before the flood (${ctrl} ms)`,
      );
      assert.ok(
        during < RTT_LIMIT_MS,
        `the server's event loop stalled ${during} ms under a ping flood (idle ${ctrl} ms); every other match's snapshots and timers were frozen that long`,
      );
    });

    for (const kind of ["invalid", "action"])
      await t.test(`flood of ${kind} frames`, async () => {
        const { ctrl, during } = await worstRttDuringFlood(srv.url, kind);
        t.diagnostic(`${kind} flood: control ${ctrl} ms, during ${during} ms`);
        assert.ok(
          during < RTT_LIMIT_MS,
          `the server's event loop stalled ${during} ms under a flood of ${kind} frames (idle ${ctrl} ms)`,
        );
      });
  },
);
