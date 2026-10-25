// Sim client: a real game client in Node for live multiplayer tests. It is a
// protocol Bot (test/mp/bot.js) that also runs the game's physics on the real
// hole (test/helpers/course-world.js: Havok, CourseManager.loadHole,
// GolfBallGuy, the cavity cup, trees and rocks).
//
// It follows the server: whenever the match moves to a hole it loads that
// hole with the server's pinIndex and sets the wind from the server's
// windSeed (Wind.fromSeed, shared with the browser client). On its turn it
// places its ball at the server's lie, picks a club and a target (simple
// course-aware heuristic), swipes through the real InputHandler pointer path
// (and sometimes swipes spin mid-air the same way), simulates the shot at
// fixed frames, streams pose samples as `path` frames (path-sampler.js picks
// them: where the path bends, a few a second, batched into 4 frames a second),
// and closes the shot with its true rest / holed / penalty. Water and
// out-of-bounds are the game's own CourseManager penalties.
//
// Ground truth is kept per shot (this.shots[]: every frame's pose, the
// samples actually sent, the rest) for test/mp/checks.js.
//
// Pacing: opts.timeScale = 1 plays in real time (sample t = seconds since the
// shot opened); 4 runs four times faster than real time; Infinity simulates as
// fast as the CPU allows (path frames are still sent at <= frameHz a second).
const { setTimeout } = require("node:timers");
const { Bot } = require("./bot.js");
const { PathSampler } = require("./path-sampler.js");
const { createCourse, B } = require("../helpers/course-world.js");
const H = require("../helpers/havok-harness.js");
const { GameState } = require("../../src/game/config.js");
const { PhysicsConfig } = require("../../src/game/physics.js");
const { ClubData } = require("../../src/game/clubs.js");
const { EventManager, Utils } = require("../../src/game/utils.js");
const { InputHandler } = require("../../src/game/input.js");
const { COURSE_HOLES } = require("../../src/game/course.js");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const v3 = (p) => ({ x: p.x, y: p.y, z: p.z });
const flat = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
const r3 = (v) => Math.round(v * 1000) / 1000;
const r4 = (v) => Math.round(v * 10000) / 10000;

function makeRng(seed) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  next.gauss = () =>
    Math.sqrt(-2 * Math.log(1 - next())) * Math.cos(2 * Math.PI * next());
  return next;
}

const DEFAULTS = {
  timeScale: 1,
  fps: 60,
  sampler: {}, // PathSampler options
  // Path messages per wall-clock second, at most. Each costs ~60 bytes of
  // envelope, as much as a sample: fewer, fuller frames keep a moving ball's
  // stream inside the plan's ~1 KB/s.
  frameHz: 4,
  maxSamplesPerFrame: 32,
  spinChance: 0.35,
  aimSigmaDeg: 1,
  puttAimSigmaDeg: 0.6,
  powerSigma: 0.04,
  puttPowerSigma: 0.05,
  // Shot seconds (from shotStart) after which a ball still moving is called
  // stuck and its shot ended where it is. Genuine roll-outs run past 50 s;
  // the server expires an open shot 60 s after shotStart.
  maxShotSeconds: 58,
  lookahead: 6, // simulated tries before each shot (0: play the assist blind)
  autoplay: true,
  seed: null,
};

class SimClient extends Bot {
  constructor(url, name, opts = {}) {
    super(url, name, opts);
    this.opts = { ...DEFAULTS, ...opts };
    if (this.opts.seed == null) this.opts.seed = (Math.random() * 2 ** 31) | 0;
    this.rand = makeRng(this.opts.seed);
    this.world = null;
    this.shots = []; // this client's shots, with ground truth
    this.holes = []; // conditions as this client loaded them
    this.errors = [];
    this.shooting = false;
    this._busy = false;
    this._again = false;
    this._awaiting = null; // the last shot, until the server's view reflects it
    this.onSnapshot = () => this._kick();
  }

