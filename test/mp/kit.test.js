// The test kit's own regressions, no server needed: checks.js judging
// synthetic records the way live runs produce them, and the sim client's
// turn-taking against snapshots fed straight into it.
// Run: node --test test/mp/kit.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const { setTimeout } = require("node:timers");
const C = require("./checks.js");
const { SimClient } = require("./sim-client.js");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const TEE = { x: 0, y: 1.57, z: 126.43 };
const PIN = { x: 0, y: 0.78, z: -121.57 };
const NAMES = { me: "Sam", op: "Dave" };

// One snapshot as bot.js records it, carrying a hole-1 match view.
function view(
  at,
  {
    strokes,
    pos,
    turnSeq,
    shotOpen = null,
    turn = "me",
    hole = 0,
    op,
    results = [],
  },
) {
  return {
    at,
    bytes: 1000,
    keys: ["t", "type", "playerCount", "matchCount", "you"],
    nb: 0,
    you: {
      matchCode: "TEST",
      phase: "playing",
      match: {
        phase: "playing",
        hole,
        holeId: hole + 1,
        par: 4,
        pin: PIN,
        names: NAMES,
        teeOrder: ["op", "me"],
        turn,
        turnSeq,
        shotOpen,
        lies: {
          me: { pos, strokes, holed: false, pickedUp: false },
          op: op ?? {
            pos: { x: 3, y: 1, z: 20 },
            strokes: 1,
            holed: false,
            pickedUp: false,
          },
        },
        holeResults: results,
        score: { me: 0, op: 0 },
        status: "ALL SQUARE",
        result: null,
      },
    },
  };
}

function shot(fields) {
  return {
    code: "TEST",
    hole: 0,
    holeId: 1,
    strokesBefore: 0,
    from: TEE,
    fromTee: true,
    rest: { x: 3, y: 1, z: -20 },
    penalty: 0,
    holed: false,
    ...fields,
  };
}

const sysLine = (at, seq, text) => ({
  at,
  code: "TEST",
  lines: [{ seq, text }],
});

// ---- checkAgreement ------------------------------------------------------------

test("checkAgreement holds a shot the server timed out to the timeout rule, not the client's rest", () => {
  // The shot opens, the server's shot timeout fires (a stroke, the ball stays
  // on the tee), and the late shotEnd is refused with "No shot in play".
  const rec = {
    name: "Sam",
    playerId: "me",
    snaps: [
      view(900, { strokes: 0, pos: null, turnSeq: 2 }),
      view(1200, {
        strokes: 0,
        pos: null,
        turnSeq: 2,
        shotOpen: { id: 2, playerId: "me" },
      }),
      view(8500, { strokes: 1, pos: null, turnSeq: 3, turn: "op" }),
    ],
    shots: [shot({ turnSeq: 2, openedAt: 1000, endSentAt: 9000 })],
    notices: [{ at: 9600, text: "No shot in play" }],
    chatDeliveries: [
      sysLine(8500, 5, "Sam's shot timed out: stroke, replay from the lie"),
    ],
  };
  assert.deepEqual(C.checkAgreement([rec]), []);
  // A timed-out shot that moved the ball, or cost no stroke, is still caught.
  rec.snaps[2] = view(8500, {
    strokes: 0,
    pos: { x: 3, y: 1, z: -20 },
    turnSeq: 3,
    turn: "op",
  });
  const v = C.checkAgreement([rec]).join("\n");
  assert.match(v, /server strokes 0, expected 1/);
  assert.match(v, /timed out, yet the lie moved null -> /);
});

test("checkAgreement judges the opponent's ball on the view that resolved my shot, not a later one", () => {
  // Sam's link lags: the server holds his snapshots back, and the first view
  // he gets after his shot (turnSeq 2 -> 3) already has Dave's next one in it
  // (-> 4), Dave's ball moved.
  const opMoved = {
    pos: { x: 1, y: 1, z: -40 },
    strokes: 2,
    holed: false,
    pickedUp: false,
  };
  const rec = (afterSeq) => ({
    name: "Sam",
    playerId: "me",
    snaps: [
      view(900, { strokes: 0, pos: null, turnSeq: 2 }),
      view(4000, {
        strokes: 1,
        pos: { x: 3, y: 1, z: -20 },
        turnSeq: afterSeq,
        turn: afterSeq === 3 ? "op" : "me",
        op: opMoved,
      }),
    ],
    shots: [shot({ turnSeq: 2, openedAt: 1000, endSentAt: 2000, snapIdx: 1 })],
    notices: [],
    chatDeliveries: [],
  });
  assert.deepEqual(C.checkAgreement([rec(4)]), []);
  // On the view that resolved my shot, a moved opponent is still caught.
  assert.match(C.checkAgreement([rec(3)]).join("\n"), /opponent lie changed/);
});

