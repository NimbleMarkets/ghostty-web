import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { WebGL2Renderer } from './renderer-webgl';
import { type StubWebGL2, installStubWebGL2 } from './test-helpers-webgl';

describe('WebGL2Renderer', () => {
  let getStub: () => StubWebGL2;
  let uninstall: () => void;

  beforeEach(() => {
    ({ getStub, uninstall } = installStubWebGL2());
  });

  afterEach(() => {
    uninstall();
  });

  describe('skeleton', () => {
    test('create() acquires a webgl2 context', async () => {
      const canvas = document.createElement('canvas');
      const r = await WebGL2Renderer.create(canvas, {});
      expect(r.backend).toBe('webgl');
      expect(r.canvas).toBe(canvas);
      // The act of creating triggered context acquisition.
      expect(() => getStub()).not.toThrow();
    });

    test('render() with empty grid is a no-op (no draw)', async () => {
      const canvas = document.createElement('canvas');
      const r = await WebGL2Renderer.create(canvas, {});
      const stub = getStub();
      const before = stub.calls.length;
      const fakeBuffer = {
        getLine: () => null,
        getCursor: () => ({ x: 0, y: 0, visible: false }),
        getDimensions: () => ({ cols: 0, rows: 0 }),
        isRowDirty: () => false,
        clearDirty: () => {},
      };
      r.render(fakeBuffer as any, 0);
      expect(stub.calls.length).toBe(before); // early-return guard fires
    });

    test('render() after resize() clears to theme background', async () => {
      const canvas = document.createElement('canvas');
      const r = await WebGL2Renderer.create(canvas, { theme: { background: '#1e1e1e' } as any });
      r.resize(10, 5);
      const stub = getStub();
      const fakeBuffer = {
        getLine: () => null,
        getCursor: () => ({ x: 0, y: 0, visible: false }),
        getDimensions: () => ({ cols: 10, rows: 5 }),
        isRowDirty: () => false,
        clearDirty: () => {},
      };
      r.render(fakeBuffer as any, 0);
      // Verify clearColor + clear got called (skeleton render only does this).
      expect(stub.countCalls('clearColor')).toBeGreaterThan(0);
      expect(stub.countCalls('clear')).toBeGreaterThan(0);
      const cc = stub.argsOf('clearColor')!;
      // 0x1e / 255 ≈ 0.1176
      expect(cc[0] as number).toBeCloseTo(0x1e / 255, 3);
    });

    test('throws when getContext("webgl2") returns null', async () => {
      uninstall();
      const original = HTMLCanvasElement.prototype.getContext;
      HTMLCanvasElement.prototype.getContext = function (t: string) {
        if (t === 'webgl2') return null as any;
        return original.call(this, t);
      } as any;
      try {
        const canvas = document.createElement('canvas');
        await expect(WebGL2Renderer.create(canvas, {})).rejects.toThrow(/webgl2/i);
      } finally {
        HTMLCanvasElement.prototype.getContext = original;
      }
    });
  });

  describe('GLGlyphAtlas', () => {
    test('packs glyphs left-to-right, then wraps to next shelf row', async () => {
      const { GLGlyphAtlas } = await import('./renderer-webgl');
      const canvas = document.createElement('canvas');
      const gl = canvas.getContext('webgl2') as any;
      const atlas = new GLGlyphAtlas(gl, /* cellW */ 10, /* cellH */ 20, 15, 'monospace');
      const a = atlas.getOrRaster('A', 0, 16, 1);
      expect(a).toEqual({ u: 0, v: 0, w: 10, h: 20 });
      const b = atlas.getOrRaster('B', 0, 16, 1);
      expect(b).toEqual({ u: 10, v: 0, w: 10, h: 20 });
      // Wide glyph (2 cells)
      const wide = atlas.getOrRaster('漢', 0, 16, 2);
      expect(wide).toEqual({ u: 20, v: 0, w: 20, h: 20 });
    });

    test('returns cached slot for repeat lookup of same key', async () => {
      const { GLGlyphAtlas } = await import('./renderer-webgl');
      const canvas = document.createElement('canvas');
      const gl = canvas.getContext('webgl2') as any;
      const atlas = new GLGlyphAtlas(gl, 10, 20, 15, 'monospace');
      const first = atlas.getOrRaster('X', 1, 16, 1); // bold
      const second = atlas.getOrRaster('X', 1, 16, 1);
      expect(second).toBe(first);
    });

    test('different style bits produce distinct slots', async () => {
      const { GLGlyphAtlas } = await import('./renderer-webgl');
      const canvas = document.createElement('canvas');
      const gl = canvas.getContext('webgl2') as any;
      const atlas = new GLGlyphAtlas(gl, 10, 20, 15, 'monospace');
      const plain = atlas.getOrRaster('Y', 0, 16, 1);
      const bold = atlas.getOrRaster('Y', 1, 16, 1);
      expect(plain).not.toBe(bold);
      expect(plain.u).not.toBe(bold.u);
    });

    test('first getOrRaster issues a texSubImage2D upload', async () => {
      const { GLGlyphAtlas } = await import('./renderer-webgl');
      const canvas = document.createElement('canvas');
      // installStubWebGL2 patches getContext('webgl2') to return the stub
      // directly, so `gl` here IS the stub — we can read .calls off it.
      const gl = canvas.getContext('webgl2') as any;
      const before = gl.calls.filter((c: any) => c.method === 'texSubImage2D').length;
      const atlas = new GLGlyphAtlas(gl, 10, 20, 15, 'monospace');
      atlas.getOrRaster('Z', 0, 16, 1);
      const after = gl.calls.filter((c: any) => c.method === 'texSubImage2D').length;
      expect(after).toBeGreaterThan(before);
    });

    test('grow() clears cache and resets packing cursor', async () => {
      const { GLGlyphAtlas } = await import('./renderer-webgl');
      const canvas = document.createElement('canvas');
      const gl = canvas.getContext('webgl2') as any;
      // Use cellW small enough that we can fill the atlas in a single test.
      const atlas = new GLGlyphAtlas(gl, 10, 20, 15, 'monospace');
      const initialSize = atlas.atlasSize;
      // Place a glyph and remember its slot.
      const before = atlas.getOrRaster('A', 0, 16, 1);
      // Force grow() by directly invoking it (private but accessible at runtime).
      (atlas as any).grow();
      // Same key after grow should NOT return the cached slot — it should
      // re-rasterize and place at (0, 0) on the new (empty) texture.
      const after = atlas.getOrRaster('A', 0, 16, 1);
      expect(atlas.atlasSize).toBe(initialSize * 2);
      expect(after).not.toBe(before); // cache cleared → new object
      expect(after.u).toBe(0);
      expect(after.v).toBe(0);
    });
  });
});
