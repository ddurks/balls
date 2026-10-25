// The shooter's sampler lives with the game client (src/game/path.js), so the
// sim streams exactly what the browser does.
const { PathSampler } = require("../../src/game/path.js");

module.exports = { PathSampler };