test("checkAgreement does not count a shot that reached the server after its turn ran out", () => {
  // Sam swung at the buzzer: the turn timed out first (hole conceded), so the
  // server never opened the shot and refused its shotStart.
  const rec = {
    name: "Sam",
    playerId: "me",
    snaps: [
      view(900, { strokes: 1, pos: { x: 2, y: 1, z: 40 }, turnSeq: 4 }),
      view(1500, {
        strokes: 0,
        pos: null,
        hole: 1,
        turnSeq: 5,
        turn: "op",
        op: { pos: null, strokes: 0, holed: false, pickedUp: false },
        results: [
          {
            hole: 0,
            holeId: 1,
            par: 4,
            strokes: { me: 1, op: 1 },
            winner: "op",
            reason: "timeout",
          },
        ],
      }),
    ],
    shots: [
      shot({
        turnSeq: 4,
        strokesBefore: 1,
        fromTee: false,
        from: { x: 2, y: 1, z: 40 },
        openedAt: 1400,
        endSentAt: 2400,
      }),
    ],
    notices: [{ at: 1500, text: "That turn is over" }],
    chatDeliveries: [
      sysLine(1500, 9, "Sam ran out of time, Dave wins hole 1. Dave 1 UP"),
    ],
  };
  assert.deepEqual(C.checkAgreement([rec]), []);
});

test("checkAgreement judges a shot by the view that ended its turn, even one in the same ms as shotEnd", () => {
  const p0 = { x: 21.622, y: 0.787, z: -116.051 };
  const p1 = { x: 0.505, y: 0.751, z: -121.503 };
  const p2 = { x: 0.2, y: 0.75, z: -121.6 };
  const rec = {
    name: "Sam",
    playerId: "me",
    snaps: [
      view(1000, { strokes: 3, pos: p0, turnSeq: 7 }),
      view(1100, {
        strokes: 3,
        pos: p0,
        turnSeq: 7,
        shotOpen: { id: 4, playerId: "me", club: 0, aim: 0 },
      }),
      view(1200, { strokes: 4, pos: p1, turnSeq: 8 }), // this shot's result, same ms as its shotEnd
      view(1290, { strokes: 5, pos: p2, turnSeq: 9 }), // the next shot's
    ],
    shots: [
      shot({
        turnSeq: 7,
        strokesBefore: 3,
        from: p0,
        fromTee: false,
        rest: p1,
        openedAt: 1050,
        endSentAt: 1200,
      }),
    ],
    notices: [],
    chatDeliveries: [],
  };
  assert.deepEqual(C.checkAgreement([rec]), []);
});

test("checkAgreement takes no older view as a shot's result, even one from the swing's millisecond", () => {
  // Seen live: ws hands every snapshot of one socket read over at once, so
  // Dave's still-open shot (turnSeq 9) and the view that resolved it and gave
  // Sam the turn (turnSeq 10) arrive in the same ms, and Sam swings in it too.
  const T = 1792922582646;
  const mine0 = { x: -9.611, y: 0.066, z: -63.575 };
  const mine1 = { x: -7.613, y: 0.133, z: -69.74 };
  const lie = (pos, strokes) => ({
    pos,
    strokes,
    holed: false,
    pickedUp: false,
  });
  const op1 = lie({ x: -9.335, y: 0.055, z: -62.862 }, 1);
  const op2 = lie({ x: -8.292, y: 0.112, z: -67.82 }, 2);
  const rec = {
    name: "Sam",
    playerId: "me",
    snaps: [
      view(T - 170, {
        strokes: 1,
        pos: mine0,
        turnSeq: 9,
        turn: "op",
        op: op1,
      }),
      // One socket read, two snapshots: Dave's shot still open, then its result.
      view(T, {
        strokes: 1,
        pos: mine0,
        turnSeq: 9,
        turn: "op",
        op: op1,
        shotOpen: { id: 9, playerId: "op", club: 0, aim: 0 },
      }),
      view(T, { strokes: 1, pos: mine0, turnSeq: 10, op: op2 }),
      view(T + 77, {
        strokes: 1,
        pos: mine0,
        turnSeq: 10,
        op: op2,
        shotOpen: { id: 10, playerId: "me", club: 0, aim: 0 },
      }),
      view(T + 162, {
        strokes: 2,
        pos: mine1,
        turnSeq: 11,
        turn: "op",
        op: op2,
      }),
    ],
    shots: [
      shot({
        turnSeq: 10,
        strokesBefore: 1,
        from: mine0,
        fromTee: false,
        rest: mine1,
        openedAt: T, // the sim swung as the turn view arrived
        endSentAt: T + 108,
      }),
    ],
    notices: [],
    chatDeliveries: [
      { ...sysLine(T, 20, "Sam is away"), i: 2 },
      { ...sysLine(T + 162, 21, "Dave is away"), i: 4 },
    ],
  };
  // By time (records without arrival order), and by arrival order.
  for (const snapIdx of [undefined, 3]) {
    rec.shots[0].snapIdx = snapIdx;
    assert.deepEqual(C.checkAgreement([rec]), []);
    assert.equal(C.shotOutcome(rec, rec.shots[0]).after.m.turnSeq, 11);
  }
});

