# WebGPU Kitty Atlas Migration (Phase B) — Design

**Status:** Approved (design)
**Date:** 2026-05-09
**Branch (anticipated):** `nm-webgpu` (continuation)
**Predecessor specs:**
- `docs/superpowers/specs/2026-05-09-webgl-kitty-design.md` (Phase A — WebGL kitty)
- `docs/superpowers/specs/2026-05-08-webgl-backend-design.md` (original WebGL backend)

## Goal

Migrate the WebGPU renderer's virtual-placement code path from the current "16 sampler uniforms + switch" pattern to the shared `KittyAtlasBase` introduced in Phase A. Drop the `requiredLimits.maxSampledTexturesPerShaderStage` adapter-bumping in the factory. After Phase B both backends share the same kitty-atlas approach for virtual placements; WebGPU works natively on adapters that report exactly 16 sampled-textures-per-stage (currently fragile).

## Non-goals (Phase B)

- **WebGL backend.** Untouched in Phase B; already on the atlas (Phase A).
- **WebGPU direct-placement migration.** Direct placements stay per-image via `WebGPUKittyTextureCache` (already in place from Phase A's K5).
- **Atlas growth or LRU eviction.** Same as Phase A: fixed 1024² atlas, clear-and-reset on overflow.
- **WebGPU stub-context unit tests.** WebGPU's automated testing surface is unchanged; testing remains manual demo + factory unit tests. Adding stub-context tests for WebGPU is separate uplift work.
- **Bigger destroy-cleanup pass.** The pre-existing T6 follow-up (text/cursor programs, glyph atlas, cellBuffer, etc.) is not addressed in Phase B. Only the new kitty atlas + UBO get released.
- **Per-frame Float32Array reuse for direct placements.** Phase A code review flagged this; intentionally deferred.

## Architecture

### File layout

| Path | Status | Purpose |
|---|---|---|
| `lib/renderer-webgpu.ts` | modify | Add `WebGPUKittyAtlas extends KittyAtlasBase`; add `kittyAtlasUBO`, `kittyAtlasRects`, `kittySampler` fields. Rewrite WGSL `TEXT_SHADER` (drop 16 sampler bindings + `samplePlaceholder` switch + `placeholderSamp`; add kitty atlas binding + sampler + `KittyAtlasUBO` block + atlas-rect sampling branch). Update bind-group layout (16 entries → 3 entries replaced). Update `render()` virtual-placement walk: call `kittyAtlas.addOrUpdate(id, pixels)`, populate rects, `writeBuffer` to UBO. Update `encodeCells` context to `maxKittyImages: 256`. Extend `destroy()` to release the new resources. Remove `frameKittyViews`, `dummyTexture`, `dummyView`, `placeholderSamp`. |
| `lib/renderer-factory.ts` | modify | Drop `requiredLimits.maxSampledTexturesPerShaderStage` adapter-bumping (text shader now binds 2 sampled textures, well under default 16). Replace the explanatory comment block with a brief note pointing at this spec. |
| `lib/renderer-factory.test.ts` | possibly modify | Verify existing tests still pass after dropping `requiredLimits`. If any test asserts the `requiredLimits` argument, update. |
| `lib/renderer-core.ts` | untouched | `KittyAtlasBase` reused as-is. |
| `lib/renderer-webgl.ts` | untouched | WebGL backend stays on the atlas it already uses. |
| `demo/index.html`, `demo/bin/demo.js` | untouched | No demo changes. |

### `WebGPUKittyAtlas` (new class in `lib/renderer-webgpu.ts`)

Subclass of `KittyAtlasBase`. ~40 lines. Mirrors `GLKittyAtlas` structurally.

- **State**: single `GPUTexture` (RGBA8, 1024² square, `TEXTURE_BINDING | COPY_DST` usage).
- **`uploadRegion(slot, rgba, w, h)`**: `device.queue.writeTexture` to the texture at `(slot.u, slot.v)` of size `w × h`.
- **`growTexture(_newSize)`**: no-op (v1; matches `GLKittyAtlas`).
- **`view(): GPUTextureView`**: returns the texture's view (created lazily, cached if needed).
- **`destroy()`**: `texture.destroy()`.

Constructor takes `device: GPUDevice`. Allocated lazily in `resize()` like the existing `GlyphAtlas`.

### Per-frame state additions

- `kittyAtlas?: WebGPUKittyAtlas` — lazy
- `kittyAtlasUBO?: GPUBuffer` — 4096 bytes (256 vec4), allocated in `initialize()`
- `kittyAtlasRects: Float32Array(256 * 4)` — host-side staging
- `kittySampler?: GPUSampler` — linear, clamp-to-edge (replaces the current `placeholderSamp`)

### Removed state

- `frameKittyViews` array (no longer 16 per-image views per frame)
- `placeholderSamp` (replaced by `kittySampler`)
- `dummyTexture`, `dummyView` (no longer needed; atlas is always present once initialized)

## WGSL changes (TEXT_SHADER)

### Removed

```wgsl
// 16 sampler bindings + placeholder sampler
@group(0) @binding(5) var kittyTex0: texture_2d<f32>;
// ...through binding 20 (kittyTex15)...
@group(0) @binding(21) var placeholderSamp: sampler;

// Switch dispatch function
fn samplePlaceholder(idx: u32, uv: vec2<f32>) -> vec4<f32> {
  switch idx {
    case 0u: { return textureSampleLevel(kittyTex0, placeholderSamp, uv, 0.0); }
    // ...15 more cases...
    default: { return vec4<f32>(0.0); }
  }
}
```

### Added

```wgsl
@group(0) @binding(5) var kittyAtlas: texture_2d<f32>;
@group(0) @binding(6) var kittySamp: sampler;

struct KittyAtlasUBO {
  rects: array<vec4<f32>, 256>,  // (uMin, vMin, uMax, vMax) in atlas-normalized coords
};
@group(0) @binding(7) var<uniform> kittyAtlasU: KittyAtlasUBO;
```

### Updated kitty-placeholder branch in `fsMain`

Old:
```wgsl
if ((flags & FLAG_IS_KITTY_PLACEHOLDER) != 0u) {
  let sliceCol = f32(cell.blockOrSlice & 0xffffu);
  let sliceRow = f32((cell.blockOrSlice >> 16u) & 0xffffu);
  let gridCols = f32(cell._r & 0xffffu);
  let gridRows = f32((cell._r >> 16u) & 0xffffu);
  let uvX = (sliceCol + in.uv.x) / gridCols;
  let uvY = (sliceRow + in.uv.y) / gridRows;
  return samplePlaceholder(cell.kittyTexIndex, vec2<f32>(uvX, uvY));
}
```

New:
```wgsl
if ((flags & FLAG_IS_KITTY_PLACEHOLDER) != 0u) {
  let sliceCol = f32(cell.blockOrSlice & 0xffffu);
  let sliceRow = f32((cell.blockOrSlice >> 16u) & 0xffffu);
  let gridCols = f32(cell._r & 0xffffu);
  let gridRows = f32((cell._r >> 16u) & 0xffffu);
  let uvX = (sliceCol + in.uv.x) / gridCols;
  let uvY = (sliceRow + in.uv.y) / gridRows;
  let rect = kittyAtlasU.rects[cell.kittyTexIndex];  // (uMin, vMin, uMax, vMax) in atlas-normalized coords
  let atlasUv = mix(rect.xy, rect.zw, vec2<f32>(uvX, uvY));
  return textureSampleLevel(kittyAtlas, kittySamp, atlasUv, 0.0);
}
```

`textureSampleLevel` (not `textureSample`) for the same reason as the existing atlas reads — non-uniform control flow above. LOD 0 because the atlas has no mips.

The non-kitty branches (atlas glyph sampling, cursor cell, INVERSE swap, INVISIBLE early-return, link underlines, strikethrough) are unchanged.

## Bind-group-layout changes

`textBindGroupLayout` entries reduce from 22 to 8.

**Today (`lib/renderer-webgpu.ts:707-733`):**
```
binding 0: gridUBO (uniform)           [vertex|fragment]
binding 1: paletteUBO (uniform)        [fragment]
binding 2: cellBuffer (storage,read)   [vertex|fragment]
binding 3: atlasTex (texture)          [fragment]
binding 4: atlasSamp (sampler)         [fragment]
bindings 5-20: kittyTex0..15 (texture) [fragment]   ← 16 entries removed
binding 21: placeholderSamp (sampler)  [fragment]   ← removed
```

**After Phase B:**
```
binding 0: gridUBO (uniform)           [vertex|fragment]
binding 1: paletteUBO (uniform)        [fragment]
binding 2: cellBuffer (storage,read)   [vertex|fragment]
binding 3: atlasTex (texture)          [fragment]
binding 4: atlasSamp (sampler)         [fragment]
binding 5: kittyAtlas (texture)        [fragment]   ← new
binding 6: kittySamp (sampler)         [fragment]   ← new
binding 7: kittyAtlasUBO (uniform)     [fragment]   ← new
```

The `Array.from({ length: 16 }, ...)` block that generated the 16 kitty texture entries is deleted. The 3 new entries replace it directly.

The per-frame `textBindGroup` rebuild simplifies: instead of populating `frameKittyViews[s] = tex.view` for up to 16 ids, just attach the single kitty atlas view and the rect UBO.

## Data flow per frame

`render(buffer, viewportY, sb)`:

1. **Encode cells** — `encodeCells` with `kittyEnabled: true, maxKittyImages: 256`. Returns `usedKittyImageIds`.
2. **Update virtual-placement atlas** — for each id in `usedKittyImageIds`: `pixels = buffer.getKittyImagePixels(graphics, id)`; `kittyAtlas.addOrUpdate(id, pixels)`. Skip cells whose image fails to fit.
3. **Build kitty rect lookup table** — populate `kittyAtlasRects` with `(slot.u, slot.v, slot.u+slot.w, slot.v+slot.h) / atlas.size` for each used id.
4. **Upload kitty rect UBO** — `device.queue.writeBuffer(kittyAtlasUBO, 0, kittyAtlasRects.buffer)`.
5. **Update grid + palette UBOs and cell buffer** — unchanged.
6. **Direct-placement pre-walk** — unchanged (per-image textures via `WebGPUKittyTextureCache`).
7. **Build text bind group** — now 8 entries (gridUBO, paletteUBO, cellBuffer, atlas, atlasSamp, kittyAtlas, kittySamp, kittyAtlasUBO).
8. **Render pass** — text → kitty-direct → cursor (ordering unchanged).
9. **`buffer.clearDirty()` + `invalidateNext = false`** — unchanged.

## Factory changes

`lib/renderer-factory.ts:33-46` currently bumps `maxSampledTexturesPerShaderStage`:

```ts
const adapter = await gpu.requestAdapter({ powerPreference: 'high-performance' });
if (!adapter) {
  if (explicit) throw new Error('WebGPU adapter unavailable');
  return null;
}
const adapterMax = adapter.limits?.maxSampledTexturesPerShaderStage ?? 16;
const requiredLimits: Record<string, number> = {};
if (adapterMax >= 17) {
  requiredLimits.maxSampledTexturesPerShaderStage = Math.min(32, adapterMax);
}
const device = await adapter.requestDevice({ requiredLimits });
```

After Phase B the text shader binds 2 sampled textures (atlas + kittyAtlas). Replace with:

```ts
const adapter = await gpu.requestAdapter({ powerPreference: 'high-performance' });
if (!adapter) {
  if (explicit) throw new Error('WebGPU adapter unavailable');
  return null;
}
const device = await adapter.requestDevice();
```

Also remove the explanatory comment block about the 17-sampler limit; replace with a brief reference to this spec.

`lib/renderer-factory.test.ts` — verify existing tests still pass. The existing factory tests stub `requestAdapter` to return null or throw, so they never reach the `requestDevice` line. Likely no update needed; spot-check before declaring done.

## Error handling

| Failure mode | Handling |
|---|---|
| `kittyAtlas.addOrUpdate` returns null | Cell renders as bg only this frame (same as WebGL). |
| `getKittyImagePixels` returns null | Skip; cell renders as bg only. |
| `device.createTexture` for kitty atlas fails | Throw at construction; renderer init fails; factory falls through to WebGL/Canvas2D. |
| `device.createBuffer` for `kittyAtlasUBO` fails | Throw; renderer init fails. |
| **Adapters reporting exactly 16 sampled-textures-per-stage** | **Now work natively on WebGPU.** Previously fell through to WebGL via the factory's `requiredLimits` failure path. This is a positive behavior change — user-facing behavior on those devices switches from WebGL → WebGPU. |
| Existing virtual-placement edge cases | Same as today + Phase A WebGL behavior. |

### Lifecycle

`destroy()` extends to release new kitty resources:

```ts
destroy(): void {
  this.destroyed = true;
  this.cursorBlink_.destroy();
  this.kittyTextures.destroyAll();              // existing (Phase A)
  for (const buf of this.kittyParamsRing) buf.destroy();   // existing (Phase A)
  this.kittyParamsRing.length = 0;              // existing (Phase A)
  this.kittyAtlas?.destroy();                   // new (Phase B)
  if (this.kittyAtlasUBO) this.kittyAtlasUBO.destroy();    // new (Phase B)
  // device.destroy() left to caller; we don't own it. Other resources
  // (paletteUBO, gridUBO, glyph atlas, cellBuffer, pipelines, etc.) are
  // owned by the device and reclaimed when it is destroyed.
}
```

## Testing

### Automated

- **No new automated tests.** WebGPU lacks stub-context test infrastructure (unlike WebGL). Adding it is separate uplift work, out of scope.
- **`lib/renderer-factory.test.ts`** — confirm existing tests still pass after dropping `requiredLimits`. Update only if any test asserts the parameter shape (unlikely; existing tests stub at `requestAdapter`).
- **CI gate stays unchanged**: `bun run fmt && bun run lint && bun run typecheck && bun test && bun run build`.

### Manual

- `bun run demo` then `?renderer=webgpu`
- **Direct placements** (regression check): `kitten icat path/to/img.png` — should render identically to today (path unchanged via `WebGPUKittyTextureCache`).
- **Virtual placements**: TUI tool with U+10EEEE protocol (ranger image preview, kitten that embeds images) — should render via the new atlas.
- **Side-by-side** with `?renderer=webgl` — visual parity check.
- **Renderer cycling**: Alt+Shift+R between webgpu / webgl / canvas2d — no crashes; kitty content survives or correctly disappears (Canvas2D has its own kitty support; WebGL and WebGPU should match each other).
- **(If available) 16-sampler hardware** — Android Chrome on older GPUs that report exactly 16 sampled-textures-per-stage. Previously fell through to WebGL; should now stay on WebGPU.

## Out of scope (explicit)

- WebGL backend changes (already on atlas)
- WebGPU direct-placement migration (already shared via `KittyTextureCacheBase`)
- LRU eviction or atlas growth (same as Phase A)
- WebGPU stub-context unit tests
- Bigger T6 destroy-cleanup pass for non-kitty resources
- Per-frame Float32Array reuse for direct placements
- Performance benchmarking
