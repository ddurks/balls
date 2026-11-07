// title.js — the title screen on a fresh visit to the site (index.html): the
// logo, your name, and where to go. Plain HTML and CSS, loaded before
// anything else so it's up at once; the clubhouse's scripts load behind it.
//
// Play, Driving Range and Locker Room go straight to their pages; Clubhouse
// and Challenge a Friend let the clubhouse load (Title.choice resolves with
// "clubhouse" or "challenge"). Not shown when the page is a challenge link,
// the VIP room, or an arrival through a door (the room's transition stamp).
(function (global) {
  const ARRIVAL_KEY = "ballsRoomFX"; // Shared.roomFX's stamp, set by the page we came from

  function shouldShow() {
    const q = new URLSearchParams(global.location.search);
    if (q.has("challenge") || q.has("room")) return false;
    try {
      if (global.sessionStorage.getItem(ARRIVAL_KEY) != null) return false;
    } catch {}
    return true;
  }

  const CSS = `
.title-screen{position:fixed;inset:0;z-index:9500;overflow-y:auto;box-sizing:border-box;
  display:flex;padding:16px;background:radial-gradient(ellipse at 50% 40%,#123a1d 0%,#000 70%);
  font-family:"DrawvidHand","Comic Sans MS",cursive,sans-serif;transition:opacity .3s ease}
.title-col{margin:auto;width:100%;max-width:440px;display:flex;flex-direction:column;
  align-items:center;gap:clamp(10px,2.4vh,20px)}
.title-logo{width:100%;max-width:420px;max-height:32vh;object-fit:contain}
.title-name{display:flex;flex-direction:column;align-items:center;gap:6px;width:100%}
.title-name label{color:#cfe8cf;font-size:16px;letter-spacing:.5px}
.title-name input{width:100%;max-width:300px;box-sizing:border-box;padding:10px 18px;
  border-radius:999px;border:3px solid #2e8b48;background:#f4faf4;color:#1e7a34;outline:none;
  font:bold 20px "DrawvidHand","Comic Sans MS",cursive,sans-serif;text-align:center}
.title-name input::placeholder{color:#8db497}
.title-btn{cursor:pointer;user-select:none;-webkit-user-select:none;border:none;border-radius:999px;
  font:bold 18px "DrawvidHand","Comic Sans MS",cursive,sans-serif;color:#fff;padding:12px 14px;
  line-height:1.15;background:linear-gradient(180deg,#4fc46a,#2e8b48);
  box-shadow:0 6px 16px rgba(20,90,40,.4),inset 0 2px 6px rgba(255,255,255,.6);
  text-shadow:0 1px 2px rgba(0,0,0,.35);transition:transform .08s ease,filter .08s ease}
.title-btn:hover{filter:brightness(1.07)}
.title-btn:active{transform:translateY(2px) scale(.98);filter:brightness(.95)}
.title-btn.secondary{background:linear-gradient(180deg,#e9f3ec,#c9ddce);color:#1e7a34;
  text-shadow:0 1px 0 rgba(255,255,255,.7)}
.title-play{width:100%;max-width:300px;font-size:26px;padding:16px}
.title-grid{display:grid;grid-template-columns:1fr 1fr;gap:10px;width:100%;max-width:380px}
.title-grid .title-btn{white-space:nowrap;font-size:clamp(14px,4.2vw,18px);padding:12px 8px}
@media (max-height:520px) and (min-aspect-ratio:4/3){
  .title-col{max-width:760px;display:grid;grid-template-columns:1fr 1fr;align-items:center;
    justify-items:center;column-gap:28px;row-gap:12px}
  .title-logo{grid-row:1/4;max-height:72vh}
  .title-play{font-size:22px;padding:12px}
}`;

  const PLACES = [
    { label: "Driving Range", go: "game.html?mode=practice" },
    { label: "Clubhouse", stay: "clubhouse" },
    { label: "Locker Room", go: "locker.html" },
    { label: "Challenge a Friend", stay: "challenge" },
  ];

  function show(resolve) {
    const style = document.createElement("style");
    style.textContent = CSS;
    document.head.appendChild(style);
    const screen = document.createElement("div");
    screen.className = "title-screen";
    screen.innerHTML = `
      <div class="title-col">
        <img class="title-logo" src="assets/ui/branding/balls-golf.png" alt="Balls Golf">
        <div class="title-name">
          <label for="titleName">Your name</label>
          <input id="titleName" type="text" autocomplete="nickname" enterkeyhint="go" spellcheck="false">
        </div>
        <button class="title-btn title-play" type="button">Play</button>
        <div class="title-grid"></div>
      </div>`;
    const input = screen.querySelector("input");
    input.maxLength = PlayerName.MAX;
    input.value = PlayerName.chosen();
    input.placeholder = PlayerName.get();
    const grid = screen.querySelector(".title-grid");
    const pick = (place) => {
      PlayerName.set(input.value);
      if (place.go) {
        global.location.href = place.go;
        return;
      }
      screen.style.opacity = "0";
      setTimeout(() => screen.remove(), 300);
      resolve(place.stay);
    };
    screen
      .querySelector(".title-play")
      .addEventListener("click", () => pick({ go: "game.html?mode=course" }));
    for (const place of PLACES) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "title-btn secondary";
      b.textContent = place.label;
      b.addEventListener("click", () => pick(place));
      grid.appendChild(b);
    }
    // Keys typed in the name are the field's (the clubhouse behind walks on
    // WASD once it loads); Enter plays.
    input.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Enter") pick({ go: "game.html?mode=course" });
    });
    input.addEventListener("keyup", (e) => e.stopPropagation());
    document.body.appendChild(screen);
  }

  const choice = new Promise((resolve) => {
    if (!shouldShow()) return resolve("clubhouse");
    if (document.body) show(resolve);
    else document.addEventListener("DOMContentLoaded", () => show(resolve));
  });

  global.Title = { choice };
})(/** @type {any} */ (typeof globalThis !== "undefined" ? globalThis : this));
