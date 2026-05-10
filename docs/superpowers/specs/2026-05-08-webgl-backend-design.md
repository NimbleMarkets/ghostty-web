# WebGL2 Renderer Backend — Design

**Status:** Approved (design)
**Date:** 2026-05-08
**Branch (anticipated):** `nm-webgl`

## Goal

Add a WebGL2 rendering backend to `ghostty-web` so the project has a hardware-accelerated path on platforms where WebGPU is unavailable (notably Safari < 26 and Firefox without the flag). Canvas2D remains the universal fallback.

## Non-Goals (v1)

- **Kitty graphics** — no direct or virtual placements rendered. Kitty content in the buffer is silently skipped.
- **In-shader block-element drawing** — block-drawing characters (▀ ▄ █ ╔ etc.) render as ordinary font glyphs through the atlas, not as procedural fillRects. The atlas already rasterizes them; visual fidelity is "good enough" for v1.
- **WebGL1 support** — WebGL2-only. Coverage is ~98% of browsers (Safari 15+, Chrome/Firefox/Edge since 2017).
- **Shared rendering core** — no extraction of common code with `renderer-webgpu.ts` in this iteration. Duplication is intentional; abstractions are deferred until a third backend or refactor pass justifies them.

## Decisions

| Question            | Decision                                                                       |
| ------------------- | ------------------------------------------------------------------------------ |
| Feature parity      | Core text only: text + colors, cursor, selection, link/hyperlink underlines    |
| GL version          | WebGL2 only                                                                    |
| Code sharing        | Standalone parallel file; copy-and-adapt API-agnostic blocks from WebGPU       |
| Auto fallback chain | WebGPU → WebGL2 → Canvas2D                                                     |
| Test approach       | Logic tests + stub `WebGL2RenderingContext` recorder; manual demo verification |
| Kitty placements    | Silent skip                                                                    |

## Architecture

### File layout

| File                           | Change                                                                                                                                                 |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `lib/renderer-webgl.ts`        | **add** — `WebGL2Renderer` class, ~700–900 lines                                                                                                       |
| `lib/renderer-webgl.test.ts`   | **add** — stub-context unit tests                                                                                                                      |
| `lib/renderer-types.ts`        | **modify** — widen `RendererBackend` to `'webgpu' \| 'webgl' \| 'canvas2d' \| 'auto'`; widen `Renderer.backend` to `'webgpu' \| 'webgl' \| 'canvas2d'` |
| `lib/renderer-factory.ts`      | **modify** — add WebGL branch; `'auto'` chain becomes WebGPU → WebGL → Canvas2D                                                                        |
| `lib/renderer-factory.test.ts` | **modify** — extend to cover the new chain                                                                                                             |
| `lib/terminal.ts`              | **modify** — WebGPU `onDeviceLost` falls back to WebGL2 first; new symmetric `webglcontextlost` handler that falls back to Canvas2D                    |
| `demo/index.html`              | **modify** — accept `?renderer=webgl` (the FPS overlay already reads `term.renderer.backend`)                                                          |
| `lib/renderer-webgpu.ts`       | **untouched** — zero changes                                                                                                                           |

### Components inside `WebGL2Renderer`

1. **`GLGlyphAtlas`** — parallel to the WebGPU `GlyphAtlas`. Same offscreen `<canvas>` 2D rasterizer, same shelf-packing (`nextX`/`nextY`/`rowHeight`), same cache key (`${widthInCells}|${styleBits}|${grapheme}`), same `grow()` / `reset()` policy, same `getOrRaster()` API returning `AtlasSlot`. Uploads via `gl.texSubImage2D` into an `RGBA8` 2D texture with `LINEAR` filtering.

2. **Cell-buffer encoding** — copy of `encodeCells()` from `renderer-webgpu.ts`, with kitty-graphics branches stripped. Same `Uint32Array` packing, same `CELL_U32S = 8` (32 bytes/cell), same flag bits.

3. **Cell texture** — packed `Uint32Array` uploaded as an `RGBA32UI` 2D texture sized `(cols * 2, rows)` (2 RGBA texels per cell). `texSubImage2D` with format `RGBA_INTEGER`, type `UNSIGNED_INT`. Fragment shader reads via `texelFetch(uCellTex, ivec2(cellX*2, cellY), 0)` and `+1` for the second texel — direct analogue of the WGSL storage-buffer reads.

4. **GL programs** —
   - **`textProgram`**: instanced quad, 6 vertices × `cols*rows` instances. Fragment shader does the work of WebGPU's `TEXT_SHADER` minus the kitty branch and minus the procedural block-element fillRects: cell decode → bg fill → atlas sample → fg/selection/underline/strikethrough/cursor-cell inversion.
   - **`cursorProgram`**: a small program drawing the underline/bar cursor as a single quad. Block-style cursor stays handled by `FLAG_IS_CURSOR_CELL` inside `textProgram` (same pattern as WebGPU).

5. **Uniform buffers** — std140-laid-out UBOs with the _same byte layouts_ as the WebGPU `paletteUBO` (384 B) and `gridUBO` (80 B). The byte-construction code is copied from WebGPU verbatim; only the upload call differs (`gl.bufferSubData(UNIFORM_BUFFER, …)` vs `device.queue.writeBuffer(…)`).

6. **Frame state & lifecycle** — `cursorBlink_`, `selectionManager`, `hoveredHyperlinkId`, `hoveredLinkRange`, `theme`, `metrics`, `dpr`, `invalidateNext`, `destroyed` — carried over verbatim. DPR-aware canvas sizing follows the pattern fixed in `afc445f`. Context-loss is handled via `canvas.addEventListener('webglcontextlost', …)`, plumbed through a public `onContextLost(cb)` API that mirrors WebGPU's `onDeviceLost`.

