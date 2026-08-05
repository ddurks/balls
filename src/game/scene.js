// scene.js — SceneSetup.
// Split out of game.js; loaded as a plain <script> before game.js (see game.html),
// and require()-able in Node for unit tests. Cross-module refs resolve via globals.
(function (global) {
  // ─── SCENE SETUP ──────────────────────────────────────────────────────────────

  class SceneSetup {
    static async createEnvironment(scene, opts = {}) {
      let envTexture = null;
      try {
        envTexture = BABYLON.CubeTexture.CreateFromPrefilteredData(
          CONFIG.ENVIRONMENT.ENV_TEXTURE_PATH,
          scene,
        );
        if (CONFIG.ENVIRONMENT.SKYBOX_ENABLED && envTexture) {
          const skybox = scene.createDefaultSkybox(
            envTexture,
            true,
            CONFIG.ENVIRONMENT.SKYBOX_SIZE,
            CONFIG.ENVIRONMENT.SKYBOX_PBRBRIGHT,
          );
          // Rotate skybox 180 degrees so sun appears in look direction
          if (skybox) {
            skybox.rotation.y = Math.PI;
          } else {
            console.warn("✗ Skybox object not created or null");
          }
          scene.environmentTexture = envTexture;
        }
      } catch (err) {}

      const ambientLight = new BABYLON.HemisphericLight(
        "ambient",
        new BABYLON.Vector3(0, 1, 0),
        scene,
      );
      ambientLight.intensity = CONFIG.LIGHTING.AMBIENT_INTENSITY;
      ambientLight.diffuse = new BABYLON.Color3(1.0, 1.0, 1.0);
      ambientLight.groundColor = new BABYLON.Color3(0.25, 0.45, 0.1); // brighter green fill from below

      // Directional sun light (required for shadow casting)
      const sunLight = new BABYLON.DirectionalLight(
        "sun",
        new BABYLON.Vector3(-0.5, -1, -0.5),
        scene,
      );
      sunLight.intensity = CONFIG.LIGHTING.SUN_INTENSITY;
      sunLight.position = new BABYLON.Vector3(100, 200, 100);

      // Shadow generator - store on scene so loadGolfBall/loadCharacter can register casters
      const shadowGenerator = new BABYLON.ShadowGenerator(1024, sunLight);
      shadowGenerator.useBlurExponentialShadowMap = true;
      shadowGenerator.bias = 0.001;
      scene.shadowGenerator = shadowGenerator;

      // Ground disc with distant horizon dressing.
      // Course mode skips the flat playable disc (each hole ships its own terrain)
      // but keeps the distant hills + water backdrop.
      if (opts.skipGround) {
        this.createRollingHillsRing(scene, 183);
        this.createTallerHillsRing(scene, 183);
        this.createWaterRing(scene, 183);
      } else {
        this.createGroundDisc(scene);
      }

      scene.birdFlockSystem = new BirdFlockSystem(scene, 0, 0);
      await scene.birdFlockSystem.load();
    }

    static createGroundDisc(scene) {
      const radius = 183; // 400 yard diameter (200 yard radius)

      const ground = BABYLON.MeshBuilder.CreateDisc(
        "groundDisc",
        {
          radius: radius,
          tessellation: 64,
        },
        scene,
      );

      ground.rotation.x = Math.PI / 2;
      ground.position.y = 0;

      const groundMat = Utils.createMaterial(
        "groundDiscMat",
        scene,
        new BABYLON.Color3(0.25, 0.5, 0.15),
        new BABYLON.Color3(0.02, 0.02, 0.02), // Much darker specular for matte
        4, // Lower power for matte finish
      );

      const diffuseTex = new BABYLON.Texture(
        CONFIG.TERRAIN.TEXTURE_PATH,
        scene,
      );
      diffuseTex.wrapU = BABYLON.Texture.WRAP_ADDRESSMODE;
      diffuseTex.wrapV = BABYLON.Texture.WRAP_ADDRESSMODE;
      diffuseTex.uScale = 50;
      diffuseTex.vScale = 50;
      groundMat.diffuseTexture = diffuseTex;

      const normalTex = new BABYLON.Texture(
        CONFIG.TERRAIN.NORMAL_MAP_PATH,
        scene,
      );
      normalTex.wrapU = BABYLON.Texture.WRAP_ADDRESSMODE;
      normalTex.wrapV = BABYLON.Texture.WRAP_ADDRESSMODE;
      normalTex.uScale = 50;
      normalTex.vScale = 50;
      groundMat.bumpTexture = normalTex;

      ground.material = groundMat;
      ground.receiveShadows = true;
      ground.isPickable = false;

      // Physics for terrain - create a separate collision body for reliable ground
      const collisionBox = BABYLON.MeshBuilder.CreateBox(
        "groundCollision",
        {
          width: radius * 2 * 1.1, // Slightly larger than disc
          height: 1, // Thin enough to not interfere but enough for collision
          depth: radius * 2 * 1.1,
        },
        scene,
      );
      collisionBox.position.y = -0.5; // Position so top surface is at y=0
      collisionBox.visibility = 0;

      const groundAggregate = new BABYLON.PhysicsAggregate(
        collisionBox,
        BABYLON.PhysicsShapeType.BOX,
        {
          mass: 0,
          friction: CONFIG.TERRAIN.FRICTION,
          restitution: CONFIG.TERRAIN.RESTITUTION,
        },
        scene,
      );
      scene.groundPhysicsBody = groundAggregate.body;

      this.createRollingHillsRing(scene, radius);
      this.createTallerHillsRing(scene, radius);
      this.createWaterRing(scene, radius);

      return ground;
    }

    static createRollingHillsRing(scene, groundRadius) {
      const segments = 32;
      const innerRadius = groundRadius + 120;
      const outerRadius = groundRadius + 320;
      const baseHeight = -10;
      const maxRise = 55;
      const innerPath = [];
      const outerPath = [];

      for (let index = 0; index <= segments; index++) {
        const angle = (index / segments) * Math.PI * 2;
        const cosAngle = Math.cos(angle);
        const sinAngle = Math.sin(angle);
        const rollingHeight =
          0.55 +
          0.22 * Math.sin(angle * 2.3 + 0.4) +
          0.15 * Math.sin(angle * 5.1 - 0.9) +
          0.08 * Math.cos(angle * 9.2 + 0.7);

        innerPath.push(
          new BABYLON.Vector3(
            cosAngle * innerRadius,
            baseHeight + 6,
            sinAngle * innerRadius,
          ),
        );

        outerPath.push(
          new BABYLON.Vector3(
            cosAngle * outerRadius,
            baseHeight + Math.max(0, rollingHeight) * maxRise,
            sinAngle * outerRadius,
          ),
        );
      }

      const hillsRing = BABYLON.MeshBuilder.CreateRibbon(
        "rollingHillsRing",
        {
          pathArray: [innerPath, outerPath],
          closePath: true,
          closeArray: false,
          sideOrientation: BABYLON.Mesh.DOUBLESIDE,
        },
        scene,
      );

      hillsRing.convertToFlatShadedMesh();
      hillsRing.receiveShadows = false;
      hillsRing.isPickable = false;
      // Let Babylon frustum cull hills (they're far away and large)

      const hillsMaterial = Utils.createMaterial(
        "rollingHillsMat",
        scene,
        new BABYLON.Color3(0.34, 0.47, 0.28),
        BABYLON.Color3.Black(),
        1,
      );
      hillsMaterial.backFaceCulling = false;

      hillsRing.material = hillsMaterial;

      return hillsRing;
    }

    static createTallerHillsRing(scene, groundRadius) {
      const segments = 32;
      const innerRadius = groundRadius + 320;
      const outerRadius = groundRadius + 620;
      const baseHeight = -10;
      const maxRise = 120; // Taller than first ring (which is 55)
      const innerPath = [];
      const outerPath = [];

      for (let index = 0; index <= segments; index++) {
        const angle = (index / segments) * Math.PI * 2;
        const cosAngle = Math.cos(angle);
        const sinAngle = Math.sin(angle);

        const rollingHeight =
          0.7 +
          0.35 * Math.sin(angle * 1.7 + 1.2) +
          0.25 * Math.sin(angle * 4.3 - 1.5) +
          0.15 * Math.cos(angle * 7.9 + 2.1) +
          0.12 * Math.sin(angle * 11.2 - 0.8);

        innerPath.push(
          new BABYLON.Vector3(
            cosAngle * innerRadius,
            baseHeight + 12,
            sinAngle * innerRadius,
          ),
        );

        outerPath.push(
          new BABYLON.Vector3(
            cosAngle * outerRadius,
            baseHeight + Math.max(0, rollingHeight) * maxRise,
            sinAngle * outerRadius,
          ),
        );
      }

      const tallHillsRing = BABYLON.MeshBuilder.CreateRibbon(
        "tallerHillsRing",
        {
          pathArray: [innerPath, outerPath],
          closePath: true,
          closeArray: false,
          sideOrientation: BABYLON.Mesh.DOUBLESIDE,
        },
        scene,
      );

      tallHillsRing.convertToFlatShadedMesh();
      tallHillsRing.receiveShadows = false;
      tallHillsRing.isPickable = false;
      // Let Babylon frustum cull hills (they're far away and large)

      const tallHillsMaterial = Utils.createMaterial(
        "tallerHillsMat",
        scene,
        new BABYLON.Color3(0.28, 0.38, 0.2),
        BABYLON.Color3.Black(),
        1,
      );
      tallHillsMaterial.backFaceCulling = false;

      tallHillsRing.material = tallHillsMaterial;

      return tallHillsRing;
    }

    static createWaterRing(scene, groundRadius) {
      // Create water disc extending to the middle of the hills
      // First hills go from (groundRadius + 120) to (groundRadius + 320)
      // Middle is at (groundRadius + 220)
      const waterRadius = groundRadius + 220;

      const waterDisc = BABYLON.MeshBuilder.CreateDisc(
        "waterRing",
        {
          radius: waterRadius,
          tessellation: 128,
        },
        scene,
      );

      // Lay it flat, separated to avoid z-fighting
      waterDisc.rotation.x = Math.PI / 2;
      waterDisc.position.y = -2.0;

      const waterMat = new BABYLON.PBRMaterial("sonicWater", scene);

      const diffuseTex = new BABYLON.Texture(
        "./assets/texture/water.png",
        scene,
      );
      diffuseTex.wrapU = BABYLON.Texture.WRAP_ADDRESSMODE;
      diffuseTex.wrapV = BABYLON.Texture.WRAP_ADDRESSMODE;
      diffuseTex.uScale = 4;
      diffuseTex.vScale = 4;
      waterMat.albedoTexture = diffuseTex;

      const normalTex = new BABYLON.Texture(
        "./assets/texture/waternormals.png",
        scene,
      );
      normalTex.wrapU = BABYLON.Texture.WRAP_ADDRESSMODE;
      normalTex.wrapV = BABYLON.Texture.WRAP_ADDRESSMODE;
      normalTex.uScale = 4;
      normalTex.vScale = 4;
      waterMat.bumpTexture = normalTex;

      // PBR water: high metallic and low roughness for Sonic water shine
      waterMat.metallic = 0.8;
      waterMat.roughness = 0.2;
      waterMat.alpha = 0.85;
      waterMat.backFaceCulling = false;

      waterDisc.material = waterMat;
      waterDisc.isPickable = false;
      scene.waterRing = waterDisc;

      waterDisc.waterAnimTime = 0;
      waterDisc.diffuseTex = diffuseTex;
      waterDisc.normalTex = normalTex;

      scene.fogMode = BABYLON.Scene.FOGMODE_NONE;
    }
  }

  Object.assign(global, { SceneSetup });
  if (typeof module !== "undefined" && module.exports)
    module.exports = { SceneSetup };
})(typeof globalThis !== "undefined" ? globalThis : this);
