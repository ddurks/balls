// name.js — the one name a player goes by in the clubhouse, on a challenge
// link, on the course and on the leaderboard. No dependencies, so the title
// screen can read and set it before the rest of the page loads.
//
// Until the player picks one (ballsName, from the title screen), a default is
// made up once and kept (ballsGuestName): rolled per page, the challenger in
// the feed or a link turned out to be someone else on the course. Defaults
// are "ball" and three digits; an older made-up "Guest123" is replaced, since
// nobody picked it.
(function (global) {
  const MAX = 16;
  const OLD_DEFAULT = /^Guest\d{3}$/;
  let pageDefault = null; // storage blocked: at least one name per page

  function read(key) {
    try {
      return (global.localStorage?.getItem(key) || "").trim();
    } catch {
      return "";
    }
  }
  function write(key, value) {
    try {
      global.localStorage.setItem(key, value);
    } catch {}
  }

  /** The name the player picked, or "" if they haven't. */
  function chosen() {
    return read("ballsName");
  }

  function get() {
    const picked = chosen();
    if (picked) return picked;
    const kept = read("ballsGuestName");
    if (kept && !OLD_DEFAULT.test(kept)) return kept;
    if (!pageDefault)
      pageDefault =
        "ball" + String(Math.floor(Math.random() * 1000)).padStart(3, "0");
    write("ballsGuestName", pageDefault);
    return pageDefault;
  }

  /** Keeps `raw` (trimmed, at most MAX) as the player's name; blank keeps the default. Returns the name now in use. */
  function set(raw) {
    const name = String(raw ?? "")
      .trim()
      .slice(0, MAX)
      .trim();
    if (name) write("ballsName", name);
    return get();
  }

  const PlayerName = { get, set, chosen, MAX };
  Object.assign(global, { PlayerName });
  if (typeof module !== "undefined" && module.exports)
    module.exports = PlayerName;
})(/** @type {any} */ (typeof globalThis !== "undefined" ? globalThis : this));