  async connect(opts) {
    await this.buildWorld();
    return super.connect(opts);
  }

  // The game world this client plays in (connect() builds it; tests that
  // feed snapshots in by hand call it alone).
  async buildWorld() {
    if (this.world) return;
    this.world = await createCourse({ fps: this.opts.fps });
    this.world.events.on("pin:holesink", () => (this._sunk = true));
    this.world.events.on("ball:landed", (p) => (this._landedAt = p));
    this._hitEvents = new EventManager();
    this._input = new InputHandler(
      { addEventListener() {} },
      this.world.ball,
      this.world.game,
      this._hitEvents,
    );
  }

  dispose() {
    this.opts.autoplay = false;
    this.close();
    this.world?.dispose();
    this.world = null;
  }

  records() {
    return {
      ...super.records(),
      seed: this.opts.seed,
      shots: this.shots,
      holes: this.holes,
      errors: this.errors.map((e) => String(e?.stack || e)),
    };
  }

  // ---- driving -------------------------------------------------------------

  _kick() {
    if (!this.opts.autoplay || !this.world) return;
    if (this._busy) {
      this._again = true;
      return;
    }
    this._busy = true;
    (async () => {
      try {
        do {
          this._again = false;
          await this._step();
        } while (this._again && this.opts.autoplay && this.world);
      } catch (e) {
        this.errors.push(e);
        if (this.log) console.error(`[${this.name}]`, e);
      } finally {
        this._busy = false;
      }
    })();
  }

  async _step() {
    const m = this.match;
    if (!m || m.phase !== "playing" || this.closed) return;
    if (this._awaiting && !this._reflected(this._awaiting)) return;
    this._awaiting = null;
    await this.ensureHole(m);
    // ws emits every message of one read at once, so a newer view (the next
    // hole, even) can land while the hole loads: only play the loaded hole.
    const now = this.match;
    if (now?.hole !== m.hole || now.windSeed !== m.windSeed) {
      this._again = true;
      return;
    }
    if (this.isMyTurn()) await this.takeTurn(now);
  }

  // The server has dealt with our last shot: the turn it was played in is
  // over (turnSeq moves on at every turn, and with the hole), or the match
  // is. Notices don't count: one may answer an older action.
  _reflected(a) {
    const m = this.match;
    return !m || m.phase !== "playing" || m.turnSeq !== a.turnSeq;
  }

  /** Load the match's current hole with the server's pin and wind. */
  async ensureHole(m) {
    const w = this.world;
    const loaded = this.holes[this.holes.length - 1];
    if (loaded?.hole === m.hole && loaded.server.windSeed === m.windSeed)
      return;
    await w.loadHole(m.hole, m.pinIndex);
    w.wind.setFromSeed(m.windSeed);
    const c = w.course;
    this.holes.push({
      at: Date.now(),
      code: this.code,
      hole: m.hole,
      holeId: COURSE_HOLES[m.hole].id,
      version: COURSE_HOLES[m.hole].version,
      server: {
        holeId: m.holeId,
        version: m.version,
        pinIndex: m.pinIndex,
        pin: m.pin,
        windSeed: m.windSeed,
      },
      pin: v3(c.pinPool[m.pinIndex]),
      cup: v3(c.cup),
      tee: v3(c.tee),
      wind: { direction: w.wind.direction, speed: w.wind.speed },
      // Tree and rock colliders as built: [type, x, y, z, yaw, scale].
      decor: w.decor.map((d) => [
        d.type,
        r3(d.pos.x),
        r3(d.pos.y),
        r3(d.pos.z),
        r4(d.yaw),
        r4(d.scale),
      ]),
    });
  }

  // ---- one shot ------------------------------------------------------------

