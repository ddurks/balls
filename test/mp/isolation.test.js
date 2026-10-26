// Contract 8 (isolation) live, protocol bots on a private server.
// 1. Many matches in parallel, each with chat (lobby, play, results screen,
//    plain {t:'chat'}) and streamed paths: nothing crosses (checkIsolation),
//    and an outsider with no match receives nothing.
// 2. The shared-world messages the golf world inherited (typing, dance, gun
//    spawn, fired bullets) reach nobody: they would carry one match's player
//    id and client-chosen numbers to the players of every other match.
// 3. Two matches saying the same everyday words is no leak: checkIsolation
//    used to report one whenever a line's text was also said elsewhere.
// Run: node --test test/mp/isolation.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const { setTimeout } = require("node:timers");
const { startGolfServer } = require("./server.js");
const { Bot, setupMatch, fakeShot } = require("./bot.js");
const C = require("./checks.js");

const MATCHES = Number(process.env.MP_ISO_MATCHES || 12);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function play(bots, tag) {
  const [a] = bots;
  let n = 0;
  while (a.you?.phase === "playing") {
    const me = bots.find((b) => b.isMyTurn());
    if (!me) {
      await a.nextSnapshot();
      continue;
    }
    const before = C.stable(me.match.lies);
    fakeShot(me, { fraction: 0.55, frames: 4 });
    // Stay under the 5 lines / 5 s limit so every line must arrive.
    if (++n % 2 === 0 && Date.now() - (me.lastChatAt ?? 0) > 1500) {
      me.lastChatAt = Date.now();
      if (n % 4 === 0) me.chatPlain(`${tag} plain ${n} ${me.name}`);
      else me.mchat(`${tag} in play ${n} ${me.name}`);
    }
    await me.until(
      (b) =>
        b.you?.phase !== "playing" ||
        C.stable(b.match.lies) !== before ||
        b.notices.length,
      { timeout: 10000 },
    );
    await sleep(120);
  }
}

test(
  "isolation across parallel matches (contract 8)",
  { timeout: 240000 },
  async (t) => {
    const srv = await startGolfServer({
      env: { GOLF_FINISHED_LINGER_MS: "3000", GOLF_TURN_TIMEOUT_MS: "20000" },
    });
    const all = [];
    t.after(async () => {
      all.forEach((b) => b.close());
      await srv.stop();
    });

    await t.test(
      `${MATCHES} parallel matches leak no roster, chat or paths`,
      async () => {
        const outsider = new Bot(srv.url, "Outsider");
        await outsider.connect();
        all.push(outsider);
        const setups = await Promise.all(
          Array.from({ length: MATCHES }, (_, i) =>
            setupMatch(srv.url, [`D${i}`, `S${i}`], { start: false }),
          ),
        );
        for (const s of setups) all.push(...s.bots);
        // Lobby chat, then start.
        setups.forEach((s, i) =>
          s.bots[1].mchat(`m${i} lobby hello ${s.code}`),
        );
        for (const s of setups) s.host.start();
        await Promise.all(
          setups.flatMap((s) => s.bots.map((b) => b.untilPhase("playing"))),
        );
        outsider.chatPlain("outsider says hi to everyone");
        await Promise.all(setups.map((s, i) => play(s.bots, `m${i}`)));
        // Results-screen chat.
        setups.forEach((s, i) =>
          s.bots[0].mchat(`m${i} gg on the results screen`),
        );
        await Promise.all(
          setups.map((s, i) =>
            s.bots[1].untilChat(new RegExp(`m${i} gg on the results`)),
          ),
        );
        await Promise.all(
          setups.flatMap((s) =>
            s.bots.map((b) => b.until((x) => !x.code, { timeout: 10000 })),
          ),
        );
        const groups = setups.map((s) => ({
          code: s.code,
          recs: s.bots.map((b) => b.records()),
        }));
        const v = C.checkIsolation(groups);
        for (const g of groups)
          v.push(
            ...C.checkChat(g.recs, { code: g.code }),
            ...C.checkLiveness(g.recs, { code: g.code }),
          );
        // The outsider never sees any match.
        if (outsider.snaps.some((s) => s.you?.matchCode || s.you?.chat || s.nb))
          v.push("outsider saw match data");
        // Not even the bootstrap handshake: the golf world takes none.
        if (outsider.other.length)
          v.push(
            `outsider got ${outsider.other.length} other messages: ${JSON.stringify(outsider.other.map((o) => o.msg)).slice(0, 300)}`,
          );
        for (const s of setups)
          for (const b of s.bots)
            if (b.chatLog(s.code).some((l) => /outsider/.test(l.text)))
              v.push(`${b.name} saw the outsider's chat`);
        C.assertClean(v, "isolation");
        const paths = setups.reduce(
          (n, s) => n + s.bots.reduce((m, b) => m + b.broadcasts.length, 0),
          0,
        );
        t.diagnostic(`${MATCHES} matches, ${paths} path frames relayed`);
        assert.ok(paths > 0);
      },
    );

    await t.test("nothing a player sends reaches another match", async () => {
      const a = await setupMatch(srv.url, ["A1", "A2"]);
      const b = await setupMatch(srv.url, ["B1", "B2"]);
      all.push(...a.bots, ...b.bots);
      const [a1] = a.bots;
      const [b1, b2] = b.bots;
      const from = b1.other.length;
      a1.send({ t: "action", typing: true });
      a1.send({ t: "d" });
      a1.send({ t: "gs" });
      a1.send({ t: "fb", x: 1, y: 2, z: 3, vx: 1e6, vy: 0, vz: 0 });
      await b1.nextSnapshot();
      await b1.nextSnapshot();
      await sleep(200);
      const got = [...b1.other.slice(from), ...b2.other]
        .map((o) => o.msg)
        .filter((m) => m && JSON.stringify(m).includes(a1.playerId));
      assert.deepEqual(
        got.map((m) => m.t),
        [],
        `match ${b.code} received ${got.length} message(s) from ${a1.name} in match ${a.code}: ${JSON.stringify(got.slice(0, 4))}`,
      );
      C.assertClean(
        C.checkIsolation([
          { code: a.code, recs: a.bots.map((x) => x.records()) },
          { code: b.code, recs: b.bots.map((x) => x.records()) },
        ]),
        "world relays",
      );
    });

    await t.test(
      "the same words said in two matches are not a leak",
      async () => {
        const a = await setupMatch(srv.url, ["Dave", "Sam"], { start: false });
        const b = await setupMatch(srv.url, ["Ann", "Bob"], { start: false });
        all.push(...a.bots, ...b.bots);
        a.bots[1].mchat("good game everyone");
        b.bots[1].mchat("good game everyone");
        await Promise.all(
          [...a.bots, ...b.bots].map((x) => x.untilChat(/good game everyone/)),
        );
        // Every line each bot got came from a member of its own match.
        for (const [g, other] of [
          [a, b],
          [b, a],
        ])
          for (const x of g.bots)
            for (const l of x.chatLog(g.code)) {
              assert.ok(!other.bots.some((o) => o.playerId === l.from));
              assert.ok(g.bots.some((o) => o.playerId === l.from));
            }
        assert.deepEqual(
          C.checkIsolation([
            { code: a.code, recs: a.bots.map((x) => x.records()) },
            { code: b.code, recs: b.bots.map((x) => x.records()) },
          ]),
          [],
        );
      },
    );
  },
);
