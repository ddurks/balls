# Physics review — September 6, 2026

The main problems are inconsistent collision handling, an inaccurate putting guide,
and a missing resting-state lock. Retuning friction alone couples unrelated behaviors.

## Findings, in priority order

1. **Completed shots can restart rolling during aim (fixed).**
   `GolfBallGuy.updateLandingState()` previously zeroed velocity once but left the
   body dynamic, so gravity could move a "landed" ball again. An interim fix parked
   settled balls as STATIC; that has been replaced by one rolling law (finding 7):
   a stopped ball on any slope up to asin(μr) of its surface is held exactly by the
   law itself, and "at rest" means ground contact plus the law's hold, with low
   speed and spin, for six consecutive physics steps. No snap, no parking.

2. **The terrain recovery bounce is not a sweep.**
   `GolfBallGuy.preventTunneling()` checks vertically under the endpoint, not along
   the ball's travel. It can miss a crossed ridge or recover against a different
   slope than the one struck. It also uses `getNormal(true)`, which the installed
   Babylon implementation defaults to interpolated vertex/shading normals, rather
   than the triangle's geometric normal. That normal determines the reflected
   horizontal velocity. These are credible causes of surprising backward bounces;
   the specific reported course bounce has not been reproduced. Fix with an
   actual swept collision query, geometric normals, and one collision response per
   impact. Do not simply clamp all backward velocity: a rock face or steep upslope
   should still be able to return a ball.

3. **Havok and recovery use different surface restitution.**
   The installed Babylon 9.4.1 Havok plugin defaults to MAXIMUM restitution
   combination. The ball's 0.5 therefore overrides green 0.1, fairway 0.3, rough
   0.2, and sand 0.05 during normal collisions. Recovery instead reads the
   terrain's stamped restitution directly. Identical surface settings thus produce
   different bounce strengths depending on which path handles the collision.
   Define and test one material-combination rule for both paths before tuning.

4. **Putting guidance used the wrong distance curve (fixed).**
   `InputHandler.predictLandingRangeForStrength()` ran its flight simulation at
   zero loft. The putter now uses a closed form of the rolling law: the ball
   launches sliding without spin, kinetic friction μ brakes it while spinning it
   up (spin gains 5/2 of what it brakes) and the law brakes it by μr·g, until it
   rolls at v1 = 2.5·μ·v0 / (3.5·μ + μr) (0.67·v0 on the green, verified in Havok);
   it then rolls out at 5/7·μr·g. It matches Havok within 2 cm from 0.06 to 22 m.
   The strength cache uses a 1 mm putter tolerance and the guide arrow preserves
   tap-in strength, so the displayed arrow round-trips through the input mapping.

5. **The existing calibration scripts can count rollout as carry.**
   Both scripts wait for the ball to cross its starting center height after
   flight. A collision can bounce it before a sampled frame crosses that height.
   If it never crosses, they substitute the final horizontal distance for carry;
   if it crosses after bouncing, they record that later distance. Calibration can
   therefore fit launch speed to a bounce/roll measurement. Use first-contact
   events for on-course carry, or remove the ground to measure isolated flight.
   Reject missing carry instead of silently replacing it.

6. **Force application depends on render frequency.**
   Wind and Magnus run once per render in `GolfGame.setupRenderLoop()`. The installed
   Havok plugin implements `applyForce()` as an impulse using its configured
   timestep (default 1/60 s), while world stepping uses frame delta. Thus these
   forces are not consistently integrated at 30/60/120 FPS. Also, Babylon runs
   physics before `onBeforeRender`, contrary to the rolling-resistance comment.
   Align forces and rolling updates with physics steps and test across frame rates
   before calibrating wind/spin behavior. The no-wind, no-spin measurements below
   do not test this issue.

