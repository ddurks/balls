// locker.js — the Locker Room: a rudimentary character editor reached through
// the Members-lounge door. Live Babylon preview of the gball avatar (idle bob +
// blink + slow turntable) with the customizations persisted instantly to
// localStorage via BallsStyle (style.js) and applied by every other mode:
//   in-scene ◀▶ arrows beside the hat and the ball cycle them on tap/click
//   drop an image on the preview (or 🖼 BALL IMAGE) — wraps it around the ball
//   FACE PAINT — draw on a 512×512 canvas (replaces the smile); drop a photo
//   in to move/resize then stamp it; 🪣 FILL flood-fills a region
// Desktop: preview left / paint right. Portrait: preview top / paint bottom.
// No networking here: the clubhouse re-announces the style on the next load.
(function () {
  "use strict";

  const ASSET_V = "14"; // keep in step with clubhouse.js (immutable /assets cache)
  const FACE_SIZE = 512; // matches the gball face texture + assets/faces PNGs

  const $ = (id) => document.getElementById(id);

  // Warm oak wainscot/floor + dark-green shag come from the shared generator
  // (src/shared/textures.js), so the locker room reads the same PS1-flat way as
  // the clubhouse. The locker wood is a seamless field (no plank lines).
  function woodTex(scene) {
    return Textures.wood(scene, {
      name: "lkWood",
      grainStrokes: 160,
      planks: 1,
    });
  }

  function shagTex(scene) {
    return Textures.shag(scene, { name: "lkShag" });
  }

  function buildRoom(scene, shadow) {
    const R = 6.0; // half-extent (walls 12 apart)
    const H = 3.4;
    const T = 0.3;
    const wood = Materials.flat("lkWoodMat", scene, woodTex(scene));
    const shag = Materials.flat("lkShagMat", scene, shagTex(scene));
    const cream = Materials.color(
      "lkCream",
      scene,
      new BABYLON.Color3(0.86, 0.75, 0.48),
      0.5,
    );
    const green = Materials.color(
      "lkGreen",
      scene,
      new BABYLON.Color3(0.13, 0.42, 0.22),
      0.32,
    );
    const dark = Materials.color(
      "lkDark",
      scene,
      new BABYLON.Color3(0.09, 0.09, 0.11),
      0.2,
    );
    const box = (name, w, h, d, x, y, z, mat, cast) => {
      const m = BABYLON.MeshBuilder.CreateBox(
        name,
        { width: w, height: h, depth: d },
        scene,
      );
      m.position.set(x, y, z);
      m.material = mat;
      m.isPickable = false;
      m.receiveShadows = true;
      if (cast && shadow) shadow.addShadowCaster(m);
      return m;
    };
    box("lkFloor", 2 * R, 0.2, 2 * R, 0, -0.1, 0, shag);
    box("lkCeil", 2 * R, 0.2, 2 * R, 0, H, 0, dark);
    // walls: full-height cream with a wood wainscot proud of the lower half —
    // baseboard, recessed panel field, chair rail, and vertical dividers, the
    // same molding profile as the clubhouse (heights in metres).
    const molding = (cx, cz, alongZ, inward) => {
      const L = 2 * R;
      const put = (name, along, len, y, h, thick) => {
        const px = alongZ ? cx + inward * (T / 2 + thick / 2) : along;
        const pz = alongZ ? along : cz + inward * (T / 2 + thick / 2);
        box(
          name,
          alongZ ? thick : len,
          h,
          alongZ ? len : thick,
          px,
          y,
          pz,
          wood,
        );
      };
      put("lkTrimBase", 0, L, 0.16, 0.32, 0.15);
      put("lkPanel", 0, L - 0.06, 1.02, 1.3, 0.05);
      put("lkTrimRail", 0, L, 1.76, 0.22, 0.18);
      const ndiv = 4;
      for (let i = 0; i <= ndiv; i++) {
        const a = -R + 2 * R * (i / ndiv);
        put("lkTrimDiv" + i, a, 0.16, 1.0, 1.34, 0.11);
      }
    };
    const wall = (cx, cz, alongZ, inward) => {
      box(
        "lkCream",
        alongZ ? T : 2 * R,
        H,
        alongZ ? 2 * R : T,
        cx,
        H / 2,
        cz,
        cream,
      );
      molding(cx, cz, alongZ, inward);
    };
    wall(0, -R, false, 1);
    wall(0, R, false, -1);
    wall(-R, 0, true, 1);
    wall(R, 0, true, -1);
    // wood-framed lockers with green doors (axis 'x' runs along x at z=wallCoord)
    const LW = 1.0,
      LH = 2.0,
      LD = 0.36;
    function lockerBank(count, wallCoord, inward, axis) {
      const start = -(count * LW) / 2 + LW / 2;
      for (let i = 0; i < count; i++) {
        const off = start + i * LW;
        const cx = axis === "x" ? off : wallCoord + inward * (LD / 2 + 0.02);
        const cz = axis === "x" ? wallCoord + inward * (LD / 2 + 0.02) : off;
        box(
          "lkLocker",
          axis === "x" ? LW : LD,
          LH,
          axis === "x" ? LD : LW,
          cx,
          LH / 2,
          cz,
          wood,
          true,
        );
        // green door, inset within the wood frame and proud of the carcass face
        const fx = axis === "x" ? cx : cx + inward * (LD / 2 + 0.01);
        const fz = axis === "x" ? cz + inward * (LD / 2 + 0.01) : cz;
        box(
          "lkDoor",
          axis === "x" ? LW - 0.14 : 0.05,
          LH - 0.16,
          axis === "x" ? 0.05 : LW - 0.14,
          fx,
          LH / 2,
          fz,
          green,
        );
        box(
          "lkHandle",
          0.06,
          0.22,
          0.06,
          axis === "x" ? cx + LW * 0.3 : fx + inward * 0.03,
          LH * 0.46,
          axis === "x" ? fz + inward * 0.03 : cz + LW * 0.3,
          dark,
        );
        for (let v = 0; v < 3; v++) {
          const vy = LH - 0.3 - v * 0.12;
          box(
            "lkVent",
            axis === "x" ? LW - 0.34 : 0.02,
            0.03,
            axis === "x" ? 0.02 : LW - 0.34,
            axis === "x" ? cx : fx + inward * 0.01,
            vy,
            axis === "x" ? fz + inward * 0.01 : cz,
            dark,
          );
        }
      }
    }
    lockerBank(6, -R + 0.02, 1, "x"); // back wall (main backdrop)
    lockerBank(6, R - 0.02, -1, "x"); // front wall (behind camera)
    lockerBank(6, -R + 0.02, 1, "z"); // left wall
    lockerBank(6, R - 0.02, -1, "z"); // right wall
    const glow = new BABYLON.StandardMaterial("lkGlow", scene);
    glow.emissiveColor = new BABYLON.Color3(1.0, 0.76, 0.47);
    glow.diffuseColor = new BABYLON.Color3(0, 0, 0);
    glow.specularColor = new BABYLON.Color3(0, 0, 0);
    glow.disableLighting = true;
    const Y = 2.65;
    const specs = [
      [-3, -R + 0.15, 0, 1],
      [3, -R + 0.15, 0, 1],
      [-3, R - 0.15, 0, -1],
      [3, R - 0.15, 0, -1],
      [-R + 0.15, -3, 1, 0],
      [-R + 0.15, 3, 1, 0],
      [R - 0.15, -3, -1, 0],
      [R - 0.15, 3, -1, 0],
    ];
    specs.forEach(([x, z, nx, nz], i) => {
      box(
        "lkScBr" + i,
        0.14,
        0.34,
        0.16,
        x + nx * 0.06,
        Y - 0.06,
        z + nz * 0.06,
        dark,
      );
      const bulb = BABYLON.MeshBuilder.CreateSphere(
        "lkScB" + i,
        { diameter: 0.24, segments: 10 },
        scene,
      );
      bulb.material = glow;
      bulb.position.set(x + nx * 0.2, Y + 0.06, z + nz * 0.2);
      bulb.isPickable = false;
      const L = new BABYLON.PointLight(
        "lkScL" + i,
        new BABYLON.Vector3(x + nx * 0.3, Y + 0.06, z + nz * 0.3),
        scene,
      );
      L.diffuse = new BABYLON.Color3(1.0, 0.79, 0.52);
      L.specular = new BABYLON.Color3(0, 0, 0);
      L.intensity = 0.62;
      L.range = 8;
    });
    // 8 sconces + key + hemi blow past Babylon's 4-lights-per-mesh default
    for (const m of scene.materials) m.maxSimultaneousLights = 12;
  }

  function whenReady() {
    if (typeof BABYLON === "undefined" || !BABYLON.Engine) {
      return setTimeout(whenReady, 30);
    }
    start().catch((e) => console.error("[locker] fatal", e));
  }
  whenReady();

  async function start() {
    const canvas = $("renderCanvas");
    const engine = new BABYLON.Engine(canvas, true);
    const scene = new BABYLON.Scene(engine);
    scene.clearColor = new BABYLON.Color4(0.1, 0.08, 0.07, 1);
    scene.ambientColor = new BABYLON.Color3(1, 1, 1);

    // ¾ framing on the character's face (front = +z, so camera alpha = π/2);
    // drag to orbit, wheel to zoom — clamped so the camera stays inside the room.
    const camera = new BABYLON.ArcRotateCamera(
      "cam",
      Math.PI / 2,
      1.2,
      4.6,
      new BABYLON.Vector3(0, 1.05, 0),
      scene,
    );
    camera.attachControl(canvas, true);
    camera.lowerRadiusLimit = 3.2;
    camera.upperRadiusLimit = 7.5;
    camera.lowerBetaLimit = 0.7;
    camera.upperBetaLimit = 1.46;
    camera.lowerAlphaLimit = camera.upperAlphaLimit = Math.PI / 2; // face the character (no orbit)
    camera.panningSensibility = 0; // no panning — keep the character framed
    camera.wheelPrecision = 40;

    // Offset the character into the open area the paint card leaves: to the left
    // in landscape (card on the right), upward in portrait (card on the bottom).
    function updateFraming() {
      const landscape = window.innerWidth >= window.innerHeight * 1.15;
      if (landscape) {
        camera.fov = 0.8;
        camera.radius = 4.6;
        camera.targetScreenOffset = new BABYLON.Vector2(-0.85, 0); // clear the card on the right
      } else {
        // portrait: the bottom card takes ~half the screen, so frame the whole
        // character (+ its ±1.15 side arrows) into the top half. Derive the
        // pull-back from the REAL canvas aspect (engine render size), not
        // window.innerWidth/Height — on iOS the canvas can render at a different
        // aspect (URL bar / DPR), which is what was cutting the arrows off.
        const a =
          engine.getRenderWidth() / Math.max(1, engine.getRenderHeight());
        camera.fov = 1.0;
        // half the visible width = radius*tan(fov/2)*aspect; keep it ≥ 1.85 so
        // the ±1.15 arrows sit well inside the frame edge (extra margin for iOS).
        camera.radius = Math.min(
          9.0,
          Math.max(4.6, 2.0 / (Math.tan(camera.fov / 2) * a)),
        );
        camera.targetScreenOffset = new BABYLON.Vector2(
          0,
          camera.radius * 0.23,
        );
      }
    }
    updateFraming();

    const hemi = new BABYLON.HemisphericLight(
      "hemi",
      new BABYLON.Vector3(0.25, 1, 0.15),
      scene,
    );
    hemi.intensity = 0.42;
    hemi.diffuse = new BABYLON.Color3(0.82, 0.84, 0.95);
    hemi.groundColor = new BABYLON.Color3(0.22, 0.2, 0.24);
    const key = new BABYLON.DirectionalLight(
      "key",
      new BABYLON.Vector3(-0.5, -1.05, 0.4),
      scene,
    );
    key.position = new BABYLON.Vector3(6, 18, -6);
    key.intensity = 0.55;
    key.diffuse = new BABYLON.Color3(1.0, 0.95, 0.84);
    const shadow = new BABYLON.ShadowGenerator(1024, key);
    shadow.usePoissonSampling = true; // PCF renders nothing in this Babylon build
    shadow.setDarkness(0.4);
    shadow.bias = 0.006;

    buildRoom(scene, shadow);

    // ---- the preview avatar (same wrapper→bob idiom as the clubhouse) ------
    const result = await Shared.loadModel("gball.glb", scene, {
      version: ASSET_V,
    });
    const wrapper = new BABYLON.TransformNode("wrapper", scene);
    const bob = new BABYLON.TransformNode("bob", scene);
    bob.parent = wrapper;
    for (const m of result.meshes) if (!m.parent) m.parent = bob;
    for (const m of result.meshes)
      if (m.getTotalVertices && m.getTotalVertices() > 0)
        shadow.addShadowCaster(m);
    wrapper.position.y = 0.84; // gball model half-height — ball rests on the mat

    let faceMesh = null;
    let eyelids = null;
    for (const m of result.meshes) {
      if (m.name && /face/i.test(m.name) && m.material && !faceMesh)
        faceMesh = m;
      if (m.name && /eyelid/i.test(m.name) && m.morphTargetManager) eyelids = m;
    }
    let faceMat = null;
    let faceOrigTex = null;
    let customFaceTex = null;
    if (faceMesh) {
      faceMat = faceMesh.material.clone("faceMat");
      faceMesh.material = faceMat;
      faceOrigTex = faceMat.albedoTexture || faceMat.diffuseTexture || null;
    }
    const setFaceTex = (tex) => {
      if (!faceMat) return;
      if ("albedoTexture" in faceMat) faceMat.albedoTexture = tex;
      else faceMat.diffuseTexture = tex;
    };

    let blink = null;
    let blinkIdx = -1;
    let blinkMgr = null;
    if (eyelids) {
      blinkMgr = eyelids.morphTargetManager;
      blinkIdx = Balls.findBlinkMorphIndex(blinkMgr);
      if (blinkIdx < 0 && blinkMgr.numTargets > 0)
        blinkIdx = blinkMgr.numTargets - 1;
      if (blinkIdx >= 0) blink = Balls.newBlinkState();
    }

    // ---- style state: every change saves + re-applies to the preview -------
    const state = BallsStyle.loadStyle();
    const save = () => BallsStyle.saveStyle(state);
    let hatNode = null;

    let chipT = null;
    function showChip(text) {
      const c = $("styleChip");
      c.textContent = text;
      c.style.opacity = "1";
      clearTimeout(chipT);
      chipT = setTimeout(() => (c.style.opacity = "0"), 1400);
    }

    function applyHat() {
      if (hatNode) {
        hatNode.dispose(false, true);
        hatNode = null;
      }
      hatNode = BallsStyle.buildHat(scene, state.hat);
      if (hatNode) {
        hatNode.parent = bob;
        for (const m of hatNode.getChildMeshes(false)) m.isPickable = false;
      }
    }
    function applySkin() {
      BallsStyle.applySkin(scene, result.meshes, state.skin, state.skinImg);
    }
    function applyFace() {
      if (customFaceTex) {
        customFaceTex.dispose();
        customFaceTex = null;
      }
      if (state.face) {
        customFaceTex = BallsStyle.faceTextureFromDataURL(scene, state.face);
        setFaceTex(customFaceTex);
      } else {
        setFaceTex(faceOrigTex);
      }
    }

    const cycleHat = (dir) => {
      state.hat = BallsStyle.cycle(state.hat, dir, BallsStyle.HATS.length);
      save();
      applyHat();
      showChip(BallsStyle.HATS[state.hat].label);
    };
    const cycleSkin = (dir) => {
      state.skinImg = null; // an arrow pick replaces a dropped image
      state.skin = BallsStyle.cycle(state.skin, dir, BallsStyle.SKINS.length);
      save();
      applySkin();
      showChip(BallsStyle.SKINS[state.skin].label);
    };
    $("doneBtn").onclick = () => {
      // Iris back to the lounge; the stamp spawns us beside its LOCKER ROOM door.
      Shared.roomFX.leave("index.html?room=vip", { from: "locker" });
    };

    // ---- in-scene white "aim" arrows beside the hat and the ball -----------
    // Stubby white versions of the gameplay trajectory arrow (arrow.glb): the
    // same asset recoloured white and squashed. The editor camera is locked
    // facing the character (tilt + zoom only), so the arrows sit at fixed
    // left/right spots and always read as ◀ ▶. The arrow's native geometry
    // points along local Z and is flat in local Y; the quaternions map that to
    // point along world ±X with its flat face toward the camera.
    // NOTE the camera's world-right is −X (alpha locked at π/2), so world +X is
    // SCREEN-LEFT: the "prev" (◀) arrow lives at +X and the "next" (▶) at −X.
    const arrowWhite = new BABYLON.StandardMaterial("arrowWhite", scene);
    arrowWhite.diffuseColor = new BABYLON.Color3(1, 1, 1);
    arrowWhite.emissiveColor = new BABYLON.Color3(0.72, 0.75, 0.8);
    arrowWhite.specularColor = new BABYLON.Color3(0, 0, 0);
    const Q_PLUSX = new BABYLON.Quaternion(0.5, 0.5, 0.5, 0.5); // points world +X (= screen-left)
    const Q_MINUSX = BABYLON.Quaternion.RotationAxis(
      BABYLON.Axis.Z,
      Math.PI,
    ).multiply(Q_PLUSX);
    const arrows = {};
    try {
      const ar = await Shared.loadModel("arrow.glb", scene, {
        version: ASSET_V,
      });
      const tmpl = ar.meshes[0];
      tmpl.setEnabled(false);
      const paint = (m) => {
        m.material = arrowWhite;
        m.isPickable = true;
        m.getChildMeshes().forEach((c) => {
          c.material = arrowWhite;
          c.isPickable = true;
        });
      };
      const make = (name, pointsScreenLeft) => {
        const a = tmpl.clone(name);
        a.setEnabled(true);
        a.parent = null;
        a.rotationQuaternion = (pointsScreenLeft ? Q_PLUSX : Q_MINUSX).clone();
        a.scaling = a.scaling.multiply(new BABYLON.Vector3(0.5, 0.5, 0.25)); // shrink + stubby
        paint(a);
        return a;
      };
      arrows.arrow_hat_prev = make("arrow_hat_prev", true);
      arrows.arrow_hat_next = make("arrow_hat_next", false);
      arrows.arrow_skin_prev = make("arrow_skin_prev", true);
      arrows.arrow_skin_next = make("arrow_skin_next", false);
    } catch (e) {
      console.warn("[locker] arrow.glb failed to load", e);
    }
    const HAT_ARROW_Y = 2.0; // beside the hat (world units; ball centre is 0.84)
    const BALL_ARROW_Y = 0.82;
    function placeArrows() {
      if (!arrows.arrow_hat_prev) return;
      // portrait is narrow, so the arrows hug the character (ball radius ≈ 0.88)
      const portrait = window.innerWidth < window.innerHeight * 1.15;
      const AX = portrait ? 1.15 : 1.5;
      // +X is screen-left (camera right is −X), so prev sits at +X, next at −X
      arrows.arrow_hat_prev.position.set(AX, HAT_ARROW_Y, 0);
      arrows.arrow_hat_next.position.set(-AX, HAT_ARROW_Y, 0);
      arrows.arrow_skin_prev.position.set(AX, BALL_ARROW_Y, 0);
      arrows.arrow_skin_next.position.set(-AX, BALL_ARROW_Y, 0);
    }
    placeArrows();
    scene.onPointerObservable.add((pi) => {
      if (pi.type !== BABYLON.PointerEventTypes.POINTERPICK) return;
      let m = pi.pickInfo && pi.pickInfo.pickedMesh;
      while (m && !/^arrow_(hat|skin)_(prev|next)$/.test(m.name || ""))
        m = m.parent;
      if (!m) return;
      if (m.name === "arrow_hat_prev") cycleHat(-1);
      else if (m.name === "arrow_hat_next") cycleHat(1);
      else if (m.name === "arrow_skin_prev") cycleSkin(-1);
      else if (m.name === "arrow_skin_next") cycleSkin(1);
    });

    // ---- images in: shared file → Image helper -----------------------------
    function readImageFile(file, cb) {
      if (!file || !/^image\//.test(file.type || "")) return;
      const fr = new FileReader();
      fr.onload = () => {
        const img = new Image();
        img.onload = () => cb(img);
        img.src = fr.result;
      };
      fr.readAsDataURL(file);
    }
    // Downscale + re-encode so the dataURL fits localStorage and the sync cap.
    function encodeScaled(img, max, mime, q) {
      const s = Math.min(1, max / Math.max(img.width, img.height));
      const c = document.createElement("canvas");
      c.width = Math.max(1, Math.round(img.width * s));
      c.height = Math.max(1, Math.round(img.height * s));
      const cx = c.getContext("2d");
      if (mime === "image/jpeg") {
        cx.fillStyle = "#fff"; // jpeg has no alpha channel
        cx.fillRect(0, 0, c.width, c.height);
      }
      cx.drawImage(img, 0, 0, c.width, c.height);
      return c.toDataURL(mime, q);
    }

    function setBallImage(img) {
      let url = encodeScaled(img, 512, "image/jpeg", 0.85);
      if (url.length > BallsStyle.FACE_MAX_BYTES)
        url = encodeScaled(img, 256, "image/jpeg", 0.8);
      if (url.length > BallsStyle.FACE_MAX_BYTES)
        return showChip("IMAGE TOO BIG");
      state.skinImg = url;
      save();
      applySkin();
      showChip("CUSTOM BALL");
    }
    canvas.addEventListener("dragover", (e) => {
      e.preventDefault();
      showChip("DROP TO WRAP THE BALL");
    });
    canvas.addEventListener("drop", (e) => {
      e.preventDefault();
      readImageFile(
        e.dataTransfer.files && e.dataTransfer.files[0],
        setBallImage,
      );
    });
    $("ballImgBtn").onclick = () => $("filePickBall").click();
    $("filePickBall").onchange = (e) => {
      readImageFile(e.target.files && e.target.files[0], setBallImage);
      e.target.value = "";
    };

    // ---- KidPix face paint --------------------------------------------------
    const faceCanvas = $("faceCanvas");
    const ctx = faceCanvas.getContext("2d", { willReadFrequently: true });
    ctx.lineCap = "round";
    ctx.lineJoin = "round";

    const COLORS = [
      "#1c1c22",
      "#f4f4f0",
      "#b3202c",
      "#e07a2a",
      "#e1e44e",
      "#2e8b48",
      "#3a6fd8",
      "#e88ac0",
    ];
    const BRUSH = { small: 14, big: 32 };
    let color = COLORS[0];
    let brush = BRUSH.small;
    let tool = "brush"; // "brush" | "eraser" | "bucket"
    const undoStack = [];
    let drawing = false;
    let last = null;
    let faceHold = 0; // seconds the turntable eases back to face the painter

    if (state.face) {
      const img = new Image();
      img.onload = () => ctx.drawImage(img, 0, 0, FACE_SIZE, FACE_SIZE);
      img.src = state.face;
    }

    const colorTools = $("colorTools");
    const dots = COLORS.map((c) => {
      const d = document.createElement("div");
      d.className = "dot";
      d.style.background = c;
      d.onclick = () => {
        color = c;
        if (tool === "eraser") tool = "brush";
        refreshTools();
      };
      colorTools.appendChild(d);
      return d;
    });
    function refreshTools() {
      dots.forEach((d, i) =>
        d.classList.toggle("sel", tool !== "eraser" && COLORS[i] === color),
      );
      $("eraserBtn").classList.toggle("sel", tool === "eraser");
      $("bucketBtn").classList.toggle("sel", tool === "bucket");
      $("brushSmall").classList.toggle("sel", brush === BRUSH.small);
      $("brushBig").classList.toggle("sel", brush === BRUSH.big);
    }
    $("brushSmall").onclick = () => {
      brush = BRUSH.small;
      if (tool === "bucket") tool = "brush";
      refreshTools();
    };
    $("brushBig").onclick = () => {
      brush = BRUSH.big;
      if (tool === "bucket") tool = "brush";
      refreshTools();
    };
    $("eraserBtn").onclick = () => {
      tool = tool === "eraser" ? "brush" : "eraser";
      refreshTools();
    };
    $("bucketBtn").onclick = () => {
      tool = tool === "bucket" ? "brush" : "bucket";
      refreshTools();
    };
    refreshTools();

    const snapshot = () => {
      undoStack.push(ctx.getImageData(0, 0, FACE_SIZE, FACE_SIZE));
      if (undoStack.length > 20) undoStack.shift();
    };
    $("undoBtn").onclick = () => {
      if (!undoStack.length) return;
      ctx.putImageData(undoStack.pop(), 0, 0);
      commitFace();
    };
    $("clearBtn").onclick = () => {
      snapshot();
      ctx.clearRect(0, 0, FACE_SIZE, FACE_SIZE);
      commitFace();
    };

    function hasInk() {
      const d = ctx.getImageData(0, 0, FACE_SIZE, FACE_SIZE).data;
      for (let i = 3; i < d.length; i += 4) if (d[i] > 8) return true;
      return false;
    }

    // canvas → style.face (dataURL) → preview texture, saved immediately
    function commitFace() {
      if (hasInk()) {
        let url = faceCanvas.toDataURL("image/png");
        if (url.length > BallsStyle.FACE_MAX_BYTES) {
          // busy drawing — re-encode at 256px before giving up
          const c2 = document.createElement("canvas");
          c2.width = c2.height = 256;
          c2.getContext("2d").drawImage(faceCanvas, 0, 0, 256, 256);
          const small = c2.toDataURL("image/png");
          if (small.length <= BallsStyle.FACE_MAX_BYTES) url = small;
        }
        if (url.length <= BallsStyle.FACE_MAX_BYTES) state.face = url;
      } else {
        state.face = null;
      }
      save();
      applyFace();
    }

    const posOn = (el, e) => {
      const r = el.getBoundingClientRect();
      return {
        x: ((e.clientX - r.left) / r.width) * FACE_SIZE,
        y: ((e.clientY - r.top) / r.height) * FACE_SIZE,
      };
    };
    const hexToRgb = (h) => [
      parseInt(h.slice(1, 3), 16),
      parseInt(h.slice(3, 5), 16),
      parseInt(h.slice(5, 7), 16),
    ];

    function floodFill(sx, sy) {
      sx |= 0;
      sy |= 0;
      const idata = ctx.getImageData(0, 0, FACE_SIZE, FACE_SIZE);
      const d = idata.data;
      const i0 = (sy * FACE_SIZE + sx) * 4;
      const t = [d[i0], d[i0 + 1], d[i0 + 2], d[i0 + 3]];
      const [fr, fg, fb] = hexToRgb(color);
      const TOL2 = 48 * 48;
      const seen = new Uint8Array(FACE_SIZE * FACE_SIZE);
      const stack = [sx, sy];
      while (stack.length) {
        const y = stack.pop();
        const x = stack.pop();
        if (x < 0 || y < 0 || x >= FACE_SIZE || y >= FACE_SIZE) continue;
        const p = y * FACE_SIZE + x;
        if (seen[p]) continue;
        seen[p] = 1;
        const i = p * 4;
        const dr = d[i] - t[0];
        const dg = d[i + 1] - t[1];
        const db = d[i + 2] - t[2];
        const da = d[i + 3] - t[3];
        if (dr * dr + dg * dg + db * db + da * da > TOL2) continue;
        d[i] = fr;
        d[i + 1] = fg;
        d[i + 2] = fb;
        d[i + 3] = 255;
        stack.push(x + 1, y, x - 1, y, x, y + 1, x, y - 1);
      }
      ctx.putImageData(idata, 0, 0);
    }

    function strokeTo(p) {
      ctx.globalCompositeOperation =
        tool === "eraser" ? "destination-out" : "source-over";
      ctx.strokeStyle = color;
      ctx.lineWidth = tool === "eraser" ? brush * 1.6 : brush;
      ctx.beginPath();
      ctx.moveTo(last.x, last.y);
      ctx.lineTo(p.x, p.y);
      ctx.stroke();
      last = p;
    }
    faceCanvas.addEventListener("pointerdown", (e) => {
      const p = posOn(faceCanvas, e);
      faceHold = 2.5;
      e.preventDefault();
      if (tool === "bucket") {
        snapshot();
        floodFill(p.x, p.y);
        commitFace();
        return;
      }
      faceCanvas.setPointerCapture(e.pointerId);
      snapshot();
      drawing = true;
      last = p;
      strokeTo(p); // a tap paints a dot
    });
    faceCanvas.addEventListener("pointermove", (e) => {
      if (!drawing) return;
      strokeTo(posOn(faceCanvas, e));
      faceHold = 2.5;
    });
    const endStroke = () => {
      if (!drawing) return;
      drawing = false;
      commitFace();
    };
    faceCanvas.addEventListener("pointerup", endStroke);
    faceCanvas.addEventListener("pointercancel", endStroke);

    // ---- dropped photo → move/resize → stamp into the face -----------------
    const stampCanvas = $("stampCanvas");
    const sctx = stampCanvas.getContext("2d");
    const HANDLE = 26; // corner-handle radius (512-space px)
    let stamp = null; // {img, x, y, w, h} in face-canvas coords
    let stampDrag = null;

    function startStamp(img) {
      const s = Math.min(1, 320 / Math.max(img.width, img.height));
      stamp = {
        img,
        w: img.width * s,
        h: img.height * s,
        x: (FACE_SIZE - img.width * s) / 2,
        y: (FACE_SIZE - img.height * s) / 2,
      };
      stampCanvas.style.pointerEvents = "auto"; // blocks painting while placing
      $("stampBar").classList.add("on");
      drawStampOverlay();
      faceHold = 3;
    }
    function endStampMode() {
      stamp = null;
      stampDrag = null;
      sctx.clearRect(0, 0, FACE_SIZE, FACE_SIZE);
      stampCanvas.style.pointerEvents = "none";
      $("stampBar").classList.remove("on");
    }
    const stampCorners = () => [
      [stamp.x, stamp.y],
      [stamp.x + stamp.w, stamp.y],
      [stamp.x, stamp.y + stamp.h],
      [stamp.x + stamp.w, stamp.y + stamp.h],
    ];
    function drawStampOverlay() {
      sctx.clearRect(0, 0, FACE_SIZE, FACE_SIZE);
      if (!stamp) return;
      sctx.drawImage(stamp.img, stamp.x, stamp.y, stamp.w, stamp.h);
      sctx.strokeStyle = "#2e8b48";
      sctx.lineWidth = 4;
      sctx.setLineDash([12, 8]);
      sctx.strokeRect(stamp.x, stamp.y, stamp.w, stamp.h);
      sctx.setLineDash([]);
      for (const [cx, cy] of stampCorners()) {
        sctx.fillStyle = "#fff";
        sctx.strokeStyle = "#12572a";
        sctx.lineWidth = 3;
        sctx.beginPath();
        sctx.arc(cx, cy, HANDLE / 2, 0, Math.PI * 2);
        sctx.fill();
        sctx.stroke();
      }
    }
    stampCanvas.addEventListener("pointerdown", (e) => {
      if (!stamp) return;
      const p = posOn(stampCanvas, e);
      stampCanvas.setPointerCapture(e.pointerId);
      const cs = stampCorners();
      let corner = -1;
      for (let i = 0; i < 4; i++) {
        if (Math.hypot(p.x - cs[i][0], p.y - cs[i][1]) <= HANDLE) corner = i;
      }
      if (corner >= 0) {
        // uniform scale around the opposite corner
        stampDrag = {
          mode: "scale",
          anchor: cs[3 - corner],
          orig: { ...stamp },
          from: cs[corner],
        };
      } else if (
        p.x >= stamp.x &&
        p.x <= stamp.x + stamp.w &&
        p.y >= stamp.y &&
        p.y <= stamp.y + stamp.h
      ) {
        stampDrag = { mode: "move", start: p, orig: { ...stamp } };
      }
      faceHold = 3;
      e.preventDefault();
    });
    stampCanvas.addEventListener("pointermove", (e) => {
      if (!stamp || !stampDrag) return;
      const p = posOn(stampCanvas, e);
      const o = stampDrag.orig;
      if (stampDrag.mode === "move") {
        stamp.x = o.x + (p.x - stampDrag.start.x);
        stamp.y = o.y + (p.y - stampDrag.start.y);
      } else {
        const [ax, ay] = stampDrag.anchor;
        const d0 =
          Math.hypot(stampDrag.from[0] - ax, stampDrag.from[1] - ay) || 1;
        const k = Math.max(0.08, Math.hypot(p.x - ax, p.y - ay) / d0);
        stamp.w = o.w * k;
        stamp.h = o.h * k;
        stamp.x = ax - (ax - o.x) * k;
        stamp.y = ay - (ay - o.y) * k;
      }
      drawStampOverlay();
      faceHold = 3;
    });
    const endStampDrag = () => (stampDrag = null);
    stampCanvas.addEventListener("pointerup", endStampDrag);
    stampCanvas.addEventListener("pointercancel", endStampDrag);
    $("stampOk").onclick = () => {
      if (!stamp) return;
      snapshot();
      ctx.drawImage(stamp.img, stamp.x, stamp.y, stamp.w, stamp.h);
      endStampMode();
      commitFace();
    };
    $("stampNo").onclick = endStampMode;

    // photo in: drop on the easel, or the 🖼 PHOTO button (mobile has no drag)
    const easel = $("easel");
    easel.addEventListener("dragover", (e) => {
      e.preventDefault();
      e.stopPropagation();
      easel.classList.add("dropping");
    });
    easel.addEventListener("dragleave", () =>
      easel.classList.remove("dropping"),
    );
    easel.addEventListener("drop", (e) => {
      e.preventDefault();
      e.stopPropagation();
      easel.classList.remove("dropping");
      readImageFile(
        e.dataTransfer.files && e.dataTransfer.files[0],
        startStamp,
      );
    });
    $("faceImgBtn").onclick = () => $("filePickFace").click();
    $("filePickFace").onchange = (e) => {
      readImageFile(e.target.files && e.target.files[0], startStamp);
      e.target.value = "";
    };

    // ghost guide: the default smile, faint, under the drawing layer (never
    // exported) — so you can see where the mouth goes before painting over it.
    const ghostCtx = () => $("ghostCanvas").getContext("2d");
    if (faceOrigTex) {
      BABYLON.Texture.WhenAllReady([faceOrigTex], () => {
        Promise.resolve(faceOrigTex.readPixels())
          .then((pix) => {
            if (!pix) return;
            const size = faceOrigTex.getSize();
            const tmp = document.createElement("canvas");
            tmp.width = size.width;
            tmp.height = size.height;
            const id = new ImageData(
              new Uint8ClampedArray(pix.buffer, pix.byteOffset, pix.byteLength),
              size.width,
              size.height,
            );
            tmp.getContext("2d").putImageData(id, 0, 0);
            // readPixels comes back top-down (Babylon un-flips it) — draw as-is
            // so the ghost matches the orientation toDataURL() exports.
            ghostCtx().drawImage(tmp, 0, 0, FACE_SIZE, FACE_SIZE);
          })
          .catch(() => {}); // no ghost — the checker backdrop is guide enough
      });
    }

    applyHat();
    applySkin();
    applyFace();

    // ---- render loop: idle bob + blink + turntable -------------------------
    let t = Math.random() * 3;
    engine.runRenderLoop(() => {
      const dt = Math.min(engine.getDeltaTime() / 1000, 0.1);
      t += dt * 0.8;
      const phase = t - Math.floor(t);
      const u = 0.5 - 0.5 * Math.cos(2 * Math.PI * phase); // smooth 0→1→0 bob
      bob.position.y = 0.12 * u;
      bob.scaling.set(1 - 0.015 * u, 1 + 0.03 * u, 1 - 0.015 * u);
      if (blink && blinkIdx >= 0) {
        const tgt = blinkMgr.getTarget(blinkIdx);
        if (tgt) tgt.influence = Balls.updateBlink(blink, dt);
      }
      if (faceHold > 0) {
        faceHold -= dt;
        wrapper.rotation.y += (0 - wrapper.rotation.y) * Math.min(1, dt * 6);
      } else {
        wrapper.rotation.y += dt * 0.45;
        if (wrapper.rotation.y > Math.PI) wrapper.rotation.y -= 2 * Math.PI;
      }
      scene.render();
    });
    const relayout = () => {
      engine.resize();
      updateFraming();
      placeArrows();
    };
    addEventListener("resize", relayout);
    addEventListener("orientationchange", relayout);
    // iOS fires this (not always `resize`) when the URL bar shows/hides
    if (window.visualViewport)
      window.visualViewport.addEventListener("resize", relayout);
    Shared.roomFX.enter();
  }
})();
