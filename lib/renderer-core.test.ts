import { describe, expect, test } from 'bun:test';
import { kittyImageToRGBA, KittyTextureCacheBase } from './renderer-core';
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
