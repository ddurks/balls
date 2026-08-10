# Texture scaling plan

## Goal

Reduce download size and decoded GPU memory without softening the ball, nearby
turf, or clubhouse materials. Keep format conversion and resolution reduction as
separate steps so any visual regression has a single, obvious cause.

## Where the bytes are

The course normal maps are the payload. PNG stores their high-frequency data
poorly, so three files dominate everything else combined:

- `ground-normal.png` — 3.49 MB
- `green-normal.png` — 3.44 MB
- `water-normal.png` — 1.92 MB (**8.85 MB across the three**)

Two independent levers act on these:

- **Resolution** (1,254² → 1,024²) is simple, reversible, needs no runtime
  changes, and cuts pixels to ~67%. It is the safe first increment but only
  captures roughly one third of the available savings.
- **Format** (KTX2/Basis) is the primary objective. UASTC stays block-compressed
  in VRAM, so it cuts decoded memory ~4–8× — the win that actually matters on
  mobile. It costs more: self-hosting the Basis transcoder, verifying Babylon's
  KTX2 loader, and a fallback path. Treat it as the goal, not an optional last
  step.

Byte totals below are source-file sizes, not decoded GPU memory. Uncompressed GPU
cost is about width × height × 4 bytes per RGBA level, plus ~⅓ for mipmaps — so
one 1,254² RGBA map with mips is ~8.4 MB resident, versus ~5.6 MB at 1,024² and
~1 MB as UASTC.

## Prerequisite: fix cache-busting before shipping any resized asset

`/assets` is served immutable in production. Resizing a file in place and
redeploying will serve returning users the stale cached copy unless the request
URL changes. Two gaps block step 6 today:

- **Course textures are unversioned.** `src/game/config.js`, `src/game/scene.js`,
  and `src/game/terrain.js` reference course maps with bare paths (no `?v=`) — the
  exact files resized first.
- **The version constant has already drifted.** `src/clubhouse/clubhouse.js` uses
  `ASSET_V = "15"` while `src/clubhouse/locker.js` uses `"14"`, despite the
  "keep in step" comment.

Minimum to unblock: a single shared version constant imported everywhere, applied
to _all_ texture references including the course maps. Preferred end state:
content-hashed filenames at build time, which make cache invalidation automatic
and retire `?v=` entirely. Do not resize a course map until its URL will change on
deploy.

## Current inventory

Paths reflect the committed reorganization (`assets/textures/`, `assets/ui/`,
`assets/sprites/`).

| Asset group                                |             Current | Current size |          First target |
| ------------------------------------------ | ------------------: | -----------: | --------------------: |
| `textures/course` ground+green normals     |         1,254² each |       6.9 MB |                1,024² |
| `textures/course` water color+normal       |         1,254² each |       3.6 MB |                1,024² |
| `textures/course` ground+green color       |         1,254² each |       741 KB |                1,024² |
| `textures/clubhouse` carpet+wood sets      |         1,024² each |       5.3 MB | Keep 1,024² initially |
| `ui/smoke/smoke-sheet.png`                 | 1,792² (7×7 × 256²) |       1.2 MB |     896² (7×7 × 128²) |
| `sprites/fire` frames                      |            512² × 4 |       690 KB |              256² × 4 |
| `sprites/faces` + `sprites/flags`          |                512² | 214 KB total |          Test at 256² |
| `textures/course` sand + `clubhouse` stone |                512² |       1.0 MB |             Keep 512² |
| `sprites/clouds` + `sprites/grass`         |     ~128² / 128×126 | 230 KB total |     Keep current dims |

`textures/characters/golf-ball-dimples.jpg` (1,024², 158 KB) is excluded on
purpose — the ball is the hero asset and must not be softened.

Note: 1,254² is non-power-of-two. Moving to 1,024² is a POT win in its own right
(clean mipmapping, block-compression alignment), not only a size reduction.

## Migration

1. **Capture a baseline.** Record page transfer size, decoded texture memory,
   frame time, and screenshots from the tee, green, clubhouse floor, VIP carpet,
   smoke, and fire. Test desktop plus one representative mobile device. Every
   later target is measured against these numbers.
2. **Unify and extend versioning.** Land the cache-busting prerequisite above so
   every texture URL changes on deploy. This is a code change, not an asset
   change; ship and verify it before touching any file bytes.
3. **Resample the six course maps to 1,024².** Treat normals as linear data,
   renormalize vectors after filtering, and preserve wrap and UV-scale settings.
   This is the safe down payment (~⅓ of savings).
4. **Convert the three normal maps to KTX2/Basis (UASTC).** Self-host the
   transcoder and verify Babylon's KTX2 loader plus a fallback before changing
   any runtime URL. This is the primary win for both transfer and VRAM. Use
   ETC1S for color maps only where block artifacts are acceptable; use WebP only
   for UI/sprite art that does not need GPU block compression.
5. **Reduce atlases and sprites.** Rebuild smoke at 896² so its 7×7 grid stays
   exact (128² frames). Test fire at 256² and faces/flags at 256²; keep an
   original whenever silhouettes or facial lines visibly degrade.
6. **Evaluate clubhouse maps last.** Keep wood and carpet at 1,024² for the first
   pass — they are viewed close-up. A/B 512² variants only after compressed
   formats work. Stone is already 512² and should not be reduced.
7. **Ship one group at a time.** Bump the shared version (or rely on content
   hashing), deploy, and compare against the baseline before starting the next
   group.

## Acceptance criteria

- No visible seams or changed tiling scale.
- Normal-map lighting stays directionally correct and free of banding.
- Face, flag, fire, and smoke edges stay clean on high-DPI mobile.
- No missing-decoder or format-fallback errors in the console; KTX2 assets fall
  back cleanly where the target format is unsupported.
- **The resolution pass cuts course-texture transfer by ≥ 30% vs. baseline.**
- **The KTX2 pass cuts decoded course-normal VRAM by ≥ 50% vs. baseline.**
- Any group that fails to beat its target for the visual risk it carries is
  reverted to the current asset.
