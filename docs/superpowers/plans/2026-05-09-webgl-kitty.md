# Kitty Graphics on WebGL Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add kitty graphics support (direct + virtual placements) to the WebGL2 renderer using a shared `KittyAtlasBase` (variable-size shelf-packed atlas) for virtual placements, plus per-image textures for direct placements. Phase A only — WebGPU's virtual-placement code path stays untouched and migrates in a separate Phase B.

**Architecture:** Three new classes added to `lib/renderer-core.ts`: `KittyAtlasBase` (variable-size shelf packing for virtual placements), `KittyTextureCacheBase<T>` (per-image GPU texture cache with signature-based invalidation, used by direct placements), and a pure `kittyImageToRGBA` utility (RGB/GRAY/GRAY_ALPHA → RGBA8 conversion). WebGPU adopts the shared `KittyTextureCacheBase` for its direct-placement cache; otherwise WebGPU is unchanged. WebGL adds GLSL kitty shaders, a kitty program, a 4096-byte kitty rect UBO, a per-placement KittyParams UBO ring, and extends `TEXT_FS` with an atlas-based virtual-placement branch.

**Tech Stack:** TypeScript, WebGL2, GLSL ES 3.00. Test runner: `bun test`. Pre-commit: `bun run fmt && bun run lint && bun run typecheck && bun test && bun run build`.

**Spec:** `docs/superpowers/specs/2026-05-09-webgl-kitty-design.md`

---

## File Structure

| Path                         | Status         | Purpose                                                                                                                                                                                                                                            |
| ---------------------------- | -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `lib/renderer-core.ts`       | modify         | Add `kittyImageToRGBA`, `KittyTextureCacheBase<T>`, `KittyAtlasBase`; raise `EncodeCellsContext` with optional `maxKittyImages`                                                                                                                    |
| `lib/renderer-webgpu.ts`     | modify (small) | Replace inline `getOrUploadKittyTexture` + `kittyTextures` map with a `WebGPUKittyTextureCache extends KittyTextureCacheBase<GPUTexture>` subclass. Existing virtual-placement code path unchanged.                                                |
| `lib/renderer-webgl.ts`      | modify         | Add `GLKittyTextureCache`, `GLKittyAtlas`, kitty UBOs, kitty pipeline, `KITTY_VS`/`KITTY_FS`, extended `TEXT_FS`, kitty render path in `render()`, destroy() cleanup additions, encodeCells flag flip to `kittyEnabled: true, maxKittyImages: 256` |
| `lib/renderer-webgl.test.ts` | modify         | New tests for: kittyImageToRGBA, atlas packing, texture cache, kitty pipeline init, render path call shape                                                                                                                                         |
| `lib/renderer-core.test.ts`  | add            | Pure-logic tests for `kittyImageToRGBA`, `KittyTextureCacheBase`, `KittyAtlasBase` (test via stub subclasses without GL)                                                                                                                           |

## Reference snapshots

- `lib/renderer-webgpu.ts:392-434` — WGSL `KITTY_SHADER` (direct placements). Translation target for K9.
- `lib/renderer-webgpu.ts:243-252` — WGSL virtual-placement branch in `TEXT_SHADER`. Translation target for K10 (atlas-adapted).
- `lib/renderer-webgpu.ts:824-907` — `getOrUploadKittyTexture` (format conversion + signature-matching cache). Source for K1, K2, K5.
- `lib/renderer-webgpu.ts:1219-1277` — Direct-placement render-path walk + ring + draw loop. Translation target for K11b.
- `lib/renderer-webgpu.ts:545,654-657` — Kitty texture cache + ring + bind-group-layout fields.
- `lib/renderer-core.ts` (current state) — existing `GlyphAtlasBase`, `EncodeCellsContext`, `encodeCells` are the structural model for K2, K3, K4.

## Behavior preserved by Phase A

- WebGPU direct + virtual placements work identically to today (the only change is direct cache moves to a shared base class).
- WebGL with no kitty content renders identically to today.
- Auto fallback chain (WebGPU → WebGL → Canvas2D) unchanged.

---

## Task K1: `kittyImageToRGBA` utility

**Files:**

- Modify: `lib/renderer-core.ts` — append the function
- Add: `lib/renderer-core.test.ts` — new test file (or extend if it already exists; check first)

Pure CPU function converting `KittyImagePixels` to a packed RGBA8 `Uint8Array`. Lifted verbatim from WebGPU's inlined version at `lib/renderer-webgpu.ts:844-879`.

- [ ] **Step 1: Write failing tests**

If `lib/renderer-core.test.ts` doesn't exist yet, create it. Otherwise append to it.

```ts
import { describe, expect, test } from 'bun:test';
import { kittyImageToRGBA } from './renderer-core';
import { KittyImageFormat } from './types';

describe('kittyImageToRGBA', () => {
  test('RGBA passes through unchanged', () => {
    const data = new Uint8Array([10, 20, 30, 40, 50, 60, 70, 80]);
    const out = kittyImageToRGBA({ width: 2, height: 1, format: KittyImageFormat.RGBA, data });
    expect(out).not.toBeNull();
    expect(Array.from(out!)).toEqual([10, 20, 30, 40, 50, 60, 70, 80]);
  });

  test('RGB inserts alpha=255 per pixel', () => {
    const data = new Uint8Array([10, 20, 30, 40, 50, 60]);
    const out = kittyImageToRGBA({ width: 2, height: 1, format: KittyImageFormat.RGB, data });
    expect(out).not.toBeNull();
    expect(Array.from(out!)).toEqual([10, 20, 30, 255, 40, 50, 60, 255]);
  });

  test('GRAY broadcasts to RGB and inserts alpha=255', () => {
    const data = new Uint8Array([100, 200]);
    const out = kittyImageToRGBA({ width: 2, height: 1, format: KittyImageFormat.GRAY, data });
    expect(out).not.toBeNull();
    expect(Array.from(out!)).toEqual([100, 100, 100, 255, 200, 200, 200, 255]);
  });

  test('GRAY_ALPHA broadcasts gray and uses provided alpha', () => {
    const data = new Uint8Array([100, 50, 200, 150]);
    const out = kittyImageToRGBA({
      width: 2,
      height: 1,
      format: KittyImageFormat.GRAY_ALPHA,
      data,
    });
    expect(out).not.toBeNull();
    expect(Array.from(out!)).toEqual([100, 100, 100, 50, 200, 200, 200, 150]);
  });

  test('PNG (undecoded) returns null', () => {
    const out = kittyImageToRGBA({
      width: 2,
      height: 1,
      format: KittyImageFormat.PNG,
      data: new Uint8Array([1, 2, 3]),
    });
    expect(out).toBeNull();
  });

  test('zero-dimension image returns null', () => {
    const out = kittyImageToRGBA({
      width: 0,
      height: 1,
      format: KittyImageFormat.RGBA,
      data: new Uint8Array(0),
    });
    expect(out).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
bun test lib/renderer-core.test.ts
```

Expected: FAIL — `kittyImageToRGBA` not exported.

- [ ] **Step 3: Add the function to `lib/renderer-core.ts`**

Append (place near other utility functions, e.g. after `parseHexColor`):

```ts
import { KittyImageFormat } from './types';
import type { KittyImagePixels } from './types';

/**
 * Convert a `KittyImagePixels` payload (RGB / GRAY / GRAY_ALPHA / RGBA) to
 * a packed `width × height × 4` RGBA8 Uint8Array. Returns null for
 * unsupported formats (PNG should be pre-decoded; if it isn't, callers
 * skip the placement) or zero-dimension images.
 *
 * Lifted from the inlined WebGPU implementation; behavior is identical.
 */
export function kittyImageToRGBA(pixels: KittyImagePixels): Uint8Array | null {
  const { width, height, format, data } = pixels;
  if (width === 0 || height === 0) return null;
  const rgba = new Uint8Array(width * height * 4);
  switch (format) {
    case KittyImageFormat.RGBA:
      rgba.set(data);
      return rgba;
    case KittyImageFormat.RGB:
      for (let i = 0, o = 0; i < data.length; i += 3, o += 4) {
        rgba[o] = data[i]!;
        rgba[o + 1] = data[i + 1]!;
        rgba[o + 2] = data[i + 2]!;
        rgba[o + 3] = 255;
      }
      return rgba;
    case KittyImageFormat.GRAY:
      for (let i = 0, o = 0; i < data.length; i++, o += 4) {
        const v = data[i]!;
        rgba[o] = v;
        rgba[o + 1] = v;
        rgba[o + 2] = v;
        rgba[o + 3] = 255;
      }
      return rgba;
    case KittyImageFormat.GRAY_ALPHA:
      for (let i = 0, o = 0; i < data.length; i += 2, o += 4) {
        const v = data[i]!;
        rgba[o] = v;
        rgba[o + 1] = v;
        rgba[o + 2] = v;
        rgba[o + 3] = data[i + 1]!;
      }
      return rgba;
    default:
      return null; // PNG (should be pre-decoded) / unknown
  }
}
```