test("checkAgreement does not count a swing on a view that had already left its turn", () => {
  // The sim's lookahead outlasted its turn: the hole was conceded on time
  // before it swung, so the server refused the swing ("That turn is over").
  const rec = {
    name: "Sam",
    playerId: "me",
    snaps: [
      view(1000, { strokes: 1, pos: { x: 2, y: 1, z: 40 }, turnSeq: 4 }),
      view(1500, {
        strokes: 0,
        pos: null,
        hole: 1,
        turnSeq: 5,
        turn: "op",
        op: { pos: null, strokes: 0, holed: false, pickedUp: false },
        results: [
          {
            hole: 0,
            holeId: 1,
            par: 4,
            strokes: { me: 1, op: 1 },
            winner: "op",
            reason: "timeout",
          },
        ],
      }),
      view(9000, {
        strokes: 0,
        pos: null,
        hole: 1,
        turnSeq: 6,
        op: {
          pos: { x: 1, y: 1, z: 1 },
          strokes: 1,
          holed: false,
          pickedUp: false,
        },
        results: [
          {
            hole: 0,
            holeId: 1,
            par: 4,
            strokes: { me: 1, op: 1 },
            winner: "op",
            reason: "timeout",
          },
        ],
      }),
    ],
    shots: [
      shot({
        turnSeq: 4,
        strokesBefore: 1,
        fromTee: false,
        from: { x: 2, y: 1, z: 40 },
        snapIdx: 2, // the conceded hole's view was already in
        openedAt: 2000,
        endSentAt: 3000,
      }),
    ],
    notices: [{ at: 2100, text: "That turn is over" }],
    chatDeliveries: [
      {
        ...sysLine(1500, 9, "Sam ran out of time, Dave wins hole 1. Dave 1 UP"),
        i: 1,
      },
    ],
  };
  assert.equal(C.shotOutcome(rec, rec.shots[0]).outcome, "conceded");
  assert.deepEqual(C.checkAgreement([rec]), []);
});

// ---- checkPathFidelity -----------------------------------------------------------

test("checkPathFidelity matches each shot to its own stream when two start from the same spot", () => {
  // Replays from one drop (or the tee after a timeout) share their first
  // streamed sample exactly; the relays carry server shot ids 3 and 5.
  const first = [0.8, -0.003, 13.42, 80, 0, 0, 0, 1];
  const a = [
    first,
    [0.85, 1, 14, 78, 0, 0, 0, 1],
    [0.9, 2, 13, 76, 0, 0, 0, 1],
  ];
  const b = [
    first,
    [0.85, -1, 14, 78, 0, 0, 0, 1],
    [0.9, -2, 13, 76, 0, 0, 0, 1],
  ];
  const mk = (sent, openedAt) => ({
    sent,
    sentAt: sent.map(() => openedAt + 50),
    truth: sent,
    rest: { x: sent.at(-1)[1], y: sent.at(-1)[2], z: sent.at(-1)[3] },
    penalty: 0,
    holed: false,
    openedAt,
    endSentAt: openedAt + 500,
  });
  // Matching may not lean on the ids' order either.
  for (const [idA, idB] of [
    [3, 5],
    [5, 3],
  ]) {
    const shooter = {
      name: "Dave",
      playerId: "d",
      shots: [mk(a, 1000), mk(b, 5000)],
    };
    const spectator = {
      name: "Sam",
      broadcasts: [
        {
          at: 1100,
          type: "path",
          data: { playerId: "d", shot: idA, samples: a },
        },
        {
          at: 5100,
          type: "path",
          data: { playerId: "d", shot: idB, samples: b },
        },
      ],
    };
    const v = C.checkPathFidelity(shooter, spectator);
    assert.deepEqual([...v], []);
    assert.equal(v.stats.matched, 2);
  }
});

