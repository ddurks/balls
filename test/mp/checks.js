// Contract checks for live multiplayer runs (docs/course-multiplayer-plan.md,
// "Contract"). Each takes plain records (bot.records() / sim.records(), or
// the same JSON read back from disk) and returns an array of violation
// strings; empty means the run kept that part of the contract. Some attach a
// `.stats` object. assertClean() throws with every violation listed.
//
// A record may span several matches; most checks take { code } and default to
// the last match the record was in.
if (!globalThis.window) globalThis.window = { innerWidth: 1280 };
require("../../src/game/config.js");
const { Wind } = require("../../src/game/wind.js");
const { holeById, STROKE_CAP } = require("./holes.js");

const HOLE_COUNT = 3;
const AWAY_TIE_M = 0.01;
const flat = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
const dist3 = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

function stable(v) {
  if (Array.isArray(v)) return `[${v.map(stable).join(",")}]`;
  if (v && typeof v === "object")
    return `{${Object.keys(v)
      .sort()
      .filter((k) => v[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${stable(v[k])}`)
      .join(",")}}`;
  return JSON.stringify(v);
}

function lastCode(rec) {
  for (let i = rec.snaps.length - 1; i >= 0; i--) {
    const c = rec.snaps[i].you?.matchCode;
    if (c) return c;
  }
  return null;
}

/**
 * Every snapshot of `code` that carries a match view: {at, i, bytes, m, you},
 * i its index in rec.snaps (arrival order: ws hands every snapshot of one
 * socket read over in the same millisecond, so `at` can't order them).
 */
function views(rec, code = lastCode(rec)) {
  const out = [];
  rec.snaps.forEach((s, i) => {
    if (s.you?.matchCode === code && s.you.match)
      out.push({ at: s.at, i, bytes: s.bytes, m: s.you.match, you: s.you });
  });
  return out;
}

const strokesSum = (m) =>
  Object.values(m.lies).reduce((n, l) => n + l.strokes, 0);
// One server state per key: strokes only ever grow within a hole, a hole only
// ends by adding a result, and the phase changes on finish/forfeit.
const keyOf = (m) =>
  `${m.phase}|${m.hole}|${m.holeResults.length}|${strokesSum(m)}`;
// Who's connected (present) comes and goes without a stroke; it isn't play.
const canon = (m) =>
  stable({ ...m, turnEndsIn: undefined, present: undefined });

function settledStates(rec, code) {
  const out = new Map();
  const bad = [];
  for (const v of views(rec, code)) {
    if (v.m.shotOpen) continue;
    const k = keyOf(v.m);
    const c = canon(v.m);
    if (out.has(k) && out.get(k).c !== c)
      bad.push(
        `${rec.name}: state ${k} changed with no stroke or result: ${out.get(k).c} -> ${c}`,
      );
    if (!out.has(k)) out.set(k, { c, m: v.m, at: v.at });
  }
  return { states: out, bad };
}

// ---- 1. agreement -------------------------------------------------------------

/**
 * What the server made of one of a sim's shots. `after` is the first view of
 * the server having moved past the turn the shot was played in (it bumps
 * turnSeq at every turn, and a finished match leaves play) that arrived after
 * the view the sim swung on: shot.snapIdx is how many snapshots it had then
 * (records without it fall back to times). The system lines that came with
 * it say how: "played" (shotEnd taken), "expired" (the shot timeout charged a
 * stroke from the lie) or "conceded" (never opened: the turn ran out before
 * the shot reached the server, or was already over when it swung).
 */
function shotOutcome(rec, shot) {
  const vs = views(rec, shot.code);
  const past = (x) => x.m.turnSeq > shot.turnSeq || x.m.phase !== "playing";
  let after;
  if (shot.snapIdx != null) {
    // Swung on a view already past its turn: refused, so it changed nothing.
    const seen = vs.filter((x) => x.i < shot.snapIdx).pop();
    if (seen && past(seen)) return { after: seen, outcome: "conceded" };
    after = vs.find((x) => x.i >= shot.snapIdx && past(x));
  } else after = vs.find((x) => x.at >= shot.openedAt && past(x));
  if (!after) return { after: null, outcome: null };
  const name = after.m.names?.[rec.playerId] ?? rec.name;
  const said = rec.chatDeliveries
    .filter(
      (d) =>
        d.code === shot.code &&
        (d.i != null ? d.i === after.i : d.at === after.at),
    )
    .flatMap((d) => d.lines)
    .filter((l) => !l.from)
    .map((l) => l.text);
  const outcome = said.includes(
    `${name}'s shot timed out: stroke, replay from the lie`,
  )
    ? "expired"
    : said.some((t) => t.startsWith(`${name} ran out of time, `))
      ? "conceded"
      : "played";
  return { after, outcome };
}

/**
 * Both clients and the server agree on every lie, stroke count, turn, hole and
 * status: whenever two clients saw the server at the same settled state they
 * saw identical views, and each sim's own shots match what the server
 * recorded (rest within tol, strokes = before + 1 + penalty, capped).
 */
