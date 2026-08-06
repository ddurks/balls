/* ============================================================================
 * Balls — Clubhouse (the game's root)
 *
 * A standalone Babylon.js hangout: a country-club room with a PS1 look where
 * players walk their gball around (Club-Penguin style), chat, and see each
 * other in real time. Two doors lead out to the Course and the Range.
 *
 * Deliberately separate from the golf game (game.js): no Havok, no swing
 * mechanics. Multiplayer is presence + chat only, served by the drawvidverse
 * worldserver (GAME_KEY=clubhouse, port 7779). Works single-player if the
 * server is unreachable.
 * ========================================================================== */
(function () {
  "use strict";

  // Shared math helpers (from shared.js, loaded first). Aliased so the existing
  // clamp()/lerp()/lerpAngle() call sites below are unchanged.
  const { clamp, lerp, lerpAngle } = Shared;

  // Shared flat-material helpers (materials.js). Aliased here — ABOVE start() —
  // so flatMat()/colorMat() are initialized before start() runs (const has no
  // hoisting, unlike the function declarations these replaced).
  const flatMat = Materials.flat;
  const colorMat = Materials.color;

  // ---- config ----------------------------------------------------------------
  const params = new URLSearchParams(location.search);
  const isLocal =
    location.hostname === "localhost" || location.hostname === "127.0.0.1";
  const WS_URL =
    params.get("ws") ||
    (isLocal ? "ws://localhost:7779" : "wss://balls-world.drawvid.com");

  const ASSET_V = "14"; // bump to bust the immutable /assets cache after a rebuild
  const AV_SCALE = 0.8; // gball model radius ~1 -> ~1.6 dia avatar
  const MOVE_SPEED = 6.0;
  const SEND_HZ = 10;
  const DOOR_RADIUS = 2.6;
  const ARRIVE_DIST = 1.7; // how far inside the room you land entering via a door

  // Which room this page is showing (?room=vip loads the VIP lounge). Doors are
  // plain page navigations, so each room is a fresh load — no in-place swapping.
  const ROOM = params.get("room") === "vip" ? "vip" : "main";
  const ROOM_CFG = {
    main: {
      glb: "clubhouse.glb",
      area: 0,
      doors: {
        course: { label: "COURSE", url: "game.html?mode=course" },
        range: { label: "RANGE", url: "game.html?mode=practice" },
        vip: { label: "MEMBERS", url: "index.html?room=vip" },
      },
    },
    vip: {
      glb: "vip_lounge.glb",
      area: 1,
      doors: {
        main: { label: "LOBBY", url: "index.html" },
        locker: { label: "LOCKER ROOM", url: "locker.html" },
      },
    },
  }[ROOM];
  const MY_AREA = ROOM_CFG.area;
  document.title =
    ROOM === "vip" ? "Balls — Members Lounge" : "Balls Clubhouse";

  const MY_NAME =
    (localStorage.getItem("ballsName") || "").trim() ||
    "Guest" + Math.floor(100 + Math.random() * 900);

  // ---- boot ------------------------------------------------------------------
  function whenReady() {
    if (typeof BABYLON === "undefined" || !BABYLON.Engine) {
      return setTimeout(whenReady, 30);
    }
    start().catch((e) => console.error("[clubhouse] fatal", e));
  }
  whenReady();

  // ---- PS1 procedural textures ----------------------------------------------
  // Small, nearest-sampled, painterly = "impressionist PS1".
  // Wood (3 planks) + shag come from the shared generator (src/shared/textures.js);
  // the locker room builds the same building with its own name/knobs.
  function woodTexture(scene) {
    return Textures.wood(scene, {
      name: "woodTex",
      grainStrokes: 190,
      planks: 3,
    });
  }

  function shagTexture(scene) {
    return Textures.shag(scene, { name: "shagTex" });
  }

  // Build a tangent-space normal map from a height function (finite differences),
  // NEAREST-sampled to match the PS1 textures. Used for the shag + wood bump.
  function normalMap(scene, name, S, heightFn, strength) {
    const dt = new BABYLON.DynamicTexture(name, S, scene, false);
    const ctx = dt.getContext();
    const img = ctx.createImageData(S, S);
    const h = new Float32Array(S * S);
    for (let y = 0; y < S; y++)
      for (let x = 0; x < S; x++) h[y * S + x] = heightFn(x, y, S);
    for (let y = 0; y < S; y++)
      for (let x = 0; x < S; x++) {
        const hl = h[y * S + ((x - 1 + S) % S)],
          hr = h[y * S + ((x + 1) % S)];
        const hu = h[((y - 1 + S) % S) * S + x],
          hd = h[((y + 1) % S) * S + x];
        let nx = (hl - hr) * strength,
          ny = (hd - hu) * strength,
          nz = 1;
        const inv = 1 / Math.hypot(nx, ny, nz);
        nx *= inv;
        ny *= inv;
        nz *= inv;
        const i = (y * S + x) * 4;
        img.data[i] = ((nx * 0.5 + 0.5) * 255) | 0;
        img.data[i + 1] = ((ny * 0.5 + 0.5) * 255) | 0;
        img.data[i + 2] = ((nz * 0.5 + 0.5) * 255) | 0;
        img.data[i + 3] = 255;
      }
    ctx.putImageData(img, 0, 0);
    dt.update();
    dt.updateSamplingMode(BABYLON.Texture.NEAREST_SAMPLINGMODE);
    dt.wrapU = dt.wrapV = BABYLON.Texture.WRAP_ADDRESSMODE;
    return dt;
  }

  // Compute per-vertex tangents from positions/uvs/normals so StandardMaterial
  // normal-mapping works (glb box meshes ship without tangents -> bump renders black).
  function computeTangents(mesh) {
    const pos = mesh.getVerticesData(BABYLON.VertexBuffer.PositionKind);
    const nor = mesh.getVerticesData(BABYLON.VertexBuffer.NormalKind);
    const uv = mesh.getVerticesData(BABYLON.VertexBuffer.UVKind);
    const idx = mesh.getIndices();
    if (!pos || !nor || !uv || !idx) return;
    const n = pos.length / 3;
    const acc = new Float32Array(n * 3);
    for (let i = 0; i < idx.length; i += 3) {
      const a = idx[i],
        b = idx[i + 1],
        c = idx[i + 2];
      const e1x = pos[b * 3] - pos[a * 3],
        e1y = pos[b * 3 + 1] - pos[a * 3 + 1],
        e1z = pos[b * 3 + 2] - pos[a * 3 + 2];
      const e2x = pos[c * 3] - pos[a * 3],
        e2y = pos[c * 3 + 1] - pos[a * 3 + 1],
        e2z = pos[c * 3 + 2] - pos[a * 3 + 2];
      const du1 = uv[b * 2] - uv[a * 2],
        dv1 = uv[b * 2 + 1] - uv[a * 2 + 1];
      const du2 = uv[c * 2] - uv[a * 2],
        dv2 = uv[c * 2 + 1] - uv[a * 2 + 1];
      const r = du1 * dv2 - du2 * dv1,
        f = r !== 0 ? 1 / r : 0;
      const tx = (dv2 * e1x - dv1 * e2x) * f,
        ty = (dv2 * e1y - dv1 * e2y) * f,
        tz = (dv2 * e1z - dv1 * e2z) * f;
      for (const vi of [a, b, c]) {
        acc[vi * 3] += tx;
        acc[vi * 3 + 1] += ty;
        acc[vi * 3 + 2] += tz;
      }
    }
    const out = new Float32Array(n * 4);
    for (let i = 0; i < n; i++) {
      let tx = acc[i * 3],
        ty = acc[i * 3 + 1],
        tz = acc[i * 3 + 2];
      const nx = nor[i * 3],
        ny = nor[i * 3 + 1],
        nz = nor[i * 3 + 2];
      const d = nx * tx + ny * ty + nz * tz;
      tx -= nx * d;
      ty -= ny * d;
      tz -= nz * d;
      const len = Math.hypot(tx, ty, tz) || 1;
      out[i * 4] = tx / len;
      out[i * 4 + 1] = ty / len;
      out[i * 4 + 2] = tz / len;
      out[i * 4 + 3] = 1;
    }
    mesh.setVerticesData(BABYLON.VertexBuffer.TangentKind, out, false);
  }

  function stoneTexture(scene) {
    const S = 128;
    const dt = new BABYLON.DynamicTexture("stoneTex", S, scene, false);
    const ctx = dt.getContext();
    ctx.fillStyle = "rgb(122,119,112)";
    ctx.fillRect(0, 0, S, S);
    for (let i = 0; i < 520; i++) {
      const x = Math.random() * S,
        y = Math.random() * S,
        r = 3 + Math.random() * 7;
      const v = 88 + Math.random() * 74;
      ctx.fillStyle = `rgba(${v | 0},${(v - 4) | 0},${(v - 11) | 0},0.5)`;
      ctx.beginPath();
      ctx.ellipse(x, y, r, r * 0.72, Math.random() * 3, 0, 7);
      ctx.fill();
    }
    ctx.strokeStyle = "rgba(68,66,62,0.5)";
    ctx.lineWidth = 1.5;
    for (let i = 0; i < 42; i++) {
      let x = Math.random() * S,
        y = Math.random() * S;
      ctx.beginPath();
      ctx.moveTo(x, y);
      for (let k = 0; k < 4; k++) {
        x += (Math.random() - 0.5) * 22;
        y += (Math.random() - 0.5) * 22;
        ctx.lineTo(x, y);
      }
      ctx.stroke();
    }
    dt.update();
    dt.updateSamplingMode(BABYLON.Texture.NEAREST_SAMPLINGMODE);
    dt.wrapU = dt.wrapV = BABYLON.Texture.WRAP_ADDRESSMODE;
    return dt;
  }

  // ---- main ------------------------------------------------------------------
  async function start() {
    // Preload the handwriting font so canvas-baked text (door signs, CIGS panel,
    // skins) renders in it — canvas ignores @font-face until the face is loaded.
    if (document.fonts?.load)
      await document.fonts.load('bold 40px "DrawvidHand"').catch(() => {});
    const canvas = document.getElementById("renderCanvas");
    const engine = new BABYLON.Engine(canvas, true, {
      preserveDrawingBuffer: true,
      stencil: true,
    });
    const scene = new BABYLON.Scene(engine);
    scene.clearColor = new BABYLON.Color4(0, 0, 0, 1); // black void — the room floats
    scene.ambientColor = new BABYLON.Color3(1, 1, 1);

    const hemi = new BABYLON.HemisphericLight(
      "hemi",
      new BABYLON.Vector3(0.25, 1, 0.15),
      scene,
    );
    hemi.intensity = 0.26; // low base fill — the wall sconces do the work now
    hemi.diffuse = new BABYLON.Color3(0.82, 0.84, 0.95);
    hemi.groundColor = new BABYLON.Color3(0.22, 0.2, 0.24);
    const keyLight = new BABYLON.DirectionalLight(
      "key",
      new BABYLON.Vector3(-0.5, -1.05, 0.4),
      scene,
    );
    keyLight.position = new BABYLON.Vector3(9, 26, -9);
    keyLight.intensity = 0.5; // dimmed so it no longer reads as an overhead source (kept for the contact shadow)
    keyLight.diffuse = new BABYLON.Color3(1.0, 0.95, 0.84);
    const shadow = new BABYLON.ShadowGenerator(1024, keyLight);
    // Poisson soft shadows — PCF renders nothing in this Babylon build; Poisson
    // gives a soft, moody contact shadow that actually shows on the carpet.
    shadow.usePoissonSampling = true;
    shadow.setDarkness(0.38);
    shadow.bias = 0.006;
    let fireLight = null; // warm flicker light at the hearth (set after the room loads)

    const CAM_BETA = 1.12; // lower angle, close to the original golf-style camera
    const camera = new BABYLON.ArcRotateCamera(
      "cam",
      -Math.PI / 2,
      CAM_BETA,
      16,
      new BABYLON.Vector3(0, 1, 0),
      scene,
    );
    camera.attachControl(canvas, true);
    camera.lowerRadiusLimit = 12;
    camera.upperRadiusLimit = 20;
    camera.lowerBetaLimit = CAM_BETA;
    camera.upperBetaLimit = CAM_BETA;
    camera.wheelPrecision = 18;
    camera.panningSensibility = 0; // no panning; target follows the avatar
    camera.fov = 0.72;
    camera.maxZ = 220; // small room; a modest far clip is plenty

    // -- clubhouse building --
    const woodTex = woodTexture(scene);
    const shagTex = shagTexture(scene);
    const stoneTex = stoneTexture(scene);
    const woodMat = flatMat("wood", scene, woodTex);
    woodMat.emissiveColor = new BABYLON.Color3(0.13, 0.11, 0.07);
    // wood-grain bump: horizontal grain ridges (varies down the grain, +a little jitter)
    woodMat.bumpTexture = normalMap(
      scene,
      "woodBump",
      128,
      (x, y) =>
        0.5 +
        (Math.sin(y * 0.26) * 0.5 + Math.sin(y * 0.07 + 1) * 0.5) * 0.4 +
        (Math.random() - 0.5) * 0.08,
      2.6,
    );
    woodMat.bumpTexture.level = 0.8;
    const shagMat = flatMat("shag", scene, shagTex);
    shagMat.bumpTexture = normalMap(
      scene,
      "shagBump",
      96,
      () => Math.random(),
      0.9,
    );
    shagMat.bumpTexture.level = 0.7;
    const stoneMat = flatMat("stone", scene, stoneTex);
    stoneMat.emissiveColor = new BABYLON.Color3(0.15, 0.15, 0.15);
    const creamMat = colorMat(
      "cream",
      scene,
      new BABYLON.Color3(0.86, 0.75, 0.48),
    );
    const doorWoodMat = colorMat(
      "doorWood",
      scene,
      new BABYLON.Color3(0.4, 0.24, 0.11),
    );
    const brassMat = colorMat(
      "brass",
      scene,
      new BABYLON.Color3(0.82, 0.63, 0.2),
    );
    const feltMat = colorMat(
      "felt",
      scene,
      new BABYLON.Color3(0.1, 0.42, 0.17),
    );
    const metalMat = colorMat(
      "metal",
      scene,
      new BABYLON.Color3(0.8, 0.82, 0.85),
    );
    const leatherMat = colorMat(
      "leather",
      scene,
      new BABYLON.Color3(0.34, 0.08, 0.09),
    );
    const darkMat = colorMat(
      "dark",
      scene,
      new BABYLON.Color3(0.05, 0.05, 0.06),
    );
    const vipFloorMat = colorMat(
      "floorVip",
      scene,
      new BABYLON.Color3(0.17, 0.07, 0.07),
    );
    const fireRedMat = colorMat(
      "fireRed",
      scene,
      new BABYLON.Color3(0.85, 0.12, 0.05),
    );
    fireRedMat.emissiveColor = new BABYLON.Color3(0.9, 0.14, 0.05);
    const fireOrangeMat = colorMat(
      "fireOrange",
      scene,
      new BABYLON.Color3(1.0, 0.42, 0.06),
    );
    fireOrangeMat.emissiveColor = new BABYLON.Color3(1.0, 0.44, 0.07);
    const fireYellowMat = colorMat(
      "fireYellow",
      scene,
      new BABYLON.Color3(1.0, 0.8, 0.2),
    );
    fireYellowMat.emissiveColor = new BABYLON.Color3(1.0, 0.82, 0.26);
    const flameMeshes = [];

    // Inward normal of the axis-aligned wall nearest `pos` (so signs/windows face
    // straight off their wall, not diagonally toward the room centre).
    function wallInward(pos) {
      if (Math.abs(pos.x) > Math.abs(pos.z))
        return new BABYLON.Vector3(-Math.sign(pos.x), 0, 0);
      return new BABYLON.Vector3(0, 0, -Math.sign(pos.z));
    }

    // Door sign: dark-brown block text on a wood plaque, mounted flush on the
    // wall above the door, facing into the room (no billboard).
    function makeDoorLabel(text, pos) {
      const W = 256,
        Hh = 80;
      const dt = new BABYLON.DynamicTexture(
        "lbl_" + text,
        { width: W, height: Hh },
        scene,
        false,
      );
      const ctx = dt.getContext();
      ctx.clearRect(0, 0, W, Hh);
      ctx.fillStyle = "#6b4a24";
      ctx.fillRect(0, 0, W, Hh);
      ctx.fillStyle = "#5a3d1e";
      ctx.fillRect(0, 0, W, 4);
      ctx.fillRect(0, Hh - 4, W, 4);
      ctx.strokeStyle = "rgba(58,36,15,0.45)";
      ctx.lineWidth = 1;
      for (let gy = 9; gy < Hh; gy += 8) {
        ctx.beginPath();
        ctx.moveTo(0, gy);
        ctx.lineTo(W, gy);
        ctx.stroke();
      }
      ctx.fillStyle = "#2e8b48";
      ctx.fillRect(13, 13, W - 26, Hh - 26);
      ctx.strokeStyle = "rgba(30,20,8,0.7)";
      ctx.lineWidth = 2;
      ctx.strokeRect(13, 13, W - 26, Hh - 26);
      ctx.fillStyle = "#ffffff";
      let fs = 52; // shrink the font so longer labels (e.g. MEMBERS LOUNGE) fit the plaque
      ctx.font =
        "bold " + fs + "px 'DrawvidHand', 'Comic Sans MS', cursive, sans-serif";
      while (ctx.measureText(text).width > W - 30 && fs > 14) {
        fs -= 2;
        ctx.font =
          "bold " +
          fs +
          "px 'DrawvidHand', 'Comic Sans MS', cursive, sans-serif";
      }
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(text, W / 2, Hh / 2 + 3);
      dt.update();
      dt.hasAlpha = true;
      dt.updateSamplingMode(BABYLON.Texture.NEAREST_SAMPLINGMODE);
      const mat = new BABYLON.StandardMaterial("lblMat_" + text, scene);
      mat.diffuseTexture = dt;
      mat.diffuseTexture.hasAlpha = true;
      mat.useAlphaFromDiffuseTexture = true;
      mat.emissiveTexture = dt; // self-lit so plaque + text read at true color
      mat.emissiveColor = new BABYLON.Color3(1, 1, 1);
      mat.diffuseColor = new BABYLON.Color3(0, 0, 0);
      mat.disableLighting = true;
      mat.specularColor = new BABYLON.Color3(0, 0, 0);
      mat.backFaceCulling = false;
      const plane = BABYLON.MeshBuilder.CreatePlane(
        "lblPlane_" + text,
        { width: 2.4, height: 0.55 },
        scene,
      );
      plane.material = mat;
      const inward = wallInward(pos); // straight off the wall (fixes off-centre doors like VIP)
      // raised into the gap between the door-frame top (~2.9) and the wall top
      // (3.6) so the plaque sits above the frame, not overlapping it
      plane.position.set(
        pos.x + inward.x * 0.16,
        pos.y + 1.96,
        pos.z + inward.z * 0.16,
      );
      plane.rotation.y = Math.atan2(inward.x, inward.z) + Math.PI; // face the room (text not mirrored)
      plane.isPickable = false;
    }

    let spawn = new BABYLON.Vector3(0, 0, 0);
    const doors = []; // {kind, mesh, pos}
    const colliders = []; // furniture XZ boxes {minX,maxX,minZ,maxZ}
    const dispensers = []; // {kind, grabPos, standPos, radius} — walk-up cig machine + beer conveyor
    const PICKUP_R = 2.2; // how close you must be to grab from a dispenser
    const clubMeshes = new Set(); // building meshes (for camera-occlusion fade)
    let floorTopY = 0;
    let bounds = { minX: -10, maxX: 10, minZ: -10, maxZ: 10 };

    const room = await Shared.loadModel(ROOM_CFG.glb, scene, {
      version: ASSET_V,
    });
    const DOOR_KINDS = ["course", "range", "vip", "main", "locker"];
    for (const mesh of room.meshes) {
      if (!mesh.name || mesh.name === "__root__") continue;
      mesh.computeWorldMatrix(true);
      const n = mesh.name;
      // Relocate the lounge table into the corner between the fireplace (+Z wall)
      // and the range door (-X wall). Done at runtime (like the bar glasses/bottles)
      // so it applies to the shipped GLB without a Blender rebuild; the build script
      // (clubhouse_build.py) carries the same corner as the source of truth. Runs
      // before the shadow caster + XZ collider box below, so both track the new spot.
      if (n === "wood_table" || n === "wood_tableleg") {
        const p = mesh.getAbsolutePosition();
        mesh.setAbsolutePosition(new BABYLON.Vector3(-9.5, p.y, 9.5));
        mesh.computeWorldMatrix(true);
      }
      if (n.startsWith("marker_spawn")) {
        spawn = mesh.getAbsolutePosition().clone();
        mesh.setEnabled(false);
      } else if (n.startsWith("door_")) {
        const kind = DOOR_KINDS.find((k) => n.startsWith("door_" + k));
        const cfg = kind && ROOM_CFG.doors[kind];
        if (cfg) {
          mesh.material = n.includes("knob") ? brassMat : doorWoodMat;
          clubMeshes.add(mesh);
          shadow.addShadowCaster(mesh);
          mesh.receiveShadows = true;
          if (n === "door_" + kind) {
            // the main slab (not the panels/knob)
            const pos = mesh.getAbsolutePosition().clone();
            doors.push({ kind, mesh, pos, url: cfg.url, label: cfg.label });
            makeDoorLabel(cfg.label, pos);
          }
        } else {
          mesh.material = doorWoodMat;
        }
      } else if (n.startsWith("carpet_floor") || n.startsWith("floor_")) {
        mesh.material = n.startsWith("floor_vip") ? vipFloorMat : shagMat;
        mesh.receiveShadows = true;
        const bb = mesh.getBoundingInfo().boundingBox;
        floorTopY = bb.maximumWorld.y;
        bounds = {
          minX: bb.minimumWorld.x + 1.5,
          maxX: bb.maximumWorld.x - 1.5,
          minZ: bb.minimumWorld.z + 1.5,
          maxZ: bb.maximumWorld.z - 1.5,
        };
      } else {
        // props by material prefix (wood_* is the default)
        if (n.startsWith("cream_field"))
          mesh.material = woodMat; // wood wainscot panels
        else if (n.startsWith("cream_")) mesh.material = creamMat;
        else if (n.startsWith("trim_"))
          mesh.material = woodMat; // wood wainscot molding
        else if (n.startsWith("stone_")) mesh.material = stoneMat;
        else if (n.startsWith("felt_")) mesh.material = feltMat;
        else if (n.startsWith("metal_")) mesh.material = metalMat;
        else if (n.startsWith("leather_")) mesh.material = leatherMat;
        else if (n.startsWith("fire_")) {
          mesh.material = n.startsWith("fire_red")
            ? fireRedMat
            : n.startsWith("fire_orange")
              ? fireOrangeMat
              : fireYellowMat;
          flameMeshes.push(mesh);
        } else if (n.startsWith("dark_")) mesh.material = darkMat;
        else mesh.material = woodMat;
        mesh.receiveShadows = true;
        // walls + furniture cast shadows (skip tiny trim / logs / flames)
        if (
          /^(cream_wall|wood_(bar|bartop|table|fireplace|pooltable|cardtable|cardleg|barcart)|stone_fireplace|metal_fridge|leather_couch|wood_frame)/.test(
            n,
          )
        ) {
          shadow.addShadowCaster(mesh);
        }
        // walls + wainscot molding + door frames fade when they occlude the character
        if (/^(cream_wall|cream_field|trim_|wood_frame)/.test(n))
          clubMeshes.add(mesh);
        // floor-standing furniture gets a simple XZ collision box
        if (
          /^(wood_(bar|table|fireplace|pooltable|cardtable|cardleg|barcart)|metal_fridge|leather_couch|stone_fireplace)/.test(
            n,
          )
        ) {
          const bb = mesh.getBoundingInfo().boundingBox;
          colliders.push({
            minX: bb.minimumWorld.x,
            maxX: bb.maximumWorld.x,
            minZ: bb.minimumWorld.z,
            maxZ: bb.maximumWorld.z,
          });
        }
      }
    }
    // give the wood + shag meshes tangents so their bump maps light correctly
    for (const mesh of room.meshes) {
      if (mesh.material === woodMat || mesh.material === shagMat)
        computeTangents(mesh);
    }

    // Door-aware arrival: if we walked in through a door (rather than a cold
    // load), spawn just inside it facing into the room. The page we left
    // stamped its id via Shared.roomFX.leave({from}); ids double as door kinds
    // (main/vip/locker/course/range), so the door that leads BACK there is the
    // one we came through — any new room/door pair inherits this for free.
    let arriveYaw = null;
    const fromDoor = doors.find((d) => d.kind === Shared.roomFX.arrivedFrom);
    if (fromDoor) {
      const inward = wallInward(fromDoor.pos);
      spawn = fromDoor.pos.add(inward.scale(ARRIVE_DIST));
      arriveYaw = Math.atan2(inward.x, inward.z); // face away from the door
    }
    // Sprite hearth fire: hand-drawn frames (assets/fire) swapped on flat planes
    // instead of the 3D cones — one big central + two smaller flanking to fill the
    // recess without stretching. Each plane's bottom sits on the log tops (= the
    // cones' base). Planes are double-sided + emissive so the fire glows.
    const fireSprites = [];
    if (flameMeshes.length) {
      let mn = new BABYLON.Vector3(1e9, 1e9, 1e9);
      let mx = new BABYLON.Vector3(-1e9, -1e9, -1e9);
      for (const f of flameMeshes) {
        f.computeWorldMatrix(true);
        const b = f.getBoundingInfo().boundingBox;
        mn = BABYLON.Vector3.Minimize(mn, b.minimumWorld);
        mx = BABYLON.Vector3.Maximize(mx, b.maximumWorld);
        f.setEnabled(false); // the cones are replaced by the sprites
      }
      const cx = (mn.x + mx.x) / 2;
      const cz = (mn.z + mx.z) / 2;
      const baseY = mn.y; // log tops — bottom of every sprite rests here
      const W = mx.x - mn.x; // recess width

      const frames = [1, 2, 3, 4].map((n) => {
        const t = new BABYLON.Texture(
          `assets/fire/fire-${n}.png?v=` + ASSET_V,
          scene,
        );
        t.hasAlpha = true;
        return t;
      });
      const makeFire = (offX, size) => {
        const p = BABYLON.MeshBuilder.CreatePlane(
          "hearthFire",
          { size },
          scene,
        );
        p.position.set(cx + offX, baseY + size / 2, cz);
        p.isPickable = false;
        p.receiveShadows = false;
        const m = new BABYLON.StandardMaterial("fireSpriteMat", scene);
        m.diffuseTexture = frames[0];
        m.emissiveTexture = frames[0];
        m.emissiveColor = new BABYLON.Color3(1, 1, 1);
        m.diffuseColor = new BABYLON.Color3(0, 0, 0);
        m.specularColor = new BABYLON.Color3(0, 0, 0);
        m.disableLighting = true;
        m.backFaceCulling = false; // faces the room from either side
        m.useAlphaFromDiffuseTexture = true;
        m.transparencyMode = BABYLON.Material.MATERIAL_ALPHABLEND;
        p.material = m;
        fireSprites.push({
          mat: m,
          frames,
          idx: Math.floor(Math.random() * frames.length),
          t: 0,
          next: 0, // seconds to hold the current frame (set on first tick)
        });
      };
      makeFire(0, W * 0.64); // big central flame
      makeFire(-W * 0.34, W * 0.44); // smaller left flank
      makeFire(W * 0.34, W * 0.44); // smaller right flank

      const fp = flameMeshes[0].getAbsolutePosition();
      fireLight = new BABYLON.PointLight(
        "fireLight",
        new BABYLON.Vector3(fp.x, fp.y + 0.5, fp.z),
        scene,
      );
      fireLight.diffuse = new BABYLON.Color3(1.0, 0.5, 0.16);
      fireLight.specular = new BABYLON.Color3(0, 0, 0);
      fireLight.intensity = 0.9;
      fireLight.range = 17;
    }

    const avatarY = floorTopY + AV_SCALE * 0.84; // model half-height -> ball bottom sits on the floor

    // ---- windows: framed panes flanking the COURSE/RANGE doors, showing a
    // generic rolling-hills golf landscape (blue sky, clouds, green hills, a
    // pond) painted to match the course palette — two evenly spaced per door ----
    const WIN_CFGS = [
      {
        skyTop: "#5fb4e6",
        clouds: [
          [54, 30, 11],
          [182, 22, 14],
          [120, 47, 8],
        ],
        hills: [
          [78, 9, 0.0, "#3f7d2c"],
          [92, 12, 2.1, "#569f31"],
          [108, 8, 4.0, "#74c23c"],
        ],
        ponds: [[150, 117, 46, 11]],
        flags: [[70, 88]],
      },
      {
        skyTop: "#63b7e8",
        clouds: [
          [40, 26, 13],
          [112, 20, 10],
          [202, 34, 12],
          [150, 50, 7],
        ],
        hills: [
          [74, 7, 1.0, "#3a7629"],
          [88, 10, 3.4, "#4f962e"],
          [104, 10, 5.5, "#6fbd39"],
        ],
        ponds: [[126, 121, 86, 13]],
        flags: [[206, 98]],
      },
      {
        skyTop: "#5ab0e4",
        clouds: [
          [80, 24, 12],
          [192, 30, 11],
        ],
        hills: [
          [70, 12, 0.6, "#3d7a2b"],
          [86, 15, 2.8, "#549c30"],
          [104, 11, 4.6, "#72c03b"],
        ],
        ponds: [[54, 119, 32, 9]],
        trees: [
          [150, 98, 10],
          [172, 102, 8],
          [131, 103, 7],
        ],
      },
      {
        skyTop: "#6bbcea",
        clouds: [
          [50, 20, 10],
          [130, 31, 13],
          [212, 24, 11],
        ],
        hills: [
          [76, 8, 1.6, "#40802d"],
          [90, 11, 3.9, "#579f32"],
          [106, 9, 5.9, "#75c33d"],
        ],
        ponds: [[198, 119, 38, 10]],
        bunkers: [[96, 111, 26, 8]],
        flags: [[120, 94]],
      },
    ];
    function golfSceneTexture(v) {
      const cfg = WIN_CFGS[v];
      const W = 256,
        Hh = 128;
      const dt = new BABYLON.DynamicTexture(
        "golfWin" + v,
        { width: W, height: Hh },
        scene,
        false,
      );
      const ctx = dt.getContext();
      const sky = ctx.createLinearGradient(0, 0, 0, Hh);
      sky.addColorStop(0, cfg.skyTop);
      sky.addColorStop(0.6, "#bfe6f7");
      ctx.fillStyle = sky;
      ctx.fillRect(0, 0, W, Hh);
      ctx.fillStyle = "rgba(255,255,255,0.95)";
      for (const [cx, cy, s] of cfg.clouds) {
        ctx.beginPath();
        ctx.arc(cx, cy, s, 0, 7);
        ctx.arc(cx + s, cy + s * 0.25, s * 0.8, 0, 7);
        ctx.arc(cx - s, cy + s * 0.25, s * 0.8, 0, 7);
        ctx.arc(cx + s * 0.4, cy - s * 0.4, s * 0.7, 0, 7);
        ctx.fill();
      }
      for (const [
        base,
        amp,
        phase,
        color,
      ] of /** @type {Array<[number, number, number, string]>} */ (cfg.hills)) {
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.moveTo(0, Hh);
        for (let x = 0; x <= W; x += 6)
          ctx.lineTo(x, base - Math.sin(x / 38 + phase) * amp);
        ctx.lineTo(W, Hh);
        ctx.closePath();
        ctx.fill();
      }
      for (const [x, y, rx, ry] of cfg.bunkers || []) {
        ctx.fillStyle = "#e6d6a2";
        ctx.beginPath();
        ctx.ellipse(x, y, rx, ry, 0, 0, 7);
        ctx.fill();
      }
      for (const [x, y, rx, ry] of cfg.ponds || []) {
        ctx.fillStyle = "#2379db";
        ctx.beginPath();
        ctx.ellipse(x, y, rx, ry, 0, 0, 7);
        ctx.fill();
        ctx.fillStyle = "rgba(255,255,255,0.28)";
        ctx.beginPath();
        ctx.ellipse(
          x - rx * 0.28,
          y - ry * 0.3,
          rx * 0.32,
          Math.max(2, ry * 0.3),
          0,
          0,
          7,
        );
        ctx.fill();
      }
      for (const [x, gy, s] of cfg.trees || []) {
        ctx.fillStyle = "#5b3a1e";
        ctx.fillRect(x - 1, gy - s, 2, s + 1);
        ctx.fillStyle = "#245e1c";
        ctx.beginPath();
        ctx.arc(x, gy - s, s * 0.95, 0, 7);
        ctx.fill();
      }
      for (const [x, gy] of cfg.flags || []) {
        ctx.strokeStyle = "#eaeaea";
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(x, gy);
        ctx.lineTo(x, gy - 14);
        ctx.stroke();
        ctx.fillStyle = "#d3202a";
        ctx.beginPath();
        ctx.moveTo(x, gy - 14);
        ctx.lineTo(x + 9, gy - 11);
        ctx.lineTo(x, gy - 8);
        ctx.closePath();
        ctx.fill();
      }
      dt.update();
      dt.updateSamplingMode(BABYLON.Texture.NEAREST_SAMPLINGMODE);
      return dt;
    }
    // one unlit material per variant (needs BOTH diffuse & emissive textures or
    // disableLighting renders it flat white)
    function makeWinMat(v) {
      const tex = golfSceneTexture(v);
      const m = new BABYLON.StandardMaterial("winPaneMat" + v, scene);
      m.diffuseTexture = tex;
      m.emissiveTexture = tex;
      m.emissiveColor = new BABYLON.Color3(1, 1, 1);
      m.diffuseColor = new BABYLON.Color3(0, 0, 0);
      m.disableLighting = true;
      m.specularColor = new BABYLON.Color3(0, 0, 0);
      m.backFaceCulling = false;
      return m;
    }
    const winMats = ROOM === "main" ? [0, 1, 2, 3].map(makeWinMat) : [];
    const parallaxWindows = []; // {tex, center, along} — vista slides with the camera
    // a framed window pane `off` units along the wall from `door`
    function makeWindow(door, off, mat) {
      const inward = wallInward(door.pos);
      const along = new BABYLON.Vector3(inward.z, 0, -inward.x); // along the wall
      const wy = 2.5;
      const wx = door.pos.x + along.x * off,
        wz = door.pos.z + along.z * off;
      const roty = Math.atan2(inward.x, inward.z) + Math.PI; // face the room
      // mount snug on the wall (small relief; not floating)
      const frame = BABYLON.MeshBuilder.CreateBox(
        "winFrame",
        { width: 3.1, height: 1.7, depth: 0.14 },
        scene,
      );
      frame.material = woodMat;
      computeTangents(frame); // ...or the wood bump map renders black
      frame.isPickable = false;
      frame.receiveShadows = true;
      frame.position.set(wx + inward.x * 0.15, wy, wz + inward.z * 0.15);
      frame.rotation.y = roty;
      const pane = BABYLON.MeshBuilder.CreatePlane(
        "winPane",
        { width: 2.7, height: 1.32 },
        scene,
      );
      pane.material = mat;
      pane.isPickable = false;
      pane.position.set(wx + inward.x * 0.24, wy, wz + inward.z * 0.24);
      pane.rotation.y = roty;
      // show only part of the vista so it can slide behind the frame for parallax
      mat.diffuseTexture.uScale = 0.82;
      mat.diffuseTexture.wrapU = BABYLON.Texture.WRAP_ADDRESSMODE;
      parallaxWindows.push({
        tex: mat.diffuseTexture, // diffuse + emissive share one texture object
        center: new BABYLON.Vector3(wx, wy, wz),
        along,
      });
      const mp = new BABYLON.Vector3(
        wx + inward.x * 0.29,
        wy,
        wz + inward.z * 0.29,
      );
      const mv = BABYLON.MeshBuilder.CreateBox(
        "winMuntV",
        { width: 0.07, height: 1.32, depth: 0.05 },
        scene,
      );
      mv.material = woodMat;
      computeTangents(mv);
      mv.isPickable = false;
      mv.position.copyFrom(mp);
      mv.rotation.y = roty;
      const mh = BABYLON.MeshBuilder.CreateBox(
        "winMuntH",
        { width: 2.7, height: 0.07, depth: 0.05 },
        scene,
      );
      mh.material = woodMat;
      computeTangents(mh);
      mh.isPickable = false;
      mh.position.copyFrom(mp);
      mh.rotation.y = roty;
    }
    if (ROOM === "main") {
      let wi = 0;
      for (const d of doors) {
        if (d.kind === "course" || d.kind === "range") {
          makeWindow(d, 3.7, winMats[wi++ % winMats.length]);
          makeWindow(d, -3.7, winMats[wi++ % winMats.length]);
        }
      }
    }

    // -- gball avatar template (loaded once, instanced for local + remotes) --
    const gballContainer = await Shared.loadModel("gball.glb", scene, {
      container: true,
      version: ASSET_V,
    });
    const cybeerContainer = await Shared.loadModel("cybeer.glb", scene, {
      container: true,
      version: ASSET_V,
    });
    const cigContainer = await Shared.loadModel("cigarette.glb", scene, {
      container: true,
      version: ASSET_V,
    });

    function spawnAvatar() {
      // clone (don't hardware-instance) so the eyelids morph survives per-avatar
      const inst = gballContainer.instantiateModelsToScene(
        (name) => name,
        false,
        { doNotInstantiate: true },
      );
      for (const g of inst.animationGroups) g.stop(); // none expected; just in case
      const wrapper = new BABYLON.TransformNode("avatar", scene); // locomotion
      wrapper.scaling.setAll(AV_SCALE);
      const bob = new BABYLON.TransformNode("bob", scene); // carries the bounce
      bob.parent = wrapper;
      let faceMesh = null;
      let gballMesh = null;
      for (const root of inst.rootNodes) {
        root.parent = bob;
        for (const cm of root.getChildMeshes(false)) {
          shadow.addShadowCaster(cm);
          cm.receiveShadows = true;
          if (cm.name && /face/i.test(cm.name)) faceMesh = cm;
          if (cm.name && /gball/i.test(cm.name) && cm.material) gballMesh = cm;
        }
      }
      const hand = new BABYLON.TransformNode("hand", scene); // holds a beer / cigarette
      hand.parent = wrapper;
      const av = {
        wrapper,
        bob,
        hand,
        holdType: "none",
        item: null,
        current: "bounce",
        animTime: Math.random() * 3,
      };
      if (faceMesh && faceMesh.material) {
        av.faceMat = faceMesh.material.clone("faceMat"); // own material -> per-avatar expressions
        faceMesh.material = av.faceMat;
        av.faceDefault = av.faceMat.albedoTexture || null;
        av.faceOrigDefault = av.faceDefault; // kept: a custom face replaces faceDefault
      }
      av.gballMesh = gballMesh; // the ball body (for locker-room skin swaps)
      av.curFace = "none";
      setupBlink(av, inst);
      return av;
    }

    // Periodic eyelid blink (the gball's "Closed" morph), independent per avatar
    // (cloneManager desyncs each avatar's blink). Shared setup lives in balls.js.
    function setupBlink(av, inst) {
      const meshes = [];
      for (const rn of inst.rootNodes) {
        meshes.push(rn);
        for (const c of rn.getChildMeshes(false)) meshes.push(c);
      }
      const b = Balls.initBlink(meshes, { cloneManager: true });
      if (!b) return;
      av.blinkMgr = b.mgr;
      av.blinkIdx = b.idx;
      av.blink = b.state;
    }

    function updateBlink(av, dt) {
      if (!av.blinkMgr || av.blinkIdx == null || av.blinkIdx < 0 || !av.blink)
        return;
      const tgt = av.blinkMgr.getTarget(av.blinkIdx);
      if (tgt) tgt.influence = Balls.updateBlink(av.blink, dt);
    }

    // Procedural bounce/walk: the same squash-and-stretch feel derived from
    // Apple Royale's idle/hop, applied to a child node so gball.glb (with its
    // dimple texture + pupils) is never re-exported/degraded.
    function setClip(av, type) {
      av.current = type;
    }
    function animateAvatar(av, dt) {
      const type = av.current || "bounce";
      av.animTime += dt * (type === "walk" ? 1.6 : 0.8); // cycles / second
      const phase = av.animTime - Math.floor(av.animTime);
      let y, sxy, sz;
      if (type === "walk") {
        const s = sampleWalk(phase);
        y = s.y;
        sxy = s.sxy;
        sz = s.sz;
      } else {
        const u = 0.5 - 0.5 * Math.cos(2 * Math.PI * phase); // smooth 0→1→0 bob
        y = 0.12 * u;
        sxy = 1 - 0.015 * u;
        sz = 1 + 0.03 * u;
      }
      av.bob.position.y = y;
      av.bob.scaling.set(sxy, sz, sxy);
    }

    // ---- beer / cigarette / smoke ------------------------------------------
    // Held items are tiny meshes parented to the avatar's `hand` node (the ball
    // has no arms, so we just float the item at mouth height). One synced value
    // per player, `holdType`, drives what every client renders on that avatar.
    const HOLD_TYPES = ["none", "beer", "cig"]; // index == wire code
    const CEIL_Y = 3.3; // invisible ceiling the smoke pools under
    const HAND_LOCAL = new BABYLON.Vector3(0.24, -0.05, 1.02); // wrapper-local: front, just past the ball surface at mouth height

    const smokeTex = new BABYLON.Texture(
      "assets/smokesheet.png?v=" + ASSET_V,
      scene,
      false,
      false,
      BABYLON.Texture.NEAREST_SAMPLINGMODE,
    );
    const beerMat = new BABYLON.StandardMaterial("beerMat", scene);
    beerMat.diffuseColor = new BABYLON.Color3(0.94, 0.62, 0.1);
    beerMat.emissiveColor = new BABYLON.Color3(0.58, 0.34, 0.03);
    beerMat.specularColor = new BABYLON.Color3(0, 0, 0);
    const emberMat = new BABYLON.StandardMaterial("emberMat", scene);
    emberMat.diffuseColor = new BABYLON.Color3(1, 0.3, 0.05);
    emberMat.emissiveColor = new BABYLON.Color3(1, 0.32, 0.03);
    emberMat.specularColor = new BABYLON.Color3(0, 0, 0);
    let anyCig = 0; // >0 while at least one cigarette exists (drives ember flicker)

    // face-swap textures (the gball reuses the golf game's face set): a buck-toothed
    // open mouth while drinking, an "O" mouth while smoking.
    function faceTex(file) {
      return Balls.faceTexture(scene, file);
    }
    const faceDrinkTex = faceTex("elated.png"); // open mouth + buck teeth
    const faceSmokeTex = faceTex("o.png"); // round "O" mouth
    function setFace(av, name) {
      if (!av.faceMat) return;
      av.faceMat.albedoTexture =
        name === "o"
          ? faceSmokeTex
          : name === "drink"
            ? faceDrinkTex
            : av.faceDefault;
    }

    // ---- locker-room customization (hat / ball skin / drawn face) ----------
    // Applied to self (from localStorage) and remotes (from snapshot + face
    // broadcasts). Hats and skin materials/textures are built fresh PER AVATAR:
    // the remote cull path disposes them with the wrapper, so nothing here may
    // be shared or cached across avatars.
    function applyAvatarStyle(av, style) {
      const st = BallsStyle.normalizeStyle(style);
      if (av.styleHat !== st.hat) {
        av.styleHat = st.hat;
        if (av.hatNode) av.hatNode.dispose(false, true);
        av.hatNode = BallsStyle.buildHat(scene, st.hat);
        if (av.hatNode) {
          av.hatNode.parent = av.bob; // rides the bounce squash like the ball
          for (const m of av.hatNode.getChildMeshes(false)) {
            shadow.addShadowCaster(m);
            m.isPickable = false;
          }
        }
      }
      if (
        (av.styleSkin !== st.skin || av.styleSkinImg !== st.skinImg) &&
        av.gballMesh
      ) {
        av.styleSkin = st.skin;
        av.styleSkinImg = st.skinImg;
        BallsStyle.applySkin(scene, [av.gballMesh], st.skin, st.skinImg);
      }
      // custom face becomes the avatar's resting faceDefault, so the sip/drag
      // overrides in updateHold() still swap it out and restore it untouched
      if (av.styleFaceData !== st.face) {
        av.styleFaceData = st.face;
        if (av.customFaceTex) av.customFaceTex.dispose();
        av.customFaceTex = st.face
          ? BallsStyle.faceTextureFromDataURL(scene, st.face)
          : null;
        av.faceDefault = av.customFaceTex || av.faceOrigDefault || null;
        setFace(av, av.curFace); // refresh unless a sip/drag face is showing
      }
    }

    // world-space smoke: rise buoyantly, then pool + spread under the ceiling
    function smokeUpdate(particles) {
      const dt = this._scaledUpdateSpeed;
      for (let i = 0; i < particles.length; i++) {
        const p = particles[i];
        p.age += dt;
        if (p.age >= p.lifeTime) {
          this.recycleParticle(p);
          i--;
          continue;
        }
        const fade = Math.max(0, 1 - p.age / p.lifeTime);
        p.color.a = Math.pow(fade, 0.6) * 0.5;
        p.size = 0.36 + (1 - fade) * 3.3; // ~3x bigger so the smoke is clearly visible; grows as it ages
        if (p.position.y >= CEIL_Y) {
          // hit the invisible ceiling -> spread
          p.direction.x = (Math.random() - 0.5) * 0.5;
          p.direction.y = -0.03 + Math.random() * 0.01;
          p.direction.z = (Math.random() - 0.5) * 0.5;
        } else {
          p.direction.x *= 1 - dt * 0.4;
          p.direction.z *= 1 - dt * 0.4;
          p.direction.y += dt * 0.25;
        }
        p.position.x += p.direction.x * dt;
        p.position.y += p.direction.y * dt;
        p.position.z += p.direction.z * dt;
        if (p.updateCellIndex) p.updateCellIndex();
      }
    }

    // cybeer's labelled beer glass (the `beer` mesh + its child `cybeer` label);
    // the arm rig + camera helper in the glb are hidden.
    function makeBeer(av) {
      const inst = cybeerContainer.instantiateModelsToScene((n) => n, false, {
        doNotInstantiate: true,
      });
      const root = inst.rootNodes[0];
      root.parent = av.hand;
      let beerMesh = null,
        labelMesh = null;
      for (const m of root.getChildMeshes(false)) {
        m.isPickable = false;
        if (m.name === "beer") beerMesh = m;
        else if (m.name === "cybeer") labelMesh = m;
        else m.setEnabled(false); // drop the arm + camera
      }
      const S = 0.32;
      root.scaling.setAll(S);
      // Orient the glass upright, label facing out. SET the quaternion explicitly
      // instead of `addRotation` — instantiateModelsToScene shares rotation state
      // between clones, so a cumulative spin here inherits the shelf/conveyor
      // glasses' rotations and tips the held mug on its side.
      if (beerMesh)
        beerMesh.rotationQuaternion = BABYLON.Quaternion.RotationAxis(
          BABYLON.Axis.Y,
          Math.PI,
        );
      if (labelMesh) labelMesh.scaling.x = -Math.abs(labelMesh.scaling.x);
      // seat the upright glass at the hand (mouth), nudged forward + down —
      // measured from the glass bbox so it's robust to the cup's internal origin
      if (beerMesh) {
        root.position.set(0, 0, 0);
        av.hand.computeWorldMatrix(true);
        beerMesh.computeWorldMatrix(true);
        const gl = BABYLON.Vector3.TransformCoordinates(
          beerMesh.getBoundingInfo().boundingBox.centerWorld,
          BABYLON.Matrix.Invert(av.hand.getWorldMatrix()),
        );
        root.position.set(-gl.x, -gl.y - 0.35, -gl.z + 0.15);
      }
      // amber fill INSIDE the glass — parented to the glass mesh, on its cup axis (x/z 0),
      // sized to fit the cup; shrinks as you drink
      const fbH = 1.35,
        fbBottom = -0.83,
        cx = 0,
        cz = 0;
      const fluid = BABYLON.MeshBuilder.CreateCylinder(
        "beerFluid",
        { height: fbH, diameter: 1.4, tessellation: 16 },
        scene,
      );
      fluid.parent = beerMesh || root;
      fluid.isPickable = false;
      fluid.material = beerMat;
      const ctl = {
        root,
        fluid,
        cx,
        cz,
        fbH,
        fbBottom,
        level: 1,
        sipT: -1,
        nextSip: 1.5 + Math.random() * 2,
      };
      setBeerLevel(ctl, 1);
      return ctl;
    }
    function setBeerLevel(ctl, lvl) {
      ctl.level = lvl;
      const h = Math.max(0.001, ctl.fbH * lvl);
      ctl.fluid.scaling.y = lvl;
      ctl.fluid.position.set(ctl.cx, ctl.fbBottom + h / 2, ctl.cz);
    }

    // cigbot's cigarette model (3-material cylinder), scaled up, with a glowing
    // ember + smoke added at the burning tip.
    function makeCigarette(av) {
      const inst = cigContainer.instantiateModelsToScene((n) => n, false, {
        doNotInstantiate: true,
      });
      const root = inst.rootNodes[0];
      root.parent = av.hand;
      // KEEP the skeleton: the cig's built-in "smoke" AnimationGroup (frames
      // 0..300) shortens it from full length (0) to a butt (300) as it burns. We
      // scrub it by `burn` in updateHold rather than playing it in real time.
      let cigMesh = null;
      for (const m of root.getChildMeshes(false)) {
        m.isPickable = false;
        if (m.skeleton) cigMesh = m;
      }
      const burnGrp =
        inst.animationGroups.find((g) => g.name === "smoke") ||
        inst.animationGroups[0];
      if (burnGrp) {
        burnGrp.start(true, 1, burnGrp.from, burnGrp.to);
        burnGrp.pause();
        burnGrp.goToFrame(0); // frame 0 = full length
      }
      const emberBone =
        inst.skeletons && inst.skeletons[0]
          ? inst.skeletons[0].bones.find((b) => b.name === "ember")
          : null;
      const S = 0.5; // ~3x bigger than the old procedural cig
      root.scaling.setAll(S);
      root.rotationQuaternion = null; // drop the glTF import flip
      // The SKINNED geometry runs along local Z (ember +Z / filter -Z) — already
      // horizontal, ember out — so (unlike the old detached Y-axis geometry) it
      // needs no -90° tilt, which was standing it up vertically.
      root.rotation.set(0, 0, 0);
      root.position.set(0.0, -0.2, 0.12); // sits into the mouth when smoking
      const ember = BABYLON.MeshBuilder.CreateSphere(
        "cigEmber",
        { diameter: 0.4, segments: 8 },
        scene,
      );
      ember.material = emberMat;
      ember.isPickable = false;
      // Ride the "ember" bone so the glow + smoke follow the burning tip as it
      // recedes. Bone-parented, so equipHold disposes it explicitly (not via root).
      if (emberBone && cigMesh) ember.attachToBone(emberBone, cigMesh);
      else {
        ember.parent = root;
        ember.position.set(0, -1.03, -0.945); // burning tip (fallback)
      }
      const ps = new BABYLON.ParticleSystem("smoke", 220, scene);
      ps.particleTexture = smokeTex;
      ps.isAnimationSheetEnabled = true;
      ps.spriteCellWidth = 256;
      ps.spriteCellHeight = 256; // 1792 / 7
      ps.startSpriteCellID = 0;
      ps.endSpriteCellID = 45;
      ps.spriteRandomStartCell = true;
      ps.spriteCellChangeSpeed = 1.4;
      ps.emitter = ember; // world-space (isLocal false): trail stays in the room
      ps.minEmitBox = ps.maxEmitBox = BABYLON.Vector3.Zero();
      ps.color1 = new BABYLON.Color4(0.64, 0.64, 0.64, 1);
      ps.color2 = new BABYLON.Color4(0.58, 0.58, 0.58, 1);
      ps.minLifeTime = 4;
      ps.maxLifeTime = 11; // long-lived -> accumulates
      ps.emitRate = 6; // ambient smolder — a drag puffs extra (see updateHold)
      ps.minSize = 0.36;
      ps.maxSize = 0.36;
      ps.direction1 = new BABYLON.Vector3(-0.05, 0.55, -0.05);
      ps.direction2 = new BABYLON.Vector3(0.05, 0.68, 0.05);
      ps.minEmitPower = 0.25;
      ps.maxEmitPower = 0.5;
      ps.blendMode = BABYLON.ParticleSystem.BLENDMODE_STANDARD;
      ps.updateFunction = smokeUpdate;
      ps.start();
      anyCig++;
      return {
        root,
        ember,
        ps,
        burnGrp,
        burn: 0, // 0 = fresh, 1 = smoked to the butt
        actT: -1, // >=0 while a drag is in progress
        nextAct: 1.5 + Math.random() * 2.5, // remotes auto-drag on this timer
        ambientEmit: 6,
      };
    }

    function equipHold(av, type) {
      if (av.holdType === type) return;
      if (av.item) {
        if (av.item.ps) {
          anyCig--;
          av.item.ps.stop();
          const s = av.item.ps;
          setTimeout(() => s.dispose(), 12000);
        }
        if (av.item.ember) av.item.ember.dispose(); // bone-parented, not under root
        if (av.item.root) av.item.root.dispose(false, true);
        av.item = null;
      }
      av.holdType = type;
      if (type === "beer") av.item = makeBeer(av);
      else if (type === "cig") av.item = makeCigarette(av);
    }

    // ---- cigarette machine + beer conveyor + shelf glasses (cosmetic) ----------
    // Two walk-up dispensers tucked in the SW corner: a cigarette vending machine
    // on the south wall (between the fireplace and the bar) and a beer conveyor
    // that runs out of the west wall onto the bar's south end. Walk up and tap
    // either one to grab that item; the 🍺/🚬 buttons then use what you hold.
    const unlitTexMat = (name, tex) => Materials.unlitTex(name, scene, tex);

    function cigMachineTex() {
      const W = 128,
        Hh = 224;
      const dt = new BABYLON.DynamicTexture(
        "cigMachineTex",
        { width: W, height: Hh },
        scene,
        false,
      );
      const c = dt.getContext();
      c.fillStyle = "#2a1838";
      c.fillRect(0, 0, W, Hh);
      c.fillStyle = "#c22";
      c.fillRect(8, 8, W - 16, 32);
      c.fillStyle = "#ffe8c0";
      c.font = "bold 24px 'DrawvidHand','Comic Sans MS',cursive,sans-serif";
      c.textAlign = "center";
      c.textBaseline = "middle";
      c.fillText("CIGS", W / 2, 25);
      c.fillStyle = "#0b0b14";
      c.fillRect(10, 48, W - 20, 116);
      const packCol = [
        "#d8d0c0",
        "#c02a2a",
        "#e0b020",
        "#1e7a3a",
        "#3050c0",
        "#b0b0b8",
      ];
      for (let r = 0; r < 4; r++)
        for (let col = 0; col < 3; col++) {
          const x = 16 + col * 34,
            y = 54 + r * 27;
          c.fillStyle = packCol[(r * 3 + col) % packCol.length];
          c.fillRect(x, y, 28, 22);
          c.fillStyle = "rgba(255,255,255,.7)";
          c.fillRect(x, y, 28, 5);
        }
      c.fillStyle = "#9a9aa2";
      c.fillRect(18, 176, 22, 12);
      c.fillStyle = "#c8b060";
      c.fillRect(W - 40, 178, 22, 6);
      c.fillStyle = "#000";
      c.fillRect(14, 196, W - 28, 20);
      dt.update();
      dt.updateSamplingMode(BABYLON.Texture.NEAREST_SAMPLINGMODE);
      return dt;
    }

    // dark belt texture (light/dark stripes) — scrolled toward the lip for motion.
    function beltTex() {
      const dt = new BABYLON.DynamicTexture(
        "beltTex",
        { width: 16, height: 8 },
        scene,
        false,
      );
      const c = dt.getContext();
      c.fillStyle = "#141414";
      c.fillRect(0, 0, 16, 8);
      c.fillStyle = "#2c2c2c";
      c.fillRect(0, 0, 8, 8);
      dt.update();
      dt.updateSamplingMode(BABYLON.Texture.NEAREST_SAMPLINGMODE);
      dt.wrapU = dt.wrapV = BABYLON.Texture.WRAP_ADDRESSMODE;
      return dt;
    }

    // A static cybeer glass (label facing `yaw`) for the back shelf and as the
    // "ready" beer on the conveyor. Mirrors makeBeer's label fix; full amber fill.
    function makeStaticCybeer(pos, yaw, S, prefix, pickable, withFluid) {
      const inst = cybeerContainer.instantiateModelsToScene((n) => n, false, {
        doNotInstantiate: true,
      });
      const root = inst.rootNodes[0];
      const holder = new BABYLON.TransformNode(prefix + "_holder", scene);
      root.parent = holder;
      let beerMesh = null,
        labelMesh = null;
      for (const m of root.getChildMeshes(false)) {
        if (m.name === "beer") beerMesh = m;
        else if (m.name === "cybeer") labelMesh = m;
        else {
          m.setEnabled(false); // drop the arm + camera helper
          continue;
        }
        m.isPickable = pickable;
        m.name = prefix + "_" + (m === labelMesh ? "label" : "glass");
        m.receiveShadows = true;
        shadow.addShadowCaster(m);
      }
      root.scaling.setAll(S);
      if (beerMesh) beerMesh.addRotation(0, Math.PI, 0); // handle away, label out
      if (labelMesh) labelMesh.scaling.x *= -1; // un-mirror the flipped decal
      if (withFluid) {
        // full amber pint on the cup axis (the conveyor's ready beer only;
        // the back-shelf glasses stay empty)
        const fluid = BABYLON.MeshBuilder.CreateCylinder(
          prefix + "_fluid",
          { height: 1.35, diameter: 1.4, tessellation: 16 },
          scene,
        );
        fluid.parent = beerMesh || root;
        fluid.isPickable = pickable;
        fluid.material = beerMat;
        fluid.position.set(0, -0.155, 0);
      }
      root.position.set(0.36 * S, -1.21 * S, 0.19 * S); // glass centre -> holder origin
      holder.position.copyFrom(pos);
      holder.rotation.y = yaw;
      return holder;
    }

    function buildDispensers() {
      // -- cigarette vending machine: south wall, between the fireplace and bar --
      // (the bar is on the +x/east wall in-game, so the "corner between the
      // fireplace and the bar" is the SE corner — hence the +x coordinates.)
      const cm = { x: 6.0, z: 11.1, w: 1.2, h: 2.3, d: 0.62 };
      const cy = floorTopY + cm.h / 2;
      const body = BABYLON.MeshBuilder.CreateBox(
        "disp_cig_body",
        { width: cm.w, height: cm.h, depth: cm.d },
        scene,
      );
      body.material = metalMat;
      body.position.set(cm.x, cy, cm.z);
      body.receiveShadows = true;
      shadow.addShadowCaster(body);
      const front = BABYLON.MeshBuilder.CreatePlane(
        "disp_cig_front",
        { width: cm.w * 0.94, height: cm.h * 0.94 },
        scene,
      );
      front.material = unlitTexMat("cigFrontMat", cigMachineTex());
      front.position.set(cm.x, cy, cm.z - cm.d / 2 - 0.011);
      front.rotation.y = Math.PI; // face -z, into the room
      front.scaling.x = -1; // un-mirror the text (rotated 180° about Y)
      colliders.push({
        minX: cm.x - cm.w / 2,
        maxX: cm.x + cm.w / 2,
        minZ: cm.z - cm.d / 2,
        maxZ: cm.z + cm.d / 2,
      });
      dispensers.push({
        kind: "cig",
        grabPos: new BABYLON.Vector3(cm.x, 0, cm.z - cm.d / 2),
        standPos: new BABYLON.Vector3(cm.x, 0, cm.z - cm.d / 2 - 0.9),
        radius: PICKUP_R,
      });

      // -- beer conveyor: runs out of the east wall ACROSS the bar to its
      // room-facing edge, so you can walk up to the bar and grab the beer --
      const cv = { wallX: 11.8, lipX: 7.9, y: 1.3, z: 5.5, w: 0.86 };
      const len = cv.wallX - cv.lipX;
      const midX = (cv.wallX + cv.lipX) / 2;
      const chan = BABYLON.MeshBuilder.CreateBox(
        "disp_beer_chan",
        { width: len, height: 0.18, depth: cv.w },
        scene,
      );
      chan.material = darkMat;
      chan.position.set(midX, cv.y - 0.12, cv.z);
      chan.receiveShadows = true;
      shadow.addShadowCaster(chan);
      for (const s of [-1, 1]) {
        const rail = BABYLON.MeshBuilder.CreateBox(
          "disp_beer_rail",
          { width: len, height: 0.12, depth: 0.06 },
          scene,
        );
        rail.material = metalMat;
        rail.position.set(midX, cv.y - 0.02, cv.z + s * (cv.w / 2 - 0.03));
      }
      const beltMat = new BABYLON.StandardMaterial("beltMat", scene);
      beltMat.diffuseTexture = beltTex();
      beltMat.diffuseTexture.uScale = len / 0.34;
      beltMat.specularColor = new BABYLON.Color3(0, 0, 0);
      beltMat.emissiveColor = new BABYLON.Color3(0.06, 0.06, 0.06);
      const belt = BABYLON.MeshBuilder.CreatePlane(
        "disp_beer_belt",
        { width: len, height: cv.w - 0.12 },
        scene,
      );
      belt.material = beltMat;
      belt.rotation.x = -Math.PI / 2; // lie flat, face up
      belt.position.set(midX, cv.y - 0.02, cv.z);
      belt.isPickable = false;
      scene.onBeforeRenderObservable.add(() => {
        beltMat.diffuseTexture.uOffset -= (engine.getDeltaTime() / 1000) * 0.5; // scroll toward the lip
      });
      // the "ready" beer waiting at the lip (grabbable, full), logo facing the room (-x)
      makeStaticCybeer(
        new BABYLON.Vector3(cv.lipX + 0.28, cv.y + 0.26, cv.z),
        -Math.PI / 2,
        0.3,
        "disp_beer",
        true,
        true,
      );
      dispensers.push({
        kind: "beer",
        grabPos: new BABYLON.Vector3(cv.lipX + 0.28, 0, cv.z),
        standPos: new BABYLON.Vector3(cv.lipX - 1.6, 0, cv.z),
        radius: PICKUP_R,
      });
    }

    function buildShelfGlasses() {
      // line cybeer glasses along the back shelf above the bar (+x/east wall),
      // logos facing out into the room (-x)
      // gx pulled back toward the wall so the mugs rest fully on the (now-lowered)
      // bottom shelf instead of drooping off its front edge.
      const shelfTopY = 2.73,
        gx = 11.35,
        S = 0.3,
        gy = shelfTopY + 0.24;
      for (const z of [-4.9, -3.0, -1.0, 1.0, 3.0, 4.9])
        makeStaticCybeer(
          new BABYLON.Vector3(gx, gy, z),
          -Math.PI / 2,
          S,
          "shelf_glass",
          false,
          false, // empty glasses on the shelf
        );
    }

    // wall sconces near the corners (2 per wall) — warm point lights + a glowing
    // fixture; they carry the room now that the overhead key/fill are dimmed.
    function buildSconces() {
      // [x, z, inwardX, inwardZ] — the fixture + warm light are identical in every
      // room (shared builder, src/shared/lighting.js); only the wall positions
      // differ with room size.
      let specs;
      if (ROOM === "main") {
        // hand-placed for the main clubhouse: south sits at ±5 to clear the cig
        // machine; east at ±7 to clear the bar/shelf run.
        specs = [
          [-6, -11.7, 0, 1],
          [6, -11.7, 0, 1], // north wall
          [-5, 11.7, 0, -1],
          [5, 11.7, 0, -1], // south wall
          [11.7, -7, -1, 0],
          [11.7, 7, -1, 0], // east wall
          [-11.7, -6, 1, 0],
          [-11.7, 6, 1, 0], // west wall
        ];
      } else {
        // VIP lounge: a 20×20 box — walls centred at ±10 with inner faces at ~±9.7
        // (S/E/W are solid cream_wall_* meshes; N is the LOBBY door wall). Positions
        // sit just inside each inner face so the fixtures mount flush and point into
        // the room; the N pair straddles the door (which is centred at x≈0). Same
        // specs→fixture pipeline as main, hand-sized to this room.
        specs = [
          [-5, -9.6, 0, 1],
          [5, -9.6, 0, 1], // north wall (LOBBY door), flanking the door
          [-5, 9.6, 0, -1],
          [5, 9.6, 0, -1], // south wall
          [9.6, -5, -1, 0],
          [9.6, 5, -1, 0], // east wall
          [-9.6, -5, 1, 0],
          [-9.6, 5, 1, 0], // west wall
        ];
      }
      Lighting.buildSconces(scene, specs, {
        prefix: "sconce",
        bracketMat: darkMat,
      });
    }

    // grab an item from a dispenser (no put-down; grabbing the other one swaps)
    function grabFromDispenser(kind) {
      if (me.holdType === kind) return;
      equipHold(me, kind);
      net.sendHold(HOLD_TYPES.indexOf(kind));
      reflectHoldBtns();
    }
    // start a one-shot sip (beer) / drag (cig) on the local avatar's held item
    function startAction(av) {
      const it = av.item;
      if (!it) return;
      if (av.holdType === "beer" && it.sipT < 0) it.sipT = 0;
      else if (av.holdType === "cig" && it.actT < 0) it.actT = 0;
    }
    function triggerAction(type) {
      if (me.holdType !== type) {
        flashHint(
          type === "beer"
            ? "Grab a 🍺 from the conveyor"
            : "Grab a 🚬 from the machine",
        );
        return;
      }
      startAction(me);
    }
    let hintEl = null,
      hintT = null;
    function flashHint(text) {
      if (!hintEl) {
        hintEl = document.createElement("div");
        Object.assign(hintEl.style, {
          position: "absolute",
          bottom: "120px",
          left: "50%",
          transform: "translateX(-50%)",
          padding: "7px 14px",
          borderRadius: "16px",
          background: "rgba(20,40,20,0.86)",
          color: "#e8ffd8",
          fontWeight: "bold",
          fontSize: "14px",
          fontFamily: "DrawvidHand, Comic Sans MS, cursive, sans-serif",
          maxWidth: "82vw",
          boxSizing: "border-box",
          textAlign: "center",
          pointerEvents: "none",
          zIndex: "60",
        });
        document.getElementById("overlay").appendChild(hintEl);
      }
      hintEl.textContent = text;
      hintEl.style.display = "block";
      if (hintT) clearTimeout(hintT);
      hintT = setTimeout(() => (hintEl.style.display = "none"), 1500);
    }

    // per-frame: item rides the ball's bob; a sip/drag is triggered by the button
    // (local) or a gentle auto-loop (remotes). The face changes to match.
    function updateHold(av, dt, isLocal) {
      if (!av.hand) return;
      av.hand.position.copyFrom(HAND_LOCAL);
      av.hand.position.y += av.bob ? av.bob.position.y : 0;
      av.hand.rotation.set(0, 0, 0);
      const it = av.item;
      let face = null;
      if (it && av.holdType === "beer") {
        if (it.sipT < 0) {
          if (!isLocal) {
            it.nextSip -= dt;
            if (it.nextSip <= 0) it.sipT = 0; // remotes sip on a loop
          }
        } else {
          it.sipT += dt;
          const T = 1.5,
            u = Math.min(1, it.sipT / T);
          const tip = Math.sin(Math.min(1, u / 0.9) * Math.PI); // 0 -> 1 -> 0
          av.hand.rotation.x = -tip * 1.35; // tip the mug so the rim meets the mouth
          face = "drink";
          if (u > 0.4 && u < 0.75)
            setBeerLevel(it, Math.max(0, it.level - (dt / 0.9) * 0.34));
          if (u >= 1) {
            it.sipT = -1;
            it.nextSip = 2.5 + Math.random() * 2.5;
            if (it.level <= 0.05) {
              if (isLocal) {
                // finished the pint — hands empty; the 🍺 button hides (via
                // reflectHoldBtns) so you know to go grab another.
                equipHold(me, "none");
                net.sendHold(0);
                reflectHoldBtns();
                face = null;
              } else {
                setBeerLevel(it, 1); // remote visual loop -> fresh pint
              }
            }
          }
        }
      } else if (it && av.holdType === "cig") {
        // The cig only burns down on a DRAG (button press) — no ambient smolder,
        // so it doesn't deplete while just held.
        if (it.actT < 0) {
          it.ps.emitRate = it.ambientEmit;
          it.ember.scaling.setAll(1);
          if (!isLocal) {
            it.nextAct -= dt;
            if (it.nextAct <= 0) it.actT = 0; // remotes drag on a loop
          }
        } else {
          it.actT += dt;
          const T = 1.4,
            u = Math.min(1, it.actT / T);
          face = "o";
          it.ember.scaling.setAll(u < 0.5 ? 1.6 : 1); // ember flares on the inhale
          it.ps.emitRate = u > 0.5 ? 52 : it.ambientEmit; // exhale puff
          if (u >= 1) {
            it.actT = -1;
            it.nextAct = 3 + Math.random() * 3;
            it.ps.emitRate = it.ambientEmit;
            it.burn = Math.min(1, it.burn + 0.14); // each drag burns a chunk
          }
        }
        // Scrub the built-in "smoke" animation so the cig shortens as it burns.
        if (it.burnGrp) it.burnGrp.goToFrame(it.burn * it.burnGrp.to);
        if (it.burn >= 1) {
          if (isLocal) {
            // smoked to the butt — hands empty; the 🚬 button hides so you
            // know to go grab another.
            equipHold(me, "none");
            net.sendHold(0);
            reflectHoldBtns();
            face = null;
          } else {
            it.burn = 0; // remote visual loop -> fresh cig
          }
        }
      }
      if (av.curFace !== face) {
        setFace(av, face);
        av.curFace = face;
      }
    }

    // FACE_OFFSET tunes which way the gball's eyes point vs travel direction.
    const FACE_OFFSET = 0;

    // -- local avatar (small random offset so players don't stack on spawn) --
    const me = spawnAvatar();
    // Cold load frames the two exit doors (see below); the COURSE (-Z) and RANGE
    // (-X) doors project symmetrically about the z=x diagonal, so land the ball ON
    // it — and skip the anti-stack scatter — to sit him dead-centre between them.
    // Door arrivals keep their at-the-door spot with a little scatter.
    if (!fromDoor) spawn = new BABYLON.Vector3(2, spawn.y, 2);
    const scatter = fromDoor ? 0.5 : 0;
    me.wrapper.position.set(
      spawn.x + (Math.random() - 0.5) * scatter,
      avatarY,
      spawn.z + (Math.random() - 0.5) * scatter,
    );
    let myYaw;
    if (arriveYaw != null) {
      myYaw = arriveYaw;
      // start the orbit camera behind him, looking the way he faces
      camera.alpha = Math.atan2(-Math.cos(arriveYaw), -Math.sin(arriveYaw));
    } else {
      // Cold load (the clubhouse is index.html): frame the two exit doors — range
      // (-X wall) and course (-Z wall) — with the character turned to face the lens.
      // The camera sits at +X/+Z looking across the room toward the -X/-Z corner;
      // alpha and the ball's yaw match (FACE_OFFSET is 0), so the ball meets the camera.
      camera.alpha = Math.PI / 4;
      myYaw = Math.PI / 4;
    }
    setClip(me, "bounce");
    const myStyle = BallsStyle.loadStyle();
    applyAvatarStyle(me, myStyle);

    // dress the room. The shelf glasses and the two walk-up dispensers (beer
    // conveyor + cig machine) live at the main clubhouse's hardcoded bar/wall
    // coordinates, so they belong to MAIN only — in the smaller VIP lounge they'd
    // float through the walls. The VIP lounge is "bring your own": you carry items
    // in through the door (hold is persisted across the room-switch page load).
    // Sconces run in every room, sized to that room's walls (see buildSconces).
    if (ROOM === "main") {
      buildShelfGlasses();
      buildDispensers();
    }
    buildSconces();
    // sconces push the room past Babylon's default 4-lights-per-mesh cap
    for (const m of scene.materials) m.maxSimultaneousLights = 12;

    // -- input state --
    const keys = Object.create(null);
    let typing = false;
    let moveTarget = null; // click-to-move point (Vector3) or null

    addEventListener("keydown", (e) => {
      if (typing) return;
      keys[e.key.toLowerCase()] = true;
    });
    addEventListener("keyup", (e) => {
      keys[e.key.toLowerCase()] = false;
    });

    scene.onPointerObservable.add((pi) => {
      if (pi.type !== BABYLON.PointerEventTypes.POINTERPICK) return;
      const p = pi.pickInfo;
      if (!p || !p.hit || !p.pickedMesh) return;
      const nm = p.pickedMesh.name || "";
      const door = doors.find(
        (d) => nm.startsWith("door_" + d.kind) || p.pickedMesh === d.mesh,
      );
      if (door) return goToDoor(door.kind);
      // dispensers: near enough -> grab it; otherwise walk over first
      const dkind = nm.startsWith("disp_cig")
        ? "cig"
        : nm.startsWith("disp_beer")
          ? "beer"
          : null;
      if (dkind) {
        const d = dispensers.find((x) => x.kind === dkind);
        if (d) {
          const dx = d.grabPos.x - me.wrapper.position.x;
          const dz = d.grabPos.z - me.wrapper.position.z;
          if (dx * dx + dz * dz <= d.radius * d.radius)
            grabFromDispenser(dkind);
          else moveTarget = d.standPos.clone();
          return;
        }
      }
      moveTarget = p.pickedPoint.clone();
    });

    // -- networking --
    const net = new ClubhouseNet(WS_URL, MY_NAME, MY_AREA);
    // On (re)connect, re-announce what we're holding so others see an item we
    // carried in from another room (the local re-equip already happened on load).
    net.onReady = () => {
      if (me.holdType !== "none") net.sendHold(HOLD_TYPES.indexOf(me.holdType));
      // announce the locker-room look; empty image strings clear stale ones
      net.sendHat(myStyle.hat);
      net.sendSkin(myStyle.skin);
      net.sendFace(myStyle.face || "");
      net.sendSkinImg(myStyle.skinImg || "");
    };
    const remotes = new Map(); // id -> { av, x,z,ry, tx,tz,try, moving, seen }
    const faceStore = new Map(); // id -> {v, data} drawn-face blobs (from broadcasts)
    const skinImgStore = new Map(); // id -> {v, data} ball-wrap image blobs
    net.onSnapshot = (playersArr, broadcasts) => {
      const nowSeen = Date.now();
      for (const p of playersArr) {
        if (p.id === net.playerId) continue;
        if ((p.area || 0) !== MY_AREA) continue; // only show players in the same room
        let r = remotes.get(p.id);
        if (!r) {
          const av = spawnAvatar();
          av.wrapper.position.set(p.x, avatarY, p.z);
          setClip(av, "bounce");
          r = {
            av,
            x: p.x,
            z: p.z,
            ry: p.ry || 0,
            tx: p.x,
            tz: p.z,
            try_: p.ry || 0,
            moving: false,
            name: p.name,
            seen: nowSeen,
          };
          remotes.set(p.id, r);
          makeTag(p.id, p.name);
        }
        r.tx = p.x;
        r.tz = p.z;
        r.try_ = p.ry || 0;
        r.moving = !!p.moving;
        r.name = p.name;
        r.seen = nowSeen;
        const ht = HOLD_TYPES[p.hold || 0] || "none";
        if (r.av.holdType !== ht) equipHold(r.av, ht);
        // locker-room look: hat/skin ride the snapshot; the face + ball-image
        // blobs arrive via broadcasts (applyAvatarStyle no-ops on no change)
        applyAvatarStyle(r.av, {
          hat: p.hat || 0,
          skin: p.skin || 0,
          face: (faceStore.get(p.id) || {}).data || null,
          skinImg: (skinImgStore.get(p.id) || {}).data || null,
        });
      }
      for (const b of broadcasts || []) {
        if (b.type === "feed") pushFeed(b.data);
        else if (
          b.type === "face" &&
          b.data &&
          b.data.playerId !== net.playerId
        )
          faceStore.set(b.data.playerId, {
            v: b.data.faceV || 0,
            data: b.data.face || null,
          });
        else if (
          b.type === "skinimg" &&
          b.data &&
          b.data.playerId !== net.playerId
        )
          skinImgStore.set(b.data.playerId, {
            v: b.data.v || 0,
            data: b.data.img || null,
          });
      }
      // cull players not seen in this snapshot — free ALL their resources
      for (const [id, r] of remotes) {
        if (r.seen !== nowSeen) {
          // Drop shadow-map references before the meshes go: the generator keeps
          // the caster in its render list otherwise (avatar body + any hat).
          for (const m of r.av.wrapper.getChildMeshes(false))
            shadow.removeShadowCaster(m);
          equipHold(r.av, "none"); // decrements anyCig + disposes held item/smoke
          if (r.av.customFaceTex) r.av.customFaceTex.dispose();
          r.av.wrapper.dispose(false, true);
          faceStore.delete(id); // these per-player blob caches grow unbounded otherwise
          skinImgStore.delete(id);
          removeTag(id);
          removeBubble(id);
          remotes.delete(id);
        }
      }
    };
    net.onChat = (msg) => {
      // Own messages are echoed locally at send time (so chat works even when
      // the server is unreachable) — skip the server's copy to avoid doubling.
      if (msg.playerId === net.playerId) return;
      pushFeed(`${msg.playerName}: ${msg.text}`);
      showBubble(msg.playerId, msg.text);
    };
    net.connect();

    // -- chat + overlay UI --
    const ui = buildChatUI();
    ui.input.addEventListener("focus", () => (typing = true));
    ui.input.addEventListener("blur", () => {
      typing = false;
      // Safari's ✓/Done accessory button only closes the keyboard — treat any
      // dismissal with text still typed as a send, so every keyboard button
      // that ends typing submits the message (Escape clears first to cancel).
      sendChatNow();
      // iOS pans the page when the keyboard covers an input; snap it back so
      // the fixed-canvas layout can't end up stuck half-scrolled.
      window.scrollTo(0, 0);
    });
    const sendChatNow = () => {
      const t = ui.input.value.trim();
      ui.input.value = ""; // clear FIRST so re-entrant blur can't double-send
      if (t) {
        net.sendChat(t);
        // Local echo: your own line + bubble render immediately — the server
        // round-trip (or its absence when offline) must never decide whether
        // YOUR message shows on YOUR screen. onChat skips self to match.
        pushFeed(`${MY_NAME}: ${t}`);
        showBubble("me", t);
      }
    };
    // ONE submit behaviour however the keyboard is dismissed: the return/send
    // key (form submit or Enter keydown) sends, and — because Safari's own
    // ✓/Done accessory button can't be removed or relabelled — closing the
    // keyboard with text still typed sends too (see the blur handler above).
    ui.form.addEventListener("submit", (e) => {
      e.preventDefault();
      sendChatNow();
      ui.input.blur();
    });
    ui.input.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Enter") {
        e.preventDefault();
        sendChatNow();
        ui.input.blur();
      } else if (e.key === "Escape") {
        ui.input.value = ""; // clear BEFORE blur = cancelled, nothing sends
        ui.input.blur();
      }
    });

    // -- virtual joystick (bottom-left) so mobile / no-keyboard players can move --
    const joy = { x: 0, y: 0 };
    (function buildJoystick() {
      const R = 56; // knob travel radius (px)
      const base = document.createElement("div");
      Object.assign(base.style, {
        position: "absolute",
        left: "20px",
        bottom: "20px",
        width: R * 2 + "px",
        height: R * 2 + "px",
        borderRadius: "50%",
        background:
          "radial-gradient(circle at 50% 38%, rgba(255,255,255,.22), rgba(30,90,45,.30))",
        border: "3px solid rgba(255,255,255,.5)",
        boxShadow: "inset 0 2px 10px rgba(0,0,0,.25)",
        touchAction: "none",
        pointerEvents: "auto",
        zIndex: "50",
      });
      const knob = document.createElement("div");
      Object.assign(knob.style, {
        position: "absolute",
        left: "50%",
        top: "50%",
        width: "54px",
        height: "54px",
        marginLeft: "-27px",
        marginTop: "-27px",
        borderRadius: "50%",
        background: "linear-gradient(180deg,#4fc46a,#2e8b48)",
        border: "2px solid rgba(255,255,255,.6)",
        boxShadow:
          "0 4px 10px rgba(20,90,40,.45), inset 0 2px 6px rgba(255,255,255,.6)",
        pointerEvents: "none",
        transition: "transform .04s linear",
      });
      base.appendChild(knob);
      document.getElementById("overlay").appendChild(base);
      let pid = null;
      const setKnob = (dx, dy) => {
        knob.style.transform = "translate(" + dx + "px," + dy + "px)";
      };
      const move = (e) => {
        const r = base.getBoundingClientRect();
        let dx = e.clientX - (r.left + r.width / 2),
          dy = e.clientY - (r.top + r.height / 2);
        const len = Math.hypot(dx, dy) || 1,
          cl = Math.min(len, R);
        dx = (dx / len) * cl;
        dy = (dy / len) * cl;
        setKnob(dx, dy);
        const nx = dx / R,
          ny = dy / R,
          dead = 0.16;
        joy.x = Math.abs(nx) < dead ? 0 : nx;
        joy.y = Math.abs(ny) < dead ? 0 : -ny; // pushing up = forward
      };
      const end = (e) => {
        if (pid != null && e.pointerId !== pid) return;
        pid = null;
        joy.x = 0;
        joy.y = 0;
        setKnob(0, 0);
      };
      base.addEventListener("pointerdown", (e) => {
        pid = e.pointerId;
        base.setPointerCapture(pid);
        move(e);
        e.preventDefault();
        e.stopPropagation();
      });
      base.addEventListener("pointermove", (e) => {
        if (e.pointerId === pid) {
          move(e);
          e.preventDefault();
        }
      });
      base.addEventListener("pointerup", end);
      base.addEventListener("pointercancel", end);
    })();

    // -- beer / cigarette buttons: golf-style glossy green circles, stacked bottom-right --
    const holdBar = document.createElement("div");
    Object.assign(holdBar.style, {
      position: "absolute",
      right: "18px",
      bottom: "18px",
      display: "flex",
      flexDirection: "column",
      gap: "12px",
      zIndex: "50",
    });
    const HOLD_OFF =
      "0 5px 14px rgba(20,90,40,.45), inset 0 2px 6px rgba(255,255,255,.6)";
    const HOLD_ON = "0 0 0 3px #f4c430, " + HOLD_OFF;
    function holdBtn(label, title) {
      const b = document.createElement("button");
      b.textContent = label;
      b.title = title;
      Object.assign(b.style, {
        pointerEvents: "auto",
        width: "60px",
        height: "60px",
        borderRadius: "50%",
        border: "3px solid rgba(255,255,255,.6)",
        cursor: "pointer",
        fontSize: "30px",
        lineHeight: "1",
        padding: "0",
        color: "#fff",
        background: "linear-gradient(180deg,#4fc46a,#2e8b48)",
        boxShadow: HOLD_ON,
      });
      b.addEventListener("pointerdown", (e) => e.stopPropagation());
      return b;
    }
    const beerBtn = holdBtn("🍺", "Sip your beer");
    const cigBtn = holdBtn("🚬", "Take a drag");
    holdBar.appendChild(beerBtn);
    holdBar.appendChild(cigBtn);
    document.getElementById("overlay").appendChild(holdBar);
    // The buttons no longer spawn items — you grab those from the dispensers.
    // They sip / drag whatever you hold. You can only hold one at a time, so
    // only the equipped item's button is shown (both share the same slot);
    // the other is hidden entirely.
    function reflectHoldBtns() {
      beerBtn.style.display = me.holdType === "beer" ? "block" : "none";
      cigBtn.style.display = me.holdType === "cig" ? "block" : "none";
    }
    reflectHoldBtns();
    // Re-equip whatever the player carried in from the previous room (stashed in
    // goToDoor). The network re-announce happens on connect via net.onReady, so
    // remotes see the item too even though the socket isn't open yet here.
    const carriedHold = localStorage.getItem("ballsHold");
    if (carriedHold === "beer" || carriedHold === "cig") {
      equipHold(me, carriedHold);
      reflectHoldBtns();
    }
    beerBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      triggerAction("beer");
    });
    cigBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      triggerAction("cig");
    });

    const prompt = document.createElement("div");
    Object.assign(prompt.style, {
      position: "absolute",
      bottom: "84px",
      left: "50%",
      transform: "translateX(-50%)",
      padding: "7px 14px",
      borderRadius: "16px",
      background: "rgba(20,40,20,0.82)",
      color: "#e8ffd8",
      fontWeight: "bold",
      fontSize: "15px",
      // Cap the width + wrap so the chip always fits narrow mobile screens
      // (the handwriting font runs wider than the old one).
      maxWidth: "82vw",
      boxSizing: "border-box",
      textAlign: "center",
      lineHeight: "1.2",
      display: "none",
      pointerEvents: "none",
      zIndex: "40",
    });
    document.getElementById("overlay").appendChild(prompt);

    // -- collision (circle vs furniture boxes) + camera-occlusion fade --
    const AV_RADIUS = AV_SCALE * 0.9;
    function resolveCollisions(x, z, r) {
      for (let pass = 0; pass < 2; pass++) {
        for (const c of colliders) {
          const minX = c.minX - r,
            maxX = c.maxX + r,
            minZ = c.minZ - r,
            maxZ = c.maxZ + r;
          if (x > minX && x < maxX && z > minZ && z < maxZ) {
            const dL = x - minX,
              dR = maxX - x,
              dT = z - minZ,
              dB = maxZ - z;
            const mn = Math.min(dL, dR, dT, dB);
            if (mn === dL) x = minX;
            else if (mn === dR) x = maxX;
            else if (mn === dT) z = minZ;
            else z = maxZ;
          }
        }
      }
      return { x, z };
    }
    const occRay = new BABYLON.Ray(
      BABYLON.Vector3.Zero(),
      BABYLON.Vector3.Forward(),
      1,
    );
    const occPredicate = (m) => clubMeshes.has(m);
    const occSet = new Set();
    let _occCam = null; // last camera pos the occlusion pick ran at
    let _occChar = null; // last character pos it ran at
    for (const m of clubMeshes) m.visibility = 1;
    // wainscot/molding grouped by wall (n/s/e/w) so it fades with its wall — rays
    // reliably hit the big flat walls but slip past the thin trim pieces
    const wainscotByWall = { n: [], s: [], e: [], w: [] };
    for (const m of clubMeshes) {
      const g = /^(?:trim|cream_field)_([nsew])/.exec(m.name);
      if (g) wainscotByWall[g[1]].push(m);
    }

    // -- per-frame update --
    let sendAcc = 0;
    let fireTime = 0;
    let lastSent = { x: 1e9, z: 1e9, ry: 0, moving: false };
    scene.onBeforeRenderObservable.add(() => {
      const dt = Math.min(0.05, engine.getDeltaTime() / 1000);

      // Animate the sprite hearth fire: advance each flame's frame on its own
      // random 4-8 fps timer (independent, so the three never march in lockstep).
      if (fireSprites.length) {
        fireTime += dt;
        for (const s of fireSprites) {
          s.t += dt;
          if (s.t >= s.next) {
            s.t = 0;
            s.next = 1 / (4 + Math.random() * 4); // 4..8 fps hold
            s.idx = (s.idx + 1) % s.frames.length;
            s.mat.diffuseTexture = s.frames[s.idx];
            s.mat.emissiveTexture = s.frames[s.idx];
          }
        }
        if (fireLight)
          fireLight.intensity =
            0.72 +
            0.26 * Math.sin(fireTime * 6 + 1) +
            0.12 * Math.sin(fireTime * 21);
      }

      // movement input (camera-relative)
      let fx = 0,
        fz = 0;
      if (keys["w"] || keys["arrowup"]) fz += 1;
      if (keys["s"] || keys["arrowdown"]) fz -= 1;
      if (keys["a"] || keys["arrowleft"]) fx -= 1;
      if (keys["d"] || keys["arrowright"]) fx += 1;
      fx += joy.x;
      fz += joy.y;

      let dir = null;
      if (fx || fz) {
        moveTarget = null;
        const fwd = camera.getTarget().subtract(camera.position); // camera → target = forward
        fwd.y = 0;
        if (fwd.lengthSquared() < 1e-4) fwd.set(0, 0, 1);
        fwd.normalize();
        const right = BABYLON.Vector3.Cross(BABYLON.Axis.Y, fwd); // screen-right (fixes A/D)
        right.normalize();
        dir = fwd.scale(fz).add(right.scale(fx));
        if (dir.lengthSquared() > 1e-6) dir.normalize();
      } else if (moveTarget) {
        const d = moveTarget.subtract(me.wrapper.position);
        d.y = 0;
        if (d.length() < 0.25) moveTarget = null;
        else dir = d.normalize();
      }

      let moving = false;
      if (dir) {
        const step = MOVE_SPEED * dt;
        let nx = clamp(
          me.wrapper.position.x + dir.x * step,
          bounds.minX,
          bounds.maxX,
        );
        let nz = clamp(
          me.wrapper.position.z + dir.z * step,
          bounds.minZ,
          bounds.maxZ,
        );
        let res = resolveCollisions(nx, nz, AV_RADIUS);
        nx = res.x;
        nz = res.z;
        // don't walk through other characters
        const minD = AV_SCALE * 2;
        for (const rp of remotes.values()) {
          const dx = nx - rp.x,
            dz = nz - rp.z;
          const d = Math.hypot(dx, dz);
          if (d > 1e-4 && d < minD) {
            const p = minD - d;
            nx += (dx / d) * p;
            nz += (dz / d) * p;
          }
        }
        res = resolveCollisions(nx, nz, AV_RADIUS); // re-resolve furniture after the push
        me.wrapper.position.x = clamp(res.x, bounds.minX, bounds.maxX);
        me.wrapper.position.z = clamp(res.z, bounds.minZ, bounds.maxZ);
        me.wrapper.position.y = avatarY;
        myYaw = Math.atan2(dir.x, dir.z) + FACE_OFFSET;
        moving = true;
      }
      me.wrapper.rotation.y = myYaw;
      setClip(me, moving ? "walk" : "bounce");
      animateAvatar(me, dt);
      updateBlink(me, dt);
      updateHold(me, dt, true);

      // flicker every lit cigarette ember (one shared material)
      if (anyCig > 0) {
        const fl = 0.85 + Math.random() * 0.3;
        emberMat.emissiveColor.set(1.0 * fl, 0.32 * fl, 0.03 * fl);
      }

      // camera follows the avatar (keeps user's orbit)
      camera.target.copyFrom(me.wrapper.position);
      camera.target.y += 1.0;

      // Bottom hint chip: what to do at whatever you're standing near — a door,
      // or (if you're not already holding it) a beer/cigarette dispenser.
      let hint = null;
      for (const d of doors) {
        const dx = d.pos.x - me.wrapper.position.x;
        const dz = d.pos.z - me.wrapper.position.z;
        if (dx * dx + dz * dz < DOOR_RADIUS * DOOR_RADIUS)
          hint = "▸ " + d.label + " (tap the door)";
      }
      if (!hint) {
        for (const d of dispensers) {
          const dx = d.grabPos.x - me.wrapper.position.x;
          const dz = d.grabPos.z - me.wrapper.position.z;
          if (dx * dx + dz * dz < d.radius * d.radius && me.holdType !== d.kind)
            hint =
              d.kind === "beer" ? "▸ tap to grab a 🍺" : "▸ tap to grab a 🚬";
        }
      }
      if (hint) {
        prompt.style.display = "block";
        prompt.textContent = hint;
      } else {
        prompt.style.display = "none";
      }

      for (const r of remotes.values()) {
        const k = Math.min(1, dt * 10);
        r.x += (r.tx - r.x) * k;
        r.z += (r.tz - r.z) * k;
        r.ry = lerpAngle(r.ry, r.try_, k);
        r.av.wrapper.position.set(r.x, avatarY, r.z);
        r.av.wrapper.rotation.y = r.ry;
        setClip(r.av, r.moving ? "walk" : "bounce");
        animateAvatar(r.av, dt);
        updateBlink(r.av, dt);
        updateHold(r.av, dt, false);
      }

      // network send (throttled, on change)
      sendAcc += dt;
      if (sendAcc >= 1 / SEND_HZ) {
        sendAcc = 0;
        const px = me.wrapper.position.x,
          pz = me.wrapper.position.z;
        if (
          Math.abs(px - lastSent.x) > 0.01 ||
          Math.abs(pz - lastSent.z) > 0.01 ||
          Math.abs(myYaw - lastSent.ry) > 0.01 ||
          moving !== lastSent.moving
        ) {
          net.sendMove(px, pz, myYaw, moving);
          lastSent = { x: px, z: pz, ry: myYaw, moving };
        }
      }

      // fade any building mesh between the camera and the avatar. Rays reliably
      // catch the big flat walls but slip past the thin wainscot, so when a wall
      // goes see-through, drag its molding/wainscot along with it.
      // The occlusion ray is camera->head; both are static most frames (the camera
      // only orbits on drag). Re-run the scene-wide multipick only when one moved,
      // else reuse the cached occSet — the fade lerp below still runs every frame.
      const camMoved =
        !_occCam ||
        BABYLON.Vector3.DistanceSquared(camera.position, _occCam) > 1e-5;
      const charMoved =
        !_occChar ||
        BABYLON.Vector3.DistanceSquared(me.wrapper.position, _occChar) > 1e-5;
      if (camMoved || charMoved) {
        (_occCam = _occCam || new BABYLON.Vector3()).copyFrom(camera.position);
        (_occChar = _occChar || new BABYLON.Vector3()).copyFrom(
          me.wrapper.position,
        );
        occSet.clear();
        const toHead = me.wrapper.position
          .add(new BABYLON.Vector3(0, 0.9, 0))
          .subtract(camera.position);
        const distCam = toHead.length();
        if (distCam > 0.001) {
          occRay.origin.copyFrom(camera.position);
          occRay.direction.copyFrom(toHead.scale(1 / distCam));
          occRay.length = Math.max(0, distCam - 1.2);
          const picks = scene.multiPickWithRay(occRay, occPredicate);
          if (picks)
            for (const p of picks) if (p.pickedMesh) occSet.add(p.pickedMesh);
          for (const m of [...occSet]) {
            const wall = /^cream_wall_([nsew])/.exec(m.name);
            if (wall) for (const w of wainscotByWall[wall[1]]) occSet.add(w);
          }
        }
      }

      // horizontal parallax on the window vistas: slide the painted scene with
      // the camera's position along each window's wall, for an illusion of depth
      for (const w of parallaxWindows) {
        const s = BABYLON.Vector3.Dot(
          camera.position.subtract(w.center),
          w.along,
        );
        w.tex.uOffset = clamp(0.09 + s * 0.006, 0, 0.18);
      }
      const fk = Math.min(1, dt * 12);
      for (const m of clubMeshes) {
        const goal = occSet.has(m) ? 0.22 : 1.0;
        m.visibility += (goal - m.visibility) * fk;
        // Snap when within a hair of the target. The lerp only ASYMPTOTES toward
        // 1.0, so a restored mesh would sit at 0.999… forever — and any visibility
        // below 1.0 keeps it in Babylon's transparent pass, where the wainscot
        // z-fights its wall and flickers/vanishes. Exactly 1.0 = opaque again.
        if (Math.abs(m.visibility - goal) < 0.012) m.visibility = goal;
      }

      updateTags(scene, engine, camera, me, remotes, net.playerId);
    });

    engine.runRenderLoop(() => scene.render());
    addEventListener("resize", () => engine.resize());
    Shared.hideBoot();
    Shared.roomFX.enter(); // iris open now the room is built (no-op on cold loads)

    function goToDoor(kind) {
      const d = doors.find((dd) => dd.kind === kind);
      if (!d || !d.url) return;
      // Carry whatever you're holding through the door. Rooms are separate page
      // loads, so stash the current hold and re-equip it on the next room's load.
      localStorage.setItem("ballsHold", me.holdType);
      net.close();
      // Iris out on the door itself; stamp this room's id so the next page
      // spawns us just inside its matching return door (see arrival above).
      Shared.roomFX.leave(d.url, { from: ROOM, at: doorScreenXY(d) });
    }

    // A door's centre in CSS pixels, for centring the iris wipe on it.
    function doorScreenXY(d) {
      const p = BABYLON.Vector3.Project(
        d.pos.add(new BABYLON.Vector3(0, 1.2, 0)), // door mid-height
        BABYLON.Matrix.Identity(),
        scene.getTransformMatrix(),
        camera.viewport.toGlobal(
          engine.getRenderWidth(),
          engine.getRenderHeight(),
        ),
      );
      const r = engine.getRenderingCanvas().getBoundingClientRect();
      return {
        x:
          r.left +
          Shared.clamp((p.x / engine.getRenderWidth()) * r.width, 0, r.width),
        y:
          r.top +
          Shared.clamp(
            (p.y / engine.getRenderHeight()) * r.height,
            0,
            r.height,
          ),
      };
    }
  }

  // ---- networking module -----------------------------------------------------
  function ClubhouseNet(url, name, area) {
    this.url = url;
    this.name = name;
    this.area = area || 0;
    this.ws = null;
    this.playerId = null;
    this.offline = false;
    this.seq = 0;
    this.onSnapshot = null;
    this.onChat = null;
    this.onReady = null; // fired after join is acknowledged (and on every reconnect)
    this._intentionalClose = false; // set by close() so we don't fight a deliberate leave
    this._reconnectDelay = 0; // ms; grows on repeated failures (see _scheduleReconnect)
    this._reconnectTimer = null;
  }
  ClubhouseNet.prototype.connect = function () {
    this._intentionalClose = false;
    let ws;
    try {
      ws = new WebSocket(this.url);
    } catch {
      this.offline = true;
      this._scheduleReconnect();
      return;
    }
    this.ws = ws;
    ws.onopen = () => {
      this.offline = false;
      this._reconnectDelay = 0; // a good connection resets the backoff
      this._send({ t: "auth", token: "" });
      this._send({ t: "join", name: this.name });
    };
    ws.onmessage = (ev) => {
      let m;
      try {
        m = JSON.parse(ev.data);
      } catch {
        return;
      }
      // A malformed frame must not throw mid-mutation and wedge the client: the
      // handlers below touch untrusted server fields + Babylon/DOM state.
      try {
        if (m.t === "welcome") {
          this.playerId = m.playerId;
          this.sendArea(this.area);
          if (this.onReady) this.onReady();
        } else if (m.t === "gameSnapshot") {
          if (this.onSnapshot)
            this.onSnapshot(m.players || [], m.broadcasts || []);
        } else if (m.t === "chat") {
          if (this.onChat) this.onChat(m);
        }
        // ignore bootstrapRequired and anything else
      } catch (e) {
        console.warn("clubhouse: dropped a bad server message", e);
      }
    };
    ws.onerror = () => {
      this.offline = true;
    };
    ws.onclose = () => {
      this.offline = true;
      this.ws = null;
      if (!this._intentionalClose) this._scheduleReconnect();
    };
  };
  // Exponential backoff reconnect (1s → 2s → … capped at 15s). onReady re-fires on
  // the fresh welcome and re-announces hold/hat/skin/face so remotes re-sync.
  ClubhouseNet.prototype._scheduleReconnect = function () {
    if (this._intentionalClose || this._reconnectTimer) return;
    this._reconnectDelay = Math.min(
      this._reconnectDelay ? this._reconnectDelay * 2 : 1000,
      15000,
    );
    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;
      this.connect();
    }, this._reconnectDelay);
  };
  ClubhouseNet.prototype._send = function (obj) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      try {
        this.ws.send(JSON.stringify(obj));
      } catch {}
    }
  };
  // movement reuses the `in` input message: mx=x, mz=z, yaw, jump=moving
  ClubhouseNet.prototype.sendMove = function (x, z, yaw, moving) {
    this._send({
      t: "in",
      seq: ++this.seq,
      mx: x,
      mz: z,
      yaw: yaw,
      jump: !!moving,
    });
  };
  ClubhouseNet.prototype.sendChat = function (text) {
    this._send({ t: "chat", text: String(text).slice(0, 200) });
  };
  // tell the server which room we're in so clients can filter who they see
  ClubhouseNet.prototype.sendArea = function (area) {
    this._send({ t: "action", action: "area", direction: area });
  };
  // tell everyone what we're holding (0=none, 1=beer, 2=cig)
  ClubhouseNet.prototype.sendHat = function (i) {
    this._send({ t: "action", action: "hat", direction: i });
  };

  ClubhouseNet.prototype.sendSkin = function (i) {
    this._send({ t: "action", action: "skin", direction: i });
  };

  // The drawn face rides the action message's string field ("" clears it); the
  // engine stores it per player and re-broadcasts it (also to late joiners).
  ClubhouseNet.prototype.sendFace = function (dataURL) {
    this._send({ t: "action", action: "face", message: dataURL || "" });
  };

  // Same shape for the locker room's ball-wrap image.
  ClubhouseNet.prototype.sendSkinImg = function (dataURL) {
    this._send({ t: "action", action: "skinimg", message: dataURL || "" });
  };

  ClubhouseNet.prototype.sendHold = function (code) {
    this._send({ t: "action", action: "hold", direction: code });
  };
  ClubhouseNet.prototype.close = function () {
    this._intentionalClose = true;
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
    if (this.ws) {
      try {
        this.ws.close();
      } catch {}
      this.ws = null;
    }
  };

  // ---- DOM: chat feed, input, nametags, bubbles ------------------------------
  const tags = new Map(); // id -> div (nametag)
  const bubbles = new Map(); // id -> {el, until}
  let feedEl = null;

  function buildChatUI() {
    const wrap = document.createElement("div");
    Object.assign(wrap.style, {
      position: "absolute",
      left: "12px",
      top: "12px",
      width: "300px",
      maxWidth: "70vw",
      zIndex: "50",
      pointerEvents: "none",
      fontFamily: "DrawvidHand, Comic Sans MS, cursive, sans-serif",
    });
    // The input lives in a FORM so the iOS software keyboard's return key
    // reliably submits (a bare keydown listener misses it on some Safari
    // versions); the caller wires the submit handler.
    const form = document.createElement("form");
    form.style.pointerEvents = "none";
    const input = document.createElement("input");
    input.type = "text";
    input.placeholder = "chat...";
    input.maxLength = 200;
    input.enterKeyHint = "send"; // label the iOS return key
    input.autocomplete = "off";
    Object.assign(input.style, {
      width: "100%",
      boxSizing: "border-box",
      pointerEvents: "auto",
      padding: "8px 12px",
      borderRadius: "16px",
      border: "3px solid #476a23",
      background: "rgba(255,255,255,0.9)",
      // Form controls don't inherit font-family — set it so the input + its
      // placeholder use the handwriting font too.
      fontFamily: "DrawvidHand, Comic Sans MS, cursive, sans-serif",
      // ≥16px: below that, iOS Safari force-zooms the page when the input is
      // focused — the zoom then sticks and fights the orbit controls.
      fontSize: "16px",
      outline: "none",
    });
    // feed sits BELOW the entry, newest on top, older scrolling downward; the
    // history stays readable down to ~50% of the page, then fades out at its
    // bottom edge; scrollable to read older lines
    // Collapse/expand toggle — the log can be hidden to unclutter the view.
    const toggle = document.createElement("div");
    Object.assign(toggle.style, {
      marginTop: "6px",
      alignSelf: "flex-start",
      padding: "1px 8px",
      fontSize: "20px",
      color: "#fff",
      textShadow: "1px 1px 0 rgba(0,0,0,0.9), 0 0 4px rgba(0,0,0,0.9)",
      background: "rgba(0,0,0,0.35)",
      borderRadius: "8px",
      cursor: "pointer",
      pointerEvents: "auto",
      userSelect: "none",
    });

    // OG-Minecraft style log: plain white "username: message", newest on top,
    // grows to half the viewport then scrolls. No bubbles, no mask fade.
    feedEl = document.createElement("div");
    Object.assign(feedEl.style, {
      marginTop: "6px",
      maxHeight: "50vh",
      overflowY: "auto",
      display: "flex",
      flexDirection: "column",
      gap: "2px",
      fontSize: "30px",
      lineHeight: "1.2",
      color: "#fff",
      pointerEvents: "auto",
      scrollbarWidth: "none", // thin/hidden scrollbar (still scrollable)
    });

    let collapsed = false;
    const renderToggle = () =>
      (toggle.textContent = (collapsed ? "▸" : "▾") + " chat");
    renderToggle();
    toggle.onclick = () => {
      collapsed = !collapsed;
      feedEl.style.display = collapsed ? "none" : "flex";
      renderToggle();
    };

    form.appendChild(input);
    wrap.appendChild(form);
    wrap.appendChild(toggle);
    wrap.appendChild(feedEl);
    document.body.appendChild(wrap);
    return { input, form };
  }

  function pushFeed(text) {
    if (!feedEl) return;
    const line = document.createElement("div");
    line.textContent = text; // already "username: message"
    Object.assign(line.style, {
      alignSelf: "flex-start",
      maxWidth: "100%",
      flex: "0 0 auto",
      color: "#fff",
      textShadow: "1px 1px 0 rgba(0,0,0,0.9), 0 0 3px rgba(0,0,0,0.9)",
      whiteSpace: "normal",
      wordBreak: "break-word",
    });
    feedEl.insertBefore(line, feedEl.firstChild); // newest on top
    while (feedEl.children.length > 40) feedEl.removeChild(feedEl.lastChild);
    feedEl.scrollTop = 0;
  }

  function makeTag(id, name) {
    const d = document.createElement("div");
    d.textContent = name;
    Object.assign(d.style, {
      position: "absolute",
      // Anchored at its TOP-centre so the name sits BELOW the projected point
      // (which updateTags puts at the player's feet on the ground).
      transform: "translate(-50%, 0)",
      color: "#fff",
      fontSize: "30px",
      fontWeight: "bold",
      fontFamily: "DrawvidHand, Comic Sans MS, cursive, sans-serif",
      textShadow: "1px 1px 0 rgba(0,0,0,0.9), 0 0 4px rgba(0,0,0,0.9)",
      whiteSpace: "nowrap",
      pointerEvents: "none",
    });
    document.getElementById("overlay").appendChild(d);
    tags.set(id, d);
  }
  function removeTag(id) {
    const d = tags.get(id);
    if (d) d.remove();
    tags.delete(id);
  }

  // ---- speech bubbles: assets/speech_bubble.png, text shaped into the round
  // part of the balloon. DOM-projected over the head, so it's always
  // camera-facing (billboarded) for free.
  const BUBBLE_PX = 188; // on-screen size of the square bubble sprite (enlarged for 2x text)
  // The balloon's circle as fractions of the sprite square; the tail hangs
  // below-right of it and its tip anchors on the speaker's head.
  const BUB = { cx: 0.465, cy: 0.415, r: 0.385 };
  const BUB_FLEX_MAX = 40; // chars: short lines centre; longer get arc-shaped

  // shape-outside polygons that confine text to the circle: each float fills
  // half of the square text box, its inner edge tracing the circle's arc.
  function bubbleArc(side) {
    const pts = [];
    for (let a = 90; a <= 270; a += 12) {
      const rad = (a * Math.PI) / 180;
      const y = (50 + 50 * Math.sin(rad)).toFixed(1);
      const x = (
        side === "left" ? 100 + 100 * Math.cos(rad) : -100 * Math.cos(rad)
      ).toFixed(1);
      pts.push(x + "% " + y + "%");
    }
    return side === "left"
      ? `polygon(${pts.join(",")}, 0% 0%, 0% 100%)`
      : `polygon(${pts.join(",")}, 100% 0%, 100% 100%)`;
  }
  const BUB_SHAPE_L = bubbleArc("left");
  const BUB_SHAPE_R = bubbleArc("right");

  function showBubble(id, text) {
    removeBubble(id);
    const el = document.createElement("div");
    Object.assign(el.style, {
      position: "absolute",
      // centred above the speaker's head (the tail still reads as pointing
      // down at them; anchoring by the tail tip shifted the balloon left)
      transform: "translate(-50%,-97%)",
      width: BUBBLE_PX + "px",
      height: BUBBLE_PX + "px",
      backgroundImage: "url('assets/speech_bubble.png')",
      backgroundSize: "100% 100%",
      pointerEvents: "none",
      fontFamily: "DrawvidHand, Comic Sans MS, cursive, sans-serif",
    });
    const txt = document.createElement("div");
    Object.assign(txt.style, {
      position: "absolute",
      left: (BUB.cx - BUB.r) * 100 + "%",
      top: (BUB.cy - BUB.r) * 100 + "%",
      width: BUB.r * 2 * 100 + "%",
      height: BUB.r * 2 * 100 + "%",
      borderRadius: "50%", // clips (and scrolls) in the circle's shape
      overflowY: "auto",
      overscrollBehavior: "contain",
      scrollbarWidth: "none",
      pointerEvents: "auto", // long text is scrollable inside the circle
      textAlign: "center",
      fontSize: "24px",
      lineHeight: "1.2",
      color: "#123",
    });
    if (text.length < BUB_FLEX_MAX) {
      Object.assign(txt.style, {
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: "0 14%",
        boxSizing: "border-box",
      });
      txt.textContent = text;
    } else {
      // long line: two shape-outside floats trace the circle's arcs so the
      // text lays out as a circle; anything past one "page" scrolls.
      for (const [shape, side] of [
        [BUB_SHAPE_L, "left"],
        [BUB_SHAPE_R, "right"],
      ]) {
        const f = document.createElement("div");
        Object.assign(f.style, {
          float: side,
          width: "50%",
          height: "100%",
          shapeOutside: shape,
        });
        txt.appendChild(f);
      }
      txt.appendChild(document.createTextNode(text));
    }
    el.appendChild(txt);
    document.getElementById("overlay").appendChild(el);
    // longer messages linger longer (they can need a scroll to read)
    bubbles.set(id, {
      el,
      until: Date.now() + 4200 + Math.max(0, text.length - 60) * 40,
    });
  }
  function removeBubble(id) {
    const b = bubbles.get(id);
    if (b) b.el.remove();
    bubbles.delete(id);
  }

  function projectToScreen(scene, engine, camera, worldPos) {
    const v = BABYLON.Vector3.Project(
      worldPos,
      BABYLON.Matrix.Identity(),
      scene.getTransformMatrix(),
      camera.viewport.toGlobal(
        engine.getRenderWidth(),
        engine.getRenderHeight(),
      ),
    );
    // behind camera?
    const toPt = worldPos.subtract(camera.position);
    if (BABYLON.Vector3.Dot(toPt, camera.getForwardRay().direction) < 0)
      return null;
    return v;
  }

  function updateTags(scene, engine, camera, me, remotes, _myId) {
    const dpr = engine.getHardwareScalingLevel ? 1 : 1;
    const now = Date.now();
    function place(map, id, wrapper, extraY) {
      const head = wrapper.position.clone();
      head.y += extraY;
      const p = projectToScreen(scene, engine, camera, head);
      const el = map.get(id);
      if (!el) return;
      const node = el.el || el;
      if (!p) {
        node.style.display = "none";
        return;
      }
      node.style.display = "block";
      node.style.left = p.x / dpr + "px";
      node.style.top = p.y / dpr + "px";
    }
    // Project at the player's feet (~floor) so the name sits UNDER them on the
    // ground; the tag is top-anchored so it hangs just below this point.
    // -0.67 ≈ AV_SCALE(0.8) * 0.84 (ball-centre height above the floor).
    for (const [id, r] of remotes) place(tags, id, r.av.wrapper, -0.67);
    for (const [id, b] of bubbles) {
      if (now > b.until) {
        removeBubble(id);
        continue;
      }
      const wrapper =
        id === "me"
          ? me.wrapper
          : remotes.get(id) && remotes.get(id).av.wrapper;
      if (!wrapper) {
        removeBubble(id);
        continue;
      }
      place(bubbles, id, wrapper, 1.9); // tail tip just over the head
    }
  }

  // Walk/hop keyframes [phase, yOffset, scaleXZ, scaleY] — Apple Royale's hop
  // (crouch → launch-stretch → peak → land → impact-squash), base pinned to floor.
  const WALK_KEYS = [
    [0.0, 0.0, 1.0, 1.0],
    [0.103, -0.16, 1.1, 0.84],
    [0.241, 0.21, 0.92, 1.16],
    [0.345, 0.4, 0.97, 1.06],
    [0.517, 0.22, 1.0, 1.0],
    [0.655, 0.0, 1.0, 1.0],
    [0.759, -0.2, 1.12, 0.8],
    [0.897, 0.06, 0.97, 1.06],
    [1.0, 0.0, 1.0, 1.0],
  ];
  function sampleWalk(phase) {
    for (let i = 1; i < WALK_KEYS.length; i++) {
      if (phase <= WALK_KEYS[i][0]) {
        const a = WALK_KEYS[i - 1],
          b = WALK_KEYS[i];
        const t = (phase - a[0]) / (b[0] - a[0] || 1);
        return {
          y: lerp(a[1], b[1], t),
          sxy: lerp(a[2], b[2], t),
          sz: lerp(a[3], b[3], t),
        };
      }
    }
    const l = WALK_KEYS[WALK_KEYS.length - 1];
    return { y: l[1], sxy: l[2], sz: l[3] };
  }
})();