test("checkPathFidelity pairs a shot with its own server id's stream; an expired one may have none", () => {
  // Sam's tee shot (server shot 1) expired: his uplink stalled past the shot
  // timeout and the server dropped its late frames, as it should. The replay
  // from the tee (shot 2) streamed normally. Both start on the same sample.
  const first = [0.85, 0, 1.6, 126.43, 0, 0, 0, 1];
  const pathA = [
    first,
    [0.9, 0, 3, 120, 0.1, 0, 0, 0.99],
    [1.0, 0, 5, 110, 0.2, 0, 0, 0.98],
  ];
  const pathB = [
    first,
    [0.9, 0.2, 3.1, 119, 0.1, 0, 0, 0.99],
    [1.0, 0.4, 5.2, 108, 0.2, 0, 0, 0.98],
  ];
  const restB = { x: 0.4, y: 5.2, z: 108 };
  const shooter = {
    name: "Sam",
    playerId: "me",
    snaps: [
      view(1000, { strokes: 0, pos: null, turnSeq: 2 }),
      view(1100, {
        strokes: 0,
        pos: null,
        turnSeq: 2,
        shotOpen: { id: 1, playerId: "me", club: 12, aim: 0 },
      }),
      view(5100, { strokes: 1, pos: null, turnSeq: 3 }), // timed out: still away, on the tee
      view(5300, {
        strokes: 1,
        pos: null,
        turnSeq: 3,
        shotOpen: { id: 2, playerId: "me", club: 12, aim: 0 },
      }),
      view(8000, { strokes: 2, pos: restB, turnSeq: 4, turn: "op" }),
    ],
    chatDeliveries: [
      sysLine(5100, 5, "Sam's shot timed out: stroke, replay from the lie"),
    ],
    shots: [
      shot({
        turnSeq: 2,
        openedAt: 1050,
        sent: pathA,
        sentAt: [1060, 1110, 1160],
        truth: pathA,
        rest: { x: 0, y: 5, z: 110 },
        endSentAt: 1200,
      }),
      shot({
        turnSeq: 3,
        strokesBefore: 1,
        openedAt: 5200,
        sent: pathB,
        sentAt: [5210, 5260, 5310],
        truth: pathB,
        rest: restB,
        endSentAt: 5400,
      }),
    ],
    broadcasts: [],
    notices: [],
  };
  const relay = (at, id, samples) => ({
    at,
    type: "path",
    data: { playerId: "me", shot: id, samples },
  });
  // Nothing of the expired shot came through: no fault, and the replay keeps its own stream.
  let v = C.checkPathFidelity(
    shooter,
    { name: "Dave", broadcasts: [relay(5500, 2, pathB)] },
    { requireComplete: false },
  );
  assert.deepEqual([...v], []);
  assert.equal(v.stats.matched, 1);
  // Its first sample made it before the timeout: each shot still gets its own.
  v = C.checkPathFidelity(
    shooter,
    {
      name: "Dave",
      broadcasts: [relay(1150, 1, [first]), relay(5500, 2, pathB)],
    },
    { requireComplete: false, maxDelayMs: 1000 },
  );
  assert.deepEqual([...v], []);
  assert.equal(v.stats.matched, 2);
});

// ---- checkMatchPlay / checkHonors ------------------------------------------------

test("holeScores cuts holes on the server's own header lines, not on what players type or are called", () => {
  // Sam types a fake hole header mid-hole; "Hole 2 (par 3)" is also a player
  // name the server writes into its lines.
  const m = {
    names: { me: "Sam", op: "Hole 2 (par 3)" },
    holeResults: [
      {
        hole: 0,
        holeId: 1,
        par: 4,
        strokes: { me: 3, op: 4 },
        winner: "me",
        reason: "played",
      },
    ],
  };
  const sys = (seq, text) => ({ seq, text });
  const chat = [
    sys(1, "Match play, 3 holes: Sam vs Hole 2 (par 3)"),
    sys(2, "Hole 1 (par 4): Sam has the honor"),
    {
      seq: 3,
      text: "Hole 2 (par 3): Sam has the honor",
      from: "me",
      name: "Sam",
    },
    sys(4, "Hole 2 (par 3) is away"),
    sys(5, "Sam holed out in 3: birdie"),
    sys(6, "Hole 2 (par 3) holed out in 4: par"),
    sys(7, "Sam wins hole 1 with a 3. Sam 1 UP"),
    sys(8, "Hole 2 (par 4): Sam has the honor"),
  ];
  const r = C.holeScores(chat, m, 0);
  assert.equal(r.known, true);
  assert.deepEqual(r.score, { me: 3, op: 4 });
});

// ---- checkChat / checkIsolation ---------------------------------------------------

function chatRec(sentAts, kept) {
  const sent = sentAts.map((at, i) => ({
    at,
    msg: { t: "action", action: "mchat", message: `line ${i + 1}` },
  }));
  const lines = kept.map((i, k) => ({
    seq: k + 1,
    text: `line ${i}`,
    from: "a",
    name: "Ann",
  }));
  return {
    name: "Ann",
    playerId: "a",
    snaps: [
      {
        at: 0,
        you: {
          matchCode: "TEST",
          players: [{ id: "a", name: "Ann", ready: false }],
        },
      },
    ],
    chatDeliveries: [{ at: sentAts.at(-1) + 50, code: "TEST", lines }],
    notices: [{ at: sentAts.at(-1) + 50, text: "Slow down" }],
    sent,
  };
}

