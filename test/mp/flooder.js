// A protocol bot on a thread of its own, for floods. Building and masking
// frames of megabytes is real work for the sender; on a test's own thread it
// would hold up the bystander bots' snapshots there and read as a server
// stall. The flooder joins, opens a lobby of its own, and sends what it's
// told.
//
//   const atk = await startFlooder(url, "Atk");
//   const { errs } = await atk.flood(frameText, { n: 20 });  // raw frames
//   const { chat, notices, names } = await atk.state();
//   await atk.stop();
const {
  Worker,
  isMainThread,
  parentPort,
  workerData,
} = require("node:worker_threads");
const { setTimeout } = require("node:timers");

if (isMainThread) {
  module.exports = {
    startFlooder(url, name) {
      const w = new Worker(__filename, { workerData: { url, name } });
      let seq = 0;
      const pending = new Map();
      let ready;
      const up = new Promise((resolve, reject) => {
        ready = resolve;
        w.once("error", reject);
      });
      w.on("message", (m) => {
        if (m.ready) return ready();
        pending.get(m.id)?.(m);
        pending.delete(m.id);
      });
      const ask = (msg) =>
        new Promise((resolve) => {
          const id = ++seq;
          pending.set(id, resolve);
          w.postMessage({ id, ...msg });
        });
      return up.then(() => ({
        // `n` copies of `frame`, two in flight at most (what the server pays
        // per frame, not a backlog on the sender), then a ping: once its pong
        // is back the server has handled them all. Resolves with the error
        // codes they drew.
        flood: (frame, { n = 20 } = {}) => ask({ cmd: "flood", frame, n }),
        state: () => ask({ cmd: "state" }),
        stop: () => w.terminate(),
      }));
    },
  };
} else {
  const { Bot } = require("./bot.js");
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const bot = new Bot(workerData.url, workerData.name);
  const errsFrom = (from) =>
    bot.other
      .slice(from)
      .filter((o) => o.msg?.t === "err")
      .map((o) => o.msg.code);
  parentPort.on("message", async ({ id, cmd, frame, n }) => {
    if (cmd === "flood") {
      const from = bot.other.length;
      for (let i = 0; i < n; i++) {
        while (bot.ws.bufferedAmount >= 2 * frame.length) await sleep(2);
        bot.sendRaw(frame);
      }
      const at = bot.other.length;
      bot.send({ t: "ping" });
      await bot.until(
        (b) => b.other.slice(at).some((o) => o.msg?.t === "pong"),
        { timeout: 60000, label: "pong" },
      );
      parentPort.postMessage({ id, errs: errsFrom(from) });
    } else if (cmd === "state") {
      parentPort.postMessage({
        id,
        chat: bot.chatLog().map((l) => l.text),
        notices: bot.notices.map((x) => x.text),
        names: bot.you.players.map((p) => p.name),
      });
    }
  });
  (async () => {
    await bot.connect();
    bot.create();
    await bot.untilMatch();
    parentPort.postMessage({ ready: true });
  })();
}