7. **Capability check** — `canvas.getContext('webgl2', { alpha: false, antialias: false, preserveDrawingBuffer: false })`. If `null`, the factory throws for explicit `'webgl'` and falls through silently for `'auto'`.

## Data flow per frame

`render(buffer, viewportY?, scrollbackProvider?)` follows the same shape as WebGPU:

1. **Encode cells** — walk the buffer once into `this.cellArray: Uint32Array` (size `cols*rows*8`). Reuse the WebGPU dirty-row optimization. Set `FLAG_IS_CURSOR_CELL` for block-style cursor.
2. **Upload palette UBO** — only on theme change (dirty bit, same as WebGPU).
3. **Upload grid UBO** — every frame.
4. **Upload cell texture** — `gl.texSubImage2D(TEXTURE_2D, 0, 0, 0, cols*2, rows, RGBA_INTEGER, UNSIGNED_INT, this.cellArray)`. Reallocate (`texImage2D`) only on grid dimension change.
5. **Upload atlas region** — only when new glyphs were rasterized (atlas tracks a dirty bbox; `null` means skip).
6. **Bind & draw text** — `useProgram(textProgram)`, bind UBOs via `bindBufferBase`, bind cell+atlas textures, `drawArraysInstanced(TRIANGLES, 0, 6, cols*rows)`.
7. **Bind & draw cursor** (only if cursor is visible AND style ≠ block) — `useProgram(cursorProgram)`, `drawArrays(TRIANGLES, 0, 6)`.

No render-pass / command-encoder concept; immediate-mode draws to the default framebuffer.

## Error handling

| Failure mode                          | Handling                                                                                                                                                                |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `getContext('webgl2')` returns `null` | Throw with clear message; factory catches under `'auto'` and falls through                                                                                              |
| Shader compile / program link failure | Throw with `getShaderInfoLog` / `getProgramInfoLog`; same propagation as above                                                                                          |
| `webglcontextlost` event              | `e.preventDefault()`; fire registered listeners; `terminal.ts` falls back directly to Canvas2D (no retry to WebGPU — context loss usually indicates deeper GPU trouble) |
| Atlas grow OOM                        | Catch, log one-line warning, keep existing atlas; new glyph fails this frame and retries next frame. Same as WebGPU.                                                    |
| Kitty content in buffer               | Silently skipped. No warnings, no renderer churn.                                                                                                                       |

## Auto-fallback chain

`pickRenderer('auto', …)` order:

1. Try WebGPU (existing logic).
2. On WebGPU adapter/device failure: try WebGL2.
3. On WebGL2 init failure: Canvas2D.

Explicit `'webgpu'` and `'webgl'` strings throw on init failure (no fallback). `'canvas2d'` is unchanged.

The `terminal.ts` device-lost handler currently re-creates Canvas2D on `onDeviceLost`. After this change, it tries WebGL2 first, then Canvas2D.

## Testing

- **`lib/renderer-webgl.test.ts`** — stub `WebGL2RenderingContext` that records calls and returns plausible values (`getShaderParameter` → `true`, `getProgramParameter` → `true`, `createTexture` → numeric id, etc.). Mirrors the Canvas2D approach in `renderer.test.ts`. Verifies:
  - Init compiles + links the two programs and creates cell + atlas textures.
  - Render issues `drawArraysInstanced` once with `instanceCount === cols*rows`.
  - Cursor program invoked iff cursor is visible AND non-block style.
  - `texSubImage2D` for the cell texture is called with `cols*2 × rows` and the expected bytes.
  - Theme / dimension changes trigger the right UBO uploads and texture re-allocations.
- **`lib/renderer-factory.test.ts`** — extend with a case for the new auto chain (WebGPU unavailable → WebGL2 picked; WebGL2 also unavailable → Canvas2D).
- **Pure-logic tests** for the duplicated `encodeCells` / atlas pack / font measurement: these work without any GL context. No new tests are strictly required (the WebGPU tests cover the same logic), but a small smoke test on each adapted function is cheap and catches accidental divergence.
- **Manual / demo** — `?renderer=webgl` query string in `demo/index.html`. Manual eyeball comparison (no automated screenshot diff in v1) against `?renderer=webgpu` and `?renderer=canvas2d` on a fixture page exercising vim, htop, 24-bit color, link hover, selection, and cursor blink.
- **CI gate is unchanged**: `bun run fmt && bun run lint && bun run typecheck && bun test && bun run build` must pass.

## Open implementation questions (deferred to plan)

- Output color space: WebGPU configures the canvas with the preferred format and sRGB handling baked in. WebGL2 will use the default framebuffer's color space. If side-by-side tests show a visible difference, we may need `gl.SRGB8_ALPHA8` for an offscreen FBO + a blit pass — but pre-investigation suggests the default sRGB output is good enough for our color values, which are already in sRGB space.
- Atlas dirty-region tracking: the current WebGPU atlas rasterizes one glyph per call and uploads it inline. We can keep that pattern (one `texSubImage2D` per new glyph) or accumulate a dirty bbox and flush once per frame. Simpler-first wins; bbox accumulation is a future optimization if profiling shows upload overhead.

## Out of scope (explicit)

- Shared `lib/renderer-core.ts` extraction — deferred.
- Performance benchmarking / matching WebGPU FPS — v1 just needs to be smoothly interactive.
- Kitty graphics on WebGL — separate future spec.
- WebGL1 support — not planned (would essentially require a second shader codebase; revisit only if a concrete deployment target demands it).
