# WebGPU Kitty Atlas Migration (Phase B) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Migrate WebGPU's virtual-placement code path from "16 sampler uniforms + switch" to the shared `KittyAtlasBase`. Drop the `requiredLimits.maxSampledTexturesPerShaderStage` adapter-bumping in the factory. After Phase B, adapters reporting exactly 16 sampled-textures-per-stage work natively on WebGPU.

**Architecture:** A new `WebGPUKittyAtlas` subclass of `KittyAtlasBase` (introduced in Phase A) packs all virtual-placement images into a single 1024² RGBA8 GPU texture. The `TEXT_SHADER` WGSL is rewritten to drop the 16 individual `kittyTex0..15` sampler bindings + `samplePlaceholder` switch, and instead reads atlas rects from a 256×vec4 `KittyAtlasUBO` and samples a single `kittyAtlas` texture. The text-shader binding count drops from 17 sampled textures to 2, eliminating the need for `requiredLimits` shenanigans in the factory. Direct-placement code path (per-image textures via `WebGPUKittyTextureCache` from Phase A) is unchanged.

**Tech Stack:** TypeScript, WebGPU, WGSL. Test runner: `bun test`. Pre-commit gate: `bun run fmt && bun run lint && bun run typecheck && bun test && bun run build`.

**Spec:** `docs/superpowers/specs/2026-05-09-webgpu-kitty-atlas-design.md`

---

## File Structure

| Path | Status | Purpose |
|---|---|---|
| `lib/renderer-webgpu.ts` | modify | Add `WebGPUKittyAtlas` subclass + `kittyAtlasUBO` + `kittySampler` + `kittyAtlasRects` host buffer. Rewrite TEXT_SHADER WGSL. Update bind-group layout. Update render() virtual-placement walk. Set `maxKittyImages: 256`. Extend `destroy()`. Remove now-unused `frameKittyViews`/`dummyTexture`/`dummyView`/`placeholderSampler`. |
| `lib/renderer-factory.ts` | modify | Drop `requiredLimits.maxSampledTexturesPerShaderStage` adapter-bumping from `tryWebGPU`. Replace explanatory comment block. |
| `lib/renderer-factory.test.ts` | possibly modify | Spot-check whether any test asserts the `requiredLimits` parameter shape. Likely no change needed (existing tests stub at `requestAdapter`). |
| `lib/renderer-core.ts` | untouched | `KittyAtlasBase` reused as-is. |
| `lib/renderer-webgl.ts` | untouched | WebGL backend unchanged. |
| `demo/index.html`, `demo/bin/demo.js` | untouched | No demo changes. |

## Reference snapshots

- **WGSL TEXT_SHADER** at `lib/renderer-webgpu.ts:39-315` — full shader. The 16 sampler bindings (`@binding(5)..@binding(20)`), the `placeholderSamp` (`@binding(21)`), and the `samplePlaceholder(idx, uv)` switch function get deleted. The kitty-placeholder branch in `fsMain` (lines 251-260) gets rewritten to read from the atlas rect UBO.
- **`textBindGroupLayout` setup** at approximately `lib/renderer-webgpu.ts:707-733` — the `Array.from({ length: 16 }, ...)` block that generates 16 kitty texture entries plus the `placeholderSamp` entry get deleted; 3 new entries replace them.
- **Per-frame `textBindGroup` rebuild** at approximately `lib/renderer-webgpu.ts:935-974` — the `frameKittyViews` walk gets removed; the bind-group entry list shrinks accordingly.
- **`render()` virtual-placement walk** at `lib/renderer-webgpu.ts:934-951` — the per-id `getOrUpload` + `createView` collection becomes `kittyAtlas.addOrUpdate` + `kittyAtlasRects` population + `kittyAtlasUBO` upload.
- **Phase A WebGL counterpart** at `lib/renderer-webgl.ts` (around the `kittyAtlasRects` block in `render()`) is the structural reference for the WebGPU port.

## Behavior preserved by Phase B

- **WebGPU direct placements (`icat foo.png`)** — unchanged. Per-image textures via `WebGPUKittyTextureCache` (from Phase A K5).
- **WebGL backend** — completely untouched.
- **Canvas2D backend** — completely untouched.
- **Auto-fallback chain** — WebGPU → WebGL → Canvas2D unchanged.
- **Visual fidelity for virtual placements** — should be identical to today (same atlas-normalized UV math, same texture filtering).

