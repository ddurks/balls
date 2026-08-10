// course.js — COURSE_HOLES, SURFACE_PHYSICS, CourseManager.
// Split out of game.js; loaded as a plain <script> before game.js (see game.html),
// and require()-able in Node for unit tests. Cross-module refs resolve via globals.
(function (global) {
  // Runtime mirror of each hole's package manifest. Keep this synchronous because
  // the course UI reads it during initialization; manifest.json is the authoring
  // and asset-audit contract stored beside each scene.
  const COURSE_HOLES = [
    {
      id: 1,
      glb: "environments/course/holes/hole-01/scene.glb",
      par: 4,
      name: "Wet and Wild",
      version: "greenfix1",
    },
    {
      id: 2,
      glb: "environments/course/holes/hole-02/scene.glb",
      par: 3,
      name: "Rock and Roll",
      version: "greenfix1",
    },
    {
      id: 3,
      glb: "environments/course/holes/hole-03/scene.glb",
      par: 5,
      name: "On a Bender",
      version: "greenfix1",
    },
  ];

  // Physics + friction per surface type. Golf-ball-scale tuning: rough grabs, greens
  // roll true, sand plugs, the desert rock face bounces balls back toward the green.
  const SURFACE_PHYSICS = {
    // Grass friction ordering: green fastest (least), fairway medium, rough grabbiest.
    green: { friction: 0.9, restitution: 0.1 }, // least → true, fast roll
    fairway: { friction: 1.8, restitution: 0.3 }, // middle
    rough: { friction: 4.5, restitution: 0.2 }, // most → ball stops
    sand: { friction: 10.0, restitution: 0.05, grab: 20 }, // plush bunker: plugs + brakes hard (grab = stop rate)
    desert: { friction: 2.8, restitution: 0.35 }, // firm rocky hardpan
    rock: { friction: 0.5, restitution: 0.6 }, // rock face: lucky bounces
  };

  /**
   * Orchestrates the round: loads holes, builds physics/materials/decor, runs the
   * drone flyover, cycles player turns, detects water + hole-outs, tallies scores.
   * Built for N players; starts with 1.
   */
  class CourseManager {
    constructor(game) {
      this.game = game;
      this.scene = game.scene;
      this.holeIndex = 0;
      this.currentPlayer = 0;
      this.players = [];
      this.holeNodes = [];
      this.holeAggregates = [];
      this.surfaceMeshes = [];
      this.tee = null;
      this.cup = null;
      this.waterlineY = -100;
      this.holeComplete = false;
      this.busy = true; // input locked (menu/drone/transitions)
      this._pickCache = null;
    }

    async init() {
      const players = Math.max(1, this.game.options.players || 1);
      for (let i = 0; i < players; i++) {
        this.players.push({ name: `Player ${i + 1}`, scores: [] });
      }
      this.decor = new CourseDecor(this.scene);
      await this.decor.load();
      // Flowing slope-direction arrows on each green (see slopearrows.js).
      this.slopeArrows = new SlopeArrows(this.scene);
      await this.slopeArrows.load();
      this.surfaces = new CourseSurfaces(this.scene);
      this.surfaces.build();
      this.hud = new CourseHUD();

      this.pinManager = new PinManager(
        this.scene,
        this.game.golfBall,
        this.game.eventManager,
      );
      this.scene.pinManager = this.pinManager;

      this.game.eventManager.on("ball:landed", (pos) => this.onBallLanded(pos));
      // Holing out is handled by GolfGame.onHoleSink (shared cinematic), which
      // calls this.onHoleComplete() for the course-specific score + advance tail.
      this.scene.onBeforeRenderObservable.add(() => this.frame());
    }

    async start() {
      if (this.game.grassSystem) {
        this.game.grassSystem.groundYAt = (x, z) => this.groundY(x, z);
        this.game.grassSystem.playableAt = (x, z) => this.grassAllowed(x, z);
      }
      await this.loadHole(0);
    }

    // ---- terrain height field (sampled once per hole via rays, then O(1) lookups) ----
    // Per-blade raycasting every frame caused big frame drops during ball flight, so
    // the grass system + ball heightRef read this cheap grid instead. This lets grass
    // follow the ball continuously like the practice range (no batch pop-in on landing).
    buildHeightGrid() {
      const cell = 3; // finer than before so the fairway/rough boundary is crisp
      let minX = 1e9,
        maxX = -1e9,
        minZ = 1e9,
        maxZ = -1e9;
      for (const m of this.surfaceMeshes) {
        const bb = m.getBoundingInfo().boundingBox;
        minX = Math.min(minX, bb.minimumWorld.x);
        maxX = Math.max(maxX, bb.maximumWorld.x);
        minZ = Math.min(minZ, bb.minimumWorld.z);
        maxZ = Math.max(maxZ, bb.maximumWorld.z);
      }
      const nx = Math.ceil((maxX - minX) / cell) + 1;
      const nz = Math.ceil((maxZ - minZ) / cell) + 1;
      const height = new Float32Array(nx * nz);
      const playable = new Uint8Array(nx * nz);
      const solid = new Uint8Array(nx * nz); // ray hit terrain (0 = void off the island)
      // sample the ground below (exclude the water surface so height = the bed)
      const solids = this.surfaceMeshes.filter(
        (m) => !m.name.toLowerCase().includes("water"),
      );
      const down = new BABYLON.Vector3(0, -1, 0);
      for (let i = 0; i < nx; i++) {
        for (let j = 0; j < nz; j++) {
          const x = minX + i * cell,
            z = minZ + j * cell;
          const ray = new BABYLON.Ray(
            new BABYLON.Vector3(x, 300, z),
            down,
            600,
          );
          const hit = this.scene.pickWithRay(ray, (m) => solids.includes(m));
          const idx = i * nz + j;
          if (hit && hit.hit) {
            solid[idx] = 1;
            height[idx] = hit.pickedPoint.y;
            const n = hit.pickedMesh.name.toLowerCase();
            // Grass only on rough turf, and never on the submerged bed under water.
            playable[idx] =
              n.includes("rough") && hit.pickedPoint.y > this.waterlineY + 0.4
                ? 1
                : 0;
          }
        }
      }
      // Erode the playable mask by one cell so grass never straddles a boundary
      // (fairway / sand / water / hole edge). A cell survives only if it and all
      // four orthogonal neighbours are rough — keeps every blade strictly inside
      // the rough with a thin first-cut margin, so nothing leaks onto the fairway.
      const eroded = new Uint8Array(nx * nz);
      for (let i = 1; i < nx - 1; i++) {
        for (let j = 1; j < nz - 1; j++) {
          const idx = i * nz + j;
          if (
            playable[idx] &&
            playable[(i - 1) * nz + j] &&
            playable[(i + 1) * nz + j] &&
            playable[i * nz + (j - 1)] &&
            playable[i * nz + (j + 1)]
          ) {
            eroded[idx] = 1;
          }
        }
      }
      this.hg = { minX, minZ, cell, nx, nz, height, playable: eroded, solid };
    }

    groundY(x, z) {
      const hg = this.hg;
      if (!hg) return 0;
      const fx = (x - hg.minX) / hg.cell,
        fz = (z - hg.minZ) / hg.cell;
      let i = Shared.clamp(Math.floor(fx), 0, hg.nx - 2);
      let j = Shared.clamp(Math.floor(fz), 0, hg.nz - 2);
      const tx = Shared.clamp(fx - i, 0, 1),
        tz = Shared.clamp(fz - j, 0, 1);
      const H = (a, b) => hg.height[a * hg.nz + b];
      return (
        H(i, j) * (1 - tx) * (1 - tz) +
        H(i + 1, j) * tx * (1 - tz) +
        H(i, j + 1) * (1 - tx) * tz +
        H(i + 1, j + 1) * tx * tz
      );
    }

    // Is the given position sitting on a green surface? Used by club auto-select
    // so the putter is only ever the default on the green. Rays straight down and
    // reads the surface it hits.
    isOnGreen(pos) {
      const ray = new BABYLON.Ray(
        new BABYLON.Vector3(pos.x, pos.y + 3, pos.z),
        new BABYLON.Vector3(0, -1, 0),
        20,
      );
      const hit = this.scene.pickWithRay(
        ray,
        (m) => m.name && m.name.startsWith("surf_"),
      );
      return !!(
        hit &&
        hit.hit &&
        this.surfaces.forSurfaceName(hit.pickedMesh.name) === "green"
      );
    }

    grassAllowed(x, z) {
      const hg = this.hg;
      if (!hg) return false;
      const i = Math.max(
        0,
        Math.min(hg.nx - 1, Math.round((x - hg.minX) / hg.cell)),
      );
      const j = Math.max(
        0,
        Math.min(hg.nz - 1, Math.round((z - hg.minZ) / hg.cell)),
      );
      return hg.playable[i * hg.nz + j] === 1;
    }

    // ---- hole lifecycle ----
    async loadHole(index) {
      this.busy = true;
      this.holeIndex = index;
      this.holeComplete = false;
      this.game.wind?.reset?.(); // fresh (non-editable) wind condition per hole
      const cfg = COURSE_HOLES[index];

      // Show the loading logo ON TOP for the whole load, every hole. Hole 0 arrives
      // from the clubhouse behind a black arrival cover, and later holes behind the
      // between-hole cover (advance() wiped to black) — showBoot() lifts the logo
      // above both, so the player sees the logo instead of plain black. The reveal
      // (below) is a logo opacity-fade, which can't freeze the way the width/height
      // iris does when the new hole's first render stalls the main thread.
      Shared.showBoot();
      const reveal = () => {
        Shared.roomFX.clearCovers(); // drop the black cover(s) sitting behind the logo…
        Shared.hideBoot(); //           …then fade the logo out to reveal the hole
      };

      // Cache-bust: hole .glb files are served immutable, so version the request
      // to pick up rebuilt geometry. Force the glb loader since the query hides the ext.
      let res;
      try {
        res = await Shared.loadModel(cfg.glb, this.scene, {
          version: cfg.version,
        });
      } catch (e) {
        console.error(
          `Hole ${index + 1} geometry (${cfg.glb}) failed to load.`,
          e,
        );
        await reveal();
        this.busy = false;
        return;
      }

      let teeMarker = null;
      const pinMarkers = [];
      let root = null;
      const decorMarkers = [];
      const surfMeshes = [];

      for (const mesh of res.meshes) {
        const name = mesh.name;
        if (name === "__root__") {
          root = mesh;
          this.holeNodes.push(mesh);
          continue;
        }
        if (name.startsWith("marker_tee")) {
          teeMarker = mesh;
          continue;
        }
        if (name.startsWith("marker_pin")) {
          pinMarkers.push(mesh); // flat-spot pin pool (marker_pin_0..N)
          continue;
        }
        if (name.startsWith("tree_") || name.startsWith("rock_")) {
          decorMarkers.push(mesh); // <tree|rock>_<type>_<idx>
          continue;
        }
        if (name.startsWith("surf_")) {
          surfMeshes.push(mesh);
          continue;
        }
      }

      // Center the hole on the origin so it sits inside the distant scenery/mountain
      // ring (esp. the long par 5). Do this BEFORE building colliders.
      if (root) {
        root.computeWorldMatrix(true);
        const b = root.getHierarchyBoundingVectors(true);
        root.position.x -= (b.min.x + b.max.x) / 2;
        root.position.z -= (b.min.z + b.max.z) / 2;
        root.computeWorldMatrix(true);
      }
      for (const m of surfMeshes) m.computeWorldMatrix(true);
      for (const m of surfMeshes) this.setupSurface(m);

      // Waterline (for water-hazard detection + keeping grass off submerged bed) —
      // read from the water plane geometry BEFORE building the height grid.
      const waterMesh = this.surfaceMeshes.find((m) =>
        m.name.toLowerCase().startsWith("surf_water"),
      );
      this.waterlineY = waterMesh
        ? waterMesh.getBoundingInfo().boundingBox.centerWorld.y
        : -100;

      this.buildHeightGrid(); // cheap height/playable lookup for grass + ball
      this.game.grassSystem?.reset(); // drop last hole's grass (terrain changed)

      // A hole is unplayable without its tee/pin markers — bail cleanly rather than
      // throwing a TypeError deep in the render loop if the .glb is malformed.
      if (!teeMarker || pinMarkers.length === 0) {
        console.error(
          `Hole ${index + 1} is missing marker_tee/marker_pin; skipping.`,
        );
        await reveal();
        this.busy = false;
        return;
      }

      // Tee world position from marker.
      teeMarker.computeWorldMatrix(true);
      this.tee = teeMarker.getAbsolutePosition().clone();

      // Pick this hole's pin from the flat-spot pool: random each round, unless the
      // hole forces a specific spot via COURSE_HOLES[index].pinIndex (purposeful).
      // Chosen once per hole load, so every hot-seat player plays the same pin.
      const pinIdx = (n) => {
        const m = /marker_pin_(\d+)/.exec(n);
        return m ? +m[1] : 0;
      };
      pinMarkers.sort((a, b) => pinIdx(a.name) - pinIdx(b.name));
      const forced = COURSE_HOLES[index]?.pinIndex;
      const chosen = Number.isInteger(forced)
        ? pinMarkers[Shared.clamp(forced, 0, pinMarkers.length - 1)]
        : pinMarkers[Math.floor(Math.random() * pinMarkers.length)];
      chosen.computeWorldMatrix(true);
      this.cup = chosen.getAbsolutePosition().clone();
      // Anchor the cup to the EXACT green surface at the pin via a downward ray (the
      // marker sits off the undulating surface, and the coarse height grid can be a
      // couple cm off — the tee peg uses the same trick), so the cavity lines up with
      // the turf. Fall back to the height grid if the ray misses.
      const cupRay = new BABYLON.Ray(
        new BABYLON.Vector3(this.cup.x, this.cup.y + 50, this.cup.z),
        new BABYLON.Vector3(0, -1, 0),
        100,
      );
      const cupHit = this.scene.pickWithRay(
        cupRay,
        (m) => m.name && m.name.startsWith("surf_"),
      );
      this.cup.y =
        cupHit && cupHit.hit
          ? cupHit.pickedPoint.y
          : this.groundY(this.cup.x, this.cup.z);

      // Trees + rocks (instanced from decor.glb)
      this.treeZones = [];
      const authoredRocks = [];
      for (const dm of decorMarkers) {
        dm.computeWorldMatrix(true);
        const parts = dm.name.split("_"); // <tree|rock>_<type>_<idx>
        const type = parts[1] || "tree1";
        const pos = dm.getAbsolutePosition().clone(); // ground (pre-sink) position
        const isTree = dm.name.startsWith("tree_");
        let s = Math.abs(dm.absoluteScaling.x) || 1;
        if (isTree) s *= 3; // trees 3x bigger (relative to the pin)
        const yaw =
          (dm.rotationQuaternion
            ? dm.rotationQuaternion.toEulerAngles().y
            : dm.rotation.y) || 0;
        if (isTree) {
          // Sink the trunk base a little into the turf so it never peeks/floats
          // over undulating ground, then add a solid trunk collider (leaves stay
          // pass-through via the canopy zone below).
          pos.y -= 0.5 + 0.25 * s;
          const inst = this.decor.place(type, pos, yaw, s);
          if (inst) this.holeNodes.push(inst);
          this.addDecorCollider(type, true, pos, yaw, s);
          this.treeZones.push({
            x: pos.x,
            z: pos.z,
            r: 2.4 * s,
            y0: pos.y - 0.5,
            y1: pos.y + 7 * s,
          });
        } else {
          this.placeRock(type, pos.clone(), yaw, s);
          authoredRocks.push({ type, groundPos: pos.clone(), scale: s });
        }
        dm.dispose();
      }
      // More rocks per the design: 2× lining hole 1's water, 3× on hole 2, and a
      // random scatter across hole 3's rough.
      this.addExtraRocks(cfg.id, authoredRocks);
      teeMarker.dispose();
      for (const pm of pinMarkers) pm.dispose();

      // Cup / flag / sink detection. Point auto-aim at THIS hole's cup (otherwise
      // it keeps aiming at the previous hole's now-disposed pin).
      // Green surface normal at the cup so the cavity mouth lies flush on slopes
      // (a flat horizontal mouth floats over a tilted green → the visible gap).
      const cupNormal =
        (cupHit && cupHit.hit && cupHit.getNormal(true, true)) ||
        new BABYLON.Vector3(0, 1, 0);
      this.pinManager.addPin(this.cup.clone(), this.scene, {
        cavity: true,
        surfaceNormal: cupNormal,
      });
      this.slopeArrows?.build(this.cup, (x, z) => this.groundY(x, z));
      this.game.currentHolePin =
        this.pinManager.pins[this.pinManager.pins.length - 1];

      this.placeBallAtTee();
      this.hud.setHole(cfg.id, cfg.par, cfg.name);
      this.game.isControlsDisabled = true;
      this.game.aimView?.deactivate?.();

      // Start the hole on the club the tee shot actually calls for — not the
      // putter left selected from holing out on the previous green. Clear the
      // manual lock so it's a suggestion the player can still override, and set
      // it BEFORE the flyover so the HUD reads right from the reveal.
      const cs = this.game.aimView?.clubSelector;
      if (cs) {
        cs.enableAutoSelect();
        cs.currentClub = cs.suggestClub(
          BABYLON.Vector3.Distance(this.tee, this.cup),
          false, // teeing off is never "on the green"
        );
        cs.updateUI?.();
      }

      // Hold the logo until every mesh + texture is ready (no flash of just the ball
      // + water). Race a 4 s safety so a stuck texture can't keep the logo up forever.
      await Promise.race([
        this.scene.whenReadyAsync(),
        new Promise((r) => setTimeout(r, 4000)),
      ]);
      const drone = new DroneCamera(this.scene);
      const flyDone = drone.fly(
        this.tee.clone(),
        this.cup.clone(),
        this.game.camera.camera,
      );
      // Let the first couple of frames render behind the logo so the shader-compile
      // hitch on the new hole's materials happens hidden, not during the reveal.
      await new Promise((r) =>
        requestAnimationFrame(() => requestAnimationFrame(r)),
      );
      reveal();
      await flyDone;

      this.beginTurn();
    }

    // Place a rock instance (sunk halfway into the turf) plus a convex-hull
    // collider that matches its mesh exactly.
    placeRock(type, groundPos, yaw, scale) {
      const rh = this.decor.sources[type]?._decorHeight || 2;
      const pos = groundPos.clone();
      pos.y -= 0.5 * rh * scale; // bury the lower half (origin sits at the base)
      const inst = this.decor.place(type, pos, yaw, scale);
      if (inst) this.holeNodes.push(inst);
      this.addDecorCollider(type, false, pos, yaw, scale);
    }

    // Invisible CONVEX-HULL collider matching the actual decor mesh, so the ball
    // can never end up visually inside a rock or tree trunk (the old
    // sphere/cylinder approximations under-covered the mesh, and trees had no
    // trunk collider at all). Built from a real clone of the decor source —
    // rocks hull their whole (convex) mesh; trees hull ONLY the trunk (treewood
    // submesh) so the leaf canopy stays pass-through (see treeZones slow-down).
    addDecorCollider(type, isTree, pos, yaw, scale) {
      const src = this.decor.sources[type];
      if (!src) return;
      const col = src.clone("decorCol_" + type, null);
      if (!col) return;
      col.setParent(null);
      col.position = pos.clone();
      col.rotationQuaternion = null;
      col.rotation = new BABYLON.Vector3(0, yaw, 0);
      col.scaling = new BABYLON.Vector3(scale, scale, scale);
      col.setEnabled(true);
      col.isVisible = false;
      col.isPickable = false;
      // Geometry can live on the node itself (rocks) or on per-material child
      // submeshes (trees: foliage + treewood).
      const meshes = col.getChildMeshes ? col.getChildMeshes(false) : [];
      if (col.getTotalVertices && col.getTotalVertices() > 0) meshes.push(col);
      for (const m of meshes) {
        m.isVisible = false;
        m.isPickable = false;
      }
      const hasGeom = (m) => m.getTotalVertices && m.getTotalVertices() > 0;
      let parts;
      if (isTree) {
        parts = meshes.filter(
          (m) => m.material && /wood|trunk|bark/i.test(m.material.name),
        );
        // Fallback: if the trunk submesh isn't named as expected, hull every
        // solid part EXCEPT the leaves, so a tree never ends up with no collider.
        if (parts.length === 0)
          parts = meshes.filter(
            (m) =>
              hasGeom(m) &&
              !(
                m.material &&
                /foliage|leaf|leaves|canopy/i.test(m.material.name)
              ),
          );
      } else {
        parts = meshes.filter(hasGeom);
      }
      const opts = isTree
        ? { mass: 0, friction: 0.7, restitution: 0.4 }
        : { mass: 0, friction: 0.8, restitution: 0.45 };
      for (const m of parts) {
        m.computeWorldMatrix(true);
        const agg = new BABYLON.PhysicsAggregate(
          m,
          BABYLON.PhysicsShapeType.CONVEX_HULL,
          opts,
          this.scene,
        );
        this.holeAggregates.push(agg);
      }
      this.holeNodes.push(col);
    }

    // Extra rocks beyond the authored markers (see the loadHole call site):
    //   hole 1 → double, distributed ALONG the water line (not paired on top of
    //            the originals),
    //   hole 2 → triple, scattered randomly on the rough around the originals,
    //   hole 3 → a random scatter across the rough.
    addExtraRocks(holeId, authored) {
      if (holeId === 1) {
        this.distributeRocksAlong(authored, authored.length); // +1× along the water
      } else if (holeId === 2) {
        const box = this._rockBBox(authored, 10);
        this.scatterRoughRocks(authored.length * 2, box, authored); // +2× → triple
      } else if (holeId === 3) {
        this.scatterRoughRocks(24, null, authored);
      }
    }

    // Distribute `addCount` rocks evenly ALONG the chain the authored rocks form
    // (nearest-neighbour ordered), interleaved between the originals with a bit of
    // perpendicular jitter — so hole 1's rocks line the water more densely instead
    // of doubling up in place.
    distributeRocksAlong(authored, addCount) {
      if (authored.length < 2 || addCount <= 0) return;
      // Greedy nearest-neighbour chain so "between adjacent" follows the shoreline.
      const used = new Array(authored.length).fill(false);
      const order = [0];
      used[0] = true;
      for (let k = 1; k < authored.length; k++) {
        const last = authored[order[order.length - 1]].groundPos;
        let best = -1,
          bd = Infinity;
        for (let i = 0; i < authored.length; i++) {
          if (used[i]) continue;
          const d = BABYLON.Vector3.DistanceSquared(
            last,
            authored[i].groundPos,
          );
          if (d < bd) {
            bd = d;
            best = i;
          }
        }
        order.push(best);
        used[best] = true;
      }
      const chain = order.map((i) => authored[i]);
      const seg = [];
      let total = 0;
      for (let i = 0; i < chain.length - 1; i++) {
        const d = BABYLON.Vector3.Distance(
          chain[i].groundPos,
          chain[i + 1].groundPos,
        );
        seg.push(d);
        total += d;
      }
      if (total < 1e-3) return;
      for (let n = 0; n < addCount; n++) {
        let s = (total * (n + 0.5)) / addCount; // interleave between originals
        let i = 0;
        while (i < seg.length - 1 && s > seg[i]) {
          s -= seg[i];
          i++;
        }
        const a = chain[i],
          b = chain[i + 1];
        const t = seg[i] > 1e-6 ? Shared.clamp(s / seg[i], 0, 1) : 0.5;
        const p = BABYLON.Vector3.Lerp(a.groundPos, b.groundPos, t);
        const dir = b.groundPos.subtract(a.groundPos);
        const len = Math.hypot(dir.x, dir.z) || 1;
        const jit = (Math.random() * 2 - 1) * 1.5; // perpendicular wobble (m)
        const gp = new BABYLON.Vector3(
          p.x + (-dir.z / len) * jit,
          0,
          p.z + (dir.x / len) * jit,
        );
        gp.y = this.groundY(gp.x, gp.z);
        const scale = a.scale * (0.8 + Math.random() * 0.5);
        this.placeRock(a.type, gp, Math.random() * Math.PI * 2, scale);
      }
    }

    // Padded XZ bounding box of a set of authored rocks (fallback: whole hole).
    _rockBBox(authored, pad) {
      if (!authored || authored.length === 0) return null;
      let minX = Infinity,
        maxX = -Infinity,
        minZ = Infinity,
        maxZ = -Infinity;
      for (const r of authored) {
        const p = r.groundPos;
        minX = Math.min(minX, p.x);
        maxX = Math.max(maxX, p.x);
        minZ = Math.min(minZ, p.z);
        maxZ = Math.max(maxZ, p.z);
      }
      return {
        minX: minX - pad,
        maxX: maxX + pad,
        minZ: minZ - pad,
        maxZ: maxZ + pad,
      };
    }

    // Randomly spatter `count` rocks on the ROUGH within `box` (defaults to the
    // whole hole). Rays down to the surface, keeps only rough hits clear of the
    // tee, cup, and any rocks in `avoid` / already placed, so nothing clusters.
    scatterRoughRocks(count, box, avoid) {
      const hg = this.hg;
      if (!hg) return;
      const b = box || {
        minX: hg.minX,
        maxX: hg.minX + (hg.nx - 1) * hg.cell,
        minZ: hg.minZ,
        maxZ: hg.minZ + (hg.nz - 1) * hg.cell,
      };
      const types = ["rock1", "rock2", "rock3"];
      const down = new BABYLON.Vector3(0, -1, 0);
      const avoidPts = (avoid || []).map((r) => r.groundPos);
      const placed = [];
      const tooClose = (gp) =>
        avoidPts.some((p) => BABYLON.Vector3.DistanceSquared(gp, p) < 9) ||
        placed.some((p) => BABYLON.Vector3.DistanceSquared(gp, p) < 9);
      let n = 0;
      for (let tries = 0; n < count && tries < count * 30; tries++) {
        const x = b.minX + Math.random() * (b.maxX - b.minX);
        const z = b.minZ + Math.random() * (b.maxZ - b.minZ);
        const ray = new BABYLON.Ray(new BABYLON.Vector3(x, 200, z), down, 400);
        const hit = this.scene.pickWithRay(
          ray,
          (m) => m.name && m.name.startsWith("surf_"),
        );
        if (!hit || !hit.hit) continue;
        if (this.surfaces.forSurfaceName(hit.pickedMesh.name) !== "rough")
          continue;
        const gp = new BABYLON.Vector3(x, hit.pickedPoint.y, z);
        if (BABYLON.Vector3.Distance(gp, this.tee) < 5) continue;
        if (BABYLON.Vector3.Distance(gp, this.cup) < 7) continue;
        if (tooClose(gp)) continue;
        const type = types[Math.floor(Math.random() * types.length)];
        const scale = 0.5 + Math.random() * 0.9;
        this.placeRock(type, gp, Math.random() * Math.PI * 2, scale);
        placed.push(gp);
        n++;
      }
    }

    setupSurface(mesh) {
      const type = this.surfaces.forSurfaceName(mesh.name);
      mesh.material = this.surfaces.mats[type];
      mesh.isPickable = true; // used by surface ray + grass sampling
      mesh.receiveShadows = true;
      this.surfaceMeshes.push(mesh);
      if (type !== "water") {
        const phys = SURFACE_PHYSICS[type] || SURFACE_PHYSICS.rough;
        // Stamp the surface restitution so the anti-tunnel bounce (character.js
        // preventTunneling) reflects off sand vs rock correctly, not a global.
        mesh._surfaceRestitution = phys.restitution;
        mesh._surfaceGrab = phys.grab || 0; // sand grabs the ball to a fast stop
        const agg = new BABYLON.PhysicsAggregate(
          mesh,
          BABYLON.PhysicsShapeType.MESH,
          { mass: 0, friction: phys.friction, restitution: phys.restitution },
          this.scene,
        );
        this.holeAggregates.push(agg);
      }
    }

    placeBallAtTee(yOffset = 0.05) {
      const pos = this.tee.clone();
      // Rest on the real pad surface — the marker can sit well below the pad.
      pos.y = this.teeSurfaceY() + yOffset;
      this.game.ballStartPosition = pos.clone();
      this.game.golfBall.startPosition = pos.clone();
      this.game.golfBall.reset();
      this.lastLie = pos.clone();
    }

    // Actual pad-surface height at the tee (the marker can sit below the pad).
    teeSurfaceY() {
      const ray = new BABYLON.Ray(
        new BABYLON.Vector3(this.tee.x, this.tee.y + 50, this.tee.z),
        new BABYLON.Vector3(0, -1, 0),
        100,
      );
      const hit = this.scene.pickWithRay(
        ray,
        (m) => m.name && m.name.startsWith("surf_"),
      );
      return hit && hit.hit ? hit.pickedPoint.y : this.tee.y;
    }

    // Real-size wooden tee peg (~5 cm) for driver tee shots on the longer holes.
    makeTeePeg(pos, pegH) {
      const peg = BABYLON.MeshBuilder.CreateCylinder(
        "teePeg",
        {
          height: pegH,
          diameterTop: 0.05,
          diameterBottom: 0.012,
          tessellation: 10,
        },
        this.scene,
      );
      peg.position = new BABYLON.Vector3(
        pos.x,
        this.teeSurfaceY() + pegH / 2,
        pos.z,
      );
      const mat = new BABYLON.StandardMaterial("teePegMat", this.scene);
      mat.diffuseColor = new BABYLON.Color3(0.95, 0.9, 0.82);
      mat.specularColor = new BABYLON.Color3(0.1, 0.1, 0.1);
      peg.material = mat;
      peg.isPickable = false;
      peg.receiveShadows = true;
      // Collider so the ball rests teed-up until struck.
      this.teePegAgg = new BABYLON.PhysicsAggregate(
        peg,
        BABYLON.PhysicsShapeType.CYLINDER,
        { mass: 0, friction: 0.6, restitution: 0.1 },
        this.scene,
      );
      return peg;
    }

    disposeTeePeg() {
      if (this.teePegAgg) {
        try {
          this.teePegAgg.dispose();
        } catch (e) {}
        this.teePegAgg = null;
      }
      if (this.teePeg) {
        this.teePeg.dispose();
        this.teePeg = null;
      }
    }

    beginTurn() {
      this.busy = false; // player may act
      this.game.currentHoleShotCount = 0;
      this.holeSinkGuardReset();
      this.disposeTeePeg();

      // Tee the ball up when the shot warrants a wood/driver (by distance to pin).
      // Metres, to match ClubData.maxDistance (findBestClubForDistance compares
      // against it directly). Passing yards here biased tee shots toward woods.
      const distToPin = BABYLON.Vector3.Distance(this.tee, this.cup);
      const bestClub =
        this.game.aimView?.clubSelector?.findBestClubForDistance(distToPin) ??
        0;
      const useTee = bestClub >= 10; // 3 Wood / 5 Wood / Driver
      const pegH = 0.05; // visible tee height ≈ 5 cm
      this.placeBallAtTee(useTee ? pegH + 0.03 : 0.05);
      if (useTee) this.teePeg = this.makeTeePeg(this.tee, pegH);

      // Aim the camera down the hole toward the pin (behind-ball view).
      // Normalize to [-pi,pi] so the aim→strike camera lerp doesn't wrap the long way.
      const dx = this.cup.x - this.tee.x;
      const dz = this.cup.z - this.tee.z;
      const bearing = this.game.normalizeAngle(Math.atan2(dx, dz) + Math.PI);
      this.game.gameState = GameState.AIM;
      this.game.isControlsDisabled = false;
      if (this.game.aimView) {
        this.game.aimView.cameraRotation = bearing;
        this.game.aimView.activate();
        // Default the tee shot to a driver (and lock it until the player re-aims).
        if (useTee && this.game.aimView.clubSelector) {
          this.game.aimView.clubSelector.currentClub = 12;
          this.game.aimView.clubSelector.manuallySelectedClub = true;
        }
      }
      this.game.circleUIManager?.showStatsCircle();
      this.game.circleUIManager?.showCompassCircle();
    }

    holeSinkGuardReset() {
      this.game.holeSinkProcessed = false;
      this.game.clearArchivedTrails?.();
    }

    // ---- per-frame ----
    frame() {
      if (!this.game.golfBall) return;
      const ball = this.game.golfBall;
      // Keep airborne/landing tests relative to the terrain under the ball
      const bp = ball.getPosition();
      if (this.hg) ball.heightRef = this.groundY(bp.x, bp.z);

      // Slope arrows: only visible while the putter (club id 0) is the active club.
      if (this.slopeArrows) {
        const putterOut = this.game.aimView?.currentClub === 0;
        this.slopeArrows.setVisible(putterOut);
        if (putterOut) {
          this.slopeArrows.update(this.game.engine.getDeltaTime() / 1000);
        }
      }

      // Out of bounds: ball rolled/flew off the hole terrain (an island) and is
      // falling into the void — take a penalty drop instead of falling forever.
      if (!this.busy && !this.holeComplete && bp.y < -15) {
        this.applyPenalty("Out of bounds +1");
        return;
      }

      // Trees: when the ball enters a canopy it's deflected out ONCE — losing
      // energy and kicking out in a random-but-forward-biased direction — instead
      // of being continuously slowed (which used to freeze it inside the tree).
      let zoneNow = null;
      if (this.treeZones) {
        for (const z of this.treeZones) {
          if (bp.y < z.y1 && bp.y > z.y0) {
            const dx = bp.x - z.x,
              dz = bp.z - z.z;
            if (dx * dx + dz * dz < z.r * z.r) {
              zoneNow = z;
              break;
            }
          }
        }
      }
      if (zoneNow && zoneNow !== this._treeZone) this.treeBounce(ball);
      this._treeZone = zoneNow;

      // Remove the tee peg once the ball has been struck off it. Compare in the
      // horizontal plane only (the tee marker can sit below the ball's rest height).
      if (
        this.teePeg &&
        this.tee &&
        Math.hypot(bp.x - this.tee.x, bp.z - this.tee.z) > 0.3
      ) {
        this.disposeTeePeg();
      }
    }

    // Deflect the ball out of a tree it just entered: lose most of its energy and
    // kick out at a random angle biased toward its original heading, with a small
    // upward pop and some spin — like clattering through the branches.
    treeBounce(ball) {
      const v = ball.getVelocity();
      const hs = Math.hypot(v.x, v.z);
      if (hs < 2) return; // too slow to bounce out meaningfully
      const keep = 0.3 + Math.random() * 0.25; // lose ~45–70% of horizontal speed
      const newHs = hs * keep;
      const heading =
        Math.atan2(v.x, v.z) + (Math.random() - 0.5) * Math.PI * 0.5; // ±45° bias forward
      const nvy = Math.max(1.0, v.y * 0.3) + Math.random() * 2.0; // pop up out of the tree
      ball.body.setLinearVelocity(
        new BABYLON.Vector3(
          Math.sin(heading) * newHs,
          nvy,
          Math.cos(heading) * newHs,
        ),
      );
      ball.body.setAngularVelocity(
        new BABYLON.Vector3(
          (Math.random() - 0.5) * 12,
          (Math.random() - 0.5) * 12,
          (Math.random() - 0.5) * 12,
        ),
      );
      ball.landed = false;
      ball.touchedGround = false;
    }

    // ---- events ----
    onBallLanded(pos) {
      if (this.busy || this.holeComplete) return;
      // Water hazard: resting below the waterline
      if (pos.y < this.waterlineY - 0.15) {
        this.applyWaterPenalty(pos);
        return;
      }
      this.lastLie = pos.clone();
    }

    applyPenalty(msg, dropPos = null) {
      this.game.currentHoleShotCount += 1; // penalty stroke
      this.hud.flash(msg, 1800);
      const drop = (dropPos || this.lastLie || this.tee).clone();
      drop.y += 0.5;
      this.game.golfBall.startPosition = drop.clone();
      this.game.golfBall.reset();
      this.game._awaitingSettle = false;
      this.game.gameState = GameState.AIM;
      this.game.aimView?.activate();
    }

    applyWaterPenalty(pos) {
      // Drop on the nearest flat dry ground that doesn't gain distance on the
      // hole, rather than replaying from the previous lie / tee.
      this.applyPenalty("💦 Water — +1", this.findWaterDrop(pos));
    }

    // Nearest height-grid cell to the water entry point that is dry, roughly
    // level, on real terrain (not the void off the island's edge) and no closer
    // to the cup than where the ball went in. Returns null when nothing
    // qualifies — the caller then falls back to the last lie.
    findWaterDrop(entry) {
      const hg = this.hg;
      if (!hg || !hg.solid || !this.cup || !entry) return null;
      const DRY = 0.2; // min clearance above the waterline (m)
      const FLAT = 0.35; // max height step to any neighbour cell (3 m away) ≈ 12%
      const entryCupSq =
        (entry.x - this.cup.x) ** 2 + (entry.z - this.cup.z) ** 2;
      const H = (i, j) => hg.height[i * hg.nz + j];
      const S = (i, j) => hg.solid[i * hg.nz + j];
      let best = null;
      let bestSq = Infinity;
      for (let i = 1; i < hg.nx - 1; i++) {
        for (let j = 1; j < hg.nz - 1; j++) {
          // The cell and its 4 neighbours must all be real ground — this also
          // keeps the drop a full cell away from the island's edge.
          if (
            !S(i, j) ||
            !S(i - 1, j) ||
            !S(i + 1, j) ||
            !S(i, j - 1) ||
            !S(i, j + 1)
          )
            continue;
          const h = H(i, j);
          if (h < this.waterlineY + DRY) continue; // submerged / beach line
          if (
            Math.abs(H(i - 1, j) - h) > FLAT ||
            Math.abs(H(i + 1, j) - h) > FLAT ||
            Math.abs(H(i, j - 1) - h) > FLAT ||
            Math.abs(H(i, j + 1) - h) > FLAT
          )
            continue; // too sloped to count as flat
          const x = hg.minX + i * hg.cell;
          const z = hg.minZ + j * hg.cell;
          const cupSq = (x - this.cup.x) ** 2 + (z - this.cup.z) ** 2;
          if (cupSq < entryCupSq) continue; // would gain ground on the hole
          const dSq = (x - entry.x) ** 2 + (z - entry.z) ** 2;
          if (dSq < bestSq) {
            bestSq = dSq;
            best = new BABYLON.Vector3(x, h, z);
          }
        }
      }
      return best;
    }

    // Course tail of holing out, invoked by GolfGame.onHoleSink after the shared
    // cinematic. Re-entry is already guarded by GolfGame.holeSinkProcessed.
    onHoleComplete(shotCount) {
      this.holeComplete = true;
      this.busy = true;
      const par = COURSE_HOLES[this.holeIndex].par;
      const strokes = Math.max(1, shotCount);
      this.players[this.currentPlayer].scores[this.holeIndex] = strokes;
      this.hud.flash(CourseUI.scoreName(strokes, par), 2600);
      // Show the make result, then advance to the next hole (no shot overview for
      // now). clearArchivedTrails releases this hole's trails before the teardown.
      setTimeout(() => {
        this.game.clearArchivedTrails();
        this.advance().catch((e) => console.error("Hole advance failed:", e));
      }, 2200);
    }

    async advance() {
      // Next player on the same hole?
      if (this.currentPlayer < this.players.length - 1) {
        this.currentPlayer += 1;
        this.holeComplete = false;
        this.busy = false;
        this.hud.flash(
          `${this.players[this.currentPlayer].name} — tee off`,
          1600,
        );
        this.beginTurn();
        return;
      }
      // Otherwise advance to the next hole
      this.currentPlayer = 0;
      if (this.holeIndex < COURSE_HOLES.length - 1) {
        // Circle-wipe to black BEFORE tearing down the old hole so the swap (dispose
        // + load) is hidden; loadHole reopens the iris once the new hole is ready.
        this.busy = true;
        await Shared.roomFX.irisClose();
        this.disposeHole();
        // Await + recover: an unawaited loadHole that rejects (bad .glb, a stalled
        // whenReadyAsync/drone) would strand the player behind the black cover with
        // busy=true and an unhandled rejection. Drop the cover + unlock instead.
        try {
          await this.loadHole(this.holeIndex + 1);
        } catch (e) {
          console.error("Failed to load the next hole:", e);
          Shared.roomFX.clearCovers();
          Shared.hideBoot();
          this.busy = false;
        }
      } else {
        this.hud.hide();
        Scoreboard.show(this.players, COURSE_HOLES);
      }
    }

    disposeHole() {
      this.disposeTeePeg();
      this.treeZones = [];
      this.slopeArrows?.clear();
      this.game.currentHolePin = null; // avoid auto-aiming at the old cup
      for (const agg of this.holeAggregates) {
        try {
          agg.dispose();
        } catch (e) {}
      }
      this.holeAggregates = [];
      for (const node of this.holeNodes) {
        try {
          node.getChildMeshes?.().forEach((m) => m.dispose());
          node.dispose();
        } catch (e) {}
      }
      this.holeNodes = [];
      this.surfaceMeshes = [];
      if (this.pinManager?.pins) {
        for (const pin of this.pinManager.pins) {
          try {
            pin.body?.dispose?.();
            pin.mesh?.dispose();
            pin.flagMesh?.dispose();
            pin.flagPivot?.dispose();
            pin.hole?.dispose();
            pin.cupWallAgg?.dispose?.();
            pin.cupFloorAgg?.dispose?.();
            pin.cupWall?.dispose();
            pin.cupFloor?.dispose();
            // Materials/textures aren't freed by mesh.dispose() — do it explicitly.
            // flagMat's texture is the shared static cache, so dispose the material
            // but NOT its diffuseTexture.
            pin.poleMat?.dispose();
            pin.flagMat?.dispose();
            pin.holeMat?.dispose();
            pin.stripeTexture?.dispose();
          } catch (e) {}
        }
        this.pinManager.pins = [];
      }
      this._pickCache = null;
    }
  }

  Object.assign(global, {
    COURSE_HOLES,
    SURFACE_PHYSICS,
    CourseManager,
  });
  if (typeof module !== "undefined" && module.exports)
    module.exports = {
      COURSE_HOLES,
      SURFACE_PHYSICS,
      CourseManager,
    };
})(typeof globalThis !== "undefined" ? globalThis : this);
