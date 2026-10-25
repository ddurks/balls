// golfnet.js — GolfNet: WS client for networked course rounds (M0: match rooms).
//
// Talks to the drawvidverse worldserver's `golf` world (GAME_KEY=golf, port
// 7780). Same handshake as ClubhouseNet: auth (empty token) + join, then 12 Hz
// `gameSnapshot` frames — match-scoped state arrives on the per-player `you`
// field. Actions: create / join / leave / ready / start.
//
// M0 dev entry (no UI yet): visiting game.html?host=1 creates a match and
// game.html?join=CODE joins one; state is logged + shown in a corner readout,
// and window.golfNet is exposed so ready()/start() can be driven from the
// console. The real lobby UX (clubhouse wall phone, tap-invites) is M2.
//
// Challenge entry: game.html?mode=course&rv=KEY (from a clubhouse challenge or
// a shared challenge link) meets the opponent through the server's `rv`
// rendezvous and shows a waiting splash until the match starts. window.golfNet
// is the same GolfNet; golfNet.rv.state says where the meeting is at.
(function (global) {
  const params = new URLSearchParams(location.search);
  const isLocal =
    location.hostname === "localhost" || location.hostname === "127.0.0.1";
  const WS_URL =
    Challenge.serverOverride(location, "gws") ||
    (isLocal ? "ws://localhost:7780" : "wss://balls-golf.drawvid.com");

  function GolfNet(url, name) {
    this.url = url;
    this.name = name;
    this.ws = null;
    this.playerId = null;
    this.you = null; // latest per-player match state from the server
    this.onReady = null; // fired once joined (welcome received)
    this.onState = null; // fired with `you` on every snapshot
    this.onMatch = null; // fired after onState, for the MatchCoordinator
    this.onPath = null; // fired with each relayed {playerId, shot, samples}
    this.rv = null; // {key, state} while meeting a challenger (rvBoot)
    // Every match chat line received, kept here so lines that arrive before
    // the course has loaded (the waiting room, a restored log) aren't lost.
    this.chatLog = [];
  }

  GolfNet.prototype.connect = function () {
    let ws;
    try {
      ws = new WebSocket(this.url);
    } catch {
      return;
    }
    this.ws = ws;
    ws.onopen = () => {
      this._send({ t: "auth", token: "" });
      this._send({ t: "join", name: this.name });
    };
    ws.onmessage = (ev) => {
      let m;
      try {
        m = JSON.parse(ev.data);
      } catch {
        return;
      }
      try {
        if (m.t === "welcome") {
          this.playerId = m.playerId;
          const st = global.BallsStyle?.loadStyle();
          if (st)
            this._send({
              t: "action",
              action: "style",
              data: { hat: st.hat, skin: st.skin },
            });
          if (this.onReady) this.onReady();
        } else if (m.t === "gameSnapshot") {
          // `you` only comes when something in it changed, and `you.match`
          // only when the view did: keep the last of each.
          if (m.you) {
            const prev = this.you;
            this.you =
              !m.you.match &&
              m.you.matchCode &&
              prev?.matchCode === m.you.matchCode
                ? { ...m.you, match: prev.match }
                : m.you;
            if (m.you.chat) this.chatLog.push(...m.you.chat);
            if (this.onState) this.onState(this.you);
            if (this.onMatch) this.onMatch(this.you);
          }
          // After the view, so a path is read against the hole it was shot on.
          for (const b of m.broadcasts || [])
            if (b.type === "path" && this.onPath) this.onPath(b.data);
        }
      } catch (e) {
        console.warn("golfnet: dropped a bad server message", e);
      }
    };
  };

  GolfNet.prototype._send = function (obj) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      try {
        this.ws.send(JSON.stringify(obj));
      } catch {}
    }
  };

  GolfNet.prototype.create = function () {
    this._send({ t: "action", action: "create" });
  };
  GolfNet.prototype.join = function (code) {
    this._send({ t: "action", action: "join", message: String(code) });
  };
  GolfNet.prototype.leave = function () {
    this._send({ t: "action", action: "leave" });
  };
  GolfNet.prototype.ready = function (isReady) {
    this._send({ t: "action", action: "ready", direction: isReady ? 1 : 0 });
  };
  GolfNet.prototype.start = function () {
    this._send({ t: "action", action: "start" });
  };
  // Join-or-create the private match for a challenge's rendezvous key.
  // `token` is this side's own (see rvToken), so the server knows us when we
  // come back on a new connection.
  GolfNet.prototype.rendezvous = function (key, token) {
    this._send({
      t: "action",
      action: "rv",
      message: String(key),
      direction: token,
    });
  };
  // turnSeq names the turn the shot is played in, from this side's view.
  GolfNet.prototype.shotStart = function (club, aim, turnSeq) {
    this._send({
      t: "action",
      action: "shotStart",
      data: { club, aim, turnSeq },
    });
  };
  GolfNet.prototype.path = function (samples) {
    this._send({ t: "action", action: "path", data: { samples } });
  };
  GolfNet.prototype.shotEnd = function (restPos, holed, penalty) {
    this._send({
      t: "action",
      action: "shotEnd",
      data: { restPos, holed, penalty },
    });
  };
  GolfNet.prototype.sendChat = function (text) {
    this._send({ t: "action", action: "mchat", message: String(text) });
  };
  GolfNet.prototype.close = function () {
    if (this.ws) {
      try {
        this.ws.close();
      } catch {}
      this.ws = null;
    }
  };

  // ---- challenge rendezvous ----------------------------------------------------
  // Both players of a challenge land here with the same key; the server opens
  // a private match for the first, and starts it when the host, seeing the
  // second arrive, sends the key again: a host whose socket died without the
  // server noticing never does, and its redial takes its place instead.
  // rv.state: connecting -> waiting -> started | failed | left, and started ->
  // failed (you = null) if the match's connection drops: M1 has no rejoin, so
  // the server has forfeited it.

  // A clubhouse challenge's opponent (?vs=NAME) was in the room a moment ago
  // and is loading this page too. Past this, they aren't coming (their page
  // closed, or their clubhouse socket dropped just as the accept landed and
  // came back too late for it): say so rather than wait out the key's TTL.
  // A shared link's challenger gets the whole TTL.
  const ARRIVE_MS = 90 * 1000;

  // A random number for this tab and key, kept across reloads (sessionStorage
  // is per tab): tells the server a redial or reload is the same side again,
  // not the opponent arriving.
  function rvToken(key) {
    const k = "ballsRvToken:" + key;
    try {
      const t = Number(sessionStorage.getItem(k));
      if (Number.isSafeInteger(t) && t > 0) return t;
    } catch {}
    const r = window.crypto.getRandomValues(new Uint32Array(2));
    const t = (r[0] & 0x1fffff) * 2 ** 32 + r[1] + 1; // 53 bits, never 0
    try {
      sessionStorage.setItem(k, String(t));
    } catch {}
    return t;
  }

  function rvBoot(key, vs = null) {
    const net = new GolfNet(WS_URL, Shared.playerName());
    net.rv = { key, state: "connecting" };
    Object.assign(global, { golfNet: net });

    const toClubhouse = () =>
      Shared.roomFX.leave(Challenge.clubhouseUrl(location), {
        from: "course",
      });
    // Leaving on purpose calls the challenge off on the server, so whoever
    // turns up next is told rather than left hosting a match alone. (A socket
    // that merely drops redials instead.)
    const quit = () => {
      if (net.rv.state === "waiting") net.leave();
    };
    const splash = Splash.show({
      title: "Waiting for your opponent…",
      buttons: [
        {
          label: "Leave",
          kind: "stop",
          cancel: true,
          onClick: () => {
            quit();
            net.rv.state = "left";
            net.close();
            toClubhouse();
          },
        },
      ],
    });
    // Back, or closing the tab, while waiting is leaving too. So is a reload,
    // as far as this page can tell: it comes back with this tab's token, and
    // the server keeps a called-off key open a while for that, so an opponent
    // who turns up meanwhile still meets us. beforeunload goes first because
    // until pagehide the page still holds its place on the server, where it
    // can be paired and then forfeit, and a busy page fires pagehide a second
    // or more into the reload. Phones may skip beforeunload; pagehide they fire.
    if (typeof addEventListener === "function") {
      addEventListener("beforeunload", quit);
      addEventListener("pagehide", quit);
    }
    const failure = (title) => ({
      title,
      detail: "",
      buttons: [
        {
          label: "Clubhouse",
          kind: "go",
          cancel: true,
          onClick: toClubhouse,
        },
      ],
    });
    let timer = null;
    // ARRIVE_MS, where it applies, runs only while this side waits on the
    // server: nobody can arrive while the course is unreachable, and a deploy
    // or a dead network isn't the opponent's to answer for.
    let arriveLeft = null;
    let arriveTimer = null;
    let arriveFrom = 0;
    const arriveClock = (run) => {
      if (arriveTimer !== null) {
        clearTimeout(arriveTimer);
        arriveTimer = null;
        arriveLeft -= Date.now() - arriveFrom;
      }
      if (!run || arriveLeft === null) return;
      arriveFrom = Date.now();
      const who = Challenge.cleanName(vs);
      arriveTimer = setTimeout(
        () => giveUp(`${who} didn't make it`),
        Math.max(0, arriveLeft),
      );
    };
    const giveUp = (title) => {
      if (net.rv.state !== "connecting" && net.rv.state !== "waiting") return;
      net.rv.state = "failed";
      clearTimeout(timer);
      arriveClock(false);
      net.leave(); // frees the private match if we were the one waiting in it
      splash.update(failure(title));
    };
    const lost = () => {
      const you = net.you;
      if (!you || !you.matchCode || you.phase === "finished") return;
      net.rv.state = "failed";
      net.you = null;
      Splash.show(failure("Lost the connection to the match"));
    };

    // The server refuses the key after its TTL; no point waiting past that.
    // The key's mint time is the server's clock and this device's can be off,
    // so an estimate that makes no sense (already expired, or more than a
    // whole TTL left) waits the full TTL and lets the server judge the key.
    const left = Challenge.keyTimeLeft(key, Date.now());
    if (left === null) return giveUp("That challenge link is broken");
    const wait =
      left > 0 && left <= Challenge.RV_TTL_MS ? left : Challenge.RV_TTL_MS;
    timer = setTimeout(
      () =>
        giveUp(
          net.rv.state === "waiting"
            ? "Nobody showed up"
            : "Can't reach the course",
        ),
      wait,
    );
    if (vs != null && wait > ARRIVE_MS) arriveLeft = ARRIVE_MS;

    const token = rvToken(key);
    let drops = 0;
    let saidGo = null; // the opponent we've told the server to start with
    let redialed = false;

    const connect = () => {
      net.connect();
      if (!net.ws) return giveUp("Can't reach the course");
      net.ws.addEventListener("close", () => {
        if (net.rv.state === "started") return lost();
        if (net.rv.state !== "connecting" && net.rv.state !== "waiting") return;
        arriveClock(false);
        // The course loading on this same thread can stall the handshake past
        // the server's auth timeout, and a deploy restarts the server. Arriving
        // again is harmless (the token makes us the same side), so keep
        // redialing, backing off, until the key's time is up.
        net.rv.state = "connecting";
        net.you = null;
        saidGo = null;
        redialed = true;
        drops++;
        if (drops > 1) splash.update({ detail: "Reconnecting to the course…" });
        const delay = Math.min(1000 * 2 ** (drops - 1), 8000);
        setTimeout(() => net.rv.state === "connecting" && connect(), delay);
      });
    };
    net.onReady = () => {
      if (net.rv.state !== "connecting") return; // gave up or left meanwhile
      drops = 0;
      net.rv.state = "waiting";
      splash.update({ detail: "" });
      net.rendezvous(key, token);
      arriveClock(true);
    };
    net.onState = (you) => {
      if (!you || net.rv.state !== "waiting") return;
      if (you.notice && !you.matchCode)
        // We only redial before the start, so a seat we "left" went down
        // with the old connection as the match began.
        return giveUp(
          redialed && you.notice === "You left that match"
            ? "Lost the connection as the match started"
            : you.notice,
        );
      if (you.matchCode && you.phase && you.phase !== "lobby") {
        net.rv.state = "started";
        clearTimeout(timer);
        arriveClock(false);
        splash.close();
        return;
      }
      // Once, per opponent: after the start the key is spent, and saying it
      // again would only be refused.
      const opp = (you.players || []).find((p) => p.id !== net.playerId);
      if (
        you.matchCode &&
        you.hostId === net.playerId &&
        opp &&
        saidGo !== opp.id
      ) {
        saidGo = opp.id;
        net.rendezvous(key, token);
      }
    };
    connect();
  }

  // ---- M0 dev entry ----------------------------------------------------------
  function devBoot() {
    const rvKey = params.get("rv");
    if (rvKey) return rvBoot(rvKey, params.get("vs"));
    const joinCode = params.get("join");
    const hosting = params.get("host") === "1";
    if (!joinCode && !hosting) return;

    const net = new GolfNet(WS_URL, Shared.playerName());
    Object.assign(global, { golfNet: net }); // console: golfNet.ready(true), golfNet.start()

    const hud = document.createElement("div");
    hud.style.cssText =
      "position:fixed;top:8px;right:8px;z-index:9999;background:rgba(0,0,0,.7);" +
      "color:#cfc;font:12px monospace;padding:8px 10px;border-radius:6px;" +
      "pointer-events:none;white-space:pre;max-width:280px";
    hud.textContent = "golf: connecting…";
    if (params.has("debug")) document.body.appendChild(hud);

    net.onReady = () => {
      if (hosting) net.create();
      else net.join(joinCode);
    };
    net.onState = (you) => {
      if (!you) return;
      if (you.notice) console.warn("golf:", you.notice);
      if (you.feed) for (const line of you.feed) console.log("golf:", line);
      if (!you.matchCode) {
        hud.textContent =
          "golf: no match" + (you.notice ? `\n${you.notice}` : "");
        return;
      }
      const roster = (you.players || [])
        .map(
          (p) =>
            `${p.ready ? "✔" : "·"} ${p.name}${p.id === you.hostId ? " (host)" : ""}`,
        )
        .join("\n");
      hud.textContent =
        `match ${you.matchCode} — ${you.phase}\n${roster}` +
        (you.notice ? `\n! ${you.notice}` : "");
    };
    net.connect();
  }

  if (document.readyState === "loading")
    document.addEventListener("DOMContentLoaded", devBoot);
  else devBoot();

  Object.assign(global, { GolfNet });
  if (typeof module !== "undefined" && module.exports)
    module.exports = { GolfNet, rvBoot, ARRIVE_MS };
})(/** @type {any} */ (typeof globalThis !== "undefined" ? globalThis : this));
