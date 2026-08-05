// Flat ESLint config (ESLint 9+). game.js + clubhouse.js are classic browser <script>s
// (globals, no module system); the tests, server, and tooling are CommonJS Node.
// Run: `npm install` then `npm run lint`.
const js = require("@eslint/js");

const browserGlobals = {
  BABYLON: "readonly",
  HavokPhysics: "readonly",
  window: "readonly",
  document: "readonly",
  navigator: "readonly",
  location: "readonly",
  addEventListener: "readonly",
  removeEventListener: "readonly",
  URLSearchParams: "readonly",
  WebSocket: "readonly",
  console: "readonly",
  performance: "readonly",
  localStorage: "readonly",
  sessionStorage: "readonly",
  requestAnimationFrame: "readonly",
  cancelAnimationFrame: "readonly",
  setTimeout: "readonly",
  clearTimeout: "readonly",
  setInterval: "readonly",
  clearInterval: "readonly",
  fetch: "readonly",
  Image: "readonly",
  alert: "readonly",
  module: "writable",
  globalThis: "readonly",
  Shared: "readonly", // window.Shared from shared.js (loaded first)
  Balls: "readonly", // window.Balls from balls.js (loaded first)
  Materials: "readonly", // window.Materials from materials.js (loaded first)
  Textures: "readonly", // window.Textures from textures.js (loaded first)
  Lighting: "readonly", // window.Lighting from lighting.js (loaded first)
  BallsStyle: "readonly", // window.BallsStyle from style.js (loaded first)
  ImageData: "readonly",
  Uint8ClampedArray: "readonly",
  Uint8Array: "readonly",
  FileReader: "readonly",
};

const nodeGlobals = {
  require: "readonly",
  module: "writable",
  process: "readonly",
  console: "readonly",
  __dirname: "readonly",
  __filename: "readonly",
  globalThis: "writable",
  Buffer: "readonly",
};

// game.js was split into per-system modules (src/game/*) that reference each
// other via globals — each module does Object.assign(globalThis, {...}). Declare
// those cross-module symbols so no-undef doesn't flag the seams between files.
const gameGlobals = {
  GameState: "readonly",
  CameraViewMode: "readonly",
  PALETTE: "readonly",
  UNITS: "readonly",
  CONFIG: "readonly",
  EventManager: "readonly",
  Utils: "readonly",
  Wind: "readonly",
  CloudSystem: "readonly",
  Boid3D: "readonly",
  BirdFlockSystem: "readonly",
  ClubData: "readonly",
  ClubSelector: "readonly",
  ClubSystem: "readonly",
  TrajectoryArrow: "readonly",
  AimView: "readonly",
  SwipeArrowOverlay: "readonly",
  PhysicsConfig: "readonly",
  PhysicsManager: "readonly",
  GolfBallGuy: "readonly",
  BallTrail: "readonly",
  FollowCamera: "readonly",
  DroneCamera: "readonly",
  GrassSystem: "readonly",
  CourseDecor: "readonly",
  CourseSurfaces: "readonly",
  InputHandler: "readonly",
  CircleUIManager: "readonly",
  UIManager: "readonly",
  PinManager: "readonly",
  CourseHUD: "readonly",
  CourseUI: "readonly",
  BallsMenu: "readonly",
  Scoreboard: "readonly",
  SwingCoordinator: "readonly",
  GameStateCoordinator: "readonly",
  SceneSetup: "readonly",
  HOLE_ASSET_VERSION: "readonly",
  COURSE_HOLES: "readonly",
  SURFACE_PHYSICS: "readonly",
  CourseManager: "readonly",
  GolfGame: "readonly",
  startGame: "readonly",
};

module.exports = [
  { ignores: ["node_modules/**", "vendor/**", "babylon/**", "assets/**"] },
  js.configs.recommended,
  {
    // all app scripts are classic browser <script>s (globals, no module system)
    files: ["src/**/*.js"],
    languageOptions: {
      ecmaVersion: 2022, // static class fields (ES2022)
      sourceType: "script",
      globals: browserGlobals,
    },
    rules: {
      "no-unused-vars": ["warn", { argsIgnorePattern: "^_" }],
      "no-empty": ["warn", { allowEmptyCatch: true }],
      // "smart" still allows the idiomatic `x == null` null/undefined check.
      eqeqeq: ["warn", "smart"],
      "no-loop-func": "warn", // closures capturing a loop var are a classic footgun
    },
  },
  {
    // the split game modules also see each other's classes/consts as globals
    files: ["src/game/**/*.js"],
    languageOptions: { globals: gameGlobals },
  },
  {
    files: ["test/**/*.js", "server.js", "scripts/**/*.js", "*.config.js"],
    languageOptions: {
      ecmaVersion: 2021,
      sourceType: "commonjs",
      globals: nodeGlobals,
    },
    rules: {
      "no-unused-vars": ["warn", { argsIgnorePattern: "^_" }],
      eqeqeq: ["warn", "smart"],
      "no-loop-func": "warn",
    },
  },
  {
    // club-*.js are Node puppeteer harnesses whose page.evaluate() bodies run in
    // the browser and reference page globals — allow both (merges with the Node
    // block above for require/module/process).
    files: ["scripts/club-*.js"],
    languageOptions: {
      globals: { ...browserGlobals, ClubData: "readonly", Utils: "readonly" },
    },
  },
];