If `KittyImageFormat` and `KittyImagePixels` aren't already imported at the top of `renderer-core.ts`, hoist these imports there with the existing imports.

- [ ] **Step 4: Run tests to verify they pass**

```bash
bun test lib/renderer-core.test.ts
```

Expected: 6 pass.

- [ ] **Step 5: Verify full suite + format**

```bash
bun run typecheck
bun test
npx prettier --write lib/renderer-core.ts lib/renderer-core.test.ts
npx prettier --check lib/renderer-core.ts lib/renderer-core.test.ts
```

Expected: typecheck green; full suite green; prettier clean.

- [ ] **Step 6: Commit**

```bash
git add lib/renderer-core.ts lib/renderer-core.test.ts
git commit -m "feat(render): kittyImageToRGBA shared utility in renderer-core"
```

---

## Task K2: `KittyTextureCacheBase<T>` abstract class

**Files:**

- Modify: `lib/renderer-core.ts`
- Modify: `lib/renderer-core.test.ts`

Generic abstract class for per-image GPU texture caches with signature-based invalidation. Subclasses provide `createTexture`, `uploadFull`, and `destroyTexture` for their backend. Used by direct-placement code in both renderers.

- [ ] **Step 1: Write failing tests**

Append to `lib/renderer-core.test.ts`:

```ts
import { KittyTextureCacheBase } from './renderer-core';

describe('KittyTextureCacheBase', () => {
  // Concrete stub subclass for testing — no GL needed.
  class StubCache extends KittyTextureCacheBase<{ id: number }> {
    public created: Array<{ id: number; w: number; h: number }> = [];
    public destroyed: Array<{ id: number }> = [];
    public uploaded: Array<{ id: number; bytes: number }> = [];
    private nextId = 1;
    protected createTexture(_w: number, _h: number): { id: number } | null {
      const t = { id: this.nextId++ };
      this.created.push({ id: t.id, w: _w, h: _h });
      return t;
    }
    protected uploadFull(handle: { id: number }, rgba: Uint8Array, _w: number, _h: number): void {
      this.uploaded.push({ id: handle.id, bytes: rgba.length });
    }
    protected destroyTexture(handle: { id: number }): void {
      this.destroyed.push({ id: handle.id });
    }
  }

  test('first call creates and uploads', () => {
    const cache = new StubCache();
    const px = {
      width: 2,
      height: 1,
      format: 1, // RGBA
      data: new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]),
    };
    const handle = cache.getOrUpload(42, px as any);
    expect(handle).not.toBeNull();
    expect(cache.created.length).toBe(1);
    expect(cache.uploaded.length).toBe(1);
  });

  test('second call with identical signature returns cached handle', () => {
    const cache = new StubCache();
    const px = {
      width: 2,
      height: 1,
      format: 1,
      data: new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]),
    };
    const a = cache.getOrUpload(42, px as any);
    const b = cache.getOrUpload(42, px as any);
    expect(a).toBe(b);
    expect(cache.created.length).toBe(1); // no new texture
  });

  test('signature mismatch destroys old and creates new', () => {
    const cache = new StubCache();
    const px1 = {
      width: 2,
      height: 1,
      format: 1,
      data: new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]),
    };
    const px2 = {
      width: 2,
      height: 1,
      format: 1,
      data: new Uint8Array([10, 20, 30, 40, 50, 60, 70, 80]),
    };
    cache.getOrUpload(42, px1 as any);
    cache.getOrUpload(42, px2 as any);
    expect(cache.created.length).toBe(2);
    expect(cache.destroyed.length).toBe(1);
  });

  test('unsupported format returns null without creating', () => {
    const cache = new StubCache();
    const px = {
      width: 2,
      height: 1,
      format: 2, // PNG
      data: new Uint8Array([1, 2, 3]),
    };
    const handle = cache.getOrUpload(42, px as any);
    expect(handle).toBeNull();
    expect(cache.created.length).toBe(0);
  });

  test('destroyAll cleans up every entry', () => {
    const cache = new StubCache();
    const px = {
      width: 2,
      height: 1,
      format: 1,
      data: new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]),
    };
    cache.getOrUpload(42, px as any);
    cache.getOrUpload(43, px as any);
    cache.destroyAll();
    expect(cache.destroyed.length).toBe(2);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
bun test lib/renderer-core.test.ts -t "KittyTextureCacheBase"
```

Expected: FAIL — class not exported.

- [ ] **Step 3: Add the class to `lib/renderer-core.ts`**

Append after `kittyImageToRGBA`:

```ts
/**
 * Per-image GPU texture cache for direct-placement kitty images, abstract
 * over backend texture handles. Subclasses provide createTexture / uploadFull
 * / destroyTexture for their backend.
 *
 * Cache is keyed by imageId. Each entry stores a signature (width, height,
 * format, data byteOffset, data length) so we re-upload only when the
 * underlying image data changes (caller passes the same KittyImagePixels
 * object whose .data is a view into WASM memory; if the WASM image changes
 * the byteOffset/length will too).
 */
export abstract class KittyTextureCacheBase<TBackendTexture> {
  private cache = new Map<
    number,
    {
      handle: TBackendTexture;
      width: number;
      height: number;
      format: number;
      dataPtr: number;
      dataLen: number;
    }
  >();

  protected abstract createTexture(width: number, height: number): TBackendTexture | null;
  protected abstract uploadFull(
    handle: TBackendTexture,
    rgba: Uint8Array,
    width: number,
    height: number
  ): void;
  protected abstract destroyTexture(handle: TBackendTexture): void;

  /**
   * Returns the cached or newly-uploaded texture for the given imageId.
   * Returns null if the image cannot be converted (e.g. undecoded PNG) or
   * if texture allocation fails.
   */
  getOrUpload(imageId: number, pixels: KittyImagePixels): TBackendTexture | null {
    const cached = this.cache.get(imageId);
    const sigMatches =
      cached &&
      cached.width === pixels.width &&
      cached.height === pixels.height &&
      cached.format === pixels.format &&
      cached.dataPtr === pixels.data.byteOffset &&
      cached.dataLen === pixels.data.length;
    if (sigMatches) return cached.handle;

    const rgba = kittyImageToRGBA(pixels);
    if (!rgba) return null;

    if (cached) this.destroyTexture(cached.handle);
    const handle = this.createTexture(pixels.width, pixels.height);
    if (!handle) return null;
    this.uploadFull(handle, rgba, pixels.width, pixels.height);
    this.cache.set(imageId, {
      handle,
      width: pixels.width,
      height: pixels.height,
      format: pixels.format,
      dataPtr: pixels.data.byteOffset,
      dataLen: pixels.data.length,
    });
    return handle;
  }

  /** Lookup without upload. */
  get(imageId: number): TBackendTexture | undefined {
    return this.cache.get(imageId)?.handle;
  }

  /** Release all backend textures. Called by renderer destroy(). */
  destroyAll(): void {
    for (const entry of this.cache.values()) this.destroyTexture(entry.handle);
    this.cache.clear();
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
bun test lib/renderer-core.test.ts -t "KittyTextureCacheBase"
```

Expected: 5 pass.

- [ ] **Step 5: Verify full suite + format**

