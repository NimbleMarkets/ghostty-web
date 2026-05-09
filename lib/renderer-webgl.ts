/**
 * WebGL2 renderer.
 *
 * Implementation grows across the WebGL backend plan tasks:
 *   T3:  context init, DPR-aware canvas sizing, clear-only render
 *   T4:  GLGlyphAtlas
 *   T5:  encodeCells (kitty branches removed)
 *   T6:  paletteUBO + gridUBO byte construction
 *   T7:  cell texture allocation + upload
 *   T8:  text vertex/fragment shaders + program
 *   T9:  text-program render path
 *   T10: cursor shader + program
 *   T11: cursor render path + cursor-blink
 *   T12: setters / lifecycle
 *   T13: webglcontextlost listener API
 *
 * No kitty graphics, no in-shader block-element drawing in v1.
 */

import { CursorBlink } from './cursor-blink';
import type { ITheme } from './interfaces';
import { DEFAULT_THEME } from './renderer';
import type {
  FontMetrics,
  IRenderable,
  IScrollbackProvider,
  LinkRange,
  Renderer,
  RendererOptions,
} from './renderer-types';
import type { SelectionManager } from './selection-manager';

const warnedUnparseableColors = new Set<string>();

type AtlasSlot = { u: number; v: number; w: number; h: number };

export class GLGlyphAtlas {
  private gl: WebGL2RenderingContext;
  private texture: WebGLTexture;
  private size: number; // square; powers of 2
  private nextX = 0;
  private nextY = 0;
  private rowHeight = 0;
  private cache = new Map<string, AtlasSlot>();
  private cellW: number;
  private cellH: number;
  private fontSize: number;
  private fontFamily: string;
  private offscreen = document.createElement('canvas');
  private offCtx: CanvasRenderingContext2D;

  constructor(
    gl: WebGL2RenderingContext,
    cellW: number,
    cellH: number,
    fontSize: number,
    fontFamily: string
  ) {
    this.gl = gl;
    this.cellW = cellW;
    this.cellH = cellH;
    this.fontSize = fontSize;
    this.fontFamily = fontFamily;
    this.size = 1024;
    const tex = gl.createTexture();
    if (!tex) throw new Error('GLGlyphAtlas: createTexture failed');
    this.texture = tex;
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, this.size, this.size);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    this.offscreen.width = cellW * 2;
    this.offscreen.height = cellH;
    this.offCtx = this.offscreen.getContext('2d', { willReadFrequently: true })!;
  }

  glTexture(): WebGLTexture {
    return this.texture;
  }

  reset(cellW: number, cellH: number, fontSize: number, fontFamily: string): void {
    this.cellW = cellW;
    this.cellH = cellH;
    this.fontSize = fontSize;
    this.fontFamily = fontFamily;
    this.cache.clear();
    this.nextX = 0;
    this.nextY = 0;
    this.rowHeight = 0;
    this.offscreen.width = cellW * 2;
    this.offscreen.height = cellH;
  }

  getOrRaster(
    grapheme: string,
    styleBits: number,
    baseline: number,
    widthInCells: number = 1
  ): AtlasSlot {
    const key = `${widthInCells}|${styleBits}|${grapheme}`;
    const cached = this.cache.get(key);
    if (cached) return cached;

    const w = this.cellW * widthInCells;
    const h = this.cellH;
    if (this.nextX + w > this.size) {
      this.nextX = 0;
      this.nextY += this.rowHeight;
      this.rowHeight = 0;
    }
    if (this.nextY + h > this.size) {
      this.grow();
    }
    const slot: AtlasSlot = { u: this.nextX, v: this.nextY, w, h };
    this.nextX += w;
    if (h > this.rowHeight) this.rowHeight = h;
    this.cache.set(key, slot);

    const ctx = this.offCtx;
    ctx.clearRect(0, 0, w, h);
    let style = '';
    if (styleBits & 1) style += 'bold ';
    if (styleBits & 2) style += 'italic ';
    ctx.font = `${style}${this.fontSize}px ${this.fontFamily}`;
    ctx.textBaseline = 'alphabetic';
    ctx.textAlign = 'left';
    ctx.fillStyle = styleBits & 4 ? 'rgba(255, 255, 255, 0.5)' : '#ffffff';
    ctx.fillText(grapheme, 0, baseline);

    const img = ctx.getImageData(0, 0, w, h);
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.pixelStorei(/* UNPACK_ALIGNMENT */ 0x0cf5, 1);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, slot.u, slot.v, w, h, gl.RGBA, gl.UNSIGNED_BYTE, img.data);
    return slot;
  }

  private grow(): void {
    const newSize = this.size * 2;
    const gl = this.gl;
    const newTex = gl.createTexture();
    if (!newTex) {
      console.warn('[ghostty-web] GLGlyphAtlas: grow() failed; keeping existing atlas');
      return;
    }
    gl.bindTexture(gl.TEXTURE_2D, newTex);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, newSize, newSize);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    // We do not preserve old contents on grow. The WebGPU path uses
    // copyTextureToTexture; we instead clear the cache + packing cursor
    // and let getOrRaster re-rasterize each glyph on next miss. Simpler;
    // callers see the same logical behavior at the cost of one cycle of
    // re-rasterization right after a grow event.
    this.cache.clear();
    this.nextX = 0;
    this.nextY = 0;
    this.rowHeight = 0;
    gl.deleteTexture?.(this.texture);
    this.texture = newTex;
    this.size = newSize;
  }

  get atlasSize(): number {
    return this.size;
  }
}

