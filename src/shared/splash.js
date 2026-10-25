// splash.js — the circular confirm/cancel splash used for head-to-head
// challenges (clubhouse player taps, incoming challenges, the wall phone, the
// game page's waiting room). One glassy green disc in the game's circle-UI
// style: an optional round portrait, a handwritten title, an optional detail
// line, an optional read-only `field` (text to copy by hand, e.g. a link the
// clipboard refused), and round buttons. Escape presses the button marked
// `cancel`.
//
//   const s = Splash.show({ image, title, detail, buttons: [
//     { label: "Confirm", kind: "go", onClick: (s) => ... },
//     { label: "Cancel", kind: "stop", cancel: true, onClick: (s) => s.close() },
//   ]});
//   s.update({ title: "Waiting…" }); s.close();
//
// The go button takes keyboard focus (Enter confirms) unless `focus: false`:
// a splash nobody asked for, like an incoming challenge, mustn't be answered
// by whatever key the player was about to press. Focus is never taken from a
// text field being typed in, not even by pressing the splash's buttons (the
// clubhouse chat box sends what's typed when it loses focus), and Escape
// typed there stays the field's.
//
// Only one splash is up at a time; show() replaces the current one. Plain
// <script> (exposes window.Splash); DOM is only touched at call time.
(function (global) {
  const CSS = `
.splash-backdrop{position:fixed;inset:0;z-index:100002;display:flex;align-items:center;
  justify-content:center;background:rgba(0,0,0,.45);opacity:0;transition:opacity .15s ease;
  touch-action:none;-webkit-user-select:none;user-select:none;
  font-family:"DrawvidHand","Comic Sans MS",cursive,sans-serif}
.splash-backdrop.open{opacity:1}
.splash-disc{--d:min(88vw,74vh,440px);--fit:1;position:relative;width:var(--d);height:var(--d);
  box-sizing:border-box;border-radius:50%;background:rgba(144,200,150,.94);
  border:6px solid #476a23;box-shadow:0 10px 40px rgba(0,0,0,.45);display:flex;
  flex-direction:column;align-items:center;justify-content:center;gap:calc(var(--d)*.03);
  padding:calc(var(--d)*.08);transform:scale(.86);
  transition:transform .2s cubic-bezier(.2,1.5,.4,1)}
.splash-backdrop.open .splash-disc{transform:none}
.splash-disc::before{content:"";position:absolute;top:5%;left:10%;width:80%;height:50%;
  border-radius:50%;transform:rotate(-10deg);pointer-events:none;
  background:radial-gradient(ellipse at 38% 30%,rgba(255,255,255,.5) 0%,
  rgba(255,255,255,.2) 45%,rgba(255,255,255,.04) 70%,transparent 100%)}
.splash-disc>*{position:relative}
.splash-img{width:calc(var(--d)*.36*var(--fit));height:calc(var(--d)*.36*var(--fit));flex:0 0 auto;
  box-sizing:border-box;border-radius:50%;border:4px solid #476a23;overflow:hidden;
  background:radial-gradient(circle at 50% 38%,#fbf8e6,#b4d8b8 72%)}
.splash-img img{width:100%;height:100%;object-fit:cover;display:block}
.splash-title{color:#e1e44e;font-weight:bold;font-size:calc(var(--d)*.085*var(--fit));line-height:1.05;
  text-align:center;max-width:82%;overflow-wrap:anywhere;
  text-shadow:0 0 3px rgba(0,0,0,.9),1px 1px 2px #000}
.splash-detail{color:#f4f8ff;font-size:calc(var(--d)*.042*var(--fit));max-width:74%;text-align:center;
  overflow-wrap:anywhere;-webkit-user-select:text;user-select:text;
  text-shadow:0 1px 3px rgba(0,0,0,.8)}
.splash-field{width:74%;box-sizing:border-box;flex:0 0 auto;padding:6px 10px;border-radius:12px;
  border:3px solid #476a23;background:rgba(255,255,255,.92);color:#222;outline:none;
  font:16px/1.2 ui-monospace,Menlo,Consolas,monospace;text-overflow:ellipsis;
  -webkit-user-select:text;user-select:text}
.splash-btns{display:flex;gap:calc(var(--d)*.06)}
.splash-btn{width:calc(var(--d)*.23);height:calc(var(--d)*.23);min-width:56px;min-height:56px;
  border-radius:50%;border:3px solid rgba(255,255,255,.65);padding:0;cursor:pointer;
  color:#fff;font:inherit;font-weight:bold;font-size:calc(var(--d)*.056);line-height:1;
  touch-action:manipulation;text-shadow:0 1px 2px rgba(0,0,0,.8);
  background:linear-gradient(180deg,#4fc46a,#2e8b48);
  box-shadow:0 5px 14px rgba(20,90,40,.45),inset 0 2px 6px rgba(255,255,255,.6)}
.splash-btn.stop{background:linear-gradient(180deg,#e0705a,#a8321f);
  box-shadow:0 5px 14px rgba(120,30,20,.45),inset 0 2px 6px rgba(255,255,255,.5)}
.splash-btn:active{transform:translateY(1px) scale(.97)}
.splash-btn:disabled{opacity:.5;cursor:default}
.splash-btn:focus-visible{outline:3px solid #e1e44e;outline-offset:3px}`;

  // Clicks this soon after a splash's buttons appear or change were aimed at
  // whatever was there before: the tail of a double tap (Confirm's second
  // click landing on the Cancel that replaced it), or a click meant for the
  // splash this one replaced or for the room underneath (a challenge popping
  // up under a walk tap, its Accept right where Confirm was).
  const ARM_MS = 400;

  let styled = false;
  let current = null;

  function el(tag, cls) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    return e;
  }

  // When an input event happened, on Date.now()'s clock. Its timeStamp
  // (performance.now()'s clock) is when it came in; on a busy 3D page the
  // handler can run most of a second after that.
  function eventTime(e) {
    const late =
      typeof performance !== "undefined" && typeof e.timeStamp === "number"
        ? performance.now() - e.timeStamp
        : 0;
    return Date.now() - Math.max(0, late);
  }

  // Somewhere the player types (a read-only field isn't).
  function isTextField(t) {
    return (
      !!t &&
      !t.readOnly &&
      (t.tagName === "INPUT" ||
        t.tagName === "TEXTAREA" ||
        t.isContentEditable === true)
    );
  }

  function show(opts) {
    if (current) current.close();
    if (!styled) {
      const st = el("style");
      st.textContent = CSS;
      document.head.appendChild(st);
      styled = true;
    }
    const back = el("div", "splash-backdrop");
    const disc = el("div", "splash-disc");
    disc.setAttribute("role", "dialog");
    disc.setAttribute("aria-modal", "true");
    const imgWrap = el("div", "splash-img");
    const img = el("img");
    img.alt = "";
    imgWrap.appendChild(img);
    const title = el("div", "splash-title");
    const detail = el("div", "splash-detail");
    // 16px: smaller makes iOS zoom the page when it's tapped
    const field = el("input", "splash-field");
    field.readOnly = true;
    field.spellcheck = false;
    field.addEventListener("focus", () => field.select());
    const btns = el("div", "splash-btns");
    disc.append(imgWrap, title, detail, field, btns);
    back.appendChild(disc);
    let cancelBtn = null;
    let armedAt = 0;
    // A tap counts from when the finger went down, not from its click event,
    // which a busy page can dispatch well after the guard has run out.
    let pressAt = null;
    // Taps on the backdrop must never fall through to the 3D view underneath.
    back.addEventListener("pointerdown", (e) => {
      e.stopPropagation();
      pressAt = eventTime(e);
    });
    // Focus moves on mousedown (touches send one too); the link field is
    // still the player's to select.
    back.addEventListener("mousedown", (e) => {
      if (e.target !== field && isTextField(document.activeElement))
        e.preventDefault();
    });
    const armed = () => {
      const at = pressAt === null ? Date.now() : pressAt;
      pressAt = null;
      return at >= armedAt;
    };
    const s = {
      el: back,
      closed: false,
      update(o) {
        if ("image" in o) {
          imgWrap.style.display = o.image === undefined ? "none" : "";
          if (o.image) img.src = o.image;
          else img.removeAttribute("src");
        }
        if ("title" in o) {
          title.textContent = o.title || "";
          disc.setAttribute("aria-label", o.title || "");
        }
        if ("detail" in o) {
          detail.textContent = o.detail || "";
          detail.style.display = o.detail ? "" : "none";
        }
        if ("field" in o) {
          field.value = o.field || "";
          field.style.display = o.field ? "" : "none";
        }
        if ("buttons" in o) {
          btns.textContent = "";
          cancelBtn = null;
          armedAt = Date.now() + ARM_MS;
          for (const b of o.buttons || []) {
            const btn = el(
              "button",
              "splash-btn" + (b.kind === "stop" ? " stop" : ""),
            );
            btn.type = "button";
            btn.textContent = b.label;
            btn.disabled = !!b.disabled;
            btn.addEventListener("click", (e) => {
              e.stopPropagation();
              // detail is 0 for keyboard and scripted clicks: only taps wait
              if (e.detail > 0 && !armed()) return;
              if (!s.closed && b.onClick) b.onClick(s);
            });
            if (b.cancel) cancelBtn = btn;
            btns.appendChild(btn);
          }
          btns.style.display = btns.children.length ? "" : "none";
          focusGo();
        }
        fit();
        return s;
      },
      close() {
        if (s.closed) return;
        s.closed = true;
        removeEventListener("keydown", onKey, true);
        removeEventListener("resize", fit);
        back.remove();
        if (current === s) current = null;
      },
    };
    // Enter confirms on desktop; a no-op until the splash is in the document.
    function focusGo() {
      if (opts.focus === false || isTextField(document.activeElement)) return;
      const go = btns.querySelector(".splash-btn:not(.stop):not(:disabled)");
      if (go) go.focus({ preventScroll: true });
    }
    // A long title (a 24-character name, a link to copy) would push the
    // portrait and buttons out of the circle: scale the text and portrait down
    // until the column fits. Buttons keep their size so they stay tappable.
    function fit() {
      if (s.closed) return;
      let k = 1;
      disc.style.setProperty("--fit", "1");
      while (k > 0.45 && tooTall()) {
        k *= 0.9;
        disc.style.setProperty("--fit", k.toFixed(3));
      }
      fitLabels();
    }
    // A long label ("Clubhouse") would run out of its round button: shrink
    // it to sit inside the circle's middle, where the circle is widest.
    function fitLabels() {
      if (!document.createRange) return;
      for (const b of btns.children) {
        b.style.fontSize = "";
        const r = document.createRange();
        r.selectNodeContents(b);
        // both as drawn: the disc pops in from scale(.86)
        const w = r.getBoundingClientRect().width;
        const room = b.getBoundingClientRect().width * 0.8;
        if (w > room)
          b.style.fontSize =
            (
              (parseFloat(window.getComputedStyle(b).fontSize) * room) /
              w
            ).toFixed(1) + "px";
      }
    }
    // Centred and within 80% of the disc's height, even the button row (the
    // widest part near an edge) clears the rim.
    function tooTall() {
      let top = Infinity;
      let bottom = -Infinity;
      for (const c of disc.children) {
        const r = c.getBoundingClientRect();
        if (!r.height) continue;
        top = Math.min(top, r.top);
        bottom = Math.max(bottom, r.bottom);
      }
      return bottom - top > 0.8 * disc.clientHeight;
    }
    function onKey(e) {
      if (e.key !== "Escape" || isTextField(e.target)) return;
      e.preventDefault();
      e.stopPropagation();
      if (cancelBtn && !cancelBtn.disabled) cancelBtn.click();
    }
    addEventListener("keydown", onKey, true);
    addEventListener("resize", fit);

    s.update({
      image: opts.image,
      title: opts.title,
      detail: opts.detail,
      field: opts.field,
      buttons: opts.buttons,
    });
    document.body.appendChild(back);
    focusGo();
    fit();
    // the handwritten webfont can land after the first measure
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(fit);
    // next frame, so the pop-in transition runs from the closed state. The
    // tap guard starts over then too: that's when the splash is first drawn,
    // and a busy 3D frame can put it a few hundred ms after show().
    requestAnimationFrame(() => {
      back.classList.add("open");
      armedAt = Date.now() + ARM_MS;
    });
    current = s;
    return s;
  }

  const Splash = {
    show,
    close() {
      if (current) current.close();
    },
    get current() {
      return current;
    },
  };
  global.Splash = Splash;
  if (typeof module !== "undefined" && module.exports) module.exports = Splash;
})(/** @type {any} */ (typeof globalThis !== "undefined" ? globalThis : this));
