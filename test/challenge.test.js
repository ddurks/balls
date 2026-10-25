"use strict";
// Head-to-head challenge plumbing (src/shared/challenge.js): rendezvous key
// checks and the URLs that carry a challenge between pages.
const test = require("node:test");
const assert = require("node:assert");
const { URL, URLSearchParams } = require("node:url");
const Challenge = require("../src/shared/challenge.js");

const NOW = Date.UTC(2026, 9, 25, 12);
const local = (search) => ({ hostname: "localhost", search });
const prod = (search) => ({ hostname: "balls.drawvid.com", search });
// Same shape the clubhouse server mints: <mintedAt base36>.<22 base64url chars>
const keyAt = (t) => t.toString(36) + ".AbCdEfGhIjKlMnOpQrSt_-";
const KEY = keyAt(NOW);

test("challenge: reads the mint time off a well-formed key", () => {
  assert.strictEqual(Challenge.keyMintedAt(KEY), NOW);
  assert.ok(Challenge.isKey(KEY));
  for (const bad of [
    null,
    undefined,
    7,
    "",
    "nope",
    "ABCDEF.xxxxxxxxxxxxxxxxxxxxxx",
    KEY + "x",
    KEY.replace("_", "!"),
  ])
    assert.strictEqual(Challenge.isKey(bad), false, String(bad));
});

test("challenge: time left runs out at the server's 15 minute TTL", () => {
  assert.strictEqual(Challenge.RV_TTL_MS, 15 * 60 * 1000);
  assert.strictEqual(Challenge.keyTimeLeft(KEY, NOW), Challenge.RV_TTL_MS);
  assert.strictEqual(Challenge.keyTimeLeft(KEY, NOW + Challenge.RV_TTL_MS), 0);
  assert.strictEqual(Challenge.keyTimeLeft("junk", NOW), null);
});

test("challenge: the game URL carries the key and keeps local dev server overrides", () => {
  assert.strictEqual(
    Challenge.gameUrl(local(""), KEY),
    "game.html?mode=course&rv=" + encodeURIComponent(KEY),
  );
  const url = Challenge.gameUrl(
    local(
      "?ws=ws%3A%2F%2Flocalhost%3A7900&gws=ws%3A%2F%2Flocalhost%3A7901&room=vip&challenge=x",
    ),
    KEY,
  );
  const q = new URLSearchParams(url.split("?")[1]);
  assert.strictEqual(q.get("mode"), "course");
  assert.strictEqual(q.get("rv"), KEY);
  assert.strictEqual(q.get("ws"), "ws://localhost:7900");
  assert.strictEqual(q.get("gws"), "ws://localhost:7901");
  assert.strictEqual(q.has("room"), false);
  assert.strictEqual(q.has("challenge"), false);
});

test("challenge: a tap challenge's game URL names the opponent", () => {
  const q = new URLSearchParams(
    Challenge.gameUrl(local(""), KEY, "  Bob ").split("?")[1],
  );
  assert.strictEqual(q.get("vs"), "Bob");
  assert.strictEqual(q.get("rv"), KEY);
});

test("challenge: back-to-clubhouse URL keeps only the dev overrides", () => {
  assert.strictEqual(Challenge.clubhouseUrl(local("")), "index.html");
  assert.strictEqual(
    Challenge.clubhouseUrl(local("?mode=course&rv=k&gws=ws%3A%2F%2Fh%3A1")),
    "index.html?gws=ws%3A%2F%2Fh%3A1",
  );
});

test("challenge: server overrides count on dev hosts only", () => {
  for (const h of [
    "localhost",
    "127.0.0.1",
    "[::1]",
    "",
    "192.168.1.20",
    "10.0.0.7",
    "172.20.1.1",
    "mac-mini.local",
  ])
    assert.ok(Challenge.isDevHost(h), h);
  for (const h of [
    "balls.drawvid.com",
    "172.32.0.1",
    "8.8.8.8",
    "evil.example",
  ])
    assert.ok(!Challenge.isDevHost(h), h);
  const q = "?ws=ws%3A%2F%2Fh%3A1";
  assert.strictEqual(Challenge.serverOverride(local(q), "ws"), "ws://h:1");
  assert.strictEqual(Challenge.serverOverride(prod(q), "ws"), null);
  assert.strictEqual(Challenge.serverOverride(local(""), "ws"), null);
  assert.strictEqual(
    Challenge.serverOverride(
      { origin: "http://192.168.1.20:3000", search: q },
      "ws",
    ),
    "ws://h:1",
  );
});