  async takeTurn(m) {
    const w = this.world;
    const { ball, clubSelector } = w;
    const lie = m.lies[this.playerId];
    this.shooting = true;
    try {
      const fromTee = lie.pos === null;
      // Play from the server's lie. Our ball is normally already there; it
      // isn't after a shot that didn't count or timed out.
      const here = ball.getPosition();
      if (
        fromTee ||
        !ball.isLanded() ||
        Math.hypot(here.x - lie.pos.x, here.y - lie.pos.y, here.z - lie.pos.z) >
          0.01
      ) {
        this._place(fromTee ? null : lie.pos, 0.002);
        // The server's lie is now the one a penalty replays from.
        if (!fromTee)
          w.course.lastLie = new B.Vector3(lie.pos.x, lie.pos.y, lie.pos.z);
      }
      const start = v3(ball.getPosition());

      const plan = this._plan(start, fromTee);
      if (this.opts.lookahead) {
        // Each try's landing moves the course's last lie; the real swing must
        // find it (and the ball) as the player's own game left them.
        const lastLie = w.course.lastLie.clone();
        await this._refine(plan, start, fromTee);
        this._place(fromTee ? null : start);
        w.course.lastLie = lastLie;
        // The tries take real time, and the server may have moved on meanwhile
        // (the turn ran out, the opponent left): don't swing on a turn that's over.
        const now = this.match;
        if (
          now?.phase !== "playing" ||
          now.turnSeq !== m.turnSeq ||
          !this.isMyTurn()
        ) {
          this._again = true;
          return;
        }
      }
      const from = v3(ball.getPosition());
      // The player's error: where they point the camera, and how hard they
      // swipe along the assist's arrow.
      const sigma =
        ((plan.putt ? this.opts.puttAimSigmaDeg : this.opts.aimSigmaDeg) *
          Math.PI) /
        180;
      plan.aim = plan.bearing + this.rand.gauss() * sigma;
      plan.power =
        1 +
        this.rand.gauss() *
          (plan.putt ? this.opts.puttPowerSigma : this.opts.powerSigma);
      clubSelector.currentClub = plan.club.id;
      const hit = this._swipe(plan, plan.strength * plan.power);
      if (!hit) throw new Error(`${this.name}: swipe produced no input:hit`);

      const shot = {
        code: this.code,
        hole: m.hole,
        holeId: m.holeId,
        turnSeq: m.turnSeq,
        strokesBefore: lie.strokes,
        from,
        fromTee,
        club: plan.club.id,
        aim: plan.aim,
        target: v3(plan.target),
        strength: plan.strength,
        power: plan.power,
        trials: plan.trials,
        hit,
        // Snapshots received before the swing: checks.js orders the shot
        // against the views by it (several can share a millisecond).
        snapIdx: this.snaps.length,
        spins: [],
        truth: [], // every frame: [t, x, y, z, qx, qy, qz, qw], t = s since shotStart
        sent: [], // the samples streamed (rounded as sent)
        sentAt: [], // wall ms each sent sample left in a path frame
        openedAt: Date.now(),
      };
      this.shots.push(shot);
      this.shotStart(plan.club.id, plan.aim, m.turnSeq);
      await this._fly(shot, hit, plan);
      await this._drainPath();
      shot.rest = v3(ball.getPosition());
      shot.endSentAt = Date.now();
      this.shotEnd(shot.rest, shot.holed, shot.penalty);
      this._awaiting = { at: Date.now(), turnSeq: m.turnSeq };
    } finally {
      this.shooting = false;
    }
  }

