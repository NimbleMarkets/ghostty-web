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
import { CellFlags } from './types';

const warnedUnparseableColors = new Set<string>();

// Cell encoding — see plan §"Cell Encoding Reference".
const CELL_BYTES = 32;
const CELL_U32S = 8;

// Flag bits — must match WGSL.
const FLAG_BOLD = 1 << 0;
const FLAG_ITALIC = 1 << 1;
const FLAG_UNDERLINE = 1 << 2;
const FLAG_STRIKETHROUGH = 1 << 3;
const FLAG_INVERSE = 1 << 4;
const FLAG_FAINT = 1 << 5;
const FLAG_INVISIBLE = 1 << 6;
const FLAG_IS_SELECTED = 1 << 7;
const FLAG_IS_HYPERLINK_HOVERED = 1 << 8;
const FLAG_IS_LINK_RANGE_HOVERED = 1 << 9;
const FLAG_IS_BLOCK_ELEMENT = 1 << 10;
const FLAG_IS_KITTY_PLACEHOLDER = 1 << 11;
const FLAG_USE_THEME_FG = 1 << 12;
const FLAG_USE_THEME_BG = 1 << 13;
const FLAG_IS_CURSOR_CELL = 1 << 14;

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

  // Buffers
  private cellBuffer?: GPUBuffer;
  private cellBufferCapacity = 0; // bytes
  private paletteUBO?: GPUBuffer; // 384 B
  private gridUBO?: GPUBuffer;    // 80 B
  private cellArray = new Uint32Array(0); // staging
  // Placeholder for Task 8's GlyphAtlas; replaced in Task 8.
  private atlas?: { atlasSize: number };

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

    this.paletteUBO = this.device.createBuffer({
      size: 384,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      label: 'paletteUBO',
    });
    this.gridUBO = this.device.createBuffer({
      size: 80,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      label: 'gridUBO',
    });
    this.uploadPaletteUBO();

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

  // -------- Buffer helpers --------

  private uploadPaletteUBO(): void {
    if (!this.paletteUBO) return;
    const data = new Float32Array(96);
    const w = (i: number, hex: string): void => {
      const [r, g, b] = this.parseHexColor(hex);
      data[i * 4 + 0] = r / 255;
      data[i * 4 + 1] = g / 255;
      data[i * 4 + 2] = b / 255;
      data[i * 4 + 3] = 1;
    };
    // 16 ANSI palette
    const t = this.theme;
    w(0, t.black);
    w(1, t.red);
    w(2, t.green);
    w(3, t.yellow);
    w(4, t.blue);
    w(5, t.magenta);
    w(6, t.cyan);
    w(7, t.white);
    w(8, t.brightBlack);
    w(9, t.brightRed);
    w(10, t.brightGreen);
    w(11, t.brightYellow);
    w(12, t.brightBlue);
    w(13, t.brightMagenta);
    w(14, t.brightCyan);
    w(15, t.brightWhite);
    // theme entries
    w(16, t.foreground);
    w(17, t.background);
    w(18, t.cursor);
    w(19, t.cursorAccent);
    w(20, t.selectionBackground);
    w(21, t.selectionForeground);
    w(22, '#4A90E2'); // link underline color (matches CanvasRenderer)
    // 23 reserved (zeroed)
    this.device.queue.writeBuffer(this.paletteUBO, 0, data.buffer);
  }

  private uploadGridUBO(_viewportY: number, cursor: { x: number; y: number; visible: boolean }): void {
    if (!this.gridUBO) return;
    // 80 B = 20 × u32. Layout matches the WGSL GridUBO struct (Tasks 9, 14).
    const u32 = new Uint32Array(20);
    const f32 = new Float32Array(u32.buffer);
    u32[0] = this.cols;                                                  // gridSize.x
    u32[1] = this.rows;                                                  // gridSize.y
    f32[2] = this.metrics.width;                                         // cellSize.x
    f32[3] = this.metrics.height;                                        // cellSize.y
    f32[4] = this.dpr;                                                   // devicePixelRatio
    u32[5] = cursor.visible && this.cursorBlink_.isVisible() ? 1 : 0;    // cursorVisible
    u32[6] = cursor.x;                                                   // cursorPos.x
    u32[7] = cursor.y;                                                   // cursorPos.y
    u32[8] = this.cursorStyle === 'block' ? 0 : this.cursorStyle === 'underline' ? 1 : 2;
    u32[9] = 0;                                                          // _pad0
    u32[10] = this.atlas?.atlasSize ?? 1024;                             // atlasSize (Task 9 uses it)
    // u32[11..19] reserved
    this.device.queue.writeBuffer(this.gridUBO, 0, u32.buffer);
  }

  private encodeCells(buffer: IRenderable, viewportY: number, sb?: IScrollbackProvider): void {
    const arr = this.cellArray;
    arr.fill(0);
    const dims = buffer.getDimensions();
    const sbLen = sb?.getScrollbackLength() ?? 0;
    const cursor = buffer.getCursor();
    const sel = this.selectionManager?.getSelectionCoords() ?? null;
    const inSel = (x: number, y: number): boolean => {
      if (!sel) return false;
      if (sel.startRow === sel.endRow) {
        return y === sel.startRow && x >= sel.startCol && x <= sel.endCol;
      }
      if (y === sel.startRow) return x >= sel.startCol;
      if (y === sel.endRow) return x <= sel.endCol;
      return y > sel.startRow && y < sel.endRow;
    };

    for (let y = 0; y < dims.rows; y++) {
      let line: ReturnType<IRenderable['getLine']> = null;
      if (viewportY > 0) {
        if (y < viewportY && sb) {
          const off = sbLen - Math.floor(viewportY) + y;
          line = sb.getScrollbackLine(off);
        } else {
          line = buffer.getLine(y - Math.floor(viewportY));
        }
      } else {
        line = buffer.getLine(y);
      }
      if (!line) continue;
      for (let x = 0; x < line.length && x < dims.cols; x++) {
        const c = line[x];
        if (!c || c.width === 0) continue;
        const i = (y * dims.cols + x) * CELL_U32S;
        let flags = 0;
        if (c.flags & CellFlags.BOLD) flags |= FLAG_BOLD;
        if (c.flags & CellFlags.ITALIC) flags |= FLAG_ITALIC;
        if (c.flags & CellFlags.UNDERLINE) flags |= FLAG_UNDERLINE;
        if (c.flags & CellFlags.STRIKETHROUGH) flags |= FLAG_STRIKETHROUGH;
        if (c.flags & CellFlags.INVERSE) flags |= FLAG_INVERSE;
        if (c.flags & CellFlags.FAINT) flags |= FLAG_FAINT;
        if (c.flags & CellFlags.INVISIBLE) flags |= FLAG_INVISIBLE;
        if (c.fgIsDefault) flags |= FLAG_USE_THEME_FG;
        if (c.bgIsDefault) flags |= FLAG_USE_THEME_BG;
        if (inSel(x, y)) flags |= FLAG_IS_SELECTED;
        if (c.hyperlink_id !== 0 && c.hyperlink_id === this.hoveredHyperlinkId) {
          flags |= FLAG_IS_HYPERLINK_HOVERED;
        }
        // Pack colors as little-endian rgba8.
        arr[i + 0] = c.fg_r | (c.fg_g << 8) | (c.fg_b << 16);
        arr[i + 1] = c.bg_r | (c.bg_g << 8) | (c.bg_b << 16);
        // arr[i + 2] = atlasUV — Task 8
        // arr[i + 3] = atlasSize — Task 8
        arr[i + 4] = flags >>> 0;
        // arr[i + 5] = blockOrSliceCode — Task 13/16
        // arr[i + 6] = kittyTexIndex — Task 16
      }
    }

    if (cursor.visible && this.cursorBlink_.isVisible()) {
      const ci = (cursor.y * dims.cols + cursor.x) * CELL_U32S;
      arr[ci + 4] = (arr[ci + 4]! | FLAG_IS_CURSOR_CELL) >>> 0;
    }

    if (this.cellBuffer) {
      this.device.queue.writeBuffer(
        this.cellBuffer,
        0,
        arr.buffer,
        0,
        dims.cols * dims.rows * CELL_BYTES,
      );
    }
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

    const requiredBytes = Math.max(1, cols * rows * CELL_BYTES);
    if (!this.cellBuffer || this.cellBufferCapacity < requiredBytes) {
      this.cellBuffer?.destroy();
      this.cellBuffer = this.device.createBuffer({
        size: requiredBytes,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
        label: 'cellBuffer',
      });
      this.cellBufferCapacity = requiredBytes;
      this.cellArray = new Uint32Array(cols * rows * CELL_U32S);
    } else if (this.cellArray.length !== cols * rows * CELL_U32S) {
      this.cellArray = new Uint32Array(cols * rows * CELL_U32S);
    }
  }

  render(buffer: IRenderable, viewportY: number = 0, sb?: IScrollbackProvider): void {
    if (this.cols === 0 || this.rows === 0) return;
    const cursor = buffer.getCursor();
    this.encodeCells(buffer, viewportY, sb);
    this.uploadGridUBO(viewportY, cursor);

    const view = this.context.getCurrentTexture().createView();
    const [r, g, b] = this.parseHexColor(this.theme.background);
    const encoder = this.device.createCommandEncoder();
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

    buffer.clearDirty();
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
    this.uploadPaletteUBO();
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
