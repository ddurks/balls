// challenge.js — head-to-head challenge plumbing shared by the clubhouse
// (sending / receiving challenges, the wall phone's share link) and the game
// page (meeting the opponent on the golf server).
//
// A challenge resolves to a rendezvous key minted by the clubhouse server
// (drawvidverse worldserver, games/golf/rendezvous.ts): "<mintedAt base36>.<22
// base64url chars>". Both players open game.html?mode=course&rv=KEY and the
// golf server pairs them (a clubhouse challenge adds &vs=NAME, the opponent who
// was in the room a moment ago). A shared link is
// index.html?challenge=KEY&from=NAME.
//
// Pure string/URL logic only, so it stays require()-able for node tests.
(function (global) {
  // Mirrors RV_TTL_MS on the golf server, which is what actually enforces it;
  // the client only uses it to say "expired" up front instead of making a
  // friend wait on a dead link.
  const RV_TTL_MS = 15 * 60 * 1000;
  const KEY_RE = /^([0-9a-z]{6,12})\.([A-Za-z0-9_-]{22})$/;
  const NAME_MAX = 24;
  // Local-dev server overrides (clubhouse and golf sockets) that must survive
  // the hop between pages. Honoured on dev hosts only: on the public site a
  // crafted challenge link could otherwise point a friend's sockets (name,
  // drawn face, chat) at someone else's server, and pass that on in every
  // link they send.
  const DEV_PARAMS = ["ws", "gws"];

  // localhost, a LAN test box (phones on the dev machine's wifi), or file:.
  function isDevHost(hostname) {
    const h = String(hostname || "").toLowerCase();
    return (
      h === "" ||
      h === "localhost" ||
      h === "[::1]" ||
      h.endsWith(".local") ||
      /^127\./.test(h) ||
      /^10\./.test(h) ||
      /^192\.168\./.test(h) ||
      /^172\.(1[6-9]|2\d|3[01])\./.test(h)
    );
  }

  function hostOf(loc) {
    if (loc.hostname != null) return loc.hostname;
    return String(loc.origin || "")
      .replace(/^[a-z][a-z0-9+.-]*:\/\//i, "")
      .replace(/:\d+$/, "");
  }

  // A ws/gws server override on this page, or null (none, or not a dev host).
  function serverOverride(loc, name) {
    if (!isDevHost(hostOf(loc))) return null;
    return new URLSearchParams(loc.search || "").get(name) || null;
  }

  function keyMintedAt(key) {
    const m = typeof key === "string" ? KEY_RE.exec(key) : null;
    return m ? parseInt(m[1], 36) : null;
  }

  function isKey(key) {
    return keyMintedAt(key) !== null;
  }

  // Milliseconds of life left (<= 0 once expired); null for a malformed key.
  function keyTimeLeft(key, now) {
    const t = keyMintedAt(key);
    return t === null ? null : t + RV_TTL_MS - now;
  }

  function cleanName(raw) {
    const s = Array.from(
      String(raw || "")
        .replace(/\s+/g, " ")
        .trim(),
    )
      .slice(0, NAME_MAX)
      .join("")
      .trim();
    return s || "A friend";
  }

  function withDev(loc, into) {
    for (const k of DEV_PARAMS) {
      const v = serverOverride(loc, k);
      if (v) into.set(k, v);
    }
    return into;
  }

  // game.html URL both challengers navigate to. `vs`: the opponent of a
  // clubhouse challenge (both were in the room seconds ago, so the course
  // needn't wait long for them).
  function gameUrl(loc, key, vs) {
    const q = new URLSearchParams({ mode: "course", rv: String(key) });
    if (vs != null) q.set("vs", cleanName(vs));
    return "game.html?" + withDev(loc, q).toString();
  }

  function clubhouseUrl(loc) {
    const q = withDev(loc, new URLSearchParams()).toString();
    return "index.html" + (q ? "?" + q : "");
  }

  // Absolute, shareable link (works on localhost too): same directory as the
  // current page, landing in the clubhouse.
  function linkUrl(loc, key, name) {
    const dir = String(loc.pathname || "/").replace(/[^/]*$/, "");
    const q = new URLSearchParams({
      challenge: String(key),
      from: cleanName(name),
    });
    withDev(loc, q);
    return loc.origin + dir + "index.html?" + q.toString();
  }

  // An incoming challenge link, or null when the page wasn't opened from one.
  function parseLink(search, now) {
    const q = new URLSearchParams(search || "");
    if (!q.has("challenge")) return null;
    const key = q.get("challenge");
    const from = cleanName(q.get("from"));
    const left = keyTimeLeft(key, now);
    return {
      key,
      from,
      valid: left !== null,
      expired: left !== null && left <= 0,
    };
  }

  // This page's query minus the link params, so a reload (or a decline)
  // doesn't prompt again; off a dev host, minus any server override the link
  // brought along too.
  function stripLink(loc) {
    const q = new URLSearchParams(loc.search || "");
    q.delete("challenge");
    q.delete("from");
    if (!isDevHost(hostOf(loc))) for (const k of DEV_PARAMS) q.delete(k);
    const s = q.toString();
    return s ? "?" + s : "";
  }

  const Challenge = {
    RV_TTL_MS,
    keyMintedAt,
    isKey,
    keyTimeLeft,
    cleanName,
    isDevHost,
    serverOverride,
    gameUrl,
    clubhouseUrl,
    linkUrl,
    parseLink,
    stripLink,
  };
  global.Challenge = Challenge;
  if (typeof module !== "undefined" && module.exports)
    module.exports = Challenge;
})(/** @type {any} */ (typeof globalThis !== "undefined" ? globalThis : this));