  // Ball at rest on the tee (beginTurn: tee peg for the woods, as the game
  // starts every hole) or at `pos`, dropped from `lift` m above it (a lie
  // rounded to the server's mm can sit a hair inside the turf). Leaves the
  // course's last lie to the game, as a player's own game would.
  _place(pos, lift = 0) {
    const { ball, course } = this.world;
    if (pos) {
      ball.teleport(pos.x, pos.y + lift, pos.z);
      ball.landed = false;
      ball.touchedGround = false;
    } else {
      course.beginTurn();
    }
    this._settle(3);
    const p = ball.getPosition();
    if (pos && Math.hypot(p.x - pos.x, p.y - pos.y, p.z - pos.z) > 0.005) {
      // Set down again on a slope or a rock flank, a ball can creep off a
      // spot where the player's own ball lay still, or settle lower into it
      // (2.4 cm, seen once): put it back, at rest.
      ball.teleport(pos.x, pos.y + lift, pos.z);
      ball.landed = true;
      ball.touchedGround = true;
    }
    course.busy = false;
  }

  // Run unpaced frames until the ball is at rest (placements, drops).
  _settle(seconds) {
    const w = this.world;
    for (let i = 0; i < seconds * w.fps; i++) {
      if (w.frame() === "fullLand" || w.ball.isLanded()) break;
    }
  }

  // Club, target and swipe strength: putt the cup on the green; otherwise go
  // at the cup when it's in reach, else lay up to the best spot (fairway or
  // green, nearest the cup) a full club can carry to.
  _plan(pos, fromTee) {
    const { course, clubSelector } = this.world;
    const cup = course.cup;
    const onGreen = course.isOnGreen(pos);
    let target = cup;
    if (!onGreen) target = this._layup(pos, cup) || cup;
    let clubId;
    if (onGreen) clubId = 0;
    else if (
      fromTee &&
      target === cup &&
      clubSelector.findBestClubForDistance(
        B.Vector3.Distance(course.tee, cup),
      ) >= 10
    )
      clubId = 12; // beginTurn's teed-up driver
    else
      clubId = clubSelector.suggestClub(
        B.Vector3.Distance(new B.Vector3(pos.x, pos.y, pos.z), target),
        false,
      );
    const club = ClubData.getClub(clubId);
    const dist = flat(pos, target);
    const strength = this._input.solveSwipeStrengthForDistance(
      dist,
      PhysicsConfig.STEP_SECONDS,
      PhysicsConfig.BALL_LINEAR_DAMPING,
      Math.abs(PhysicsConfig.GRAVITY.y),
      club,
    );
    const bearing = Math.atan2(target.x - pos.x, -(target.z - pos.z));
    return {
      club,
      target,
      bearing,
      strength,
      dist,
      putt: club.angle === 0,
      trials: [],
    };
  }

  _layup(pos, cup) {
    const { scene, course } = this.world;
    const reach = ClubData.getClub(12).maxDistance;
    if (flat(pos, cup) <= reach * 0.9) return null;
    const bearing = Math.atan2(cup.x - pos.x, -(cup.z - pos.z));
    const down = new B.Vector3(0, -1, 0);
    let best = null;
    for (let deg = -50; deg <= 50; deg += 5) {
      for (const frac of [0.85, 0.75, 0.65]) {
        const a = bearing + (deg * Math.PI) / 180;
        const r = reach * frac;
        const x = pos.x + Math.sin(a) * r;
        const z = pos.z - Math.cos(a) * r;
        const hit = scene.pickWithRay(
          new B.Ray(new B.Vector3(x, 300, z), down, 600),
          (mesh) => mesh.name.startsWith("surf_"),
        );
        if (!hit?.hit) continue;
        const kind = course.surfaces.forSurfaceName(hit.pickedMesh.name);
        const cost = { green: 0, fairway: 0, rough: 25, sand: 40 }[kind];
        if (cost === undefined) continue;
        const score =
          Math.hypot(cup.x - x, cup.z - z) + cost + Math.abs(deg) * 0.3;
        if (!best || score < best.score) best = { score, p: hit.pickedPoint };
      }
    }
    return best?.p ?? null;
  }

