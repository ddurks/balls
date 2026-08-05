// shared.js — framework-free helpers shared across the golf modes.
//
// Loaded as a plain <script> BEFORE either mode script (game.js for the
// course/practice golf, clubhouse.js for the hub), so both see `window.Shared`.
// Also require()-able in Node for unit tests (see test/logic.test.js).
//
// The math helpers are dependency-free; loadModel() uses the global BABYLON
// (available by call time — shared.js loads after babylon.js), never at import
// time, so this file stays require()-able without BABYLON.
(function (global) {
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

  const lerp = (a, b, t) => a + (b - a) * t;

  // Always-positive modulo (JS % keeps the sign of the dividend).
  const mod = (n, m) => ((n % m) + m) % m;

  // Interpolate between two angles (radians) the short way around the circle.
  const lerpAngle = (a, b, t) =>
    a + (mod(b - a + Math.PI, 2 * Math.PI) - Math.PI) * t;

  const wrapAngle = (a) => mod(a, 2 * Math.PI);

  // Load a .glb from `root` (default "assets/3d/"). container:true returns an
  // AssetContainer (for instancing); otherwise a standard ImportMesh result.
  // `version` appends ?v=<version> AND forces the glb loader — the query string
  // hides the ".glb" extension the loader would otherwise sniff, so this must be
  // passed together (the bug this centralizes: it was easy to forget one half).
  // Rejects on failure; callers keep their own try/catch. Uses global BABYLON.
  function loadModel(file, scene, opts = {}) {
    const { root = "assets/3d/", container = false, version = null } = opts;
    const name = version ? `${file}?v=${version}` : file;
    const ext = version ? [null, ".glb"] : []; // force glb loader when ?v= hides the ext
    return container
      ? BABYLON.SceneLoader.LoadAssetContainerAsync(root, name, scene, ...ext)
      : BABYLON.SceneLoader.ImportMeshAsync("", root, name, scene, ...ext);
  }

  // ---- mobile page-zoom lock ---------------------------------------------
  // Pinch/double-tap page zoom fights the orbit + swipe controls, so it is
  // disabled everywhere. iOS Safari ignores user-scalable=no, but it does
  // honour preventDefault on its proprietary gesture* events; the touch-action
  // hint covers double-tap (and Android). Canvases keep touch-action:none.
  if (typeof document !== "undefined") {
    for (const ev of ["gesturestart", "gesturechange", "gestureend"]) {
      document.addEventListener(ev, (e) => e.preventDefault(), {
        passive: false,
      });
    }
    document.documentElement.style.touchAction = "manipulation";
  }

  // ---- room transitions: iris wipe + arrival stamp ---------------------------
  // The hub's rooms are separate page loads, so the door transition runs in two
  // halves. leave(url, {from, at}) stamps sessionStorage with the id of the
  // place being left, shrinks a black iris onto `at` ({x,y} CSS px, default
  // screen centre), then navigates. On the NEXT page (any page that loads
  // shared.js) the stamp is consumed as this script evaluates: the screen
  // starts covered in black, roomFX.arrivedFrom exposes the stamp (so the page
  // can spawn the player beside the matching return door), and enter() irises
  // back open — with a safety timer so a page that never calls enter() can't
  // stay black. Node-safe: everything browser-only is guarded or call-time.
  const roomFX = (function () {
    const KEY = "ballsRoomFX";
    const MS = 480; // one half of the wipe
    let cover = null; // full-black div shown from page load until enter()
    let leaving = false; // one door click = one transition
    let pageCover = null; // in-page (no-navigation) black cover, for course holes

    // A transparent circle (the "hole") whose giant box-shadow blacks out the
    // rest of the screen; animating its size opens/closes the iris. The size is
    // animated (not transform-scaled) because the shadow must not scale away.
    function iris(at, fromD, toD, done) {
      const x = at && at.x != null ? at.x : window.innerWidth / 2;
      const y = at && at.y != null ? at.y : window.innerHeight / 2;
      const el = document.createElement("div");
      el.style.cssText =
        "position:fixed;border-radius:50%;pointer-events:none;z-index:99999;" +
        "box-shadow:0 0 0 400vmax #000;" +
        `transition:width ${MS}ms ease-in-out,height ${MS}ms ease-in-out,` +
        `left ${MS}ms ease-in-out,top ${MS}ms ease-in-out;`;
      const size = (d) => {
        el.style.width = d + "px";
        el.style.height = d + "px";
        el.style.left = x - d / 2 + "px";
        el.style.top = y - d / 2 + "px";
      };
      size(fromD);
      document.documentElement.appendChild(el);
      // double rAF: commit the starting size before the transition begins
      requestAnimationFrame(() => requestAnimationFrame(() => size(toD)));
      setTimeout(() => done(el), MS + 60);
    }

    // Hole diameter that fully clears the screen from (x,y)
    function fullD(at) {
      const x = at && at.x != null ? at.x : window.innerWidth / 2;
      const y = at && at.y != null ? at.y : window.innerHeight / 2;
      return (
        2 *
        Math.hypot(
          Math.max(x, window.innerWidth - x),
          Math.max(y, window.innerHeight - y),
        )
      );
    }

    const fx = {
      arrivedFrom: null, // id stamped by the page we came from (or null)
      leave(url, opts = {}) {
        if (leaving) return;
        leaving = true;
        try {
          sessionStorage.setItem(KEY, opts.from || "");
        } catch {} // storage blocked: lose the stamp but still transition
        iris(opts.at, fullD(opts.at), 0, () => (location.href = url));
      },
      enter(at) {
        if (!cover) return;
        const c = cover;
        cover = null;
        iris(at, 0, fullD(at), (el) => el.remove());
        c.remove(); // the closed iris covers the screen now; drop the flat cover
      },
      // In-page transition (no navigation): close the iris to black and hold a flat
      // cover until irisOpen() reveals again. Used between course holes so the next
      // hole can load fully behind black. Both return a Promise that resolves when
      // the wipe half finishes.
      irisClose(at) {
        return new Promise((resolve) => {
          iris(at, fullD(at), 0, (el) => {
            pageCover = document.createElement("div");
            pageCover.style.cssText =
              "position:fixed;inset:0;background:#000;z-index:99998;pointer-events:none;";
            document.documentElement.appendChild(pageCover);
            el.remove(); // pageCover now holds the black; drop the shrunk iris
            resolve();
          });
        });
      },
      irisOpen(at) {
        return new Promise((resolve) => {
          // start the opening iris first (it covers at size 0) so removing the flat
          // cover can't flash the scene for a frame
          iris(at, 0, fullD(at), (el) => {
            el.remove();
            resolve();
          });
          if (pageCover) {
            pageCover.remove();
            pageCover = null;
          }
        });
      },
      // Instantly drop any full-screen black cover (the arrival cover or a between-
      // hole pageCover) with no animation. Used when the boot logo is now on top and
      // does the reveal itself — a logo opacity-fade can't freeze mid-transition the
      // way the width/height iris does when the newly-loaded scene stalls the main
      // thread.
      clearCovers() {
        if (cover) {
          cover.remove();
          cover = null;
        }
        if (pageCover) {
          pageCover.remove();
          pageCover = null;
        }
      },
    };

    // Arrival half: runs as this script loads on the destination page.
    if (
      typeof document !== "undefined" &&
      typeof sessionStorage !== "undefined"
    ) {
      let stamp = null;
      try {
        stamp = sessionStorage.getItem(KEY);
        sessionStorage.removeItem(KEY);
      } catch {}
      if (stamp != null) {
        fx.arrivedFrom = stamp || null;
        cover = document.createElement("div");
        cover.style.cssText =
          "position:fixed;inset:0;background:#000;z-index:99999;pointer-events:none;";
        document.documentElement.appendChild(cover);
        setTimeout(() => fx.enter(), 4000); // safety: never stay black
      }
    }
    return fx;
  })();

  function hideBoot() {
    const el =
      typeof document !== "undefined" && document.getElementById("bootScreen");
    if (!el) return;
    el.style.opacity = "0";
    // Hide (not remove) so it can be re-shown between course holes — but don't
    // clobber a showBoot() that came in during the fade.
    setTimeout(() => {
      if (el.style.opacity === "0") el.style.display = "none";
    }, 450);
  }

  // Re-show the loading overlay (logo on black), lifted above the transition iris,
  // e.g. while a course hole loads behind a closed iris.
  function showBoot() {
    const el =
      typeof document !== "undefined" && document.getElementById("bootScreen");
    if (!el) return;
    el.style.zIndex = "100000";
    el.style.display = "flex";
    el.style.opacity = "1";
  }

  const Shared = {
    clamp,
    lerp,
    mod,
    lerpAngle,
    wrapAngle,
    loadModel,
    roomFX,
    hideBoot,
    showBoot,
  };

  global.Shared = Shared;
  if (typeof module !== "undefined" && module.exports) module.exports = Shared;
})(typeof globalThis !== "undefined" ? globalThis : this);
