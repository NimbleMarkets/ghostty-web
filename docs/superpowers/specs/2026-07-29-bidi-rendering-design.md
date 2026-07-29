# BiDi (RTL) Rendering — Design

**Date:** 2026-07-29
**Branch:** `nm-rtl` (off `nm-webgpu` @ bfbe0e5), lands on `nm-webgpu`
**Tracking:** coder/ghostty-web#83; upstream context ghostty-org/ghostty#1442
**Source brief:** `NimbleMarkets/go-booba` @ `rtl-text`, `tests/rtl-text/UPSTREAM-FIX-PROMPT.md`

## Problem

RTL scripts (Hebrew, Arabic, Persian) render mirrored: cells are painted in
logical order left-to-right, so the first logical character appears leftmost
where correct Unicode BiDi rendering puts it rightmost. All four consumers of
the cell-index↔x-position mapping are affected:

1. `lib/renderer-canvas2d.ts:687` — `renderLine()` (both passes)
2. `lib/renderer-core.ts:414` — `encodeCells()` (shared by WebGL and WebGPU)
3. `lib/selection-manager.ts:854` — pixel→column for selection/hit-testing
4. `lib/input-handler.ts:738` — pixel→column for mouse reporting to the app

The fix is entirely in ghostty-web. Ghostty core has no BiDi and needs none:
BiDi is a pure function of a row's codepoint sequence plus a paragraph
direction, and `GhosttyTerminal.getViewport()` already materializes full rows
as `GhosttyCell[]`.

## Scope decisions (settled with the user)

- **Implicit BiDi ordering only.** Arabic cursive joining (shaping) is a
  separate defect — per-cell atlas rasterization emits isolated forms — and is
  **out of scope**; it remains a known limitation, tracked as follow-up work.
  No ECMA-48 SCP/SDS/SRS/BDSM escape parsing (that would be explicit BiDi and
  would pull in libghostty-vt).
- **UBA source:** new runtime dependency on `bidi-js` (lojjic/bidi-js, MIT,
  zero deps, ~7KB gzip). Full UBA with maintained Unicode tables; avoids
  hand-rolled subsets that collapse R/AL and AN/EN distinctions.
- **Paragraph direction: fixed LTR base, per row.** An all-RTL row reorders in
  place while staying anchored to its left-hand columns, which is what
  cursor-addressed TUIs expect. No config option now; a mode can be added
  later if upstream wants one.
- **Never reverse strings; no Hebrew special-casing.** Everything routes
  through a per-row logical↔visual permutation.

## 1. Core module — `lib/bidi.ts`

A `RowBidiMapper` class wrapping `bidi-js`, producing per row of
`GhosttyCell[]`:

```ts
interface RowBidiMap {
  isIdentity: boolean;            // fast-path flag; shared singleton for LTR rows
  visualToLogical: Uint16Array;   // visual column → logical column
  logicalToVisual: Uint16Array;   // inverse
  mirror: Map<number, number> | null; // logical col → mirrored codepoint (UBA L4), paint-time only
}
```

- **Fast path:** scan the row's codepoints; if none is ≥ U+0590 (below which
  no RTL-triggering character exists), return a shared identity map. Kitty
  placeholder cells (U+10EEEE) are explicitly treated as LTR by this scan so
  image rows never pay for a UBA run. Pure-ASCII frames cost ~zero.
- **Full path:** build a string with one codepoint per cell (codepoint 0 →
  space; width-0 spacer cells contribute nothing), tracking string-position ↔
  cell-index. Run `getEmbeddingLevels(text, 'ltr')` + `getReorderedIndices`,
  then project the string-level permutation back to a cell-level permutation.
- **Wide-cell fusing:** a width-2 cell and its width-0 spacer move as one
  unit, spacer always immediately after its base in visual order. This
  preserves the renderers' existing wide-cell handling (`pendingRightHalf`
  in `encodeCells`, spacer skips in `renderLine`).
- **Mirroring (UBA L4):** the map carries a precomputed `mirror` lookup
  (logical col → mirrored codepoint, from `getMirroredCharactersMap`) so `(`
  renders as `)` inside RTL runs. Copy is unaffected — it reads logical cells.
- **Caching:** internal LRU (~256 entries) keyed by a hash of the codepoint
  sequence, with full-sequence equality verification on hit (a hash collision
  must not silently permute wrong). Maps are pure functions of row content —
  nothing is keyed by row position — so scrollback movement and reflow
  invalidate for free.
- **Ownership:** `Terminal` creates one `RowBidiMapper` and hands it to both
  renderers, the selection manager, and the input handler. Consistency across
  consumers is automatic because maps are content-derived.

## 2. Rendering — the two paint paths

### `renderer-canvas2d.ts renderLine()`

Both passes become:

```ts
for (let x = 0; x < line.length; x++) {
  const cell = line[map.visualToLogical[x]];
  // draw at visual x
}
```

The two-pass background/text split is kept. `isInSelection(x, y)` continues to
receive the loop's visual `x` (selection is visual — §3). Mirroring is applied
when building the drawn string.

### `renderer-core.ts encodeCells()`

Same substitution inside the column loop: the cell is fetched via
`map.visualToLogical[x]` and written at the existing visual index
`arr[(y * cols + x) * CELL_U32S]`. No shader changes; WebGL and WebGPU both
inherit the fix.

Coordinate-space fixes inside the loop:

- Selection-flag comparison (`x >= selStartCol && x <= selEndCol`) stays
  against **visual** `x` (§3).