function checkAgreement(recs, { code, tol = 0.01 } = {}) {
  const v = [];
  code = code ?? lastCode(recs[0]);
  const per = recs.map((r) => {
    const s = settledStates(r, code);
    v.push(...s.bad);
    return s.states;
  });
  for (let i = 0; i < recs.length; i++)
    for (let j = i + 1; j < recs.length; j++)
      for (const [k, a] of per[i]) {
        const b = per[j].get(k);
        if (b && a.c !== b.c)
          v.push(
            `${recs[i].name} and ${recs[j].name} disagree at ${k}:\n  ${a.c}\n  ${b.c}`,
          );
      }
  for (const rec of recs) {
    if (!rec.shots) continue;
    // Lies only change when a shot closes, so a view with the next shot
    // already open still shows this one's result.
    const vs = views(rec, code).filter((x) => !x.m.shotOpen);
    for (const [i, shot] of rec.shots.entries()) {
      if (shot.endSentAt == null || shot.code !== code) continue;
      const label = `${rec.name} shot ${i + 1} (hole ${shot.hole + 1})`;
      const before = [...vs]
        .reverse()
        .find((x) =>
          shot.snapIdx != null ? x.i < shot.snapIdx : x.at <= shot.openedAt,
        );
      const { after, outcome } = shotOutcome(rec, shot);
      if (!after) {
        v.push(`${label}: no view after the shot ends its turn`);
        continue;
      }
      // Never opened (the turn ran out first): the shot changes nothing.
      // Timed out on the server: a stroke, and the ball stays where it was.
      const want =
        outcome === "conceded"
          ? shot.strokesBefore
          : Math.min(
              STROKE_CAP,
              shot.strokesBefore +
                1 +
                (outcome === "expired" ? 0 : shot.penalty),
            );
      if (
        outcome !== "conceded" &&
        after.m.hole === shot.hole &&
        after.m.phase === "playing"
      ) {
        const lie = after.m.lies[rec.playerId];
        if (lie.strokes !== want)
          v.push(`${label}: server strokes ${lie.strokes}, expected ${want}`);
        if (outcome === "expired") {
          const was =
            before?.m.hole === shot.hole
              ? before.m.lies[rec.playerId].pos
              : undefined;
          if (
            lie.holed ||
            (was !== undefined && stable(lie.pos) !== stable(was))
          )
            v.push(
              `${label}: timed out, yet the lie moved ${stable(was)} -> ${stable(lie.pos)}`,
            );
        } else {
          if (lie.holed !== shot.holed)
            v.push(
              `${label}: server holed=${lie.holed}, client holed=${shot.holed}`,
            );
          if (shot.holed) {
            if (dist3(lie.pos, after.m.pin) > 1e-9)
              v.push(
                `${label}: holed lie ${JSON.stringify(lie.pos)} is not the pin`,
              );
          } else if (!lie.pos || dist3(lie.pos, shot.rest) > tol)
            v.push(
              `${label}: server lie ${JSON.stringify(lie.pos)} vs client rest ${JSON.stringify(shot.rest)}`,
            );
        }
        // The opponent's ball doesn't move on my shot (a decided hole may pick
        // them up). Judged on the view that resolved it only: a lagging link's
        // snapshots are held back, so the first view after can already show
        // the opponent's next shot too.
        if (
          before &&
          before.m.hole === shot.hole &&
          after.m.turnSeq === shot.turnSeq + 1
        )
          for (const [id, l0] of Object.entries(before.m.lies)) {
            if (id === rec.playerId) continue;
            const l1 = after.m.lies[id];
            if (
              stable({ ...l0, pickedUp: 0 }) !==
                stable({ ...l1, pickedUp: 0 }) ||
              (l0.pickedUp && !l1.pickedUp)
            )
              v.push(
                `${label}: opponent lie changed ${stable(l0)} -> ${stable(l1)}`,
              );
          }
      } else {
        const res = after.m.holeResults[shot.hole];
        if (
          res &&
          res.strokes[rec.playerId] !== want &&
          !after.m.result?.reason?.startsWith("forfeit")
        )
          v.push(
            `${label}: hole result strokes ${res.strokes[rec.playerId]}, expected ${want}`,
          );
      }
      if (before && before.m.hole === shot.hole && !shot.fromTee) {
        const lie = before.m.lies[rec.playerId];
        if (lie.pos && dist3(lie.pos, shot.from) > tol)
          v.push(
            `${label}: played from ${JSON.stringify(shot.from)}, server lie ${JSON.stringify(lie.pos)}`,
          );
      }
    }
  }
  return v;
}

// ---- 2. honors ----------------------------------------------------------------

function expectedTurn(m) {
  const active = m.teeOrder.filter(
    (id) => !m.lies[id].holed && !m.lies[id].pickedUp,
  );
  if (!active.length) return null;
  const toTee = active.find((id) => m.lies[id].strokes === 0);
  if (toTee) return toTee;
  const tee = holeById(m.holeId).tee;
  const d = (id) => flat(m.lies[id].pos ?? tee, m.pin);
  let best = active[0];
  for (const id of active.slice(1)) if (d(id) > d(best) + AWAY_TIE_M) best = id;
  return best;
}

const nameMatch = (line, name, rest) => line.text.startsWith(`${name}${rest}`);

// The server's line opening each hole. Hole segments are cut on it among the
// server's own lines only: a player can type "Hole 2 (par 3): ...".
const HOLE_HEADER = /^Hole (\d+) \(par \d+\): .+ has the honor$/;

/** Per-player hole score as the server ranks it: holed strokes, 11 not holed, 12 conceded. */
function holeScores(chat, m, n) {
  const res = m.holeResults[n];
  const id = holeById(res.holeId).id;
  const sys = chat.filter((l) => !l.from);
  const startIdx = sys.findIndex(
    (l) => HOLE_HEADER.exec(l.text)?.[1] === String(id),
  );
  const nextIdx = sys.findIndex(
    (l, i) => i > startIdx && HOLE_HEADER.test(l.text),
  );
  const seg = sys.slice(startIdx, nextIdx < 0 ? undefined : nextIdx);
  const ids = Object.keys(res.strokes);
  const holed = new Set(
    ids.filter((p) =>
      seg.some((l) => nameMatch(l, m.names[p], " holed out in ")),
    ),
  );
  const conceder =
    res.reason === "timeout"
      ? ids.find((p) =>
          seg.some((l) => nameMatch(l, m.names[p], " ran out of time, ")),
        )
      : null;
  const score = {};
  for (const p of ids)
    score[p] =
      p === conceder
        ? STROKE_CAP + 2
        : holed.has(p)
          ? res.strokes[p]
          : STROKE_CAP + 1;
  return { score, holed, conceder, known: startIdx >= 0 };
}

/**
 * The player to play is always the farthest from the pin among those still
 * out (tee order first, level lies to the earlier tee slot); each hole tees
 * off in the previous hole's score order, honors to the best.
 */
