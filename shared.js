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
  // Clamp v into [a, b].
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

  // Linear interpolate from a to b by t.
  const lerp = (a, b, t) => a + (b - a) * t;

  // Always-positive modulo (JS % keeps the sign of the dividend).
  const mod = (n, m) => ((n % m) + m) % m;

  // Interpolate between two angles (radians) the short way around the circle.
  const lerpAngle = (a, b, t) => a + (mod(b - a + Math.PI, 2 * Math.PI) - Math.PI) * t;

  // Wrap an angle into [0, 2π).
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

  const Shared = { clamp, lerp, mod, lerpAngle, wrapAngle, loadModel };

  global.Shared = Shared;
  if (typeof module !== "undefined" && module.exports) module.exports = Shared;
})(typeof globalThis !== "undefined" ? globalThis : this);