## Behavior change introduced by Phase B

- **Adapters reporting exactly 16 sampled-textures-per-stage** — previously fell through to WebGL via the factory's `requiredLimits` failure path. Now stay on WebGPU. User-facing impact on those devices: WebGPU instead of WebGL. Both backends now share the kitty-atlas approach, so visual parity should hold.

---

## Task PB1: Allocate `WebGPUKittyAtlas` + supporting state (no wiring yet)

**Files:**
- Modify: `lib/renderer-webgpu.ts`

Add the new `WebGPUKittyAtlas` subclass, the `kittyAtlasUBO` GPU buffer, the `kittySampler`, and the host-side `kittyAtlasRects` Float32Array. Allocate them in the appropriate phases of the renderer lifecycle (constructor / `initialize()` / `resize()`) — but no render-path wiring yet. The renderer remains functionally unchanged after PB1 because nothing references the new fields yet.

- [ ] **Step 1: Add the `WebGPUKittyAtlas` subclass**

In `lib/renderer-webgpu.ts`, find the existing `WebGPUKittyTextureCache` class (added in Phase A K5). Add `WebGPUKittyAtlas` immediately after it:

```ts
class WebGPUKittyAtlas extends KittyAtlasBase {
  private device: GPUDevice;
  private texture: GPUTexture;

  constructor(device: GPUDevice, size = 1024) {
    super(size);
    this.device = device;
    this.texture = device.createTexture({
      size: { width: size, height: size },
      format: 'rgba8unorm',
      usage:
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.COPY_DST |
        GPUTextureUsage.RENDER_ATTACHMENT,
      label: 'kittyAtlas',
    });
  }

  view(): GPUTextureView {
    return this.texture.createView();
  }

  destroy(): void {
    this.texture.destroy();
  }

  protected uploadRegion(
    slot: { u: number; v: number; w: number; h: number },
    rgba: Uint8Array,
    w: number,
    h: number
  ): void {
    this.device.queue.writeTexture(
      { texture: this.texture, origin: { x: slot.u, y: slot.v } },
      rgba.buffer,
      { bytesPerRow: w * 4, rowsPerImage: h },
      { width: w, height: h }
    );
  }

  protected growTexture(_newSize: number): void {
    // v1: never grows; clearAndReset reuses the existing texture.
  }
}
```

Add `KittyAtlasBase` to the existing `./renderer-core` import in `lib/renderer-webgpu.ts`. The current import line includes `KittyTextureCacheBase`; append `KittyAtlasBase` to that list.

- [ ] **Step 2: Add fields**

Find the existing kitty-related fields on `WebGPURenderer` (the cache, the sampler, the ring). Add new fields nearby:

```ts
private kittyAtlas?: WebGPUKittyAtlas;
private kittyAtlasUBO?: GPUBuffer;
private kittyAtlasRects = new Float32Array(256 * 4); // host-side staging (256 vec4)
private kittySampler?: GPUSampler;
```

- [ ] **Step 3: Allocate `kittyAtlasUBO` and `kittySampler` in `initialize()`**

In `initialize()`, after existing UBO + sampler setup, add:

```ts
this.kittyAtlasUBO = this.device.createBuffer({
  size: 256 * 4 * 4, // 256 vec4 × 4 floats × 4 bytes = 4096 bytes
  usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  label: 'kittyAtlasUBO',
});

this.kittySampler = this.device.createSampler({
  magFilter: 'linear',
  minFilter: 'linear',
  addressModeU: 'clamp-to-edge',
  addressModeV: 'clamp-to-edge',
  label: 'kittySampler',
});
```

Place these alongside the existing `paletteUBO`/`gridUBO`/`atlasSampler` allocations.

- [ ] **Step 4: Allocate `kittyAtlas` lazily in `resize()`**

Find the existing glyph atlas (re)allocation block in `resize()`. After it, add:

```ts
if (!this.kittyAtlas) {
  this.kittyAtlas = new WebGPUKittyAtlas(this.device);
}
// Note: the kitty atlas is fixed-size and persists across resizes.
```

Mirror Phase A's `GLKittyAtlas` lazy-allocation pattern.

- [ ] **Step 5: Verify**

