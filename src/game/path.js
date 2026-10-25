// path.js — a shot's ball path as pose samples [t, x, y, z, qx, qy, qz, qw]
// (t in seconds since the shot opened). PathSampler picks which poses the
// shooter streams; PathPlayer replays a list of them, live as they arrive or
// a stored shot all at once. Plain <script> in the browser, require()-able in
// Node (the multiplayer test kit streams with the same sampler).
(function (global) {
  // Which of a shot's per-frame ball poses the shooter streams (contract 6):
  // the fewest whose linear replay, as a spectator interpolates it, passes
  // within `tol` m of every frame. So a ball that strikes a rock or a trunk
  // between two regular samples is sampled where it turned, not cut across,
  // and a straight roll costs next to nothing. At least one every `maxGap` s of
  // shot time, so the spectator never waits long for the next; at most `rate`
  // a second over any stretch (`burst` at once), so a ball rattling through a
  // canopy can't push the stream past its budget (the plan's ~1 KB/s while a
  // ball moves).
  //
  //   const sampler = new PathSampler();
  //   every frame:       for (const s of sampler.push(pose)) send(s);
  //   at rest / hazard:  for (const s of sampler.end(pose)) send(s);
  class PathSampler {
    constructor({ tol = 0.05, maxGap = 0.25, rate = 10, burst = 10 } = {}) {
      Object.assign(this, { tol, maxGap, rate, burst });
      this.anchor = null; // the last pose streamed
      this.pending = []; // frames since, oldest first
      this.tokens = burst;
      this.countedAt = 0;
    }

    /** The next frame's pose; returns the poses to stream now (oldest first). */
    push(pose) {
      if (!this.anchor) {
        this.countedAt = pose[0];
        return [(this.anchor = pose)];
      }
      this.pending.push(pose);
      if (this._fits() || !this._take(pose[0])) return [];
      // This frame broke the line from the anchor: the one before it ends a
      // segment that held (or, past the rate, the closest that can go now).
      const n = this.pending.length;
      const end = n > 1 ? this.pending[n - 2] : pose;
      this.pending = end === pose ? [] : [pose];
      return [(this.anchor = end)];
    }

    /** The ball is at rest, holed or out of play at `pose`: the stream ends there. */
    end(pose) {
      const out =
        pose === this.anchor || pose === this.pending.at(-1)
          ? []
          : this.push(pose);
      if (pose !== this.anchor) {
        this.pending = [];
        out.push((this.anchor = pose));
      }
      return out;
    }

    // Whether the line from the anchor to the newest frame passes within tol of
    // every frame in between, and spans no more than maxGap.
    _fits() {
      const a = this.anchor;
      const b = this.pending[this.pending.length - 1];
      const span = b[0] - a[0];
      if (span > this.maxGap) return false;
      for (let i = 0; i < this.pending.length - 1; i++) {
        const p = this.pending[i];
        const k = (p[0] - a[0]) / span;
        const dx = a[1] + (b[1] - a[1]) * k - p[1];
        const dy = a[2] + (b[2] - a[2]) * k - p[2];
        const dz = a[3] + (b[3] - a[3]) * k - p[3];
        if (dx * dx + dy * dy + dz * dz > this.tol * this.tol) return false;
      }
      return true;
    }

    _take(t) {
      this.tokens = Math.min(
        this.burst,
        this.tokens + (t - this.countedAt) * this.rate,
      );
      this.countedAt = t;
      if (this.tokens < 1) return false;
      this.tokens--;
      return true;
    }
  }

  // Replays samples on its own clock. Live, it waits until it holds `delay` s
  // of path before starting (samples come a few at a time, up to ~0.5 s after
  // the shooter's frame), then nudges its rate to stay about that far behind
  // the newest sample. A stored shot is pushed whole and end()ed up front, so
  // it starts at once and plays in real time.
  //
  //   const p = new PathPlayer();
  //   p.push(samples) ... p.end();
  //   every frame: const pose = p.step(dt);  // [x, y, z, qx, qy, qz, qw] or null
  //   p.done: played to the last sample of an ended path
  class PathPlayer {
    constructor(samples = [], { delay = 0.2 } = {}) {
      this.samples = [];
      this.delay = delay;
      this.t = null;
      this.ended = false;
      this.push(samples);
    }

    push(samples) {
      for (const s of samples) {
        // Late or repeated samples would run the clock backwards.
        if (this.samples.length && s[0] <= this.samples.at(-1)[0]) continue;
        this.samples.push(s);
      }
    }

    end() {
      this.ended = true;
    }

    get done() {
      return (
        this.ended &&
        (!this.samples.length ||
          (this.t !== null && this.t >= this.samples.at(-1)[0]))
      );
    }

    step(dt) {
      const n = this.samples.length;
      if (!n) return null;
      const first = this.samples[0][0];
      const last = this.samples[n - 1][0];
      if (this.t === null) {
        if (!this.ended && last - first < this.delay) return null;
        this.t = first;
      } else {
        const lead = last - this.t;
        const rate = this.ended
          ? 1
          : lead > this.delay * 3
            ? 1.25
            : lead < this.delay / 2
              ? 0.8
              : 1;
        this.t = Math.min(this.t + dt * rate, last);
      }
      return this.at(this.t);
    }

    /** The pose at shot time t: positions lerped, rotations nlerped, held at the ends. */
    at(t) {
      const s = this.samples;
      if (!s.length) return null;
      if (t <= s[0][0]) return s[0].slice(1);
      if (t >= s.at(-1)[0]) return s.at(-1).slice(1);
      let i = 1;
      while (s[i][0] < t) i++;
      const a = s[i - 1];
      const b = s[i];
      const k = (t - a[0]) / (b[0] - a[0]);
      const out = [];
      for (let j = 1; j <= 3; j++) out.push(a[j] + (b[j] - a[j]) * k);
      const dot = a[4] * b[4] + a[5] * b[5] + a[6] * b[6] + a[7] * b[7];
      const sign = dot < 0 ? -1 : 1;
      let len = 0;
      for (let j = 4; j <= 7; j++) {
        const q = a[j] + (sign * b[j] - a[j]) * k;
        out.push(q);
        len += q * q;
      }
      len = Math.sqrt(len) || 1;
      for (let j = 3; j <= 6; j++) out[j] /= len;
      return out;
    }
  }

  Object.assign(global, { PathSampler, PathPlayer });
  if (typeof module !== "undefined" && module.exports)
    module.exports = { PathSampler, PathPlayer };
})(typeof globalThis !== "undefined" ? globalThis : this);
