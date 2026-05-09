# Kitty Graphics on WebGL — Design

**Status:** Approved (design)
**Date:** 2026-05-09
**Branch (anticipated):** `nm-webgpu` (continuation of the WebGL backend work)
**Predecessor specs:**
- `docs/superpowers/specs/2026-05-08-webgl-backend-design.md`

## Goal

Add kitty graphics support (both direct and virtual placements) to the WebGL2 renderer. Architecturally migrate the virtual-placement texture-binding strategy from WebGPU's "16 sampler uniforms + switch" pattern to a shared variable-size kitty atlas. The new approach also fixes a known WebGPU brittleness on adapters that report exactly 16 sampled-textures-per-fragment (atlas reduces the text-shader binding count from 17 to 3).

## Non-Goals (Phase A — this spec)

- **WebGPU virtual-placement migration to the atlas.** WebGPU keeps its existing 16-sampler implementation in Phase A. Phase B (separate spec) will migrate WebGPU.
- **Per-image LRU eviction.** v1 uses clear-and-reset-on-overflow (matches `GlyphAtlasBase.grow()` semantics, simplest correct policy).
- **Direct placements via the atlas.** Direct placements (`icat foo.png`) keep per-image textures. Atlas pressure stays low; large-image draws don't evict virtual-placement images.
- **Atlas growth.** v1 ships with a fixed atlas size (1024² square). When full → clear and re-rasterize on next frame's encode walk. Growth can be added later without changing the API surface.
- **PNG decoding.** `KittyImageFormat.PNG` continues to be expected pre-decoded by the WASM layer; if it arrives undecoded, the cell renders as background only.

## Decisions

| Question | Decision |
|---|---|
| v1 scope | Both direct + virtual placements (full WebGPU parity) |
| Virtual-placement binding | Shared kitty atlas (option C) — extracted to core, reused by Phase B |
| Direct-placement path | Per-image textures (current WebGPU pattern) |
| Eviction policy | Clear-all + re-rasterize on miss when atlas overflows |
| Migration order | WebGL first (Phase A); WebGPU follows in a separate spec (Phase B) |
| Atlas UV lookup | UBO of up to 256 `vec4` rects, indexed by `cell.kittyImageIndex` |
| Test approach | Stub-context tests + manual demo verification (no automated GPU diff) |

## Architecture

### File layout

| File | Phase A status | Purpose |
|---|---|---|
| `lib/renderer-core.ts` | **modify** | Add `KittyAtlasBase`, `kittyImageToRGBA`, `KittyTextureCacheBase`, raise `EncodeCellsContext.maxKittyImages` (default 16, WebGL passes 256) |
| `lib/renderer-webgl.ts` | **modify** | New `GLKittyAtlas`, `GLKittyTextureCache`, `KITTY_VS`/`KITTY_FS` GLSL shaders, kitty pipeline + UBO ring, `TEXT_FS` extended for atlas-based virtual placements, kitty rect UBO, `encodeCells` flag flip to `kittyEnabled: true` and `maxKittyImages: 256` |
| `lib/renderer-webgl.test.ts` | **modify** | Stub-context tests for kitty pipeline init, atlas packing, format conversion, render-path call shape |
| `lib/renderer-webgpu.ts` | **modify** (small) | Subclass `KittyTextureCacheBase` for direct-placement cache (extracts the existing `kittyTextures` map + format conversion); WebGPU virtual-placement code path is **untouched** in Phase A and continues to use the 16-sampler shader |
| `demo/index.html`, `demo/bin/demo.js` | **untouched** | Existing `?renderer=webgl` query string already exercises this path |

### Components

#### `KittyAtlasBase` (new abstract class in `lib/renderer-core.ts`)

Variable-size 2D shelf-packed atlas for virtual-placement images. Parallel to `GlyphAtlasBase` but for arbitrary-dimension RGBA8 images instead of fixed-size glyph rasters.

