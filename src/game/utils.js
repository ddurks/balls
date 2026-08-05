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
