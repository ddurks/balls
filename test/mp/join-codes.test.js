// Contracts 8 and 9 (a lobby's chat never leaks outside its match): a 4-letter
// join code is all that keeps a lobby private, and a joiner is handed its
// whole chat log. One client used to try all 32^4 codes in under a minute (no
// limit on join), walk into every open lobby and read its chat. Now a join
// that doesn't get a client in spends one of its address's five tries, which
// come back one a second: the same sweep takes twelve days.
//
// A spy on an address of its own sweeps codes as fast as the server answers,
// then tries the codes of a dozen real lobbies; more connections from the same
// address get no fresh tries; an invited friend on another address joins at
// once.
// Run: node --test test/mp/join-codes.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const { setTimeout } = require("node:timers");
const { startGolfServer } = require("./server.js");
const { Bot, setupMatch } = require("./bot.js");

const LOBBIES = 12;
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const SPY = "203.0.113.66";
const FRIEND = "198.51.100.7";
const TOO_MANY = "Too many tries, wait a moment";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const codeAt = (i) => {
  let s = "";
  for (let k = 0; k < 4; k++) {
    s = ALPHABET[i % 32] + s;
    i = Math.floor(i / 32);
  }
  return s;
};

test(
  "join codes can't be swept to read private lobbies",
  { timeout: 120000 },
  async (t) => {
    const srv = await startGolfServer();
    const all = [];
    t.after(async () => {
      for (const b of all) b.close();
      await srv.stop();
    });
    const mk = async (name, address) => {
      const b = new Bot(srv.url, name, { address });
      await b.connect();
      all.push(b);
      return b;
    };

    // Invite-only lobbies, each with a line its host typed while waiting.
    const lobbies = [];
    for (let i = 0; i < LOBBIES; i++) {
      const st = await setupMatch(srv.url, [`Host${i}`, `Guest${i}`], {
        start: false,
      });
      all.push(...st.bots);
      st.bots[0].mchat(`secret ${i}: meet at the ninth`);
      lobbies.push(st.code);
    }
    await sleep(300);
    const live = new Set(lobbies);

    const spy = await mk("Spy", SPY);
    let pongs = 0;
    spy.ws.on("message", (d) => {
      if (String(d).includes('"pong"')) pongs++;
    });
    // A ping is answered in order: its pong means every join before it is done.
    const settle = async (n) => {
      spy.send({ t: "ping" });
      await spy.until(() => pongs >= n, { timeout: 60000, label: "pong" });
    };

    await t.test(
      "a burst of codes, then the real ones, gets nowhere",
      async () => {
        // Fewer than the thousand frames that would get the connection
        // dropped as a flood (frame-flood.test.js); read 100 a second.
        const wrong = [];
        for (let i = 0; wrong.length < 900; i++)
          if (!live.has(codeAt(i))) wrong.push(codeAt(i));
        for (const c of wrong) spy.join(c);
        await settle(1);
        for (const c of lobbies) spy.join(c);
        await settle(2);
        await spy.nextSnapshot();
        assert.equal(spy.code, null);
        assert.deepEqual([...spy.chat.keys()], []);
        assert.equal(spy.notices.at(-1).text, TOO_MANY);
      },
    );

    await t.test(
      "past its first tries, one lookup a second: days for the code space",
      async () => {
        // A wrong code four times a second, each answer read before the next.
        let looked = 0;
        let refused = 0;
        const t0 = Date.now();
        for (let i = 0; i < 24; i++) {
          const n = spy.notices.length;
          spy.join("ZZZZ" === lobbies[0] ? "YYYY" : "ZZZZ");
          const notice = await spy.until(() => spy.notices[n], {
            label: "an answer",
          });
          if (notice.text === TOO_MANY) refused++;
          else looked++;
          await sleep(250);
        }
        const secs = (Date.now() - t0) / 1000;
        const days = 32 ** 4 / (looked / secs) / 86400;
        t.diagnostic(
          `${looked} lookups, ${refused} refused in ${secs.toFixed(1)} s: ${days.toFixed(1)} days for every code`,
        );
        assert.ok(looked <= secs + 1, `${looked} lookups in ${secs} s`);
        assert.ok(days > 7, `a sweep would take ${days.toFixed(1)} days`);
        assert.equal(spy.code, null);
      },
    );

    await t.test(
      "another connection from the spy's address gets no fresh tries",
      async () => {
        const spy2 = await mk("Spy2", SPY);
        let pongs2 = 0;
        spy2.ws.on("message", (d) => {
          if (String(d).includes('"pong"')) pongs2++;
        });
        // Fresh tries would look up these three wrong codes and still let the
        // real one in. The address's own budget refills while the spy waits,
        // so it may have one try back: the first may be looked up, no more.
        for (const c of ["ZZZZ", "YYYY", "XXXX"].filter((x) => !live.has(x)))
          spy2.join(c);
        spy2.join(lobbies[0]);
        spy2.send({ t: "ping" });
        await spy2.until(() => pongs2 >= 1, { label: "pong" });
        await spy2.nextSnapshot();
        assert.equal(spy2.code, null);
        assert.equal(spy2.notices.at(-1).text, TOO_MANY);
      },
    );

    await t.test(
      "an invited friend on another address joins at once",
      async () => {
        const friend = await mk("Friend", FRIEND);
        friend.join(lobbies[0]);
        await friend.untilMatch();
        const line = await friend.untilChat(/^secret 0/);
        assert.equal(line.text, "secret 0: meet at the ninth");
      },
    );
  },
);
