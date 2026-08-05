// ui.js — CircleUIManager, UIManager, PinManager, CourseHUD, CourseUI, BallsMenu, Scoreboard.
// Split out of game.js; loaded as a plain <script> before game.js (see game.html),
// and require()-able in Node for unit tests. Cross-module refs resolve via globals.
(function (global) {
  // ─── UNIFIED CIRCLE UI MANAGER ──────────────────────────────────────────────

  class CircleUIManager {
    static FLAG_PATHS = [
      "assets/flag/flag.png",
      "assets/flag/flag-1.png",
      "assets/flag/flag-2.png",
      "assets/flag/flag-3.png",
      "assets/flag/flag-4.png",
      "assets/flag/flag-5.png",
      "assets/flag/flag-6.png",
    ];

    static flagImages = new Map();
    static flagDataUrls = new Map();
    static flagAssetsPromise = null;

    static ensureFlagAssetsLoaded() {
      if (CircleUIManager.flagAssetsPromise) {
        return CircleUIManager.flagAssetsPromise;
      }

      CircleUIManager.flagAssetsPromise = Promise.all(
        CircleUIManager.FLAG_PATHS.map(
          (path, index) =>
            new Promise((resolve, reject) => {
              const img = new Image();

              img.onload = () => {
                const canvas = document.createElement("canvas");
                canvas.width = img.width;
                canvas.height = img.height;
                const ctx = canvas.getContext("2d");

                if (!ctx) {
                  reject(new Error(`Failed to create flag canvas for ${path}`));
                  return;
                }

                ctx.drawImage(img, 0, 0);
                CircleUIManager.flagImages.set(index, img);
                CircleUIManager.flagDataUrls.set(
                  index,
                  canvas.toDataURL("image/png"),
                );
                resolve();
              };

              img.onerror = () => {
                reject(new Error(`Failed to load flag asset: ${path}`));
              };

              img.src = path;
            }),
        ),
      );

      return CircleUIManager.flagAssetsPromise;
    }

    constructor(modeToggleCallback = null) {
      this.modeToggleCallback = modeToggleCallback;

      CircleUIManager.ensureFlagAssetsLoaded().catch((error) => {
        console.warn(error.message);
      });
      const scale = CONFIG.SCREEN.UI_SCALE;
      const root = document.documentElement;
      root.style.setProperty("--ui-size", 150 * scale + "px");
      root.style.setProperty("--ui-margin", 15 * scale + "px");
      root.style.setProperty("--ui-border-width", 6 * scale + "px");
      root.style.setProperty("--ui-btn-size", 40 * scale + "px");
      root.style.setProperty("--ui-gap", 12 * scale + "px");
      root.style.setProperty("--ui-mb-flag", 4 * scale + "px");
      root.style.setProperty("--ui-flag-w", 112 * scale + "px");
      root.style.setProperty("--ui-flag-h", 88 * scale + "px");
      root.style.setProperty("--ui-pin-fs", 36 * scale + "px");
      root.style.setProperty("--ui-yardage-fs", 28 * scale + "px");
      root.style.setProperty("--ui-wind-fs", 32 * scale + "px");
      root.style.setProperty("--ui-power-emoji-fs", 44 * scale + "px");
      root.style.setProperty("--ui-power-fs", 26 * scale + "px");
      root.style.setProperty("--ui-power-gap", 2 * scale + "px");
      root.style.setProperty("--ui-club-btn-fs", 24 * scale + "px");
      root.style.setProperty("--ui-club-icon-fs", 64 * scale + "px");
      root.style.setProperty("--ui-club-name-fs", 24 * scale + "px");
      root.style.setProperty("--ui-club-dist-fs", 12 * scale + "px");

      this.circles = {
        topLeft: document.getElementById("circleStats"),
        topRight: document.getElementById("circleCompass"),
        bottomLeft: document.getElementById("circlePower"),
        bottomRight: document.getElementById("circleClub"),
      };
      this.clubButtonsContainer = document.getElementById(
        "clubSelectorWrapper",
      );

      this._statsFlagImg = document.getElementById("statsFlagImg");
      this._lastFlagFrame = -1;
      this._statsPinNumber = document.getElementById("statsPinNumber");
      this.powerPercent = document.getElementById("powerPercent");
      this.powerArc = document.getElementById("powerArc");
      this._powerCircumference = 383; // 2π * 61, fixed for viewBox="0 0 150 150"
      this.clubIcon = document.getElementById("clubIcon");
      this.clubAbbr = document.getElementById("clubAbbr");
      this.clubYds = document.getElementById("clubYds");
      this._statsPar = document.getElementById("statsPar");
      this.clubPrev = document.getElementById("clubPrev");
      this.clubNext = document.getElementById("clubNext");
      this.clubPrevIcon = this.clubPrev?.querySelector(".club-mini-icon");
      this.clubNextIcon = this.clubNext?.querySelector(".club-mini-icon");
      this.clubPrevAbbr = this.clubPrev?.querySelector(".club-mini-abbr");
      this.clubNextAbbr = this.clubNext?.querySelector(".club-mini-abbr");
      this.clubPrevYds = this.clubPrev?.querySelector(".club-mini-yds");
      this.clubNextYds = this.clubNext?.querySelector(".club-mini-yds");
      this._rollAnimating = false;

      this._attachPressEffect(this.circles.topLeft);
      this._attachPressEffect(document.getElementById("compassCircle"));
      this._attachPressEffect(this.circles.bottomLeft);
      this._attachPressEffect(this.circles.bottomRight);

      const clubCircle = this.circles.bottomRight;
      if (clubCircle && this.modeToggleCallback) {
        clubCircle.addEventListener("click", () => {
          this.modeToggleCallback();
        });
      }
    }

    _attachPressEffect(el) {
      if (!el) return; // a missing HUD element must not take down the whole HUD
      el.addEventListener("pointerdown", () => el.classList.add("pressed"));
      el.addEventListener("pointerup", () => el.classList.remove("pressed"));
      el.addEventListener("pointerleave", () => el.classList.remove("pressed"));
      el.addEventListener("pointercancel", () =>
        el.classList.remove("pressed"),
      );
    }

    showStatsCircle() {
      const stats = document.getElementById("circleStats");
      if (stats) stats.style.display = "flex";
    }

    hideStatsCircle() {
      const stats = document.getElementById("circleStats");
      if (stats) stats.style.display = "none";
    }

    updateStats(
      speed,
      spin,
      height,
      distance,
      flagFrame,
      pinNumber,
      par = null,
    ) {
      const yardageEl = document.getElementById("circleYardage");
      if (yardageEl) yardageEl.textContent = distance.toFixed(0);

      // Course mode: par sits between the flag and the distance; hidden in practice.
      if (this._statsPar) {
        if (par != null) {
          this._statsPar.textContent = "PAR " + par;
          this._statsPar.style.display = "block";
        } else {
          this._statsPar.style.display = "none";
        }
      }

      // Update flag via cached data URLs (no network requests, pure memory)
      if (this._statsFlagImg && flagFrame !== this._lastFlagFrame) {
        this._lastFlagFrame = flagFrame;
        const frameIndex = Shared.clamp(flagFrame, 0, 6);
        const dataUrl = CircleUIManager.flagDataUrls.get(frameIndex);

        if (dataUrl) {
          this._statsFlagImg.style.backgroundImage = `url('${dataUrl}')`;
        }
      }

      if (this._statsPinNumber && pinNumber !== undefined) {
        this._statsPinNumber.textContent = pinNumber;
      }
    }

    updatePower(powerPercent) {
      const percent = Shared.clamp(powerPercent, 0, 100);
      if (this.powerPercent) this.powerPercent.textContent = percent.toFixed(0);
      if (this.powerArc && this._powerCircumference) {
        const offset = this._powerCircumference * (1 - percent / 100);
        this.powerArc.style.strokeDashoffset = String(offset);
        this.powerArc.style.stroke = PALETTE.YELLOW;
      }
    }

    static iconForClub(clubName) {
      if (clubName.includes("Driver") || clubName.includes("Wood"))
        return "assets/clubs/driver.png";
      if (clubName.includes("Putter")) return "assets/clubs/putter.png";
      return "assets/clubs/iron.png";
    }

    // Short badge for the preview minis: D / 3W / 5W / P / S (lob) / PW / H, or the
    // bare number for irons.
    static abbrevForClub(name) {
      if (name === "Driver") return "D";
      if (name === "Putter") return "P";
      if (name === "Lob Wedge") return "S";
      if (name === "Sand Wedge") return "SW";
      if (name === "Pitching Wedge") return "PW";
      if (name === "Hybrid") return "H";
      const iron = /^(\d+)\s*Iron/i.exec(name);
      if (iron) return iron[1];
      const wood = /^(\d+)\s*Wood/i.exec(name);
      if (wood) return wood[1] + "W";
      return name.slice(0, 2).toUpperCase();
    }

    // Circumcentre of three points — the arc the carousel rotates along.
    static _circumcenter(a, b, c) {
      const d = 2 * (a.x * (b.y - c.y) + b.x * (c.y - a.y) + c.x * (a.y - b.y));
      if (Math.abs(d) < 1e-6) return { x: b.x, y: b.y };
      const a2 = a.x * a.x + a.y * a.y,
        b2 = b.x * b.x + b.y * b.y,
        c2 = c.x * c.x + c.y * c.y;
      return {
        x: (a2 * (b.y - c.y) + b2 * (c.y - a.y) + c2 * (a.y - b.y)) / d,
        y: (a2 * (c.x - b.x) + b2 * (a.x - c.x) + c2 * (b.x - a.x)) / d,
      };
    }

    // Update the club carousel: the selected club (full size, in the corner) plus
    // half-size previous/next previews (icon + short badge) above and to the left.
    // sel/prev/next are { name, yds } — all three circles show icon + abbrev + yardage.
    updateClub(sel, prev, next) {
      const paint = (icon, abbr, yds, club) => {
        if (!club) return;
        if (icon) icon.src = CircleUIManager.iconForClub(club.name);
        if (abbr) abbr.textContent = CircleUIManager.abbrevForClub(club.name);
        if (yds) yds.textContent = club.yds;
      };
      paint(this.clubIcon, this.clubAbbr, this.clubYds, sel);
      paint(this.clubPrevIcon, this.clubPrevAbbr, this.clubPrevYds, prev);
      paint(this.clubNextIcon, this.clubNextAbbr, this.clubNextYds, next);
    }

    // Rotate the carousel one step. The clicked preview (`which` = "prev" = above,
    // "next" = left) swings along the quarter-circle arc into the corner and grows to
    // the selected size; the selected club swings + shrinks into the opposite preview
    // slot; the club that leaves the 3-window POPS out; the newly-revealed club FADES
    // in. Motion uses the Web Animations API so it runs on the compositor (smooth even
    // while the 3D scene renders). onDone re-renders the static state at settle; the
    // swap is masked because every circle is a pixel-identical scale of the others.
    animateClubRoll(which, onDone) {
      const P = this.clubPrev,
        C = this.circles.bottomRight,
        N = this.clubNext;
      if (!P || !C || !N || this._rollAnimating) {
        onDone();
        return;
      }
      this._rollAnimating = true;
      const ctr = (el) => {
        const r = el.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width };
      };
      const cP = ctr(P),
        cC = ctr(C),
        cN = ctr(N);
      const O = CircleUIManager._circumcenter(cP, cC, cN);
      const rad = Math.hypot(cC.x - O.x, cC.y - O.y);
      const ang = (p) => Math.atan2(p.y - O.y, p.x - O.x);
      const full = cC.w,
        mini = cP.w;
      // Keyframes for a circle swinging along the arc from its own centre to `toAng`,
      // scaling from s0 to s1 (relative to its own width).
      const arc = (from, toAng, s0, s1) => {
        let d = toAng - ang(from);
        while (d > Math.PI) d -= 2 * Math.PI;
        while (d < -Math.PI) d += 2 * Math.PI;
        const frames = [];
        for (let i = 0; i <= 12; i++) {
          const e = i / 12,
            th = ang(from) + d * e;
          const x = O.x + rad * Math.cos(th),
            y = O.y + rad * Math.sin(th);
          const sc = (s0 + (s1 - s0) * e) / from.w;
          frames.push({
            transform: `translate(${(x - from.x).toFixed(2)}px, ${(y - from.y).toFixed(2)}px) scale(${sc.toFixed(4)})`,
          });
        }
        return frames;
      };
      const clicked = which === "prev" ? P : N;
      const clickedFrom = which === "prev" ? cP : cN;
      const exiter = which === "prev" ? N : P; // the club leaving the window
      const clubTo = which === "prev" ? ang(cN) : ang(cP); // where the selected swings to
      const T = 340,
        opts = /** @type {KeyframeAnimationOptions} */ ({
          duration: T,
          easing: "cubic-bezier(0.34, 0, 0.26, 1)",
          fill: "forwards",
        });
      const a1 = clicked.animate(arc(clickedFrom, ang(cC), mini, full), opts);
      const a2 = C.animate(arc(cC, clubTo, full, mini), opts);
      exiter.style.opacity = "0"; // POP out — no fade

      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        [a1, a2].forEach((a) => {
          try {
            a.cancel();
          } catch (e) {}
        });
        for (const el of [P, C, N]) {
          el.style.transform = "";
          el.style.opacity = "";
        }
        onDone(); // commit the new selection + re-render the static 3-club state
        clicked.animate([{ opacity: 0 }, { opacity: 1 }], {
          duration: 200,
          easing: "ease-out",
        }); // the newly-revealed club FADES in
        this._rollAnimating = false;
      };
      Promise.all([a1.finished, a2.finished])
        .then(finish)
        .catch(() => {});
      setTimeout(finish, T + 250); // safety if the WAAPI promises never settle
    }

    showPowerCircle() {
      if (this.circles.bottomLeft)
        this.circles.bottomLeft.style.display = "flex";
    }
    hidePowerCircle() {
      if (this.circles.bottomLeft)
        this.circles.bottomLeft.style.display = "none";
    }

    showCompassCircle() {
      const circle = document.getElementById("compassCircle");
      const wind = document.getElementById("windSpeedDisplay");
      if (circle) circle.style.display = "flex";
      if (wind) wind.style.display = "block";
    }

    hideCompassCircle() {
      const circle = document.getElementById("compassCircle");
      const wind = document.getElementById("windSpeedDisplay");
      if (circle) circle.style.display = "none";
      if (wind) wind.style.display = "none";
    }

    showClubCircle() {
      const prev = document.getElementById("clubPrev");
      const circle = document.getElementById("circleClub");
      const next = document.getElementById("clubNext");
      if (prev) prev.style.display = "flex";
      if (circle) circle.style.display = "flex";
      if (next) next.style.display = "flex";
    }

    hideClubCircle() {
      const prev = document.getElementById("clubPrev");
      const circle = document.getElementById("circleClub");
      const next = document.getElementById("clubNext");
      if (prev) prev.style.display = "none";
      if (circle) circle.style.display = "none";
      if (next) next.style.display = "none";
    }

    hideAllCircles() {
      Object.values(this.circles).forEach((circle) => {
        if (circle) circle.style.display = "none";
      });
      if (this.clubButtonsContainer)
        this.clubButtonsContainer.style.display = "none";
    }

    showAllCircles() {
      Object.values(this.circles).forEach((circle) => {
        if (circle) circle.style.display = "flex";
      });
      if (this.clubButtonsContainer)
        this.clubButtonsContainer.style.display = "flex";
    }

    getCompassSvg() {
      return document.getElementById("compassSvg");
    }

    getClubButtons() {
      if (!this.clubButtonsContainer) return null;
      return {
        prevBtn: this.clubButtonsContainer.querySelector("#clubPrev"),
        nextBtn: this.clubButtonsContainer.querySelector("#clubNext"),
      };
    }

    destroy() {
      Object.values(this.circles).forEach((circle) => {
        if (circle) circle.style.display = "none";
      });
      if (this.clubButtonsContainer)
        this.clubButtonsContainer.style.display = "none";
    }
  }

  // ─── UI MANAGER ─────────────────────────────────────────────────────────────

  class UIManager {
    constructor(
      golfBall,
      ballStartPosition,
      game = null,
      circleUIManager = null,
    ) {
      this.golfBall = golfBall;
      this.ballStartPosition = ballStartPosition;
      this.game = game;
      this.circleUIManager = circleUIManager;
    }

    update() {
      const speed = this.golfBall.getSpeed() * UNITS.MS_TO_MPH;
      const height = Math.max(
        0,
        (this.golfBall.getHeight() - 1) * UNITS.M_TO_FEET,
      );
      const distanceToPin = this.getDistanceToNearestPin() * UNITS.M_TO_YARDS;
      const spin = this.golfBall.pendingSpinAmount * 100;

      const pinManager = this.game?.scene?.pinManager;
      const flagFrame = pinManager?.currentFlagFrame ?? 0;

      // Course mode: the flag shows the HOLE number and the stats circle shows the
      // hole's PAR. Practice: the aimed-at pin index and no par.
      const cm = this.game?.courseManager;
      const hole = cm ? COURSE_HOLES[cm.holeIndex] : null;
      let pinNumber;
      let par = null;
      if (hole) {
        pinNumber = hole.id;
        par = hole.par;
      } else {
        const targetPin = this.getTargetPin();
        pinNumber = targetPin !== null ? targetPin + 1 : 1;
      }

      if (this.circleUIManager) {
        this.circleUIManager.updateStats(
          speed,
          spin,
          height,
          distanceToPin,
          flagFrame,
          pinNumber,
          par,
        );
      }
    }

    getDistanceToNearestPin() {
      if (!this.game?.scene?.pinManager?.pins?.length) {
        return 0;
      }

      const ballPos = this.golfBall.getPosition();
      const pinManager = this.game.scene.pinManager;

      if (this.game.gameState === GameState.AIM && this.game.aimView) {
        const { distance, pin } = pinManager.getTargetPin(
          ballPos,
          this.game.aimView.cameraRotation,
        );
        if (pin) return distance;
      }

      const nearestPin = pinManager.pins.reduce((nearest, pin) => {
        const dist = BABYLON.Vector3.Distance(ballPos, pin.mesh.position);
        return !nearest || dist < nearest.dist ? { dist, pin } : nearest;
      }, null);

      return nearestPin ? nearestPin.dist : 0;
    }

    getTargetPin() {
      if (!this.game?.scene?.pinManager?.pins?.length) return null;
      const pinManager = this.game.scene.pinManager;
      const ballPos = this.golfBall.getPosition();

      if (this.game.gameState === GameState.AIM && this.game.aimView) {
        const { index } = pinManager.getTargetPin(
          ballPos,
          this.game.aimView.cameraRotation,
        );
        if (index !== -1) return index;
      }

      const pins = pinManager.pins;
      let nearestIdx = 0,
        nearestDist = Infinity;
      for (let i = 0; i < pins.length; i++) {
        const dist = BABYLON.Vector3.Distance(ballPos, pins[i].mesh.position);
        if (dist < nearestDist) {
          nearestDist = dist;
          nearestIdx = i;
        }
      }
      return nearestIdx;
    }
  }

  // ─── PIN MANAGER ─────────────────────────────────────────────────────────────

  class PinManager {
    static flagTexturesCache = null;

    constructor(scene, golfBall, eventManager = null) {
      this.scene = scene;
      this.golfBall = golfBall;
      this.eventManager = eventManager || new EventManager();
      this.pins = [];
      this.greens = [];
      this.currentFlagFrame = 0; // shared frame index (0=still, 1-6=animated)

      this.COLLISION_CHECK_RADIUS = CONFIG.PINS.PIN_COLLISION_RADIUS * 3; // 3x collision radius for early detection
      this.SINK_CHECK_RADIUS = CONFIG.PINS.HOLE_RADIUS * 5; // 5x hole radius for precision

      if (!PinManager.flagTexturesCache) {
        PinManager.flagTexturesCache = this._initFlagTextureCache(scene);
      }
    }

    _initFlagTextureCache(scene) {
      const textures = CircleUIManager.FLAG_PATHS.map((_, index) => {
        const t = new BABYLON.DynamicTexture(
          `flagTexture_${index}`,
          { width: 256, height: 128 },
          scene,
          true,
        );
        t.hasAlpha = true;
        t.wrapU = BABYLON.Texture.CLAMP_ADDRESSMODE;
        t.wrapV = BABYLON.Texture.CLAMP_ADDRESSMODE;
        const ctx = t.getContext();
        ctx.clearRect(0, 0, 256, 128);
        t.update();
        return t;
      });

      CircleUIManager.ensureFlagAssetsLoaded()
        .then(() => {
          textures.forEach((texture, index) => {
            const image = CircleUIManager.flagImages.get(index);
            if (!image) return;

            const ctx = texture.getContext();
            ctx.clearRect(0, 0, 256, 128);
            ctx.drawImage(image, 0, 0, 256, 128);
            texture.update();
          });
        })
        .catch((error) => {
          console.warn(error.message);
        });

      return textures;
    }

    addPin(position, scene, opts = {}) {
      const cfg = CONFIG.PINS;
      const baseY = position.y + cfg.PIN_Y_OFFSET;

      // ── Pole: black & white stripes using per-segment materials ──
      const STRIPE_COUNT = 8;
      const pole = BABYLON.MeshBuilder.CreateCylinder(
        "pin",
        {
          height: cfg.PIN_HEIGHT,
          diameter: cfg.PIN_DIAMETER,
          segments: 12,
          tessellation: 12,
        },
        scene,
      );
      pole.position = position.clone();
      pole.position.y = baseY;
      pole.isPickable = true; // MUST be pickable - used for click detection in AimView

      const stripeCanvas = document.createElement("canvas");
      stripeCanvas.width = 4;
      stripeCanvas.height = 256;
      const ctx = stripeCanvas.getContext("2d");
      const stripeH = stripeCanvas.height / STRIPE_COUNT;
      for (let i = 0; i < STRIPE_COUNT; i++) {
        ctx.fillStyle = i % 2 === 0 ? "#ffffff" : "#111111";
        ctx.fillRect(0, i * stripeH, stripeCanvas.width, stripeH);
      }
      const stripeTexture = new BABYLON.DynamicTexture(
        "stripesTex",
        { width: 4, height: 256 },
        scene,
        false,
      );
      stripeTexture.getContext().drawImage(stripeCanvas, 0, 0);
      stripeTexture.update();
      const poleMat = new BABYLON.StandardMaterial("poleMat", scene);
      poleMat.diffuseTexture = stripeTexture;
      poleMat.specularColor = new BABYLON.Color3(0.1, 0.1, 0.1);
      pole.material = poleMat;

      const poleBody = new BABYLON.PhysicsAggregate(
        pole,
        BABYLON.PhysicsShapeType.CYLINDER,
        { mass: 0, friction: 0, restitution: 0.5 },
        scene,
      );

      // ── Flag quad at the top of the pole ──
      // Use a pivot node at the pole top so rotation always pivots from the left edge.
      const flagTopY = baseY + cfg.PIN_HEIGHT / 2;
      const flagPivot = new BABYLON.TransformNode("flagPivot", scene);
      flagPivot.position = new BABYLON.Vector3(
        position.x,
        flagTopY - cfg.FLAG_HEIGHT / 2,
        position.z,
      );

      const flagPlane = BABYLON.MeshBuilder.CreatePlane(
        "flag",
        {
          width: cfg.FLAG_WIDTH,
          height: cfg.FLAG_HEIGHT,
          sideOrientation: BABYLON.Mesh.DOUBLESIDE,
        },
        scene,
      );
      // Parent to pivot; offset so the left edge sits at the pivot (pole center)
      flagPlane.parent = flagPivot;
      flagPlane.position = new BABYLON.Vector3(cfg.FLAG_WIDTH / 2, 0, 0);
      flagPlane.isPickable = false;

      const flagMat = new BABYLON.StandardMaterial("flagMat", scene);
      flagMat.diffuseTexture = PinManager.flagTexturesCache[0];
      flagMat.diffuseTexture.hasAlpha = true;
      flagMat.useAlphaFromDiffuseTexture = true;
      flagMat.transparencyMode = BABYLON.Material.MATERIAL_ALPHATESTANDBLEND;
      flagMat.backFaceCulling = false;
      flagMat.specularColor = new BABYLON.Color3(0, 0, 0);
      flagPlane.material = flagMat;
      flagPlane.billboardMode = BABYLON.Mesh.BILLBOARDMODE_NONE;

      const flagTextures = PinManager.flagTexturesCache;

      // ── The cup ──
      // Course mode gets a REAL cavity (open-top cylinder well: dark wall + floor
      // colliders) at the pin's actual surface height, so the ball drops in and
      // rests below the lip. Practice keeps the flat decorative disc at the legacy
      // absolute HOLE_Y_OFFSET (its squashed-sphere green isn't surface-sampled).
      const holeMat = new BABYLON.StandardMaterial("holeMat", scene);
      holeMat.diffuseColor = new BABYLON.Color3(0, 0, 0);
      holeMat.specularColor = new BABYLON.Color3(0, 0, 0);
      // Pure black no matter the scene lights, visible from either side (the old
      // practice disc faced DOWN and was backface-culled — an invisible hole).
      holeMat.disableLighting = true;
      holeMat.emissiveColor = new BABYLON.Color3(0, 0, 0);
      holeMat.backFaceCulling = false;

      let hole = null;
      let cupWall = null,
        cupFloor = null,
        cupWallAgg = null,
        cupFloorAgg = null;
      if (opts.cavity) {
        const surfaceY = position.y;
        const r = cfg.HOLE_RADIUS;
        // Dark inner wall (open cylinder) — visually the hole + contains a bouncing ball.
        cupWall = BABYLON.MeshBuilder.CreateCylinder(
          "cupWall",
          {
            diameter: r * 2,
            height: cfg.CUP_DEPTH,
            tessellation: 20,
            cap: BABYLON.Mesh.NO_CAP,
          },
          scene,
        );
        cupWall.position = new BABYLON.Vector3(
          position.x,
          surfaceY - cfg.CUP_DEPTH / 2,
          position.z,
        );
        cupWall.material = holeMat;
        cupWall.isPickable = false;
        cupWallAgg = new BABYLON.PhysicsAggregate(
          cupWall,
          BABYLON.PhysicsShapeType.MESH,
          { mass: 0, friction: 1.0, restitution: 0.05 },
          scene,
        );
        // Cup floor the ball rests on. Made thick (extends well below) so a ball
        // that drops in fast can't tunnel through it — preventTunneling is disabled
        // while the ball is in the cup, so the floor itself must be the backstop.
        const floorH = 0.4;
        cupFloor = BABYLON.MeshBuilder.CreateCylinder(
          "cupFloor",
          { diameter: r * 2, height: floorH, tessellation: 20 },
          scene,
        );
        cupFloor.position = new BABYLON.Vector3(
          position.x,
          surfaceY - cfg.CUP_DEPTH + 0.01 - floorH / 2,
          position.z,
        );
        cupFloor.material = holeMat;
        cupFloor.isPickable = false;
        cupFloorAgg = new BABYLON.PhysicsAggregate(
          cupFloor,
          BABYLON.PhysicsShapeType.CYLINDER,
          { mass: 0, friction: 1.0, restitution: 0.05 },
          scene,
        );
        // Visible mouth: a flat black disc a hair above the green. The cavity is
        // buried inside the (uncut) green mesh, so without this the hole doesn't
        // show against the surface at all.
        hole = BABYLON.MeshBuilder.CreateDisc(
          "holeMouth",
          { radius: r, tessellation: 24 },
          scene,
        );
        hole.position = new BABYLON.Vector3(
          position.x,
          surfaceY + 0.005,
          position.z,
        );
        hole.rotation.x = -Math.PI / 2; // face up
        hole.isPickable = false;
        hole.material = holeMat;
      } else {
        hole = BABYLON.MeshBuilder.CreateDisc(
          "hole",
          { radius: cfg.HOLE_RADIUS, tessellation: 24 },
          scene,
        );
        hole.position = position.clone();
        // Sit a hair above the green surface when the caller knows it (practice
        // passes the squashed-sphere apex); the legacy absolute offset floated
        // the disc 0.23 m in the air.
        hole.position.y = (opts.surfaceY ?? cfg.HOLE_Y_OFFSET) + 0.005;
        hole.rotation.x = -Math.PI / 2; // face up
        hole.isPickable = false;
        hole.material = holeMat;
      }

      this.pins.push({
        mesh: pole,
        body: poleBody,
        poleMat, // per-pin — must be disposed with the pin
        stripeTexture, // per-pin DynamicTexture — must be disposed with the pin
        flagMesh: flagPlane,
        flagPivot,
        flagMat, // per-pin (its diffuseTexture is the shared flagTexturesCache)
        flagTextures,
        hole, // black mouth disc (practice flat cup, or over the course cavity)
        holeMat, // per-pin
        cavity: !!opts.cavity,
        surfaceY: position.y, // green surface height at the cup mouth
        captured: false, // ball has dropped into the cavity, awaiting settle
        captureFrames: 0,
        cupWall,
        cupFloor,
        cupWallAgg,
        cupFloorAgg,
        flagAnimTime: 0,
        flagAnimFrame: 0,
        holePosition: position.clone(),
      });
    }

    addGreen(centerPos, radius, scene) {
      // Flat green pad, styled like the course's greens: same putting texture at
      // the course's world-scale tiling (~1.6 m per tile), same brighter palette
      // and low sheen, and a flat top that actually matches the flat collider
      // below (the old squashed-sphere mound curved away under the ball near the
      // edges). Height keeps the legacy apex (0.001 + radius/100) so the hole
      // disc, sink thresholds and camera floor stay put.
      const padH = radius * 0.01;
      const green = BABYLON.MeshBuilder.CreateCylinder(
        "green",
        { diameter: radius * 2, height: padH, tessellation: 48 },
        scene,
      );
      green.position = centerPos.clone();
      green.position.y = 0.001 + padH / 2;
      green.isPickable = false;

      const greenMat = Utils.createMaterial(
        `greenMat_${Math.random()}`,
        scene,
        new BABYLON.Color3(0.5, 0.82, 0.28), // courseGreen palette
        new BABYLON.Color3(0.02, 0.02, 0.02),
        8,
      );
      // Cylinder caps map UV 0..1 across the diameter; scale so one tile spans
      // ~1.6 world metres, matching CourseSurfaces' green tiling.
      const tiling = (radius * 2) / 1.6;
      const greenDiffuse = new BABYLON.Texture(
        CONFIG.PINS.GREEN_TEXTURE_PATH,
        scene,
      );
      greenDiffuse.wrapU = greenDiffuse.wrapV =
        BABYLON.Texture.WRAP_ADDRESSMODE;
      greenDiffuse.uScale = greenDiffuse.vScale = tiling;
      greenMat.diffuseTexture = greenDiffuse;
      const greenNormal = new BABYLON.Texture(
        CONFIG.PINS.GREEN_NORMAL_MAP_PATH,
        scene,
      );
      greenNormal.wrapU = greenNormal.wrapV = BABYLON.Texture.WRAP_ADDRESSMODE;
      greenNormal.uScale = greenNormal.vScale = tiling;
      greenMat.bumpTexture = greenNormal;
      green.material = greenMat;
      green.receiveShadows = true;

      // Physics: a thin invisible CYLINDER with real thickness instead of a ~2000-tri
      // MESH collider on the squashed sphere. Much cheaper (no triangle soup + wasted
      // underside), and the thickness prevents fast landings from tunnelling through.
      const colThickness = 1.0;
      const greenTopY = green.position.y + padH / 2; // top of the pad
      const greenCol = BABYLON.MeshBuilder.CreateCylinder(
        "greenCol",
        { diameter: radius * 2, height: colThickness, tessellation: 24 },
        scene,
      );
      greenCol.position = new BABYLON.Vector3(
        centerPos.x,
        greenTopY - colThickness / 2,
        centerPos.z,
      );
      greenCol.isVisible = false;
      greenCol.isPickable = false;
      // Roll like the course greens (SURFACE_PHYSICS.green): true and fast.
      const greenPhysics = new BABYLON.PhysicsAggregate(
        greenCol,
        BABYLON.PhysicsShapeType.CYLINDER,
        {
          mass: 0,
          friction: SURFACE_PHYSICS.green.friction,
          restitution: SURFACE_PHYSICS.green.restitution,
        },
        scene,
      );

      this.greens.push({ mesh: green, body: greenPhysics, collider: greenCol });
      return greenTopY; // surface height at the pin, for placing the hole disc
    }

    updateFlags(wind, dt) {
      const cfg = CONFIG.PINS;
      const windSpeedMs = wind.speed; // m/s
      const windVec = wind.getWindVector();
      // Angle the flag faces into the wind (flag blows away from wind source)
      const windAngle = Math.atan2(windVec.x, windVec.z) - Math.PI / 2;

      for (const pin of this.pins) {
        if (!pin.flagMesh) continue;

        if (windSpeedMs < cfg.FLAG_WIND_THRESHOLD) {
          if (pin.flagMat.diffuseTexture !== pin.flagTextures[0]) {
            pin.flagMat.diffuseTexture = pin.flagTextures[0];
          }
          this.currentFlagFrame = 0;
        } else {
          // Animate through frames 1-6; FPS scales linearly from 4 at threshold to 12 at max wind
          const t = Math.min(
            1,
            (windSpeedMs - cfg.FLAG_WIND_THRESHOLD) /
              (CONFIG.WIND.MAX_SPEED - cfg.FLAG_WIND_THRESHOLD),
          );
          const animFps = 4 + t * (12 - 4);
          pin.flagAnimTime += dt * animFps;
          const frameIndex = 1 + (Math.floor(pin.flagAnimTime) % 6);
          if (pin.flagMat.diffuseTexture !== pin.flagTextures[frameIndex]) {
            pin.flagMat.diffuseTexture = pin.flagTextures[frameIndex];
          }
          this.currentFlagFrame = frameIndex;
        }

        if (pin.flagPivot) pin.flagPivot.rotation.y = windAngle;
      }
    }

    checkHoleSink() {
      const ballPos = this.golfBall.getPosition();
      const ballSpeed = this.golfBall.getSpeed();

      // Only check pins within sink detection radius (spatial culling)
      for (const pin of this.pins) {
        const holePos = pin.holePosition;
        if (!holePos) continue;
        if (pin.sunk) continue; // already sunk — don't re-snap/re-emit every frame

        const distance3D = BABYLON.Vector3.Distance(ballPos, holePos);
        if (distance3D > this.SINK_CHECK_RADIUS) {
          continue;
        }

        if (pin.cavity) {
          this._sinkCavity(pin, ballPos, ballSpeed);
          continue;
        }

        // Legacy proximity trigger (practice mode): snap the ball into the flat cup.
        const dx = ballPos.x - holePos.x;
        const dz = ballPos.z - holePos.z;
        const horizDist = Math.sqrt(dx * dx + dz * dz);
        const nearGround = ballPos.y < CONFIG.PINS.HOLE_Y_OFFSET + 1.5;

        if (
          horizDist < CONFIG.PINS.HOLE_RADIUS * 0.85 &&
          nearGround &&
          ballSpeed < 6
        ) {
          this.golfBall.body.setLinearVelocity(BABYLON.Vector3.Zero());
          this.golfBall.body.setAngularVelocity(BABYLON.Vector3.Zero());
          this.golfBall.mesh.position.x = holePos.x;
          this.golfBall.mesh.position.z = holePos.z;
          this.golfBall.mesh.position.y = CONFIG.PINS.HOLE_Y_OFFSET - 0.25;
          this.golfBall.landed = true;
          pin.sunk = true;
          this.eventManager.emit("pin:holesink", holePos);
        }
      }
    }

    // Real cavity cup: a slow ball over the mouth drops in; the hole counts only
    // once the ball comes to rest on the cup floor ("fall in AND stay in"). A ball
    // moving faster than CUP_CAPTURE_SPEED just rolls over the mouth (lips out).
    _sinkCavity(pin, ballPos, ballSpeed) {
      const cfg = CONFIG.PINS;
      const holePos = pin.holePosition;
      const surfaceY = pin.surfaceY;
      const r = CONFIG.BALL.COLLIDER_DIAMETER / 2;
      const dx = ballPos.x - holePos.x;
      const dz = ballPos.z - holePos.z;
      const horizDist = Math.sqrt(dx * dx + dz * dz);

      if (!pin.captured) {
        const overMouth = horizDist < cfg.HOLE_RADIUS * 0.9;
        // Rolling on the green at the mouth (not a shot flying high over it).
        const atSurface =
          ballPos.y < surfaceY + r + 0.06 &&
          ballPos.y > surfaceY - cfg.CUP_DEPTH;
        if (overMouth && atSurface && ballSpeed <= cfg.CUP_CAPTURE_SPEED) {
          // Drop it in, centred just below the lip; gravity then seats it on the floor.
          this.golfBall._inCup = true; // stop preventTunneling from lifting it back out
          this.golfBall.teleport(holePos.x, surfaceY - r - 0.005, holePos.z);
          pin.captured = true;
          pin.captureFrames = 0;
        }
        return;
      }

      // Captured: bounced back out above the lip? let it try again.
      if (ballPos.y > surfaceY + r) {
        pin.captured = false;
        pin.captureFrames = 0;
        this.golfBall._inCup = false;
        return;
      }
      // Wait out the teleport-restore frames, then hole out once it has fallen below
      // the lip and come to rest on the cup floor ("stay in").
      pin.captureFrames++;
      if (
        pin.captureFrames > 3 &&
        ballPos.y < surfaceY - r &&
        ballSpeed < cfg.CUP_SETTLE_SPEED
      ) {
        this.golfBall.landed = true;
        pin.sunk = true;
        this.eventManager.emit("pin:holesink", holePos);
      }
    }

    checkPinCollisions() {
      const ballPos = this.golfBall.getPosition();
      const ballSpeed = this.golfBall.getSpeed();

      // Only check pins within collision detection radius (spatial culling)
      for (const pin of this.pins) {
        const distance = BABYLON.Vector3.Distance(ballPos, pin.mesh.position);

        if (distance > this.COLLISION_CHECK_RADIUS) {
          continue;
        }

        if (
          distance < CONFIG.PINS.PIN_COLLISION_RADIUS &&
          ballSpeed > CONFIG.PINS.PIN_COLLISION_MIN_SPEED
        ) {
          this.eventManager.emit("pin:hit", pin.mesh.position);

          pin.mesh.scaling.y = CONFIG.PINS.PIN_FLASH_SCALE_Y;
          setTimeout(() => {
            pin.mesh.scaling.y = 1;
          }, CONFIG.PINS.PIN_FLASH_DURATION_MS);
        }
      }
    }

    /**
     * Find the target pin based on ball position and aim direction.
     * Returns the pin most aligned with the aim direction (within 90° cone).
     *
     * @param {any} ballPos - Current ball position (BABYLON.Vector3)
     * @param {number} aimDirection - Aim direction angle (radians)
     * @returns {{pin: Object|null, index: number, distance: number}}
     *          pin: the pin object, index: position in pins array, distance: yardage to pin
     */
    getTargetPin(ballPos, aimDirection) {
      if (!this.pins || this.pins.length === 0) {
        return { pin: null, index: -1, distance: 0 };
      }

      // Convert aim direction to vector (opposite camera direction since ball faces away from camera)
      const aimVec = new BABYLON.Vector3(
        Math.sin(aimDirection + Math.PI),
        0,
        Math.cos(aimDirection + Math.PI),
      );

      let bestPin = null;
      let bestIndex = -1;
      let smallestAngle = Math.PI;

      for (let i = 0; i < this.pins.length; i++) {
        const pin = this.pins[i];
        const pinPos = pin.mesh.position;
        const toPin = pinPos.subtract(ballPos);
        const toPinFlat = toPin.clone();
        toPinFlat.y = 0;

        if (toPinFlat.length() === 0) continue;

        toPinFlat.normalize();

        const dotProd = BABYLON.Vector3.Dot(aimVec, toPinFlat);
        const angle = Math.acos(Shared.clamp(dotProd, -1, 1));

        if (angle < smallestAngle) {
          smallestAngle = angle;
          bestPin = pin;
          bestIndex = i;
        }
      }

      // Return most-aligned pin's distance if within 90° cone (in front)
      if (bestPin && smallestAngle < Math.PI / 2) {
        const distance = BABYLON.Vector3.Distance(
          ballPos,
          bestPin.mesh.position,
        );
        return { pin: bestPin, index: bestIndex, distance };
      }

      return { pin: null, index: -1, distance: 0 };
    }
  }

  /** Small top-of-screen hole banner + transient flash messages. */
  class CourseHUD {
    constructor() {
      CourseUI.ensureStyles();
      this.flashEl = document.createElement("div");
      this.flashEl.className = "course-flash";
      this.flashEl.style.display = "none";
      document.body.appendChild(this.flashEl);
      this._flashTimer = null;
    }

    // The hole number + par now live in the top-left stats circle; the old center
    // banner (and per-hole title) is gone. Kept as a no-op so callers don't break.
    setHole() {}

    flash(text, ms = 2200) {
      this.flashEl.textContent = text;
      this.flashEl.style.display = "block";
      this.flashEl.classList.remove("cf-show");
      void this.flashEl.offsetWidth; // restart animation
      this.flashEl.classList.add("cf-show");
      clearTimeout(this._flashTimer);
      this._flashTimer = setTimeout(() => {
        this.flashEl.style.display = "none";
      }, ms);
    }

    hide() {}
  }

  // Shared style injection + score naming for the course UI.
  class CourseUI {
    static _styled = false;
    static ensureStyles() {
      if (CourseUI._styled) return;
      CourseUI._styled = true;
      const css = `
    .course-flash{position:absolute;top:38%;left:50%;transform:translate(-50%,-50%);
      z-index:1600;font-family:'Trebuchet MS',Arial,sans-serif;font-weight:bold;font-size:46px;
      color:#eafff0;text-shadow:0 2px 10px rgba(0,0,0,.6),0 0 24px rgba(80,220,120,.6);
      pointer-events:none;text-align:center;}
    .course-flash.cf-show{animation:cfpop .5s cubic-bezier(.2,1.4,.4,1);}
    @keyframes cfpop{0%{transform:translate(-50%,-50%) scale(.4);opacity:0}
      60%{transform:translate(-50%,-52%) scale(1.08);opacity:1}
      100%{transform:translate(-50%,-50%) scale(1);opacity:1}}
    .balls-overlay{position:absolute;inset:0;z-index:2000;display:flex;align-items:center;
      justify-content:center;background:radial-gradient(circle at 50% 30%,rgba(135,207,235,.6),rgba(90,150,200,.75));
      font-family:'Trebuchet MS',Arial,sans-serif;-webkit-backdrop-filter:blur(2px);backdrop-filter:blur(2px);}
    .balls-overlay.splash-in{animation:sbSplash .6s cubic-bezier(.16,1.1,.3,1) both;}
    @keyframes sbSplash{from{-webkit-clip-path:circle(0% at 50% 50%);clip-path:circle(0% at 50% 50%);}
      to{-webkit-clip-path:circle(150% at 50% 50%);clip-path:circle(150% at 50% 50%);}}
    .aero-card{background:linear-gradient(180deg,rgba(255,255,255,.96),rgba(232,245,235,.94));
      border:2px solid rgba(255,255,255,.85);border-radius:32px;padding:30px 40px 34px;min-width:320px;
      box-shadow:0 20px 60px rgba(0,60,20,.35),inset 0 3px 12px rgba(255,255,255,.9);
      text-align:center;position:relative;overflow:hidden;}
    .aero-card::before{content:'';position:absolute;top:0;left:0;right:0;height:46%;
      background:linear-gradient(180deg,rgba(255,255,255,.65),rgba(255,255,255,0));
      border-radius:32px 32px 60% 60%/32px 32px 30% 30%;pointer-events:none;}
    .aero-title{font-size:40px;font-weight:bold;color:#1e7a34;letter-spacing:1px;margin:0 0 4px;
      text-shadow:0 1px 0 #fff,0 2px 6px rgba(30,122,52,.25);}
    .aero-sub{font-size:15px;color:#3a7a4c;margin:0 0 22px;opacity:.85;}
    .aero-btn{display:inline-block;cursor:pointer;user-select:none;border:none;margin:6px;
      font-family:inherit;font-weight:bold;font-size:19px;color:#fff;padding:13px 30px;border-radius:999px;
      background:linear-gradient(180deg,#4fc46a,#2e8b48);
      box-shadow:0 6px 16px rgba(20,90,40,.4),inset 0 2px 6px rgba(255,255,255,.6);
      text-shadow:0 1px 2px rgba(0,0,0,.35);transition:transform .08s ease,filter .08s ease;}
    .aero-btn:hover{filter:brightness(1.07);}
    .aero-btn:active{transform:translateY(2px) scale(.98);filter:brightness(.95);}
    .aero-btn.secondary{background:linear-gradient(180deg,#e9f3ec,#c9ddce);color:#1e7a34;
      text-shadow:0 1px 0 rgba(255,255,255,.7);}

    /* round end screen: the card is a circle, so its content lives inside the
       inscribed square (.score-inner ~70%×70%), which stays clear of the curve. */
    .score-card{width:min(94vmin,600px);height:min(94vmin,600px);max-width:none;min-width:0;
      border-radius:50%;padding:0;display:flex;align-items:center;justify-content:center;
      background:#eef0ea url('assets/golfball_dimples.jpg') center/cover;}
    .score-inner{width:70%;max-height:70%;overflow:auto;display:flex;flex-direction:column;
      align-items:center;scrollbar-width:none;}
    .score-inner::-webkit-scrollbar{display:none;}
    /* orb sheen that follows the circle instead of the rounded-rect top gloss */
    .score-card::before{inset:0;height:auto;border-radius:50%;
      background:radial-gradient(circle at 50% 24%,rgba(255,255,255,.55),rgba(255,255,255,0) 62%);}
    .score-title{font-size:30px;margin-bottom:2px;}
    .score-card .aero-sub{margin:2px 0 12px;}
    table.scorecard{border-collapse:separate;border-spacing:0;width:100%;margin:6px 0 20px;
      border-radius:16px;overflow:hidden;box-shadow:0 4px 12px rgba(0,60,20,.15);}
    table.scorecard th,table.scorecard td{padding:7px 5px;font-size:14px;text-align:center;}
    table.scorecard thead th{background:linear-gradient(180deg,#2e8b48,#1e6e36);color:#eafff0;
      font-weight:bold;text-shadow:0 1px 2px rgba(0,0,0,.4);}
    table.scorecard tbody td{color:#1e6e36;font-weight:bold;background:rgba(255,255,255,.85);
      border-bottom:1px solid rgba(30,110,54,.12);}
    table.scorecard tbody td.label{text-align:left;color:#2a7a44;}
    table.scorecard tr.total td{background:rgba(224,244,230,.95);font-size:18px;color:#12572a;}
    `;
      const s = document.createElement("style");
      s.textContent = css;
      document.head.appendChild(s);
    }

    static scoreName(strokes, par) {
      const d = strokes - par;
      if (strokes === 1) return "Hole in One!";
      if (d <= -3) return "Albatross!";
      if (d === -2) return "Eagle!";
      if (d === -1) return "Birdie!";
      if (d === 0) return "Par";
      if (d === 1) return "Bogey";
      if (d === 2) return "Double Bogey";
      return `+${d}`;
    }
  }

  /** Modal overlay helper for the end-of-round Scoreboard. (The old Practice/Course
   *  start menu is gone — the clubhouse doors enter each mode directly.) */
  class BallsMenu {
    static _overlay(
      contentHtml,
      { id = "ballsMenu", cardClass = "aero-card" } = {},
    ) {
      const existing = document.getElementById(id);
      if (existing) existing.remove();
      const o = document.createElement("div");
      o.id = id;
      o.className = "balls-overlay";
      o.innerHTML = `<div class="${cardClass}">${contentHtml}</div>`;
      document.body.appendChild(o);
      return o;
    }
  }

  /** End-of-round scoreboard: traditional white/green, Frutiger-Aero, rounded. */
  class Scoreboard {
    static show(players, holes) {
      CourseUI.ensureStyles();
      const totalPar = holes.reduce((s, h) => s + h.par, 0);
      let head = `<tr><th class="label">Hole</th>`;
      holes.forEach((h) => (head += `<th>${h.id}</th>`));
      head += `<th>Tot</th></tr>`;
      let parRow = `<tr><td class="label">Par</td>`;
      holes.forEach((h) => (parRow += `<td>${h.par}</td>`));
      parRow += `<td>${totalPar}</td></tr>`;
      let rows = "";
      players.forEach((p) => {
        let tot = 0;
        let r = `<tr><td class="label">${p.name}</td>`;
        holes.forEach((h, i) => {
          const s = p.scores[i];
          tot += s || 0;
          r += `<td>${s != null ? s : "–"}</td>`;
        });
        r += `<td>${tot}</td></tr>`;
        rows += r;
      });
      const totals = players.map((p) =>
        p.scores.reduce((s, v) => s + (v || 0), 0),
      );
      const best = Math.min(...totals);
      const winners = players
        .filter((_, i) => totals[i] === best)
        .map((p) => p.name);
      const winLine =
        players.length > 1
          ? `<div class="aero-sub">🏆 ${winners.join(" & ")} win${winners.length > 1 ? "" : "s"} (${best})</div>`
          : `<div class="aero-sub">${best - totalPar === 0 ? "Even par" : (best - totalPar > 0 ? "+" : "") + (best - totalPar)} for the round</div>`;

      const o = BallsMenu._overlay(
        `<div class="score-inner">
        <div class="aero-title score-title">SCORECARD</div>
        ${winLine}
        <table class="scorecard"><thead>${head}${parRow}</thead>
        <tbody class="players">${rows}</tbody></table>
        <button class="aero-btn" id="sbClubhouse">Clubhouse</button>
      </div>`,
        { id: "ballsScoreboard", cardClass: "aero-card score-card" },
      );
      o.classList.add("splash-in"); // end screen opens via an expanding circle
      // The clubhouse (index.html) is the game's root — head back to the lobby.
      // The "course" stamp spawns us just inside the lobby's COURSE door, as if
      // walking back in off the links (see Shared.roomFX + clubhouse arrival).
      /** @type {any} */ (o.querySelector("#sbClubhouse")).onclick = () =>
        Shared.roomFX.leave("index.html", { from: "course" });
      const trs = o.querySelectorAll("tbody.players tr");
      trs.forEach((tr) => tr.classList.add("player-row"));
    }
  }

  Object.assign(global, {
    CircleUIManager,
    UIManager,
    PinManager,
    CourseHUD,
    CourseUI,
    BallsMenu,
    Scoreboard,
  });
  if (typeof module !== "undefined" && module.exports)
    module.exports = {
      CircleUIManager,
      UIManager,
      PinManager,
      CourseHUD,
      CourseUI,
      BallsMenu,
      Scoreboard,
    };
})(typeof globalThis !== "undefined" ? globalThis : this);
