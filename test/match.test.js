// Match client (S3/S4): PathPlayer replays streamed or stored shot samples,
// and MatchCoordinator only hands this side the ball on its own turn, opens
// the shot with that turn's turnSeq, streams the path and closes the shot
// where the ball came to rest. Run: node --test test/match.test.js
/* global BABYLON */
const test = require("node:test");
const assert = require("node:assert/strict");
const { setTimeout, setImmediate } = require("node:timers");

const { PathPlayer } = require("../src/game/path.js");

test("PathPlayer interpolates position and rotation between samples", () => {
  const s = Math.SQRT1_2;
  const p = new PathPlayer([
    [0, 0, 0, 0, 0, 0, 0, 1],
    [1, 2, 4, -6, 0, s, 0, s],
  ]);
  const mid = p.at(0.5);
  assert.deepEqual(mid.slice(0, 3), [1, 2, -3]);
  assert.ok(Math.abs(Math.hypot(...mid.slice(3)) - 1) < 1e-9);
  assert.ok(mid[4] > 0 && mid[4] < s);
  assert.deepEqual(p.at(-1), [0, 0, 0, 0, 0, 0, 1]);
  assert.deepEqual(p.at(9), [2, 4, -6, 0, s, 0, s]);
  // q and -q are one rotation: no spin the long way round between them.
  const flip = new PathPlayer([
    [0, 0, 0, 0, 0, 0, 0, 1],
    [1, 0, 0, 0, 0, 0, 0, -1],
  ]);
  assert.deepEqual(flip.at(0.5).slice(3), [0, 0, 0, 1]);
});

test("PathPlayer live: waits for its delay, ends exactly on the last sample", () => {
  const p = new PathPlayer([], { delay: 0.2 });
  p.push([[0.5, 0, 0, 0, 0, 0, 0, 1]]);
  assert.equal(p.step(0.016), null);
  p.push([
    [0.6, 1, 0, 0, 0, 0, 0, 1],
    [0.6, 9, 9, 9, 0, 0, 0, 1], // repeated t: dropped
    [0.8, 2, 0, 0, 0, 0, 0, 1],
  ]);
  assert.deepEqual(p.step(0.016), [0, 0, 0, 0, 0, 0, 1]);
  let pose;
  for (let i = 0; i < 100; i++) pose = p.step(0.016);
  assert.equal(pose[0], 2);
  assert.equal(p.done, false);
  p.end();
  pose = p.step(0.016);
  assert.equal(p.done, true);
  assert.deepEqual(pose, [2, 0, 0, 0, 0, 0, 1]);
});

test("PathPlayer stored shot plays from the first sample in real time", () => {
  const p = new PathPlayer([
    [0.4, 0, 0, 0, 0, 0, 0, 1],
    [1.4, 10, 0, 0, 0, 0, 0, 1],
  ]);
  p.end();
  assert.deepEqual(p.step(0.1)[0], 0);
  assert.ok(Math.abs(p.step(0.5)[0] - 5) < 1e-9);
  p.step(0.5);
  assert.equal(p.done, true);
});

// ---- MatchCoordinator with a stub net and game -------------------------------

