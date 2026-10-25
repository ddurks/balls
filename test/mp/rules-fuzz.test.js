// Contracts 4, 5, 8, 9 under randomized play: many parallel protocol-bot
// matches with exact-distance ties (inside and outside the 1 cm band), holes,
// penalties, the stroke cap, turn and shot timeouts (plus a late shotEnd after
// each expired shot), and match chat in every phase; then the kit's honors,
// match-play, agreement, chat, liveness and isolation checks per match.
// Run: node --test test/mp/rules-fuzz.test.js
//   (MP_FUZZ_MATCHES=20 MP_FUZZ_SEED=3 for a bigger or different run)
const test = require("node:test");
const { setTimeout } = require("node:timers");
const { startGolfServer } = require("./server.js");
const { setupMatch } = require("./bot.js");
const C = require("./checks.js");

const PORT = 7840;
const MATCHES = Number(process.env.MP_FUZZ_MATCHES || 10);
const SEED = Number(process.env.MP_FUZZ_SEED || 1);
const TURN = 2500,
  SHOT = 1800,
  LINGER = 4000;

let s = SEED >>> 0;
const rnd = () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const flat = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);

function clampIn(p, b) {
  return {
    x: Math.max(b.minX + 1, Math.min(b.maxX - 1, p.x)),
    y: Math.max(b.minY, Math.min(b.maxY, p.y)),
    z: Math.max(b.minZ + 1, Math.min(b.maxZ - 1, p.z)),
  };
}

const { SERVER_HOLES } = require("./holes.js");

function planShot(bot, mode) {
  const m = bot.match;
  const hole = SERVER_HOLES[m.hole];
  const from = m.lies[bot.playerId].pos ?? hole.tee;
  const pin = m.pin;
  const d = flat(from, pin);
  const opp = Object.keys(m.lies).find((id) => id !== bot.playerId);
  const ol = m.lies[opp];
  let rest,
    holed = false,
    penalty = 0;
  const r = rnd();
  if (d < 25 && r < 0.45) {
    holed = true;
    const a = rnd() * 6.28;
    rest = {
      x: pin.x + 0.5 * Math.cos(a),
      y: pin.y,
      z: pin.z + 0.5 * Math.sin(a),
    };
  } else if (mode.tie && ol && !ol.holed && !ol.pickedUp && rnd() < 0.5) {
    // Same distance from the pin as the opponent (or within/outside the 1 cm tie band).
    const od = flat(ol.pos ?? hole.tee, pin);
    const jitter = [0, 0.004, -0.004, 0.009, -0.009, 0.02, -0.02][
      Math.floor(rnd() * 7)
    ];
    const a = rnd() * 6.28;
    rest = {
      x: pin.x + (od + jitter) * Math.sin(a),
      y: pin.y,
      z: pin.z + (od + jitter) * Math.cos(a),
    };
    const b = hole.bounds;
    if (
      rest.x < b.minX + 1 ||
      rest.x > b.maxX - 1 ||
      rest.z < b.minZ + 1 ||
      rest.z > b.maxZ - 1
    ) {
      // mirror across the pin's x instead
      const src = ol.pos ?? hole.tee;
      const dx = src.x - pin.x;
      rest = { x: pin.x - dx, y: src.y, z: src.z };
      if (rest.x < b.minX + 1 || rest.x > b.maxX - 1) rest = { ...src };
      rest = { x: rest.x + jitter, y: rest.y, z: rest.z }; // not exact but close
    }
  } else if (mode.dribble && rnd() < 0.35) {
    rest = { x: from.x + 0.5, y: from.y, z: from.z };
  } else {
    const f = 0.3 + rnd() * 0.75;
    rest = {
      x: from.x + (pin.x - from.x) * f + (rnd() - 0.5) * 10,
      y: from.y + (pin.y - from.y) * f,
      z: from.z + (pin.z - from.z) * f,
    };
  }
  if (!holed) {
    rest = clampIn(rest, hole.bounds);
    if (flat(rest, pin) <= 1.05) rest.x += 2; // not a sneaky hole
    if (rnd() < (mode.penalty ?? 0.1)) penalty = 1 + Math.floor(rnd() * 2);
  }
  return { rest, holed, penalty };
}