function checkHonors(rec, { code } = {}) {
  const v = [];
  code = code ?? lastCode(rec);
  const vs = views(rec, code);
  const chat = chatLog(rec, code);
  for (const { m, at } of vs) {
    if (m.phase !== "playing" || m.shotOpen) continue;
    const want = expectedTurn(m);
    if (m.turn !== want)
      v.push(
        `${rec.name} @${at}: hole ${m.hole + 1} turn ${m.names[m.turn] ?? m.turn}, expected ${m.names[want] ?? want} (${stable(m.lies)})`,
      );
  }
  const last = vs[vs.length - 1]?.m;
  if (!last) return v;
  const firstOfHole = new Map();
  for (const { m } of vs)
    if (!firstOfHole.has(m.hole)) firstOfHole.set(m.hole, m);
  for (const [hole, m] of firstOfHole) {
    let want;
    if (hole === 0) want = Object.keys(m.names);
    else {
      const prev = firstOfHole.get(hole - 1);
      if (!prev || !last.holeResults[hole - 1]) continue;
      const { score, known } = holeScores(chat, last, hole - 1);
      if (!known) continue;
      want = [...prev.teeOrder].sort((a, b) => score[a] - score[b]);
    }
    if (stable(m.teeOrder) !== stable(want))
      v.push(
        `${rec.name}: hole ${hole + 1} tee order ${m.teeOrder.map((p) => m.names[p])}, expected ${want.map((p) => m.names[p])}`,
      );
  }
  return v;
}

// ---- 3. match play ------------------------------------------------------------

function statusText(m, won, played) {
  const [a, b] = Object.keys(m.names);
  const diff = won[a] - won[b];
  const remaining = HOLE_COUNT - played;
  if (!diff) return "ALL SQUARE";
  const leader = diff > 0 ? a : b;
  const lead = Math.abs(diff);
  return `${m.names[leader]} ${lead} UP${lead === remaining ? " (dormie)" : ""}`;
}

/**
 * Hole results, halves, the running status (UP / dormie / ALL SQUARE), early
 * finish and the final result, recomputed from what the server reported.
 */
function checkMatchPlay(rec, { code } = {}) {
  const v = [];
  code = code ?? lastCode(rec);
  const vs = views(rec, code);
  if (!vs.length) return [`${rec.name}: never saw a match view`];
  const last = vs[vs.length - 1].m;
  const chat = chatLog(rec, code);
  const ids = Object.keys(last.names);
  const won = Object.fromEntries(ids.map((p) => [p, 0]));
  let finishedAt = null;
  last.holeResults.forEach((res, i) => {
    const { score, holed, conceder, known } = holeScores(chat, last, i);
    if (!known) return v.push(`${rec.name}: no chat for hole ${i + 1}`);
    const best = Math.min(...ids.map((p) => score[p]));
    const leaders = ids.filter((p) => score[p] === best);
    const winner = leaders.length === 1 ? leaders[0] : null;
    if (res.winner !== winner)
      v.push(
        `${rec.name}: hole ${i + 1} winner ${res.winner}, expected ${winner} (${stable(score)})`,
      );
    if (res.winner) won[res.winner]++;
    // Its chat line, with the status after it unless the match ended there.
    const hid = res.holeId;
    let line;
    if (conceder)
      line = `${last.names[conceder]} ran out of time, ${res.winner ? last.names[res.winner] : "nobody"} wins hole ${hid}`;
    else if (res.winner)
      line = `${last.names[res.winner]} wins hole ${hid} with a ${res.strokes[res.winner]}`;
    else
      line = `Hole ${hid} halved${ids.every((p) => holed.has(p)) ? ` in ${res.strokes[ids[0]]}` : ""}`;
    const diff = Math.abs(won[ids[0]] - won[ids[1]]);
    const remaining = HOLE_COUNT - (i + 1);
    const over = diff > remaining || remaining === 0;
    const text = over ? line : `${line}. ${statusText(last, won, i + 1)}`;
    if (!chat.some((l) => !l.from && l.text === text))
      v.push(`${rec.name}: missing hole line "${text}"`);
    if (over && finishedAt == null) finishedAt = i + 1;
  });
  if (stable(last.score) !== stable(won))
    v.push(`${rec.name}: score ${stable(last.score)}, expected ${stable(won)}`);
  // Running status on every view in play.
  for (const { m } of vs) {
    if (m.phase !== "playing") continue;
    const w = Object.fromEntries(ids.map((p) => [p, 0]));
    for (const r of m.holeResults) if (r.winner) w[r.winner]++;
    const want = statusText(m, w, m.holeResults.length);
    if (m.status !== want) {
      v.push(`${rec.name}: status "${m.status}", expected "${want}"`);
      break;
    }
  }
  if (last.phase === "finished") {
    const r = last.result;
    if (!r) v.push(`${rec.name}: finished without a result`);
    else if (r.reason === "holes") {
      if (finishedAt !== last.holeResults.length)
        v.push(
          `${rec.name}: finished after ${last.holeResults.length} holes, the match was decided after ${finishedAt}`,
        );
      const diff = won[ids[0]] - won[ids[1]];
      const leader = diff > 0 ? ids[0] : diff < 0 ? ids[1] : null;
      const lead = Math.abs(diff);
      const remaining = HOLE_COUNT - last.holeResults.length;
      const text = !leader
        ? "Match halved"
        : remaining > 0
          ? `${last.names[leader]} wins ${lead} & ${remaining}`
          : `${last.names[leader]} wins ${lead} UP`;
      if (r.text !== text)
        v.push(`${rec.name}: result "${r.text}", expected "${text}"`);
      if (r.winner !== leader)
        v.push(`${rec.name}: result winner ${r.winner}, expected ${leader}`);
      if (last.status !== r.text)
        v.push(`${rec.name}: final status "${last.status}" is not the result`);
    } else if (r.reason === "forfeit") {
      const text = r.winner
        ? `${last.names[r.winner]} wins by forfeit`
        : "Match abandoned";
      if (r.text !== text)
        v.push(`${rec.name}: forfeit result "${r.text}", expected "${text}"`);
    }
    // Players may keep chatting on the results screen; the server's last word is the result.
    const lastSystem = chat.filter((l) => !l.from).pop();
    if (lastSystem?.text !== r?.text)
      v.push(
        `${rec.name}: last system line "${lastSystem?.text}" is not the result`,
      );
    if (last.turn !== null || last.shotOpen)
      v.push(`${rec.name}: finished match still has a turn or an open shot`);
  }
  return v;
}

