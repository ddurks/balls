// slopearrows.js — SlopeArrows.
// Lays a grid of translucent arrow.glb copies across the green around the cup,
// each pointing straight downhill (steepest descent of the terrain), coloured by
// slope severity (green → yellow → red) and pulsing in a wave that flows downhill,
// like the slope reads in most golf games. Course-only; driven from course.frame().
//
// Loaded as a plain <script> before game.js (see game.html); needs Shared + BABYLON.
(function (global) {
  const DOWN = new BABYLON.Vector3(0, -1, 0);
  const STEP = 1.0; // grid spacing on the green (m) — ~2× the arrow count of 1.4
  const RADIUS = 14; // sample this far around the cup, then clip to the green
  const TARGET_LEN = 0.5; // arrow length on the green (m)
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
      this.arrows = [];
      this.time = 0;
      this.isLoaded = false;
      this._visible = false; // shown only while the putter is out
    }

    async load() {
      try {
        const res = await Shared.loadModel("arrow.glb", this.scene);
        this.template = res.meshes[0];
        this.template.setEnabled(false);
        this.template.position.set(0, -1000, 0);
        this.template.getChildMeshes().forEach((m) => (m.isPickable = false));
        // Scale so the arrow reads ~TARGET_LEN metres regardless of model units.
        this.template.computeWorldMatrix(true);
        const bb = this.template.getHierarchyBoundingVectors(true);
        const len = Math.max(bb.max.x - bb.min.x, bb.max.z - bb.min.z) || 2;
        this.arrowScale = TARGET_LEN / len;
        this.isLoaded = true;
      } catch (e) {
        console.warn("SlopeArrows: arrow.glb failed to load.", e);
        this.isLoaded = false;
      }
    }

    // Ray down at (x,z); returns the green surface height there, else null.
    _greenY(x, z) {
      const ray = new BABYLON.Ray(
        new BABYLON.Vector3(x, this._top, z),
        DOWN,
        this._len,
      );
      const hit = this.scene.pickWithRay(
        ray,
        (m) => m.name && m.name.startsWith("surf_"),
      );
      return hit && hit.hit && /green/i.test(hit.pickedMesh.name)
        ? hit.pickedPoint.y
        : null;
    }

    // cup: {x,y,z}; groundY(x,z): terrain height (for the slope gradient).
    build(cup, groundY) {
      this.clear();
      if (!this.isLoaded) return;
      this._top = cup.y + 50;
      this._len = 100;
      const e = 0.6; // finite-difference step for the gradient
      for (let gx = -RADIUS; gx <= RADIUS; gx += STEP) {
        for (let gz = -RADIUS; gz <= RADIUS; gz += STEP) {
          if (gx * gx + gz * gz > RADIUS * RADIUS) continue;
          const x = cup.x + gx;
          const z = cup.z + gz;
          const y = this._greenY(x, z);
          if (y == null) continue; // not on the green
          const dydx = (groundY(x + e, z) - groundY(x - e, z)) / (2 * e);
          const dydz = (groundY(x, z + e) - groundY(x, z - e)) / (2 * e);
          const steep = Math.hypot(dydx, dydz);
          if (steep < FLAT_SLOPE) continue; // flat spot → no arrow
          const ddx = -dydx / steep; // downhill unit (XZ)
          const ddz = -dydz / steep;
          this._addArrow(x, y, z, ddx, ddz, steep);
        }
      }
    }

    _addArrow(x, y, z, ddx, ddz, steep) {
      const a = this.template.clone("slopeArrow");
      a.setEnabled(this._visible); // hidden until the putter is out
      a.position.set(x, y + HOVER, z);
      a.rotationQuaternion = null;
      a.rotation.set(0, Math.atan2(ddx, ddz), 0); // +Z faces downhill
      a.scaling.setAll(this.arrowScale);
      const t = Math.min(steep / STEEP_SLOPE, 1);
      const mat = new BABYLON.StandardMaterial("slopeArrowMat", this.scene);
      mat.disableLighting = true;
      mat.specularColor = new BABYLON.Color3(0, 0, 0);
      mat.diffuseColor = new BABYLON.Color3(0, 0, 0);
      mat.emissiveColor = severityColor(t);
      mat.alpha = BASE_ALPHA;
      mat.backFaceCulling = false;
      a.getChildMeshes().forEach((m) => {
        m.material = mat;
        m.isPickable = false;
      });
      // phase offset by position projected onto the downhill run → wave flows down
      const phase = (x * ddx + z * ddz) * FLOW_WAVELEN;
      this.arrows.push({ mesh: a, mat, phase });
    }

    // Show/hide the whole set (putter in/out). Only toggles on change.
    setVisible(v) {
      if (v === this._visible) return;
      this._visible = v;
      for (const ar of this.arrows) ar.mesh.setEnabled(v);
    }

    update(dt) {
      if (!this._visible || !this.arrows.length) return;
      this.time += dt;
      for (const ar of this.arrows) {
        const w =
          0.35 +
          0.65 * (0.5 + 0.5 * Math.sin(this.time * FLOW_SPEED - ar.phase));
        ar.mat.alpha = BASE_ALPHA * w;
      }
    }

    clear() {
      for (const ar of this.arrows) {
        try {
          ar.mesh.getChildMeshes().forEach((m) => m.dispose());
          ar.mesh.dispose();
          ar.mat.dispose();
        } catch (e) {}
      }
      this.arrows = [];
      this._visible = false;
    }

    dispose() {
      this.clear();
      try {
        this.template?.dispose();
      } catch (e) {}
      this.template = null;
      this.isLoaded = false;
    }
  }

  global.SlopeArrows = SlopeArrows;
  if (typeof module !== "undefined" && module.exports)
    module.exports = { SlopeArrows };
})(typeof globalThis !== "undefined" ? globalThis : this);