async function playMatch(bots, mode, log) {
  const [a] = bots;
  let alive = true;
  const step = async (me) => {
    const m = me.match;
    const r = rnd();
    if (r < mode.idle) {
      log.push(`${me.name} idles (turn timeout) on hole ${m.hole + 1}`);
      await me
        .until(
          (b) =>
            !b.isMyTurn() ||
            b.match.hole !== m.hole ||
            b.you.phase !== "playing" ||
            false,
          { timeout: TURN * 4, label: "idle to expire" },
        )
        .catch(() => {});
      await sleep(50);
      return;
    }
    if (r < mode.idle + mode.shotTimeout) {
      me.shotStart(12, 0);
      me.path([
        [
          0.05,
          m.lies[me.playerId].pos?.x ?? 0,
          1,
          m.lies[me.playerId].pos?.z ?? 0,
          0,
          0,
          0,
          1,
        ],
      ]);
      log.push(`${me.name} lets the shot expire on hole ${m.hole + 1}`);
      const before = C.stable(m.lies);
      await me.until(
        (b) =>
          b.you.phase !== "playing" ||
          C.stable(b.match.lies) !== before ||
          b.match.hole !== m.hole,
        { timeout: SHOT * 4, label: "shot expiry" },
      );
      // A late shotEnd must be refused.
      const n = me.notices.length;
      if (me.you.phase === "playing") {
        me.shotEnd(
          m.lies[me.playerId].pos ?? SERVER_HOLES[m.hole].tee,
          false,
          0,
        );
        me.expectLate = (me.expectLate ?? 0) + 1;
      }
      return;
    }
    const plan = planShot(me, mode);
    const before = C.stable(m.lies);
    me.shotStart(12, rnd() * 6 - 3);
    const from = m.lies[me.playerId].pos ?? SERVER_HOLES[m.hole].tee;
    me.path([
      [0.05, from.x, from.y + 1, from.z, 0, 0, 0, 1],
      [0.1, plan.rest.x, plan.rest.y + 1, plan.rest.z, 0, 0, 0, 1],
    ]);
    me.shotEnd(plan.rest, plan.holed, plan.penalty);
    // Stay under the 5 lines / 5 s limit so every line must arrive.
    if (rnd() < 0.3 && Date.now() - (me.lastChatAt ?? 0) > 1500) {
      me.lastChatAt = Date.now();
      me.mchat(`${me.name} line ${Math.floor(rnd() * 1e6)} zz${me.code}`);
    }
    await me.until(
      (b) =>
        b.you.phase !== "playing" ||
        C.stable(b.match.lies) !== before ||
        b.match.hole !== m.hole ||
        b.notices.length > (b._n ?? 0),
      { timeout: 8000, label: "shot reflected" },
    );
    await sleep(mode.gap ?? 30);
  };
  while (a.you?.phase === "playing") {
    const me = bots.find((b) => b.isMyTurn());
    if (!me) {
      await a.nextSnapshot().catch(() => {});
      continue;
    }
    me._n = me.notices.length;
    await step(me);
  }
}

test(
  `rules fuzz: ${MATCHES} parallel matches, seed ${SEED}`,
  { timeout: 600000 },
  async (t) => {
    const srv = await startGolfServer({
      port: PORT,
      env: {
        GOLF_TURN_TIMEOUT_MS: String(TURN),
        GOLF_SHOT_TIMEOUT_MS: String(SHOT),
        GOLF_FINISHED_LINGER_MS: String(LINGER),
      },
    });
    const groups = [];
    t.after(async () => {
      for (const g of groups) g.bots.forEach((b) => b.close());
      await srv.stop();
    });
    const setups = await Promise.all(
      Array.from({ length: MATCHES }, (_, i) =>
        setupMatch(srv.url, [`D${i}`, `S${i}`]),
      ),
    );
    for (const st of setups) groups.push({ code: st.code, bots: st.bots });
    const modes = setups.map((_, i) => ({
      idle: i % 4 === 0 ? 0.08 : 0,
      shotTimeout: i % 3 === 0 ? 0.08 : 0,
      tie: true,
      dribble: i % 2 === 0,
      penalty: i % 5 === 0 ? 0.3 : 0.08,
    }));
    await Promise.all(
      setups.map(async (st, i) => {
        st.bots[0].mchat(`first line from D${i} qq${st.code}`);
        st.bots[0].lastChatAt = Date.now();
        await playMatch(st.bots, modes[i], []);
        await Promise.all(
          st.bots.map((b) => b.untilPhase("finished", { timeout: 20000 })),
        );
        await sleep(1600);
        st.bots[1].mchat(`gg from S${i} after the end ww${st.code}`);
        await st.bots[0].untilChat(new RegExp(`ww${st.code}`), {
          timeout: 5000,
        });
      }),
    );
    await sleep(LINGER + 1500);
    const v = [];
    for (const g of groups) {
      const recs = g.bots.map((b) => b.records());
      v.push(
        ...C.checkLiveness(recs, { code: g.code }),
        ...C.checkAgreement(recs, { code: g.code }),
        ...C.checkHonors(recs[0], { code: g.code }),
        ...C.checkHonors(recs[1], { code: g.code }),
        ...C.checkMatchPlay(recs[0], { code: g.code }),
        ...C.checkMatchPlay(recs[1], { code: g.code }),
        ...C.checkChat(recs, { code: g.code }),
      );
      for (const b of g.bots) {
        const late = b.notices.filter(
          (n) => n.text === "No shot in play",
        ).length;
        const other = b.notices.filter((n) => n.text !== "No shot in play");
        if (other.length)
          v.push(
            `${b.name}: unexpected notices ${JSON.stringify(other.map((n) => n.text))}`,
          );
        if (late !== (b.expectLate ?? 0))
          v.push(
            `${b.name}: ${late} 'No shot in play' for ${b.expectLate ?? 0} late shotEnds`,
          );
        if (b.code)
          v.push(`${b.name}: still in match ${b.code} after the linger`);
      }
      const last = C.views(recs[0], g.code).pop().m;
      t.diagnostic(
        `${g.code}: ${last.result?.text} | ${last.holeResults.map((r) => `${Object.values(r.strokes).join("-")} ${r.winner ? last.names[r.winner] : "half"}${r.reason === "timeout" ? " (timeout)" : ""}`).join(", ")}`,
      );
    }
    v.push(
      ...C.checkIsolation(
        groups.map((g) => ({
          code: g.code,
          recs: g.bots.map((b) => b.records()),
        })),
      ),
    );
    C.assertClean(v, "rules fuzz");
  },
);
