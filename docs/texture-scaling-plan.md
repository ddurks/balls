# Texture scaling plan

## Goal

Reduce download size and GPU memory without softening the ball, nearby turf, or
clubhouse materials. Make format conversion and resolution reduction separate
steps so visual regressions have one cause.

## Current priorities

| Asset group                   |  Current dimensions | Current size | First target            |
| ----------------------------- | ------------------: | -----------: | ----------------------- |
| Course ground + green normals |         1,254² each |       6.6 MB | 1,024²                  |
| Course water color + normal   |         1,254² each |       3.6 MB | 1,024²                  |
| Course ground + green color   |         1,254² each |       741 KB | 1,024²                  |
| Clubhouse carpet + wood sets  |         1,024² each |       5.3 MB | Keep 1,024² initially   |
| Smoke atlas                   | 1,792² (7×7 frames) |       1.2 MB | 896² (7×128 frames)     |
| Fire animation                |            512² × 4 |       690 KB | 256² × 4                |
| Faces and flags               |                512² | 147 KB total | Test at 256²            |
| Sand and stone sets           |                512² |       1.0 MB | Keep 512²               |
| Clouds and grass              |          about 128² | 186 KB total | Keep current dimensions |

The byte totals are source-file sizes, not decoded GPU memory. Uncompressed GPU
cost is approximately width × height × four bytes per RGBA mip level, plus about
one third when mipmaps are present.

## Migration

1. **Capture a baseline.** Record initial page transfer size, texture memory,
   frame time, and screenshots from the tee, green, clubhouse floor, VIP carpet,
   smoke effect, and fire. Test desktop plus one representative mobile device.
2. **Normalize course maps.** Resample the six 1,254² course maps to 1,024².
   Treat normal maps as linear data, renormalize their vectors after filtering,
   and preserve the existing wrap and UV scale settings.
3. **Reduce atlases and sprites.** Rebuild smoke at 896² so its 7×7 grid remains
   exact. Test fire at 256² and faces/flags at 256², retaining the originals when
   silhouettes or facial lines visibly degrade.
4. **Convert formats separately.** Evaluate KTX2/Basis after dimensions are
   approved: ETC1S for color textures and UASTC for normal maps. Self-host and
   verify Babylon's transcoder before changing runtime URLs. Use WebP only for UI
   and sprite art that does not need GPU block compression.
5. **Evaluate clubhouse maps last.** Keep wood and carpet at 1,024² for the first
   pass because they are viewed close-up. A/B test 512² variants after compressed
   formats are working; stone is already 512² and should not be reduced first.
6. **Ship one group at a time.** Bump the appropriate immutable-cache version,
   deploy, and compare against the baseline before proceeding to the next group.

## Acceptance criteria

- No visible seams or changed tiling scale.
- Normal-map lighting remains directionally correct and free of banding.
- Face, flag, fire, and smoke edges remain clean on high-DPI mobile screens.
- No missing decoder or format fallback errors in the browser console.
- Each migrated group reduces transferred bytes or decoded texture memory enough
  to justify the visual risk; otherwise retain the current asset.