```bash
bun run typecheck
bun test
```
Expected: full suite green. No behavior change yet — the new fields exist but nothing uses them.

- [ ] **Step 6: Format + commit**

```bash
npx prettier --write lib/renderer-webgpu.ts
npx prettier --check lib/renderer-webgpu.ts
git add lib/renderer-webgpu.ts
git commit -m "feat(render): WebGPUKittyAtlas + kittyAtlasUBO allocation (no wiring yet)"
```

DO NOT include unstaged docs changes from earlier work.

---

## Task PB2: Atomic migration — WGSL + bind layout + render walk

**Files:**
- Modify: `lib/renderer-webgpu.ts`

This is the central change. The WGSL shader, the bind-group layout, the per-frame bind group rebuild, the render() virtual-placement walk, and the `encodeCells` context update all change together. Intermediate states are broken; this lands as one commit.

After this task, the WebGPU renderer's virtual-placement path uses the shared `WebGPUKittyAtlas` instead of 16 individual sampler bindings.

- [ ] **Step 1: Rewrite the WGSL TEXT_SHADER kitty bindings + sampler**

In `lib/renderer-webgpu.ts`, find the WGSL `TEXT_SHADER` template literal. Locate the kitty sampler bindings (currently `@binding(5)` through `@binding(20)` for `kittyTex0..15`, and `@binding(21)` for `placeholderSamp`).

Delete those 17 lines. Replace with:

```wgsl
@group(0) @binding(5) var kittyAtlas: texture_2d<f32>;
@group(0) @binding(6) var kittySamp: sampler;

struct KittyAtlasUBO {
  rects: array<vec4<f32>, 256>,
};
@group(0) @binding(7) var<uniform> kittyAtlasU: KittyAtlasUBO;
```

- [ ] **Step 2: Delete the WGSL `samplePlaceholder` switch function**

In the same shader, find the `fn samplePlaceholder(idx: u32, uv: vec2<f32>) -> vec4<f32> { switch idx { ... } }` function body. Delete it entirely. The 16-case switch is no longer needed.

- [ ] **Step 3: Rewrite the WGSL kitty-placeholder branch in `fsMain`**

Find the existing branch (around `lib/renderer-webgpu.ts:251-260`):

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

Replace with:

```wgsl
if ((flags & FLAG_IS_KITTY_PLACEHOLDER) != 0u) {
  let sliceCol = f32(cell.blockOrSlice & 0xffffu);
  let sliceRow = f32((cell.blockOrSlice >> 16u) & 0xffffu);
  let gridCols = f32(cell._r & 0xffffu);
  let gridRows = f32((cell._r >> 16u) & 0xffffu);
  let uvX = (sliceCol + in.uv.x) / gridCols;
  let uvY = (sliceRow + in.uv.y) / gridRows;
  let rect = kittyAtlasU.rects[cell.kittyTexIndex];
  let atlasUv = mix(rect.xy, rect.zw, vec2<f32>(uvX, uvY));
  return textureSampleLevel(kittyAtlas, kittySamp, atlasUv, 0.0);
}
```

`textureSampleLevel` (not `textureSample`) for the same reason as the existing atlas sampling — non-uniform control flow above. LOD 0 because the atlas has no mips.

- [ ] **Step 4: Rewrite `textBindGroupLayout` entries**

Find the existing `this.textBindGroupLayout = this.device.createBindGroupLayout({ entries: [...] })` setup (approximately `lib/renderer-webgpu.ts:707-733`).

The current `entries` array contains:
```
{ binding: 0, ..., buffer: { type: 'uniform' } },                   // gridUBO
{ binding: 1, ..., buffer: { type: 'uniform' } },                   // paletteUBO
{ binding: 2, ..., buffer: { type: 'read-only-storage' } },         // cellBuffer
{ binding: 3, ..., texture: { sampleType: 'float' } },              // atlasTex
{ binding: 4, ..., sampler: { type: 'filtering' } },                // atlasSamp
...Array.from({ length: 16 }, (_, i) => ({ binding: 5 + i, ..., texture: ... })),  // kittyTex0..15
{ binding: 21, ..., sampler: { type: 'filtering' } },               // placeholderSamp
```

Replace the `Array.from(...)` block AND the `binding: 21` entry with:

```ts
{
  binding: 5,
  visibility: GPUShaderStage.FRAGMENT,
  texture: { sampleType: 'float' as const },
},
{
  binding: 6,
  visibility: GPUShaderStage.FRAGMENT,
  sampler: { type: 'filtering' as const },
},
{
  binding: 7,
  visibility: GPUShaderStage.FRAGMENT,
  buffer: { type: 'uniform' as const },
},
```

The first 5 entries (bindings 0-4) stay unchanged.

- [ ] **Step 5: Rewrite the per-frame `textBindGroup` build in `render()`**

Find the existing `textBindGroup` construction (approximately `lib/renderer-webgpu.ts:953-974`):

```ts
const textBindGroup =
  this.textBindGroupLayout &&
  this.gridUBO &&
  this.paletteUBO &&
  this.cellBuffer &&
  this.atlas &&
  this.atlasSampler &&
  this.placeholderSampler
    ? this.device.createBindGroup({
        layout: this.textBindGroupLayout,
        entries: [
          { binding: 0, resource: { buffer: this.gridUBO } },
          { binding: 1, resource: { buffer: this.paletteUBO } },
          { binding: 2, resource: { buffer: this.cellBuffer } },
          { binding: 3, resource: this.atlas.view() },
          { binding: 4, resource: this.atlasSampler },
          ...frameKittyViews.map((v, i) => ({ binding: 5 + i, resource: v })),
          { binding: 21, resource: this.placeholderSampler },
        ],
      })
    : null;
```

Replace with:

```ts
const textBindGroup =
  this.textBindGroupLayout &&
  this.gridUBO &&
  this.paletteUBO &&
  this.cellBuffer &&
  this.atlas &&
  this.atlasSampler &&
  this.kittyAtlas &&
  this.kittySampler &&
  this.kittyAtlasUBO
    ? this.device.createBindGroup({
        layout: this.textBindGroupLayout,
        entries: [
          { binding: 0, resource: { buffer: this.gridUBO } },
          { binding: 1, resource: { buffer: this.paletteUBO } },
          { binding: 2, resource: { buffer: this.cellBuffer } },
          { binding: 3, resource: this.atlas.view() },
          { binding: 4, resource: this.atlasSampler },
          { binding: 5, resource: this.kittyAtlas.view() },
          { binding: 6, resource: this.kittySampler },
          { binding: 7, resource: { buffer: this.kittyAtlasUBO } },
        ],
      })
    : null;
```

- [ ] **Step 6: Replace the per-frame virtual-placement walk in `render()`**

Find the existing walk (approximately `lib/renderer-webgpu.ts:934-951`):

```ts
// Build per-frame kitty texture views (virtual placements, Task 16).
const frameKittyViews: GPUTextureView[] = new Array(16).fill(this.dummyView!);
const graphics2 = buffer.getKittyGraphics?.() ?? null;
if (graphics2 !== null) {
  for (let s = 0; s < usedKittyImageIds.length; s++) {
    const id = usedKittyImageIds[s]!;
    const pixels = buffer.getKittyImagePixels?.(graphics2, id);
    let view: GPUTextureView | null = null;
    if (pixels) {
      const tex = this.kittyTextures.getOrUpload(id, pixels);
      if (tex) view = tex.createView();
    } else {
      const cached = this.kittyTextures.get(id);
      if (cached) view = cached.createView();
    }
    if (view) frameKittyViews[s] = view;
  }
}
```

Replace with:

```ts
// Update kitty atlas for any virtual-placement images used this frame, and
// build the rect lookup table for the text shader (mirrors Phase A WebGL).
this.kittyAtlasRects.fill(0);
const graphics2 = buffer.getKittyGraphics?.() ?? null;
if (graphics2 !== null && this.kittyAtlas && usedKittyImageIds.length > 0) {
  for (let i = 0; i < usedKittyImageIds.length; i++) {
    const id = usedKittyImageIds[i]!;
    const pixels = buffer.getKittyImagePixels?.(graphics2, id);
    if (!pixels) continue;
    const entry = this.kittyAtlas.addOrUpdate(id, pixels);
    if (!entry) continue;
    const size = this.kittyAtlas.atlasSize;
    this.kittyAtlasRects[i * 4 + 0] = entry.slot.u / size;
    this.kittyAtlasRects[i * 4 + 1] = entry.slot.v / size;
    this.kittyAtlasRects[i * 4 + 2] = (entry.slot.u + entry.slot.w) / size;
    this.kittyAtlasRects[i * 4 + 3] = (entry.slot.v + entry.slot.h) / size;
  }
}
if (this.kittyAtlasUBO) {
  this.device.queue.writeBuffer(this.kittyAtlasUBO, 0, this.kittyAtlasRects.buffer);
}
```