// ---- 4. chat ------------------------------------------------------------------

function chatLog(rec, code = lastCode(rec)) {
  const by = new Map();
  for (const d of rec.chatDeliveries)
    if (d.code === code) for (const l of d.lines) by.set(l.seq, l);
  return [...by.values()].sort((a, b) => a.seq - b.seq);
}

// The server's chat (and name) normalization, engine.ts cleanText: raw text
// past 8 UTF-16 units per output code point is cut unread, unpaired
// surrogates go, control characters (C0, DEL, C1) and whitespace runs collapse
// to one space, bidi embeddings / overrides / isolates go, 200 code points at
// most, and a line with nothing visible left is dropped (""): format
// characters, default-ignorables (zero-width characters, variation selectors,
// Hangul fillers) and the blank Braille cell draw nothing.
const SPACE_RUN = /[\s\p{Cc}]+/gu;
const BIDI_CONTROL = /[\u202a-\u202e\u2066-\u2069]/g;
const LONE_SURROGATE =
  /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;
const VISIBLE = /[^\s\p{Cc}\p{Cf}\p{Default_Ignorable_Code_Point}\u2800]/u;
const normalizeChat = (raw, max = 200) => {
  const text = Array.from(
    raw
      .slice(0, max * 8)
      .replace(LONE_SURROGATE, "")
      .replace(BIDI_CONTROL, "")
      .replace(SPACE_RUN, " ")
      .trim(),
  )
    .slice(0, max)
    .join("")
    .trim();
  return VISIBLE.test(text) ? text : "";
};
const CHAT_BURST = 5; // lines per sender per CHAT_WINDOW_MS (engine.ts)
const CHAT_WINDOW_MS = 5000;
const CHAT_LOG_MAX = 100; // lines a match keeps (engine.ts)

const MOVES = new Set(["create", "join", "leave", "rv"]);
const isMove = (s) => s.msg?.t === "action" && MOVES.has(s.msg.action);

/**
 * When `rec` was in match `code`, by its own snapshots: [{inAt, outAt, entry,
 * exit}], outAt when a snapshot first showed it elsewhere (Infinity if none
 * did), entry the index in rec.sent of the move (create / join / leave / rv)
 * that put it in (-1 if none), exit the index of its next move (sent.length
 * if none).
 */
function spansIn(rec, code) {
  const spans = [];
  let inAt = null;
  const close = (outAt) => {
    let entry = -1;
    rec.sent.forEach((s, i) => {
      if (isMove(s) && s.at <= inAt) entry = i;
    });
    let exit = entry + 1;
    while (exit < rec.sent.length && !isMove(rec.sent[exit])) exit++;
    spans.push({ inAt, outAt, entry, exit });
  };
  for (const s of rec.snaps) {
    if (!s.you) continue; // nothing changed
    const here = s.you.matchCode === code;
    if (here && inAt === null) inAt = s.at;
    else if (!here && inAt !== null) {
      close(s.at);
      inAt = null;
    }
  }
  if (inAt !== null) close(Infinity);
  return spans;
}

/**
 * The chat lines `rec` sent, normalized ("" dropped): {i, at, text, sure,
 * maybe}. sure: sent while it was surely in match `code` (after a snapshot
 * showed it in, before its next move or a snapshot showing it out), so the
 * server must have logged it there. maybe: sent between the move that put it
 * in and the snapshot that showed it out, so it may have landed there.
 */
function chatSent(rec, code) {
  const spans = spansIn(rec, code);
  const out = [];
  rec.sent.forEach((s, i) => {
    if (
      !(s.msg?.t === "action" && s.msg.action === "mchat") &&
      s.msg?.t !== "chat"
    )
      return;
    const text = normalizeChat(String(s.msg.message ?? s.msg.text ?? ""));
    if (!text) return;
    const maybe = spans.some((p) => i > p.entry && s.at < p.outAt);
    const sure = spans.some(
      (p) => i > p.entry && i < p.exit && s.at >= p.inAt && s.at < p.outAt,
    );
    out.push({ i, at: s.at, text, sure, maybe });
  });
  return out;
}

/**
 * The deliveries (by snapshot index) that open each of `rec`'s stays in match
 * `code`: the first after a snapshot showed it in, having been out.
 */
function stayOpeners(rec, code) {
  const out = new Set();
  let here = false;
  let fresh = false;
  rec.snaps.forEach((s, i) => {
    if (!s.you) return; // nothing changed
    const now = s.you.matchCode === code;
    if (now && !here) fresh = true;
    here = now;
    if (fresh && now && s.you.chat?.length) {
      out.add(i);
      fresh = false;
    }
  });
  return { openers: out, stillIn: here };
}

/**
 * The match chat as each member received it: in order, no duplicates or gaps,
 * the same line for the same seq everywhere, speaker fields right (the name
 * the speaker had in the match), every line a member sent while in this
 * match present once (unless the rate limit refused it) for every member
 * still there once it was logged. A (re)joiner is handed the retained log
 * from its start: lines that fell off the bounded log while it was away are
 * gone for everyone, so that's no gap. allowRedelivery: a member rejoined and
 * was re-sent lines it already had.
 */