```bash
bun run typecheck && bun test
npx prettier --write lib/renderer-core.ts lib/renderer-core.test.ts
npx prettier --check lib/renderer-core.ts lib/renderer-core.test.ts
```

- [ ] **Step 6: Commit**

```bash
git add lib/renderer-core.ts lib/renderer-core.test.ts
git commit -m "feat(render): KittyTextureCacheBase shared in renderer-core"
```

---

## Task K3: `KittyAtlasBase` abstract class

**Files:**

- Modify: `lib/renderer-core.ts`
- Modify: `lib/renderer-core.test.ts`

Variable-size shelf-packed atlas for virtual-placement images. Subclasses provide `uploadRegion` and (no-op) `growTexture`.

- [ ] **Step 1: Write failing tests**

Append to `lib/renderer-core.test.ts`:

```ts
import { KittyAtlasBase, type AtlasSlot } from './renderer-core';

describe('KittyAtlasBase', () => {
  // Concrete stub subclass — no GL.
  class StubAtlas extends KittyAtlasBase {
    public uploads: Array<{ slot: AtlasSlot; w: number; h: number }> = [];
    constructor(size = 1024) {
      super(size);
    }
    protected uploadRegion(slot: AtlasSlot, _rgba: Uint8Array, w: number, h: number): void {
      this.uploads.push({ slot: { ...slot }, w, h });
    }
    protected growTexture(_newSize: number): void {
      /* v1: no-op */
    }
  }

  function pixels(width: number, height: number, dataLen = width * height * 4) {
    return {
      width,
      height,
      format: 1, // RGBA
      data: new Uint8Array(dataLen),
    } as any;
  }

  test('first add packs at (0,0)', () => {
    const atlas = new StubAtlas();
    const e = atlas.addOrUpdate(1, pixels(64, 32));
    expect(e).not.toBeNull();
    expect(e!.slot).toEqual({ u: 0, v: 0, w: 64, h: 32 });
    expect(atlas.uploads.length).toBe(1);
  });

  test('second add lands to the right of the first on the same shelf', () => {
    const atlas = new StubAtlas();
    atlas.addOrUpdate(1, pixels(64, 32));
    const e = atlas.addOrUpdate(2, pixels(64, 32));
    expect(e!.slot).toEqual({ u: 64, v: 0, w: 64, h: 32 });
  });

  test('signature match returns cached entry, no re-upload', () => {
    const atlas = new StubAtlas();
    const a = atlas.addOrUpdate(1, pixels(64, 32));
    const b = atlas.addOrUpdate(1, pixels(64, 32));
    expect(b).toBe(a);
    expect(atlas.uploads.length).toBe(1); // no second upload
  });

  test('overflow triggers clearAndReset and packs at (0,0) again', () => {
    const atlas = new StubAtlas(128); // small atlas
    const e1 = atlas.addOrUpdate(1, pixels(64, 64));
    const e2 = atlas.addOrUpdate(2, pixels(64, 64));
    // shelf 1 full; next add wraps to second shelf at v=64
    const e3 = atlas.addOrUpdate(3, pixels(64, 64));
    // now image 4 at 64x64 won't fit (would land at v=128, overflow)
    const e4 = atlas.addOrUpdate(4, pixels(64, 64));
    // After clearAndReset, image 4 packs at (0,0). Cache for 1/2/3 cleared.
    expect(e4).not.toBeNull();
    expect(e4!.slot).toEqual({ u: 0, v: 0, w: 64, h: 64 });
    expect(atlas.getEntry(1)).toBeUndefined();
    expect(atlas.getEntry(4)).toBe(e4!);
  });

  test('image larger than atlas returns null after retry', () => {
    const atlas = new StubAtlas(128);
    const e = atlas.addOrUpdate(1, pixels(256, 256));
    expect(e).toBeNull();
  });

  test('atlasSize getter returns current size', () => {
    const atlas = new StubAtlas(2048);
    expect(atlas.atlasSize).toBe(2048);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
bun test lib/renderer-core.test.ts -t "KittyAtlasBase"
```

Expected: FAIL — class not exported.

- [ ] **Step 3: Add the class to `lib/renderer-core.ts`**

Append after `KittyTextureCacheBase`:

```ts
export type KittyAtlasEntry = {
  slot: AtlasSlot;
  signature: { width: number; height: number; format: number; dataPtr: number; dataLen: number };
};

/**
 * Variable-size shelf-packed atlas for virtual-placement kitty images.
 * Parallel to GlyphAtlasBase but for arbitrary-dimension RGBA8 images.
 *
 * v1 is fixed-size (1024² by default). On overflow, clears the entire
 * cache + packing cursor and retries once. If the image is still too big,
 * returns null and the caller skips that placement for the frame.
 *
 * Subclasses provide the backend texture upload primitive.
 */
export abstract class KittyAtlasBase {
  protected size: number;
  private nextX = 0;
  private nextY = 0;
  private rowHeight = 0;
  private cache = new Map<number, KittyAtlasEntry>();

  constructor(size = 1024) {
    this.size = size;
  }

  /** Subclass: upload a freshly-converted RGBA region into the backing texture. */
  protected abstract uploadRegion(slot: AtlasSlot, rgba: Uint8Array, w: number, h: number): void;

  /** Subclass: grow the backing texture (v1 callers pass the existing size; reserved). */
  protected abstract growTexture(newSize: number): void;

  /**
   * Add (or refresh) the image for `imageId`. On signature match returns the
   * cached entry. On miss converts to RGBA, shelf-packs into the atlas, and
   * uploads. Returns null if conversion fails or the image doesn't fit even
   * after one clearAndReset retry.
   */
  addOrUpdate(imageId: number, pixels: KittyImagePixels): KittyAtlasEntry | null {
    const cached = this.cache.get(imageId);
    const sigMatches =
      cached &&
      cached.signature.width === pixels.width &&
      cached.signature.height === pixels.height &&
      cached.signature.format === pixels.format &&
      cached.signature.dataPtr === pixels.data.byteOffset &&
      cached.signature.dataLen === pixels.data.length;
    if (sigMatches) return cached;

    const rgba = kittyImageToRGBA(pixels);
    if (!rgba) return null;

    let slot = this.tryPack(pixels.width, pixels.height);
    if (!slot) {
      this.clearAndReset();
      slot = this.tryPack(pixels.width, pixels.height);
      if (!slot) return null; // image larger than the entire atlas
    }
    this.uploadRegion(slot, rgba, pixels.width, pixels.height);
    const entry: KittyAtlasEntry = {
      slot,
      signature: {
        width: pixels.width,
        height: pixels.height,
        format: pixels.format,
        dataPtr: pixels.data.byteOffset,
        dataLen: pixels.data.length,
      },
    };
    this.cache.set(imageId, entry);
    return entry;
  }

  /** Lookup a cached entry without uploading. */
  getEntry(imageId: number): KittyAtlasEntry | undefined {
    return this.cache.get(imageId);
  }

  /** Clear cache + reset packing cursor. Surviving images get re-uploaded on next walk. */
  clearAndReset(): void {
    this.cache.clear();
    this.nextX = 0;
    this.nextY = 0;
    this.rowHeight = 0;
  }

  get atlasSize(): number {
    return this.size;
  }

  private tryPack(w: number, h: number): AtlasSlot | null {
    if (w > this.size || h > this.size) return null;
    if (this.nextX + w > this.size) {
      this.nextX = 0;
      this.nextY += this.rowHeight;
      this.rowHeight = 0;
    }
    if (this.nextY + h > this.size) return null;
    const slot: AtlasSlot = { u: this.nextX, v: this.nextY, w, h };
    this.nextX += w;
    if (h > this.rowHeight) this.rowHeight = h;
    return slot;
  }
}
```

`AtlasSlot` is already exported from `renderer-core.ts` (introduced in R3); reuse it.

- [ ] **Step 4: Run tests to verify they pass**

```bash
bun test lib/renderer-core.test.ts -t "KittyAtlasBase"
```

Expected: 6 pass.

- [ ] **Step 5: Verify full suite + format**

