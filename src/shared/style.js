// style.js — avatar customization ("locker room" style) shared by game.js (the
// player ball), clubhouse.js (multiplayer avatars), and locker.js (the editor).
// One source of truth for the hat list, the ball-skin painters, the custom-face
// recipe, and localStorage persistence, so every mode renders the same look.
//
// Loaded as a plain <script> after materials.js, before the mode script
// (exposes window.BallsStyle). require()-able in Node for tests; BABYLON and
// Materials are only touched inside the builder functions at call time.
//
// Persistence keys (browser-local, like "ballsName"/"ballsHold"):
//   ballsHat     — index into HATS
//   ballsSkin    — index into SKINS
//   ballsFace    — png dataURL drawn in the locker room (absent = default smile)
//   ballsSkinImg — image dataURL wrapped around the ball (overrides ballsSkin)
//
// All hat geometry is authored in gball MODEL units (ball radius ~1, +z is the
// character's front). The eyes poke out on the upper front (up to y≈1.13), so
// hats sit high and tilt back a little to clear them.
(function (global) {
  const HATS = [
    { id: "none", label: "NO HAT" },
    { id: "tophat", label: "TOP HAT" },
    { id: "cap", label: "GOLF CAP" },
    { id: "crown", label: "CROWN" },
    { id: "beanie", label: "PROPELLER" },
    { id: "wizard", label: "WIZARD" },
    { id: "visor", label: "VISOR" },
  ];

  const SKINS = [
    { id: "golf", label: "GOLF BALL" }, // keeps gball.glb's own dimple texture
    { id: "basketball", label: "BASKETBALL" },
    { id: "tennis", label: "TENNIS" },
    { id: "8ball", label: "8-BALL" },
    { id: "soccer", label: "SOCCER" },
    { id: "beach", label: "BEACH BALL" },
  ];

  // An image dataURL bigger than this is refused everywhere — drawn faces,
  // stamped photos, and ball-wrap images alike (the cap keeps localStorage and
  // the world server honest; senders downscale/re-encode to fit).
  const FACE_MAX_BYTES = 300 * 1024;

  const cycle = (i, dir, n) => (((i + dir) % n) + n) % n;

  // Coerce anything (bad localStorage, hostile network) into a valid style.
  function normalizeStyle(raw) {
    const r = raw || {};
    const idx = (v, n) => {
      const i = typeof v === "string" ? parseInt(v, 10) : v;
      return Number.isInteger(i) && i >= 0 && i < n ? i : 0;
    };
    const img = (v) =>
      typeof v === "string" &&
      v.startsWith("data:image/") &&
      v.length <= FACE_MAX_BYTES
        ? v
        : null;
    return {
      hat: idx(r.hat, HATS.length),
      skin: idx(r.skin, SKINS.length),
      face: img(r.face),
      skinImg: img(r.skinImg),
    };
  }

  // storage is injectable for tests; defaults to the browser's localStorage.
  function loadStyle(storage) {
    const s =
      storage || (typeof localStorage !== "undefined" ? localStorage : null);
    if (!s) return normalizeStyle(null);
    try {
      return normalizeStyle({
        hat: s.getItem("ballsHat"),
        skin: s.getItem("ballsSkin"),
        face: s.getItem("ballsFace"),
        skinImg: s.getItem("ballsSkinImg"),
      });
    } catch (e) {
      return normalizeStyle(null);
    }
  }

  function saveStyle(style, storage) {
    const s =
      storage || (typeof localStorage !== "undefined" ? localStorage : null);
    if (!s) return;
    const st = normalizeStyle(style);
    try {
      s.setItem("ballsHat", String(st.hat));
      s.setItem("ballsSkin", String(st.skin));
      if (st.face) s.setItem("ballsFace", st.face);
      else s.removeItem("ballsFace");
      if (st.skinImg) s.setItem("ballsSkinImg", st.skinImg);
      else s.removeItem("ballsSkinImg");
    } catch (e) {
      // storage full/blocked — style just won't persist
    }
  }

  // ---- hats (procedural, flat PS1 materials) -------------------------------

  const hex = (h) => BABYLON.Color3.FromHexString(h);
  const cmat = (scene, h) => Materials.color("hat_" + h, scene, hex(h));

  // Build the hat for HATS[idx] as a TransformNode at the ball's local origin
  // (caller parents + scales it). Returns null for "none". Fresh materials per
  // call, so disposing the node (dispose(false, true)) frees everything.
  function buildHat(scene, idx) {
    const kind = (HATS[idx] || HATS[0]).id;
    if (kind === "none") return null;
    const M = BABYLON.MeshBuilder;
    const node = new BABYLON.TransformNode("hat_" + kind, scene);

    const cyl = (name, d, h, y, matHex, dTop) => {
      const m = M.CreateCylinder(
        name,
        {
          diameter: d,
          diameterTop: dTop != null ? dTop : d,
          height: h,
          tessellation: 20,
        },
        scene,
      );
      m.position.y = y;
      m.material = cmat(scene, matHex);
      m.parent = node;
      return m;
    };
    const box = (name, w, h, dpt, x, y, z, matHex) => {
      const m = M.CreateBox(name, { width: w, height: h, depth: dpt }, scene);
      m.position.set(x, y, z);
      m.material = cmat(scene, matHex);
      m.parent = node;
      return m;
    };
    const dome = (name, d, y, matHex) => {
      const m = M.CreateSphere(
        name,
        { diameter: d, slice: 0.5, segments: 10 },
        scene,
      );
      m.position.y = y;
      m.material = cmat(scene, matHex);
      m.parent = node;
      return m;
    };

    if (kind === "tophat") {
      cyl("brim", 1.55, 0.08, 1.02, "#1c1c22");
      cyl("tube", 0.95, 0.95, 1.52, "#1c1c22");
      cyl("band", 1.0, 0.16, 1.14, "#b3202c");
    } else if (kind === "cap") {
      dome("dome", 1.15, 0.98, "#2e8b48");
      cyl("button", 0.14, 0.06, 1.56, "#e1e44e");
      box("brim", 0.78, 0.05, 0.55, 0, 1.02, 0.72, "#246b38");
    } else if (kind === "crown") {
      cyl("ring", 1.0, 0.34, 1.08, "#e0b83a");
      for (let i = 0; i < 5; i++) {
        const a = (i / 5) * Math.PI * 2;
        const p = M.CreateCylinder(
          "pt" + i,
          {
            diameterBottom: 0.22,
            diameterTop: 0,
            height: 0.32,
            tessellation: 8,
          },
          scene,
        );
        p.position.set(Math.sin(a) * 0.4, 1.4, Math.cos(a) * 0.4);
        p.material = cmat(scene, "#e0b83a");
        p.parent = node;
      }
    } else if (kind === "beanie") {
      dome("dome", 1.12, 0.96, "#b3202c");
      cyl("stem", 0.09, 0.18, 1.6, "#e0b83a");
      const prop = new BABYLON.TransformNode("prop", scene);
      prop.parent = node;
      prop.position.y = 1.72;
      const b1 = M.CreateBox(
        "blade1",
        { width: 1.05, height: 0.05, depth: 0.16 },
        scene,
      );
      b1.material = cmat(scene, "#e1e44e");
      b1.parent = prop;
      const b2 = M.CreateBox(
        "blade2",
        { width: 0.16, height: 0.05, depth: 1.05 },
        scene,
      );
      b2.material = cmat(scene, "#4fc46a");
      b2.parent = prop;
      // idle propeller spin; unhooked automatically when the hat is disposed
      const obs = scene.onBeforeRenderObservable.add(() => {
        prop.rotation.y += scene.getEngine().getDeltaTime() * 0.004;
      });
      node.onDisposeObservable.add(() =>
        scene.onBeforeRenderObservable.remove(obs),
      );
    } else if (kind === "wizard") {
      cyl("brim", 1.5, 0.07, 1.0, "#4b2a7a");
      cyl("cone", 1.05, 1.15, 1.6, "#5b34a0", 0);
      cyl("band", 1.08, 0.14, 1.1, "#e0b83a");
    } else if (kind === "visor") {
      cyl("band", 1.1, 0.15, 0.92, "#f2f0e6");
      box("brim", 0.8, 0.05, 0.55, 0, 0.92, 0.7, "#2e8b48");
    }

    // Seat above the ball, tipped back so the front edge clears the eyes.
    node.rotation.x = -0.24;
    node.position.y = 0.02;
    return node;
  }

  // ---- ball skins (painted DynamicTextures) --------------------------------
  //
  // The gball ball mesh has a single non-tiling unwrap: u∈[0.125, 0.875] spans
  // the full 360° of longitude (so x=64 and x=448 on a 512px texture meet at
  // the back seam), v∈[0,1] runs pole to pole. Painters keep patterns periodic
  // over that 384px band and repeat into the margins so nothing shows a seam.
  const TEX = 512;
  const U0 = 64; // 0.125 * 512
  const BAND = 384; // (0.875 - 0.125) * 512

  // Draw `fn(ctx)` three times, offset by -BAND/0/+BAND, so the pattern is
  // continuous across the wrap seam and fills the unsampled margins.
  function periodic(ctx, fn) {
    for (const off of [-BAND, 0, BAND]) {
      ctx.save();
      ctx.translate(off, 0);
      fn(ctx);
      ctx.restore();
    }
  }

  const SKIN_PAINTERS = {
    basketball(ctx) {
      ctx.fillStyle = "#c96a1f";
      ctx.fillRect(0, 0, TEX, TEX);
      ctx.fillStyle = "rgba(120,60,15,0.5)"; // pebble speckle
      for (let i = 0; i < 900; i++) {
        ctx.fillRect(Math.random() * TEX, Math.random() * TEX, 2, 2);
      }
      ctx.strokeStyle = "#241505";
      ctx.lineWidth = 9;
      // seam hoops both ways (the gball unwrap's poles sit at the character's
      // sides, so a UV cross reads as classic basketball rings from any angle)
      for (const y of [TEX * 0.25, TEX * 0.5, TEX * 0.75]) {
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(TEX, y);
        ctx.stroke();
      }
      periodic(ctx, (c) => {
        for (const mx of [
          U0 + BAND * 0.25,
          U0 + BAND * 0.5,
          U0 + BAND * 0.75,
        ]) {
          c.beginPath();
          c.moveTo(mx, 0);
          c.lineTo(mx, TEX);
          c.stroke();
        }
      });
    },
    tennis(ctx) {
      ctx.fillStyle = "#cfe340";
      ctx.fillRect(0, 0, TEX, TEX);
      ctx.fillStyle = "rgba(255,255,255,0.35)"; // fuzz
      for (let i = 0; i < 700; i++) {
        ctx.fillRect(Math.random() * TEX, Math.random() * TEX, 2, 1);
      }
      ctx.strokeStyle = "#f4f4ee";
      ctx.lineWidth = 24;
      periodic(ctx, (c) => {
        c.beginPath(); // the wavy seam, period = the 384px band (k=2 waves)
        for (let x = U0 - 8; x <= U0 + BAND + 8; x += 8) {
          const y = TEX / 2 + 96 * Math.sin(((x - U0) / BAND) * Math.PI * 4);
          x === U0 - 8 ? c.moveTo(x, y) : c.lineTo(x, y);
        }
        c.stroke();
      });
    },
    "8ball"(ctx) {
      ctx.fillStyle = "#15151a";
      ctx.fillRect(0, 0, TEX, TEX);
      ctx.fillStyle = "#f2f0e6"; // number spot (lands on the ball's back)
      ctx.beginPath();
      ctx.arc(TEX / 2, 84, 62, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "#15151a";
      ctx.font = "bold 88px Arial";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.save(); // the unwrap is rotated ~90° on the ball — pre-rotate the 8
      ctx.translate(TEX / 2, 84);
      ctx.rotate(Math.PI / 2);
      ctx.fillText("8", 0, 6);
      ctx.restore();
    },
    soccer(ctx) {
      ctx.fillStyle = "#f4f4f0";
      ctx.fillRect(0, 0, TEX, TEX);
      ctx.fillStyle = "#1c1c22";
      const pent = (c, cx, cy, r, rot) => {
        c.beginPath();
        for (let i = 0; i < 5; i++) {
          const a = rot + (i / 5) * Math.PI * 2;
          const x = cx + Math.sin(a) * r;
          const y = cy - Math.cos(a) * r;
          i === 0 ? c.moveTo(x, y) : c.lineTo(x, y);
        }
        c.closePath();
        c.fill();
      };
      periodic(ctx, (c) => {
        const spots = [
          [0.1, 0.28, 0.5],
          [0.35, 0.2, 2.1],
          [0.62, 0.3, 4.0],
          [0.88, 0.24, 1.2],
          [0.22, 0.55, 3.3],
          [0.5, 0.52, 0.9],
          [0.78, 0.58, 5.1],
          [0.08, 0.78, 2.6],
          [0.42, 0.8, 4.4],
          [0.7, 0.82, 1.7],
          [0.95, 0.76, 3.9],
        ];
        for (const [ux, vy, rot] of spots)
          pent(c, U0 + ux * BAND, vy * TEX, 34, rot);
      });
    },
    beach(ctx) {
      const cols = [
        "#f4f4f0",
        "#b3202c",
        "#e1e44e",
        "#2e8b48",
        "#f4f4f0",
        "#3a6fd8",
      ];
      periodic(ctx, (c) => {
        const w = BAND / cols.length;
        cols.forEach((col, i) => {
          c.fillStyle = col;
          c.fillRect(U0 + i * w, 0, w + 1, TEX);
        });
      });
    },
  };

  // A fresh texture per call — avatars own their textures (remote-avatar cleanup
  // disposes them), so nothing here may be shared or cached.
  function makeSkinTexture(scene, idx) {
    const kind = (SKINS[idx] || SKINS[0]).id;
    const paint = SKIN_PAINTERS[kind];
    if (!paint) return null; // "golf" — keep the glb's own texture
    const dt = new BABYLON.DynamicTexture(
      "skin_" + kind,
      { width: TEX, height: TEX },
      scene,
      true,
      BABYLON.Texture.NEAREST_SAMPLINGMODE,
    );
    paint(dt.getContext());
    dt.update();
    return dt;
  }

  // A user image wrapped once around the ball. The unwrap reads ~90° rotated on
  // the surface (poles at the character's sides), so the image is drawn rotated
  // to compensate and repeated across the wrap seam. Fills in asynchronously
  // when the image decodes; the texture is usable immediately.
  function imageSkinTexture(scene, dataURL) {
    const dt = new BABYLON.DynamicTexture(
      "skin_img",
      { width: TEX, height: TEX },
      scene,
      true,
      BABYLON.Texture.TRILINEAR_SAMPLINGMODE,
    );
    const img = new Image();
    img.onload = () => {
      const c = dt.getContext();
      c.fillStyle = "#f2f0e6";
      c.fillRect(0, 0, TEX, TEX);
      periodic(c, (cc) => {
        cc.save();
        cc.translate(U0 + BAND / 2, TEX / 2);
        cc.rotate(Math.PI / 2);
        cc.scale(-1, 1); // the mirrored glb root flips the wrap's left/right
        cc.drawImage(img, -TEX / 2, -BAND / 2, TEX, BAND);
        cc.restore();
      });
      dt.update();
    };
    img.src = dataURL;
    return dt;
  }

  // The ball mesh inside a set of gball meshes (the node is named "gball").
  function findBallMesh(meshes) {
    return (meshes || []).find(
      (m) => m && m.name && /gball/i.test(m.name) && m.material,
    );
  }

  // Swap the ball's texture to SKINS[idx], or to a wrapped user image when
  // `imgDataURL` is set (it wins over the preset). Clones the material per mesh
  // (glb clones share materials — a shared swap would reskin every avatar).
  // Repeat calls dispose the previous clone; golf + no image restores the
  // original material.
  function applySkin(scene, meshes, idx, imgDataURL) {
    const mesh = findBallMesh(meshes);
    if (!mesh) return null;
    if (!mesh._origBallMat) mesh._origBallMat = mesh.material;
    if (mesh._ballsSkin) {
      mesh._ballsSkin.mat.dispose(true, true); // also frees the DynamicTexture
      mesh._ballsSkin = null;
    }
    const tex = imgDataURL
      ? imageSkinTexture(scene, imgDataURL)
      : makeSkinTexture(scene, idx);
    if (!tex) {
      mesh.material = mesh._origBallMat;
      return null;
    }
    const mat = mesh._origBallMat.clone("ballSkin_" + idx);
    if ("albedoTexture" in mat) mat.albedoTexture = tex;
    else mat.diffuseTexture = tex;
    if ("metallic" in mat) mat.metallic = 0;
    if ("roughness" in mat) mat.roughness = 0.9;
    // The glb root mirrors X, so the ball's winding is inverted — the original
    // material renders it with culling OFF. The clone must match or the whole
    // ball disappears (backface-culled inside-out).
    mat.backFaceCulling = mesh._origBallMat.backFaceCulling;
    mat.sideOrientation = mesh._origBallMat.sideOrientation;
    mesh.material = mat;
    mesh._ballsSkin = { mat, tex };
    return mesh._ballsSkin;
  }

  // The custom drawn face as a texture — same recipe as Balls.faceTexture
  // (alpha + trilinear, invertY=false), sourced from a dataURL.
  function faceTextureFromDataURL(scene, dataURL) {
    if (!dataURL) return null;
    const t = BABYLON.Texture.CreateFromBase64String(
      dataURL,
      "customFace",
      scene,
      false,
      false,
      BABYLON.Texture.TRILINEAR_SAMPLINGMODE,
    );
    t.hasAlpha = true;
    return t;
  }

  global.BallsStyle = {
    HATS,
    SKINS,
    FACE_MAX_BYTES,
    cycle,
    normalizeStyle,
    loadStyle,
    saveStyle,
    buildHat,
    makeSkinTexture,
    imageSkinTexture,
    findBallMesh,
    applySkin,
    faceTextureFromDataURL,
  };
  if (typeof module !== "undefined" && module.exports)
    module.exports = global.BallsStyle;
})(typeof globalThis !== "undefined" ? globalThis : this);