function checkChat(recs, { code, allowRedelivery = false } = {}) {
  const v = [];
  code = code ?? lastCode(recs[0]);
  // Every name each player bore in the match: a line keeps the one it was
  // said under, and a joiner's " 2" can go when it rejoins.
  const names = new Map();
  for (const r of recs)
    for (const s of r.snaps)
      if (s.you?.matchCode === code)
        for (const p of s.you.players ?? []) {
          if (!names.has(p.id)) names.set(p.id, new Set());
          names.get(p.id).add(p.name);
        }
  const bySeq = new Map();
  for (const r of recs) {
    let max = 0;
    const { openers, stillIn } = stayOpeners(r, code);
    let stay = null;
    for (const d of r.chatDeliveries.filter((x) => x.code === code)) {
      let prev = null;
      for (const l of d.lines) {
        if (prev != null && l.seq !== prev + 1)
          v.push(`${r.name}: chat seq ${prev} then ${l.seq} in one delivery`);
        prev = l.seq;
      }
      const first = d.lines[0].seq;
      const opens = openers.has(d.i);
      if (opens) stay = { first, last: prev };
      else if (stay) stay.last = Math.max(stay.last, prev);
      if (first <= max && !allowRedelivery)
        v.push(`${r.name}: chat seq ${first} delivered again (max ${max})`);
      else if (first > max + 1 && max > 0 && !opens)
        v.push(`${r.name}: chat gap ${max} -> ${first}`);
      max = Math.max(max, prev);
    }
    // A stay handed the log from past seq 1 found it full: the restore holds
    // CHAT_LOG_MAX lines, unless the member left before the rest came.
    if (
      stay &&
      stillIn &&
      stay.first > 1 &&
      stay.last - stay.first < CHAT_LOG_MAX - 1
    )
      v.push(
        `${r.name}: chat restored from seq ${stay.first}, past the start of the retained log`,
      );
    const log = chatLog(r, code);
    if (
      log.length &&
      log[0].seq !== 1 &&
      log[log.length - 1].seq - log[0].seq < CHAT_LOG_MAX - 1
    )
      v.push(
        `${r.name}: chat starts at seq ${log[0].seq} though the log is short`,
      );
    for (const l of log) {
      const t = stable(l);
      if (bySeq.has(l.seq) && bySeq.get(l.seq).t !== t)
        v.push(`chat seq ${l.seq} differs: ${bySeq.get(l.seq).t} vs ${t}`);
      bySeq.set(l.seq, { t });
      if (!l.text || l.text !== normalizeChat(l.text))
        v.push(
          `${r.name}: chat line ${l.seq} not normalized: ${JSON.stringify(l.text)}`,
        );
      if ((l.from == null) !== (l.name == null))
        v.push(
          `${r.name}: chat line ${l.seq} has from without name or vice versa`,
        );
      if (l.from != null && !names.get(l.from)?.has(l.name))
        v.push(`${r.name}: chat line ${l.seq} from ${l.from} named ${l.name}`);
    }
  }
  // Every line a member sent in this match shows up once, from them.
  for (const sender of recs) {
    const said = chatSent(sender, code);
    // The rate limit is the player's, across matches, and counts lines sent in
    // any match (one in none is dropped first). It may refuse a line sent with
    // CHAT_BURST such others inside the window before it (slack for the trip
    // to the server). Its refusals don't count one per notice: those between
    // two snapshots arrive as one.
    const codes = new Set(
      sender.snaps.map((s) => s.you?.matchCode).filter(Boolean),
    );
    const counted = new Set();
    for (const c of codes)
      for (const s of chatSent(sender, c)) if (s.maybe) counted.add(s.i);
    const limited = (k) =>
      said
        .slice(0, k)
        .filter(
          (x) => counted.has(x.i) && said[k].at - x.at < CHAT_WINDOW_MS + 1000,
        ).length >= CHAT_BURST;
    // When the sender had each sure line back: the server had logged it.
    const own = chatLog(sender, code).filter((l) => l.from === sender.playerId);
    const backAt = new Map();
    for (const d of sender.chatDeliveries)
      if (d.code === code)
        for (const l of d.lines)
          if (l.from === sender.playerId && !backAt.has(l.seq))
            backAt.set(l.seq, d.at);
    let o = 0;
    const loggedAt = said.map((s) => {
      if (!s.sure) return Infinity;
      const j = own.findIndex((l, k) => k >= o && l.text === s.text);
      if (j < 0) return Infinity; // refused, or it left before it had it back
      o = j + 1;
      return backAt.get(own[j].seq);
    });
    for (const r of recs) {
      const mine = chatLog(r, code)
        .filter((l) => l.from === sender.playerId)
        .map((l) => l.text);
      // A member (the sender too) that never left gets the line; one that
      // asked to leave after the line was logged was still there for it. A
      // match only dissolves after its last line.
      const spans = spansIn(r, code);
      const stayed = (at) =>
        spans.some((p) => {
          const left = Math.min(r.sent[p.exit]?.at ?? Infinity, p.outAt);
          return left === Infinity || left > at;
        });
      const missing = said.filter(
        (s, k) =>
          s.sure &&
          stayed(loggedAt[k]) &&
          !mine.includes(s.text) &&
          !limited(k),
      );
      if (missing.length)
        v.push(
          `${r.name}: missing ${missing.length} line(s) ${sender.name} sent: ${JSON.stringify(missing.map((m) => m.text))}`,
        );
      for (const t of new Set(mine)) {
        const n = mine.filter((x) => x === t).length;
        const m = said.filter((s) => s.maybe && s.text === t).length;
        if (n > m)
          v.push(
            `${r.name}: "${t}" from ${sender.name} appears ${n}x, sent ${m}x`,
          );
      }
    }
  }
  return v;
}

// ---- 5. isolation ---------------------------------------------------------------

// Per-connection replies that carry no match data. Not the bootstrap
// handshake: the golf world takes no bootstrap, and one would be a player's
// upload relayed to everyone.
const WORLD_PLUMBING = new Set(["pong", "videoSync", "err"]);