```bash
bun run typecheck && bun test
npx prettier --write lib/renderer-core.ts lib/renderer-core.test.ts
npx prettier --check lib/renderer-core.ts lib/renderer-core.test.ts
```

- [ ] **Step 6: Commit**

```bash
git add lib/renderer-core.ts lib/renderer-core.test.ts
git commit -m "feat(render): KittyAtlasBase shared in renderer-core"
```

---

## Task K4: `EncodeCellsContext.maxKittyImages`

**Files:**

- Modify: `lib/renderer-core.ts`

Add an optional `maxKittyImages` field to `EncodeCellsContext`, defaulting to 16 (current cap, hardcoded today). WebGPU keeps 16; WebGL will pass 256 in K11.

- [ ] **Step 1: Modify `EncodeCellsContext` and `encodeCells`**

In `lib/renderer-core.ts`, find the `EncodeCellsContext` interface and add the field:

```ts
export interface EncodeCellsContext {
  metrics: FontMetrics;
  selectionManager: SelectionManager | undefined;
  hoveredHyperlinkId: number;
  hoveredLinkRange: LinkRange | null;
  cursorStyle: 'block' | 'underline' | 'bar';
  cursorBlinkVisible: boolean;
  atlas: GlyphAtlasBase | undefined;
  kittyEnabled: boolean;
  blockElementShaderEnabled: boolean;
  /**
   * Maximum number of distinct kitty image ids to track in usedKittyImageIds
   * for this frame. Cells whose imageId would exceed this cap render as
   * background only. Defaults to 16 (WebGPU's 16-sampler limit). WebGL with
   * the kitty atlas can safely raise this to e.g. 256.
   */
  maxKittyImages?: number;
}
```

In `encodeCells` body, find the line that caps `usedKittyImageIds.length < 16` and replace with the configurable cap:

```ts
const maxKitty = ctx.maxKittyImages ?? 16;
// ... later, in the kitty walk:
if (!usedKittyImageIndex.has(p.imageId) && usedKittyImageIds.length < maxKitty) {
```

- [ ] **Step 2: Verify**

```bash
bun run typecheck && bun test
```

Expected: full suite green (all 379+ tests including the new K1-K3 ones; existing encodeCells tests use no `maxKittyImages` so they still get 16 by default).

- [ ] **Step 3: Format + commit**

```bash
npx prettier --write lib/renderer-core.ts
git add lib/renderer-core.ts
git commit -m "feat(render): EncodeCellsContext.maxKittyImages (default 16)"
```

---

## Task K5: WebGPU adopts `KittyTextureCacheBase` for direct-placement cache

**Files:**

- Modify: `lib/renderer-webgpu.ts`

Replace the existing inline `kittyTextures` map and `getOrUploadKittyTexture` method with a `WebGPUKittyTextureCache extends KittyTextureCacheBase<GPUTexture>` subclass. Pure refactor; existing WebGPU behavior unchanged.

- [ ] **Step 1: Add the subclass and replace the cache**

In `lib/renderer-webgpu.ts`:

1. Remove the existing `kittyTextures` field (search for `private kittyTextures = new Map<...>`) and the existing `KittyTextureEntry` type.

2. Remove the existing `getOrUploadKittyTexture` method body (lines 824-907 area).

3. Add the import at the top of the file:

```ts
import { KittyTextureCacheBase, kittyImageToRGBA } from './renderer-core';
```

(`kittyImageToRGBA` may not be needed in this file if the subclass handles everything via the base — verify.)

4. Add the subclass — place near the top of the file with other supporting classes (e.g. just after `GlyphAtlas`):

```ts
class WebGPUKittyTextureCache extends KittyTextureCacheBase<GPUTexture> {
  constructor(private device: GPUDevice) {
    super();
  }
  protected createTexture(width: number, height: number): GPUTexture | null {
    return this.device.createTexture({
      size: { width, height },
      format: 'rgba8unorm',
      usage:
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.COPY_DST |
        GPUTextureUsage.RENDER_ATTACHMENT,
      label: 'kittyImg',
    });
  }
  protected uploadFull(handle: GPUTexture, rgba: Uint8Array, width: number, height: number): void {
    this.device.queue.writeTexture(
      { texture: handle },
      rgba.buffer,
      { bytesPerRow: width * 4, rowsPerImage: height },
      { width, height }
    );
  }
  protected destroyTexture(handle: GPUTexture): void {
    handle.destroy();
  }
}
```

5. Replace the field declaration: instead of `private kittyTextures = new Map<...>`, declare:

```ts
private kittyTextures!: WebGPUKittyTextureCache;
```

(Use `!` to defer init; instantiate in `initialize()`.)

6. In `initialize()`, after `this.device = ...` is settled, add:

```ts
this.kittyTextures = new WebGPUKittyTextureCache(this.device);
```

7. Replace all call sites that did `this.getOrUploadKittyTexture(graphics, id, buffer)` (search for them — there are ~3 call sites in the render path). The new pattern is:

```ts
const pixels = buffer.getKittyImagePixels?.(graphics, imageId);
if (!pixels) {
  const cached = this.kittyTextures.get(imageId);
  if (!cached) continue; // or whatever the original null-handling was
  // use cached
}
const tex = this.kittyTextures.getOrUpload(imageId, pixels);
```

The original `getOrUploadKittyTexture` returned a `KittyTextureEntry` with `{ texture, view, width, height }`. Callers used `tex.view` for bind group entries and `tex.width`/`tex.height` for params. With the new `KittyTextureCacheBase`, `getOrUpload` returns just the `GPUTexture`. Callers need to call `.createView()` themselves and read `.width`/`.height` from the original `KittyImagePixels`.

For each of the ~3 call sites, refactor to:

```ts
// Old pattern at renderer-webgpu.ts:1006-1011 area:
//   const tex = this.getOrUploadKittyTexture(graphics2, id, buffer);
//   if (tex) frameKittyViews[s] = tex.view;
//
// New pattern:
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
```

For the direct-placement walk (the `for (const p of buffer.iterPlacements(graphics, true))` block), the previous code used `tex.width` and `tex.height` from the cached entry. After refactor, read these from `pixels.width` / `pixels.height` (since `pixels` was just fetched). For cache hits, the dimensions are stored in the cache's signature — but `KittyTextureCacheBase.get(id)` only returns the texture handle, not the signature. To preserve dimension access on cache-hit-without-pixels, expose a `getSignature(id)` method — but actually, the previous code only ran when pixels were available (`getKittyImagePixels` returned non-null), so the dimensions were always from the freshly fetched pixels. Safe to keep that pattern.

The `KittyTextureEntry` type can be deleted entirely.

- [ ] **Step 2: Verify all WebGPU tests still pass**

```bash
bun run typecheck && bun test
```

Expected: full suite green. The WebGPU renderer's behavior is unchanged from the user's perspective; only the internal cache class differs.

- [ ] **Step 3: Format + commit**

```bash
npx prettier --write lib/renderer-webgpu.ts
git add lib/renderer-webgpu.ts
git commit -m "refactor(render): WebGPU adopts KittyTextureCacheBase for direct-placement cache"
```

---

## Task K6: WebGL `GLKittyTextureCache` subclass

**Files:**

- Modify: `lib/renderer-webgl.ts`

Add `GLKittyTextureCache extends KittyTextureCacheBase<WebGLTexture>` and a private field. No render-path wiring yet — that comes in K11b.

- [ ] **Step 1: Add the subclass**

In `lib/renderer-webgl.ts`:

1. Add to the existing renderer-core import:

```ts
import { KittyTextureCacheBase /* , …existing … */ } from './renderer-core';
```

2. Add the subclass near `GLGlyphAtlas`:

```ts
class GLKittyTextureCache extends KittyTextureCacheBase<WebGLTexture> {
  constructor(private gl: WebGL2RenderingContext) {
    super();
  }
  protected createTexture(width: number, height: number): WebGLTexture | null {
    const gl = this.gl;
    const tex = gl.createTexture();
    if (!tex) return null;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, width, height);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return tex;
  }
  protected uploadFull(
    handle: WebGLTexture,
    rgba: Uint8Array,
    width: number,
    height: number
  ): void {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, handle);
    gl.pixelStorei(/* UNPACK_ALIGNMENT */ 0x0cf5, 1);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, rgba);
  }
  protected destroyTexture(handle: WebGLTexture): void {
    this.gl.deleteTexture(handle);
  }
}
```

