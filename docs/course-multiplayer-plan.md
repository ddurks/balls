# Course Multiplayer — Plan

Networked golf rounds on the course: **up to 4 players playing together**, with a
**chat feed scoped to just the current game**. Draft plan to build from next time.

## Head start

The course is **already turn-based** (`src/game/course.js` `CourseManager`:
`players[]`, `currentPlayer`, `beginTurn`, `advance`, per-hole `scores`, a random
pin per hole). So this is a **networked turn-based match, not real-time physics
sync** — much easier. The clubhouse already proves the whole transport: the
drawvidverse `worldserver` (WS, 12 Hz snapshot + `broadcast` + `action` protocol),
the `ClubhouseNet` client, and presence/chat/style sync.

## Architecture

- **Server** — a new `golf` game plugin in `../drawvidverse/worldserver/src/games/`
  (beside `clubhouse`), implementing `IGameLogic`. It owns **matches** (rooms of
  ≤4) and is the **authority** for: the shared pin per hole, whose turn it is, and
  scoring. Match state: players, tee order, hole index, pin-per-hole, each player's
  lie/strokes/scores, phase (`lobby` / `playing` / `hole-review` / `finished`).
- **Client** — a `GolfNet` (mirror of `ClubhouseNet`) + a `MatchCoordinator` that
  drives `CourseManager` from **server** state instead of the local hot-seat loop.

## Sync model (the crux)

Havok physics is **not deterministic across machines**, so **don't replay physics
remotely**. Only the **active player** simulates their shot locally. On rest /
hole-out they send the **outcome**: `{ launch: {club, power, spinX, aimDir},
restPos, holedOut, strokes }`.

- **Spectators** fly the ball using the game's **existing deterministic trajectory
  solver** (the aim-preview integrator in `src/game/input.js`) for a plausible arc,
  then **snap to `restPos`**. Robust, cheap, no desync.
- The **server** validates + advances the turn.
- Remote players render as **gball avatars with each player's locker style**
  (reuse `BallsStyle` + the clubhouse avatar rig) sitting at their lie.

## Match lifecycle

1. **Lobby** — one player **creates a match** → short **join code**; up to 3 others
   join → everyone **readies up** → host starts.
2. **Play** — server sends each hole's config incl. **the shared pin index**;
   clients `loadHole()` with it (today each client randomizes the pin — that must
   become server-authoritative). Turn order announced.
3. **Per hole** — players shoot in turn; when all hole out (or hit a stroke cap),
   the server tallies + advances (`onHoleComplete` / `advance` become
   server-driven).
4. **Results** — shared scoreboard → back to clubhouse.

**Turn order:** **honors / "you're away"** shot-by-shot order from v1 (decided
2026-08-06): after everyone tees off, whoever is farthest from the pin plays
next; all balls rest on the hole simultaneously. Honors on the next tee goes to
the best score on the previous hole.

## Game-scoped chat

Reuse the chat pipe but the server **routes `chat` only to the match room** (not a
global feed). Client renders a **match chat feed** (same white-Minecraft style as
the clubhouse, but lifetime = the match) that also posts shot events
("Dave — birdie on 2", "Sam is away").

## Edge cases

- **Disconnect mid-round** → grace timer → auto-skip their turns / mark forfeit;
  their ball stays as a ghost. Reconnect within N s rejoins the slot (match code +
  player token).
- **Turn timeout** → auto-concede the hole or auto-tee (configurable) so one AFK
  player can't stall the group.
- **Late join** → matches **lock at start** (spectator-join is a v2).
- **Pin / geometry** → server sends `HOLE_ASSET_VERSION` + pin index so all clients
  render the identical hole.

## Phasing

- **M0** — server scaffold: `golf` plugin + match rooms + invite codes/tokens
  (no gameplay). Dev entry: `game.html?join=CODE`.
- **M1** — 2-player end-to-end with **honors order**: shared pin, outcome
  broadcast, spectator trajectory + snap, remote ghost ball, match chat.
- **M2** — up to 4 players, live scoreboard, and the clubhouse invite UX: the
  80s wall phone (create match + text/share the link) and tap-a-player invites.
- **M3** — polish: reconnect, timeouts, "you're away" prompts, celebrations,
  honors tee order.

## Decisions (made 2026-08-06)

1. **Matchmaking** — **invite-only** rooms, two invite paths: (a) **share via
   text** — a join link you can send by text/share sheet; (b) **tap a player in
   the clubhouse** to invite them directly in-world. No public lobby.
2. **v1 turn model** — **shot-by-shot honors** ("you're away") from the start;
   everyone's balls sit on the hole simultaneously.
3. **Spectating** — **trajectory + snap** via the deterministic aim-preview
   solver.
4. **Entry point** — the **clubhouse**: an **80s wall telephone with a curly
   cord** in the open corner; pick up the handset to "send the text" (create a
   match + share the join link). The link deep-links into `game.html?join=CODE`,
   which is also the receiving end for text invites.

## Key files

- Client turn/scoring/hole flow: `src/game/course.js` (`CourseManager`).
- Existing net client to mirror: `src/clubhouse/clubhouse.js` (`ClubhouseNet`).
- Deterministic trajectory solver (for spectator arcs): `src/game/input.js`.
- Avatar/style reuse: `src/shared/style.js` (`BallsStyle`), clubhouse avatar rig.
- Server plugin pattern: `../drawvidverse/worldserver/src/games/clubhouse/`.
