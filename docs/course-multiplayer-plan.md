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

## Decisions (made 2026-10-25) — head-to-head M1

Revisited after the physics rework (mid-air swipe spin, wind, rich roll-out):

1. **Turn model** — honors / "you're away", turn-based (unchanged).
2. **Spectating** — **stream the real path** (supersedes "trajectory + snap"):
   the shooter's client sends ball pose samples (~20 Hz) while the ball moves;
   spectators replay with interpolation ~150–250 ms behind. Exact, including
   spin curves, bounces and lip-outs; ~1 KB/s while a ball is moving. The
   aim-preview solver can't reproduce swipe spin / bounces / roll.
3. **Scoring** — **match play** (holes won / halved, "2 UP", dormie, early finish).
4. **Ball contact** — **ghosts**: an opponent's ball is drawn at its lie with no
   collider (as if marked). No shared physics to sync.
5. **Match chat** — a chat for just the players in the match, separate from
   clubhouse chat, **persisted for the match's lifetime**: the server keeps the
   match's chat log (bounded), so a reload or rejoin gets the history back.
   Shown as a feed **and as speech bubbles** over the speaker's ball (reusing
   the clubhouse bubble style), with shot events ("Dave — birdie on 2", "Sam is
   away") in the same feed.

## Async play (decided 2026-10-25)

Words-with-Friends-style play, especially for text-link challenges, alongside
live head-to-head.

1. **Turn unit — hole by hole.** On your turn you watch a replay of the
   opponent's hole (their real streamed paths), then play your whole hole.
   Ghost balls (no contact) make each player's hole independent once the server
   fixes the pin and wind, so nothing is lost versus shot-by-shot. Honors
   decide who plays each hole first.
2. **One match type, live or async by presence.** A match never dies on
   disconnect. Both online → it plays live (shot-by-shot honors, as in M1).
   One leaves → the other finishes their own hole and the match goes async.
   Both back → live again. This replaces M1's forfeit-on-disconnect (and the
   deferred "reload after start forfeits" bug). A clubhouse tap usually plays
   live; a texted link usually plays async — same match either way.
3. **Turn notice (v1) — text the link back.** After your turn, the share sheet
   opens with "Your move on hole 4 ⛳" and the match link. No server-sent
   SMS/email. Web Push (Android/desktop; iOS only from the home screen) later.

**Needs:**

- **Durable matches** — the drawvidverse world server already has a DynamoDB
  store (`world/storage/ddbWorldStore.ts`); prod runs `WORLD_STORE_MODE=memory`.
  A match is small: pin + wind per hole, scores, and stored shot paths (a few
  KB per shot, kept for the replay).
- **Stable identity** — a per-browser player token (localStorage) + the match
  link, so you can return days later; a stable name instead of the per-load
  Guest re-roll. Losing browser data loses the match (accounts are separate).
- **Path recording** — S4's streamed paths are also stored per shot, so live
  spectating and async replay share one format and one player.
- **"Your matches" list** — open matches and whose turn it is, from the wall
  phone or a clubhouse board.
- **Turn deadline** (later) — e.g. 3 days, then a nudge, then the hole is
  conceded, so a match can't hang forever.

**Order:** finish live S3–S5 (built with recording in mind) → async layer
(durable matches, tokens, hole turns, replay, text-back, matches list) → Web
Push and deadlines.

**Built (2026-10-25).**

