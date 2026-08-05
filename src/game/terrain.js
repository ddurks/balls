// terrain.js — GrassSystem, CourseDecor, CourseSurfaces.
// Split out of game.js; loaded as a plain <script> before game.js (see game.html),
// and require()-able in Node for unit tests. Cross-module refs resolve via globals.
(function (global) {
  // ─── GRASS SYSTEM ──────────────────────────────────────────────────────────
  // GPU thin-instanced grass. Each texture variant is ONE mesh drawn in a single
  // call from a matrix buffer — no per-blade scene nodes, no per-frame billboarding.
  // Blades are crossed quads (an "X" from above) so they read as volume from any
  // angle without facing the camera. Grass is generated in fixed CELL_SIZE chunks
  // around the CAMERA and only rebuilt when the camera crosses a chunk boundary.

  class GrassSystem {
    constructor(scene) {
      this.scene = scene;
      this.grassMeshes = []; // one crossed-quad template per grass texture
      // One PERSISTENT thin-instance matrix buffer per variant, sized for the whole
      // WxW ring of chunks. Each chunk owns a fixed slot in it (toroidal addressing),
      // so a chunk crossing rewrites only the handful of slots that changed and
      // uploads just those sub-ranges — no realloc, no full re-upload, no flight spike.
      this.buffers = null; // Float32Array[] (per variant); allocated in initialize()
      this.cap = 0; // matrices reserved per slot per variant (= BLADES_PER_CELL)
      this.R = 0; // ring radius in chunks
      this.W = 0; // ring width = 2R+1
      this.G = 0; // total slots = W²
      this.built = null; // per-slot {cx,cz} currently uploaded, or null
      this.desired = null; // per-slot {cx,cz,d} it SHOULD show (d = dist² to center)
      this.queue = []; // slot indices awaiting (re)build, nearest-first
      this.center = null; // last center chunk {cx,cz}
      this.camPos = new BABYLON.Vector3(); // shared uCamPos ref; refreshed each update()
      // Course-mode hooks (null in practice → flat disc at y=0).
      // groundYAt(x,z) → terrain height for the blade; playableAt(x,z) → whether
      // grass is allowed there (fairway/rough only, not water/sand/off-hole).
      this.groundYAt = null;
      this.playableAt = null;
    }

    async initialize() {
      // One crossed-quad template per grass texture. Variety comes from the texture
      // plus a random per-blade yaw baked into each instance matrix (which subsumes
      // the old mirror-flip variant). Each template is thin-instanced → one draw call.
      for (let i = 0; i < 3; i++) {
        this.grassMeshes.push(this.makeBladeTemplate(i));
      }
      // Fixed ring geometry. cap = BLADES_PER_CELL so a slot can hold a whole chunk's
      // blades in ANY single variant (a chunk splits its blades randomly across the 3
      // variants, so per-variant counts vary) — no overflow, no drops. Unused entries
      // stay all-zero, which transforms to a degenerate point the GPU discards for free
      // (no fragments). If ever vertex-bound, cap could be tightened toward
      // BLADES_PER_CELL/3 by dropping the rare per-variant overflow.
      this.cap = CONFIG.GRASS.BLADES_PER_CELL;
      this.R = Math.ceil(CONFIG.GRASS.VIEW_RADIUS / CONFIG.GRASS.CELL_SIZE);
      this.W = 2 * this.R + 1;
      this.G = this.W * this.W;
      const capFloats = this.cap * 16;
      this.buffers = this.grassMeshes.map((mesh) => {
        const buf = new Float32Array(this.G * capFloats); // all-zero → all degenerate
        // staticBuffer=false → dynamic GL buffer we can partial-update per slot.
        mesh.thinInstanceSetBuffer("matrix", buf, 16, false);
        mesh.setEnabled(true);
        return buf;
      });
      this.built = new Array(this.G).fill(null);
      this.desired = new Array(this.G);
      this.queue = [];
      this.center = null;
    }

    // Two planes crossed at 90°, merged into one mesh with its base at y=0, so a blade
    // reads as volume from any direction and never needs to be billboarded.
    makeBladeTemplate(index) {
      const s = CONFIG.GRASS.BLADE_SIZE;
      const a = BABYLON.MeshBuilder.CreatePlane(
        `grassPlaneA_${index}`,
        { width: s, height: s },
        this.scene,
      );
      const b = BABYLON.MeshBuilder.CreatePlane(
        `grassPlaneB_${index}`,
        { width: s, height: s },
        this.scene,
      );
      a.position.y = s / 2; // lift so the merged blade's base sits on the ground
      b.position.y = s / 2;
      b.rotation.y = Math.PI / 2; // cross the second quad → an "X" seen from above
      const blade = BABYLON.Mesh.MergeMeshes([a, b], true, true); // bakes transforms

      const tex = new BABYLON.Texture(
        `./assets/grass/grass${index + 1}.png`,
        this.scene,
      );
      tex.hasAlpha = true;
      tex.uWrapMode = BABYLON.Texture.CLAMP_ADDRESSMODE;
      tex.vWrapMode = BABYLON.Texture.CLAMP_ADDRESSMODE;
      tex.uOffset = 0.01;
      tex.vOffset = 0.01;
      tex.uScale = 0.98;
      tex.vScale = 0.98;

      // CustomMaterial = StandardMaterial + GLSL injection hooks. We inject a vertex
      // fade so a blade's height ramps to zero as it approaches the outer edge of the
      // grass ring: chunks streaming in at the leading edge rise from the ground
      // instead of popping in at full height, and the hard chunk boundary — where a
      // not-yet-built chunk could show a gap — is masked because blades there are
      // already ~zero height. Runs entirely on the GPU, no per-frame CPU cost.
      const mat = new BABYLON.CustomMaterial(`grassMat_${index}`, this.scene);
      mat.diffuseTexture = tex;
      mat.useAlphaFromDiffuseTexture = true;
      // Alpha-TEST (cutout), not alpha-BLEND: no transparency sorting / overdraw.
      mat.transparencyMode = BABYLON.Material.MATERIAL_ALPHATEST;
      mat.alphaCutOff = 0.4;
      mat.backFaceCulling = false; // both faces of each quad visible
      mat.specularColor = new BABYLON.Color3(0, 0, 0); // grass isn't shiny
      // uCamPos is the shared Vector3 refreshed each frame in update(); CustomMaterial
      // re-reads and re-uploads the passed reference on every bind, so mutating that
      // one vector updates all three grass materials — no per-frame observer needed.
      mat.AddUniform("uCamPos", "vec3", this.camPos);
      // Fully faded a bit inside VIEW_RADIUS so blades vanish BEFORE the leading chunk
      // boundary they'd otherwise reveal. world3.xz = this thin-instance's world
      // translation (the blade's base) — the assembled `finalWorld` isn't available
      // yet at this injection point, but the raw instance attribute is.
      const fadeStart = (CONFIG.GRASS.VIEW_RADIUS * 0.6).toFixed(2);
      const fadeEnd = (CONFIG.GRASS.VIEW_RADIUS * 0.95).toFixed(2);
      mat.Vertex_Before_PositionUpdated(`
      #ifdef INSTANCES
        float _gd = length(world3.xz - uCamPos.xz);
        positionUpdated.y *= 1.0 - smoothstep(${fadeStart}, ${fadeEnd}, _gd);
      #endif
    `);

      blade.name = `grassBlade_${index}`;
      blade.material = mat;
      blade.isPickable = false;
      blade.thinInstanceEnablePicking = false;
      // Instances cover the whole field; the template's own bounds are tiny, so keep
      // it always active rather than letting frustum culling drop the entire field.
      blade.alwaysSelectAsActiveMesh = true;
      blade.setEnabled(false);
      return blade;
    }

    // Deterministic PRNG (mulberry32) so a chunk that stays in view regenerates the
    // SAME blades every rebuild — no shuffling / pop-in. Seeded by chunk coords.
    static _rng(seed) {
      let t = seed >>> 0;
      return () => {
        t = (t + 0x6d2b79f5) >>> 0;
        let x = Math.imul(t ^ (t >>> 15), 1 | t);
        x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
        return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
      };
    }

    // Build one chunk's blade matrices, split per texture variant (Float32Array each).
    buildChunk(cx, cz, pinPositions) {
      const S = CONFIG.GRASS.CELL_SIZE;
      const density = CONFIG.GRASS.BLADES_PER_CELL;
      const exclSq =
        CONFIG.GRASS.GREEN_EXCLUSION_RADIUS *
        CONFIG.GRASS.GREEN_EXCLUSION_RADIUS;
      const terrainRSq =
        CONFIG.GRASS.TERRAIN_RADIUS * CONFIG.GRASS.TERRAIN_RADIUS;
      const nVar = this.grassMeshes.length;
      const rng = GrassSystem._rng(
        Math.imul(cx, 73856093) ^ Math.imul(cz, 19349663),
      );
      const out = Array.from({ length: nVar }, () => []);
      const scale = new BABYLON.Vector3();
      const quat = new BABYLON.Quaternion();
      const pos = new BABYLON.Vector3();
      const mat = new BABYLON.Matrix();
      for (let i = 0; i < density; i++) {
        const x = cx * S + rng() * S;
        const z = cz * S + rng() * S;
        // Course mode: only grow on playable turf. Practice mode: the flat disc.
        if (this.playableAt) {
          if (!this.playableAt(x, z)) continue;
        } else if (x * x + z * z > terrainRSq) {
          continue;
        }
        let skip = false; // keep grass off greens
        for (const p of pinPositions) {
          const dx = x - p.x,
            dz = z - p.z;
          if (dx * dx + dz * dz < exclSq) {
            skip = true;
            break;
          }
        }
        if (skip) continue;
        const y = this.groundYAt ? this.groundYAt(x, z) : 0;
        const sc = 0.8 + rng() * 0.6; // per-blade size variation
        scale.set(sc, sc, sc);
        BABYLON.Quaternion.RotationYawPitchRollToRef(
          rng() * Math.PI * 2,
          0,
          0,
          quat,
        );
        pos.set(x, y, z);
        BABYLON.Matrix.ComposeToRef(scale, quat, pos, mat);
        const arr = out[Math.floor(rng() * nVar)];
        for (let k = 0; k < 16; k++) arr.push(mat.m[k]);
      }
      return out.map((a) => Float32Array.from(a));
    }

    // Toroidal slot for a world chunk: consecutive chunks wrap onto fixed buffer
    // slots, so when the ring recenters only the newly-exposed chunks change slots.
    _slot(cx, cz) {
      const W = this.W;
      const sx = ((cx % W) + W) % W;
      const sz = ((cz % W) + W) % W;
      return sz * W + sx;
    }

    // Recompute which chunk each slot should show, and queue the mismatched slots
    // (nearest-first) for streaming. The WxW neighbourhood maps bijectively onto all
    // G slots, so every slot gets exactly one desired chunk.
    _reindex(cx, cz) {
      const R = this.R;
      for (let dz = -R; dz <= R; dz++) {
        for (let dx = -R; dx <= R; dx++) {
          const wcx = cx + dx,
            wcz = cz + dz;
          this.desired[this._slot(wcx, wcz)] = {
            cx: wcx,
            cz: wcz,
            d: dx * dx + dz * dz,
          };
        }
      }
      const q = [];
      for (let s = 0; s < this.G; s++) {
        const b = this.built[s],
          d = this.desired[s];
        if (!b || b.cx !== d.cx || b.cz !== d.cz) q.push(s);
      }
      q.sort((a, b) => this.desired[a].d - this.desired[b].d);
      this.queue = q;
    }

    // Write one chunk's blades into its slot and upload ONLY that slot's sub-range.
    _buildSlot(slot, cx, cz, pinPositions) {
      const mats = this.buildChunk(cx, cz, pinPositions); // per-variant Float32Array
      const capFloats = this.cap * 16;
      const base = slot * capFloats;
      for (let v = 0; v < this.grassMeshes.length; v++) {
        const buf = this.buffers[v];
        const src = mats[v];
        buf.set(src, base); // real blades at the front of the slot
        buf.fill(0, base + src.length, base + capFloats); // rest degenerate
        // Upload just this slot's `cap` matrices (starting matrix index = slot*cap).
        this.grassMeshes[v].thinInstancePartialBufferUpdate(
          "matrix",
          this.cap,
          slot * this.cap,
        );
      }
      this.built[slot] = { cx, cz };
    }

    update(refPos, pinPositions = []) {
      if (!this.buffers) return;
      this.camPos.copyFrom(refPos); // drives the vertex distance-fade this frame
      const S = CONFIG.GRASS.CELL_SIZE;
      const cx = Math.floor(refPos.x / S);
      const cz = Math.floor(refPos.z / S);
      // Re-target slots only when the reference crosses into a new chunk.
      if (!this.center || this.center.cx !== cx || this.center.cz !== cz) {
        this.center = { cx, cz };
        this._reindex(cx, cz);
      }
      // Stream a bounded number of chunks per frame — this is what removes both the
      // in-flight rebuild spike and the batch pop-in when the ball comes to rest.
      let budget = CONFIG.GRASS.BUILD_BUDGET;
      while (budget > 0 && this.queue.length) {
        const slot = this.queue.shift();
        const d = this.desired[slot];
        this._buildSlot(slot, d.cx, d.cz, pinPositions);
        budget--;
      }
    }

    // Clear all grass (e.g. between holes — the terrain height/playable mask changed).
    reset() {
      if (!this.buffers) return;
      this.built.fill(null);
      this.queue = [];
      this.center = null;
      for (let v = 0; v < this.grassMeshes.length; v++) {
        this.buffers[v].fill(0); // every slot degenerate → old hole's grass vanishes
        this.grassMeshes[v].thinInstanceBufferUpdated("matrix"); // one upload (transition)
      }
    }

    dispose() {
      for (const mesh of this.grassMeshes) {
        mesh.dispose(false, true); // also dispose material + textures
      }
      this.grassMeshes = [];
      this.buffers = null;
      this.built = null;
      this.desired = null;
      this.queue = [];
      this.center = null;
    }
  }

  /**
   * Loads decor.glb once and stamps instanced copies (trees/rocks) so many
   * placements share geometry. Sources are parked far below the course.
   */
  class CourseDecor {
    constructor(scene) {
      this.scene = scene;
      this.sources = {};
    }

    async load() {
      let res;
      try {
        res = await Shared.loadModel("decor.glb", this.scene);
      } catch (e) {
        // Non-fatal: without decor sources, place() returns null and holes simply
        // render with no trees/rocks rather than the whole round failing to load.
        console.warn(
          "Decor model (decor.glb) failed to load; holes will have no trees/rocks.",
          e,
        );
        return;
      }
      for (const name of [
        "tree1",
        "tree2",
        "tree3",
        "rock1",
        "rock2",
        "rock3",
      ]) {
        const node =
          res.meshes.find((m) => m.name === name) ||
          (res.transformNodes || []).find((n) => n.name === name);
        if (!node) continue;
        node.setParent(null); // bake the glTF handedness transform into the node
        node.setEnabled(true);
        // Natural (scale-1) height, so rocks can be sunk halfway into the turf when
        // placed (their origin sits at the base). Union the node + its child meshes.
        const srcMeshes = node.getChildMeshes ? node.getChildMeshes(false) : [];
        if (node.getBoundingInfo) srcMeshes.push(node);
        let lo = Infinity,
          hi = -Infinity;
        for (const cm of srcMeshes) {
          cm.computeWorldMatrix(true);
          const cbb = cm.getBoundingInfo().boundingBox;
          lo = Math.min(lo, cbb.minimumWorld.y);
          hi = Math.max(hi, cbb.maximumWorld.y);
        }
        node._decorHeight = hi > lo ? hi - lo : 2;
        node.position = new BABYLON.Vector3(0, -1000, 0); // park source off-course
        this.sources[name] = node;
      }
    }

    place(type, position, yaw = 0, scale = 1) {
      const src = this.sources[type];
      if (!src) return null;
      const inst = src.instantiateHierarchy(null, { doNotInstantiate: false });
      if (!inst) return null;
      inst.position = position.clone();
      inst.rotation = new BABYLON.Vector3(0, yaw, 0);
      inst.rotationQuaternion = null;
      inst.scaling = new BABYLON.Vector3(scale, scale, scale);
      inst.setEnabled(true);
      inst.getChildMeshes().forEach((m) => {
        m.isPickable = false;
        m.receiveShadows = true;
      });
      return inst;
    }
  }

  /**
   * Shared world-projected (triplanar) materials so hole terrain matches the
   * existing grass/water/sand look without needing UVs baked into the glb.
   */
  class CourseSurfaces {
    constructor(scene) {
      this.scene = scene;
      this.mats = {};
    }

    // Terrain meshes carry planar world (x,y) UVs, so tiling = 1/tileWorld units.
    _tex(path, tileWorld) {
      const t = new BABYLON.Texture(path, this.scene);
      t.wrapU = t.wrapV = BABYLON.Texture.WRAP_ADDRESSMODE;
      t.uScale = t.vScale = 1 / tileWorld;
      return t;
    }

    _std(name, texPath, tileWorld, color, normalPath) {
      const m = new BABYLON.StandardMaterial(name, this.scene);
      m.diffuseColor = color;
      m.specularColor = new BABYLON.Color3(0.02, 0.02, 0.02);
      m.specularPower = 8;
      m.diffuseTexture = this._tex(texPath, tileWorld);
      if (normalPath) m.bumpTexture = this._tex(normalPath, tileWorld);
      return m;
    }

    build() {
      const C = BABYLON.Color3;
      const T = CONFIG.TERRAIN;
      const P = CONFIG.PINS;
      // rough = dark painted-grass texture; fairway/green = brighter putting texture.
      // Fine tiling (small world size per tile) so the painted grass reads at ball scale.
      this.mats.rough = this._std(
        "courseRough",
        T.TEXTURE_PATH,
        2.5,
        new C(0.42, 0.62, 0.28),
        T.NORMAL_MAP_PATH,
      );
      this.mats.fairway = this._std(
        "courseFairway",
        P.GREEN_TEXTURE_PATH,
        2.5,
        new C(0.62, 0.8, 0.42),
        P.GREEN_NORMAL_MAP_PATH,
      );
      this.mats.green = this._std(
        "courseGreen",
        P.GREEN_TEXTURE_PATH,
        1.6,
        new C(0.5, 0.82, 0.28),
        P.GREEN_NORMAL_MAP_PATH,
      );
      this.mats.sand = this._std(
        "courseSand",
        "assets/texture/sand.png",
        3,
        new C(0.96, 0.9, 0.76),
        null,
      );
      this.mats.desert = this._std(
        "courseDesert",
        "assets/texture/sand.png",
        3.5,
        new C(0.94, 0.87, 0.72),
        null,
      );
      this.mats.rock = new BABYLON.StandardMaterial("courseRock", this.scene);
      this.mats.rock.diffuseColor = new C(0.46, 0.44, 0.41);
      this.mats.rock.specularColor = new C(0.05, 0.05, 0.05);

      // Water: bright translucent like the distant water ring
      const water = new BABYLON.PBRMaterial("courseWater", this.scene);
      water.albedoTexture = this._tex("assets/texture/water.png", 10);
      water.bumpTexture = this._tex("assets/texture/waternormals.png", 10);
      water.metallic = 0.6;
      water.roughness = 0.25;
      water.alpha = 0.82;
      water.transparencyMode = BABYLON.Material.MATERIAL_ALPHABLEND;
      water.backFaceCulling = true; // only ever viewed from above — skip the underside
      this.mats.water = water;
      return this.mats;
    }

    // Surface-name → material/physics key. These `surf_*` substrings are a CONTRACT
    // with the hole authoring pipeline: course_design/hole_gen.py writes the mesh
    // names (surf_rough/fairway/green/sand/desert/rockface/water, marker_tee/pin,
    // tree_*/rock_*) and the runtime decodes them here + in buildHeightGrid,
    // BirdFlockSystem.sampleSurface, and CourseManager.loadHole. Rename on one side
    // → update the other, or physics/decor/birds silently break.
    forSurfaceName(name) {
      const n = name.toLowerCase();
      if (n.includes("underwater")) return "rough"; // submerged basin floor
      if (n.includes("water")) return "water";
      if (n.includes("green")) return "green";
      if (n.includes("fairway")) return "fairway";
      if (n.includes("desert")) return "desert";
      if (n.includes("sand")) return "sand";
      if (n.includes("rock")) return "rock"; // rock face backstop
      return "rough"; // rough + rough_underwater
    }
  }

  Object.assign(global, { GrassSystem, CourseDecor, CourseSurfaces });
  if (typeof module !== "undefined" && module.exports)
    module.exports = { GrassSystem, CourseDecor, CourseSurfaces };
})(typeof globalThis !== "undefined" ? globalThis : this);
