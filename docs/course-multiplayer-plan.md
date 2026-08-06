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

**Turn order:** v1 = **sequential** (each plays their whole ball, exactly like
today's `advance`) — smallest diff. v2 = **honors / "you're away"** shot-by-shot
order (classic golf, most "together" feel).

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

- **M0** — server scaffold: `golf` plugin + match rooms + join code (no gameplay).
- **M1** — 2-player, sequential, end-to-end: shared pin, outcome broadcast + snap,
  remote ghost ball, match chat. Smallest working slice.
- **M2** — up to 4, honors ("you're away") order, spectator trajectory, live
  scoreboard.
- **M3** — polish: reconnect, timeouts, "you're away" prompts, celebrations,
  honors tee order.

## Open decisions (answer before M0)

1. **Matchmaking** — private **join-code** rooms (recommended for friends) vs. a
   public lobby list vs. both?
2. **v1 turn model** — sequential whole-ball (fastest to ship) vs. jump straight to
   **shot-by-shot honors** order (more social)?
3. **Spectating** — plausible **trajectory + snap** (recommended) vs. simple
   teleport the ball to its rest spot?
4. **Entry point** — launch a round from the **clubhouse** (a door / NPC) or a
   **menu on `game.html`**?

## Key files

- Client turn/scoring/hole flow: `src/game/course.js` (`CourseManager`).
- Existing net client to mirror: `src/clubhouse/clubhouse.js` (`ClubhouseNet`).
- Deterministic trajectory solver (for spectator arcs): `src/game/input.js`.
- Avatar/style reuse: `src/shared/style.js` (`BallsStyle`), clubhouse avatar rig.
- Server plugin pattern: `../drawvidverse/worldserver/src/games/clubhouse/`.
