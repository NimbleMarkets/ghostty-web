/**
 * Renderer factory. Resolves a RendererBackend choice into a concrete
 * Renderer instance, with auto-fallback chain WebGPU → WebGL2 → Canvas2D.
 *
 * - 'canvas2d' → CanvasRenderer
 * - 'webgpu'   → WebGPURenderer; throws if WebGPU is unavailable
 * - 'webgl'    → WebGL2Renderer; throws if WebGL2 is unavailable
 * - 'auto'     → tries WebGPU first, then WebGL2, then Canvas2D.
 *                Logs a one-line warning on each fallback (one per kind).
 */

import { CanvasRenderer } from './renderer';
import type { Renderer, RendererBackend, RendererOptions } from './renderer-types';
import { WebGL2Renderer } from './renderer-webgl';
import { WebGPURenderer } from './renderer-webgpu';

let warnedWebGPUFallback = false;
let warnedWebGLFallback = false;

async function tryWebGPU(
  canvas: HTMLCanvasElement,
  opts: RendererOptions,
  explicit: boolean
): Promise<Renderer | null> {
  const gpu = (navigator as any).gpu as
    | { requestAdapter: (opts?: any) => Promise<any> }
    | undefined;
  if (!gpu) {
    if (explicit) throw new Error('WebGPU not available in this browser');
    return null;
  }
  try {
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
    return await WebGPURenderer.create(canvas, device, opts, /* ownsDevice */ true);
  } catch (e) {
    if (explicit) throw e;
    if (!warnedWebGPUFallback) {
      warnedWebGPUFallback = true;
      console.warn('[ghostty-web] WebGPU init failed, trying WebGL2:', e);
    }
    return null;
  }
}

async function tryWebGL(
  canvas: HTMLCanvasElement,
  opts: RendererOptions,
  explicit: boolean
): Promise<Renderer | null> {
  try {
    return await WebGL2Renderer.create(canvas, opts);
  } catch (e) {
    if (explicit) throw e;
    if (!warnedWebGLFallback) {
      warnedWebGLFallback = true;
      console.warn('[ghostty-web] WebGL2 init failed, falling back to Canvas2D:', e);
    }
    return null;
  }
}

export async function pickRenderer(
  backend: RendererBackend,
  canvas: HTMLCanvasElement,
  opts: RendererOptions
): Promise<Renderer> {
  if (backend === 'canvas2d') {
    return new CanvasRenderer(canvas, opts);
  }
  if (backend === 'webgpu') {
    const r = await tryWebGPU(canvas, opts, true);
    if (!r) throw new Error('WebGPU initialization failed');
    return r;
  }
  if (backend === 'webgl') {
    const r = await tryWebGL(canvas, opts, true);
    if (!r) throw new Error('WebGL2 initialization failed');
    return r;
  }
  // backend === 'auto'
  const wgpu = await tryWebGPU(canvas, opts, false);
  if (wgpu) return wgpu;
  const wgl = await tryWebGL(canvas, opts, false);
  if (wgl) return wgl;
  return new CanvasRenderer(canvas, opts);
}