  // A player reads the hole (elevation, wind, slope) from practice and the
  // aim arrow; the sim gets there by trying the shot, each try simulated for
  // real and undone, correcting line and strength from where it finished
  // (or went out of play), and keeping the best try.
  async _refine(plan, start, fromTee) {
    const { cup } = this.world.course;
    const goal = plan.target;
    let bearing = plan.bearing;
    let strength = Math.min(plan.strength, 1.75);
    let best = null;
    for (let i = 0; i < this.opts.lookahead; i++) {
      this._place(fromTee ? null : start);
      const r = this._trial(plan, bearing, strength);
      const cost = r.holed
        ? -1
        : r.penalty
          ? 1000 + flat(r.end, goal)
          : flat(r.rest, goal === cup ? cup : goal);
      plan.trials.push({
        bearing,
        strength,
        cost,
        holed: r.holed,
        penalty: r.penalty,
      });
      if (!best || cost < best.cost) best = { bearing, strength, cost };
      if (r.holed || cost < (plan.putt ? 0.05 : 1)) break;
      const want = flat(start, goal);
      const got = flat(start, r.end);
      if (got < 0.01) {
        strength = Math.min(strength * 1.5, 1.75);
      } else {
        const off =
          Math.atan2(r.end.x - start.x, -(r.end.z - start.z)) -
          Math.atan2(goal.x - start.x, -(goal.z - start.z));
        bearing -= Math.atan2(Math.sin(off), Math.cos(off));
        strength = Math.min(
          strength * Math.min(1.6, Math.max(0.6, Math.sqrt(want / got))),
          1.75,
        );
      }
      await sleep(0);
    }
    plan.bearing = best.bearing;
    plan.strength = best.strength;
  }

  // One shot simulated and undone (no network): where it came to rest, and
  // `end`, where it left play if it did.
  _trial(plan, bearing, strength) {
    const w = this.world;
    const { ball, game, course, clubSelector } = w;
    clubSelector.currentClub = plan.club.id;
    const hit = this._swipe({ ...plan, bearing }, strength);
    const count = game.currentHoleShotCount;
    this._sunk = false;
    this._landedAt = null;
    ball.landed = false;
    ball.applyHit(
      hit.deltaX,
      hit.deltaY,
      hit.force,
      bearing,
      plan.club.angle,
      plan.club.v0,
    );
    const r = { holed: false, penalty: 0, rest: null, end: null };
    let last = v3(ball.getPosition());
    for (let i = 0; i < this.opts.maxShotSeconds * w.fps; i++) {
      const state = w.frame();
      if (game.currentHoleShotCount > count) {
        r.penalty = 1;
        r.end = this._landedAt ? v3(this._landedAt) : last;
        break;
      }
      last = v3(ball.getPosition());
      if (this._sunk || state === "fullLand") break;
    }
    r.holed = this._sunk;
    r.rest = v3(ball.getPosition());
    r.end ||= r.rest;
    game.currentHoleShotCount = count;
    const pin = course.pinManager.pins[0];
    if (pin)
      Object.assign(pin, { sunk: false, captured: false, captureFrames: 0 });
    ball._inCup = false;
    this._sunk = false;
    this._landedAt = null;
    return r;
  }

  // The game's ideal-swipe assist for `strength` along plan.bearing, played
  // through InputHandler's real pointer path; returns its input:hit.
  _swipe(plan, strength) {
    const { game, ball } = this.world;
    const input = this._input;
    const pos = ball.getPosition();
    const local = Utils.rotate2D(
      plan.target.x - pos.x,
      plan.target.z - pos.z,
      -plan.bearing,
    );
    const ideal = input.buildIdealSwipeVector(
      { local },
      plan.bearing,
      strength,
    );
    const scale = input.getHitSwipeScale();
    game.gameState = GameState.PLAY;
    game.isControlsDisabled = false;
    let hit = null;
    const onHit = (d) => (hit = d);
    this._hitEvents.on("input:hit", onHit);
    const x0 = 640;
    const y0 = 600;
    input.handlePointerDown({ clientX: x0, clientY: y0 });
    const end = {
      clientX: x0 + ideal.deltaX * scale,
      clientY: y0 + ideal.deltaY * scale,
    };
    input.handlePointerMove(end);
    input.handlePointerUp(end);
    this._hitEvents.off("input:hit", onHit);
    return hit;
  }

