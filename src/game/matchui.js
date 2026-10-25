// matchui.js — the match's HUD: the match-play status chip, a result card
// between holes, the match chat (feed + input, scoped to the match, apart
// from the clubhouse's) and speech bubbles over the speaker's ball.
//
// matchStatus() is pure (Node-testable); MatchUI touches the
// DOM and is only made in the browser (see MatchCoordinator.start).
(function (global) {
  const FONT = "DrawvidHand, Comic Sans MS, cursive, sans-serif";
  const SHADOW = "1px 1px 0 rgba(0,0,0,0.9), 0 0 3px rgba(0,0,0,0.9)";
  const BUBBLE_PX = 150;
  const BUB = { cx: 0.465, cy: 0.415, r: 0.385 }; // the balloon in the sprite

  // The match from `me`'s side: "2 UP", "1 DOWN", "All square", "Dormie" when
  // the lead equals the holes left, and at the end "Won 3&2" / "Lost 1 UP".
  function matchStatus(m, me) {
    if (!m || !m.score) return "";
    const opp = (m.teeOrder || []).find((id) => id !== me);
    const diff = (m.score[me] || 0) - (m.score[opp] || 0);
    const left = (m.holeCount || 0) - (m.holeResults || []).length;
    const lead = Math.abs(diff);
    if (m.phase === "finished") {
      const w = m.result?.winner;
      if (m.result?.reason === "forfeit")
        return w === me ? "Won (forfeit)" : "Lost (forfeit)";
      if (!w) return "Halved";
      const margin = left > 0 ? `${lead}&${left}` : `${lead} UP`;
      return `${w === me ? "Won" : "Lost"} ${margin}`;
    }
    if (!diff) return "All square";
    const s = `${lead} ${diff > 0 ? "UP" : "DOWN"}`;
    return lead === left ? `${s} · Dormie` : s;
  }

  class MatchUI {
    // send(text) posts a chat line; anchor(id) is the world position a
    // player's bubble hangs over (null when their ball isn't shown).
    constructor({ scene, send, anchor }) {
      if (global.CourseUI) CourseUI.ensureStyles();
      this.scene = scene;
      this.send = send;
      this.anchor = anchor;
      this.bubbles = new Map(); // id -> {el, until}
      this.seen = 0; // highest chat seq shown
      this.typing = false;
      this.buildChat();
      this.card = null;
      this.cardTimer = null;
    }

    buildChat() {
      const wrap = document.createElement("div");
      Object.assign(wrap.style, {
        position: "fixed",
        left: "12px",
        top: "calc(var(--ui-margin, 12px) + 150px)",
        width: "260px",
        maxWidth: "60vw",
        zIndex: "50",
        pointerEvents: "none",
        fontFamily: FONT,
      });
      const form = document.createElement("form");
      const input = document.createElement("input");
      Object.assign(input, {
        type: "text",
        placeholder: "chat...",
        maxLength: 200,
        enterKeyHint: "send",
        autocomplete: "off",
      });
      Object.assign(input.style, {
        width: "100%",
        boxSizing: "border-box",
        pointerEvents: "auto",
        padding: "6px 10px",
        borderRadius: "16px",
        border: "3px solid #476a23",
        background: "rgba(255,255,255,0.9)",
        fontFamily: FONT,
        fontSize: "16px", // below 16px iOS zooms the page on focus
        outline: "none",
      });
      const feed = document.createElement("div");
      Object.assign(feed.style, {
        marginTop: "6px",
        maxHeight: "30vh",
        overflowY: "auto",
        display: "flex",
        flexDirection: "column",
        gap: "2px",
        fontSize: "20px",
        lineHeight: "1.2",
        color: "#fff",
        pointerEvents: "auto",
        scrollbarWidth: "none",
      });
      const sendNow = () => {
        const t = input.value.trim();
        input.value = "";
        if (!t) return;
        this.send(t);
        this.bubble("me", t); // the feed line comes back from the server
      };
      form.addEventListener("submit", (e) => {
        e.preventDefault();
        sendNow();
        input.blur();
      });
      // Keys typed here aren't the game's (aim arrows, the debug toggle).
      for (const t of ["keydown", "keyup"])
        input.addEventListener(t, (e) => {
          e.stopPropagation();
          if (
            t === "keydown" &&
            /** @type {KeyboardEvent} */ (e).key === "Escape"
          ) {
            input.value = "";
            input.blur();
          }
        });
      input.addEventListener("focus", () => (this.typing = true));
      input.addEventListener("blur", () => {
        this.typing = false;
        window.scrollTo(0, 0);
      });
      form.appendChild(input);
      wrap.appendChild(form);
      wrap.appendChild(feed);
      document.body.appendChild(wrap);
      this.feed = feed;
    }

    line(text, system = false) {
      const d = document.createElement("div");
      d.textContent = text;
      Object.assign(d.style, {
        alignSelf: "flex-start",
        maxWidth: "100%",
        flex: "0 0 auto",
        color: system ? "#eafff0" : "#fff",
        fontStyle: system ? "italic" : "normal",
        textShadow: SHADOW,
        wordBreak: "break-word",
      });
      this.feed.insertBefore(d, this.feed.firstChild); // newest on top
      while (this.feed.children.length > 60)
        this.feed.removeChild(this.feed.lastChild);
      this.feed.scrollTop = 0;
    }

    // Server chat lines {seq, text, from?, name?}; `live` false for a
    // restored log, which gets no bubbles.
    chat(lines, me, live = true) {
      for (const l of lines) {
        if (l.seq <= this.seen) continue;
        this.seen = l.seq;
        if (!l.from) {
          // The server says "X is away" before each of X's shots; once is enough.
          if (/ is away$/.test(l.text) && l.text === this.lastSystem) continue;
          this.lastSystem = l.text;
          this.line(l.text, true);
          continue;
        }
        this.line(`${l.name}: ${l.text}`);
        if (live && l.from !== me) this.bubble(l.from, l.text);
      }
    }

    // ---- between holes ----------------------------------------------------

    holeCard(r, names) {
      clearTimeout(this.cardTimer);
      this.card?.remove();
      const card = document.createElement("div");
      card.className = "aero-card";
      Object.assign(card.style, {
        position: "fixed",
        top: "90px",
        left: "50%",
        transform: "translateX(-50%)",
        zIndex: "100001", // over the iris that covers the hole change
        minWidth: "0",
        width: "min(320px, calc(100vw - 32px))",
        boxSizing: "border-box",
        padding: "16px 20px 10px",
        pointerEvents: "none",
        fontFamily: FONT,
      });
      const title = document.createElement("div");
      title.className = "aero-title";
      title.style.fontSize = "26px";
      title.textContent = r.winner
        ? `${names[r.winner] ?? "?"} wins hole ${r.holeId}`
        : `Hole ${r.holeId} halved`;
      const sub = document.createElement("div");
      sub.className = "aero-sub";
      sub.style.margin = "0 0 6px";
      sub.textContent =
        `Par ${r.par}` + (r.reason === "timeout" ? " · out of time" : "");
      const table = document.createElement("table");
      table.className = "scorecard";
      table.style.margin = "4px 0 10px";
      for (const [id, n] of Object.entries(r.strokes)) {
        const tr = table.insertRow();
        const a = tr.insertCell();
        a.className = "label";
        a.textContent = (id === r.winner ? "★ " : "") + (names[id] ?? "?");
        tr.insertCell().textContent = String(n);
      }
      card.append(title, sub, table);
      document.body.appendChild(card);
      this.card = card;
      this.cardTimer = setTimeout(() => {
        card.remove();
        if (this.card === card) this.card = null;
      }, 4500);
    }

    // ---- speech bubbles ---------------------------------------------------

    bubble(id, text) {
      this.bubbles.get(id)?.el.remove();
      const el = document.createElement("div");
      Object.assign(el.style, {
        position: "fixed",
        transform: "translate(-50%,-97%)",
        width: BUBBLE_PX + "px",
        height: BUBBLE_PX + "px",
        backgroundImage: "url('assets/ui/effects/speech-bubble.png')",
        backgroundSize: "100% 100%",
        pointerEvents: "none",
        zIndex: "40",
        display: "none",
        fontFamily: FONT,
      });
      const txt = document.createElement("div");
      Object.assign(txt.style, {
        position: "absolute",
        left: (BUB.cx - BUB.r) * 100 + "%",
        top: (BUB.cy - BUB.r) * 100 + "%",
        width: BUB.r * 200 + "%",
        height: BUB.r * 200 + "%",
        borderRadius: "50%",
        overflowY: "auto",
        scrollbarWidth: "none",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: "0 12%",
        boxSizing: "border-box",
        textAlign: "center",
        fontSize: text.length < 40 ? "20px" : "15px",
        lineHeight: "1.15",
        color: "#123",
        wordBreak: "break-word",
      });
      txt.textContent = text;
      el.appendChild(txt);
      document.body.appendChild(el);
      this.bubbles.set(id, {
        el,
        until: Date.now() + 4200 + Math.max(0, text.length - 60) * 40,
      });
    }

    // Per frame: hang each bubble over its speaker's ball.
    frame() {
      if (!this.bubbles.size) return;
      const scene = this.scene;
      const cam = scene.activeCamera;
      if (!cam) return;
      const engine = scene.getEngine();
      const vp = cam.viewport.toGlobal(
        engine.getRenderWidth(),
        engine.getRenderHeight(),
      );
      const rect = engine.getRenderingCanvasClientRect?.();
      const sx = rect ? rect.width / engine.getRenderWidth() : 1;
      const sy = rect ? rect.height / engine.getRenderHeight() : 1;
      const fwd = cam.getDirection(BABYLON.Axis.Z);
      const now = Date.now();
      for (const [id, b] of this.bubbles) {
        if (now > b.until) {
          b.el.remove();
          this.bubbles.delete(id);
          continue;
        }
        const at = this.anchor(id);
        const head = at && new BABYLON.Vector3(at.x, at.y + 0.08, at.z);
        const show =
          !!head && BABYLON.Vector3.Dot(head.subtract(cam.position), fwd) > 0;
        b.el.style.display = show ? "block" : "none";
        if (!show) continue;
        const p = BABYLON.Vector3.Project(
          head,
          BABYLON.Matrix.Identity(),
          scene.getTransformMatrix(),
          vp,
        );
        b.el.style.left = Math.round((rect?.left ?? 0) + p.x * sx) + "px";
        b.el.style.top = Math.round((rect?.top ?? 0) + p.y * sy) + "px";
      }
    }
  }

  Object.assign(global, { MatchUI, matchStatus });
  if (typeof module !== "undefined" && module.exports)
    module.exports = { MatchUI, matchStatus };
})(/** @type {any} */ (typeof globalThis !== "undefined" ? globalThis : this));
