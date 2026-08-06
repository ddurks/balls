# Clubhouse texture templates

Hand-draw replacements for the two main procedural clubhouse textures. Each
`*-template.png` is a **seamless square tile**: the black frame is the exact
`1024×1024` tile you draw inside, and the margins are guides only.

- `clubhouse-wood-template.png` — warm oak wainscot / bar / doors. It's **3
  horizontal planks**; the two brown "plank seam" lines + the top/bottom edge
  are board boundaries.
- `clubhouse-carpet-template.png` — dark-green shag floor (uniform, no seams).
- `*-tiling-preview.png` — the _current_ texture tiled 3×3 so you can see what
  "repeats perfectly" should look like.

## Drawing a perfectly-repeating tile in Procreate

1. Import a template, add a **new layer** on top, and draw your version inside
   the black frame (the faint texture underneath is a colour/style reference —
   match the palette swatches). Hide/delete the template layer when done.
2. **Make it seamless** — the easy way: whatever stroke runs off one edge must
   re-enter the opposite edge. To fix seams, use Procreate's wrap trick:
   `Adjustments → (or Selection/Transform)` move your layer **512 px** across and
   **512 px** down (half the tile) so the four edges meet in the centre, paint
   over the visible seam, then move it back 512/512.
3. For the wood, keep the grain roughly **horizontal** and let each plank band
   read continuously left↔right.
4. Export a **flattened 1024×1024** PNG cropped to the frame (no margins/guides).

Drop the finished PNGs back to me and I'll wire them in (replacing the
procedural `Textures.wood` / `Textures.shag`).
