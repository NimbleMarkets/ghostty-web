import { describe, expect, test } from 'bun:test';
import {
  kittyImageToRGBA,
  KittyTextureCacheBase,
  KittyAtlasBase,
  type AtlasSlot,
} from './renderer-core';
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
    // 4 64x64 images fill the atlas exactly: (0,0) (64,0) (0,64) (64,64).
    atlas.addOrUpdate(1, pixels(64, 64));
    atlas.addOrUpdate(2, pixels(64, 64));
    atlas.addOrUpdate(3, pixels(64, 64));
    atlas.addOrUpdate(4, pixels(64, 64));
    // 5th 64x64 image overflows; clearAndReset fires and packs at (0,0).
    const e5 = atlas.addOrUpdate(5, pixels(64, 64));
    expect(e5).not.toBeNull();
    expect(e5!.slot).toEqual({ u: 0, v: 0, w: 64, h: 64 });
    // Cache for 1-4 cleared.
    expect(atlas.getEntry(1)).toBeUndefined();
    expect(atlas.getEntry(4)).toBeUndefined();
    expect(atlas.getEntry(5)).toBe(e5!);
  });

  test('mixed-height images do not pack out-of-bounds after wrap', () => {
    const atlas = new StubAtlas(128);
    // Tall image first sets rowHeight = 100.
    const tall = atlas.addOrUpdate(1, pixels(100, 100));
    expect(tall!.slot).toEqual({ u: 0, v: 0, w: 100, h: 100 });
    // Next image at 64×64 wraps horizontally (100+64 > 128) and lands on
    // shelf row 2 at v=100. With the buggy pre-wrap height check, this
    // would have packed at v=100 with h=64 → bottom edge at 164 > 128.
    // Correct algorithm: post-wrap check (100 + 64 > 128) → null → retry.
    const wrap = atlas.addOrUpdate(2, pixels(64, 64));
    expect(wrap).not.toBeNull();
    // After clearAndReset, the 64x64 image packs at (0, 0).
    expect(wrap!.slot).toEqual({ u: 0, v: 0, w: 64, h: 64 });
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