- **State**: `size` (square dim, fixed at 1024 in v1), `nextX`/`nextY`/`rowHeight` (shelf cursor), `Map<imageId, AtlasEntry>` cache. Each `AtlasEntry` holds `{ slot: AtlasSlot, signature }` where `signature` matches the WebGPU cache's signature (`width / height / format / dataPtr / dataLen`) so we re-upload only when the underlying image data changes.
- **`addOrUpdate(imageId, pixels): AtlasEntry | null`** — main entry point. On signature match returns cached entry. On miss: shelf-pack for the requested w×h; if it doesn't fit, call `clearAndReset()` once and retry. If the second pack also fails (image larger than the entire atlas), return `null`. On successful fit: rasterize via `uploadRegion(slot, rgba, w, h)` (subclass override) and cache.
- **`clearAndReset()`** — clears cache + resets shelf cursor. Surviving images get re-uploaded by their next encodeCells walk.
- **`getEntry(imageId): AtlasEntry | undefined`** — lookup without upload.
- **Subclass overrides**: `uploadRegion(slot, rgba, w, h)`, `growTexture(newSize)` (no-op in v1; reserved for future growth strategy).

#### `kittyImageToRGBA(pixels: KittyImagePixels): Uint8Array | null` (new utility in `lib/renderer-core.ts`)

Pure CPU function. Converts a `KittyImagePixels` (RGB / GRAY / GRAY_ALPHA / RGBA) to a packed `width × height × 4` RGBA8 `Uint8Array`. Returns `null` for unsupported formats. Lifted verbatim from WebGPU's `getOrUploadKittyTexture` body.

#### `KittyTextureCacheBase<TBackendTexture>` (new abstract class in `lib/renderer-core.ts`)

Per-image GPU texture cache for direct placements. Mirrors WebGPU's existing `kittyTextures` map but factored to be backend-abstract.

- **State**: `Map<imageId, { handle: TBackendTexture, width, height, format, dataPtr, dataLen }>`.
- **`getOrUpload(imageId, pixels): TBackendTexture | null`** — signature-match → cached; mismatch → destroy old, allocate new via `createTexture(w, h)` (override), upload via `uploadFull(handle, rgba, w, h)` (override). Returns the texture handle.
- **`destroyAll()`** — calls `destroyTexture(handle)` (override) for each entry. Used by renderer `destroy()`.

#### WebGL renderer additions (`lib/renderer-webgl.ts`)

- **`GLKittyAtlas`** — `KittyAtlasBase` subclass. ~30 lines, mirrors `GLGlyphAtlas` structurally. Single RGBA8 `WebGLTexture`, NEAREST filter, CLAMP_TO_EDGE wrap.
- **`GLKittyTextureCache`** — `KittyTextureCacheBase<WebGLTexture>` subclass for direct placements. Backend-specific upload via `gl.texSubImage2D` (or fresh `gl.texImage2D` on size change).
- **GLSL kitty direct-placement shaders**:
  - `KITTY_VS` — single quad, positions from `KittyParamsUBO.dstOrigin/dstSize`, NDC conversion, outputs UV.
  - `KITTY_FS` — single sampler `uKittyImg`, `texture(uKittyImg, uv)`. Direct port of WGSL `KITTY_SHADER`.
- **`TEXT_FS` extension** — adds `uniform highp sampler2D uKittyAtlas` (texture unit 2) and a new `KittyAtlasUBO` block holding `vec4 rects[256]` (atlas UVs in normalized [0..1]). New branch in `main()`: when `(flags & FLAG_IS_KITTY_PLACEHOLDER) != 0u`, compute slice UV from `cell.blockOrSlice` (sliceCol/Row) and `cell._r` (gridCols/Rows), then `texture(uKittyAtlas, mix(rect.xy, rect.zw, sliceUV))`.
- **Per-frame state**:
  - `kittyAtlas?: GLKittyAtlas` — allocated lazily in `resize()`
  - `kittyTextureCache: GLKittyTextureCache` — allocated in `initialize()`
  - `kittyParamsRing: WebGLBuffer[]` — UBO ring grown on demand to match max placements
  - `kittyAtlasUBO: WebGLBuffer` — 4096-byte rect lookup table allocated in `initialize()`
  - `kittyProgram?: WebGLProgram` — direct-placement program built in `initialize()`
- **`encodeCells` flag flip**: `kittyEnabled: true`, `maxKittyImages: 256`.