test("checkChat accepts a burst the rate limit cut short, however few notices said so", () => {
  // 8 lines in one burst: the server keeps 5, refuses 3, and the refusals
  // arrive as one notice (one notice field per snapshot).
  const at = [1000, 1001, 1002, 1003, 1004, 1005, 1006, 1007];
  assert.deepEqual(C.checkChat([chatRec(at, [1, 2, 3, 4, 5])]), []);
  // A line that went missing outside any burst is still reported.
  const spaced = [1000, 4000, 8000, 12000, 16000, 20000];
  assert.equal(C.checkChat([chatRec(spaced, [1, 2, 3, 4, 6])]).length, 1);
});

// A record for checkChat: `snaps` [at, matchCode | null], `sent` [at,
// action, message?], `got` [at, code, seq, text, from] (a line from `from`).
function chatLife(id, name, { snaps, sent, got = [] }) {
  const roster = {
    a: { id: "a", name: "Ann", ready: false },
    b: { id: "b", name: "Bob", ready: false },
  };
  return {
    name,
    playerId: id,
    snaps: snaps.map(([at, code]) => ({
      at,
      you: code
        ? { matchCode: code, players: [roster.a, roster.b] }
        : { matchCode: null },
    })),
    sent: sent.map(([at, action, message]) => ({
      at,
      msg: { t: "action", action, ...(message ? { message } : {}) },
    })),
    chatDeliveries: got.map(([at, code, seq, text, from]) => ({
      at,
      code,
      lines: [{ seq, text, from, name: roster[from].name }],
    })),
    notices: [],
  };
}

test("checkChat with { code } expects only the lines sent in that match", () => {
  // Ann chats in lobby AAAA, leaves, says something in no match (dropped),
  // then hosts BBBB and chats there.
  const ann = (gotSecond) =>
    chatLife("a", "Ann", {
      snaps: [
        [100, "AAAA"],
        [2100, null],
        [4100, "BBBB"],
      ],
      sent: [
        [0, "create"],
        [1000, "mchat", "first"],
        [2000, "leave"],
        [3000, "mchat", "nowhere"],
        [4000, "create"],
        [5000, "mchat", "second"],
      ],
      got: [
        [1050, "AAAA", 1, "first", "a"],
        ...(gotSecond ? [[5050, "BBBB", 1, "second", "a"]] : []),
      ],
    });
  assert.deepEqual(C.checkChat([ann(true)], { code: "AAAA" }), []);
  assert.deepEqual(C.checkChat([ann(true)], { code: "BBBB" }), []);
  // A line the server really dropped is still reported, and only there.
  assert.deepEqual(C.checkChat([ann(false)], { code: "AAAA" }), []);
  assert.deepEqual(C.checkChat([ann(false)], { code: "BBBB" }), [
    'Ann: missing 1 line(s) Ann sent: ["second"]',
  ]);
});

test("checkChat expects a line only of members still in the match once it was logged", () => {
  const ann = chatLife("a", "Ann", {
    snaps: [[100, "AAAA"]],
    sent: [
      [0, "create"],
      [3000, "mchat", "after Bob left"],
    ],
    got: [[3050, "AAAA", 1, "after Bob left", "a"]],
  });
  const bob = (leftAt) =>
    chatLife("b", "Bob", {
      snaps: [
        [200, "AAAA"],
        [leftAt + 50, null],
      ],
      sent: [
        [150, "join", "AAAA"],
        [leftAt, "leave"],
      ],
    });
  assert.deepEqual(C.checkChat([ann, bob(2000)], { code: "AAAA" }), []);
  // Bob asked to leave after Ann had her line back: he was there for it.
  assert.deepEqual(C.checkChat([ann, bob(4000)], { code: "AAAA" }), [
    'Bob: missing 1 line(s) Ann sent: ["after Bob left"]',
  ]);
});

test("checkChat lets only lines the server counted excuse a refusal", () => {
  // Five lines in no match are dropped before the rate limit sees them, so
  // the line Ann sends a moment after joining can't have been refused.
  const ann = chatLife("a", "Ann", {
    snaps: [
      [0, null],
      [1600, "AAAA"],
    ],
    sent: [
      [1000, "mchat", "one"],
      [1001, "mchat", "two"],
      [1002, "mchat", "three"],
      [1003, "mchat", "four"],
      [1004, "mchat", "five"],
      [1500, "create"],
      [2000, "mchat", "in the match"],
    ],
  });
  assert.deepEqual(C.checkChat([ann], { code: "AAAA" }), [
    'Ann: missing 1 line(s) Ann sent: ["in the match"]',
  ]);
});

