// challenges.js — the clubhouse side of head-to-head challenges: tap a player
// to challenge them, answer someone's challenge, text a link from the wall
// phone, open a friend's link. The server relays (drawvidverse worldserver,
// games/clubhouse/engine.ts); every challenge message reaching us is ours.
//
// Apart from clubhouse.js (which owns the room, the portraits and the socket)
// so the races between taps and server answers can be tested in node.
//
//   const ch = ClubChallenges.create({
//     net,         // ClubhouseNet: challenge sends, playerId, offline, clockSkew
//     token,       // this tab's random number (see connected())
//     splash,      // Splash
//     hint,        // (text) => a brief toast
//     nameOf,      // (playerId) => name, or undefined if they're not here
//     portraits,   // {player(id), link(), phone()} -> Promise<dataURL | null>
//     myName,
//     myMatches,   // () => Promise<[{id, vs, myTurn, hole, status, finished}]>
//     goToCourse,  // (url) => leave the room for game.html
//     storage,     // localStorage: the keys of this browser's own links
//     location, history, navigator,
//   });
//   ch.tapPlayer(id); ch.tapPhone(); ch.onMessage(broadcast);
//   ch.connected();  // on every welcome
//   ch.snapshot();   // on every snapshot, before its broadcasts
//   ch.start();      // once the room is up
//
// Plain <script> (exposes window.ClubChallenges; needs window.Challenge).
(function (global) {
  const MSGS = new Set([
    "challenge",
    "challengeSent",
    "challengeGo",
    "challengeEnd",
    "challengeLink",
  ]);
  // The server expires a pending challenge after 30 s. If its word never
  // comes (a socket that dropped and redialed), ours lapses a bit later.
  const LAPSE_MS = 35000;
  // How long a go is still honoured for a challenge whose splash is gone (we
  // called it off, or our socket dropped while it was pending): the server
  // re-sends a go to this tab for as long after a reconnect.
  const GO_HONOUR_MS = 60000;
  // The phone's last minted key is reused when it's picked up again soon:
  // peeking at the phone mustn't cost a mint (and the rate limit) each time.
  const LINK_REUSE_MS = 2 * 60 * 1000;
  // How long a challenge link waits for the server's clock before falling
  // back on this device's.
  const LINK_CLOCK_WAIT_MS = 4000;
  // A second Send link press while a share sheet is still opening (a double
  // tap) is ignored for this long. Not until the sheet settles: a promise
  // that never settles would leave the button dead.
  const SHARE_PRESS_MS = 3000;
  // Keys of links this browser minted, newest last, shared by all its tabs:
  // a share often lands in your own chat thread, and accepting your own link
  // there paired the waiting tab with the new one and spent the friend's key.
  const MINE_KEY = "ballsMyLinks";
  const MINE_MAX = 20;

  const END_TEXT = {
    declined: (n) => `${n} declined`,
    cancelled: (n) => `${n} called it off`,
    left: (n) => `${n} left`,
    busy: (n) => `${n} is busy`,
    gone: (n) => `${n} isn't here`,
    slow: () => "Slow down a sec",
    later: (n) => `Give ${n} a minute`,
  };

  function create(env) {
    const { net, splash: Splash, hint } = env;
    const Challenge = global.Challenge;

    // chal is the one challenge this client is dealing with, or null:
    //   ask      confirm splash up, nothing sent yet
    //   wait     sent; waiting for them (id arrives with challengeSent)
    //   incoming they challenged us
    //   phone    wall-phone link (key pre-minted while the splash is up)
    //   link     we opened someone's challenge link
    //   go       on our way to the course
    /** @type {any} */
    let chal = null;
    // Challenge and link requests are numbered; the server echoes the number
    // on its answer, so the answer to a request we've since withdrawn can't be
    // taken for the current one's (Confirm, Cancel, Confirm inside one RTT).
    let reqSeq = 0;
    // Challenges whose splash is gone but whose go we still act on:
    // id -> {name, title}. A cancel can cross the target's accept on the wire,
    // and a socket can drop just as the other side accepts (the server re-sends
    // that go once we're back). Either way they're off to the course, so we go
    // too rather than leave them there alone.
    const stillOn = new Map();
    // Whether the server has us down as busy (see syncBusy).
    let busySent = false;
    let linkKey = null; // {key, at}
    let linkReq = 0; // tag of the link request in flight, 0 if none
    let lastPlayerId = null;
    // A challenge link's expiry is judged on the server's clock (keys carry
    // the server's mint time; this device's clock can be minutes off), so its
    // splash waits for the first snapshot.
    let linkPending = !!Challenge.parseLink(env.location.search, Date.now());

    // Splash up at once; the portrait drops in when it's rendered.
    function challengeSplash(opts, portrait) {
      const s = Splash.show({ image: null, ...opts });
      portrait.then((url) => {
        if (url && !s.closed && !s.bare) s.update({ image: url });
      });
      return s;
    }

    function setChal(c) {
      chal = c;
      syncBusy();
    }

    function myLinks() {
      try {
        const keys = JSON.parse(env.storage.getItem(MINE_KEY) || "[]");
        return Array.isArray(keys) ? keys : [];
      } catch {
        return [];
      }
    }

    function markMine(key) {
      const keys = myLinks().filter((k) => k !== key);
      keys.push(key);
      try {
        env.storage.setItem(MINE_KEY, JSON.stringify(keys.slice(-MINE_MAX)));
      } catch {}
    }

    // A friend's link offer or the wall phone is our own flow: a tap
    // challenge popping over it would throw it away, so the server refuses
    // those as busy for as long as one is up.
    function syncBusy() {
      const busy = !!chal && (chal.kind === "link" || chal.kind === "phone");
      if (busy === busySent) return;
      busySent = busy;
      net.setChallengeBusy(busy);
    }

    function endChallenge(text) {
      if (chal && chal.splash) chal.splash.close();
      setChal(null);
      if (text) hint(text);
    }

    function lapseLater(c, text) {
      setTimeout(() => chal === c && endChallenge(text), LAPSE_MS);
    }

    function keepOn(id, name, title) {
      stillOn.set(id, { name, title });
      setTimeout(() => stillOn.delete(id), GO_HONOUR_MS);
    }

    function callOff(id, name) {
      keepOn(id, name, `${name} accepted first! Teeing it up…`);
      net.cancelChallenge(id);
    }

    function online() {
      if (net.playerId && !net.offline) return true;
      hint("Not connected to the clubhouse");
      return false;
    }

    // `vs`: the opponent of a tap challenge (see Challenge.gameUrl).
    function leaveForCourse(key, vs, title = "Teeing it up…") {
      setChal({ kind: "go", splash: chal && chal.splash });
      if (chal.splash)
        chal.splash.update({ title, detail: "", field: "", buttons: [] });
      env.goToCourse(Challenge.gameUrl(env.location, key, vs));
    }

    function tapPlayer(id) {
      const name = env.nameOf(id);
      if (chal || name === undefined || !online()) return;
      setChal({ kind: "ask", peerId: id, name });
      chal.splash = challengeSplash(
        {
          title: `Challenge ${name}?`,
          buttons: [
            {
              label: "Confirm",
              kind: "go",
              onClick: (s) => {
                const req = ++reqSeq;
                net.sendChallenge(id, req);
                const c = {
                  kind: "wait",
                  peerId: id,
                  name,
                  id: null,
                  req,
                  splash: s,
                };
                setChal(c);
                lapseLater(c, `${name} didn't answer`);
                s.update({
                  title: `Waiting for ${name}…`,
                  buttons: [
                    {
                      label: "Cancel",
                      kind: "stop",
                      cancel: true,
                      onClick: () => {
                        // no id yet: the late challengeSent gets called off on arrival
                        if (c.id) callOff(c.id, name);
                        endChallenge();
                      },
                    },
                  ],
                });
              },
            },
            {
              label: "Cancel",
              kind: "stop",
              cancel: true,
              onClick: () => endChallenge(),
            },
          ],
        },
        env.portraits.player(id),
      );
    }

    function tapPhone() {
      if (chal || !online()) return;
      const reuse = linkKey && Date.now() - linkKey.at < LINK_REUSE_MS;
      setChal({
        kind: "phone",
        key: reuse ? linkKey.key : null,
        shareWhenReady: false,
      });
      // Minted now so Send can share inside the tap itself: share sheets and
      // clipboard writes need a fresh user gesture, a server round-trip later
      // can lose it.
      if (!chal.key) {
        if (!linkReq) {
          linkReq = ++reqSeq;
          net.requestChallengeLink(linkReq);
        }
        chal.req = linkReq;
      }
      chal.splash = challengeSplash(
        {
          title: "Challenge a friend?",
          detail: "Text them a link to play you head-to-head",
          buttons: [
            {
              label: "Send link",
              kind: "go",
              onClick: () => {
                if (chal.key) shareLink(chal.key);
                else chal.shareWhenReady = true;
              },
            },
            { label: "Matches", kind: "go", onClick: showMatches },
            {
              label: "Cancel",
              kind: "stop",
              cancel: true,
              onClick: () => endChallenge(),
            },
          ],
        },
        env.portraits.phone(),
      );
    }

    // The wall phone's "Your matches": started matches (the golf server finds
    // them by this browser's token) and whose turn it is; a tap goes back in.
    function showMatches() {
      const phone = chal;
      const s = phone.splash;
      s.update({
        title: "Your matches",
        image: undefined,
        detail: "Looking…",
        buttons: [
          {
            label: "Close",
            kind: "stop",
            cancel: true,
            onClick: () => endChallenge(),
          },
        ],
      });
      env.myMatches().then(
        (matches) => {
          if (chal !== phone) return;
          s.update({
            detail: matches.length ? "" : "No matches yet",
            list: matches.map((m) => ({
              label:
                `vs ${m.vs} · ` +
                (m.finished
                  ? m.status
                  : `${m.myTurn ? "your" : "their"} turn, hole ${m.hole}`),
              hot: m.myTurn,
              onClick: () => {
                setChal({ kind: "go", splash: s });
                s.update({
                  title: "Teeing it up…",
                  detail: "",
                  list: [],
                  buttons: [],
                });
                env.goToCourse(Challenge.matchUrl(env.location, m.id));
              },
            })),
          });
        },
        () => chal === phone && s.update({ detail: "Can't reach the course" }),
      );
    }

    function shareLink(key) {
      const phone = chal;
      if (Date.now() - (phone.sharedAt || 0) < SHARE_PRESS_MS) return;
      const url = Challenge.linkUrl(env.location, key, env.myName);
      const s = phone.splash;
      // On the way to the course from here: the splash stays up until the hop,
      // so a tap meant for the room (a door) can't take us somewhere else.
      const copied = () => {
        if (chal !== phone) return; // put down while the clipboard was busy
        setChal({ kind: "go", splash: s });
        s.update({
          title: "Challenge link copied!",
          detail: "Send it to a friend",
          field: "",
          buttons: [],
        });
        setTimeout(() => leaveForCourse(key), 1500);
      };
      // The clipboard said no: show the link in a field to copy by hand, at a
      // size a phone can read (the portrait makes room for it).
      const showLink = () => {
        if (chal !== phone) return;
        s.bare = true;
        s.update({
          title: "Copy this link",
          image: undefined,
          detail: "",
          field: url,
          buttons: [
            {
              label: "Go wait",
              kind: "go",
              onClick: () => leaveForCourse(key),
            },
            {
              label: "Cancel",
              kind: "stop",
              cancel: true,
              onClick: () => endChallenge(),
            },
          ],
        });
      };
      const nav = env.navigator;
      const copy = () => {
        if (nav.clipboard && nav.clipboard.writeText)
          nav.clipboard.writeText(url).then(copied, showLink);
        else showLink();
      };
      if (!nav.share) return copy();
      phone.sharedAt = Date.now();
      nav
        .share({
          title: "Balls Golf",
          text: `${env.myName} challenged you to a round of Balls Golf!`,
          url,
        })
        .then(
          () => leaveForCourse(key),
          (e) => {
            phone.sharedAt = 0;
            // AbortError: they closed the share sheet. InvalidStateError: one
            // was already open. Either way the splash stays up; anything else
            // means sharing doesn't work here, so copy instead.
            const name = e && e.name;
            if (name !== "AbortError" && name !== "InvalidStateError") copy();
          },
        );
    }

    function openPendingLink() {
      if (!linkPending) return;
      linkPending = false;
      const skew = net.clockSkew == null ? 0 : net.clockSkew;
      openLink(Challenge.parseLink(env.location.search, Date.now() + skew));
    }

    function openLink(link) {
      // A used (or declined) link mustn't prompt again on a reload or Back.
      const strip = () =>
        env.history.replaceState(
          null,
          "",
          env.location.pathname +
            Challenge.stripLink(env.location) +
            env.location.hash,
        );
      const ok = [
        {
          label: "OK",
          kind: "go",
          cancel: true,
          onClick: () => {
            strip();
            endChallenge();
          },
        },
      ];
      setChal({ kind: "link" });
      if (!link.valid || link.expired) {
        chal.splash = Splash.show({
          title: link.valid
            ? `${link.from}'s challenge expired`
            : "That challenge link is broken",
          buttons: ok,
        });
        return;
      }
      if (myLinks().includes(link.key)) {
        chal.splash = Splash.show({
          title: "That's your own challenge link",
          detail: "Send it to a friend to play them",
          buttons: ok,
        });
        return;
      }
      chal.splash = challengeSplash(
        {
          title: `${link.from} challenged you. Accept?`,
          buttons: [
            {
              label: "Accept",
              kind: "go",
              onClick: () => {
                strip();
                leaveForCourse(link.key);
              },
            },
            {
              label: "Decline",
              kind: "stop",
              cancel: true,
              onClick: () => {
                strip();
                endChallenge();
              },
            },
          ],
        },
        env.portraits.link(),
      );
    }

    function incoming(d) {
      if (chal && ["go", "link", "phone"].includes(chal.kind)) {
        // Sent before our challengeBusy landed (or we're on our way out).
        net.replyChallenge(d.id, "busy");
        return;
      }
      if (chal && chal.splash) chal.splash.close();
      const name = d.fromName;
      const c = { kind: "incoming", id: d.id, peerId: d.fromId, name };
      setChal(c);
      lapseLater(c, "Challenge expired");
      c.splash = challengeSplash(
        {
          title: `${name} challenged you. Accept?`,
          // unasked-for: the key the player was about to press mustn't answer it
          focus: false,
          buttons: [
            {
              label: "Accept",
              kind: "go",
              onClick: (s) => {
                net.replyChallenge(d.id, true);
                c.accepted = true;
                s.update({ title: "Teeing it up…", buttons: [] });
                // the server always answers (go or expired); this only
                // covers a socket that died in between, whose go may yet
                // come once it's back
                setTimeout(() => {
                  if (chal !== c) return;
                  keepOn(c.id, name, "Teeing it up…");
                  endChallenge("Lost the clubhouse connection");
                }, 8000);
              },
            },
            {
              label: "Decline",
              kind: "stop",
              cancel: true,
              onClick: () => {
                net.replyChallenge(d.id, false);
                endChallenge();
              },
            },
          ],
        },
        env.portraits.player(d.fromId),
      );
    }

    function onMessage(b) {
      if (!MSGS.has(b.type)) return false;
      const d = b.data || {};
      if (b.type === "challengeSent") {
        if (chal && chal.kind === "wait" && chal.req === d.req) chal.id = d.id;
        else callOff(d.id, d.toName); // we backed out before it landed
      } else if (b.type === "challenge") {
        incoming(d);
      } else if (b.type === "challengeGo") {
        if (!Challenge.isKey(d.rv) || (chal && chal.kind === "go")) return true;
        if (chal && chal.id === d.id) leaveForCourse(d.rv, chal.name);
        else if (stillOn.has(d.id)) {
          // The match is on after all (see stillOn), so go.
          const { name, title } = stillOn.get(d.id);
          stillOn.delete(d.id);
          if (chal && chal.splash) chal.splash.close();
          setChal({ kind: "go", splash: Splash.show({ focus: false }) });
          leaveForCourse(d.rv, name, title);
        }
      } else if (b.type === "challengeEnd") {
        if (!d.id && d.req !== undefined && d.req === linkReq) linkReq = 0;
        if (!chal) return true;
        const ours = d.id
          ? chal.id === d.id
          : d.req !== undefined && chal.req === d.req;
        if (!ours) return true;
        const n = chal.name;
        endChallenge(
          d.reason === "expired"
            ? chal.kind === "wait"
              ? `${n} didn't answer`
              : "Challenge expired"
            : (END_TEXT[d.reason] || (() => "Challenge over"))(n),
        );
      } else if (b.type === "challengeLink") {
        if (d.req === linkReq) linkReq = 0;
        if (!Challenge.isKey(d.rv)) return true;
        linkKey = { key: d.rv, at: Date.now() };
        markMine(d.rv);
        if (chal && chal.kind === "phone" && !chal.key) {
          chal.key = d.rv;
          if (chal.shareWhenReady) shareLink(chal.key);
        }
      }
      return true;
    }

    // A fresh connection is a fresh player id: whatever was pending on the
    // old one died with it on the server, except an accept that got there
    // first. The server re-sends that go to this tab's token.
    function connected() {
      net.resume(env.token);
      busySent = false; // that lived on the old connection too
      syncBusy();
      const lost = lastPlayerId && lastPlayerId !== net.playerId;
      lastPlayerId = net.playerId;
      if (!lost) return;
      linkReq = 0;
      if (!chal) return;
      if (chal.kind === "wait" || chal.kind === "incoming") {
        if (chal.id && (chal.kind === "wait" || chal.accepted))
          keepOn(
            chal.id,
            chal.name,
            chal.kind === "wait"
              ? `${chal.name} accepted! Teeing it up…`
              : "Teeing it up…",
          );
        endChallenge("Lost the clubhouse connection");
      } else if (chal.kind === "phone" && !chal.key) {
        linkReq = ++reqSeq;
        chal.req = linkReq;
        net.requestChallengeLink(linkReq);
      }
    }

    function snapshot() {
      if (linkPending && net.clockSkew != null) openPendingLink();
    }

    // Opened from a friend's link (index.html?challenge=KEY&from=NAME)?
    function start() {
      if (!linkPending) return;
      setChal({ kind: "link" });
      setTimeout(openPendingLink, LINK_CLOCK_WAIT_MS);
    }

    return {
      tapPlayer,
      tapPhone,
      onMessage,
      connected,
      snapshot,
      start,
      get state() {
        return chal;
      },
      // Committed to the course: the room mustn't send us anywhere else.
      get leaving() {
        return !!chal && chal.kind === "go";
      },
    };
  }

  const ClubChallenges = { create, LAPSE_MS, LINK_REUSE_MS, GO_HONOUR_MS };
  global.ClubChallenges = ClubChallenges;
  if (typeof module !== "undefined" && module.exports)
    module.exports = ClubChallenges;
})(/** @type {any} */ (typeof globalThis !== "undefined" ? globalThis : this));