const GLOBAL_KEYS = new Set([
  "t",
  "type",
  "playerCount",
  "matchCount",
  "you",
  "broadcasts",
]);

/**
 * groups: [{ code?, recs }], one per match running in parallel. Nothing of
 * one match (roster, paths, chat) reaches another, the global snapshot part
 * carries no match data, and plain world chat is never broadcast.
 */
function checkIsolation(groups) {
  const v = [];
  const info = groups.map((g) => {
    const code = g.code ?? lastCode(g.recs[0]);
    const ids = new Set(g.recs.map((r) => r.playerId));
    const said = new Set();
    for (const r of g.recs)
      for (const s of r.sent) {
        const t =
          s.msg?.t === "chat"
            ? s.msg.text
            : s.msg?.action === "mchat"
              ? s.msg.message
              : null;
        if (t && normalizeChat(t)) said.add(normalizeChat(t));
      }
    return { code, ids, said, recs: g.recs };
  });
  for (const [gi, g] of info.entries()) {
    const foreignSaid = new Set(
      info.filter((_, j) => j !== gi).flatMap((o) => [...o.said]),
    );
    const foreignIds = new Set(
      info.filter((_, j) => j !== gi).flatMap((o) => [...o.ids]),
    );
    for (const r of g.recs) {
      for (const s of r.snaps) {
        for (const k of s.keys)
          if (!GLOBAL_KEYS.has(k))
            v.push(`${r.name}: snapshot carries global key "${k}"`);
        const y = s.you;
        if (!y) continue;
        if (
          y.matchCode &&
          y.matchCode !== g.code &&
          info.some((o) => o.code === y.matchCode)
        )
          v.push(`${r.name}: saw match ${y.matchCode}, its own is ${g.code}`);
        for (const p of y.players ?? [])
          if (foreignIds.has(p.id))
            v.push(`${r.name}: roster has foreign player ${p.id}`);
        for (const id of Object.keys(y.match?.lies ?? {}))
          if (foreignIds.has(id))
            v.push(`${r.name}: lies of foreign player ${id}`);
        for (const l of y.chat ?? []) {
          if (l.from && foreignIds.has(l.from))
            v.push(`${r.name}: chat from foreign player ${l.from}`);
          // Parallel matches say the same everyday things ("gg"), and a player
          // may type a system line's words: only a player line that this
          // match never said, and another did, came from elsewhere.
          else if (l.from && foreignSaid.has(l.text) && !g.said.has(l.text))
            v.push(
              `${r.name}: another match's chat leaked: ${JSON.stringify(l.text)}`,
            );
        }
      }
      for (const b of r.broadcasts) {
        if (b.type !== "path") continue;
        if (b.data.playerId === r.playerId)
          v.push(`${r.name}: received its own path frame`);
        else if (!g.ids.has(b.data.playerId))
          v.push(`${r.name}: path frame from outsider ${b.data.playerId}`);
      }
      for (const o of r.other)
        if (o.msg?.t === "chat")
          v.push(
            `${r.name}: world chat broadcast in the golf world: ${JSON.stringify(o.msg)}`,
          );
        else if (!WORLD_PLUMBING.has(o.msg?.t))
          // The golf world relays nothing world-wide (typing, dance, guns,
          // bullets would carry one match's player ids to every other match).
          v.push(
            `${r.name}: world-wide "${o.msg?.t}" message in the golf world: ${JSON.stringify(o.msg).slice(0, 200)}`,
          );
    }
  }
  return v;
}

// ---- 6. path fidelity ---------------------------------------------------------

function lerpAt(samples, t) {
  let lo = 0;
  let hi = samples.length - 1;
  if (t <= samples[0][0]) return samples[0];
  if (t >= samples[hi][0]) return samples[hi];
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (samples[mid][0] <= t) lo = mid;
    else hi = mid;
  }
  const a = samples[lo];
  const b = samples[hi];
  const k = (t - a[0]) / (b[0] - a[0]);
  return [
    t,
    a[1] + (b[1] - a[1]) * k,
    a[2] + (b[2] - a[2]) * k,
    a[3] + (b[3] - a[3]) * k,
  ];
}

const pctl = (xs, p) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(p * s.length))];
};

/** The server's id for one of a sim's shots: the open shot its own view showed on that turn. */
function serverShotId(rec, shot) {
  if (shot.turnSeq === undefined) return null;
  const open = views(rec, shot.code).find(
    (x) =>
      x.m.turnSeq === shot.turnSeq &&
      x.m.shotOpen?.playerId === rec.playerId &&
      (shot.snapIdx != null ? x.i >= shot.snapIdx : x.at >= shot.openedAt),
  );
  return open ? open.m.shotOpen.id : null;
}

/**
 * What the spectator received of each of the shooter's shots against the
 * shooter's ground truth: every streamed sample, exactly, in order, once;
 * linear replay within eps (m) of the 60 Hz truth; ends on the rest the
 * server took as the lie; no jump faster than maxSpeed (m/s); delivered
 * within maxDelayMs of being sent. requireComplete: no frame may be missing
 * (false under lossy chaos: then only order and exactness are required).
 * shots: (shot, index) => whether to check it (default all).
 */