function setup() {
  class V3 {
    constructor(x = 0, y = 0, z = 0) {
      Object.assign(this, { x, y, z });
    }
    clone() {
      return new V3(this.x, this.y, this.z);
    }
  }
  globalThis.BABYLON = {
    Vector3: V3,
    Quaternion: { Identity: () => ({ x: 0, y: 0, z: 0, w: 1 }) },
  };
  globalThis.GameState = { AIM: "aim", PLAY: "play" };
  require("../src/game/path.js");
  require("../src/game/matchui.js");
  const { EventManager } = require("../src/game/utils.js");
  const { MatchCoordinator } = require("../src/game/match.js");

  const sent = [];
  const net = {
    playerId: "me",
    you: null,
    shotStart: (club, aim, turnSeq) =>
      sent.push({ a: "shotStart", club, aim, turnSeq }),
    path: (samples) => sent.push({ a: "path", samples }),
    shotEnd: (restPos, holed, penalty) =>
      sent.push({ a: "shotEnd", restPos, holed, penalty }),
  };
  globalThis.golfNet = net;
  const frames = [];
  const ball = {
    pos: new V3(0, 0.02, 0),
    inShot: false,
    mesh: { rotationQuaternion: { x: 0, y: 0, z: 0, w: 1 } },
    getPosition() {
      return this.pos;
    },
    isLanded: () => true,
    teleport() {},
  };
  const game = {
    eventManager: new EventManager(),
    scene: { onBeforeRenderObservable: { add: (f) => frames.push(f) } },
    engine: { getDeltaTime: () => 16 },
    golfBall: ball,
    currentHoleShotCount: 0,
    isControlsDisabled: true,
    aimView: {
      currentClub: 7,
      activate() {
        if (!game.match.canAim()) return;
        this.isActive = true;
      },
      deactivate() {
        this.isActive = false;
      },
    },
    getShotDirection: () => 1.25,
    courseManager: {
      cup: new V3(0, 0, -100),
      tee: new V3(0, 0, 0),
      beginTurn() {
        game.isControlsDisabled = false;
        game.aimView.activate();
      },
      async loadHole() {},
      holeSinkGuardReset() {},
    },
  };
  const match = new MatchCoordinator(game);
  game.match = match;
  match.say = () => {};
  match.makeGhost = async () => {};
  match.start();
  const view = (over) => {
    net.you = {
      matchCode: "ABCD",
      players: [],
      match: {
        phase: "playing",
        hole: 0,
        windSeed: 5,
        pinIndex: 1,
        teeOrder: ["opp", "me"],
        names: { me: "Me", opp: "Sam" },
        turn: "opp",
        turnSeq: 1,
        shotOpen: null,
        lies: {
          me: { pos: null, strokes: 0, holed: false },
          opp: { pos: null, strokes: 0, holed: false },
        },
        ...over,
      },
    };
    match.sync();
  };
  const tick = () => frames.forEach((f) => f());
  return { match, game, ball, net, sent, view, tick };
}

test("MatchCoordinator: input only on our turn; shot streamed and closed", async () => {
  const { match, game, ball, sent, view, tick } = setup();
  view({});
  await new Promise((r) => setImmediate(r)); // the hole load
  assert.equal(match.hole, "0:5");
  assert.equal(match.canAim(), false);
  assert.equal(game.isControlsDisabled, true);
  game.eventManager.emit("input:hit", {});
  assert.equal(sent.length, 0, "a swing on their turn must not open a shot");

  view({ turn: "me", turnSeq: 2 });
  assert.equal(match.canAim(), true);
  assert.equal(game.aimView.isActive, true);

  game.eventManager.emit("input:hit", {});
  assert.deepEqual(sent[0], {
    a: "shotStart",
    club: 7,
    aim: 1.25,
    turnSeq: 2,
  });
  assert.equal(match.canAim(), false);

  ball.inShot = true;
  for (let i = 0; i < 30; i++) {
    ball.pos = new BABYLON.Vector3(0, 0.02 + Math.sin(i / 10), -i);
    tick();
    await new Promise((r) => setTimeout(r, 10));
  }
  ball.inShot = false;
  ball.pos = new BABYLON.Vector3(0, 0.02, -30);
  game.eventManager.emit("ball:landed");
  tick();
  const end = sent.at(-1);
  assert.equal(end.a, "shotEnd");
  assert.deepEqual(end.restPos, { x: 0, y: 0.02, z: -30 });
  assert.equal(end.holed, false);
  assert.equal(end.penalty, 0);
  const samples = sent.filter((s) => s.a === "path").flatMap((s) => s.samples);
  assert.ok(samples.length >= 2);
  for (let i = 1; i < samples.length; i++)
    assert.ok(samples[i][0] > samples[i - 1][0], "t strictly increases");
  assert.deepEqual(samples.at(-1).slice(1, 4), [0, 0.02, -30]);
  assert.equal(game.isControlsDisabled, true);

  // Still our view's turn until the server answers: no second shot.
  game.eventManager.emit("input:hit", {});
  assert.equal(sent.filter((s) => s.a === "shotStart").length, 1);
});