Note the rename of variable: there's no longer a `frameKittyViews` array.

- [ ] **Step 7: Raise `maxKittyImages` to 256 in encodeCells call**

Find the existing `private encodeCells` wrapper method on `WebGPURenderer`. Currently it calls `coreEncodeCells` without `maxKittyImages` (defaulting to 16). Update to pass 256:

```ts
private encodeCells(
  buffer: IRenderable,
  viewportY: number,
  sb?: IScrollbackProvider
): { usedKittyImageIds: number[] } {
  return coreEncodeCells(this.cellArray, buffer, viewportY, sb, {
    metrics: this.metrics,
    selectionManager: this.selectionManager,
    hoveredHyperlinkId: this.hoveredHyperlinkId,
    hoveredLinkRange: this.hoveredLinkRange,
    cursorStyle: this.cursorStyle,
    cursorBlinkVisible: this.cursorBlink_.isVisible(),
    atlas: this.atlas,
    kittyEnabled: true,
    blockElementShaderEnabled: true,
    maxKittyImages: 256,
  });
}
```

The `maxKittyImages: 256` line is the only addition.

- [ ] **Step 8: Verify**

```bash
bun run typecheck
bun test
```
Expected: full suite green. No tests directly cover WebGPU's render path (no stub-context tests for WebGPU), so we're relying on typecheck + manual demo verification (PB6).

- [ ] **Step 9: Format + commit**

```bash
npx prettier --write lib/renderer-webgpu.ts
npx prettier --check lib/renderer-webgpu.ts
git add lib/renderer-webgpu.ts
git commit -m "feat(render): migrate WebGPU virtual placements to shared kitty atlas"
```

---

## Task PB3: Cleanup — remove unused fields and setup

**Files:**
- Modify: `lib/renderer-webgpu.ts`

After PB2, several fields and setup lines are unused: `frameKittyViews` (was a local in render(), already gone), `dummyTexture`, `dummyView`, `placeholderSampler`. These were used to fill empty kitty texture slots in the old 16-binding layout. Remove them.

- [ ] **Step 1: Find usages**

```bash
grep -n "dummyTexture\|dummyView\|placeholderSampler\|placeholderSamp" lib/renderer-webgpu.ts
```

Should reveal:
- Field declarations (3 `private` lines for `dummyTexture`, `dummyView`, `placeholderSampler`)
- Allocation in `initialize()` (a `createTexture` for dummyTexture, a `writeTexture` to clear it, a `createSampler` for placeholderSampler)
- Possibly references in the bind-group-layout setup (already removed in PB2 step 4)
- References in textBindGroup construction (already removed in PB2 step 5)

- [ ] **Step 2: Remove field declarations**

Delete the three field declarations:
```ts
private dummyTexture?: GPUTexture;
private dummyView?: GPUTextureView;
private placeholderSampler?: GPUSampler;
```

- [ ] **Step 3: Remove the dummyTexture + dummyView setup**

In `initialize()`, find the block that creates `dummyTexture`, writes a 1×1 black pixel to it, and creates `dummyView`:

```ts
this.dummyTexture = this.device.createTexture({
  size: { width: 1, height: 1 },
  format: 'rgba8unorm',
  usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
  label: 'dummyKittyTex',
});
this.device.queue.writeTexture(
  { texture: this.dummyTexture },
  new Uint8Array([0, 0, 0, 0]).buffer,
  { bytesPerRow: 4 },
  { width: 1, height: 1 }
);
this.dummyView = this.dummyTexture.createView();
```

Delete the entire block.

- [ ] **Step 4: Remove the placeholderSampler setup**

In `initialize()`, find:

```ts
this.placeholderSampler = this.device.createSampler({
  magFilter: 'nearest',
  minFilter: 'nearest',
  label: 'placeholderSampler',
});
```

Delete this block.

- [ ] **Step 5: Verify nothing references the removed fields**