Note: kitty images use `LINEAR` filter (smooth scaling), not `NEAREST` like glyph atlas. Matches the WebGPU `kittySampler` at `renderer-webgpu.ts:826-829`.

3. Add a field to `WebGL2Renderer`:

```ts
private kittyTextures!: GLKittyTextureCache;
```

4. In `initialize()`, after `this.gl = gl;`, instantiate:

```ts
this.kittyTextures = new GLKittyTextureCache(this.gl);
```

- [ ] **Step 2: Verify**

```bash
bun run typecheck && bun test
```

Expected: full suite green. The cache exists but isn't used yet.

- [ ] **Step 3: Format + commit**

```bash
npx prettier --write lib/renderer-webgl.ts
git add lib/renderer-webgl.ts
git commit -m "feat(render): GLKittyTextureCache subclass (no wiring yet)"
```

---

## Task K7: WebGL `GLKittyAtlas` subclass

**Files:**

- Modify: `lib/renderer-webgl.ts`

Add `GLKittyAtlas extends KittyAtlasBase` and a private field. Lazy-allocated in `resize()` like `GLGlyphAtlas`.

- [ ] **Step 1: Add the subclass**

In `lib/renderer-webgl.ts`:

1. Add to the renderer-core import:

```ts
import { KittyAtlasBase /* …existing… */ } from './renderer-core';
```

2. Add the subclass near `GLKittyTextureCache`:

```ts
class GLKittyAtlas extends KittyAtlasBase {
  private gl: WebGL2RenderingContext;
  private texture: WebGLTexture;

  constructor(gl: WebGL2RenderingContext, size = 1024) {
    super(size);
    this.gl = gl;
    const tex = gl.createTexture();
    if (!tex) throw new Error('GLKittyAtlas: createTexture failed');
    this.texture = tex;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, size, size);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  }

  glTexture(): WebGLTexture {
    return this.texture;
  }

  destroy(): void {
    this.gl.deleteTexture(this.texture);
  }

  protected uploadRegion(
    slot: { u: number; v: number; w: number; h: number },
    rgba: Uint8Array,
    w: number,
    h: number
  ): void {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.pixelStorei(/* UNPACK_ALIGNMENT */ 0x0cf5, 1);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, slot.u, slot.v, w, h, gl.RGBA, gl.UNSIGNED_BYTE, rgba);
  }

  protected growTexture(_newSize: number): void {
    // v1: never grows; clearAndReset reuses the existing texture.
  }
}
```

3. Add a field to `WebGL2Renderer`:

```ts
private kittyAtlas?: GLKittyAtlas;
```

4. In `resize()`, after the existing glyph atlas (re)allocation, add:

```ts
if (!this.kittyAtlas) {
  this.kittyAtlas = new GLKittyAtlas(this.gl);
}
// Note: the kitty atlas is fixed-size and persists across resizes.
```

- [ ] **Step 2: Verify**

```bash
bun run typecheck && bun test
```

Expected: full suite green.

- [ ] **Step 3: Format + commit**

```bash
npx prettier --write lib/renderer-webgl.ts
git add lib/renderer-webgl.ts
git commit -m "feat(render): GLKittyAtlas subclass (no wiring yet)"
```

---

## Task K8: WebGL kittyAtlasUBO allocation

**Files:**

- Modify: `lib/renderer-webgl.ts`

Allocate the 4096-byte rect lookup UBO in `initialize()` and a host-side `Float32Array(256 * 4)` for staging. No upload happens yet.

- [ ] **Step 1: Add field + allocation**

In `lib/renderer-webgl.ts`:

1. Add fields:

```ts
private kittyAtlasUBO?: WebGLBuffer;
private kittyAtlasRects = new Float32Array(256 * 4); // host-side staging
```

2. In `initialize()`, after the existing `paletteUBO` and `gridUBO` allocations, add:

```ts
this.kittyAtlasUBO = gl.createBuffer() ?? undefined;
if (!this.kittyAtlasUBO) throw new Error('WebGL2Renderer: createBuffer failed (kittyAtlasUBO)');
gl.bindBuffer(gl.UNIFORM_BUFFER, this.kittyAtlasUBO);
gl.bufferData(gl.UNIFORM_BUFFER, 256 * 4 * 4, gl.DYNAMIC_DRAW);
```

(256 vec4 = 1024 floats = 4096 bytes.)

- [ ] **Step 2: Verify**

```bash
bun run typecheck && bun test
```

Expected: full suite green.

- [ ] **Step 3: Format + commit**

```bash
npx prettier --write lib/renderer-webgl.ts
git add lib/renderer-webgl.ts
git commit -m "feat(render): WebGL kittyAtlasUBO allocation (no wiring yet)"
```

---

## Task K9: WebGL kitty direct-placement shaders + program

**Files:**

- Modify: `lib/renderer-webgl.ts`

Add `KITTY_VS` / `KITTY_FS` GLSL ES 3.00 sources mirroring WGSL `KITTY_SHADER`. Add `setupKittyProgram()` called from `initialize()`. Allocate the `kittyParamsRing`.

- [ ] **Step 1: Add shader sources**

Append to the existing GLSL constants block in `lib/renderer-webgl.ts` (after `CURSOR_FS`):

```ts
const KITTY_VS = `#version 300 es
precision highp float;
precision highp int;
layout(std140) uniform KittyParamsUBO {
  vec2 srcOrigin;
  vec2 srcSize;
  vec2 dstOrigin;
  vec2 dstSize;
  vec2 imgSize;
  vec2 canvasSize;
} kp;
out vec2 vUv;
const vec2 CORNERS[6] = vec2[6](
  vec2(0.0, 0.0), vec2(1.0, 0.0), vec2(1.0, 1.0),
  vec2(0.0, 0.0), vec2(1.0, 1.0), vec2(0.0, 1.0)
);
void main() {
  vec2 local = CORNERS[gl_VertexID];
  float cssX = kp.dstOrigin.x + local.x * kp.dstSize.x;
  float cssY = kp.dstOrigin.y + local.y * kp.dstSize.y;
  gl_Position = vec4(
    (cssX / kp.canvasSize.x) * 2.0 - 1.0,
    1.0 - (cssY / kp.canvasSize.y) * 2.0,
    0.0, 1.0
  );
  vUv = (kp.srcOrigin + local * kp.srcSize) / kp.imgSize;
}
`;

const KITTY_FS = `#version 300 es
precision highp float;
precision highp int;
uniform highp sampler2D uKittyImg;
in vec2 vUv;
out vec4 fragColor;
void main() {
  fragColor = texture(uKittyImg, vUv);
}
`;
```

- [ ] **Step 2: Add `setupKittyProgram()` + ring**

Add fields:

```ts
private kittyProgram?: WebGLProgram;
private kittyProgramUniforms = {
  kittyImg: null as WebGLUniformLocation | null,
};
private kittyParamsRing: WebGLBuffer[] = [];
```

Add the method:

```ts
private setupKittyProgram(): void {
  const gl = this.gl;
  const prog = this.buildProgram(KITTY_VS, KITTY_FS, 'kitty');
  this.kittyProgram = prog;
  // KittyParamsUBO is bound to slot 0 (kitty pipeline's only block).
  gl.uniformBlockBinding(prog, gl.getUniformBlockIndex(prog, 'KittyParamsUBO'), 0);
  this.kittyProgramUniforms.kittyImg = gl.getUniformLocation(prog, 'uKittyImg');
  gl.useProgram(prog);
  gl.uniform1i(this.kittyProgramUniforms.kittyImg, 0);
}

private ensureKittyRingSize(n: number): void {
  const gl = this.gl;
  while (this.kittyParamsRing.length < n) {
    const buf = gl.createBuffer();
    if (!buf) throw new Error('WebGL2Renderer: createBuffer failed (kittyParamsRing)');
    gl.bindBuffer(gl.UNIFORM_BUFFER, buf);
    gl.bufferData(gl.UNIFORM_BUFFER, 64, gl.DYNAMIC_DRAW); // 16 floats
    this.kittyParamsRing.push(buf);
  }
}
```