function checkPathFidelity(
  shooter,
  spectator,
  {
    eps = 1.5,
    maxDelayMs = 1500,
    maxSpeed = 200,
    requireComplete = true,
    shots = () => true,
  } = {},
) {
  const v = [];
  const stats = {
    shots: 0,
    matched: 0,
    samples: 0,
    maxInterpErr: 0,
    delays: [],
    maxDelayMs: 0,
    p95DelayMs: null,
  };
  const rx = new Map();
  for (const b of spectator.broadcasts) {
    if (b.type !== "path" || b.data.playerId !== shooter.playerId) continue;
    if (!rx.has(b.data.shot)) rx.set(b.data.shot, []);
    for (const s of b.data.samples) rx.get(b.data.shot).push({ s, at: b.at });
  }
  const same = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
  const used = new Set();
  for (const [i, shot] of (shooter.shots ?? []).entries()) {
    if (!shot.sent?.length || shot.endSentAt == null || !shots(shot, i))
      continue;
    // A shot the server never opened has no stream; one it timed out may
    // have been cut short.
    const outcome =
      shooter.snaps && shot.turnSeq !== undefined
        ? shotOutcome(shooter, shot).outcome
        : "played";
    if (outcome === "conceded") continue;
    const complete = requireComplete && outcome !== "expired";
    stats.shots++;
    const label = `${shooter.name} shot ${i + 1} -> ${spectator.name}`;
    // Its stream is the server's id for it, off the shooter's own view of the
    // shot open. Failing that (opened and closed between two snapshots), the
    // stream holding the most of its samples, two at least: shots replayed
    // from one spot share their first sample exactly.
    let id = shooter.snaps ? serverShotId(shooter, shot) : null;
    if (id == null) {
      const mine = new Set(shot.sent.map((s) => s.join()));
      let most = Math.min(2, shot.sent.length) - 1;
      for (const [sid, list] of rx) {
        if (used.has(sid)) continue;
        const n = list.filter((x) => mine.has(x.s.join())).length;
        if (n > most) {
          most = n;
          id = sid;
        }
      }
    } else if (!rx.has(id)) id = null;
    if (id == null) {
      // An expired shot may have streamed nothing in time: the server drops
      // frames that arrive after it closed the shot.
      if (outcome !== "expired") v.push(`${label}: no path frames received`);
      continue;
    }
    used.add(id);
    stats.matched++;
    const got = rx.get(id);
    const samples = got.map((x) => x.s);
    stats.samples += samples.length;
    for (let k = 1; k < samples.length; k++) {
      if (samples[k][0] <= samples[k - 1][0])
        v.push(
          `${label}: t not increasing at ${k} (${samples[k - 1][0]} -> ${samples[k][0]})`,
        );
      const dt = samples[k][0] - samples[k - 1][0];
      const dx = Math.hypot(
        samples[k][1] - samples[k - 1][1],
        samples[k][2] - samples[k - 1][2],
        samples[k][3] - samples[k - 1][3],
      );
      if (dt > 0 && dx / dt > maxSpeed)
        v.push(
          `${label}: jump of ${dx.toFixed(2)} m in ${dt.toFixed(3)} s at t=${samples[k][0]}`,
        );
    }
    let j = 0;
    for (const [k, x] of samples.entries()) {
      while (j < shot.sent.length && !same(shot.sent[j], x)) j++;
      if (j === shot.sent.length) {
        v.push(
          `${label}: received a sample never sent, or out of order: ${JSON.stringify(x)}`,
        );
        break;
      }
      stats.delays.push(got[k].at - shot.sentAt[j]);
    }
    if (complete && samples.length !== shot.sent.length)
      v.push(
        `${label}: received ${samples.length} of ${shot.sent.length} samples`,
      );
    const last = samples[samples.length - 1];
    const end = shot.sent[shot.sent.length - 1];
    if (complete && !same(last, end))
      v.push(
        `${label}: replay ends at ${JSON.stringify(last)}, path ended at ${JSON.stringify(end)}`,
      );
    if (!shot.penalty && !shot.holed && complete) {
      const d = Math.hypot(
        last[1] - shot.rest.x,
        last[2] - shot.rest.y,
        last[3] - shot.rest.z,
      );
      if (d > 0.002)
        v.push(`${label}: replay ends ${d.toFixed(4)} m from the lie`);
    }
    let worst = 0;
    for (const s of shot.truth) {
      if (s[0] < samples[0][0] || s[0] > last[0]) continue;
      const p = lerpAt(samples, s[0]);
      worst = Math.max(
        worst,
        Math.hypot(p[1] - s[1], p[2] - s[2], p[3] - s[3]),
      );
    }
    stats.maxInterpErr = Math.max(stats.maxInterpErr, worst);
    if (complete && worst > eps)
      v.push(
        `${label}: linear replay strays ${worst.toFixed(3)} m from the shot (eps ${eps})`,
      );
  }
  stats.maxDelayMs = stats.delays.length ? Math.max(...stats.delays) : 0;
  stats.p95DelayMs = pctl(stats.delays, 0.95);
  if (stats.maxDelayMs > maxDelayMs)
    v.push(
      `${shooter.name} -> ${spectator.name}: a sample took ${stats.maxDelayMs} ms to arrive (max ${maxDelayMs})`,
    );
  delete stats.delays;
  v.stats = stats;
  return v;
}

// ---- 7. shared conditions -----------------------------------------------------

/**
 * Every sim loaded the server's hole version and pin (its pinPool[pinIndex]
 * matches the server's copy) and derived the same wind from windSeed.
 */
function checkSharedConditions(sims, { code, tol = 0.02 } = {}) {
  const v = [];
  code = code ?? lastCode(sims[0]);
  const byHole = new Map();
  for (const s of sims)
    for (const h of s.holes.filter((x) => x.code === code)) {
      const label = `${s.name} hole ${h.hole + 1}`;
      const sh = holeById(h.server.holeId);
      if (h.holeId !== h.server.holeId)
        v.push(
          `${label}: loaded hole id ${h.holeId}, server ${h.server.holeId}`,
        );
      if (h.version !== h.server.version)
        v.push(
          `${label}: loaded version ${h.version}, server ${h.server.version}`,
        );
      if (
        flat(h.pin, h.server.pin) > tol ||
        Math.abs(h.pin.y - h.server.pin.y) > 0.05
      )
        v.push(
          `${label}: client pin ${stable(h.pin)} vs server pin ${stable(h.server.pin)}`,
        );
      if (flat(h.cup, h.server.pin) > tol)
        v.push(`${label}: cup ${stable(h.cup)} is not at the server pin`);
      if (sh && flat(h.tee, sh.tee) > tol)
        v.push(
          `${label}: tee ${stable(h.tee)} vs server tee ${stable(sh.tee)}`,
        );
      const w = Wind.fromSeed(h.server.windSeed);
      if (h.wind.direction !== w.direction || h.wind.speed !== w.speed)
        v.push(
          `${label}: wind ${stable(h.wind)} is not Wind.fromSeed(${h.server.windSeed})`,
        );
      if (!byHole.has(h.hole)) byHole.set(h.hole, []);
      byHole.get(h.hole).push({ s, h });
    }
  for (const [hole, list] of byHole) {
    const ref = stable({ server: list[0].h.server, wind: list[0].h.wind });
    for (const { s, h } of list.slice(1))
      if (stable({ server: h.server, wind: h.wind }) !== ref)
        v.push(`hole ${hole + 1}: ${s.name} loaded different conditions`);
    if (new Set(list.map((x) => x.s.name)).size < sims.length)
      v.push(`hole ${hole + 1}: not every client loaded it`);
  }
  return v;
}

