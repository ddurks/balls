// textures.js — procedural "PS1" DynamicTextures shared by the clubhouse
// (clubhouse.js) and the locker room (locker.js), which dress the same building
// (warm oak wainscot + dark-green shag) and used to carry divergent copies of
// these generators. Loaded as a plain <script> after babylon.js, before either
// hub script (exposes window.Textures). BABYLON is only touched at call time, so
// this stays require()-able in Node.
//
// Both are small + NEAREST-sampled for the flat, painterly PS1 read. Callers
// pass their own texture `name` (distinct so the two rooms don't collide) plus
// the couple of knobs where the two rooms intentionally differ.
(function (global) {
  // Warm oak planks. `grainStrokes` = wobbly grain line count; `planks` = number
  // of boards (planks-1 dark seams drawn; pass 1 for a seamless field).
  function wood(scene, opts = {}) {
    const S = 128;
    const grainStrokes = opts.grainStrokes != null ? opts.grainStrokes : 190;
    const planks = opts.planks != null ? opts.planks : 3;
    const dt = new BABYLON.DynamicTexture(
      opts.name || "woodTex",
      S,
      scene,
      false,
    );
    const ctx = dt.getContext();
    for (let y = 0; y < S; y++) {
      const t = Math.sin(y * 0.26) * 0.5 + Math.sin(y * 0.07 + 1) * 0.5;
      const sh = 1 + t * 0.16;
      ctx.fillStyle = `rgb(${(150 * sh) | 0},${(96 * sh) | 0},${(48 * sh) | 0})`;
      ctx.fillRect(0, y, S, 1);
    }
    for (let i = 0; i < grainStrokes; i++) {
      const y0 = Math.random() * S;
      const dark = Math.random() < 0.55;
      ctx.strokeStyle = dark
        ? `rgba(78,44,18,${0.2 + Math.random() * 0.35})`
        : `rgba(208,156,96,${0.14 + Math.random() * 0.3})`;
      ctx.lineWidth = 1 + Math.random();
      ctx.beginPath();
      let yy = y0;
      ctx.moveTo(0, yy);
      for (let x = 0; x <= S; x += 6) {
        yy += (Math.random() - 0.5) * 2.0;
        ctx.lineTo(x, yy);
      }
      ctx.stroke();
    }
    if (planks > 1) {
      ctx.strokeStyle = "rgba(42,22,8,0.85)";
      ctx.lineWidth = 1;
      for (let p = 1; p < planks; p++) {
        const y = (p * S) / planks;
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(S, y);
        ctx.stroke();
      }
    }
    dt.update();
    dt.updateSamplingMode(BABYLON.Texture.NEAREST_SAMPLINGMODE);
    dt.wrapU = dt.wrapV = BABYLON.Texture.WRAP_ADDRESSMODE;
    return dt;
  }

  // Dark-green shag carpet: short upward blades over a deep-green base.
  function shag(scene, opts = {}) {
    const S = 96;
    const dt = new BABYLON.DynamicTexture(
      opts.name || "shagTex",
      S,
      scene,
      false,
    );
    const ctx = dt.getContext();
    ctx.fillStyle = "rgb(18,46,26)";
    ctx.fillRect(0, 0, S, S);
    for (let i = 0; i < 4200; i++) {
      const x = Math.random() * S;
      const y = Math.random() * S;
      const len = 2 + Math.random() * 4;
      const lift = Math.random();
      const r = 10 + lift * 34;
      const g = 40 + lift * 70;
      const b = 20 + lift * 30;
      ctx.strokeStyle = `rgba(${r | 0},${g | 0},${b | 0},0.5)`;
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x + (Math.random() - 0.5) * 1.5, y - len);
      ctx.stroke();
    }
    dt.update();
    dt.updateSamplingMode(BABYLON.Texture.NEAREST_SAMPLINGMODE);
    dt.wrapU = dt.wrapV = BABYLON.Texture.WRAP_ADDRESSMODE;
    return dt;
  }

  const Textures = { wood, shag };
  global.Textures = Textures;
  if (typeof module !== "undefined" && module.exports)
    module.exports = Textures;
})(/** @type {any} */ (typeof globalThis !== "undefined" ? globalThis : this));