7. **Havok's default 100 rad/s angular cap (fixed).** A 42.7 mm ball cannot
   roll faster than ~2.1 m/s under it: above that it skids, braking at μ·g. That
   skid, not rolling resistance, was setting putt and roll-out distances, and it
   silently clamped every swipe spin (288 rad/s requested) to 100 rad/s.
   `PhysicsManager.enable()` (shared by the game and every Node harness) sets
   300 m/s / 2000 rad/s limits before any body is created.

8. **Air drag also applied on the ground (fixed).** The 0.3 linear damping was
   a hidden 0.3·v drag on every roll. Damping now applies only while airborne;
   isolated carries moved by < 0.4%.

9. **One rolling law (implemented).** Ball friction and restitution are 1 with
   MULTIPLY combine, so `SURFACE_PHYSICS` values reach Havok unchanged. Each
   surface also stamps a rolling resistance μr (the whole entry is stamped on the
   mesh, including the practice ground and green). Per physics step in contact the
   ball applies its own gravity (Havok's is switched off on the ground: pre-
   cancelling it let friction see the slope pull mid-step and creep the ball),
   then removes up to μr·g·dt of tangential velocity, never past zero. Contact
   friction shares that with the spin, so a rolling ball decelerates at 5/7·μr·g
   on the flat, holds any slope up to asin(μr) and otherwise accelerates at
   5/7·g·(sinθ − μr). This replaced the 2.5 m/s brake threshold, the sand grab and
   0.06 m/s snap, the landing velocity zeroing, the slope-normal ray and the
   height-based contact tests. Contact and surface come from Havok collision events.

10. **Havok brakes slow contacts by itself.** Any contact below 0.1 m/s loses
    ~0.3 m/s² (friction-, shape-, mass- and activation-independent). It stalled
    balls near the hold angle, so the ball gives that small loss back after a step
    that should have kept a slow roll (`restoreSlowRoll`).

11. **Red-team fixes.** Havok has no spinning friction, so spin about the contact
    normal (a sideways swipe, or mesh creases) never died and the ball never
    rested: the law now removes it at (15π/32)·μ·g·a/R² with a 5 mm contact patch.
    A stopped ball holds slopes up to asin(holdResistance), larger than μr like
    turf's breakaway, and a crawl below 0.02 m/s counts as stopped. Havok reports
    one contact per body pair per step, so a ball in a valley crease sees the two
    faces on alternate steps; the hold uses the most upright direction in the cone
    of the last 16 contact normals. Its spurious crease-edge normals keep a ball
    rocking about ±2 cm, so it comes to rest that far up a face. Turf drag is
    judged on rolling speed (5·v + 2·ωR)/7, so a putt (≤ 5/7 of 7.1 m/s) never
    triggers the green's. reset() leaves `landed` to rest detection; that rest
    only ends a shot after applyHit (`inShot`), and a settling placed ball can be
    struck. teleport()/reset() clear the contact memory. The camera updates once
    per frame again. The tunnel guard sampled positions from the world matrix,
    which is only refreshed per rendered frame, so it never saw a sub-step's
    motion; it now reads `mesh.position` and judges a step by where it ended
    (past the swept surface), not by whether Havok reported a contact.
    A struck ball got ~4.8 rad/s of topspin on the launch step from Havok still
    solving its resting contact (friction on the warm-started normal impulse), so
    the ball is frictionless for that one step. Wind was a constant force, which
    also shoved low hops sideways once airborne became contact-based; it now scales
    with airspeed up to its tuned value at 25 m/s (full-shot drift unchanged).
    Swipes now give real wedge spin (~1100 rad/s per firm swipe, capped at 2600)
    with the Magnus coefficient scaled to keep flight as tuned, plus an arcade
    side-force gain (2.6×) so sidespin bends a 7 iron ~22 m. Landing friction is
    applied by the ball as one Coulomb impulse per impact (Havok's gave a fraction
    of μ·(1+e)·vn and replayed its warm-started impulse as the ball bounced off,
    so the ball is frictionless on that step). The impact stops a backspinning
    ball rather than flinging it back (friction never reverses it there); the
    skid that follows draws it back. How much backspin the turf can use is capped
    by a friction-like grip, spinGrip·(1+e)·vn per surface, so stacked spin and
    timing saturate and rough and sand barely spin back. The impact also wrings
    out most spin about the contact normal, with turf grip radius 4 cm.

