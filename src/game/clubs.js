// clubs.js — ClubData, ClubSelector, ClubSystem.
// Split out of game.js; loaded as a plain <script> before game.js (see game.html),
// and require()-able in Node for unit tests. Cross-module refs resolve via globals.
(function (global) {
  // ─── CLUB DATA ──────────────────────────────────────────────────────────────

  class ClubData {
    // maxDistance = the club's estimate in metres (shown as yards in the UI).
    // v0 = full-power launch speed (m/s) at the club's loft, CALIBRATED so carry ≈
    //   maxDistance on the range with no wind. Regenerate after changing maxDistance
    //   (or ball physics) with: node scripts/club-calibrate.js
    static CLUBS = [
      { id: 0, name: "Putter", angle: 0, maxDistance: 22, v0: 17 },
      { id: 1, name: "Lob Wedge", angle: 60, maxDistance: 55, v0: 40 },
      { id: 2, name: "Pitching Wedge", angle: 45, maxDistance: 66, v0: 37.7 },
      { id: 3, name: "9 Iron", angle: 42, maxDistance: 88, v0: 45.4 },
      { id: 4, name: "8 Iron", angle: 39, maxDistance: 109, v0: 52.4 },
      { id: 5, name: "7 Iron", angle: 37, maxDistance: 131, v0: 59.6 },
      { id: 6, name: "6 Iron", angle: 34, maxDistance: 153, v0: 66.4 },
      { id: 7, name: "5 Iron", angle: 31, maxDistance: 175, v0: 73 },
      { id: 8, name: "4 Iron", angle: 28, maxDistance: 197, v0: 80.2 },
      { id: 9, name: "Hybrid", angle: 20, maxDistance: 241, v0: 93.3 },
      { id: 10, name: "3 Wood", angle: 16, maxDistance: 263, v0: 102.1 },
      { id: 11, name: "5 Wood", angle: 19, maxDistance: 252, v0: 96.9 },
      { id: 12, name: "Driver", angle: 12, maxDistance: 306, v0: 117 },
    ];

    static getClub(id) {
      return this.CLUBS[Shared.clamp(id, 0, this.CLUBS.length - 1)];
    }
  }

  // ─── CLUB SELECTOR ──────────────────────────────────────────────────────────

  class ClubSelector {
    constructor(circleUIManager = null) {
      this.circleUIManager = circleUIManager;
      this.currentClub = 12; // Default to driver
      this.manuallySelectedClub = false; // True if user manually picked a club
      this.clubButtonsAttached = false;
    }

    reset() {
      this.currentClub = 12;
      this.manuallySelectedClub = false;
      this.clubButtonsAttached = false;
    }

    /**
     * Find best club for a given distance.
     * @param {number} distance target distance in METRES (compared directly
     *   against ClubData.maxDistance, which is in metres). Callers must NOT
     *   pass yards.
     */
    findBestClubForDistance(distance, minId = 0) {
      let bestClubId = minId;
      let bestDifference = Infinity;
      for (let i = minId; i < ClubData.CLUBS.length; i++) {
        const club = ClubData.CLUBS[i];
        const predicted = this.getPredictedDistanceForClub(club);
        const difference = Math.abs(predicted - distance);
        if (difference < bestDifference) {
          bestDifference = difference;
          bestClubId = i;
        }
      }
      return bestClubId;
    }

    getPredictedDistanceForClub(club) {
      return club.maxDistance;
    }

    /**
     * The club to default to for a shot. On the green → the putter. Off the
     * green → the nearest club by distance but NEVER the putter (floored at the
     * most-lofted wedge, id 1), so a greenside chip defaults to a wedge instead
     * of the putter.
     */
    suggestClub(distance, onGreen) {
      if (onGreen) return 0; // putter
      return this.findBestClubForDistance(distance, 1); // exclude the putter
    }

    autoSelectClubIfNeeded(distance, onGreen = false) {
      if (!this.manuallySelectedClub) {
        this.currentClub = this.suggestClub(distance, onGreen);
        return true;
      }
      return false;
    }

    selectClub(clubId) {
      this.currentClub = Shared.clamp(clubId, 0, 12);
      this.manuallySelectedClub = true;
    }

    enableAutoSelect() {
      this.manuallySelectedClub = false;
    }

    updateUI() {
      if (!this.circleUIManager) return;

      const club = ClubData.getClub(this.currentClub);
      const prevClub = ClubData.getClub((this.currentClub - 1 + 13) % 13);
      const nextClub = ClubData.getClub((this.currentClub + 1) % 13);
      const mk = (c) => ({
        name: c.name,
        yds: Math.round(Utils.metersToYards(c.maxDistance)) + "'",
      });

      this.circleUIManager.updateClub(mk(club), mk(prevClub), mk(nextClub));

      // Attach carousel listeners once: tapping the preview above/below rolls it in.
      if (!this.clubButtonsAttached) {
        const buttons = this.circleUIManager.getClubButtons();
        if (buttons) {
          if (buttons.prevBtn) {
            buttons.prevBtn.onclick = (e) => {
              e.stopPropagation();
              this.rollTo("prev");
            };
          }
          if (buttons.nextBtn) {
            buttons.nextBtn.onclick = (e) => {
              e.stopPropagation();
              this.rollTo("next");
            };
          }
          this.clubButtonsAttached = true;
        }
      }
    }

    // Animate the carousel one step, then commit the new selection + re-render.
    rollTo(which) {
      if (this._rolling) return;
      this._rolling = true;
      this.circleUIManager.animateClubRoll(which, () => {
        const next =
          which === "prev"
            ? (this.currentClub - 1 + 13) % 13
            : (this.currentClub + 1) % 13;
        this.selectClub(next);
        this.updateUI();
        this._rolling = false;
      });
    }

    handleKeyPress(key) {
      if (key >= "0" && key <= "9") {
        this.selectClub(parseInt(key));
        return true;
      } else if (key === "q") {
        this.selectClub((this.currentClub + 1) % 13);
        return true;
      } else if (key === "e") {
        this.selectClub((this.currentClub - 1 + 13) % 13);
        return true;
      }
      return false;
    }
  }

  // ─── CLUB SYSTEM ──────────────────────────────────────────────────────────────

  class ClubSystem {
    constructor(scene) {
      this.scene = scene;
      this.clubsModel = null;
      this.allMeshes = [];
      this.isLoaded = false;
      this.swingInProgress = false;
    }

    async load(ballPosition) {
      try {
        const result = await Shared.loadModel(
          "models/equipment/clubs.glb",
          this.scene,
        );

        // Wrap the GLB root in a pivot node so we never overwrite its
        // built-in coordinate conversion (GLBs bake scaling/rotation into __root__)
        this.clubPivot = new BABYLON.TransformNode("clubPivot", this.scene);
        this.clubPivot.position = ballPosition.clone();
        // Match the real golf-ball scale (clubs.glb is authored at the old ~0.4 m
        // ball size); shrink the whole rig ~9.4× so the club fits the 42.7 mm ball.
        this.clubPivot.scaling = new BABYLON.Vector3(0.107, 0.107, 0.107);
        result.meshes[0].parent = this.clubPivot;

        this.clubsModel = result.meshes[0];
        this.allMeshes = result.meshes;

        // Position is now controlled via clubPivot, leave __root__ alone
        // permanently since re-enabling a child doesn't override a disabled parent)
        for (let i = 1; i < result.meshes.length; i++) {
          const mesh = result.meshes[i];
          if (mesh && mesh.name) {
            mesh.setEnabled(false);
          }
        }

        // Stop club animations from looping (skip bird animations)
        for (const animGroup of this.scene.animationGroups) {
          if (
            animGroup.name.startsWith("idle") ||
            animGroup.name.startsWith("flap")
          )
            continue;
          animGroup.loopAnimation = false;
          animGroup.stop();
        }

        this.isLoaded = true;
      } catch (error) {
        console.error("Failed to load clubs.glb:", error);
        this.isLoaded = false;
      }
    }

    getClubTypeName(clubId) {
      if (clubId === 0) return "putter";
      if (clubId >= 1 && clubId <= 8) return "iron";
      if (clubId >= 9 && clubId <= 12) return "driver";
      return null;
    }

    getClubMeshForType(clubId) {
      // Returns the first mesh for this club type (used to reference animation target)
      const typeName = this.getClubTypeName(clubId);
      if (!typeName) return null;
      for (const mesh of this.allMeshes) {
        if (
          mesh &&
          mesh.name &&
          mesh.name.toLowerCase().includes(typeName) &&
          !mesh.name.toLowerCase().includes("axis")
        ) {
          return mesh;
        }
      }
      return null;
    }

    async swing(
      clubId,
      forceRatio,
      ballPosition,
      shotDirection,
      onContactPoint = null,
      onSwingEnd = null,
    ) {
      if (!this.isLoaded || this.swingInProgress) return;

      this.swingInProgress = true;

      if (ballPosition && this.clubPivot) {
        this.clubPivot.position = ballPosition.clone();
      }
      if (shotDirection !== undefined && this.clubPivot) {
        // Match trajectory arrow convention: Math.PI + cameraRotation = Math.PI - shotDirection
        this.clubPivot.rotation.y = -shotDirection;
      }

      const typeName = this.getClubTypeName(clubId);
      if (!typeName) {
        console.warn(`[ClubSystem] No type name for club ${clubId}`);
        this.swingInProgress = false;
        return;
      }
      for (let i = 1; i < this.allMeshes.length; i++) {
        const mesh = this.allMeshes[i];
        if (mesh?.name && !mesh.name.toLowerCase().includes("axis")) {
          const belongs = mesh.name.toLowerCase().includes(typeName);
          mesh.setEnabled(belongs);
        }
      }

      const animationNames = {
        putter: "putterAction.001",
        iron: "ironAction.001",
        driver: "driverAction.001",
      };
      const animationName = animationNames[typeName];

      // Stop any running club animations (skip bird animations)
      for (const animGroup of this.scene.animationGroups) {
        if (
          animGroup.name.startsWith("idle") ||
          animGroup.name.startsWith("flap")
        )
          continue;
        animGroup.stop();
        animGroup.reset();
      }

      const animation = this.scene.getAnimationGroupByName(animationName);
      if (!animation) {
        console.warn(`[ClubSystem] Animation not found: ${animationName}`);
        this.swingInProgress = false;
        return;
      }

      // Contact point is 80% through the animation; play forward through follow-through to end
      const CONTACT_PERCENT = 0.8;
      const animFPS = 60;
      const frameStart = animation.from;
      const frameEnd = animation.to;
      const animFrameCount = frameEnd - frameStart;
      const contactFrame = frameStart + animFrameCount * CONTACT_PERCENT;

      // Harder hit = faster-looking swing. Full power = 1.0s total, weakest = 1.8s total.
      const totalSwingDuration = 1.8 - forceRatio * 0.8;
      const speedRatio = animFrameCount / animFPS / totalSwingDuration;

      animation.reset();
      animation.speedRatio = speedRatio;
      animation.loopAnimation = false;
      animation.play(false);

      // Use per-frame observable to fire contact callback at exactly CONTACT_PERCENT
      // This is reliable regardless of frame rate or setTimeout drift.
      let contactFired = false;
      const frameObserver = this.scene.onBeforeRenderObservable.add(() => {
        if (contactFired) return;
        // animation.animatables[0].masterFrame gives the current frame of the group
        const animatable = animation.animatables && animation.animatables[0];
        if (!animatable) return;
        const currentFrame = animatable.masterFrame;
        if (currentFrame >= contactFrame) {
          contactFired = true;
          if (onContactPoint) {
            onContactPoint();
          }
        }
      });

      animation.onAnimationGroupEndObservable.addOnce(() => {
        this.scene.onBeforeRenderObservable.remove(frameObserver);

        // Ensure contact fires even if the end lands exactly on or before contactFrame
        if (!contactFired) {
          contactFired = true;
          if (onContactPoint) {
            onContactPoint();
          }
        }

        // Hide ALL meshes for this club type (skip index 0 = root)
        for (let i = 1; i < this.allMeshes.length; i++) {
          const mesh = this.allMeshes[i];
          if (
            mesh &&
            mesh.name &&
            mesh.name.toLowerCase().includes(typeName) &&
            !mesh.name.toLowerCase().includes("axis")
          ) {
            mesh.setEnabled(false);
          }
        }

        if (onSwingEnd) {
          onSwingEnd();
        }

        this.swingInProgress = false;
      });
    }

    resetClubs() {
      for (let i = 1; i < this.allMeshes.length; i++) {
        const mesh = this.allMeshes[i];
        if (mesh?.name && !mesh.name.toLowerCase().includes("axis")) {
          mesh.setEnabled(false);
        }
      }
      for (const animGroup of this.scene.animationGroups) {
        if (
          animGroup.name.startsWith("idle") ||
          animGroup.name.startsWith("flap")
        )
          continue;
        animGroup.stop();
        animGroup.reset();
      }
    }

    dispose() {
      if (this.clubsModel) {
        this.clubsModel.dispose();
      }
    }
  }

  Object.assign(global, { ClubData, ClubSelector, ClubSystem });
  if (typeof module !== "undefined" && module.exports)
    module.exports = { ClubData, ClubSelector, ClubSystem };
})(typeof globalThis !== "undefined" ? globalThis : this);
