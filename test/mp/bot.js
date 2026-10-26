// Protocol bot for the golf world server: Node + ws speaking the wire protocol
// directly (no game code). Records everything it receives, with arrival times
// and byte sizes, so test/mp/checks.js can audit a run afterwards.
//
//   const bot = new Bot(url, "Dave");
//   await bot.connect();
//   bot.create(); await bot.untilMatch();
//   bot.ready(); bot.start();
//   await bot.untilMyTurn();
//   bot.shotStart(12, 0); bot.path([[0.1, x, y, z, 0, 0, 0, 1]]); bot.shotEnd(pos);
//
// `you` is the latest per-player state; notice/feed/chat are one-shot on the
// wire, so they are accumulated here (notices[], feed[], chat by match code,
// then seq: a new match starts its seq at 1 again). The server sends `you`
// only when something in it changed, and `you.match` only when the view did,
// so `you` keeps the last of each received (snaps[] records each snapshot as
// it arrived).
//
// opts.address: the client address to claim, as a local reverse proxy would
// (X-Forwarded-For, which the server takes from a loopback peer): bots on one
// machine can stand for clients on several, e.g. for golf's per-address
// join-code limit.
const { setTimeout, clearTimeout } = require("node:timers");
const WebSocket = require("ws");
const { CLUB_MAX, holeById } = require("./holes.js");

class Bot {
  constructor(url, name = "Bot", { log = false, address = null } = {}) {
    this.url = url;
    this.name = name;
    this.log = log;
    this.address = address;
    this.ws = null;
    this.playerId = null;
    this.you = null;
    this.snaps = []; // {at, bytes, you, keys, nb}: every gameSnapshot
    this.broadcasts = []; // {at, type, data}: per-player relays (path frames)
    this.chat = new Map(); // matchCode -> Map(seq -> line), deduped
    this.chatDeliveries = []; // {at, i, code, lines}: as delivered (i: index in snaps), for order/dup checks
    this.notices = []; // {at, text}
    this.feed = []; // {at, text}
    this.other = []; // {at, msg}: anything that isn't welcome/gameSnapshot
    this.sent = []; // {at, msg}: everything this bot sent (path frames included)
    this.closed = false;
    this.closeInfo = null;
    this._waiters = new Set();
  }

  // ---- connection ----------------------------------------------------------

