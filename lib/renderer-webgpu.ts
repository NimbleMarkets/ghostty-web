/**
 * WebGPU renderer. Implementation grows across Tasks 6–16:
 *
 * - Task 6:  device init, configure() the canvas context, empty render pass that clears to theme.background
 * - Task 7:  paletteUBO, gridUBO, cellBuffer alloc/write
 * - Task 8:  glyph atlas (raster + texture upload)
 * - Task 9:  textPass shader — ASCII glyphs with fg/bg
 * - Task 10: style flags
 * - Task 11: selection coloring
 * - Task 12: link underlines
 * - Task 13: block elements
 * - Task 14: cursor pass + blink wiring
 * - Task 15: kitty direct placements
 * - Task 16: kitty virtual placements (U+10EEEE)
 */

import { CursorBlink } from './cursor-blink';
import type { ITheme } from './interfaces';
import type { SelectionManager } from './selection-manager';
import { DEFAULT_THEME } from './renderer';
import type {
  FontMetrics,
  IRenderable,
  IScrollbackProvider,
  LinkRange,
  Renderer,
  RendererOptions,
} from './renderer-types';

export class WebGPURenderer implements Renderer {
  public readonly backend = 'webgpu' as const;
  public readonly canvas: HTMLCanvasElement;

  /** Async constructor — real init happens in create(). */
  static async create(
    canvas: HTMLCanvasElement,
    device: any, // GPUDevice — typed as any until @webgpu/types is added
    opts: RendererOptions
  ): Promise<WebGPURenderer> {
    const r = new WebGPURenderer(canvas, device, opts);
    await r.initialize();
    return r;
  }

  private constructor(canvas: HTMLCanvasElement, _device: any, _opts: RendererOptions) {
    this.canvas = canvas;
    throw new Error('WebGPURenderer: not yet implemented (stub)');
  }

  private async initialize(): Promise<void> {
    /* filled in Task 6 */
  }

  // ----- Renderer interface stubs (filled across later tasks) -----
  getMetrics(): FontMetrics {
    throw new Error('not implemented');
  }
  resize(_cols: number, _rows: number): void {
    throw new Error('not implemented');
  }
  render(_b: IRenderable, _vy?: number, _sb?: IScrollbackProvider): void {
    throw new Error('not implemented');
  }
  setTheme(_t: ITheme): void {
    throw new Error('not implemented');
  }
  setFontSize(_s: number): void {
    throw new Error('not implemented');
  }
  setFontFamily(_f: string): void {
    throw new Error('not implemented');
  }
  setCursorStyle(_s: 'block' | 'underline' | 'bar'): void {
    throw new Error('not implemented');
  }
  setCursorBlink(_e: boolean): void {
    throw new Error('not implemented');
  }
  setOnRequestRender(_fn: (() => void) | null): void {
    throw new Error('not implemented');
  }
  setSelectionManager(_m: SelectionManager): void {
    throw new Error('not implemented');
  }
  setHoveredHyperlinkId(_id: number): void {
    throw new Error('not implemented');
  }
  setHoveredLinkRange(_r: LinkRange | null): void {
    throw new Error('not implemented');
  }
  invalidate(): void {
    throw new Error('not implemented');
  }
  remeasureFont(): void {
    throw new Error('not implemented');
  }
  destroy(): void {
    throw new Error('not implemented');
  }
}

// Suppress unused-import warnings for symbols that will be used in later tasks.
// biome-ignore lint/suspicious/noExplicitAny: intentional stub references
void (CursorBlink as any);
// biome-ignore lint/suspicious/noExplicitAny: intentional stub references
void (DEFAULT_THEME as any);