test("checkChat holds every line to the server's normalization", () => {
  const rec = chatRec([1000, 2000], [1, 2]);
  rec.chatDeliveries[0].lines[1].text = "a\u0085b";
  rec.chatDeliveries[0].lines.push({ seq: 3, text: "\u200b\u200b" });
  const v = C.checkChat([rec]);
  assert.equal(v.filter((x) => /not normalized/.test(x)).length, 2);
});

test("checkIsolation flags anything world-wide a player is sent, not just chat", () => {
  const rec = (id, other) => ({
    name: id,
    playerId: id,
    snaps: [],
    broadcasts: [],
    sent: [],
    other: other.map((msg) => ({ at: 1, msg })),
  });
  const v = C.checkIsolation([
    {
      code: "AAAA",
      recs: [rec("a1", []), rec("a2", [{ t: "bootstrapRequired" }])],
    },
    {
      code: "BBBB",
      recs: [
        rec("b1", [
          { t: "playerAction", socketId: "a1", actions: { typing: true } },
          {
            t: "b",
            id: 1,
            x: 1,
            y: 2,
            z: 3,
            vx: 1e6,
            vy: 0,
            vz: 0,
            playerId: "a1",
          },
        ]),
        rec("b2", [{ t: "d", playerId: "a1" }]),
      ],
    },
  ]);
  // The bootstrap handshake too: the golf world takes none, and one would be
  // a player's upload relayed to everyone.
  assert.equal(v.length, 4, v.join("\n"));
});

test("checkIsolation tells two matches saying the same words from a leak", () => {
  // Each match's own player says `say`; each receiver gets `heard` from its
  // own opponent, then the server's result line.
  const group = (code, [x, y], say, heard) => ({
    code,
    recs: [
      {
        name: x,
        playerId: x,
        snaps: [
          {
            keys: ["t", "you"],
            you: {
              matchCode: code,
              players: [{ id: x }, { id: y }],
              chat: [
                { seq: 1, text: heard, from: y, name: y },
                { seq: 2, text: "Match halved" },
              ],
            },
          },
        ],
        broadcasts: [],
        sent: [],
        other: [],
      },
      {
        name: y,
        playerId: y,
        snaps: [],
        broadcasts: [],
        sent: [{ msg: { t: "action", action: "mchat", message: say } }],
        other: [],
      },
    ],
  });
  const ok = C.checkIsolation([
    group("AAAA", ["a1", "a2"], "good game everyone", "good game everyone"),
    group("BBBB", ["b1", "b2"], "Match halved", "Match halved"),
  ]);
  assert.deepEqual(ok, []);
  // A line nobody in the match said, that the other match did, came from there.
  const leak = C.checkIsolation([
    group("AAAA", ["a1", "a2"], "see you on 3", "secret plan"),
    group("BBBB", ["b1", "b2"], "secret plan", "secret plan"),
  ]);
  assert.deepEqual(leak, [`a1: another match's chat leaked: "secret plan"`]);
});

test("checkChat takes the name a line was said under, from any the speaker bore in the match", () => {
  const roster = (dave) => ({
    matchCode: "AAAA",
    players: [
      { id: "h", name: "Host" },
      { id: "d", name: dave },
    ],
  });
  const host = (secondName) => ({
    name: "Host",
    playerId: "h",
    snaps: [
      { at: 100, you: roster("Dave 2") },
      { at: 900, you: roster("Dave") },
    ],
    sent: [{ at: 0, msg: { t: "action", action: "create" } }],
    chatDeliveries: [
      {
        at: 500,
        code: "AAAA",
        lines: [{ seq: 1, text: "hi", from: "d", name: "Dave 2" }],
      },
      {
        at: 1000,
        code: "AAAA",
        lines: [{ seq: 2, text: "me again", from: "d", name: secondName }],
      },
    ],
    notices: [],
  });
  assert.deepEqual(C.checkChat([host("Dave")]), []);
  assert.deepEqual(C.checkChat([host("Davey")]), [
    "Host: chat line 2 from d named Davey",
  ]);
});

test("checkChat takes a rejoin's restore of the retained log as no gap, and still finds one", () => {
  // Pat has line 1, leaves, and rejoins once 106 lines are logged: the
  // newest 100 (7..106) come back over two snapshots.
  const line = (seq) => ({ seq, text: `line ${seq}` });
  const range = (a, b) => Array.from({ length: b - a + 1 }, (_, k) => a + k);
  const pat = (pages) => {
    const players = [{ id: "p", name: "Pat" }];
    const snaps = [
      { at: 100, you: { matchCode: "AAAA", players, chat: [line(1)] } },
      { at: 2000, you: { matchCode: null } },
      ...pages.map((seqs, k) => ({
        at: 9000 + k * 100,
        you: { matchCode: "AAAA", players, chat: seqs.map(line) },
      })),
    ];
    return {
      name: "Pat",
      playerId: "p",
      snaps,
      sent: [],
      notices: [],
      chatDeliveries: snaps
        .map((s, i) => ({ at: s.at, i, code: "AAAA", lines: s.you.chat }))
        .filter((d) => d.lines),
    };
  };
  const check = (pages) =>
    C.checkChat([pat(pages)], { code: "AAAA", allowRedelivery: true });
  assert.deepEqual(check([range(7, 56), range(57, 106)]), []);
  // Lines missing inside one stay are a gap.
  assert.deepEqual(check([range(7, 56), range(60, 106)]), [
    "Pat: chat gap 56 -> 60",
  ]);
  // A restore that skips lines the log still held starts past its start.
  assert.deepEqual(check([range(12, 56), range(57, 106)]), [
    "Pat: chat restored from seq 12, past the start of the retained log",
  ]);
});