In `initialize()`, after `setupCursorProgram()`, call:

```ts
this.setupKittyProgram();
```

- [ ] **Step 3: Add a smoke test**

Append to `lib/renderer-webgl.test.ts`:

```ts
describe('kitty program', () => {
  test('initialize() compiles + links the kitty program (3 programs total)', async () => {
    const canvas = document.createElement('canvas');
    await WebGL2Renderer.create(canvas, {});
    const stub = getStub();
    // Text + cursor + kitty = 3 programs → 6 compileShader, 3 linkProgram (minimum).
    expect(stub.countCalls('compileShader')).toBeGreaterThanOrEqual(6);
    expect(stub.countCalls('linkProgram')).toBeGreaterThanOrEqual(3);
  });
});
```

- [ ] **Step 4: Verify**

```bash
bun run typecheck && bun test lib/renderer-webgl.test.ts
```

Expected: new test passes; full suite green.

- [ ] **Step 5: Format + commit**

```bash
npx prettier --write lib/renderer-webgl.ts lib/renderer-webgl.test.ts
git add lib/renderer-webgl.ts lib/renderer-webgl.test.ts
git commit -m "feat(render): WebGL kitty direct-placement shaders + program"
```

---

## Task K10: Extend `TEXT_FS` with kitty atlas branch

**Files:**

- Modify: `lib/renderer-webgl.ts`

Add `uniform highp sampler2D uKittyAtlas` (texture unit 2) and a `KittyAtlasUBO` block to the text fragment shader. Bind in `setupTextProgram()`. The branch is in place but won't render anything yet because no cell will carry `FLAG_IS_KITTY_PLACEHOLDER` until K11.

- [ ] **Step 1: Modify `TEXT_FS`**

Find `TEXT_FS` in `lib/renderer-webgl.ts`. After the existing `uniform highp sampler2D uAtlasTex;` line, add:

```glsl
uniform highp sampler2D uKittyAtlas;
layout(std140) uniform KittyAtlasUBO {
  vec4 rects[256];
} kittyAtlas;
```

Then in `void main()`, immediately after the existing `if ((flags & FLAG_INVISIBLE) != 0u) { fragColor = vec4(bg, 1.0); return; }` line, add the kitty branch:

```glsl
if ((flags & FLAG_IS_KITTY_PLACEHOLDER) != 0u) {
  // Slice + grid encoded in c1.y / c1.w (was blockOrSlice / _r in WGSL).
  uint sliceCol = c1.y & 0xffffu;
  uint sliceRow = (c1.y >> 16) & 0xffffu;
  uint gridCols = c1.w & 0xffffu;
  uint gridRows = (c1.w >> 16) & 0xffffu;
  float uvX = (float(sliceCol) + vUv.x) / float(gridCols);
  float uvY = (float(sliceRow) + vUv.y) / float(gridRows);
  // c1.z holds the kittyImageIndex (0..255). Look up the atlas rect for that index.
  uint imgIdx = c1.z;
  vec4 rect = kittyAtlas.rects[imgIdx];  // (uMin, vMin, uMax, vMax) in atlas-normalized coords
  vec2 atlasUv = mix(rect.xy, rect.zw, vec2(uvX, uvY));
  fragColor = texture(uKittyAtlas, atlasUv);
  return;
}
```

Verify that `FLAG_IS_KITTY_PLACEHOLDER` is declared in `TEXT_FS`'s flag-constants block. It currently isn't (the WebGL renderer omitted it because nothing referenced it). Add to the constants block:

```glsl
const uint FLAG_IS_KITTY_PLACEHOLDER = 1u << 11;
```

- [ ] **Step 2: Bind kitty atlas in `setupTextProgram()`**

Find `setupTextProgram()`. After the existing two `uniformBlockBinding` calls (for `GridUBO` slot 0 and `PaletteUBO` slot 1), add:

```ts
gl.uniformBlockBinding(prog, gl.getUniformBlockIndex(prog, 'KittyAtlasUBO'), 2);
```

After the existing two `getUniformLocation` + `uniform1i` calls (for `uCellTex` unit 0 and `uAtlasTex` unit 1), add:

```ts
const kittyAtlasLoc = gl.getUniformLocation(prog, 'uKittyAtlas');
gl.uniform1i(kittyAtlasLoc, 2);
```

(No need to store this in `textProgramUniforms` — just bound once at setup.)

Also extend `textProgramUniforms` shape if helpful, or leave as-is.

- [ ] **Step 3: Verify shaders still compile**

```bash
bun run typecheck && bun test lib/renderer-webgl.test.ts
```

Expected: existing tests pass. The added shader code compiles in stub-context (the stub returns COMPILE_STATUS=true regardless). No visual change yet (no cell sets `FLAG_IS_KITTY_PLACEHOLDER` from the WebGL encode walk yet).

- [ ] **Step 4: Format + commit**

```bash
npx prettier --write lib/renderer-webgl.ts
git add lib/renderer-webgl.ts
git commit -m "feat(render): WebGL TEXT_FS extended with kitty atlas branch"
```

---

## Task K11a: WebGL virtual-placement render path

**Files:**

- Modify: `lib/renderer-webgl.ts`
- Modify: `lib/renderer-webgl.test.ts`

Flip `kittyEnabled: true, maxKittyImages: 256` in encodeCells. Walk `usedKittyImageIds`, populate the kitty atlas, build the rect UBO bytes, upload, bind in the text pass.

- [ ] **Step 1: Write the failing tests**

Append to `lib/renderer-webgl.test.ts`:

```ts
describe('virtual kitty placements (WebGL)', () => {
  test('render with virtual placement uploads kitty atlas + rect UBO', async () => {
    const canvas = document.createElement('canvas');
    const r = await WebGL2Renderer.create(canvas, {});
    r.resize(2, 1);
    const stub = getStub();
    stub.calls.length = 0;
    const placement = {
      imageId: 7,
      pixelWidth: 32,
      pixelHeight: 32,
      gridCols: 2,
      gridRows: 1,
      viewportCol: 0,
      viewportRow: 0,
      viewportVisible: true,
      sourceX: 0,
      sourceY: 0,
      sourceWidth: 32,
      sourceHeight: 32,
      isVirtual: true,
    };
    const buf = {
      getLine: (y: number) => null,
      getCursor: () => ({ x: 0, y: 0, visible: false }),
      getDimensions: () => ({ cols: 2, rows: 1 }),
      isRowDirty: () => false,
      clearDirty: () => {},
      getKittyGraphics: () => 1,
      iterPlacements: function* (_g: number, _onlyVisible?: boolean) {
        yield placement;
      },
      getKittyImagePixels: (_g: number, id: number) =>
        id === 7
          ? {
              width: 32,
              height: 32,
              format: 1,
              data: new Uint8Array(32 * 32 * 4),
            }
          : null,
    };
    r.render(buf as any, 0);
    // Should have at least one texSubImage2D for the kitty atlas (RGBA / UNSIGNED_BYTE,
    // distinguishable from the cellTex's RGBA_INTEGER + UNSIGNED_INT and the glyph atlas's
    // smaller per-glyph uploads).
    const kittyAtlasUploads = stub.calls.filter(
      (c) =>
        c.method === 'texSubImage2D' &&
        c.args.includes(0x1908) /* RGBA */ &&
        // Width = 32 (atlas region size for our placement).
        (c.args[4] === 32 || c.args[5] === 32)
    );
    expect(kittyAtlasUploads.length).toBeGreaterThan(0);
    // Should bind 3 UBOs (grid=0, palette=1, kittyAtlas=2) at some point.
    const baseBindings = stub.calls
      .filter((c) => c.method === 'bindBufferBase')
      .map((c) => c.args[1] as number);
    expect(baseBindings).toContain(2);
  });

  test('render with no kitty content does not bind UBO slot 2', async () => {
    const canvas = document.createElement('canvas');
    const r = await WebGL2Renderer.create(canvas, {});
    r.resize(2, 1);
    const stub = getStub();
    stub.calls.length = 0;
    const buf = {
      getLine: () => null,
      getCursor: () => ({ x: 0, y: 0, visible: false }),
      getDimensions: () => ({ cols: 2, rows: 1 }),
      isRowDirty: () => false,
      clearDirty: () => {},
    };
    r.render(buf as any, 0);
    // Without kitty content, the kitty atlas UBO should still be bound to slot 2
    // because the text pass references KittyAtlasUBO (the rects are zero, but the
    // binding is required for the program to validate). Verify it's bound.
    const baseBindings = stub.calls
      .filter((c) => c.method === 'bindBufferBase')
      .map((c) => c.args[1] as number);
    expect(baseBindings).toContain(2);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
bun test lib/renderer-webgl.test.ts -t "virtual kitty"
```

