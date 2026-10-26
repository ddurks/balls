// leaderboard.js — the clubhouse's daily leaderboard, after Augusta's: a white
// board in green trim, "Balls" in the logo script where it would say Masters,
// then the day's best three-hole rounds (net of par: red under, green over,
// E for even). The wall board is a canvas drawn here (too small to read from
// the room); a tap opens the same board as an overlay, scrollable, that
// collapses to its header.
//
// Entries come from the golf server ({name, image, net, strokes, solo, at},
// best first; GolfNet.leaders()). `solo` rounds were reported by the
// player's own page, so they're marked.
(function (global) {
  const GREEN = "#0b5d2e";
  const DEEP = "#073f1f";
  const RED = "#c8102e";
  const SCRIPT = "'DrawvidHand','Comic Sans MS',cursive,sans-serif";
  const SERIF = "Georgia,'Times New Roman',serif";
  // The "Balls" of the logo (assets/ui/branding/balls-golf.png), cut out.
  const SCRIPT_IMG = "assets/ui/branding/balls-script.png";

  const netText = (n) => (n === 0 ? "E" : n > 0 ? `+${n}` : String(n));
  const netColor = (n) => (n < 0 ? RED : GREEN);
  // Ties share a position, Masters style: 1, T2, T2, 4.
  function positions(entries) {
    return entries.map((e) => {
      const first = entries.findIndex((x) => x.net === e.net);
      const tied = entries.filter((x) => x.net === e.net).length > 1;
      return (tied ? "T" : "") + (first + 1);
    });
  }

  const images = new Map(); // data URL -> HTMLImageElement, once loaded
  function imageFor(src, onLoad) {
    if (!src) return null;
    const have = images.get(src);
    if (have) return have.complete ? have : null;
    const img = new Image();
    img.onload = onLoad;
    img.src = src;
    images.set(src, img);
    return null;
  }

  // The wall board, into a 2D canvas context `w` x `h`. `redraw` is called
  // again once a portrait finishes loading.
  function drawBoard(c, w, h, entries, redraw) {
    const frame = Math.round(w * 0.03);
    c.fillStyle = GREEN;
    c.fillRect(0, 0, w, h);
    c.fillStyle = "#fbfaf4";
    c.fillRect(frame, frame, w - 2 * frame, h - 2 * frame);
    c.textAlign = "center";
    c.textBaseline = "middle";
    const logo = imageFor(SCRIPT_IMG, redraw);
    if (logo) {
      const lh = h * 0.15;
      const lw = (lh * logo.width) / logo.height;
      c.drawImage(logo, w / 2 - lw / 2, frame + h * 0.012, lw, lh);
    } else {
      c.fillStyle = GREEN;
      c.font = `${Math.round(h * 0.13)}px ${SCRIPT}`;
      c.fillText("Balls", w / 2, frame + h * 0.09);
    }
    c.font = `bold ${Math.round(h * 0.055)}px ${SERIF}`;
    c.fillStyle = DEEP;
    c.fillText("L E A D E R S", w / 2, frame + h * 0.19);
    const top = frame + h * 0.25;
    c.fillStyle = GREEN;
    c.fillRect(frame, top, w - 2 * frame, h * 0.06);
    c.fillStyle = "#fff";
    c.font = `bold ${Math.round(h * 0.035)}px ${SERIF}`;
    c.textAlign = "left";
    c.fillText("POS", frame + w * 0.03, top + h * 0.03);
    c.fillText("PLAYER", frame + w * 0.26, top + h * 0.03);
    c.textAlign = "right";
    c.fillText("TOTAL", w - frame - w * 0.03, top + h * 0.03);
    const rows = 8;
    const rowH = (h - frame - top - h * 0.06) / rows;
    const pos = positions(entries);
    if (!entries.length) {
      c.textAlign = "center";
      c.fillStyle = DEEP;
      c.font = `italic ${Math.round(h * 0.045)}px ${SERIF}`;
      c.fillText("No rounds yet today", w / 2, top + h * 0.06 + rowH * 2);
    }
    entries.slice(0, rows).forEach((e, i) => {
      const y = top + h * 0.06 + rowH * i;
      if (i % 2) {
        c.fillStyle = "#eef3ea";
        c.fillRect(frame, y, w - 2 * frame, rowH);
      }
      const mid = y + rowH / 2;
      c.textAlign = "left";
      c.fillStyle = DEEP;
      c.font = `bold ${Math.round(rowH * 0.5)}px ${SERIF}`;
      c.fillText(pos[i], frame + w * 0.03, mid);
      const img = imageFor(e.image, redraw);
      const s = rowH * 0.84;
      if (img) c.drawImage(img, frame + w * 0.14, mid - s / 2, s, s);
      c.fillText(
        String(e.name).toUpperCase().slice(0, 16),
        frame + w * 0.26,
        mid,
      );
      c.textAlign = "right";
      c.fillStyle = netColor(e.net);
      c.font = `bold ${Math.round(rowH * 0.6)}px ${SERIF}`;
      c.fillText(netText(e.net), w - frame - w * 0.03, mid);
    });
  }

  let styled = false;
  function ensureStyles() {
    if (styled) return;
    styled = true;
    const s = document.createElement("style");
    s.textContent = `
      .lb-wrap{position:fixed;inset:0;z-index:3000;display:flex;align-items:center;
        justify-content:center;background:rgba(0,0,0,.45);padding:16px;box-sizing:border-box}
      .lb-board{width:min(440px,100%);max-height:100%;display:flex;flex-direction:column;
        background:#fbfaf4;border:10px solid ${GREEN};border-radius:6px;
        box-shadow:0 10px 40px rgba(0,0,0,.5);font-family:${SERIF};color:${DEEP}}
      .lb-head{position:relative;text-align:center;padding:8px 44px 6px;cursor:pointer;
        user-select:none;-webkit-user-select:none}
      .lb-script{height:58px;display:block;margin:0 auto}
      .lb-title{font-weight:bold;letter-spacing:.45em;font-size:15px;margin-top:2px}
      .lb-close,.lb-fold{position:absolute;top:8px;width:32px;height:32px;border:0;
        border-radius:50%;background:${GREEN};color:#fff;font-size:18px;line-height:32px;
        padding:0;cursor:pointer}
      .lb-close{right:8px}.lb-fold{left:8px}
      .lb-cols,.lb-row{display:grid;grid-template-columns:44px 40px 1fr 56px;
        align-items:center;gap:8px;padding:0 12px}
      .lb-cols{background:${GREEN};color:#fff;font-weight:bold;font-size:12px;
        letter-spacing:.1em;height:28px}
      .lb-list{overflow-y:auto;-webkit-overflow-scrolling:touch;overscroll-behavior:contain}
      .lb-row{min-height:48px;font-weight:bold;font-size:17px}
      .lb-row:nth-child(even){background:#eef3ea}
      .lb-row img{width:38px;height:38px;object-fit:contain}
      .lb-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;text-transform:uppercase}
      .lb-solo{font-size:10px;font-weight:normal;letter-spacing:.08em;color:#6a7f6a;
        text-transform:lowercase;margin-left:6px}
      .lb-net{text-align:right;font-size:22px}
      .lb-empty{padding:24px;text-align:center;font-style:italic}
      .lb-folded .lb-cols,.lb-folded .lb-list{display:none}`;
    document.head.appendChild(s);
  }

  // The overlay. Returns {update(entries), close()}; `entries` null shows a
  // loading line. A tap outside the board or on ✕ closes it; the header
  // (or ▾) folds it to just the header.
  /** @param {{ onClose?: () => void }} [opts] */
  function open({ onClose } = {}) {
    ensureStyles();
    const wrap = document.createElement("div");
    wrap.className = "lb-wrap";
    wrap.innerHTML = `
      <div class="lb-board">
        <div class="lb-head">
          <button class="lb-fold" aria-label="Collapse">▾</button>
          <img class="lb-script" src="${SCRIPT_IMG}" alt="Balls">
          <div class="lb-title">LEADERS</div>
          <button class="lb-close" aria-label="Close">✕</button>
        </div>
        <div class="lb-cols"><span>POS</span><span></span><span>PLAYER</span><span style="text-align:right">TOTAL</span></div>
        <div class="lb-list"><div class="lb-empty">Loading…</div></div>
      </div>`;
    const board = wrap.querySelector(".lb-board");
    const list = wrap.querySelector(".lb-list");
    const fold = wrap.querySelector(".lb-fold");
    const close = () => {
      wrap.remove();
      onClose?.();
    };
    wrap.addEventListener("click", (e) => {
      if (e.target === wrap) close();
    });
    wrap.querySelector(".lb-close").addEventListener("click", (e) => {
      e.stopPropagation();
      close();
    });
    wrap.querySelector(".lb-head").addEventListener("click", () => {
      const folded = board.classList.toggle("lb-folded");
      fold.textContent = folded ? "▸" : "▾";
      fold.setAttribute("aria-label", folded ? "Expand" : "Collapse");
    });
    document.body.appendChild(wrap);
    const update = (entries) => {
      list.textContent = "";
      if (!entries || !entries.length) {
        const d = document.createElement("div");
        d.className = "lb-empty";
        d.textContent = entries ? "No rounds yet today" : "Loading…";
        list.appendChild(d);
        return;
      }
      const pos = positions(entries);
      entries.forEach((e, i) => {
        const row = document.createElement("div");
        row.className = "lb-row";
        const p = document.createElement("span");
        p.textContent = pos[i];
        const pic = document.createElement("span");
        if (e.image) {
          const img = document.createElement("img");
          img.src = e.image;
          img.alt = "";
          pic.appendChild(img);
        }
        const name = document.createElement("span");
        name.className = "lb-name";
        name.textContent = e.name;
        if (e.solo) {
          const tag = document.createElement("span");
          tag.className = "lb-solo";
          tag.textContent = "solo";
          name.appendChild(tag);
        }
        const net = document.createElement("span");
        net.className = "lb-net";
        net.style.color = netColor(e.net);
        net.textContent = netText(e.net);
        row.append(p, pic, name, net);
        list.appendChild(row);
      });
    };
    return { update, close };
  }

  const Leaderboard = { drawBoard, open, netText, positions };
  Object.assign(global, { Leaderboard });
  if (typeof module !== "undefined" && module.exports)
    module.exports = Leaderboard;
})(/** @type {any} */ (typeof globalThis !== "undefined" ? globalThis : this));