test("lobbyCutPending: the survivor of a lobby cut is alone in it, or never got in", () => {
  const rec = ({ snaps = [], joined = false, notices = [] }) => ({
    snaps: snaps.map((you) => ({ you })),
    sent: joined
      ? [{ msg: { t: "action", action: "join", message: "AAAA" } }]
      : [],
    notices: notices.map((text) => ({ text })),
  });
  const lobby = (n) => ({
    matchCode: "AAAA",
    players: Array.from({ length: n }, (_, k) => ({ id: `p${k}` })),
  });
  // Got in, and the host's seat went with the cut.
  assert.equal(C.lobbyCutPending(rec({ snaps: [lobby(2), lobby(1)] })), null);
  assert.equal(
    C.lobbyCutPending(rec({ snaps: [lobby(2)] })),
    "alone in the lobby",
  );
  // The host was cut before the guest's join landed, or before it had a code.
  assert.equal(
    C.lobbyCutPending(
      rec({
        snaps: [{ matchCode: null }],
        joined: true,
        notices: ["No match with that code"],
      }),
    ),
    null,
  );
  assert.equal(C.lobbyCutPending(rec({ snaps: [{ matchCode: null }] })), null);
  assert.equal(
    C.lobbyCutPending(rec({ snaps: [{ matchCode: null }], joined: true })),
    '"No match with that code"',
  );
});

// ---- SimClient -----------------------------------------------------------------

function snapshot(me, other, hole, turn, turnSeq, extra = {}) {
  return Buffer.from(
    JSON.stringify({
      t: "gameSnapshot",
      type: "game-state",
      you: {
        matchCode: "TEST",
        phase: "playing",
        hostId: me,
        players: [
          { id: me, name: "Dave", ready: true },
          { id: other, name: "Sam", ready: true },
        ],
        match: {
          phase: "playing",
          hole,
          holeCount: 3,
          holeId: hole + 1,
          par: 4,
          version: "greens6",
          pinIndex: 0,
          pin: { x: 0, y: 0, z: 0 },
          windSeed: 1234 + hole,
          names: { [me]: "Dave", [other]: "Sam" },
          teeOrder: [me, other],
          turn,
          turnSeq,
          turnEndsIn: 90000,
          shotOpen: null,
          lies: {
            [me]: { pos: null, strokes: 0, holed: false, pickedUp: false },
            [other]: { pos: null, strokes: 0, holed: false, pickedUp: false },
          },
          holeResults: [],
          score: { [me]: 0, [other]: 0 },
          status: "ALL SQUARE",
          result: null,
        },
        ...extra,
      },
    }),
  );
}

async function offlineSim(t) {
  const sim = new SimClient("ws://127.0.0.1:1", "Dave", {
    timeScale: Infinity,
    lookahead: 0,
    seed: 1,
  });
  t.after(() => sim.dispose());
  await sim.buildWorld(); // no server: snapshots are fed in by hand
  sim.playerId = "me";
  return sim;
}

async function poll(pred, ms = 60000) {
  for (const end = Date.now() + ms; !pred();) {
    if (Date.now() > end) throw new Error("timed out");
    await sleep(20);
  }
}

test(
  "the sim never takes a turn on a hole it has not loaded",
  { timeout: 120000 },
  async (t) => {
    // ws emits every message of one TCP read synchronously: a backlog released
    // by a latency spike lands the next hole's view while this one loads.
    const sim = await offlineSim(t);
    const taken = [];
    sim.takeTurn = async (m) => {
      taken.push({
        viewHole: m.hole,
        loadedHole: sim.world.holeIndex,
        lastLoad: sim.holes.at(-1)?.hole,
      });
    };
    sim._onMessage(snapshot("me", "sam", 0, "sam", 1));
    await poll(() => sim.holes.length === 1 || sim.errors.length);
    assert.deepEqual(sim.errors, []);
    await sleep(50);
    sim._onMessage(snapshot("me", "sam", 0, "sam", 1));
    sim._onMessage(snapshot("me", "sam", 1, "me", 2));
    await poll(() => taken.length > 0 || sim.errors.length);
    assert.deepEqual(taken[0], { viewHole: 1, loadedHole: 1, lastLoad: 1 });
  },
);

