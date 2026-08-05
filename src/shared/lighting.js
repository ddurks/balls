// lighting.js — shared warm wall-sconce fixture used by the clubhouse rooms
// (clubhouse.js) and the locker room (locker.js), which used to carry divergent
// copies. Loaded as a plain <script> after babylon.js, before either hub script
// (exposes window.Lighting). BABYLON is only touched at call time, so this stays
// require()-able in Node.
(function (global) {
  // Build a warm sconce at each spec: a dark bracket box, an emissive bulb
  // sphere, and a warm PointLight. `specs` is a list of [x, z, inwardX, inwardZ]
  // wall placements (inward = unit normal pointing into the room). Only the wall
  // positions + a couple of sizes differ between rooms; the fixture is identical.
  //   opts: { y, bulbDia, range, intensity, prefix, bracketMat }
  function buildSconces(scene, specs, opts = {}) {
    const y = opts.y != null ? opts.y : 2.7;
    const bulbDia = opts.bulbDia != null ? opts.bulbDia : 0.26;
    const range = opts.range != null ? opts.range : 9;
    const intensity = opts.intensity != null ? opts.intensity : 0.62;
    const prefix = opts.prefix || "sconce";
    const bracketMat = opts.bracketMat || null;

    const glow = new BABYLON.StandardMaterial(prefix + "Glow", scene);
    glow.emissiveColor = new BABYLON.Color3(1.0, 0.76, 0.47); // warm, a touch whiter/brighter
    glow.diffuseColor = new BABYLON.Color3(0, 0, 0);
    glow.specularColor = new BABYLON.Color3(0, 0, 0);
    glow.disableLighting = true;

    specs.forEach(([x, z, nx, nz], i) => {
      const br = BABYLON.MeshBuilder.CreateBox(
        prefix + "_br" + i,
        { width: 0.14, height: 0.34, depth: 0.16 },
        scene,
      );
      if (bracketMat) br.material = bracketMat;
      br.position.set(x + nx * 0.08, y - 0.06, z + nz * 0.08);
      br.isPickable = false;
      const bulb = BABYLON.MeshBuilder.CreateSphere(
        prefix + "_b" + i,
        { diameter: bulbDia, segments: 10 },
        scene,
      );
      bulb.material = glow;
      bulb.position.set(x + nx * 0.22, y + 0.06, z + nz * 0.22);
      bulb.isPickable = false;
      const L = new BABYLON.PointLight(
        prefix + "L" + i,
        new BABYLON.Vector3(x + nx * 0.32, y + 0.06, z + nz * 0.32),
        scene,
      );
      L.diffuse = new BABYLON.Color3(1.0, 0.79, 0.52); // warm but less yellow / more white
      L.specular = new BABYLON.Color3(0, 0, 0);
      L.intensity = intensity;
      L.range = range;
    });
  }

  global.Lighting = { buildSconces };
  if (typeof module !== "undefined" && module.exports)
    module.exports = global.Lighting;
})(typeof globalThis !== "undefined" ? globalThis : this);