Expected: FAIL — kitty path not wired.

- [ ] **Step 3: Wire the virtual-placement path**

In `lib/renderer-webgl.ts`, modify the `encodeCells` private method body (the wrapper that calls `coreEncodeCells`). The wrapper's return shape changes to `{ cellArray, usedKittyImageIds }` so callers (render and tests) can pick what they need:

```ts
private encodeCells(
  buffer: IRenderable,
  viewportY: number,
  sb?: IScrollbackProvider
): { cellArray: Uint32Array; usedKittyImageIds: number[] } {
  const { usedKittyImageIds } = coreEncodeCells(this.cellArray, buffer, viewportY, sb, {
    metrics: this.metrics,
    selectionManager: this.selectionManager,
    hoveredHyperlinkId: this.hoveredHyperlinkId,
    hoveredLinkRange: this.hoveredLinkRange,
    cursorStyle: this.cursorStyle,
    cursorBlinkVisible: this.cursorBlink_.isVisible(),
    atlas: this.atlas,
    kittyEnabled: true,
    blockElementShaderEnabled: false,
    maxKittyImages: 256,
  });
  return { cellArray: this.cellArray, usedKittyImageIds };
}
```

The signature changes from returning `Uint32Array` to returning `{ cellArray, usedKittyImageIds }`. Update both the in-renderer call site and the existing R4-era encodeCells tests.

**In `render()`**, find the existing line that calls `this.encodeCells(buffer, viewportY, sb);` and replace with:

```ts
const { usedKittyImageIds } = this.encodeCells(buffer, viewportY, sb);
```