/**
 * Every sim built the same tree and rock colliders on each hole: the ball
 * the spectator watches bounced off the shooter's rocks.
 */
function checkSameDecor(sims, { code } = {}) {
  const v = [];
  code = code ?? lastCode(sims[0]);
  const byHole = new Map();
  for (const s of sims)
    for (const h of s.holes.filter((x) => x.code === code)) {
      if (!byHole.has(h.hole)) byHole.set(h.hole, []);
      byHole.get(h.hole).push({ name: s.name, decor: h.decor });
    }
  for (const [hole, list] of byHole) {
    const [a, ...rest] = list;
    for (const b of rest) {
      const key = (d) => stable(d);
      const bs = new Set(b.decor.map(key));
      const only = a.decor.filter((d) => !bs.has(key(d)));
      if (only.length || a.decor.length !== b.decor.length)
        v.push(
          `hole ${hole + 1}: ${a.name} has ${a.decor.length} decor colliders, ${b.name} ${b.decor.length}; ${only.length} of ${a.name}'s are not in ${b.name}'s (e.g. ${JSON.stringify(only[0])})`,
        );
    }
  }
  return v;
}

// ---- 8. liveness, errors, resources ---------------------------------------------

/** The match reached `finished` with a result, and nothing is left open. */
function checkLiveness(recs, { code } = {}) {
  const v = [];
  for (const r of recs) {
    const vs = views(r, code ?? lastCode(r));
    const m = vs[vs.length - 1]?.m;
    if (!m) v.push(`${r.name}: no match view`);
    else if (m.phase !== "finished" || !m.result)
      v.push(`${r.name}: match ended in phase ${m.phase}`);
  }
  return v;
}

/**
 * What a lobby's survivor still waits for after the other side was cut, or
 * null once it's where the server should have left it: alone in the lobby if
 * it got into the match; if the cut came first (the host dropped with its
 * create, or the guest's join, still in flight), in no match, told "No match
 * with that code" if it asked for one.
 */
function lobbyCutPending(rec) {
  const entered = rec.snaps.some((s) => s.you?.matchCode);
  const you = rec.snaps.findLast((s) => s.you)?.you;
  if (entered)
    return you?.matchCode && you.players?.length === 1
      ? null
      : "alone in the lobby";
  if (you?.matchCode) return "out of any match";
  const asked = rec.sent.some(
    (s) => s.msg?.t === "action" && s.msg.action === "join",
  );
  return !asked || rec.notices.some((n) => n.text === "No match with that code")
    ? null
    : '"No match with that code"';
}

/** No server errors, no sim exceptions, and (strict) no refused actions. */
function checkNoErrors(recs, { strict = true } = {}) {
  const v = [];
  for (const r of recs) {
    for (const o of r.other)
      if (o.msg?.t === "err")
        v.push(`${r.name}: server error ${JSON.stringify(o.msg)}`);
    for (const e of r.errors ?? []) v.push(`${r.name}: sim error ${e}`);
    if (strict)
      for (const n of r.notices) v.push(`${r.name}: notice "${n.text}"`);
    for (const s of r.shots ?? [])
      if (s.stuck)
        v.push(`${r.name}: a shot on hole ${s.hole + 1} never came to rest`);
  }
  return v;
}

/** Snapshot sizes and relay queues stay bounded. */
function checkResources(
  recs,
  { maxSnapshotBytes = 32 * 1024, maxBroadcasts = 120 } = {},
) {
  const v = [];
  const stats = {};
  for (const r of recs) {
    const bytes = r.snaps.map((s) => s.bytes);
    const max = Math.max(0, ...bytes);
    stats[r.name] = {
      snapshots: bytes.length,
      maxBytes: max,
      p95Bytes: pctl(bytes, 0.95),
      maxBroadcasts: Math.max(0, ...r.snaps.map((s) => s.nb ?? 0)),
    };
    if (max > maxSnapshotBytes)
      v.push(`${r.name}: a snapshot of ${max} bytes (max ${maxSnapshotBytes})`);
    if (stats[r.name].maxBroadcasts > maxBroadcasts)
      v.push(
        `${r.name}: ${stats[r.name].maxBroadcasts} broadcasts in one snapshot`,
      );
  }
  v.stats = stats;
  return v;
}

function assertClean(violations, label = "contract") {
  if (violations.length) {
    const err = new Error(
      `${label}: ${violations.length} violation(s)\n - ${violations.join("\n - ")}`,
    );
    err.violations = violations;
    throw err;
  }
}

module.exports = {
  checkAgreement,
  checkHonors,
  checkMatchPlay,
  checkChat,
  checkIsolation,
  checkPathFidelity,
  checkSharedConditions,
  checkSameDecor,
  checkLiveness,
  lobbyCutPending,
  checkNoErrors,
  checkResources,
  assertClean,
  // helpers for writing new checks
  views,
  lastCode,
  chatLog,
  shotOutcome,
  normalizeChat,
  expectedTurn,
  holeScores,
  statusText,
  stable,
};
