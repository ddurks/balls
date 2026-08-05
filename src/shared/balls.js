// balls.js — the anthropomorphic golf-ball character ("balls guy") shared by
// game.js (the player) and clubhouse.js (the multiplayer avatars). Both modes
// drive the SAME character, so its eyelid blink state machine and face-texture
// recipe live here — one source of truth that can't drift (clubhouse used to
// carry a copy commented "matches the range's blink").
//
// Loaded as a plain <script> after babylon.js, before either mode script
// (exposes window.Balls). require()-able in Node for tests; BABYLON is only
// touched inside faceTexture() at call time, never at import.
(function (global) {
  // Eyelid blink timings (ms). CLOSE/HOLD/OPEN = one blink; MIN..MAX_INTERVAL =
  // the randomized gap between blinks (so multiple avatars desync).
  const BLINK = {
    CLOSE: 100,
    HOLD: 50,
    OPEN: 100,
    MIN_INTERVAL: 2500,
    MAX_INTERVAL: 5000,
  };

  const nextGap = () =>
    BLINK.MIN_INTERVAL +
    Math.random() * (BLINK.MAX_INTERVAL - BLINK.MIN_INTERVAL);

  // A face texture from assets/faces/<file> with the shared alpha + trilinear
  // recipe both modes use.
  function faceTexture(scene, file, version) {
    const url = version
      ? `assets/faces/${file}?v=${version}`
      : `assets/faces/${file}`;
    const t = new BABYLON.Texture(
      url,
      scene,
      false,
      false,
      BABYLON.Texture.TRILINEAR_SAMPLINGMODE,
    );
    t.hasAlpha = true;
    return t;
  }

  // Index of the eyelids "Closed" morph on a morphTargetManager, or -1.
  function findBlinkMorphIndex(mgr) {
    if (!mgr) return -1;
    for (let i = 0; i < mgr.numTargets; i++) {
      const nm = (mgr.getTarget(i)?.name || "").toLowerCase();
      if (
        nm.includes("closed") ||
        nm.includes("blink") ||
        nm.includes("eyelid")
      )
        return i;
    }
    return -1;
  }

  // A fresh blink state (mutated in place by updateBlink).
  const newBlinkState = () => ({ state: "open", timer: 0, next: nextGap() });

  // Wire up per-avatar blinking from a set of meshes: find the eyelids mesh (with
  // a morph manager), optionally clone that manager so multiple avatars blink
  // independently (`cloneManager` — the clubhouse wants desync, the single locker
  // preview doesn't), resolve the "Closed" morph index (last key as fallback), and
  // return { mgr, idx, state } ready to drive updateBlink — or null if unavailable.
  function initBlink(meshes, opts = {}) {
    const eyelids = (meshes || []).find(
      (m) => m && m.name && /eyelid/i.test(m.name) && m.morphTargetManager,
    );
    if (!eyelids || !eyelids.morphTargetManager) return null;
    let mgr = eyelids.morphTargetManager;
    if (opts.cloneManager && typeof mgr.clone === "function") {
      try {
        mgr = mgr.clone();
        eyelids.morphTargetManager = mgr;
      } catch {}
    }
    let idx = findBlinkMorphIndex(mgr);
    if (idx < 0 && mgr.numTargets > 0) idx = mgr.numTargets - 1;
    if (idx < 0) return null;
    return { mgr, idx, state: newBlinkState() };
  }

  // Advance the blink state machine by dt (seconds); returns the eyelid "Closed"
  // morph influence in [0,1]. open →(gap)→ closing → closed → opening → open.
  function updateBlink(s, dt) {
    s.timer += dt * 1000;
    if (s.state === "open" && s.timer >= s.next) {
      s.state = "closing";
      s.timer = 0;
    }
    if (s.state === "closing") {
      if (s.timer >= BLINK.CLOSE) {
        s.state = "closed";
        s.timer = 0;
        return 1;
      }
      return Math.min(s.timer / BLINK.CLOSE, 1);
    }
    if (s.state === "closed") {
      if (s.timer >= BLINK.HOLD) {
        s.state = "opening";
        s.timer = 0;
      }
      return 1;
    }
    if (s.state === "opening") {
      if (s.timer >= BLINK.OPEN) {
        s.state = "open";
        s.timer = 0;
        s.next = nextGap();
        return 0;
      }
      return 1 - Math.min(s.timer / BLINK.OPEN, 1);
    }
    return 0;
  }

  global.Balls = {
    BLINK,
    faceTexture,
    findBlinkMorphIndex,
    newBlinkState,
    initBlink,
    updateBlink,
  };
  if (typeof module !== "undefined" && module.exports)
    module.exports = global.Balls;
})(typeof globalThis !== "undefined" ? globalThis : this);