(The cell-texture upload below already reads `this.cellArray` directly, so we don't need the destructured `cellArray` here.)

**In `lib/renderer-webgl.test.ts`**, the existing `encodeCells` describe block has 3 tests that read `arr[i]` from the wrapper's return value. Update each to destructure `cellArray`:

```ts
// In 'empty cells get FLAG_USE_THEME_FG | FLAG_USE_THEME_BG':
const { cellArray: arr } = (r as any).encodeCells(buf, 0);
// (rest of the test unchanged — `arr[4]`, `arr[12]` still read correctly)

// In 'cell with explicit fg/bg packs colors little-endian':
const { cellArray: arr } = (r as any).encodeCells(buf, 0);

// In 'cursor cell receives FLAG_IS_CURSOR_CELL when block-style cursor visible':
const { cellArray: arr } = (r as any).encodeCells(buf, 0);
```

Three identical destructure patches. The test bodies otherwise stay unchanged.

After `this.uploadGridUBO(viewportY, cursor);` and BEFORE the cell texture upload, add the kitty atlas update + rect UBO upload:

```ts
// Update kitty atlas for any virtual-placement images used this frame, and
// build the rect lookup table for the text shader.
this.kittyAtlasRects.fill(0);
const graphics = buffer.getKittyGraphics?.() ?? null;
if (graphics !== null && this.kittyAtlas && usedKittyImageIds.length > 0) {
  for (let i = 0; i < usedKittyImageIds.length; i++) {
    const id = usedKittyImageIds[i]!;
    const pixels = buffer.getKittyImagePixels?.(graphics, id);
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
  gl.bindBuffer(gl.UNIFORM_BUFFER, this.kittyAtlasUBO);
  gl.bufferSubData(gl.UNIFORM_BUFFER, 0, this.kittyAtlasRects);
}
```

In the text pass, after the existing `bindBufferBase` calls for slots 0 (grid) and 1 (palette), add:

```ts
gl.bindBufferBase(gl.UNIFORM_BUFFER, 2, this.kittyAtlasUBO!);
```

After the existing texture binds (TEXTURE0=cell, TEXTURE1=glyph atlas), add:

```ts
gl.activeTexture(gl.TEXTURE2);
gl.bindTexture(gl.TEXTURE_2D, this.kittyAtlas?.glTexture() ?? null);
```

The text pass binding-existence guard (the `if (this.textProgram && this.vao && ...)` check) should also include `this.kittyAtlas && this.kittyAtlasUBO`.

- [ ] **Step 4: Run tests to verify they pass**

```bash
bun test lib/renderer-webgl.test.ts -t "virtual kitty"
```

Expected: 2 pass.

```bash
bun run typecheck && bun test
```

Expected: full suite green.

- [ ] **Step 5: Format + commit**

```bash
npx prettier --write lib/renderer-webgl.ts lib/renderer-webgl.test.ts
git add lib/renderer-webgl.ts lib/renderer-webgl.test.ts
git commit -m "feat(render): WebGL virtual kitty placements via shared atlas"
```

---

## Task K11b: WebGL direct-placement render path

**Files:**

- Modify: `lib/renderer-webgl.ts`
- Modify: `lib/renderer-webgl.test.ts`

Walk direct placements pre-pass, populate per-placement Float32Arrays, ensure ring size, upload, then draw each between text and cursor passes.

- [ ] **Step 1: Write the failing test**

Append to `lib/renderer-webgl.test.ts`:

```ts
describe('direct kitty placements (WebGL)', () => {
  test('render with direct placement issues kitty draws between text and cursor', async () => {
    const canvas = document.createElement('canvas');
    const r = await WebGL2Renderer.create(canvas, {});
    r.resize(4, 2);
    const stub = getStub();
    stub.calls.length = 0;
    const placement = {
      imageId: 5,
      pixelWidth: 64,
      pixelHeight: 32,
      gridCols: 4,
      gridRows: 2,
      viewportCol: 0,
      viewportRow: 0,
      viewportVisible: true,
      sourceX: 0,
      sourceY: 0,
      sourceWidth: 64,
      sourceHeight: 32,
      isVirtual: false,
    };
    const buf = {
      getLine: () => null,
      getCursor: () => ({ x: 0, y: 0, visible: false }),
      getDimensions: () => ({ cols: 4, rows: 2 }),
      isRowDirty: () => false,
      clearDirty: () => {},
      getKittyGraphics: () => 1,
      iterPlacements: function* (_g: number, _onlyVisible?: boolean) {
        yield placement;
      },
      getKittyImagePixels: (_g: number, id: number) =>
        id === 5 ? { width: 64, height: 32, format: 1, data: new Uint8Array(64 * 32 * 4) } : null,
    };
    r.render(buf as any, 0);
    // Should issue an extra drawArrays(TRIANGLES, 0, 6) for the direct placement,
    // beyond any cursor-pass drawArrays.
    const directDraws = stub.calls.filter(
      (c) => c.method === 'drawArrays' && (c.args[2] as number) === 6
    );
    expect(directDraws.length).toBeGreaterThanOrEqual(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
bun test lib/renderer-webgl.test.ts -t "direct kitty"
```

Expected: FAIL — direct-placement path not wired.

- [ ] **Step 3: Wire the direct-placement path**

In `render()`, immediately after the kitty atlas update (from K11a) and BEFORE the cell-texture upload (or wherever fits in the existing flow), add the direct-placement pre-walk:

```ts
// Direct kitty placements pre-walk (must happen before bindBufferBase/draw,
// so the params UBOs are already populated by the time we issue the kitty
// draw loop).
const directPlacements: Array<{ params: Float32Array; tex: WebGLTexture }> = [];
if (graphics !== null && buffer.iterPlacements) {
  const cssW = this.cols * this.metrics.width;
  const cssH = this.rows * this.metrics.height;
  for (const p of buffer.iterPlacements(graphics, true)) {
    if (p.isVirtual) continue;
    const pixels = buffer.getKittyImagePixels?.(graphics, p.imageId);
    if (!pixels) continue;
    const tex = this.kittyTextures.getOrUpload(p.imageId, pixels);
    if (!tex) continue;
    const params = new Float32Array(16);
    params[0] = p.sourceX;
    params[1] = p.sourceY;
    params[2] = p.sourceWidth;
    params[3] = p.sourceHeight;
    params[4] = p.viewportCol * this.metrics.width;
    params[5] = p.viewportRow * this.metrics.height;
    params[6] = p.pixelWidth;
    params[7] = p.pixelHeight;
    params[8] = pixels.width;
    params[9] = pixels.height;
    params[10] = cssW;
    params[11] = cssH;
    directPlacements.push({ params, tex });
  }
}
this.ensureKittyRingSize(directPlacements.length);
for (let i = 0; i < directPlacements.length; i++) {
  gl.bindBuffer(gl.UNIFORM_BUFFER, this.kittyParamsRing[i]!);
  gl.bufferSubData(gl.UNIFORM_BUFFER, 0, directPlacements[i]!.params);
}
```

After the text pass (`gl.drawArraysInstanced(...)`) and BEFORE the cursor pass, add the direct-placement draw loop:

```ts
// Direct kitty placements — draw between text and cursor so images sit over
// text but under the cursor (matches WebGPU ordering).
if (this.kittyProgram && directPlacements.length > 0) {
  gl.useProgram(this.kittyProgram);
  gl.bindVertexArray(this.vao!);
  gl.enable(gl.BLEND);
  gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
  gl.blendEquation(gl.FUNC_ADD);
  for (let i = 0; i < directPlacements.length; i++) {
    gl.bindBufferBase(gl.UNIFORM_BUFFER, 0, this.kittyParamsRing[i]!);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, directPlacements[i]!.tex);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
  }
  gl.disable(gl.BLEND);
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
bun test lib/renderer-webgl.test.ts -t "direct kitty"
bun run typecheck && bun test
```

Expected: new test passes; full suite green.

- [ ] **Step 5: Format + commit**

```bash
npx prettier --write lib/renderer-webgl.ts lib/renderer-webgl.test.ts
git add lib/renderer-webgl.ts lib/renderer-webgl.test.ts
git commit -m "feat(render): WebGL direct kitty placements"
```

---

## Task K12: WebGL `destroy()` cleanup additions

**Files:**

- Modify: `lib/renderer-webgl.ts`

Release kitty resources on destroy. The bigger destroy-cleanup TODO (text/cursor programs, glyph atlas, cellTex, gridUBO, paletteUBO, vao) stays unaddressed by this task — it's the existing T6 follow-up.

- [ ] **Step 1: Update `destroy()`**

Find the existing `destroy()` method. Replace its body with:

```ts
destroy(): void {
  this.destroyed = true;
  this.cursorBlink_.destroy();
  this.kittyAtlas?.destroy();
  this.kittyTextures.destroyAll();
  if (this.kittyAtlasUBO) this.gl.deleteBuffer(this.kittyAtlasUBO);
  if (this.kittyProgram) this.gl.deleteProgram(this.kittyProgram);
  for (const buf of this.kittyParamsRing) this.gl.deleteBuffer(buf);
  this.kittyParamsRing.length = 0;
  // TODO (existing follow-up): also gl.deleteBuffer(paletteUBO, gridUBO),
  // gl.deleteTexture(cellTex, glyph atlas), gl.deleteProgram(textProgram,
  // cursorProgram), gl.deleteVertexArray(vao). Tracked separately.
}
```

- [ ] **Step 2: Verify**

```bash
bun run typecheck && bun test
```

Expected: full suite green.

- [ ] **Step 3: Format + commit**

```bash
npx prettier --write lib/renderer-webgl.ts
git add lib/renderer-webgl.ts
git commit -m "feat(render): WebGL destroy() releases kitty resources"
```

---

## Task K13: Manual demo verification

**Files:**

- (No code changes; verification only)

The demo's `?renderer=webgl` toggle exists from the original WebGL backend ship. We verify kitty content renders correctly side-by-side with WebGPU.

- [ ] **Step 1: Run the demo**

```bash
bun run demo
```

Open in two tabs:

- `http://localhost:8080/?renderer=webgl`
- `http://localhost:8080/?renderer=webgpu`

- [ ] **Step 2: Test direct placements (`icat`)**

In the WebGL tab's terminal, run:

```bash
kitten icat /path/to/some/image.png
```

(Any small PNG/JPG in your filesystem.)

Expected: image renders inline. Compare to the same command in the WebGPU tab. Visual parity should be close — minor differences in interpolation are acceptable.

- [ ] **Step 3: Test virtual placements (TUI image preview)**

If you have `ranger` with image preview enabled, or a kitten that uses U+10EEEE virtual placements, navigate to a directory with images and trigger a preview. Compare WebGL ↔ WebGPU.

If you don't have a virtual-placement-using tool installed, this step is informational only — note the gap and move on. Direct placements via `icat` cover the bigger use case.

- [ ] **Step 4: Test renderer-swap survival**

While an image is on screen in the WebGL tab, press Alt+Shift+R to cycle to canvas2d. Image disappears (Canvas2D has no kitty support) — this is expected. Press Alt+Shift+R again to cycle back. Kitty rendering should resume.

- [ ] **Step 5: Pre-commit gate one final time**

```bash
bun run fmt && bun run lint && bun run typecheck && bun test && bun run build
```

If any of these fail beyond the known pre-existing lint warnings in `renderer.ts` and `renderer-webgpu.ts`, investigate before declaring done.

- [ ] **Step 6: (Optional) Note any visual issues for follow-up**

If you observe artifacts (color drift, scaling fuzziness, alignment offsets, missing kitty images), capture which case and what backend showed which behavior. File as separate follow-up issues; do not block this task on minor visual differences from WebGPU since they likely affect WebGPU users equally and would be addressed in a separate "renderer color management" pass.

---

## Verification checklist

After all 13 tasks land:

- [ ] `bun test` reports all green (incl. new `lib/renderer-core.test.ts` and the new kitty test groups in `lib/renderer-webgl.test.ts`)
- [ ] `bun run typecheck` clean
- [ ] `bun run build` produces `dist/` artifacts
- [ ] Manual `kitten icat foo.png` in `?renderer=webgl` renders the image
- [ ] No regression in WebGPU kitty rendering (direct or virtual)
- [ ] Auto-fallback chain unchanged (WebGPU → WebGL → Canvas2D)

## Notes for the implementer

- **K5 (WebGPU subclass) is the riskiest step.** It touches a working code path. Read all 3 call sites for `getOrUploadKittyTexture` carefully; the new pattern reads `pixels.width`/`pixels.height` from the freshly-fetched pixels rather than from the cache entry. Verify each callsite has access to `pixels`.
- **The kitty atlas filter is LINEAR**, not NEAREST like the glyph atlas. Kitty images get scaled (sub-rect sampling, slice composition); LINEAR avoids stair-stepping.
- **`KittyAtlasUBO` rects must be bound even when no kitty content exists** — WebGL2 requires every uniform block referenced by the program to be bound to a non-null buffer. The K11a test "render with no kitty content does not bind UBO slot 2" actually asserts the OPPOSITE — it asserts slot 2 IS bound (with a zeroed rect array). The test name is slightly misleading; the assertion (`toContain(2)`) is correct.
- **Order of binding matters.** In `render()`, the kitty atlas update must run before the text-pass `bufferSubData` for `kittyAtlasUBO` (so the rects are fresh) and before the text-pass `bindTexture` for `uKittyAtlas` (so the atlas texture has the latest content).
- **Phase B (WebGPU migration) is intentionally NOT in this plan.** A separate spec/plan will tackle the WebGPU virtual-placement migration, which deletes 14 sampler bindings from `TEXT_SHADER` and drops the `requiredLimits.maxSampledTexturesPerShaderStage` workaround.