```bash
grep -n "dummyTexture\|dummyView\|placeholderSampler\|placeholderSamp\|frameKittyViews" lib/renderer-webgpu.ts
```
Expected: no results (or only WGSL strings — but those should also be empty since the WGSL was rewritten in PB2).

- [ ] **Step 6: Verify build + tests**

```bash
bun run typecheck
bun test
```
Expected: full suite green.

- [ ] **Step 7: Format + commit**

```bash
npx prettier --write lib/renderer-webgpu.ts
npx prettier --check lib/renderer-webgpu.ts
git add lib/renderer-webgpu.ts
git commit -m "refactor(render): remove now-unused dummyTexture/placeholderSampler from WebGPU"
```

---

## Task PB4: `destroy()` releases new kitty resources

**Files:**
- Modify: `lib/renderer-webgpu.ts`

PB1 added `kittyAtlas` and `kittyAtlasUBO`. Add their cleanup to `destroy()`. The pre-existing T6-style follow-up TODO for non-kitty resources (paletteUBO, gridUBO, glyph atlas, cellBuffer, pipelines, etc.) stays as-is.

- [ ] **Step 1: Update `destroy()`**

Find the existing `destroy()` method. After Phase A's K5 + the post-review fix, it should look approximately like:

```ts
destroy(): void {
  this.destroyed = true;
  this.cursorBlink_.destroy();
  this.kittyTextures.destroyAll();
  for (const buf of this.kittyParamsRing) buf.destroy();
  this.kittyParamsRing.length = 0;
  // device.destroy() left to caller; we don't own it. ...
}
```

Add the new cleanup lines:

```ts
destroy(): void {
  this.destroyed = true;
  this.cursorBlink_.destroy();
  this.kittyTextures.destroyAll();
  for (const buf of this.kittyParamsRing) buf.destroy();
  this.kittyParamsRing.length = 0;
  this.kittyAtlas?.destroy();
  if (this.kittyAtlasUBO) this.kittyAtlasUBO.destroy();
  // device.destroy() left to caller; we don't own it. Other resources
  // (paletteUBO, gridUBO, glyph atlas, cellBuffer, pipelines, etc.) are
  // owned by the device and reclaimed when it is destroyed.
}
```

- [ ] **Step 2: Verify**

```bash
bun run typecheck
bun test
```
Expected: full suite green.

- [ ] **Step 3: Format + commit**

```bash
npx prettier --write lib/renderer-webgpu.ts
npx prettier --check lib/renderer-webgpu.ts
git add lib/renderer-webgpu.ts
git commit -m "feat(render): WebGPU destroy() releases kittyAtlas + UBO"
```

---

## Task PB5: Drop the factory `requiredLimits` workaround

**Files:**
- Modify: `lib/renderer-factory.ts`
- Possibly: `lib/renderer-factory.test.ts` (spot-check only)

The text shader binding count drops from 17 to 2 sampled textures. The `requiredLimits.maxSampledTexturesPerShaderStage` adapter-bumping is no longer needed.

- [ ] **Step 1: Update `tryWebGPU` in `lib/renderer-factory.ts`**

Find the existing `tryWebGPU` function. The relevant block (approximately lines 35-46):

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
return await WebGPURenderer.create(canvas, device, opts);
```

Replace with:

```ts
const adapter = await gpu.requestAdapter({ powerPreference: 'high-performance' });
if (!adapter) {
  if (explicit) throw new Error('WebGPU adapter unavailable');
  return null;
}
// As of Phase B (2026-05-09), the WebGPU text shader binds 2 sampled
// textures (glyph atlas + kitty atlas), well within the default 16-per-stage
// limit. No requiredLimits bumping needed. See
// docs/superpowers/specs/2026-05-09-webgpu-kitty-atlas-design.md.
const device = await adapter.requestDevice();
return await WebGPURenderer.create(canvas, device, opts);
```

If there's an explanatory comment block above this code (about the 17-sampler limit, restored as a follow-up to T14), remove or replace it with the new comment.

- [ ] **Step 2: Spot-check the factory tests**

```bash
grep -n "requiredLimits\|maxSampledTextures" lib/renderer-factory.test.ts
```

If the grep returns no matches: no test changes needed (the existing tests stub at `requestAdapter`, never reaching `requestDevice`). If it returns matches, read the test and update accordingly — the test was probably asserting the `requiredLimits` argument shape and now needs to assert it's empty/unset.

- [ ] **Step 3: Verify**

```bash
bun run typecheck
bun test lib/renderer-factory.test.ts
bun test
```
Expected: full suite green.

- [ ] **Step 4: Format + commit**

```bash
npx prettier --write lib/renderer-factory.ts
npx prettier --check lib/renderer-factory.ts
git add lib/renderer-factory.ts lib/renderer-factory.test.ts
git commit -m "refactor(render): drop maxSampledTexturesPerShaderStage workaround"
```

(If `lib/renderer-factory.test.ts` wasn't modified, omit it from `git add`.)

---

## Task PB6: Manual demo verification

**Files:**
- (No code changes; verification only)

The same manual verification steps from Phase A's K13, but focused on WebGPU.

- [ ] **Step 1: Run the demo**

```bash
bun run demo
```

Open `http://localhost:8080/?renderer=webgpu` in a browser.