12. **Swipe spin follows the ball surface.** The swipe is the motion of the
    camera-facing surface, so ω ∝ swipeWorld × cameraForward, and Magnus pushes
    the ball away from a sideways swipe (an on-screen arrow shows the push). With
    the cap raised, SPIN_MULTIPLIER / STRIKE_SPIN_MAX were set so a firm swipe is
    100 rad/s again: lateral deviation is within 2–6% of the playtested build.

## Measurements

Run `node scripts/physics-audit.js`. Uses installed Babylon/Havok with a NullEngine,
the actual strike code, no wind, and no manual spin. Putter tests use a flat
green with the rolling law and landing state. Other clubs measure isolated flight
with ground removed after settling, interpolating the first downward crossing of
launch height. These are controlled baselines, not a full browser/course playtest.
All distances below are metres; every value is identical at 30/60/120 FPS.

| Putter power | Guide estimate | Measured total |
| ------------ | -------------: | -------------: |
| 10%          |           0.22 |           0.22 |
| 25%          |           1.38 |           1.38 |
| 50%          |           5.52 |           5.52 |
| 100%         |          22.09 |          22.11 |

The putter launch speed is 7.1 m/s (it was 17 while the skid limited roll-out).
Distance now grows with the square of power, as a real putt does.

| Surface (μ, μr, μs, e)         | Stimp roll from 1.83 m/s | Holds up to |
| ------------------------------ | -----------------------: | ----------: |
| Green (0.4, 0.085, 0.09, 0.1)  |                     2.81 |        5.2° |
| Fairway (0.5, 0.13, 0.15, 0.3) |                     1.84 |        8.6° |
| Rough (0.6, 0.22, 0.25, 0.2)   |                     1.09 |       14.5° |
| Sand (0.9, 2, 2, 0.05)         |                     0.13 |           — |

| Club           | Label | Isolated carry |
| -------------- | ----: | -------------: |
| Lob Wedge      |    55 |          54.43 |
| Pitching Wedge |    66 |          65.96 |
| 9 Iron         |    88 |          87.79 |
| 8 Iron         |   109 |         109.07 |
| 7 Iron         |   131 |         131.01 |
| 6 Iron         |   153 |         153.13 |
| 5 Iron         |   175 |         174.72 |
| 4 Iron         |   197 |         197.82 |
| Hybrid         |   241 |         241.61 |
| 3 Wood         |   263 |         263.76 |
| 5 Wood         |   252 |         252.84 |
| Driver         |   306 |         306.94 |

## Gameplay policy and validation

Full-shot roll-out: Havok's native contact already applies Coulomb friction at a
landing (measured Δv_t ≈ μ·(1+e)·vn, solved over two steps: normal stop, then
restitution), but that alone left a driver rolling ~180 m on a fairway. Each
surface now adds an `impactLoss` (pitch mark: tangential speed lost per m/s of
landing speed, linear velocity only, never reversing it — spin then bites or
releases) and a `turfDrag` above 4 m/s (0 on the green, so putts are untouched).
Flat fairway roll-outs: driver ~38 m, 7 iron ~6 m, pitching wedge ~1 m; green
7 iron ~5 m, lob wedge ~0; rough driver ~16 m; sand plugs.

`test/acceptance.test.js` (holding, rolling resistance, frame-rate invariance,
bounce, spin, regressions) and `test/physics.test.js` (hold/release at asin(μr),
uphill roll-back, rest detection, sweep recovery) run against real Havok.
Browser/course validation of backward bounces, short-putt guidance, cup capture
and the Magnus arrow remains outstanding.