test("MatchCoordinator: the opponent's shot replays on the ghost, then it sits at their lie", async () => {
  const { match, net, view, tick } = setup();
  const at = { x: 0, y: 0, z: 0 };
  match.ghost = {
    root: {
      position: {
        ...at,
        set(x, y, z) {
          Object.assign(this, { x, y, z });
        },
        copyFrom(v) {
          this.set(v.x, v.y, v.z);
        },
      },
      rotationQuaternion: { set() {} },
      setEnabled(on) {
        this.on = on;
      },
    },
  };
  view({ shotOpen: { id: 4, playerId: "opp", club: 12, aim: 0 } });
  await new Promise((r) => setImmediate(r));
  net.onPath({
    playerId: "opp",
    shot: 4,
    samples: [
      [1, 0, 0, 0, 0, 0, 0, 1],
      [2, 0, 5, -50, 0, 0, 0, 1],
      [3, 0, 0.02, -100.5, 0, 0, 0, 1],
    ],
  });
  tick();
  assert.ok(match.replay);
  // The server closes the shot; its lie is a water drop, off the path's end.
  view({
    turn: "me",
    turnSeq: 2,
    lies: {
      me: { pos: null, strokes: 0, holed: false },
      opp: { pos: { x: 3, y: 0.02, z: -90 }, strokes: 2, holed: false },
    },
  });
  assert.equal(match.canAim(), false, "our turn waits for the replay");
  const g = match.ghost.root;
  let sawEnd = false;
  for (let i = 0; i < 400 && match.replay; i++) {
    tick();
    if (g.position.z === -100.5) sawEnd = true;
    await new Promise((r) => setTimeout(r, 2));
  }
  assert.equal(match.replay, null);
  assert.ok(sawEnd, "the replay reaches the path's last sample");
  assert.deepEqual([g.position.x, g.position.y, g.position.z], [3, 0.02, -90]);
  assert.equal(match.canAim(), true);
});

test("MatchCoordinator: a stored shot record replays like a live one and gates our turn", async () => {
  const { match, view, tick } = setup();
  view({ turn: "me", turnSeq: 2 });
  await new Promise((r) => setImmediate(r));
  view({ turn: "me", turnSeq: 2, present: { opp: false } });
  assert.equal(match.canAim(), true);
  const rec = {
    player: "opp",
    hole: 0,
    stroke: 1,
    samples: [
      [0, 0, 0, 0, 0, 0, 0, 1],
      [0.05, 0, 0, -1, 0, 0, 0, 1],
    ],
    restPos: { x: 0, y: 0, z: -1 },
  };
  match.play(rec);
  assert.equal(match.canAim(), false, "watch the replay before playing");
  for (let i = 0; i < 20 && match.replay; i++) {
    tick();
    await new Promise((r) => setTimeout(r, 5));
  }
  assert.equal(match.replay, null);
  assert.equal(match.canAim(), true);
  assert.equal(match.present(match.view, "opp"), false);
  assert.equal(match.present(match.view, "me"), true);
});

// ---- async play: the review and the text-back -------------------------------

const stored = (hole, z) => ({
  player: "opp",
  hole,
  stroke: 1,
  samples: [
    [0, 0, 0, 0, 0, 0, 0, 1],
    [0.05, 0, 0, z, 0, 0, 0, 1],
  ],
  restPos: { x: 0, y: 0, z },
});

// Plays the review out, minus the beat between shots.
async function watchReview(match, tick) {
  for (let i = 0; i < 200 && match.review; i++) {
    match.holdUntil = 0;
    match.sync();
    tick();
    await new Promise((r) => setTimeout(r, 2));
  }
}

