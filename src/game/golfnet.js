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
(function (global) {
  const params = new URLSearchParams(location.search);
  const isLocal =
    location.hostname === "localhost" || location.hostname === "127.0.0.1";
  const WS_URL =
    params.get("gws") ||
    (isLocal ? "ws://localhost:7780" : "wss://balls-golf.drawvid.com");

  function GolfNet(url, name) {
    this.url = url;
    this.name = name;
    this.ws = null;
    this.playerId = null;
    this.you = null; // latest per-player match state from the server
    this.onReady = null; // fired once joined (welcome received)
    this.onState = null; // fired with `you` on every snapshot
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
          if (this.onReady) this.onReady();
        } else if (m.t === "gameSnapshot") {
          this.you = m.you || null;
          if (this.onState) this.onState(this.you);
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
  GolfNet.prototype.close = function () {
    if (this.ws) {
      try {
        this.ws.close();
      } catch {}
      this.ws = null;
    }
  };

  // ---- M0 dev entry ----------------------------------------------------------
  function devBoot() {
    const joinCode = params.get("join");
    const hosting = params.get("host") === "1";
    if (!joinCode && !hosting) return;

    const name =
      (localStorage.getItem("ballsName") || "").trim() ||
      "Guest" + Math.floor(100 + Math.random() * 900);
    const net = new GolfNet(WS_URL, name);
    Object.assign(global, { golfNet: net }); // console: golfNet.ready(true), golfNet.start()

    const hud = document.createElement("div");
    hud.style.cssText =
      "position:fixed;top:8px;right:8px;z-index:9999;background:rgba(0,0,0,.7);" +
      "color:#cfc;font:12px monospace;padding:8px 10px;border-radius:6px;" +
      "pointer-events:none;white-space:pre;max-width:280px";
    hud.textContent = "golf: connecting…";
    document.body.appendChild(hud);

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
    module.exports = { GolfNet };
})(typeof globalThis !== "undefined" ? globalThis : this);
