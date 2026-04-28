# Refactoring TODO

Big items in priority order. Tackle one at a time.

---

## #1 — Consolidate duplicate pin-targeting logic (highest priority)

`getDistanceToNearestPin()` and `getTargetPin()` are duplicated between `AimView` (line ~902) and `UIManager` (lines ~2949, ~3012). The same pin-selection math runs in multiple places.

**Goal:** Single method `PinManager.getTargetPin(ballPos, aimDirection)` that returns `{ pin, index, distance }`. All callers use it.

---

## #2 — Split the GolfGame god class

`GolfGame` owns input handling, camera orchestration, swing coordination, event wiring, render loop, and game state — too many responsibilities.

**Goal:** Extract distinct coordinator objects (e.g. `SwingCoordinator`, `InputHandler`) so `GolfGame` is a thin orchestrator.

---

## #3 — Extract CircleUI builder methods

`CircleUIManager` builds all circle HTML inline in one large constructor. Hard to read and impossible to test.

**Goal:** Pull each circle's HTML construction into its own builder method (e.g. `buildStatsCircle()`, `buildPowerCircle()`).

---

## #4 — Split AimView responsibilities

`AimView` handles aiming logic *and* club selection *and* UI rendering. These are separate concerns.

**Goal:** Separate aiming state/math from UI rendering; club selection should live closer to `ClubSystem`.
