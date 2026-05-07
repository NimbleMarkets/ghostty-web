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

const warnedUnparseableColors = new Set<string>();

export class WebGPURenderer implements Renderer {
  public readonly backend = 'webgpu' as const;
  public readonly canvas: HTMLCanvasElement;

  private device!: GPUDevice;
  private context!: GPUCanvasContext;
  private preferredFormat!: GPUTextureFormat;
  private theme: Required<ITheme> = DEFAULT_THEME;
  private fontSize: number;
  private fontFamily: string;
  private cursorStyle: 'block' | 'underline' | 'bar';
  private dpr: number;
  private metrics: FontMetrics = { width: 0, height: 0, baseline: 0 };
  private cols = 0;
  private rows = 0;
  private cursorBlink_ = new CursorBlink();
  private selectionManager?: SelectionManager;
  private hoveredHyperlinkId = 0;
  private hoveredLinkRange: LinkRange | null = null;
  private onRequestRender: (() => void) | null = null;
  private invalidateNext = true;
  private destroyed = false;
  private deviceLostListeners: Array<(info: GPUDeviceLostInfo) => void> = [];

  static async create(
    canvas: HTMLCanvasElement,
    device: GPUDevice,
    opts: RendererOptions
  ): Promise<WebGPURenderer> {
    const r = new WebGPURenderer(canvas, device, opts);
    await r.initialize();
    return r;
  }

  private constructor(canvas: HTMLCanvasElement, device: GPUDevice, opts: RendererOptions) {
    this.canvas = canvas;
    this.device = device;
    this.fontSize = opts.fontSize ?? 15;
    this.fontFamily = opts.fontFamily ?? 'monospace';
    this.cursorStyle = opts.cursorStyle ?? 'block';
    this.dpr = opts.devicePixelRatio ?? window.devicePixelRatio ?? 1;
    this.theme = { ...DEFAULT_THEME, ...opts.theme };
    this.cursorBlink_.setEnabled(opts.cursorBlink ?? false);
  }

  private async initialize(): Promise<void> {
    const ctx = this.canvas.getContext('webgpu') as GPUCanvasContext | null;
    if (!ctx) throw new Error('WebGPURenderer: failed to acquire webgpu context');
    this.context = ctx;
    this.preferredFormat = navigator.gpu.getPreferredCanvasFormat();
    this.context.configure({
      device: this.device,
      format: this.preferredFormat,
      alphaMode: 'premultiplied',
    });

    this.metrics = this.measureFont();

    this.device.lost.then((info) => {
      if (this.destroyed) return;
      console.error('[ghostty-web] GPUDevice lost:', info.reason, info.message);
      // Task 17 wires this to the Terminal-level fallback.
      for (const fn of this.deviceLostListeners) fn(info);
    });
  }

  /** Internal hook used by Terminal's fallback path (Task 17). */
  onDeviceLost(fn: (info: GPUDeviceLostInfo) => void): void {
    this.deviceLostListeners.push(fn);
  }

  // -------- Font metrics (same logic as CanvasRenderer.measureFont) --------

  private measureFont(): FontMetrics {
    const c = document.createElement('canvas');
    const ctx = c.getContext('2d')!;
    ctx.font = `${this.fontSize}px ${this.fontFamily}`;
    const m = ctx.measureText('M');
    const width = Math.ceil(m.width);
    const ascent = m.actualBoundingBoxAscent || this.fontSize * 0.8;
    const descent = m.actualBoundingBoxDescent || this.fontSize * 0.2;
    const height = Math.ceil(ascent + descent) + 2;
    const baseline = Math.ceil(ascent) + 1;
    return { width, height, baseline };
  }

  // -------- Renderer interface --------

  getMetrics(): FontMetrics {
    return { ...this.metrics };
  }

  resize(cols: number, rows: number): void {
    this.cols = cols;
    this.rows = rows;
    const cssW = cols * this.metrics.width;
    const cssH = rows * this.metrics.height;
    this.canvas.style.width = `${cssW}px`;
    this.canvas.style.height = `${cssH}px`;
    this.canvas.width = Math.round(cssW * this.dpr);
    this.canvas.height = Math.round(cssH * this.dpr);
    this.invalidateNext = true;
    // Tasks 7+ will re-allocate cellBuffer here.
  }

  render(
    _buffer: IRenderable,
    _viewportY: number = 0,
    _scrollbackProvider?: IScrollbackProvider
  ): void {
    // Task 6: clear-only render to theme.background.
    const view = this.context.getCurrentTexture().createView();
    const encoder = this.device.createCommandEncoder();
    const [r, g, b] = this.parseHexColor(this.theme.background);
    const pass = encoder.beginRenderPass({
      colorAttachments: [
        {
          view,
          clearValue: { r: r / 255, g: g / 255, b: b / 255, a: 1 },
          loadOp: 'clear',
          storeOp: 'store',
        },
      ],
    });
    pass.end();
    this.device.queue.submit([encoder.finish()]);
    this.invalidateNext = false;
  }

  private parseHexColor(hex: string): [number, number, number] {
    const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex.trim());
    if (!m) {
      if (!warnedUnparseableColors.has(hex)) {
        warnedUnparseableColors.add(hex);
        console.warn(
          '[ghostty-web] WebGPURenderer: unparseable theme color, falling back to black:',
          hex
        );
      }
      return [0, 0, 0];
    }
    return [Number.parseInt(m[1]!, 16), Number.parseInt(m[2]!, 16), Number.parseInt(m[3]!, 16)];
  }

  setTheme(theme: ITheme): void {
    this.theme = { ...DEFAULT_THEME, ...theme };
    this.invalidateNext = true;
    this.onRequestRender?.();
  }

  setFontSize(size: number): void {
    this.fontSize = size;
    this.metrics = this.measureFont();
    this.invalidateNext = true;
    this.onRequestRender?.();
  }

  setFontFamily(family: string): void {
    this.fontFamily = family;
    this.metrics = this.measureFont();
    this.invalidateNext = true;
    this.onRequestRender?.();
  }

  setCursorStyle(style: 'block' | 'underline' | 'bar'): void {
    this.cursorStyle = style;
    this.invalidateNext = true;
    this.onRequestRender?.();
  }

  setCursorBlink(enabled: boolean): void {
    this.cursorBlink_.setEnabled(enabled);
  }

  setOnRequestRender(fn: (() => void) | null): void {
    this.onRequestRender = fn;
    this.cursorBlink_.setOnRequestRender(fn);
  }

  setSelectionManager(mgr: SelectionManager): void {
    this.selectionManager = mgr;
  }

  setHoveredHyperlinkId(id: number): void {
    if (this.hoveredHyperlinkId === id) return;
    this.hoveredHyperlinkId = id;
    this.invalidateNext = true;
    this.onRequestRender?.();
  }

  setHoveredLinkRange(range: LinkRange | null): void {
    if (this.hoveredLinkRange === range) return;
    this.hoveredLinkRange = range;
    this.invalidateNext = true;
    this.onRequestRender?.();
  }

  invalidate(): void {
    this.invalidateNext = true;
  }

  remeasureFont(): void {
    this.metrics = this.measureFont();
    this.invalidateNext = true;
  }

  destroy(): void {
    this.destroyed = true;
    this.cursorBlink_.destroy();
    // device.destroy() left to caller; we don't own it.
  }
}
