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

module.exports = [
  { ignores: ["node_modules/**", "vendor/**", "babylon/**", "assets/**"] },
  js.configs.recommended,
  {
    files: ["game.js", "clubhouse.js"],
    languageOptions: {
      ecmaVersion: 2022, // game.js uses static class fields (ES2022)
      sourceType: "script",
      globals: browserGlobals,
    },
    rules: {
      "no-unused-vars": ["warn", { argsIgnorePattern: "^_" }],
      "no-empty": ["warn", { allowEmptyCatch: true }],
    },
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