### Encoding cap raised to 256

`EncodeCellsContext` gains a new optional field `maxKittyImages?: number` (default 16, the current cap). WebGL passes 256 explicitly. WebGPU continues to pass nothing (or 16) in Phase A — its 16-sampler shader cannot address higher indices, so the cap stays binding for it.

The cell-encoding format already supports indices up to 0xffffffff in `arr[i + 6] = idx`, so no cell-buffer change is required to lift the cap.

## Data flow per frame

`render(buffer, viewportY, sb)`:

1. **Encode cells** — `encodeCells` with `kittyEnabled: true, maxKittyImages: 256`. Returns `usedKittyImageIds` (max 256, in encode-walk order).
2. **Update virtual-placement atlas** — for each id in `usedKittyImageIds`: `pixels = buffer.getKittyImagePixels(...)`; `kittyAtlas.addOrUpdate(id, pixels)`. Skip cells whose image fails to fit (rendered as bg only this frame).
3. **Build kitty rect lookup table** — populate `kittyAtlasRects[256 * 4]` Float32Array with `(slot.u, slot.v, slot.u+slot.w, slot.v+slot.h) / atlas.size` for each used id. Trailing slots stay zeroed.
4. **Upload kitty rect UBO** — `bufferSubData` populated rects to `kittyAtlasUBO`.
5. **Update grid + palette UBOs and cell texture** — unchanged from R4 state.
6. **Direct placements pre-walk** — `for (p of buffer.iterPlacements(graphics, true))` filtering `!p.isVirtual`. For each: `kittyTextureCache.getOrUpload(p.imageId, pixels)`, build a 16-float `KittyParams` array, append to `directPlacements` list. Same logic as WebGPU's pre-walk at `renderer-webgpu.ts:1219-1266`.
7. **Ensure kitty-params ring size** — grow `kittyParamsRing` to `directPlacements.length`. `bufferSubData` each placement's params into its slot.
8. **Clear framebuffer** — viewport + clearColor + `gl.clear`.
9. **Text pass** — `useProgram(textProgram)`; bindBufferBase UBOs at slots 0/1/2 (grid/palette/**kittyAtlas**); bind cell at TEXTURE0, glyph atlas at TEXTURE1, **kitty atlas at TEXTURE2**; `drawArraysInstanced(TRIANGLES, 0, 6, cols*rows)`.
10. **Direct kitty placements** — for each placement: `useProgram(kittyProgram)`, bindBufferBase params UBO at slot 0, activeTexture+bindTexture for `uKittyImg` at TEXTURE0, enable BLEND `(SRC_ALPHA, ONE_MINUS_SRC_ALPHA, ONE, ONE_MINUS_SRC_ALPHA)`, `drawArrays(TRIANGLES, 0, 6)`.
11. **Cursor pass** — unchanged.
12. **`buffer.clearDirty()` + `invalidateNext = false`** — unchanged.

Texture-binding budget for the text pass: 3 (cell, glyph atlas, kitty atlas). Well under the WebGL2 minimum of 16.

## Error handling

| Failure mode | Handling |
|---|---|
| `getKittyImagePixels` returns null | Skip that cell; renders as bg only. Matches WebGPU at `renderer-webgpu.ts:830`. |
| `kittyImageToRGBA` returns null (unsupported format / undecoded PNG) | Skip; renders as bg only. |
| Image larger than atlas, even after `clearAndReset` retry | `addOrUpdate` returns null; cell renders as bg only. Logged once per session. |
| `gl.createTexture()` for kitty atlas fails (OOM) | Throw at construction; renderer init fails; factory falls through to Canvas2D. |
| `gl.createBuffer()` for `kittyAtlasUBO` or ring slot fails | Throw with descriptive message; init fails; factory falls back. |
| Direct-placement count exceeds current ring size | Ring grows on demand (no fixed cap). Same as WebGPU. |
| More than 256 unique virtual-placement imageIds in a frame | encodeCells caps at `maxKittyImages` (256). Excess images don't appear in `usedKittyImageIds`; cells referencing them render as bg only. |
| `webglcontextlost` mid-frame | Existing handler (T13) fires; renderer falls back to Canvas2D via terminal cascade (T15). All kitty resources released as part of `destroy()`. |

## Lifecycle

`destroy()` extends to release kitty resources:

```ts
destroy(): void {
  this.destroyed = true;
  this.cursorBlink_.destroy();
  this.kittyAtlas?.destroy();              // delete the atlas texture
  this.kittyTextureCache.destroyAll();     // delete all per-image direct textures
  if (this.kittyAtlasUBO) this.gl.deleteBuffer(this.kittyAtlasUBO);
  if (this.kittyProgram) this.gl.deleteProgram(this.kittyProgram);
  for (const buf of this.kittyParamsRing) this.gl.deleteBuffer(buf);
  // Existing TODO list (text/cursor programs, glyph atlas, cellTex, gridUBO,
  // paletteUBO, vao) remains for the next cleanup pass.
}
```

The bigger destroy-cleanup follow-up (tracked in the existing T6 comment) is not addressed here — only the new kitty-specific resources land in this spec.

## Testing

### Automated (`lib/renderer-webgl.test.ts`)

- **`kittyImageToRGBA`** unit tests:
  - RGB → RGBA inserts alpha=255
  - GRAY → RGBA broadcasts to RGB and inserts alpha=255
  - GRAY_ALPHA → RGBA broadcasts gray to RGB and uses provided alpha
  - RGBA passes through unchanged
  - Unknown format returns null
- **Kitty atlas packing**:
  - Shelf-packs left-to-right, then wraps to next shelf row
  - `addOrUpdate` returns the same entry on signature match
  - `addOrUpdate` returns a new entry on dataPtr/dataLen change (cache invalidation)
  - `addOrUpdate` returns null when image larger than 1024² atlas (post-`clearAndReset` retry still fails)
- **Render-path call shape** (with stub `WebGL2RenderingContext`):
  - With a buffer that emits virtual placements: `texSubImage2D` for the kitty atlas occurs; `bufferSubData` for the kitty rect UBO occurs; the text pass binds 3 textures (units 0/1/2)
  - With a buffer that emits direct placements: `useProgram(kittyProgram)` and `drawArrays(TRIANGLES, 0, 6)` fire once per placement
  - Without any kitty content: no kitty-specific calls fire
- **Kitty pipeline init**: program count rises 2 → 3 (text + cursor + kitty) — the existing "compile/link count" tests update to `>= 6 compileShader, >= 3 linkProgram`.

### Manual / demo

- `?renderer=webgl` then run `kitten icat path/to/img.png` — verify direct placement renders the image.
- Run a TUI tool that uses U+10EEEE virtual placements (ranger image previews, or a kitten that embeds images) — verify virtual placements render.
- Side-by-side compare with `?renderer=webgpu` to check visual parity.
- Verify Alt+Shift+R cycle still works and the `kitty` content survives renderer swaps gracefully.

CI gate is unchanged: `bun run fmt && bun run lint && bun run typecheck && bun test && bun run build`.

## Phase B (separate spec, not implemented here)

After Phase A ships and is verified, a follow-up will:
- Subclass `KittyAtlasBase` for WebGPU (`WebGPUKittyAtlas`)
- Replace `WebGPURenderer`'s 16-sampler virtual-placement code path with the atlas (drops 14 of the 16 kitty sampler bindings from `TEXT_SHADER`)
- Drop the `requiredLimits.maxSampledTexturesPerShaderStage` workaround in `lib/renderer-factory.ts`
- Raise WebGPU's `maxKittyImages` from 16 to 256 to match WebGL
- WebGPU direct placements remain per-image (no migration needed)

This spec deliberately keeps Phase B out of scope so Phase A can land as a smaller, lower-risk PR.

## Out of scope (explicit)

- LRU eviction policy (clear-all is fine for v1)
- Atlas growth (1024² fixed)
- WebGPU virtual-placement migration (Phase B)
- Direct-placement path migration to atlas (kept per-image)
- Bigger destroy-cleanup pass (existing T6 follow-up TODO)
- Performance benchmarking vs WebGPU
- Automated screenshot diff testing
