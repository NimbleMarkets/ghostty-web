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
});
