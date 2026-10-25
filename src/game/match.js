// match.js — MatchCoordinator: drives CourseManager from a networked match's
// server state (GolfNet `you.match`) instead of the local hot-seat loop.
//
// The server owns the hole order, each hole's pin and wind, whose turn it is
// and every lie. This side loads each hole with the server's conditions,
// lets the player aim and swing only on their turn (shotStart, then the
// ball's path streamed as pose samples, then shotEnd with where it finished),
// and otherwise spectates: the opponent's shot is replayed from their
// streamed path on a ghost ball (their gball + locker hat/skin, no collider)
// that then sits at their lie.
//
// Everything drawn comes from the latest view alone (a page opened mid-match
// draws the right hole, lies and turn without having seen earlier shots), and
// a shot is a self-contained record {player, hole, stroke, samples, restPos}
// that plays the same whether it is streaming in or stored (play()).
(function (global) {
  const FRAME_MS = 250; // path frames go out at most 4 a second
  const FRAME_SAMPLES = 32;
  const MAX_SHOT_S = 58; // the server expires an open shot 60 s after shotStart
  const r3 = (v) => Math.round(v * 1000) / 1000;
  const r4 = (v) => Math.round(v * 10000) / 10000;

  class MatchCoordinator {
    constructor(game) {
      this.game = game;
      this.net = null;
      this.hole = null; // "hole:windSeed" loaded
      this.loading = false;
      this.armedSeq = null; // turnSeq this side was handed the ball for
      this.shotSeq = null; // turnSeq this side has swung in
      this.shot = null; // own shot being recorded/streamed
      this.replay = null; // {rec, player}: a shot being played back on the ghost
      this.shots = []; // shot records seen this page load, own and opponent's
      this.early = []; // path frames that came before their hole loaded
      this.ghost = null;
      this.ghostStyled = null;
      this.spectating = false;
      this.holdUntil = 0;
      this.over = false;
      this.banner = null;
      this.ui = null;
      this.results = null; // hole results already shown on a card
    }

    start() {
      this.net = global.golfNet;
      if (!this.net) return;
      const ev = this.game.eventManager;
      ev.on("input:hit", () => this.onHit());
      ev.on("ball:landed", () => this.onLanded());
      ev.on("pin:holesink", () => this.endShot(true));
      this.game.scene.onBeforeRenderObservable.add(() => this.frame());
      this.makeGhost().then(() => this.sync());
      if (global.MatchUI && typeof document !== "undefined") {
        this.ui = new MatchUI({
          scene: this.game.scene,
          send: (t) => this.net.sendChat(t),
          anchor: (id) => this.anchor(id),
        });
        this.ui.chat(this.net.chatLog, this.net.playerId, false);
      }
      this.net.onMatch = () => {
        this.onView();
        this.sync();
      };
      this.net.onPath = (d) => this.onPath(d);
      this.sync();
    }

    get view() {
      return this.net?.you?.match ?? null;
    }

    opponent(m) {
      return m.teeOrder.find((id) => id !== this.net.playerId) ?? null;
    }

    // Whose turn it is, from the server's view: the one place that decides
    // whether this side may play.
    myTurn(m = this.view) {
      return (
        !!m &&
        m.phase === "playing" &&
        m.turn === this.net.playerId &&
        !this.replay
      );
    }

    canAim() {
      const m = this.view;
      return (
        this.myTurn(m) &&
        this.armedSeq === m.turnSeq &&
        this.shotSeq !== m.turnSeq
      );
    }

    // A player the server doesn't say is gone counts as here.
    present(m, id) {
      return m.present?.[id] !== false;
    }

    // ---- following the server ---------------------------------------------

    onView() {
      const m = this.view;
      this.ui?.chat(this.net.chatLog, this.net.playerId);
      if (!m) return;
      this.chip(matchStatus(m, this.net.playerId));
      if (this.results === null) this.results = m.holeResults?.length ?? 0;
    }

    // The hole's result card, once the shot that decided it has played out.
    showResults(m) {
      const res = m.holeResults || [];
      if (this.results === null || res.length <= this.results) return;
      this.results = res.length;
      this.ui?.holeCard(res[res.length - 1], m.names || {});
    }

    anchor(id) {
      if (id === "me" || id === this.net.playerId)
        return this.game.golfBall.getPosition();
      const g = this.ghost?.root;
      return g?.isEnabled() ? g.position : null;
    }

    sync() {
      const m = this.view;
      if (!m || this.loading || this.shot) return;
      if (m.phase === "finished") {
        if (this.replay) this.replay.closed = true;
        else {
          // A last shot that ended in a hazard or a pick-up leaves the ghost
          // wherever its replay stopped.
          this.placeGhost(m, this.opponent(m));
          this.showResults(m);
          this.finish(m);
        }
        return;
      }
      if (m.phase !== "playing") return;
      const open = m.shotOpen;
      if (this.replay && open?.id !== this.replay.shot)
        this.replay.closed = true;
      const key = `${m.hole}:${m.windSeed}`;
      if (key !== this.hole) {
        // Let the last shot play out and its result show before the swap.
        if (this.replay) return;
        this.showResults(m);
        const wait = this.holdUntil - Date.now();
        if (wait > 0) {
          clearTimeout(this._wait);
          this._wait = setTimeout(() => this.sync(), wait);
          return;
        }
        this.loadHole(m, key);
        return;
      }

      const opp = this.opponent(m);
      if (open && open.playerId === opp && this.replay?.shot !== open.id)
        this.watch(open.id, open.aim);
      this.placeGhost(m, opp);

      if (this.myTurn(m)) {
        if (this.shotSeq === m.turnSeq) return; // ours is in: the server decides next
        if (this.armedSeq !== m.turnSeq) this.arm(m);
        this.say("Your shot");
      } else if (m.turn !== this.net.playerId) {
        this.spectate(m, opp);
        const name = m.names[m.turn] ?? "";
        const lie = m.lies[m.turn];
        this.say(
          !m.turn
            ? ""
            : !this.present(m, m.turn)
              ? `${name} is offline`
              : lie && lie.strokes === 0
                ? `${name} has the honor`
                : `${name} is away`,
        );
      }
    }

    async loadHole(m, key) {
      const cm = this.game.courseManager;
      this.loading = true;
      this.hole = key;
      this.armedSeq = this.shotSeq = null;
      this.spectating = false;
      this.follow(null);
      this.ghost?.root.setEnabled(false);
      try {
        if (this._loadedOnce) {
          await Shared.roomFX.irisClose();
          cm.disposeHole();
        }
        this._loadedOnce = true;
        await cm.loadHole(m.hole, m.pinIndex, m.windSeed);
      } catch (e) {
        console.error("Failed to load the match hole:", e);
        Shared.roomFX.clearCovers();
        Shared.hideBoot();
      }
      this.loading = false;
      for (const d of this.early.splice(0)) this.onPath(d);
      this.sync();
    }

    // CourseManager.loadHole's tail in a match: who plays first is the server's call.
    holeLoaded() {
      this.game.courseManager.holeSinkGuardReset();
      this.game.currentHoleShotCount = 0;
    }

    arm(m) {
      const game = this.game;
      const cm = game.courseManager;
      const lie = m.lies[this.net.playerId];
      this.armedSeq = m.turnSeq;
      this.spectating = false;
      this.follow(null);
      if (!lie.pos) {
        cm.beginTurn();
        return;
      }
      this.toLie(lie);
      cm.lastLie = new BABYLON.Vector3(lie.pos.x, lie.pos.y, lie.pos.z);
      cm.busy = false;
      game.isControlsDisabled = false;
      game.currentHoleShotCount = lie.strokes;
      game.gameState = GameState.AIM;
      game._awaitingSettle = false;
      game.aimView?.activate();
      game.circleUIManager?.showStatsCircle();
    }

    // Put this side's ball where the server has it. Normally it already lies
    // there; not after a shot that timed out, or one still creeping when it
    // was reported at rest.
    toLie(lie) {
      const ball = this.game.golfBall;
      const p = ball.getPosition();
      if (Math.hypot(p.x - lie.pos.x, p.y - lie.pos.y, p.z - lie.pos.z) > 0.01)
        ball.teleport(lie.pos.x, lie.pos.y + 0.002, lie.pos.z);
    }

    spectate(m, opp) {
      if (this.spectating) return;
      this.spectating = true;
      const game = this.game;
      const mine = m.lies[this.net.playerId];
      if (mine?.pos && !mine.holed && !mine.pickedUp && !this.shot)
        this.toLie(mine);
      game.isControlsDisabled = true;
      game.courseManager.busy = true;
      game.aimView?.deactivate();
      game.circleUIManager?.hideClubCircle();
      game.circleUIManager?.hidePowerCircle();
      const lie = opp && m.lies[opp];
      // Before their tee shot there's no ghost: frame this side's ball on the
      // tee. Either way drop whatever framing the last shot or hole left.
      const pos = lie?.pos && !lie.holed ? lie.pos : null;
      this.follow(pos);
      this.aimCam(pos ?? game.golfBall.getPosition(), null);
      game.camera?.syncFromCamera?.();
    }

    // Point the follow camera at the ghost (toward `aim`, else the cup), or
    // give it back to this side's ball (pos null).
    follow(pos, aim = null) {
      const cam = this.game.camera;
      if (!cam) return;
      if (!pos || !this.ghost) {
        cam.targetMesh = this.game.golfBall.mesh;
        cam.golfBallGuy = this.game.golfBall;
        return;
      }
      cam.targetMesh = this.ghost.root;
      cam.golfBallGuy = this.ghost;
      this.aimCam(pos, aim);
    }

    // Look from behind `pos` toward `aim`, else the cup. `aim` is the
    // shooter's getShotDirection(), which is already a follow-camera angle.
    aimCam(pos, aim) {
      const cam = this.game.camera;
      if (!cam) return;
      const cup = this.game.courseManager.cup;
      const dir =
        aim ?? (cup ? Math.atan2(cup.x - pos.x, -(cup.z - pos.z)) : 0);
      cam.setCameraAngle(dir);
      cam.setPlayView();
    }

    finish(m) {
      if (this.over) return;
      this.over = true;
      const mine = matchStatus(m, this.net.playerId);
      this.say("");
      Splash.show({
        title: mine || "Match over",
        detail: m.result?.text ?? m.status ?? "",
        buttons: [
          {
            label: "Clubhouse",
            kind: "go",
            cancel: true,
            onClick: () =>
              Shared.roomFX.leave(Challenge.clubhouseUrl(location), {
                from: "course",
              }),
          },
        ],
      });
    }

    say(text) {
      this.makeBanner();
      if (this.banner) this.banner.children[0].textContent = text;
    }

    // The match-play status chip under the banner ("2 UP").
    chip(text) {
      this.makeBanner();
      const c = this.banner?.children[1];
      if (!c) return;
      c.textContent = text;
      c.style.display = text ? "inline-block" : "none";
    }

    makeBanner() {
      if (typeof document === "undefined") return;
      if (!this.banner) {
        const b = document.createElement("div");
        b.style.cssText =
          "position:fixed;top:12px;left:50%;transform:translateX(-50%);" +
          "z-index:9000;pointer-events:none;text-align:center;color:#fff;" +
          'font:bold 26px "DrawvidHand","Comic Sans MS",cursive,sans-serif;' +
          "text-shadow:2px 2px 4px rgba(0,0,0,.8);max-width:calc(100vw - 32px)";
        b.innerHTML =
          "<div></div><div style='display:inline-block;margin-top:4px;" +
          "padding:2px 14px;font-size:18px;border-radius:999px;" +
          "background:rgba(144,200,150,.9);border:3px solid #476a23;" +
          "text-shadow:1px 1px 0 rgba(0,0,0,.6)'></div>";
        document.body.appendChild(b);
        this.banner = b;
      }
    }

    // ---- the ghost ball -----------------------------------------------------

    async makeGhost() {
      const scene = this.game.scene;
      let res;
      try {
        res = await Shared.loadModel("models/characters/golf-ball.glb", scene);
      } catch (e) {
        console.warn("Ghost ball failed to load", e);
        return;
      }
      const root = new BABYLON.TransformNode("ghostBall", scene);
      root.rotationQuaternion = BABYLON.Quaternion.Identity();
      for (const mesh of res.meshes) {
        if (!mesh) continue;
        mesh.parent = root;
        mesh.position = BABYLON.Vector3.Zero();
        mesh.scaling = new BABYLON.Vector3(0.0254, 0.0254, 0.0254);
        mesh.isPickable = false; // a click on it must not count as one on our ball
      }
      Utils.addShadowCasters(res.meshes, scene.shadowGenerator);
      root.setEnabled(false);
      this.ghost = {
        root,
        meshes: res.meshes,
        getRenderPosition: () => root.position,
      };
    }

    styleGhost(opp) {
      if (!this.ghost || this.ghostStyled === opp) return;
      const p = (this.net.you?.players || []).find((x) => x.id === opp);
      if (!p) return;
      this.ghostStyled = opp;
      const st = BallsStyle.normalizeStyle(p.style);
      const scene = this.game.scene;
      BallsStyle.applySkin(scene, this.ghost.meshes, st.skin, null);
      const hat = BallsStyle.buildHat(scene, st.hat);
      if (hat) {
        const mount = new BABYLON.TransformNode("ghostHat", scene);
        mount.parent = this.ghost.root;
        mount.scaling.setAll(0.0254);
        hat.parent = mount;
        for (const m of hat.getChildMeshes(false)) m.isPickable = false;
      }
    }

    placeGhost(m, opp) {
      if (!this.ghost || !opp || this.replay) return;
      this.styleGhost(opp);
      const lie = m.lies[opp];
      const show = !!lie?.pos && !lie.holed && !lie.pickedUp;
      this.ghost.root.setEnabled(show);
      if (show) this.ghost.root.position.set(lie.pos.x, lie.pos.y, lie.pos.z);
    }

    // ---- the opponent's shot ----------------------------------------------

    // The opponent's live shot: its record fills as the samples stream in.
    watch(shot, aim) {
      const m = this.view;
      const opp = this.opponent(m);
      const rec = {
        player: opp,
        hole: m.hole,
        stroke: (m.lies[opp]?.strokes ?? 0) + 1,
        samples: [],
        restPos: null,
      };
      this.play(rec, { live: true, shot, aim });
    }

    // Replay a shot record on the ghost: a stored one at once, a live one
    // (live: true) as its samples arrive.
    play(rec, { live = false, shot = null, aim = null } = {}) {
      const player = new PathPlayer(rec.samples);
      rec.samples = player.samples;
      if (!live) player.end();
      this.shots.push(rec);
      this.replay = {
        rec,
        player,
        shot,
        live,
        lastAt: performance.now(),
        closed: !live,
      };
      if (this.ghost) {
        this.styleGhost(rec.player);
        const p = this.ghost.root.position;
        const first = rec.samples[0];
        if (first) p.set(first[1], first[2], first[3]);
        else p.copyFrom(this.game.courseManager.tee);
        this.follow(p, aim);
      }
    }

    onPath(d) {
      if (d.playerId === this.net.playerId) return;
      if (!this.replay?.live || this.replay.shot !== d.shot) {
        // A shot on a hole that isn't loaded yet waits for the load.
        const m = this.view;
        if (this.loading || !m || `${m.hole}:${m.windSeed}` !== this.hole) {
          this.early.push(d);
          return;
        }
        this.watch(d.shot, m.shotOpen?.aim ?? null);
      }
      this.replay.player.push(d.samples);
      this.replay.lastAt = performance.now();
    }

    // ---- this side's shot ---------------------------------------------------

    onHit() {
      const m = this.view;
      if (!this.canAim() || this.shot) return;
      this.shotSeq = m.turnSeq;
      const game = this.game;
      const rec = {
        player: this.net.playerId,
        hole: m.hole,
        stroke: m.lies[this.net.playerId].strokes + 1,
        samples: [],
        restPos: null,
      };
      this.shots.push(rec);
      this.net.shotStart(
        game.aimView?.currentClub ?? 12,
        game.getShotDirection(),
        m.turnSeq,
      );
      this.shot = {
        t0: performance.now(),
        counted: game.currentHoleShotCount,
        sampler: new PathSampler(),
        queue: [],
        lastT: -1,
        last: null,
        sentAt: 0,
        end: null, // {holed} once the ball is done
        rec,
      };
    }

    pose(t) {
      const ball = this.game.golfBall;
      const p = ball.getPosition();
      const q = ball.mesh.rotationQuaternion || BABYLON.Quaternion.Identity();
      return [t, p.x, p.y, p.z, q.x, q.y, q.z, q.w];
    }

    queue(s) {
      const sh = this.shot;
      const out = [
        r3(s[0]),
        r3(s[1]),
        r3(s[2]),
        r3(s[3]),
        r4(s[4]),
        r4(s[5]),
        r4(s[6]),
        r4(s[7]),
      ];
      if (out[0] <= sh.lastT) return; // t must strictly increase
      sh.lastT = out[0];
      sh.queue.push(out);
      sh.rec.samples.push(out);
    }

    onLanded() {
      const sh = this.shot;
      if (!sh || sh.end) return;
      // The course's own handler ran first: a water drop has already counted.
      this.endShot(false);
    }

    endShot(holed) {
      const sh = this.shot;
      if (!sh || sh.end) return;
      const t = (performance.now() - sh.t0) / 1000;
      const penalty = this.game.currentHoleShotCount > sh.counted;
      // A penalty has already moved the ball to its drop: the path ends
      // where it left play.
      const pose = penalty && sh.last ? [t, ...sh.last.slice(1)] : this.pose(t);
      for (const s of sh.sampler.end(pose)) this.queue(s);
      sh.end = { holed, at: performance.now() };
      if (holed) this.holdUntil = Date.now() + 2500;
    }

    sendEnd() {
      const sh = this.shot;
      const game = this.game;
      const cm = game.courseManager;
      while (sh.queue.length) this.net.path(sh.queue.splice(0, FRAME_SAMPLES));
      const penalty = game.currentHoleShotCount - sh.counted;
      const p = game.golfBall.getPosition();
      sh.rec.restPos = { x: r3(p.x), y: r3(p.y), z: r3(p.z) };
      this.net.shotEnd(sh.rec.restPos, sh.end.holed, penalty);
      this.shot = null;
      game.isControlsDisabled = true;
      cm.busy = true;
      this.sync();
    }

    // ---- per frame ----------------------------------------------------------

    frame() {
      this.ui?.frame();
      const dt = this.game.engine.getDeltaTime() / 1000;
      const sh = this.shot;
      if (sh) {
        const ball = this.game.golfBall;
        const t = (performance.now() - sh.t0) / 1000;
        if (!sh.end) {
          // Out of bounds drops the ball without a landing: the count says so.
          if (this.game.currentHoleShotCount > sh.counted) this.endShot(false);
          else if (ball.inShot) {
            sh.last = this.pose(t);
            for (const s of sh.sampler.push(sh.last)) this.queue(s);
            if (t > MAX_SHOT_S) this.endShot(false);
          }
        }
        const now = performance.now();
        if (sh.queue.length && now - sh.sentAt >= FRAME_MS) {
          sh.sentAt = now;
          this.net.path(sh.queue.splice(0, FRAME_SAMPLES));
        }
        // A penalty drop is sent once it has settled (or after 3 s).
        if (
          sh.end &&
          (sh.end.holed ||
            this.game.currentHoleShotCount === sh.counted ||
            ball.isLanded() ||
            now - sh.end.at > 3000)
        )
          this.sendEnd();
      }

      const r = this.replay;
      if (r) {
        // The shot is over on the server, but its last samples can trail the
        // view by a snapshot or two.
        if (r.closed && !r.player.ended && performance.now() - r.lastAt > 400)
          r.player.end();
        const pose = r.player.step(dt);
        if (pose && this.ghost) {
          const g = this.ghost.root;
          g.setEnabled(true);
          g.position.set(pose[0], pose[1], pose[2]);
          g.rotationQuaternion.set(pose[3], pose[4], pose[5], pose[6]);
        }
        if (r.player.done) {
          this.replay = null;
          // Where the server put the ball (a drop after a hazard, too).
          const lie = this.view?.lies?.[r.rec.player];
          if (r.live && lie) r.rec.restPos = lie.holed ? null : lie.pos;
          this.holdUntil = Math.max(this.holdUntil, Date.now() + 1500);
          this.spectating = false;
          this.sync();
        }
      }
    }
  }

  Object.assign(global, { MatchCoordinator });
  if (typeof module !== "undefined" && module.exports)
    module.exports = { MatchCoordinator };
})(typeof globalThis !== "undefined" ? globalThis : this);