- `hoveredLinkRange` and hyperlink-range checks compare the **logical**
  column, since link ranges come from the logical text scan.
- The mirrored codepoint is substituted **before** `atlas.getOrRaster`, so the
  atlas keys on the glyph actually drawn.

## 3. Selection, copy, and mouse — visual-space model

Selection anchors stay in **visual** space. A drag defines a visual rectangle,
so hit-testing (`selection-manager.ts pixelToCell`), highlight painting, and
`encodeCells`' per-row `selStartCol..selEndCol` span all work unchanged. The
"multiple logical ranges per row" problem exists only transiently inside
`getSelection()`.

- **`getSelection()`:** per row, map the visual span through
  `visualToLogical`, sort the logical indices ascending, and concatenate their
  graphemes. This yields logical-order clipboard text and correctly handles a
  visually contiguous selection whose logical image is several disjoint
  ranges. Existing trailing-space trimming and grapheme lookups
  (`getGraphemeString` / `getScrollbackGraphemeString`) are preserved.
- **Word/line selection (double/triple-click, selection-manager.ts:597):**
  word boundaries are computed on logical text as today; the resulting logical
  range converts via `logicalToVisual` to a visual min/max span. A word is a
  uniform-direction run, so it is always visually contiguous — min/max is
  exact.
- **Mouse reporting (`input-handler.ts pixelToCell()`):** after computing the
  visual column, convert through `visualToLogical` before the +1 to 1-based;
  the application receives **logical** coordinates. The input handler gains a
  way to fetch the current viewport row's cells (small addition to its mouse
  config), since it currently never touches cell data.

## 4. Cursor

Cursor x from the VT layer is logical. Painting maps it through
`logicalToVisual` at the three positioning sites: canvas2d's cursor pass, and
the `cursorX` uniform handoff in `renderer-webgl.ts:671` /
`renderer-webgpu.ts:867`. A shared helper in `renderer-core.ts` avoids
triplicating the lookup. Frame-skip dirty-tracking (`lastCursorX` etc.) keeps
comparing logical values — unchanged.

## 5. Error handling & edge cases

- Short rows, null lines, scrollback rows: identity behavior falls out of the
  fast path; maps are content-derived wherever the cells come from.
- Kitty placeholder rows: excluded from the full path by the fast-path scan
  (see §1).
- `bidi-js` is instantiated once (factory builds tables lazily). If
  construction throws, the mapper degrades to identity maps — rendering falls
  back to today's (mirrored) behavior rather than a blank terminal.
- Selections spanning multiple rows: per-row conversion; full-width middle
  rows map onto themselves as a set, so ordering within each row is logical
  and rows concatenate top-to-bottom as today.

## 6. Testing & verification

Unit tests (bun test, following existing `renderer-*.test.ts` /
`selection-manager.test.ts` patterns):

- `bidi.test.ts` — Hebrew (R); Arabic/Persian (AL); Arabic-Indic digits
  `٤٥٦` (AN) vs Persian digits `۴۵۶` (EN); mixed LTR/RTL; punctuation
  neutrals; wide+spacer fusing; identity fast path; mirroring; cache
  collision verification.
- `renderer-core.test.ts` — `encodeCells` on an RTL row lands instance data at
  reordered visual indices; link-range flag uses the logical column.
- `renderer-canvas2d.test.ts` — mock ctx records `fillText` x-positions for a
  mixed row.
- `selection-manager.test.ts` — visual selection over mixed text yields
  logical-order copy; selection spanning an LTR/RTL boundary; wide/spacer
  interaction with reordering; word-select on an RTL word.
- `input-handler.test.ts` — mouse report carries the logical column, not the
  visual one.

Manual verification per the brief: booba `tests/rtl-text` harness
(`go run ./tests/rtl-text --listen :8099`) on **canvas2d and WebGPU** (HUD
bottom-right names the backend; `renderer-factory.ts` picks it):

- Rows 5/10: red word renders to the **right** of the blue word.
- Ground truth: same string in two `<div>`s served over `http://` — one plain
  (correct UBA), one `unicode-bidi: bidi-override; direction: ltr` (the
  defect). Compare the canvas against both.
- Canvas inspection via CSS upscale (`transform: scale(6)`,
  `image-rendering: pixelated`) applied to **every** canvas layer.
- Do **not** compare against native Ghostty — it has no BiDi and mirrors too.
- Row 11 (`عربي` joining) is **expected to remain broken** — that is the
  out-of-scope shaping work item, a known limitation, not a regression.

## 7. Rollout

Commit series on `nm-rtl`, merged to `nm-webgpu` when verified:

1. Add `bidi-js` dependency + `lib/bidi.ts` with tests.
2. Route both paint paths (`renderLine`, `encodeCells`) through the map.
3. Selection/copy/word-select conversion.
4. Mouse-reporting conversion.
5. Cursor mapping.

Build with `nix develop --command bun run build` (Homebrew zig and the
ziglang.org tarball both fail on this project).

## Out of scope / follow-up

- **Arabic cursive joining (shaping):** requires shaping across cell
  boundaries; the per-cell atlas cannot express it. Separate design needed;
  plausibly larger than this work.
- **Explicit BiDi modes** (SCP/SDS/SRS/BDSM): escape parsing belongs in
  libghostty-vt; not pursued.
- **Configurable paragraph direction:** add only if upstream #83 maintainers
  want it.
- **Upstreaming:** this lands on `nm-webgpu`; a pristine series for a
  coder/ghostty-web PR is a separate later step.
