// Chaos proxy: a WebSocket man-in-the-middle between clients and the golf
// server. Each client that connects to proxy.url gets its own upstream
// connection to `target`; every message in either direction passes a pipe
// that can delay it (latency + jitter, order kept as TCP keeps it), throttle
// it (bytes per second), drop it, or cut the connection.
//
//   const proxy = await startChaosProxy({ target: srv.url, latencyMs: 150, jitterMs: 100 });
//   const sam = new SimClient(proxy.url, "Sam");
//   proxy.set({ latencyMs: 400 });                  // live, both directions
//   proxy.set({ down: { bytesPerSec: 2000 } });     // server -> client only
//   proxy.disconnect();                             // abrupt drop, every client
//   proxy.blackhole(3000);                          // lose everything 3 s, then drop
//   proxy.disconnectWhen(({ dir, json }) =>         // drop at a chosen moment
//     dir === "up" && json?.action === "shotEnd");
//   await proxy.close();
//
// dir is "up" (client -> server) or "down" (server -> client). dropRate loses
// single messages, which a real TCP stream never does: it is a fuzz knob.
const http = require("node:http");
const net = require("node:net");
const { URL } = require("node:url");
const {
  setTimeout,
  clearTimeout,
  setInterval,
  clearInterval,
} = require("node:timers");
const WebSocket = require("ws");

const DIRS = ["up", "down"];
const KNOBS = ["latencyMs", "jitterMs", "bytesPerSec", "dropRate"];

class Pipe {
  constructor(conn, dir, cfg) {
    this.conn = conn;
    this.dir = dir;
    this.cfg = cfg; // shared, live: the proxy's per-direction settings
    this.queue = []; // {at, data, isBinary}
    this.lastAt = 0;
    this.timer = null;
    this.stats = { messages: 0, bytes: 0, dropped: 0, delivered: 0 };
  }

  push(data, isBinary) {
    const c = this.cfg[this.dir];
    const size = data.length;
    this.stats.messages++;
    this.stats.bytes += size;
    if (c.dropRate > 0 && this.conn.proxy.random() < c.dropRate) {
      this.stats.dropped++;
      return;
    }
    const now = Date.now();
    const lag = c.latencyMs + this.conn.proxy.random() * c.jitterMs;
    const wire =
      Number.isFinite(c.bytesPerSec) && c.bytesPerSec > 0
        ? (size * 1000) / c.bytesPerSec
        : 0;
    // Never overtake the message before it: TCP delivers in order.
    const at = Math.max(this.lastAt, now + lag) + wire;
    this.lastAt = at;
    this.queue.push({ at, data, isBinary });
    this.pump();
  }

  pump() {
    if (this.timer || !this.queue.length) return;
    this.timer = setTimeout(
      () => {
        this.timer = null;
        const sink = this.dir === "up" ? this.conn.server : this.conn.client;
        if (!sink || sink.readyState !== WebSocket.OPEN) {
          // Upstream still connecting: hold the queue until it opens.
          if (sink && sink.readyState === WebSocket.CONNECTING)
            this.timer = setTimeout(
              () => ((this.timer = null), this.pump()),
              5,
            );
          return;
        }
        const now = Date.now();
        while (this.queue.length && this.queue[0].at <= now) {
          const m = this.queue.shift();
          sink.send(m.data, { binary: m.isBinary });
          this.stats.delivered++;
        }
        if (this.queue.length) this.pump();
        else this.onDrained?.();
      },
      Math.max(0, this.queue[0].at - Date.now()),
    );
  }

  clear() {
    clearTimeout(this.timer);
    this.timer = null;
    this.queue = [];
  }
}

