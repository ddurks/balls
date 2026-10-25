// Helper for frame-flood.test.js (not a *.test.js file, so the mp suite never
// runs it on its own). A single client, in a process of its own, that keeps
// reading every reply (so the server's non-reader drop, which only fires
// while >1 MB is unsent to it, never does) and sends small in-spec frames as
// fast as its socket drains. argv: <url> <kind> <ms>.
const { setTimeout, setImmediate } = require("node:timers");
const WebSocket = require("ws");
const [, , url, kind, msArg] = process.argv;
const ms = Number(msArg || 4000);
const ws = new WebSocket(url);
let sent = 0;
ws.on("message", () => {}); // drain: a reader, under the non-reader cap
ws.on("error", () => {});
ws.on("open", async () => {
  ws.send(JSON.stringify({ t: "auth", token: "" }));
  ws.send(JSON.stringify({ t: "join", name: "Atk" }));
  await new Promise((r) => setTimeout(r, 200));
  const frame =
    {
      ping: '{"t":"ping"}', // schema-valid, the server must answer each with a pong
      invalid: '{"t":"nope"}', // caught by zod, answered with an err, logged
      action: '{"t":"action","action":"ready","direction":1}', // routed to golf
    }[kind] ?? "x"; // not even JSON
  const end = Date.now() + ms;
  while (Date.now() < end && ws.readyState === 1) {
    for (let i = 0; i < 2000; i++) {
      ws.send(frame);
      sent++;
    }
    // Two frames in flight at most: this is the cost the server pays per
    // frame, not a backlog the sender is hiding.
    while (ws.bufferedAmount > 4e6 && Date.now() < end)
      await new Promise((r) => setTimeout(r, 2));
    await new Promise((r) => setImmediate(r));
  }
  process.send?.({ sent });
  setTimeout(() => process.exit(0), 50);
});