test(
  "the sim takes one shot per turn, whatever notices arrive meanwhile",
  { timeout: 120000 },
  async (t) => {
    // A late "No shot in play" for an older shotEnd arrives while this turn's
    // shot is still in flight, on a view that still says "your turn".
    const sim = await offlineSim(t);
    const taken = [];
    sim.takeTurn = async (m) => {
      taken.push(m.turnSeq);
      sim._awaiting = { at: Date.now(), turnSeq: m.turnSeq }; // what the real takeTurn leaves
    };
    sim._onMessage(snapshot("me", "sam", 0, "me", 3));
    await poll(() => taken.length === 1 || sim.errors.length);
    sim._onMessage(
      snapshot("me", "sam", 0, "me", 3, { notice: "No shot in play" }),
    );
    await sleep(300);
    assert.deepEqual(taken, [3]);
    // The server moving on to the next turn (still ours) is what frees it.
    sim._onMessage(snapshot("me", "sam", 0, "me", 4));
    await poll(() => taken.length === 2 || sim.errors.length);
    assert.deepEqual(taken, [3, 4]);
  },
);

test(
  "the sim doesn't swing on a turn that ended while it was trying the shot out",
  { timeout: 120000 },
  async (t) => {
    // Its lookahead takes real time; meanwhile the turn ran out (hole conceded)
    // or the opponent left. A swing then is refused, and the record would
    // carry a shot the server never took.
    const left = JSON.parse(snapshot("me", "sam", 0, null, 1).toString());
    left.you.phase = left.you.match.phase = "finished";
    for (const ended of [
      snapshot("me", "sam", 1, "sam", 2), // conceded: next hole, their turn
      Buffer.from(JSON.stringify(left)), // the opponent left: a forfeit
    ]) {
      const sim = await offlineSim(t);
      sim.opts.lookahead = 2;
      let started = 0;
      sim.shotStart = () => started++;
      let tried = false;
      const refine = sim._refine.bind(sim);
      sim._refine = async (...a) => {
        await refine(...a);
        tried = true;
        sim._onMessage(ended);
      };
      sim._onMessage(snapshot("me", "sam", 0, "me", 1));
      await poll(() => (tried && !sim._busy) || sim.errors.length);
      assert.deepEqual(sim.errors, []);
      assert.equal(started, 0);
      assert.equal(sim.shots.length, 0);
    }
  },
);

test(
  "the sim keeps its ball on the lie and leaves the game's last lie alone",
  { timeout: 120000 },
  async (t) => {
    // Re-placing a ball can creep (a rock flank, a slope) where the player's own
    // ball lay still, and the lookahead's tries land and move lastLie.
    const sim = await offlineSim(t);
    await sim.world.loadHole(0, 0);
    const { course, ball } = sim.world;
    sim._place(null);
    // A lie down the fairway, where a ball dropped there comes to rest.
    ball.teleport(0, 10, 50);
    sim._settle(5);
    const lie = ball.getPosition().clone();
    // Settling now slides the ball off whatever spot it is set down on.
    const settle = sim._settle.bind(sim);
    sim._settle = (s) => {
      settle(s);
      const p = ball.getPosition();
      ball.teleport(p.x + 0.4, p.y, p.z - 0.3);
    };
    sim._place(lie);
    const p = ball.getPosition();
    assert.ok(
      Math.hypot(p.x - lie.x, p.z - lie.z) < 1e-6,
      `ball crept to ${p}`,
    );
    assert.equal(ball.isLanded(), true);
    sim._settle = settle;

    // A whole turn with lookahead, stopped at the swing: shot from the lie, and
    // lastLie as the game had it.
    sim.opts.lookahead = 4;
    const before = course.lastLie.clone();
    let at = null;
    sim.shotStart = () => {
      at = {
        from: { ...sim.shots.at(-1).from },
        lastLie: course.lastLie.clone(),
      };
      throw new Error("stop at the swing");
    };
    const you = JSON.parse(snapshot("me", "sam", 0, "me", 1).toString()).you;
    const m = you.match;
    m.lies.me = {
      pos: { x: lie.x, y: lie.y, z: lie.z },
      strokes: 1,
      holed: false,
      pickedUp: false,
    };
    sim.you = you; // still its turn once the tries are done
    await assert.rejects(sim.takeTurn(m), /stop at the swing/);
    assert.ok(
      Math.hypot(at.from.x - lie.x, at.from.y - lie.y, at.from.z - lie.z) <
        0.005,
      `played from ${JSON.stringify(at.from)}`,
    );
    assert.ok(at.lastLie.equals(before), `lastLie moved to ${at.lastLie}`);
  },
);