  connect({ timeout = 10000 } = {}) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(
        this.url,
        this.address
          ? { headers: { "x-forwarded-for": this.address } }
          : undefined,
      );
      this.ws = ws;
      const timer = setTimeout(() => {
        reject(new Error(`${this.name}: no welcome within ${timeout} ms`));
        ws.terminate();
      }, timeout);
      ws.on("open", () => {
        this.send({ t: "auth", token: "" });
        this.send({ t: "join", name: this.name });
      });
      ws.on("message", (data) => this._onMessage(data));
      ws.on("close", (code, reason) => {
        this.closed = true;
        this.closeInfo = { at: Date.now(), code, reason: String(reason) };
        clearTimeout(timer);
        reject(new Error(`${this.name}: closed before welcome`));
        this._wake();
      });
      ws.on("error", (e) => {
        if (this.log) console.warn(`[${this.name}] ws error`, e.message);
      });
      this._welcome = (id) => {
        clearTimeout(timer);
        resolve(id);
      };
    });
  }

  _onMessage(data) {
    const at = Date.now();
    const text = data.toString();
    let m;
    try {
      m = JSON.parse(text);
    } catch {
      this.other.push({ at, msg: text });
      return;
    }
    if (m.t === "welcome") {
      this.playerId = m.playerId;
      this._welcome?.(m.playerId);
    } else if (m.t === "gameSnapshot") {
      const { you, broadcasts } = m;
      const prev = this.you;
      if (you)
        this.you =
          !you.match && you.matchCode && prev?.matchCode === you.matchCode
            ? { ...you, match: prev.match }
            : you;
      this.snaps.push({
        at,
        bytes: Buffer.byteLength(text),
        you: you ?? null,
        keys: Object.keys(m),
        nb: broadcasts?.length ?? 0,
      });
      for (const b of broadcasts ?? [])
        this.broadcasts.push({ at, type: b.type, data: b.data });
      if (you?.notice) this.notices.push({ at, text: you.notice });
      for (const line of you?.feed ?? []) this.feed.push({ at, text: line });
      if (you?.chat) {
        const code = you.matchCode;
        // i: the snapshot that carried them (several can share one `at`).
        this.chatDeliveries.push({
          at,
          i: this.snaps.length - 1,
          code,
          lines: you.chat,
        });
        if (!this.chat.has(code)) this.chat.set(code, new Map());
        for (const line of you.chat) this.chat.get(code).set(line.seq, line);
      }
      this.onSnapshot?.(this);
    } else {
      this.other.push({ at, msg: m });
    }
    this._wake();
  }

  send(obj) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
    this.sent.push({ at: Date.now(), msg: obj });
    this.ws.send(JSON.stringify(obj));
    return true;
  }

  // Any string, valid JSON or not (fuzzing).
  sendRaw(text) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
    this.sent.push({ at: Date.now(), raw: text });
    this.ws.send(text);
    return true;
  }

  close() {
    this.ws?.close();
  }

  // Abrupt drop (no close frame), like a dead tab or lost network.
  terminate() {
    this.ws?.terminate();
  }

  // ---- actions -------------------------------------------------------------

  action(action, fields = {}) {
    return this.send({ t: "action", action, ...fields });
  }
  create() {
    return this.action("create");
  }
  join(code) {
    return this.action("join", { message: String(code) });
  }
  leave() {
    return this.action("leave");
  }
  ready(on = true) {
    return this.action("ready", { direction: on ? 1 : 0 });
  }
  start() {
    return this.action("start");
  }
  rv(key) {
    return this.action("rv", { message: key });
  }
  // Back to the seat `seat` (its key, from a match view's `seats`) in a started match.
  resume(matchId, seat) {
    return this.action("resume", { message: matchId, data: { seat } });
  }
  // turnSeq names the turn the shot is played in (the view's, by default).
  shotStart(club, aim, turnSeq = this.match?.turnSeq) {
    this._streamed = false;
    this._autoT = 0;
    return this.action("shotStart", { data: { club, aim, turnSeq } });
  }
  path(samples) {
    this._streamed = true;
    return this.action("path", { data: { samples } });
  }
  // The server refuses a result its streamed path doesn't reach, so a shot the
  // test didn't stream gets one at-rest frame first, as the client sends last.
  // opts.noPath sends shotEnd alone.
  shotEnd(restPos, holed = false, penalty = 0, { noPath = false } = {}) {
    const p = restPos;
    if (
      !noPath &&
      !this._streamed &&
      p &&
      [p.x, p.y, p.z].every(Number.isFinite)
    ) {
      this._autoT = (this._autoT ?? 0) + 0.1;
      this.action("path", {
        data: { samples: [[this._autoT, p.x, p.y, p.z, 0, 0, 0, 1]] },
      });
    }
    return this.action("shotEnd", { data: { restPos, holed, penalty } });
  }
  mchat(text) {
    return this.action("mchat", { message: text });
  }
  // The world's plain chat message; the golf world routes it to the match.
  chatPlain(text) {
    return this.send({ t: "chat", text });
  }

  // ---- state ---------------------------------------------------------------

  get match() {
    return this.you?.match ?? null;
  }
  get code() {
    return this.you?.matchCode ?? null;
  }
  get myLie() {
    return this.match?.lies?.[this.playerId] ?? null;
  }
  isMyTurn() {
    const m = this.match;
    return (
      !!m && m.phase === "playing" && m.turn === this.playerId && !m.shotOpen
    );
  }
  // The match chat as received (default: the current or most recent match).
  chatLog(code = this.code ?? [...this.chat.keys()].pop()) {
    return [...(this.chat.get(code)?.values() ?? [])].sort(
      (a, b) => a.seq - b.seq,
    );
  }
  pathsFrom(playerId) {
    return this.broadcasts.filter(
      (b) => b.type === "path" && b.data.playerId === playerId,
    );
  }

  // Plain-data copy for checks.js (and for writing to disk).
  records() {
    return {
      name: this.name,
      playerId: this.playerId,
      snaps: this.snaps,
      broadcasts: this.broadcasts,
      chatDeliveries: this.chatDeliveries,
      notices: this.notices,
      feed: this.feed,
      other: this.other,
      sent: this.sent,
      closeInfo: this.closeInfo,
    };
  }

  // ---- waiting -------------------------------------------------------------

  _wake() {
    for (const w of [...this._waiters]) w();
  }

  /**
   * Resolve with pred(this)'s value once it is truthy; re-checked after every
   * incoming message. Rejects on timeout, or on close unless `allowClosed`.
   */
  until(
    pred,
    { timeout = 15000, label = "condition", allowClosed = false } = {},
  ) {
    return new Promise((resolve, reject) => {
      let timer = null;
      const check = () => {
        let v;
        try {
          v = pred(this);
        } catch (e) {
          done();
          reject(e);
          return;
        }
        if (v) {
          done();
          resolve(v);
        } else if (this.closed && !allowClosed) {
          done();
          reject(
            new Error(`${this.name}: connection closed waiting for ${label}`),
          );
        }
      };
      const done = () => {
        clearTimeout(timer);
        this._waiters.delete(check);
      };
      timer = setTimeout(() => {
        done();
        reject(
          new Error(
            `${this.name}: timed out after ${timeout} ms waiting for ${label}`,
          ),
        );
      }, timeout);
      this._waiters.add(check);
      check();
    });
  }

  untilMatch(opts) {
    return this.until((b) => b.code, { label: "a match", ...opts });
  }
  untilPhase(phase, opts) {
    return this.until((b) => b.you?.phase === phase && b.you, {
      label: `phase ${phase}`,
      ...opts,
    });
  }
  untilMyTurn(opts) {
    return this.until((b) => b.isMyTurn() && b.match, {
      label: "my turn",
      ...opts,
    });
  }
  // A notice arriving after now (they are one-shot).
  untilNotice(re = /./, opts) {
    const from = this.notices.length;
    return this.until(
      (b) => b.notices.slice(from).find((n) => re.test(n.text))?.text,
      { label: `notice ${re}`, ...opts },
    );
  }
  untilChat(re, opts) {
    return this.until((b) => b.chatLog().find((l) => re.test(l.text)), {
      label: `chat ${re}`,
      ...opts,
    });
  }
  // The next gameSnapshot after now.
  nextSnapshot(opts) {
    const n = this.snaps.length;
    return this.until(
      (b) => b.snaps.length > n && b.snaps[b.snaps.length - 1],
      {
        label: "next snapshot",
        ...opts,
      },
    );
  }
}

