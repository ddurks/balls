// A byte-level TCP link for liveness runs (tcp-fuzz, sim-tcp): latency + jitter
// and a bandwidth cap in each direction, with a bounded in-flight buffer, so
// the server feels the link the way it feels a real one (TCP backpressure,
// late pongs). The WS chaos proxy answers the server's pings itself and reads
// as fast as the server sends, so the lag gate never closes behind it.
//
//   const link = await startTcpLink(srv.url, { up: {...}, down: {...} });
//   link.set({ down: { latencyMs: 300, jitterMs: 100, bytesPerSec: 4000 } });
//   link.stall(5000);                  // nothing moves either way for 5 s
//   link.halfOpen();                   // stop forwarding, keep both sockets (no FIN, no RST)
//   link.reset();                      // RST both sides
//   await link.close();
const net = require("node:net");
const { URL } = require("node:url");
const { setTimeout, clearTimeout } = require("node:timers");

function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

class Lane {
  constructor(link, src, dst, cfg) {
    this.link = link;
    this.src = src;
    this.dst = dst;
    this.cfg = cfg; // live {latencyMs, jitterMs, bytesPerSec, holdBytes}
    this.q = []; // {due, buf}
    this.queued = 0;
    this.lastDue = 0;
    this.nextFree = 0; // when the wire is next free (bandwidth)
    this.timer = null;
    this.paused = false;
    src.on("data", (buf) => this.push(buf));
  }

  push(buf) {
    if (this.link.dead) return;
    const c = this.cfg;
    const now = Date.now();
    const lag = c.latencyMs + this.link.random() * c.jitterMs;
    const due = Math.max(this.lastDue, now + lag);
    this.lastDue = due;
    this.q.push({ due, buf });
    this.queued += buf.length;
    if (this.queued > c.holdBytes && !this.paused) {
      this.paused = true;
      this.src.pause();
    }
    this.pump();
  }

  pump() {
    if (this.timer || !this.q.length || this.link.dead) return;
    const now = Date.now();
    const at = Math.max(this.q[0].due, this.nextFree, this.link.stalledUntil);
    this.timer = setTimeout(
      () => {
        this.timer = null;
        if (this.link.dead) return;
        const t = Date.now();
        if (t < this.link.stalledUntil) return this.pump();
        const bps = this.cfg.bytesPerSec;
        while (this.q.length && this.q[0].due <= t && this.nextFree <= t) {
          const head = this.q[0];
          // Send at most what the wire carries in ~20 ms, so a cap is smooth.
          const n = Number.isFinite(bps)
            ? Math.max(1, Math.min(head.buf.length, Math.ceil(bps / 50)))
            : head.buf.length;
          this.dst.write(head.buf.subarray(0, n));
          if (n === head.buf.length) this.q.shift();
          else head.buf = head.buf.subarray(n);
          this.queued -= n;
          if (Number.isFinite(bps))
            this.nextFree = Math.max(this.nextFree, t) + (n * 1000) / bps;
        }
        if (this.paused && this.queued <= this.cfg.holdBytes) {
          this.paused = false;
          this.src.resume();
        }
        this.pump();
      },
      Math.max(0, at - now),
    );
  }

  clear() {
    clearTimeout(this.timer);
    this.timer = null;
    this.q = [];
    this.queued = 0;
  }
}

const DEFAULT = {
  latencyMs: 0,
  jitterMs: 0,
  bytesPerSec: Infinity,
  holdBytes: 16384,
};

/**
 * One TCP proxy; every client connection that comes in gets its own upstream
 * and its own lanes, all sharing these live settings.
 */
async function startTcpLink(target, { up = {}, down = {}, seed = 1 } = {}) {
  const u = new URL(target);
  const cfg = { up: { ...DEFAULT, ...up }, down: { ...DEFAULT, ...down } };
  const conns = [];
  const random = rng(seed);
  const server = net.createServer((client) => {
    const upstream = net.connect(Number(u.port), u.hostname);
    const c = { client, upstream, dead: false, stalledUntil: 0, random };
    c.up = new Lane(c, client, upstream, cfg.up);
    c.down = new Lane(c, upstream, client, cfg.down);
    conns.push(c);
    const end = () => {
      if (c.dead && c.halfOpen) return; // a half-open link never says goodbye
      c.dead = true;
      c.up.clear();
      c.down.clear();
      client.destroy();
      upstream.destroy();
    };
    for (const s of [client, upstream]) {
      s.on("close", end);
      s.on("error", end);
    }
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const link = {
    url: `ws://127.0.0.1:${server.address().port}`,
    conns,
    cfg,
    set(o = {}) {
      for (const d of ["up", "down"]) if (o[d]) Object.assign(cfg[d], o[d]);
      for (const k of Object.keys(DEFAULT))
        if (o[k] !== undefined)
          for (const d of ["up", "down"]) cfg[d][k] = o[k];
    },
    /** Nothing moves either way for `ms` (bytes keep queueing, then flow in order). */
    stall(ms, which = conns) {
      const until = Date.now() + ms;
      for (const c of which) {
        c.stalledUntil = until;
        c.up.pump();
        c.down.pump();
      }
    },
    /** The network dies silently: no more bytes either way, no FIN, no RST. */
    halfOpen(which = conns) {
      for (const c of which) {
        c.halfOpen = true;
        c.dead = true;
        c.up.clear();
        c.down.clear();
        // Keep reading so neither end sees backpressure (a real dead path
        // would leave the sender retransmitting into the void).
        c.client.resume();
        c.upstream.resume();
      }
    },
    /** Abrupt reset of both sides. */
    reset(which = conns) {
      for (const c of which) {
        c.dead = true;
        c.up.clear();
        c.down.clear();
        c.client.resetAndDestroy?.() ?? c.client.destroy();
        c.upstream.resetAndDestroy?.() ?? c.upstream.destroy();
      }
    },
    close() {
      return new Promise((r) => {
        for (const c of conns) {
          c.dead = true;
          c.halfOpen = false;
          c.up.clear();
          c.down.clear();
          c.client.destroy();
          c.upstream.destroy();
        }
        server.close(() => r());
      });
    },
  };
  return link;
}

module.exports = { startTcpLink };