- _Store_ — `games/golf/matchStore.ts`: `MATCH_STORE_MODE=memory` (default;
  newest 500 matches) or `ddb` (`DDB_TABLE`, `AWS_REGION`, `DDB_ENDPOINT` for
  DynamoDB Local; `ddbMatchStore.ts`). Items: `MATCH#id / DATA` (the match as
  JSON) and `PLAYER#tokenHash / MATCH#id` (a summary for the match list). A
  started match is saved whenever `phase:turnSeq:chatSeq` moves (an open shot
  isn't kept), evicted from memory once nobody is in it, flushed on shutdown.
  Stored shots: the current and previous hole, each thinned to 100 samples, so
  a match stays well under DynamoDB's 400 KB item.
- _Identity_ — `Shared.playerToken()` (localStorage `ballsPlayerToken`, random
  128 bits); every golf connection sends it first (`hello`); the server keeps
  only its sha256, per seat. The stable name was already `ballsGuestName`.
- _Presence_ — a seat with a token survives its player dropping (a ping
  timeout too): they're away, not out. Seats are keyed by the connection
  holding them; `resume` re-keys the seat to the new connection everywhere
  (lies, turn, chat `from`, stored shots). A seat without a token (an old
  client, the protocol bots) can't come back, so a drop still forfeits it;
  `leave` in play is resigning. Mid-hole, with one away, whoever is here plays
  on (finishes their own hole); the tee still goes by honors. The 90 s turn
  clock runs only while both are here (the deadline seam: `repick`/`setTurn`).
- _Replay_ — on taking the seat back on your turn, `you.replay` carries the
  opponent's stored shots since your own last one, grouped by hole with that
  hole's pin and wind. The client watches them (loading the previous hole if
  that's where they were), skippable, then plays.
- _Links_ — the match link is `game.html?mode=course&match=ID` (12-char
  random id). It replaces the address bar once a match starts (a reload goes
  back in), is what the text-back shares ("Your move on hole N ⛳" via
  `navigator.share`, else the clipboard, else a field), and is what the
  clubhouse match list opens. Without the seat's token: "This match is between
  X and Y". The page redials for as long as it's open.
- _Match list_ — the wall phone's Matches button; `GolfNet.myMatches()` asks
  the golf server (`matches`) on a short-lived socket.
- _Not yet_ — an async _start_ (a texted challenge still meets live through
  the rendezvous, 15 min key), turn deadlines, Web Push.

## M1 design (head-to-head, 2 players)

**Authority split.** Each client is authoritative for the _physics of its own
shot_ (Havok isn't deterministic across machines). The server is authoritative
for everything else: hole order, the **pin and wind per hole** (sent as data so
both players face the same conditions), whose turn it is, stroke counts, lies,
and the match score.

**Protocol** (rides the existing `action` message; match state on `you`):

- server → client (`you.match`): `{ id, phase, hole, pinIndex, windSeed,
turn, turnSeq, turnEndsIn, present: {id: bool}, lies: {id: {pos, strokes,
holed}}, holeResults[], status }`. Sent **only when it changed** since that player last got it (the
  `turnEndsIn` countdown ticking doesn't count; clients count down locally
  from the value that came with the view) — an unchanged ~1.5 KB view at
  12 Hz outran slow links. A client keeps the last `match` it received; the
  first snapshot after create / join (or a new match) carries the full view.
- `you` itself is sent **only when something in it changed** for that player
  (roster / phase / host, the view, or a one-shot notice / feed / chat line);
  when sent it carries the whole header `{matchCode, phase, hostId, players}`
  (or `{matchCode: null}` / `{notice}` out of a match). An idle snapshot is
  just the ~70 B global part, so the 12 Hz stream fits a ~1 KB/s link (the
  unchanged roster made it ~3.5 KB/s). A client keeps the last `you`.
- Snapshots to a socket that has fallen behind are skipped until it catches
  up (nothing one-shot is consumed for a skipped snapshot): more than 64 KB
  still unsent, or a ping (one in flight, at most every 0.5 s) unanswered for
  1.5 s. The socket's own buffer misses what the kernel and the network
  hold — a 3 KB/s link settled 40 s behind on it alone — while a pong only
  returns once the client has read everything sent before it, so the view
  stays within seconds even on a link slower than the idle stream. A client
  that keeps sending while over 1 MB behind on reading is dropped (its
  replies, errors and pongs, would otherwise pile up in server memory).
- A member whose ping has gone unanswered for 45 s (`GOLF_PING_TIMEOUT_MS`,
  `IGameLogic.pingTimeoutMs`) is dropped as if its socket had closed: it
  leaves the lobby (the host passes on), or is away from the match in play
  (a seat without a token forfeits it: see Async play). A
  network that dies without a FIN or RST (a phone leaving Wi-Fi) otherwise
  holds its seat until the kernel gives up on the socket (~15 min on
  Linux): a rejoining guest sat beside its own ghost as "Sam 2" in a lobby
  of three that could never start, a dead host never passed the lobby on,
  and a challenge's dead host captured its opponent in a lobby waiting on
  the host's word to start. A live client answers within seconds even on a
  link slower than the idle stream (the lag gate bounds its backlog), so
  45 s spares a slow link and a brief outage.
- The chat log a (re)joiner gets goes out at most 16 KB a snapshot (always at
  least one line), so a log of the longest lines (~90 KB) restores over a
  few snapshots, in order.
- `turnSeq` — bumped at every turn assignment (each shot's resolution, each
  new hole).
- `shotStart {club, aim, turnSeq}` — only the player whose turn it is, naming
  the turn from their view; opens a shot. A missing / non-integer `turnSeq`
  is "Bad shot data"; any other turn than the current one is refused with
  "That turn is over", so a swing that reaches the server after its turn
  ended (a stalled link, a swing at the buzzer) can't open a shot on a later
  turn or hole.
- `path` — batched pose samples `[t, x, y, z, qx, qy, qz, qw]` while moving
  (t in seconds since the shot opened, to the ms; positions to the mm;
  rotation to 4 places). Which poses: the fewest whose linear replay passes
  within 5 cm of every frame the shooter simulates, at least one every
  0.25 s and at most 10 a second (a canopy rattle can't blow the budget),
  sent at most 4 frames a second; the last is where the ball came to rest
  or left play. A bounce off a rock or trunk
  is sampled where it turned: the fixed ~20 Hz first planned cut such a
  corner by 1.5–1.8 m. And a moving ball costs ~500 B/s, inside the ~1 KB/s
  budget: 20 one-sample frames a second cost ~2.3 KB/s, so on a 1 KB/s
  uplink they queued behind each other, the spectator fell 5–12 s behind
  and a long roll-out's `shotEnd` reached the server after its 60 s shot
  timer. The spectator replays ~0.75 s behind (up to 0.25 s for a pose to
  be picked, 0.25 s for its frame, and the trip). The kit's sim streams this
  way (`test/mp/path-sampler.js`); the S4 client must too.
  Relayed to the opponent _only_ via the per-player broadcast outbox
  (`takePlayerBroadcasts`, added for the clubhouse image fix), and kept with
  the shot (thinned) for the async replay.
  Nothing drops a path frame for coming too fast (frames that bunch up in
  transit are the shooter's honest backlog: past the connection's frame
  budget, below, they are read late, not lost); a sample must lie within
  the club's plausible distance of the shot's start (a drive hit backwards
  flies far past the island before it falls out of bounds). Queued frames
  of one shot merge into entries of ≤32 samples (≤120 entries per
  recipient), and each snapshot takes at most 128 samples, the rest
  following in the next ones. A finished match still delivers what was
  queued (the end of the match-ending shot).
- `style {hat, skin}` — the sender's locker hat / skin indexes (sent on
  connect), shown as `style` on its roster entry so the opponent's ghost wears
  them. Drawn faces and skin images are too big to relay.
- `shotEnd {restPos, holed, penalty}` — closes the shot. The server validates
  (your turn, shot open, rest inside the hole's bounds, plausible distance for
  the club), adds 1 + penalty strokes, updates the lie, then picks the next
  player: the farthest from the pin among those not holed out. The hole ends
  when both are holed or one hits the stroke cap. Match play: lower strokes
  wins the hole; the match ends once the lead exceeds the holes remaining.
- **Turn timeout** (M1-lite): an idle turn auto-concedes the hole, so a dead
  tab can't stall a match.
- Names are normalized at join like chat (control characters incl. C1 and
  whitespace runs → one space, bidi overrides and unpaired surrogates
  dropped, trimmed), capped at 24 code points ("Player" if nothing visible is
  left), and a joiner whose name looks like one taken in the match (compared
  as drawn: under NFKC, so an accent spelled two ways or fullwidth letters
  are one; without invisible code points; and with the Cyrillic and Greek
  letters drawn exactly like a Latin one read as it, as in "Dаve" with a
  Cyrillic а) gets " 2", " 3"… in that match only: each match starts again
  from the name the player connected with. Chat lines with nothing
  visible are dropped; format characters, default-ignorables (zero-width
  characters, variation selectors, Hangul fillers) and the blank Braille cell
  count as invisible, though they stay inside a line (an emoji ZWJ sequence
  needs its joiners). Raw text past 8 UTF-16 units per output code point is
  cut unread and the chat rate limit is checked before a line is read, so a
  line costs no more than its first few hundred characters; the
  worldserver also cuts a join name to 256 units before logging it. Lobby
  event lines (`feed`) are capped at the newest 20.
- A join code (32^4 of them) is all that keeps a lobby and its chat private,
  so `join` is metered: one that doesn't get the player in (no such code,
  teed off, full, already in a match) spends one of 5 tries per client
  address (per connection where none is known), one back each second. With
  none left every join, the right code too, is refused with "Too many tries,
  wait a moment" before the code is looked up, so the refusal tells nothing.
  A sweep of every code from one address takes 12 days (it took 47 s).
  Behind a reverse proxy on the server's host every socket comes from
  loopback: the worldserver then takes the client's address from the last
  `X-Forwarded-For` entry, so the proxy must append it (nginx:
  `proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;`), or all
  clients share one budget.
- The golf world relays nothing world-wide (typing, dance, gun spawn,
  bullets): players only meet inside their match. It takes no world
  bootstrap either: the worldserver only asks for one, or hands one out,
  where the game config says `bootstrapRequired`; anywhere else an upload is
  refused with `BOOTSTRAP_DENIED` on its type alone, before it is validated
  (validating one walks every array entry: an 8 MB upload of bad entries
  held the event loop ~2.5 s and took ~2.5 GB, stalling every match).
- A frame over 64 KB is refused unread with `FRAME_TOO_LARGE`, the
  connection kept (`IGameLogic.maxFrameBytes`; golf's biggest frame is a
  path frame of a few KB). The socket itself takes 10 MB, for other worlds'
  bootstraps, and decoding that much on the loop every match shares costs
  ~0.2 s and ~200 MB in JSON.parse alone.
- One connection's frames are read at most 100 a second
  (`IGameLogic.maxFramesPerSecond`; a golf client sends a few). Past that
  its socket isn't read until the next second, so its sender's own TCP
  buffers fill, and frames already read wait, in order: none is dropped, and
  a burst that bunched up in transit only arrives late. One that has read
  ten seconds' worth ahead, or has run past its budget ten seconds in a
  row, is flooding, and is dropped. Before, a client that read its replies
  could send ~170k tiny frames a second (pings, actions, junk), each
  parsed, validated and often answered on the loop every match shares, and
  stalled every match's snapshots and timers 2–4 s at a time.
- Async play (above) adds: `hello {message: token}` (first, on connect),
  `resume {message: matchId}` (back to your seat; the whole chat log comes
  again, and `replay` if it's your turn), `matches` (answered as
  `you.matches: [{id, vs, myTurn, hole, status, finished}]` while in no
  match). A resume of a match not in memory and a list each spend a join try
  (each is a store read). Contract 9's reload case is covered by `resume`.

**Client.** A `MatchCoordinator` drives `CourseManager` from server state:
`loadHole(index, pinIndex)` (no local pin randomising), wind from `windSeed`,
input only on your turn, otherwise **spectate**: the follow camera tracks the
opponent's streamed ball, then their ghost (gball + locker style, no collider)
sits at its lie.

Every genuine shot has to end, or the shooter never sends `shotEnd` and the
server's shot timeout charges a stroke for a ball at rest. `GolfBallGuy` used
to miss four kinds of stopped ball (0.1–0.3% of spin-swiped shots in sim
matches): one plugged in a bunker's vertical lip, still spinning (sand holds a
ball at any tilt, and the hold kept "real spin" for contact friction that a
weightless face never applies; now a hold on turf with no spin grip ends the
spin); one held but creeping at ~1.6 cm/s (the hold pushed it into the
contact normal it stopped on, kept while held, which needn't be the face it
touches now; a held ball is no longer pushed); one wedged against a rock on
rough too steep to hold (a rock, trunk or flagstick the ball has come to lean
on now counts as support, like a crease's second face); and one caught under
the edge of the fairway's mesh where it lies over the rough. Nothing the
rolling law models holds that last one, so as a backstop a ball on the ground
crawling slower than turf's catch speed (2 cm/s) for 2 s during a shot is at
rest where it lies, and stopped there, spin and all; a ball easing off a slope
it can't hold passes 2 cm/s well inside that.

**Slices.**

- S1 — server match state machine (holes, pins, wind, turns, honors, match
  play, validation, timeout) + protocol-bot tests.
- S2 — headless test kit: protocol bots, the sim client, the chaos proxy (below).
- S3 — client `MatchCoordinator`: server-driven holes, turn gating, ghosts.
- S4 — path streaming + spectator playback.
- S5 — match-play scoreboard ("2 UP") + match chat: server-kept log (last ~100
  lines) sent on join/rejoin, routed only to the match, feed + speech bubbles
  over the speaker's ball, shot events in the same feed.

## Testing strategy — adversarial, driven by live headless clients

**Headless clients:**

- **Protocol bots** — Node + `ws` speaking the golf protocol directly. Fast and
  cheap: hundreds of matches, plus fuzz (out-of-turn / duplicate / malformed /
  oversized / reordered actions, leaving mid-shot).
- **Sim clients** — a real game client in Node: the Havok test harness +
  `CourseManager` + `GolfBallGuy` on the real hole GLBs, driven by the real
  match client code. They play genuine shots (club choice, swipe power, mid-air
  spin) and stream genuine paths (the poses `path-sampler.js` picks, as the
  S4 client must). Two sim clients play whole matches end to end.
- **Chaos proxy** — a small WS man-in-the-middle adding latency (50–400 ms),
  jitter, throttling and forced disconnects between a client and the server.
  It reads the server as fast as it sends and answers the server's pings
  itself, so the server never feels its delays; a byte-level **TCP
  throttle** (`startTcpThrottle`) and **TCP link** (`tcp-link.js`: latency,
  jitter, bandwidth both ways, stalls, half-open and reset cuts) read only as
  fast as they forward, for what a slow network does to the server's side
  (backpressure, late pongs). A bot can claim a client address
  (`new Bot(url, name, { address })`, sent as `X-Forwarded-For`), so bots on
  one machine stand for clients on several. A flood runs on a thread of its
  own (`flooder.js`), so building megabyte frames doesn't stall the
  bystanders it is measured against; a flood of tiny frames runs in a
  process of its own (`frame-flood-child.js`), against a bystander timing
  its pings, so the stall measured is the server's.
- **Headless browser clients** — the real `game.html` in headless Chrome (the
  installed Chrome via puppeteer-core), two per match, scripted swipes. Catches
  what Node can't: rendering, the spectator camera, ghosts, bubbles, the
  scoreboard, and the real browser WebSocket path. Slower, so a smaller suite
  run at the end of each slice; screenshots saved for review.
- **Visual checks** — Claude in Chrome tabs at milestones for interactive
  poking, then a human playtest.

**Contract (invariants the breaker tries to violate):**

1. _Agreement_ — after every shot, both clients and the server agree on every
   lie (±1 cm), stroke count, turn, hole and match status.
2. _Authority_ — the server rejects out-of-turn shots, a second `shotEnd`, a
   `shotEnd` without a `shotStart`, wrong-phase actions, stroke tampering and
   implausible rest positions.
3. _Liveness_ — every match reaches `finished` or an explicit forfeit, even
   with disconnects, timeouts and chaos; nothing gets stuck.
4. _Honors_ — the next player is always the farthest from the pin among those
   not holed out; tee order follows the previous hole; ties are defined.
5. _Match-play math_ — hole results, halves, dormie, early finish, final score.
6. _Spectator fidelity_ — the replayed path stays within ε of the shooter's
   ground-truth path, ends exactly at the lie, never teleports, and plays back
   within a bounded delay.
7. _Shared conditions_ — both clients load the same hole version, pin and wind.
8. _Isolation_ — parallel matches never leak state, chat or paths; match chat
   never reaches the clubhouse and vice versa.
9. _Chat persistence_ — a reload / rejoin mid-match restores the full match
   chat log in order, with no duplicates; it's freed when the match ends.
10. _Resources_ — server memory and per-snapshot size stay bounded; a finished
    match frees everything.

**Loop.** For each slice: the builder implements it → the breaker runs the bot
and sim suites under chaos and writes new scenarios aimed at breaking a
contract item → every break becomes a regression test (jest on the server,
`node --test` on the sim side) → the builder fixes it → repeat until the breaker
finds nothing new for two rounds → headless-browser suite → Chrome check →
human playtest.

## Key files

- Client turn/scoring/hole flow: `src/game/course.js` (`CourseManager`).
- Existing net client to mirror: `src/clubhouse/clubhouse.js` (`ClubhouseNet`).
- Deterministic trajectory solver (for spectator arcs): `src/game/input.js`.
- Avatar/style reuse: `src/shared/style.js` (`BallsStyle`), clubhouse avatar rig.
- Server plugin pattern: `../drawvidverse/worldserver/src/games/clubhouse/`.
