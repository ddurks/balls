// materials.js — shared StandardMaterial helpers for the flat "PS1" look used
// across the golf modes (game.js) and the hub (clubhouse.js). Loaded as a plain
// <script> after babylon.js, before either mode script (exposes window.Materials).
// BABYLON is only touched at call time, so this stays require()-able in Node.
(function (global) {
  const black = () => new BABYLON.Color3(0, 0, 0);

  // Flat textured material: no specular, small emissive floor so shadows aren't
  // pure black. Optional diffuse `tint`.
  function flat(name, scene, tex, tint) {
    const m = new BABYLON.StandardMaterial(name, scene);
    m.diffuseTexture = tex || null;
    m.specularColor = black();
    m.emissiveColor = new BABYLON.Color3(0.13, 0.13, 0.13);
    if (tint) m.diffuseColor = tint;
    return m;
  }

  // Flat solid color with a small self-lit floor (so shadows/shading read
  // naturally). `floor` scales the emissive contribution (default 0.16).
  function color(name, scene, col, floor = 0.16) {
    const m = new BABYLON.StandardMaterial(name, scene);
    m.diffuseColor = col;
    m.specularColor = black();
    m.emissiveColor = col.scale(floor);
    return m;
  }

  // Unlit textured panel: fully self-lit from the texture (disableLighting),
  // double-sided. For painted signs / labels / window panes.
  function unlitTex(name, scene, tex) {
    const m = new BABYLON.StandardMaterial(name, scene);
    m.diffuseTexture = tex;
    m.emissiveTexture = tex;
    m.emissiveColor = new BABYLON.Color3(1, 1, 1);
    m.diffuseColor = black();
    m.disableLighting = true;
    m.specularColor = black();
    m.backFaceCulling = false;
    return m;
  }

  global.Materials = { flat, color, unlitTex };
  if (typeof module !== "undefined" && module.exports) module.exports = global.Materials;
})(typeof globalThis !== "undefined" ? globalThis : this);