/**
 * Connected clients (Bots or SimClients) into one match: the first creates
 * it, the rest join, all ready up, and the host starts unless start === false.
 */
async function lobby(clients, { start = true } = {}) {
  const [host, ...guests] = clients;
  host.create();
  const code = await host.untilMatch();
  for (const g of guests) {
    g.join(code);
    await g.untilMatch();
  }
  for (const c of clients) c.ready(true);
  await Promise.all(
    clients.map((c) =>
      c.until(
        (x) =>
          x.you?.players?.length === clients.length &&
          x.you.players.every((p) => p.ready),
        { label: "everyone ready" },
      ),
    ),
  );
  if (start) {
    host.start();
    await Promise.all(clients.map((c) => c.untilPhase("playing")));
  }
  return code;
}

/** New Bots on `url`, connected and in one match (see lobby()). */
async function setupMatch(
  url,
  names = ["Dave", "Sam"],
  { start = true, log = false } = {},
) {
  const bots = names.map((n) => new Bot(url, n, { log }));
  await Promise.all(bots.map((b) => b.connect()));
  const code = await lobby(bots, { start });
  const [host, ...guests] = bots;
  return { code, bots, host, guests };
}

/**
 * A physics-free shot for fast protocol runs: rest `fraction` of the way from
 * the lie toward the pin (holed once within `holeWithin` m), with a straight
 * path streamed in `frames` frames. Returns what was sent.
 */
function fakeShot(
  bot,
  { fraction = 0.6, holeWithin = 3, frames = 3, club } = {},
) {
  const m = bot.match;
  const from = m.lies[bot.playerId].pos ?? holeById(m.holeId).tee;
  const pin = m.pin;
  const d = Math.hypot(pin.x - from.x, pin.z - from.z);
  const holed = d <= holeWithin;
  const f = holed ? 1 : fraction;
  const rest = {
    x: from.x + (pin.x - from.x) * f,
    y: from.y + (pin.y - from.y) * f,
    z: from.z + (pin.z - from.z) * f,
  };
  const reach = Math.hypot(rest.x - from.x, rest.z - from.z);
  const fits = CLUB_MAX.findIndex((x) => x >= reach);
  bot.shotStart(
    club ?? (fits < 0 ? 12 : fits),
    Math.atan2(pin.x - from.x, -(pin.z - from.z)),
  );
  const samples = [];
  for (let i = 1; i <= frames; i++) {
    const k = i / frames;
    samples.push([
      0.05 * i,
      from.x + (rest.x - from.x) * k,
      from.y + (rest.y - from.y) * k,
      from.z + (rest.z - from.z) * k,
      0,
      0,
      0,
      1,
    ]);
  }
  for (const s of samples) bot.path([s]);
  bot.shotEnd(rest, holed, 0);
  return { from, rest, holed, samples };
}

module.exports = { Bot, lobby, setupMatch, fakeShot };