// A crafted "?challenge=K&from=Bob&ws=wss://evil&gws=wss://evil" link on the
// public site used to point the friend's sockets at another server, keep it
// through Accept and Decline, and hand it on in every link they sent.
test("challenge: on the public site a link's server overrides go nowhere", () => {
  const EVIL = encodeURIComponent("wss://evil.example");
  const opened = {
    origin: "https://balls.drawvid.com",
    pathname: "/index.html",
    search: `?challenge=${KEY}&from=Bob&ws=${EVIL}&gws=${EVIL}`,
  };
  const shared = new URL(Challenge.linkUrl(opened, KEY, "Vic"));
  assert.strictEqual(shared.searchParams.has("ws"), false);
  assert.strictEqual(shared.searchParams.has("gws"), false);
  const game = new URLSearchParams(
    Challenge.gameUrl(opened, KEY).split("?")[1],
  );
  assert.strictEqual(game.has("ws") || game.has("gws"), false);
  assert.strictEqual(Challenge.clubhouseUrl(opened), "index.html");
  assert.strictEqual(Challenge.stripLink(opened), "");
});

test("challenge: share links are absolute, beside the current page, and round-trip", () => {
  const loc = {
    origin: "https://balls.drawvid.com",
    pathname: "/index.html",
    search: "",
  };
  const url = Challenge.linkUrl(loc, KEY, "  Dave  the   Great ");
  assert.strictEqual(
    url,
    "https://balls.drawvid.com/index.html?challenge=" +
      encodeURIComponent(KEY) +
      "&from=Dave+the+Great",
  );

  const local = Challenge.linkUrl(
    {
      origin: "http://localhost:3000",
      pathname: "/sub/dir/index.html",
      search: "?ws=ws%3A%2F%2Flocalhost%3A7900&room=vip",
    }, // no hostname: read off the origin
    KEY,
    "Sam",
  );
  const u = new URL(local);
  assert.strictEqual(
    u.origin + u.pathname,
    "http://localhost:3000/sub/dir/index.html",
  );
  assert.strictEqual(u.searchParams.get("ws"), "ws://localhost:7900");
  assert.strictEqual(u.searchParams.has("room"), false);

  const link = Challenge.parseLink(u.search, NOW + 1000);
  assert.deepStrictEqual(link, {
    key: KEY,
    from: "Sam",
    valid: true,
    expired: false,
  });
});

test("challenge: parseLink flags broken and expired links, and ignores ordinary visits", () => {
  assert.strictEqual(Challenge.parseLink("", NOW), null);
  assert.strictEqual(Challenge.parseLink("?room=vip", NOW), null);
  assert.deepStrictEqual(Challenge.parseLink("?challenge=lol&from=x", NOW), {
    key: "lol",
    from: "x",
    valid: false,
    expired: false,
  });
  const stale = Challenge.parseLink(
    "?challenge=" + encodeURIComponent(KEY),
    NOW + Challenge.RV_TTL_MS + 1,
  );
  assert.strictEqual(stale.expired, true);
  assert.strictEqual(stale.from, "A friend"); // no `from`: still reads as a sentence
});

test("challenge: names from links are trimmed, capped and never empty", () => {
  assert.strictEqual(Challenge.cleanName("x".repeat(80)), "x".repeat(24));
  assert.strictEqual(Challenge.cleanName("   "), "A friend");
  assert.strictEqual(Challenge.cleanName(null), "A friend");
  assert.strictEqual(Challenge.cleanName("a\n\tb"), "a b");
  // cut on code points: an emoji is never split into a lone surrogate
  const name = Challenge.cleanName("😀".repeat(30));
  assert.strictEqual(Array.from(name).length, 24);
  assert.ok(!/[\ud800-\udbff]$/.test(name));
});

test("challenge: stripLink drops only the link params", () => {
  assert.strictEqual(Challenge.stripLink(local("?challenge=k&from=Dave")), "");
  assert.strictEqual(
    Challenge.stripLink(local("?ws=a&challenge=k&from=Dave&gws=b")),
    "?ws=a&gws=b",
  );
  assert.strictEqual(Challenge.stripLink(local("")), "");
  assert.strictEqual(Challenge.stripLink(prod("?room=vip&ws=a")), "?room=vip");
});