- [ ] **Step 2: Test direct placements (regression check)**

```bash
kitten icat /path/to/some/image.png
```

Expected: image renders inline. The direct-placement code path was untouched in Phase B; this confirms no regression.

- [ ] **Step 3: Test virtual placements**

If you have a TUI tool that uses U+10EEEE virtual placements (ranger image previews, kitty kittens that embed images), navigate to a directory with images and trigger a preview. Compare to:
- `?renderer=webgl` in another tab — visual parity check (both backends now use the atlas approach)
- Pre-Phase-B WebGPU behavior (anecdotally, from earlier tests) — should match.

If you don't have such a tool installed, this step is informational. Direct placements via `icat` cover the bigger use case.

- [ ] **Step 4: Test renderer-swap survival**

While an image is on screen in the WebGPU tab, press Alt+Shift+R to cycle to webgl. Image should continue rendering (both backends share the kitty-atlas approach). Press again to canvas2d (Canvas2D has its own kitty support per nm-kitty-meow). Press once more to return to webgpu. No crashes; image content reappears.

- [ ] **Step 5: (Optional) 16-sampler hardware test**

If you have access to a device that previously fell through to WebGL because its adapter reported exactly 16 sampled-textures-per-stage (Android Chrome on older GPUs is the most likely candidate), open the demo on that device and confirm it now stays on WebGPU. The FPS overlay shows the active backend; previously you'd see `webgl`, now you should see `webgpu`.

- [ ] **Step 6: Final pre-commit gate**

```bash
bun run fmt && bun run lint && bun run typecheck && bun test && bun run build
```

Pre-existing lint warnings in unrelated files (`lib/renderer.ts`, possibly some others) are NOT this plan's concern.

---

## Verification checklist

After all 6 tasks land:

- [ ] `bun test` reports all green (401 tests, no regressions)
- [ ] `bun run typecheck` clean
- [ ] `bun run build` produces `dist/` artifacts
- [ ] Manual: `kitten icat foo.png` in `?renderer=webgpu` renders the image
- [ ] No regression in WebGL or Canvas2D kitty rendering
- [ ] Auto-fallback chain unchanged for the common case
- [ ] Adapters reporting exactly 16 sampled-textures-per-stage now stay on WebGPU (if testable)

## Notes for the implementer

- **PB2 is the riskiest task.** It touches working WebGPU code that has no automated test coverage at the rendering level. Read `lib/renderer-webgl.ts`'s K11a / K10 / K7 / K8 changes side-by-side — Phase B is the WebGPU port of the same pattern. If anything is unclear, the WebGL implementation is the working reference.
- **The `kittyAtlas?.view()` call creates a new `GPUTextureView` per frame.** This matches the existing `atlas.view()` call for the glyph atlas. Cheap; not a perf concern.
- **`writeBuffer(kittyAtlasUBO, 0, kittyAtlasRects.buffer)` uploads the full 4096 bytes every frame.** A perf-conscious version would skip the upload when `usedKittyImageIds.length === 0`, but Phase A WebGL did the unconditional upload too — preserving symmetry.
- **WebGPU stub-context tests do not exist.** All Phase B verification beyond typecheck is manual. This is consistent with how Phase A's WebGPU touches (K5) were verified — through the existing 401-test suite for behavioral coverage and demo for visual coverage.
- **If you find a `// Task 16` reference in the comments,** that's a leftover from the original WebGPU work. Phase B doesn't need to touch it but you can update it to reference the new spec if convenient.
