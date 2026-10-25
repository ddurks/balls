// slopearrows.js — SlopeArrows.
// Lays a grid of translucent arrow.glb copies across the green around the cup,
// each pointing straight downhill (steepest descent of the terrain), coloured by
// slope severity (green → yellow → red) and pulsing in a wave that flows downhill,
// like the slope reads in most golf games. Course-only; driven from course.frame().
//
// Loaded as a plain <script> before game.js (see game.html); needs Shared + BABYLON.
(function (global) {
  const STEP = 0.7; // grid spacing on the green (m) — ~2× the arrow count of 1.0
  const TARGET_LEN = 0.25; // arrow length on the green (m)
  const HOVER = 0.03; // sit just above the turf to avoid z-fighting
  const FLAT_SLOPE = 0.015; // below this gradient the green reads flat → no arrow
  const STEEP_SLOPE = 0.14; // gradient that maxes the severity colour to red
  const BASE_ALPHA = 0.6;
  const FLOW_SPEED = 3.2; // wave temporal speed
  const FLOW_WAVELEN = 1.1; // wave spatial frequency along the downhill run

  // green (gentle) → yellow → red (steep)
  function severityColor(t) {
    if (t < 0.5) {
      const k = t / 0.5;
      return new BABYLON.Color3(0.25 + 0.75 * k, 0.85, 0.28);
    }
    const k = (t - 0.5) / 0.5;
    return new BABYLON.Color3(1, 0.85 - 0.65 * k, 0.22 - 0.08 * k);
  }

  class SlopeArrows {
    constructor(scene) {
      this.scene = scene;
      this.template = null;
      this.arrowScale = 0.4;
      this.mat = null;
      this.meshes = []; // thin-instance hosts, one per arrow.glb part
      this.colors = null; // per-instance rgba, shared by every host
      this.phases = null;
      this.time = 0;
      this.isLoaded = false;
      this._visible = false; // shown only while the putter is out
    }

    async load() {
      try {
        const res = await Shared.loadModel(
          "models/gameplay/arrow.glb",
          this.scene,
        );
        this.template = res.meshes[0];
        this.template.setEnabled(false);
        this.template.position.set(0, -1000, 0);
        this.template.getChildMeshes().forEach((m) => (m.isPickable = false));
        // Scale so the arrow reads ~TARGET_LEN metres regardless of model units.
        this.template.computeWorldMatrix(true);
        const bb = this.template.getHierarchyBoundingVectors(true);
        const len = Math.max(bb.max.x - bb.min.x, bb.max.z - bb.min.z) || 2;
        this.arrowScale = TARGET_LEN / len;
        // Emissive white × the instance colour (StandardMaterial multiplies the
        // final colour by it, emissive included); BASE_ALPHA × the instance alpha.
        this.mat = new BABYLON.StandardMaterial("slopeArrowMat", this.scene);
        this.mat.disableLighting = true;
        this.mat.specularColor = new BABYLON.Color3(0, 0, 0);
        this.mat.diffuseColor = new BABYLON.Color3(0, 0, 0);
        this.mat.emissiveColor = new BABYLON.Color3(1, 1, 1);
        this.mat.alpha = BASE_ALPHA;
        this.mat.backFaceCulling = false;
        this.isLoaded = true;
      } catch (e) {
        console.warn("SlopeArrows: arrow.glb failed to load.", e);
        this.isLoaded = false;
      }
    }

    // groundY(x,z): terrain height (gradient). Grids each green over its OWN
    // footprint, sampling only that mesh's triangles — gridding the combined box
    // of every green and ray-picking each point (the range's greens span a 366 m
    // circle) took ~18 s.
    build(groundY) {
      this.clear();
      if (!this.isLoaded) return;
      const e = 0.6; // finite-difference step for the gradient
      const arrows = []; // [x, y, z, ddx, ddz, steep, dydx, dydz]
      const surfs = this.scene.meshes.filter(
        (m) => m.name && m.name.startsWith("surf_"),
      );
      const greens = surfs.filter((m) => /green/i.test(m.name));
      const others = surfs.filter((m) => !greens.includes(m));
      for (const m of greens) {
        m.computeWorldMatrix(true);
        const bb = m.getBoundingInfo().boundingBox;
        const minX = bb.minimumWorld.x;
        const minZ = bb.minimumWorld.z;
        const nx = Math.floor((bb.maximumWorld.x - minX) / STEP) + 1;
        const nz = Math.floor((bb.maximumWorld.z - minZ) / STEP) + 1;
        const top = new Float32Array(nx * nz).fill(-Infinity);
        Utils.rasterizeMeshY(m, minX, minZ, STEP, nx, nz, (idx, y) => {
          if (y > top[idx]) top[idx] = y;
        });
        // Drop nodes where another surface lies over the green (e.g. a bunker or
        // desert lip overlapping its edge by a few cm), else the arrow pokes
        // through it.
        for (const o of others) {
          Utils.rasterizeMeshY(o, minX, minZ, STEP, nx, nz, (idx, y) => {
            if (y > top[idx]) top[idx] = -Infinity;
          });
        }
        for (let i = 0; i < nx; i++) {
          for (let j = 0; j < nz; j++) {
            const y = top[i * nz + j];
            if (y === -Infinity) continue; // not on the green
            const x = minX + i * STEP;
            const z = minZ + j * STEP;
            const dydx = (groundY(x + e, z) - groundY(x - e, z)) / (2 * e);
            const dydz = (groundY(x, z + e) - groundY(x, z - e)) / (2 * e);
            const steep = Math.hypot(dydx, dydz);
            if (steep < FLAT_SLOPE) continue; // flat spot → no arrow
            const ddx = -dydx / steep; // downhill unit (XZ)
            const ddz = -dydz / steep;
            arrows.push([x, y, z, ddx, ddz, steep, dydx, dydz]);
          }
        }
      }
      if (arrows.length) this._buildInstances(arrows);
    }

    // All arrows are thin instances of the template's mesh(es): one draw call per
    // arrow submesh instead of a cloned mesh + material per arrow (thousands of
    // each on the range). Colour + wave alpha ride in a per-instance "color"
    // buffer, which StandardMaterial multiplies into its final colour and alpha.
    _buildInstances(arrows) {
      const n = arrows.length;
      const matrices = new Float32Array(n * 16);
      this.colors = new Float32Array(n * 4);
      this.phases = new Float32Array(n);
      const up = BABYLON.Vector3.Up();
      const scale = new BABYLON.Vector3(
        this.arrowScale,
        this.arrowScale,
        this.arrowScale,
      );
      const pos = new BABYLON.Vector3();
      const world = new BABYLON.Matrix();
      arrows.forEach(([x, y, z, ddx, ddz, steep, dydx, dydz], k) => {
        // Lay the arrow flat ON the slope with its tip pointing downhill. The
        // model's tip is at -Z (so yaw = atan2 + π), then tilt so the arrow's
        // up-axis follows the surface normal — otherwise a flat arrow
        // buries/floats on steep parts.
        const qYaw = BABYLON.Quaternion.RotationAxis(
          up,
          Math.atan2(ddx, ddz) + Math.PI,
        );
        const nrm = new BABYLON.Vector3(-dydx, 1, -dydz).normalize();
        const axis = BABYLON.Vector3.Cross(up, nrm);
        const qTilt =
          axis.lengthSquared() < 1e-8
            ? BABYLON.Quaternion.Identity()
            : BABYLON.Quaternion.RotationAxis(
                axis.normalize(),
                Math.acos(
                  Math.max(-1, Math.min(1, BABYLON.Vector3.Dot(up, nrm))),
                ),
              );
        pos.set(x, y + HOVER, z);
        BABYLON.Matrix.ComposeToRef(scale, qTilt.multiply(qYaw), pos, world);
        world.copyToArray(matrices, k * 16);
        const c = severityColor(Math.min(steep / STEEP_SLOPE, 1));
        this.colors.set([c.r, c.g, c.b, 1], k * 4);
        // phase offset by position projected onto the downhill run → wave flows down
        this.phases[k] = (x * ddx + z * ddz) * FLOW_WAVELEN;
      });
      // Each part keeps its offset under the glb root (the old clones replaced the
      // root's transform but kept the children's), so bake that into its matrices.
      const rootInv = BABYLON.Matrix.Invert(
        this.template.computeWorldMatrix(true),
      );
      for (const part of this.template.getChildMeshes()) {
        if (!part.getTotalVertices()) continue;
        const local = part.computeWorldMatrix(true).multiply(rootInv);
        const partMatrices = new Float32Array(n * 16);
        const tmp = new BABYLON.Matrix();
        for (let k = 0; k < n; k++) {
          local.multiplyToRef(BABYLON.Matrix.FromArray(matrices, k * 16), tmp);
          tmp.copyToArray(partMatrices, k * 16);
        }
        const mesh = part.clone("slopeArrows");
        mesh.parent = null; // clone(name, null) keeps the (disabled) template root
        mesh.position.setAll(0);
        mesh.rotationQuaternion = null;
        mesh.rotation.setAll(0);
        mesh.scaling.setAll(1);
        mesh.material = this.mat;
        mesh.isPickable = false;
        mesh.thinInstanceSetBuffer("matrix", partMatrices, 16, true);
        mesh.thinInstanceSetBuffer("color", this.colors, 4, false);
        mesh.setEnabled(this._visible); // hidden until the putter is out
        this.meshes.push(mesh);
      }
    }

    // Show/hide the whole set (putter in/out). Only toggles on change.
    setVisible(v) {
      if (v === this._visible) return;
      this._visible = v;
      for (const m of this.meshes) m.setEnabled(v);
    }

    update(dt) {
      if (!this._visible || !this.meshes.length) return;
      this.time += dt;
      // The wave is slow, so 30 Hz looks the same as per-frame while halving
      // the O(n) sin pass + colour-buffer upload (n is thousands on the range).
      if (this.time - (this._lastWaveT ?? -1) < 1 / 30) return;
      this._lastWaveT = this.time;
      const n = this.phases.length;
      for (let k = 0; k < n; k++) {
        const w =
          0.35 +
          0.65 *
            (0.5 + 0.5 * Math.sin(this.time * FLOW_SPEED - this.phases[k]));
        this.colors[k * 4 + 3] = w; // × the material's BASE_ALPHA
      }
      for (const m of this.meshes) m.thinInstanceBufferUpdated("color");
    }

    clear() {
      for (const m of this.meshes) {
        try {
          m.dispose();
        } catch (e) {}
      }
      this.meshes = [];
      this.colors = null;
      this.phases = null;
      this._visible = false;
    }

    dispose() {
      this.clear();
      try {
        this.template?.dispose();
        this.mat?.dispose();
      } catch (e) {}
      this.template = null;
      this.isLoaded = false;
    }
  }

  Object.assign(global, { SlopeArrows });
  if (typeof module !== "undefined" && module.exports)
    module.exports = { SlopeArrows };
})(typeof globalThis !== "undefined" ? globalThis : this);
