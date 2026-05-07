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
    const canvas = document.createElement('canvas');
    const r = await pickRenderer('auto', canvas, {});
    expect(r.backend).toBe('canvas2d');
  });
});
