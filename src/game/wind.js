// wind.js — Wind.
// Split out of game.js; loaded as a plain <script> before game.js (see game.html),
// and require()-able in Node for unit tests. Cross-module refs resolve via globals.
(function (global) {
  // ─── WIND SYSTEM ────────────────────────────────────────────────────────────
  // Manages wind direction and speed; applies procedural force to airborne balls.

  class Wind {
    constructor() {
      this.direction = 0; // radians, 0 = right (East), PI/2 = down (South), etc.
      this.speed = 0; // m/s
      this.nextChangeTime = Date.now() + CONFIG.WIND.CHANGE_FREQUENCY;
      this.generateNewWind();
    }

    update() {
      // Wind changes are now controlled manually via compass
    }

    generateNewWind() {
      this.direction = Math.random() * Math.PI * 2;
      this.speed =
        CONFIG.WIND.MIN_SPEED +
        Math.random() * (CONFIG.WIND.MAX_SPEED - CONFIG.WIND.MIN_SPEED);
    }

    getWindVector() {
      // x = left/right in world coords (negative X = West, positive X = East)
      // z = forward/backward in world coords (positive Z = North, negative Z = South)
      return new BABYLON.Vector3(
        -Math.sin(this.direction) * this.speed,
        0,
        Math.cos(this.direction) * this.speed,
      );
    }

    getForceVector() {
      // Reused scratch — applied to the ball every airborne frame, so avoid the two
      // Vector3 allocations (getWindVector + scale) the old path did per frame.
      const v =
        this._forceScratch || (this._forceScratch = new BABYLON.Vector3());
      const s = this.speed * CONFIG.WIND.FORCE_MULTIPLIER;
      v.set(-Math.sin(this.direction) * s, 0, Math.cos(this.direction) * s);
      return v;
    }

    reset() {
      this.generateNewWind();
      this.nextChangeTime = Date.now() + CONFIG.WIND.CHANGE_FREQUENCY;
    }
  }

  Object.assign(global, { Wind });
  if (typeof module !== "undefined" && module.exports)
    module.exports = { Wind };
})(typeof globalThis !== "undefined" ? globalThis : this);
