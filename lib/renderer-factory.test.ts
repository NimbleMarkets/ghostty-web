import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { pickRenderer } from './renderer-factory';

describe('pickRenderer', () => {
  let originalGpu: any;

  beforeEach(() => {
    originalGpu = (navigator as any).gpu;
  });

  afterEach(() => {
    (navigator as any).gpu = originalGpu;
  });

  test("returns Canvas2D when backend='canvas2d'", async () => {
    const canvas = document.createElement('canvas');
    const r = await pickRenderer('canvas2d', canvas, {});
    expect(r.backend).toBe('canvas2d');
  });

  test("falls back to Canvas2D under 'auto' when navigator.gpu is missing", async () => {
    (navigator as any).gpu = undefined;
    const canvas = document.createElement('canvas');
    const r = await pickRenderer('auto', canvas, {});
    expect(r.backend).toBe('canvas2d');
  });

  test("throws under 'webgpu' when navigator.gpu is missing", async () => {
    (navigator as any).gpu = undefined;
    const canvas = document.createElement('canvas');
    await expect(pickRenderer('webgpu', canvas, {})).rejects.toThrow(/WebGPU not available/);
  });

  test("falls back under 'auto' when requestAdapter returns null", async () => {
    (navigator as any).gpu = {
      requestAdapter: async () => null,
    };
    const canvas = document.createElement('canvas');
    const r = await pickRenderer('auto', canvas, {});
    expect(r.backend).toBe('canvas2d');
  });

  test("falls back under 'auto' when requestAdapter throws", async () => {
    (navigator as any).gpu = {
      requestAdapter: async () => {
        throw new Error('no gpu');
      },
    };
    // Silence the factory's one-time fallback console.warn so it doesn't
    // pollute test output. The behavior we care about is the Canvas2D
    // fallback itself, asserted below.
    const originalWarn = console.warn;
    console.warn = () => {};
    try {
      const canvas = document.createElement('canvas');
      const r = await pickRenderer('auto', canvas, {});
      expect(r.backend).toBe('canvas2d');
    } finally {
      console.warn = originalWarn;
    }
  });

  test("returns WebGL2 when backend='webgl'", async () => {
    const { installStubWebGL2 } = await import('./test-helpers-webgl');
    const { uninstall } = installStubWebGL2();
    try {
      const canvas = document.createElement('canvas');
      const r = await pickRenderer('webgl', canvas, {});
      expect(r.backend).toBe('webgl');
    } finally {
      uninstall();
    }
  });

  test("throws under 'webgl' when getContext returns null", async () => {
    const original = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (t: string) {
      if (t === 'webgl2') return null as any;
      return original.call(this, t);
    } as any;
    try {
      const canvas = document.createElement('canvas');
      await expect(pickRenderer('webgl', canvas, {})).rejects.toThrow(/webgl2/i);
    } finally {
      HTMLCanvasElement.prototype.getContext = original;
    }
  });

  test("falls through WebGPU → WebGL → Canvas2D under 'auto'", async () => {
    (navigator as any).gpu = undefined;
    const { installStubWebGL2 } = await import('./test-helpers-webgl');
    const { uninstall } = installStubWebGL2();
    try {
      const canvas = document.createElement('canvas');
      const r = await pickRenderer('auto', canvas, {});
      expect(r.backend).toBe('webgl');
    } finally {
      uninstall();
    }
  });

  test("'auto' falls back to Canvas2D when both WebGPU and WebGL are unavailable", async () => {
    (navigator as any).gpu = undefined;
    const original = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (t: string, opts?: any) {
      if (t === 'webgl2') return null as any;
      return original.call(this, t, opts);
    } as any;
    const originalWarn = console.warn;
    console.warn = () => {};
    try {
      const canvas = document.createElement('canvas');
      const r = await pickRenderer('auto', canvas, {});
      expect(r.backend).toBe('canvas2d');
    } finally {
      console.warn = originalWarn;
      HTMLCanvasElement.prototype.getContext = original;
    }
  });
});
