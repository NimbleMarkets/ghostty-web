/**
 * Renderer factory. Resolves a RendererBackend choice into a concrete
 * Renderer instance, with auto-fallback to Canvas2D when WebGPU is
 * unavailable.
 *
 * - 'canvas2d' → CanvasRenderer
 * - 'webgpu'   → WebGPURenderer; throws if WebGPU is unavailable
 * - 'auto'     → tries WebGPU first, silently falls back to Canvas2D on
 *                missing navigator.gpu, missing adapter, or device init
 *                failure. Logs a one-line warning on fallback.
 */

import { CanvasRenderer } from './renderer';
import type { Renderer, RendererBackend, RendererOptions } from './renderer-types';
import { WebGPURenderer } from './renderer-webgpu';

let warnedFallback = false;

export async function pickRenderer(
  backend: RendererBackend,
  canvas: HTMLCanvasElement,
  opts: RendererOptions
): Promise<Renderer> {
  if (backend === 'canvas2d') {
    return new CanvasRenderer(canvas, opts);
  }

  if (backend === 'webgpu' || backend === 'auto') {
    const gpu = (navigator as any).gpu as { requestAdapter: (opts?: any) => Promise<any> } | undefined;
    if (!gpu) {
      if (backend === 'webgpu') {
        throw new Error('WebGPU not available in this browser');
      }
      // auto: silently fall through
    } else {
      try {
        const adapter = await gpu.requestAdapter({ powerPreference: 'high-performance' });
        if (!adapter) {
          if (backend === 'webgpu') throw new Error('WebGPU adapter unavailable');
        } else {
          // textPass binds 1 glyph atlas + 16 kitty textures = 17 sampled
          // textures per fragment stage. Default device limit is 16, so the
          // pipeline silently fails to validate without raising the limit.
          // Request as much as the adapter exposes (most desktops report
          // ≥32; mobile may report exactly 16, which would fail).
          const adapterMax = adapter.limits?.maxSampledTexturesPerShaderStage ?? 16;
          const requiredLimits: Record<string, number> = {};
          if (adapterMax >= 17) {
            requiredLimits.maxSampledTexturesPerShaderStage = Math.min(32, adapterMax);
          }
          const device = await adapter.requestDevice({ requiredLimits });
          return await WebGPURenderer.create(canvas, device, opts);
        }
      } catch (e) {
        if (backend === 'webgpu') throw e;
        if (!warnedFallback) {
          warnedFallback = true;
          console.warn('[ghostty-web] WebGPU init failed, falling back to Canvas2D:', e);
        }
      }
    }
  }

  return new CanvasRenderer(canvas, opts);
}