  // Strike at the swing's contact point, then fly/roll to rest at fixed
  // frames, streaming samples. Fills shot.{holed, penalty, hazard, ...}.
  async _fly(shot, hit, plan) {
    const w = this.world;
    const { ball, game } = w;
    const dt = 1 / w.fps;
    const sampler = new PathSampler(this.opts.sampler);
    const scale = this.opts.timeScale;
    const paced = Number.isFinite(scale);
    // ClubSystem.swing: contact 80% through a 1.8 s (weak) .. 1.0 s (full) swing.
    const forceRatio = Math.min(hit.force / (1.75 * 100), 1);
    const contact = 0.8 * (1.8 - forceRatio * 0.8);
    const wall0 = Date.now();
    if (paced) await sleep((contact / scale) * 1000);

    game.currentHoleShotCount++; // transitionAimToPlay counts the stroke up front
    const counted = game.currentHoleShotCount;
    this._sunk = false;
    this._landedAt = null;
    ball.landed = false;
    ball.applyHit(
      hit.deltaX,
      hit.deltaY,
      hit.force,
      plan.aim,
      plan.club.angle,
      plan.club.v0,
    );

    const spinPlan =
      !plan.putt && this.rand() < this.opts.spinChance
        ? {
            dx: (this.rand() * 2 - 1) * 150,
            dy: (this.rand() * 2 - 1) * 110,
            minH: 2 + this.rand() * 6,
          }
        : null;

    let t = contact;
    let frames = 0;
    shot.penalty = 0;
    shot.holed = false;
    shot.hazard = null;
    const sample = () => {
      const p = ball.getPosition();
      const q = ball.mesh.rotationQuaternion;
      return [t, p.x, p.y, p.z, q.x, q.y, q.z, q.w];
    };
    const stream = (s) => {
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
      const last = shot.sent[shot.sent.length - 1];
      if (last && out[0] <= last[0]) return; // t must strictly increase
      shot.sent.push(out);
      this._queuePath(out);
    };
    const push = (s) => sampler.push(s).forEach(stream);
    const end = (s) => sampler.end(s).forEach(stream);
    shot.truth.push(sample());
    push(shot.truth[0]);

    let done = false;
    while (!done) {
      const until = paced ? ((Date.now() - wall0) / 1000) * scale : Infinity;
      let budget = paced ? Infinity : 240; // unpaced: yield to the socket now and then
      while (!done && t < until && budget-- > 0) {
        const state = w.frame();
        t += dt;
        frames++;
        if (
          spinPlan &&
          !shot.spins.length &&
          ball.isAirborne() &&
          ball.getHeight() > spinPlan.minH &&
          ball.getVelocity().y > 0
        ) {
          const follow = H.makeFollowCamera(
            { scene: w.scene, ball },
            -plan.aim,
          );
          const spin = H.swipeSpin(
            { scene: w.scene, ball },
            follow,
            spinPlan.dx,
            spinPlan.dy,
          );
          follow.camera.dispose();
          shot.spins.push({
            t,
            dx: spinPlan.dx,
            dy: spinPlan.dy,
            applied: !!spin,
          });
        }
        if (game.currentHoleShotCount > counted) {
          // CourseManager.applyPenalty: out of bounds (course.frame) or water
          // (ball:landed). The ball is already at the drop: the path ends at
          // the hazard and the lie update moves the spectator's ghost.
          shot.penalty = game.currentHoleShotCount - counted;
          shot.hazard = this._landedAt ? "water" : "oob";
          if (this._landedAt) {
            const p = this._landedAt;
            const q = shot.truth[shot.truth.length - 1];
            const s = [t, p.x, p.y, p.z, q[4], q[5], q[6], q[7]];
            shot.truth.push(s);
            end(s);
          } else end(shot.truth[shot.truth.length - 1]);
          this._settle(10);
          done = true;
          break;
        }
        const s = sample();
        shot.truth.push(s);
        if (this._sunk || state === "fullLand") {
          shot.holed = this._sunk;
          end(s);
          done = true;
        } else if (t >= this.opts.maxShotSeconds) {
          shot.stuck = true; // a crawl that never rests: call it here
          end(s);
          done = true;
        } else push(s);
      }
      if (!done) await sleep(paced ? 5 : 0);
    }
    shot.simSeconds = t;
    shot.frames = frames;
  }

