// utils.js — EventManager, Utils.
// Split out of game.js; loaded as a plain <script> before game.js (see game.html),
// and require()-able in Node for unit tests. Cross-module refs resolve via globals.
(function (global) {
  // ─── EVENT MANAGER ──────────────────────────────────────────────────────────

  class EventManager {
    constructor() {
      this.listeners = {};
    }

    on(eventName, callback) {
      if (!this.listeners[eventName]) {
        this.listeners[eventName] = [];
      }
      this.listeners[eventName].push(callback);
    }

    off(eventName, callback) {
      if (!this.listeners[eventName]) return;
      this.listeners[eventName] = this.listeners[eventName].filter(
        (cb) => cb !== callback,
      );
    }

    emit(eventName, data = null) {
      if (!this.listeners[eventName]) return;
      // Iterate a copy and isolate faults: a throwing listener shouldn't abort the
      // remaining handlers for this event (and off() during emit stays safe).
      for (const callback of this.listeners[eventName].slice()) {
        try {
          callback(data);
        } catch (e) {
          console.error(`Listener for "${eventName}" threw:`, e);
        }
      }
    }
  }

  // ─── UTILITY HELPERS ────────────────────────────────────────────────────────

  const Utils = {
    createMaterial(name, scene, color, specular = null, power = 16) {
      const mat = new BABYLON.StandardMaterial(name, scene);
      mat.diffuseColor = color;
      if (specular) {
        mat.specularColor = specular;
        mat.specularPower = power;
      }
      return mat;
    },

    rotate2D(x, z, angle) {
      const cos = Math.cos(angle);
      const sin = Math.sin(angle);
      return {
        x: x * cos - z * sin,
        z: x * sin + z * cos,
      };
    },

    addShadowCasters(meshes, shadowGenerator) {
      meshes.forEach((m) => {
        if (m) shadowGenerator?.addShadowCaster(m, true);
      });
    },

    // Calls visit(i * nz + j, y) for every node (minX + i·cell, minZ + j·cell) of a
    // regular XZ grid that one of `mesh`'s triangles covers, with the surface
    // height there — what a downward pickWithRay per node would hit, but walking
    // each triangle's own footprint is O(triangles + nodes) instead of a ray per
    // node (a ray-per-node load took seconds on the range). Edges are inclusive so
    // a node on a shared edge is never lost between two triangles; overlapping
    // layers each call visit, so the caller keeps whichever it wants (e.g. top-most).
    rasterizeMeshY(mesh, minX, minZ, cell, nx, nz, visit) {
      const pos = mesh.getVerticesData(BABYLON.VertexBuffer.PositionKind);
      const ind = mesh.getIndices();
      if (!pos || !ind) return;
      const w = mesh.computeWorldMatrix(true).m; // row-vector: p' = p · W
      const n = pos.length / 3;
      const wx = new Float32Array(n);
      const wy = new Float32Array(n);
      const wz = new Float32Array(n);
      for (let v = 0; v < n; v++) {
        const x = pos[3 * v],
          y = pos[3 * v + 1],
          z = pos[3 * v + 2];
        wx[v] = x * w[0] + y * w[4] + z * w[8] + w[12];
        wy[v] = x * w[1] + y * w[5] + z * w[9] + w[13];
        wz[v] = x * w[2] + y * w[6] + z * w[10] + w[14];
      }
      const EPS = -1e-6;
      for (let t = 0; t < ind.length; t += 3) {
        const a = ind[t],
          b = ind[t + 1],
          c = ind[t + 2];
        const ax = wx[a],
          az = wz[a],
          bx = wx[b],
          bz = wz[b],
          cx = wx[c],
          cz = wz[c];
        const d = (bz - cz) * (ax - cx) + (cx - bx) * (az - cz);
        if (Math.abs(d) < 1e-12) continue; // vertical sliver: no top to stand on
        const i0 = Math.max(0, Math.ceil((Math.min(ax, bx, cx) - minX) / cell));
        const i1 = Math.min(
          nx - 1,
          Math.floor((Math.max(ax, bx, cx) - minX) / cell),
        );
        const j0 = Math.max(0, Math.ceil((Math.min(az, bz, cz) - minZ) / cell));
        const j1 = Math.min(
          nz - 1,
          Math.floor((Math.max(az, bz, cz) - minZ) / cell),
        );
        for (let i = i0; i <= i1; i++) {
          const x = minX + i * cell;
          for (let j = j0; j <= j1; j++) {
            const z = minZ + j * cell;
            const l1 = ((bz - cz) * (x - cx) + (cx - bx) * (z - cz)) / d;
            const l2 = ((cz - az) * (x - cx) + (ax - cx) * (z - cz)) / d;
            const l3 = 1 - l1 - l2;
            if (l1 < EPS || l2 < EPS || l3 < EPS) continue;
            visit(i * nz + j, l1 * wy[a] + l2 * wy[b] + l3 * wy[c]);
          }
        }
      }
    },

    metersToYards(meters) {
      return Math.round(meters * UNITS.M_TO_YARDS);
    },

    formatDistance(meters) {
      const yards = this.metersToYards(meters);
      return `${yards}'`;
    },
  };

  Object.assign(global, { EventManager, Utils });
  if (typeof module !== "undefined" && module.exports)
    module.exports = { EventManager, Utils };
})(typeof globalThis !== "undefined" ? globalThis : this);