test("MatchCoordinator: back on our turn, the opponent's missed shots play first, each on its hole", async (t) => {
  const { match, game, net, view, tick } = setup();
  const loads = [];
  game.courseManager.loadHole = async (hole, pin, wind) =>
    loads.push([hole, pin, wind]);
  game.courseManager.disposeHole = () => {};
  globalThis.Shared = { roomFX: { irisClose: async () => {} } };
  t.after(() => delete globalThis.Shared);
  net.replay = [
    { hole: 0, holeId: 1, pinIndex: 3, windSeed: 9, shots: [stored(0, -40)] },
    { hole: 1, holeId: 2, pinIndex: 1, windSeed: 5, shots: [stored(1, -9)] },
  ];
  view({ hole: 1, turn: "me", turnSeq: 4 });
  assert.equal(net.replay, null, "taken");
  assert.equal(match.canAim(), false, "watch first");
  await watchReview(match, tick);
  assert.equal(match.review, null);
  // Hole 1 for its shot, then hole 2 (the match's), which its shot shares.
  assert.deepEqual(loads, [
    [0, 3, 9],
    [1, 1, 5],
  ]);
  assert.deepEqual(
    match.shots.map((s) => s.restPos.z),
    [-40, -9],
  );
  assert.equal(match.canAim(), true);
});

test("MatchCoordinator: the review can be skipped", async () => {
  const { match, net, view } = setup();
  net.replay = [
    { hole: 0, holeId: 1, pinIndex: 1, windSeed: 5, shots: [stored(0, -40)] },
  ];
  view({ turn: "me", turnSeq: 4 });
  await new Promise((r) => setImmediate(r));
  match.sync();
  assert.ok(match.replay);
  match.endReview();
  assert.equal(match.replay, null);
  assert.equal(match.canAim(), true);
});

test("MatchCoordinator: our turn ending with the opponent away offers to text them the link", (t) => {
  const { view } = setup();
  const shown = [];
  globalThis.Splash = { show: (o) => shown.push(o) };
  globalThis.Challenge = require("../src/shared/challenge.js");
  globalThis.location = {
    origin: "https://balls.example",
    pathname: "/game.html",
  };
  t.after(() => {
    delete globalThis.Splash;
    delete globalThis.Challenge;
    delete globalThis.location;
  });
  view({ turn: "me", turnSeq: 2 });
  view({ turn: "opp", turnSeq: 3 }); // here: they just play
  assert.equal(shown.length, 0);
  view({ turn: "me", turnSeq: 4 });
  view({
    id: "abcdefghijkl",
    holeId: 2,
    turn: "opp",
    turnSeq: 5,
    present: { me: true, opp: false },
  });
  assert.equal(shown.length, 1);
  assert.equal(shown[0].title, "Sam's move");
  assert.deepEqual(
    shown[0].buttons.map((b) => b.label),
    ["Text", "Later"],
  );
});

// ---- S5: match-play status -----------------------------------

test("matchStatus reads the match from this side", () => {
  const { matchStatus } = require("../src/game/matchui.js");
  const m = (score, done, over = {}) => ({
    phase: "playing",
    teeOrder: ["me", "opp"],
    holeCount: 9,
    holeResults: Array(done).fill({}),
    score,
    ...over,
  });
  assert.equal(matchStatus(m({ me: 0, opp: 0 }, 2), "me"), "All square");
  assert.equal(matchStatus(m({ me: 2, opp: 0 }, 3), "me"), "2 UP");
  assert.equal(matchStatus(m({ me: 2, opp: 0 }, 3), "opp"), "2 DOWN");
  assert.equal(matchStatus(m({ me: 3, opp: 0 }, 6), "me"), "3 UP · Dormie");
  const won = { phase: "finished", result: { winner: "me", reason: "holes" } };
  assert.equal(matchStatus(m({ me: 4, opp: 1 }, 7, won), "me"), "Won 3&2");
  assert.equal(matchStatus(m({ me: 4, opp: 1 }, 7, won), "opp"), "Lost 3&2");
  assert.equal(matchStatus(m({ me: 4, opp: 3 }, 9, won), "me"), "Won 1 UP");
  const halved = {
    phase: "finished",
    result: { winner: null, reason: "holes" },
  };
  assert.equal(matchStatus(m({ me: 2, opp: 2 }, 9, halved), "me"), "Halved");
});