  // ---- path streaming ------------------------------------------------------

  _queuePath(s) {
    (this._pathQ ||= []).push(s);
    this._pumpPath();
  }

  _pumpPath() {
    if (this._pumpTimer) return;
    const gap = 1000 / this.opts.frameHz;
    const wait = Math.max(0, (this._lastPathAt || 0) + gap - Date.now());
    this._pumpTimer = setTimeout(() => {
      this._pumpTimer = null;
      const q = this._pathQ;
      if (!q?.length) return;
      const batch = q.splice(0, this.opts.maxSamplesPerFrame);
      this._lastPathAt = Date.now();
      const at = Date.now();
      const shot = this.shots[this.shots.length - 1];
      for (let i = 0; i < batch.length; i++) shot.sentAt.push(at);
      this.path(batch);
      if (q.length) this._pumpPath();
      else this._pathDrained?.();
    }, wait);
  }

  _drainPath() {
    if (!this._pathQ?.length && !this._pumpTimer) return Promise.resolve();
    return new Promise(
      (r) => (this._pathDrained = () => ((this._pathDrained = null), r())),
    );
  }
}

// ---- CLI: one sim client per process ------------------------------------------
// node test/mp/sim-client.js --url ws://127.0.0.1:7791 --name Dave --create
// node test/mp/sim-client.js --url ws://127.0.0.1:7791 --name Sam --join CODE
//   [--time-scale 4] [--seed 7] [--out /path/records.json] [--start-when 2]
// The host prints "CODE <code>" once its match exists; with --start-when N it
// readies and starts once N players are in. Exits when the match finishes.
async function main(argv) {
  const arg = (k, d) => {
    const i = argv.indexOf(`--${k}`);
    return i < 0 ? d : argv[i + 1];
  };
  const has = (k) => argv.includes(`--${k}`);
  const sim = new SimClient(arg("url"), arg("name", "Sim"), {
    timeScale: Number(arg("time-scale", 1)),
    seed: arg("seed") != null ? Number(arg("seed")) : null,
    log: has("log"),
  });
  await sim.connect();
  if (has("create")) sim.create();
  else if (arg("join")) sim.join(arg("join"));
  else if (arg("rv")) sim.rv(arg("rv"));
  const code = await sim.untilMatch({ timeout: 30000 });
  console.log(`CODE ${code}`);
  sim.ready(true);
  const n = Number(arg("start-when", 0));
  if (n) {
    await sim.until(
      (b) => b.you?.players?.length >= n && b.you.players.every((p) => p.ready),
      {
        timeout: 600000,
        label: `${n} ready players`,
      },
    );
    sim.start();
  }
  await sim.until((b) => b.you?.phase === "finished" || !b.code, {
    timeout: 3600000,
    label: "the match to finish",
  });
  console.log(`RESULT ${sim.match?.result?.text ?? "none"}`);
  if (arg("out"))
    require("node:fs").writeFileSync(arg("out"), JSON.stringify(sim.records()));
  sim.dispose();
}

if (require.main === module)
  main(process.argv.slice(2)).catch((e) => {
    console.error(e);
    process.exit(1);
  });

module.exports = { SimClient, makeRng };