export class WebGL2Renderer implements Renderer {
  public readonly backend = 'webgl' as const;
  public readonly canvas: HTMLCanvasElement;

  private gl!: WebGL2RenderingContext;
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
  private contextLostListeners: Array<(info: { reason: string }) => void> = [];

  static async create(canvas: HTMLCanvasElement, opts: RendererOptions): Promise<WebGL2Renderer> {
    const r = new WebGL2Renderer(canvas, opts);
    await r.initialize();
    return r;
  }

  private constructor(canvas: HTMLCanvasElement, opts: RendererOptions) {
    this.canvas = canvas;
    this.fontSize = opts.fontSize ?? 15;
    this.fontFamily = opts.fontFamily ?? 'monospace';
    this.cursorStyle = opts.cursorStyle ?? 'block';
    this.dpr =
      opts.devicePixelRatio ?? (typeof window !== 'undefined' ? window.devicePixelRatio : 1) ?? 1;
    this.theme = { ...DEFAULT_THEME, ...opts.theme };
    this.cursorBlink_.setEnabled(opts.cursorBlink ?? false);
  }

  private async initialize(): Promise<void> {
    const gl = this.canvas.getContext('webgl2', {
      alpha: false,
      antialias: false,
      preserveDrawingBuffer: false,
    }) as WebGL2RenderingContext | null;
    if (!gl) throw new Error('WebGL2Renderer: failed to acquire webgl2 context');
    this.gl = gl;
    this.metrics = this.measureFont();
    // T13: this.canvas.addEventListener('webglcontextlost', ...)
  }

  // -------- Font metrics --------

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

  private parseHexColor(hex: string): [number, number, number] {
    const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex.trim());
    if (!m) {
      if (!warnedUnparseableColors.has(hex)) {
        warnedUnparseableColors.add(hex);
        console.warn(
          '[ghostty-web] WebGL2Renderer: unparseable theme color, falling back to black:',
          hex
        );
      }
      return [0, 0, 0];
    }
    return [Number.parseInt(m[1]!, 16), Number.parseInt(m[2]!, 16), Number.parseInt(m[3]!, 16)];
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
  }

  render(_buffer: IRenderable, _viewportY: number = 0, _sb?: IScrollbackProvider): void {
    if (this.cols === 0 || this.rows === 0) return;
    const gl = this.gl;
    const [r, g, b] = this.parseHexColor(this.theme.background);
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.clearColor(r / 255, g / 255, b / 255, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    this.invalidateNext = false;
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
    this.invalidateNext = true;
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
  }

  /** T13 will register a callback fired on webglcontextlost. */
  onContextLost(fn: (info: { reason: string }) => void): void {
    this.contextLostListeners.push(fn);
  }
}