class ChaosProxy {
  constructor({ target, port = 0, host = "127.0.0.1", seed, ...knobs } = {}) {
    this.target = target;
    this.port = port;
    this.host = host;
    this.cfg = {
      up: { latencyMs: 0, jitterMs: 0, bytesPerSec: Infinity, dropRate: 0 },
      down: { latencyMs: 0, jitterMs: 0, bytesPerSec: Infinity, dropRate: 0 },
    };
    this.set(knobs);
    let a = (seed ?? Date.now()) >>> 0;
    this.random = () => {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    this.conns = [];
    this.hooks = [];
    this.blackholeUntil = { up: 0, down: 0 };
    this.events = []; // {at, conn, what}: disconnects and other chaos, for reports
  }

  /** knobs apply to both directions; {up: {...}, down: {...}} to one. */
  set(opts = {}) {
    for (const k of KNOBS)
      if (opts[k] !== undefined) for (const d of DIRS) this.cfg[d][k] = opts[k];
    for (const d of DIRS) if (opts[d]) Object.assign(this.cfg[d], opts[d]);
    return this;
  }

  listen() {
    return new Promise((resolve) => {
      this.http = http.createServer();
      this.wss = new WebSocket.Server({
        server: this.http,
        perMessageDeflate: false,
      });
      this.wss.on("connection", (client) => this._accept(client));
      this.http.listen(this.port, this.host, () => {
        this.port = this.http.address().port;
        this.url = `ws://${this.host}:${this.port}`;
        resolve(this);
      });
    });
  }

  _accept(client) {
    const conn = {
      id: this.conns.length + 1,
      proxy: this,
      client,
      server: null,
      open: true,
    };
    conn.up = new Pipe(conn, "up", this.cfg);
    conn.down = new Pipe(conn, "down", this.cfg);
    this.conns.push(conn);
    const server = new WebSocket(this.target, { perMessageDeflate: false });
    conn.server = server;
    server.on("open", () => conn.up.pump());
    const relay = (dir, pipe) => (data, isBinary) => {
      if (!conn.open) return;
      if (Date.now() < this.blackholeUntil[dir]) {
        pipe.stats.messages++;
        pipe.stats.dropped++;
        return;
      }
      let action;
      if (this.hooks.length) {
        const text = isBinary ? null : data.toString();
        let json = null;
        try {
          json = text && JSON.parse(text);
        } catch {
          // not JSON: hooks get json = null
        }
        for (const h of this.hooks) {
          action = h({ dir, data: text, json, conn }) || action;
        }
      }
      if (action === "disconnect") return this._cut(conn, `hook on ${dir}`);
      if (action === "drop") {
        pipe.stats.messages++;
        pipe.stats.dropped++;
        return;
      }
      pipe.push(data, isBinary);
    };
    client.on("message", relay("up", conn.up));
    server.on("message", relay("down", conn.down));
    // A clean close travels behind the data already in flight, like a FIN.
    const closeAfter = (pipe, other) => () => {
      if (!conn.open) return;
      conn.open = false;
      const end = () => other.readyState === WebSocket.OPEN && other.close();
      if (pipe.queue.length) pipe.onDrained = end;
      else end();
      if (other.readyState === WebSocket.CONNECTING) other.terminate();
    };
    client.on("close", closeAfter(conn.up, server));
    server.on("close", closeAfter(conn.down, client));
    client.on("error", () => {});
    server.on("error", () => this._cut(conn, "upstream error"));
  }

  // Abrupt: no close frames, queued messages lost (a dead network).
  _cut(conn, why) {
    if (!conn.open && conn.cut) return;
    conn.open = false;
    conn.cut = true;
    conn.up.clear();
    conn.down.clear();
    this.events.push({
      at: Date.now(),
      conn: conn.id,
      what: `disconnect: ${why}`,
    });
    conn.client.terminate();
    conn.server?.terminate();
  }

  /** Drop connections now: all, or the conn with this id. */
  disconnect(id = null, why = "forced") {
    for (const c of this.conns)
      if (c.open && (id == null || c.id === id)) this._cut(c, why);
  }

  /** Lose every message for `ms` (both directions or one), then disconnect. */
  blackhole(ms, { dir = "both", thenDisconnect = true } = {}) {
    const until = Date.now() + ms;
    for (const d of DIRS)
      if (dir === "both" || dir === d) this.blackholeUntil[d] = until;
    this.events.push({ at: Date.now(), what: `blackhole ${dir} ${ms} ms` });
    return new Promise((r) =>
      setTimeout(() => {
        if (thenDisconnect) this.disconnect(null, "after blackhole");
        r();
      }, ms),
    );
  }

  /** hook({dir, data, json, conn}) may return "drop" or "disconnect". */
  onMessage(hook) {
    this.hooks.push(hook);
    return () => (this.hooks = this.hooks.filter((h) => h !== hook));
  }

  /** Cut the connection the first time pred({dir, data, json, conn}) is true. */
  disconnectWhen(pred) {
    return new Promise((resolve) => {
      const off = this.onMessage((m) => {
        if (!pred(m)) return undefined;
        off();
        resolve(m);
        return "disconnect";
      });
    });
  }

  stats() {
    return this.conns.map((c) => ({
      id: c.id,
      open: c.open,
      up: c.up.stats,
      down: c.down.stats,
    }));
  }

  close() {
    for (const c of this.conns) {
      c.open = false;
      c.up.clear();
      c.down.clear();
      c.client.terminate();
      c.server?.terminate();
    }
    return new Promise((r) => this.wss.close(() => this.http.close(() => r())));
  }
}

async function startChaosProxy(opts) {
  return new ChaosProxy(opts).listen();
}

/**
 * A byte-level TCP throttle, server to client. The chaos proxy above reads
 * the server's socket as fast as it arrives and paces in user space, so the
 * server never sees a backlog (and its WebSocket client answers the server's
 * pings itself). This reads from the server only as fast as it forwards, so
 * TCP backpressure and ping round trips reach the server the way a slow
 * network's do. The client to server direction passes untouched.
 *
 *   const thr = await startTcpThrottle(srv.url, 3000); // bytes per second
 *   const sam = new Bot(thr.url, "Sam"); ... await thr.close();
 */
function startTcpThrottle(
  target,
  bytesPerSec,
  { chunk = 256, holdBytes = 4096 } = {},
) {
  const u = new URL(target);
  const conns = [];
  const server = net.createServer((client) => {
    const up = net.connect(Number(u.port), u.hostname);
    const c = { client, up, queue: [], queued: 0, timer: null };
    conns.push(c);
    client.pipe(up);
    up.on("data", (buf) => {
      c.queue.push(buf);
      c.queued += buf.length;
      if (c.queued > holdBytes) up.pause();
    });
    c.timer = setInterval(
      () => {
        let budget = chunk;
        while (budget > 0 && c.queue.length) {
          const b = c.queue[0];
          const n = Math.min(budget, b.length);
          client.write(b.subarray(0, n));
          if (n === b.length) c.queue.shift();
          else c.queue[0] = b.subarray(n);
          c.queued -= n;
          budget -= n;
        }
        if (c.queued <= holdBytes) up.resume();
      },
      (chunk * 1000) / bytesPerSec,
    );
    const end = () => {
      clearInterval(c.timer);
      client.destroy();
      up.destroy();
    };
    for (const s of [client, up]) {
      s.on("close", end);
      s.on("error", end);
    }
  });
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () =>
      resolve({
        url: `ws://127.0.0.1:${server.address().port}`,
        close: () =>
          new Promise((r) => {
            for (const c of conns) {
              clearInterval(c.timer);
              c.client.destroy();
              c.up.destroy();
            }
            server.close(() => r());
          }),
      }),
    ),
  );
}

module.exports = { ChaosProxy, startChaosProxy, startTcpThrottle };
