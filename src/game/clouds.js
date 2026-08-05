// clouds.js — CloudSystem.
// Split out of game.js; loaded as a plain <script> before game.js (see game.html),
// and require()-able in Node for unit tests. Cross-module refs resolve via globals.
(function (global) {
  // ─── CLOUD SYSTEM ──────────────────────────────────────────────────────────

  class CloudSystem {
    constructor(scene, camera = null) {
      this.scene = scene;
      this.camera = camera;
      this.clouds = [];
      this.cloudTextures = [];
      this.isInitialized = false;
      this.init();
    }

    init() {
      try {
        for (let i = 1; i <= CONFIG.CLOUDS.TEXTURE_COUNT; i++) {
          const tex = new BABYLON.Texture(
            `${CONFIG.CLOUDS.TEXTURE_DIR}/clouds-${i}.png`,
            this.scene,
          );
          tex.hasAlpha = true;
          this.cloudTextures.push(tex);
        }

        for (let i = 0; i < CONFIG.CLOUDS.COUNT; i++) {
          this.createCloud(i);
        }

        this.isInitialized = true;
      } catch (error) {}
    }

    createCloud(index) {
      const cloud = BABYLON.MeshBuilder.CreatePlane(
        `cloud_${index}`,
        { width: CONFIG.CLOUDS.CLOUD_SIZE, height: CONFIG.CLOUDS.CLOUD_SIZE },
        this.scene,
      );

      cloud.billboardMode = BABYLON.Mesh.BILLBOARDMODE_ALL;
      cloud.isPickable = false;

      const mat = new BABYLON.StandardMaterial(`cloudMat_${index}`, this.scene);

      const tex =
        this.cloudTextures[
          Math.floor(Math.random() * this.cloudTextures.length)
        ];
      mat.emissiveTexture = tex; // unlit color from texture pixels
      mat.emissiveColor = new BABYLON.Color3(1, 1, 1); // white multiplier — show full texture color
      mat.diffuseTexture = tex; // needed so alpha is read from the texture
      mat.diffuseColor = new BABYLON.Color3(0, 0, 0); // kill lighting contribution on diffuse
      mat.specularColor = new BABYLON.Color3(0, 0, 0);
      mat.useAlphaFromDiffuseTexture = true; // use texture alpha channel for transparency
      mat.transparencyMode = BABYLON.Material.MATERIAL_ALPHATESTANDBLEND;
      mat.backFaceCulling = false;

      cloud.material = mat;

      cloud.rotation.z = Math.random() * Math.PI * 2;

      const spread = CONFIG.CLOUDS.HORIZON_DISTANCE;
      const minHeight = CONFIG.CLOUDS.MIN_HEIGHT;
      const maxHeight = CONFIG.CLOUDS.HORIZON_HEIGHT * 1.5;

      cloud.position = new BABYLON.Vector3(
        (Math.random() - 0.5) * spread * 2,
        minHeight + Math.random() * (maxHeight - minHeight),
        (Math.random() - 0.5) * spread * 2,
      );

      this.clouds.push({
        mesh: cloud,
      });
    }

    update(ballPos, wind) {
      if (!this.cloudTextures.length) {
        return;
      }

      // Wind is identical for every cloud this frame — compute it once, not per
      // cloud (this ran wind.getWindVector(), a fresh Vector3, 25x per frame).
      const windVector = wind.getWindVector();
      const moveDistance = 1 / 60;
      this.clouds.forEach((cloud) => {
        cloud.mesh.position.x += windVector.x * moveDistance;
        cloud.mesh.position.z += windVector.z * moveDistance;

        const driftX = cloud.mesh.position.x - ballPos.x;
        const driftZ = cloud.mesh.position.z - ballPos.z;
        const driftDist = Math.sqrt(driftX * driftX + driftZ * driftZ);

        // Recycle cloud when it drifts too far - respawn on opposite side
        if (driftDist > CONFIG.CLOUDS.HORIZON_DISTANCE * 3) {
          const driftAngle = Math.atan2(driftZ, driftX);

          const oppositeAngle =
            driftAngle + Math.PI + (Math.random() - 0.5) * 1.2;
          const respawnDistance =
            CONFIG.CLOUDS.HORIZON_DISTANCE * (0.7 + Math.random() * 0.3);
          const minHeight = CONFIG.CLOUDS.MIN_HEIGHT;
          const maxHeight = CONFIG.CLOUDS.HORIZON_HEIGHT * 1.5;

          cloud.mesh.position = new BABYLON.Vector3(
            ballPos.x + Math.cos(oppositeAngle) * respawnDistance,
            minHeight + Math.random() * (maxHeight - minHeight),
            ballPos.z + Math.sin(oppositeAngle) * respawnDistance,
          );
        }
      });
    }

    dispose() {
      this.clouds.forEach((cloud) => {
        if (cloud.mesh.material) cloud.mesh.material.dispose();
        cloud.mesh.dispose();
      });
      this.clouds = [];
      this.cloudTextures.forEach((t) => t.dispose());
      this.cloudTextures = [];
    }
  }

  Object.assign(global, { CloudSystem });
  if (typeof module !== "undefined" && module.exports)
    module.exports = { CloudSystem };
})(typeof globalThis !== "undefined" ? globalThis : this);
