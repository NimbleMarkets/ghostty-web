/**
 * Shared rendering utilities used by Canvas2D, WebGPU, and WebGL2 renderers.
 *
 * This module is intentionally GPU-API-agnostic — it contains only pure CPU
 * utilities (color parsing, font measurement) and shared constants
 * (cell-buffer layout, flag bits). Backend-specific concerns (shaders,
 * pipelines, buffer uploads) stay in the per-renderer files.
 */

import type { ITheme } from './interfaces';
import type { FontMetrics, IRenderable, IScrollbackProvider, LinkRange } from './renderer-types';
import type { SelectionManager } from './selection-manager';
import { CellFlags } from './types';
import type { KittyPlacementInfo } from './types';
import { KITTY_PLACEHOLDER, diacriticToInt } from './kitty_diacritics';

// ---------------------------------------------------------------------------
// Cell encoding
// ---------------------------------------------------------------------------

/** Bytes per cell in the packed Uint32Array consumed by GPU shaders. */
export const CELL_BYTES = 32;

/** u32s per cell (CELL_BYTES / 4). Used for indexing the packed buffer. */
export const CELL_U32S = 8;

// Flag bits — must match WGSL/GLSL shader sources in the GPU renderers.
export const FLAG_BOLD = 1 << 0;
export const FLAG_ITALIC = 1 << 1;
export const FLAG_UNDERLINE = 1 << 2;
export const FLAG_STRIKETHROUGH = 1 << 3;
export const FLAG_INVERSE = 1 << 4;
export const FLAG_FAINT = 1 << 5;
export const FLAG_INVISIBLE = 1 << 6;
export const FLAG_IS_SELECTED = 1 << 7;
export const FLAG_IS_HYPERLINK_HOVERED = 1 << 8;
export const FLAG_IS_LINK_RANGE_HOVERED = 1 << 9;
export const FLAG_IS_BLOCK_ELEMENT = 1 << 10;
export const FLAG_IS_KITTY_PLACEHOLDER = 1 << 11;
export const FLAG_USE_THEME_FG = 1 << 12;
export const FLAG_USE_THEME_BG = 1 << 13;
export const FLAG_IS_CURSOR_CELL = 1 << 14;

// ---------------------------------------------------------------------------
// Color parsing
// ---------------------------------------------------------------------------

const warnedUnparseableColors = new Set<string>();

/**
 * Parse a six-digit hex color string ('#rrggbb') to a [r, g, b] tuple.
 * On unparseable input logs a one-time warning and returns [0, 0, 0].
 */
export function parseHexColor(hex: string): [number, number, number] {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex.trim());
  if (!m) {
    if (!warnedUnparseableColors.has(hex)) {
      warnedUnparseableColors.add(hex);
      console.warn('[ghostty-web] unparseable theme color, falling back to black:', hex);
    }
    return [0, 0, 0];
  }
  return [Number.parseInt(m[1]!, 16), Number.parseInt(m[2]!, 16), Number.parseInt(m[3]!, 16)];
}

// ---------------------------------------------------------------------------
// Font measurement
// ---------------------------------------------------------------------------

/**
 * Measure cell metrics for a given font. Uses an offscreen Canvas2D context
 * (the only DOM API that exposes per-glyph measureText). Width is the
 * advance of 'M' (typically the widest character in monospace fonts);
 * height adds 2px padding to absorb glyph overflow + anti-aliasing.
 */
export function measureFont(fontSize: number, fontFamily: string): FontMetrics {
  const c = document.createElement('canvas');
  const ctx = c.getContext('2d')!;
  ctx.font = `${fontSize}px ${fontFamily}`;
  const m = ctx.measureText('M');
  const width = Math.ceil(m.width);
  const ascent = m.actualBoundingBoxAscent || fontSize * 0.8;
  const descent = m.actualBoundingBoxDescent || fontSize * 0.2;
  const height = Math.ceil(ascent + descent) + 2;
  const baseline = Math.ceil(ascent) + 1;
  return { width, height, baseline };
}

// ---------------------------------------------------------------------------
// UBO byte construction
// ---------------------------------------------------------------------------

/**
 * Build the 384-byte palette UBO payload from a fully-merged theme.
 *
 * Layout: 24 vec4s (std140, RGBA × 24 = 96 floats):
 *   [0..15]  ANSI 16-color palette (black, red, ..., brightWhite)
 *   [16]     foreground
 *   [17]     background
 *   [18]     cursor
 *   [19]     cursorAccent
 *   [20]     selectionBackground
 *   [21]     selectionForeground
 *   [22]     link underline color (hard-coded #4A90E2 to match CanvasRenderer)
 *   [23]     reserved (zeroed by Float32Array constructor)
 */
export function buildPaletteUBOBytes(theme: Required<ITheme>): Float32Array {
  const data = new Float32Array(96);
  const w = (i: number, hex: string): void => {
    const [r, g, b] = parseHexColor(hex);
    data[i * 4 + 0] = r / 255;
    data[i * 4 + 1] = g / 255;
    data[i * 4 + 2] = b / 255;
    data[i * 4 + 3] = 1;
  };
  w(0, theme.black);
  w(1, theme.red);
  w(2, theme.green);
  w(3, theme.yellow);
  w(4, theme.blue);
  w(5, theme.magenta);
  w(6, theme.cyan);
  w(7, theme.white);
  w(8, theme.brightBlack);
  w(9, theme.brightRed);
  w(10, theme.brightGreen);
  w(11, theme.brightYellow);
  w(12, theme.brightBlue);
  w(13, theme.brightMagenta);
  w(14, theme.brightCyan);
  w(15, theme.brightWhite);
  w(16, theme.foreground);
  w(17, theme.background);
  w(18, theme.cursor);
  w(19, theme.cursorAccent);
  w(20, theme.selectionBackground);
  w(21, theme.selectionForeground);
  w(22, '#4A90E2'); // link underline color (matches CanvasRenderer)
  // 23 reserved (zeroed)
  return data;
}

/**
 * Snapshot of renderer state needed to build the 80-byte grid UBO.
 * Keeps the builder pure and decoupled from any specific renderer class.
 */
export interface GridUBOState {
  cols: number;
  rows: number;
  cellWidth: number; // CSS pixels
  cellHeight: number; // CSS pixels
  dpr: number;
  cursorX: number;
  cursorY: number;
  cursorVisible: boolean;
  cursorBlinkVisible: boolean;
  cursorStyle: 'block' | 'underline' | 'bar';
  atlasSize: number;
}

/**
 * Build the 80-byte grid UBO payload. Layout matches the WGSL/GLSL GridUBO
 * struct in the WebGPU TEXT_SHADER and the WebGL GRID_UBO_GLSL block.
 *
 *   u32[0,1] gridSize.xy           (cols, rows)
 *   f32[2,3] cellSize.xy           (CSS pixels)
 *   f32[4]   devicePixelRatio
 *   u32[5]   cursorVisible (visible AND blink-on, 0/1)
 *   u32[6,7] cursorPos.xy
 *   u32[8]   cursorStyle (block=0, underline=1, bar=2)
 *   u32[9]   _pad0
 *   u32[10]  atlasSize
 *   u32[11..19] reserved
 */
export function buildGridUBOBytes(state: GridUBOState): Uint32Array {
  const u32 = new Uint32Array(20);
  const f32 = new Float32Array(u32.buffer);
  u32[0] = state.cols;
  u32[1] = state.rows;
  f32[2] = state.cellWidth;
  f32[3] = state.cellHeight;
  f32[4] = state.dpr;
  u32[5] = state.cursorVisible && state.cursorBlinkVisible ? 1 : 0;
  u32[6] = state.cursorX;
  u32[7] = state.cursorY;
  u32[8] = state.cursorStyle === 'block' ? 0 : state.cursorStyle === 'underline' ? 1 : 2;
  u32[9] = 0;
  u32[10] = state.atlasSize;
  return u32;
}

// ---------------------------------------------------------------------------
// Glyph atlas (shared shelf-packed cache; texture upload/grow per backend)
// ---------------------------------------------------------------------------

export type AtlasSlot = { u: number; v: number; w: number; h: number };

/**
 * Backend-agnostic glyph atlas. Owns shelf packing, the grapheme cache,
 * and offscreen Canvas2D rasterization. Subclasses provide the actual
 * GPU/GL texture and implement uploadRegion + growTexture.
 *
 * Cache key is `${widthInCells}|${styleBits}|${grapheme}`. Width-in-cells
 * is 1 for narrow glyphs and 2 for CJK / emoji; the slot is `cellW *
 * widthInCells` pixels wide.
 *
 * Style bits: 0x1 = bold, 0x2 = italic, 0x4 = faint (50% alpha fill).
 */
export abstract class GlyphAtlasBase {
  protected size: number; // square; powers of 2
  private nextX = 0;
  private nextY = 0;
  private rowHeight = 0;
  private cache = new Map<string, AtlasSlot>();
  protected cellW: number;
  protected cellH: number;
  protected fontSize: number;
  protected fontFamily: string;
  private offscreen = document.createElement('canvas');
  private offCtx: CanvasRenderingContext2D;

  constructor(cellW: number, cellH: number, fontSize: number, fontFamily: string) {
    this.cellW = cellW;
    this.cellH = cellH;
    this.fontSize = fontSize;
    this.fontFamily = fontFamily;
    this.size = 1024;
    // Offscreen sized for the widest glyph we support (2 cells for CJK /
    // emoji). Narrow glyphs only use the left half; we crop the read.
    this.offscreen.width = cellW * 2;
    this.offscreen.height = cellH;
    this.offCtx = this.offscreen.getContext('2d', { willReadFrequently: true })!;
  }

  /**
   * Subclass hook: upload a freshly-rasterized RGBA region into the backend
   * texture at (slot.u, slot.v) sized w × h. The pixel data is row-major
   * RGBA bytes (Uint8ClampedArray from getImageData).
   */
  protected abstract uploadRegion(
    slot: AtlasSlot,
    rgba: Uint8ClampedArray,
    w: number,
    h: number
  ): void;

  /**
   * Subclass hook: grow the underlying texture to `newSize` × `newSize`.
   * After this call returns, getOrRaster will re-rasterize on next miss
   * (the cache is cleared by the caller before invoking growTexture).
   * Implementations MAY copy old contents (WebGPU does) or skip the copy
   * (WebGL re-rasterizes on miss; simpler).
   */
  protected abstract growTexture(newSize: number): void;

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

  /**
   * Returns the slot for a (grapheme, styleBits, widthInCells) triple.
   * Rasterizes + uploads on cache miss. Allocates a new shelf row when
   * the current row fills, and grows the atlas when no shelf fits.
   */
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
    ctx.fillStyle = styleBits & 4 ? 'rgba(255, 255, 255, 0.5)' : '#ffffff'; // FAINT
    ctx.fillText(grapheme, 0, baseline);

    const img = ctx.getImageData(0, 0, w, h);
    this.uploadRegion(slot, img.data, w, h);
    return slot;
  }

  private grow(): void {
    const newSize = this.size * 2;
    this.cache.clear();
    this.nextX = 0;
    this.nextY = 0;
    this.rowHeight = 0;
    this.growTexture(newSize);
    this.size = newSize;
  }

  get atlasSize(): number {
    return this.size;
  }
}

// ---------------------------------------------------------------------------
// Cell encoding (CPU walk → packed Uint32Array)
// ---------------------------------------------------------------------------

export interface EncodeCellsContext {
  metrics: FontMetrics;
  selectionManager: SelectionManager | undefined;
  hoveredHyperlinkId: number;
  hoveredLinkRange: LinkRange | null;
  cursorStyle: 'block' | 'underline' | 'bar';
  cursorBlinkVisible: boolean;
  atlas: GlyphAtlasBase | undefined;
  /** When true, walk kitty placements and set FLAG_IS_KITTY_PLACEHOLDER. */
  kittyEnabled: boolean;
  /** When true, set FLAG_IS_BLOCK_ELEMENT for U+2580..U+259F and skip atlas. */
  blockElementShaderEnabled: boolean;
}

/**
 * Walk a renderable buffer and encode the cell grid into the packed
 * Uint32Array consumed by the GPU shaders. The array layout is 8 u32s
 * per cell (CELL_U32S); see the WGSL/GLSL shader sources for the field
 * meanings.
 *
 * Side effects:
 *   - Mutates `cellArray` in place
 *   - Calls `ctx.atlas?.getOrRaster(...)` for each visible glyph (raster
 *     misses upload to the atlas texture)
 *
 * Returns `usedKittyImageIds` — the (max 16) kitty image ids whose virtual
 * placements appeared in the encoded grid. The caller binds the
 * corresponding kitty textures for the next frame's draw. Empty when
 * `ctx.kittyEnabled` is false.
 */
export function encodeCells(
  cellArray: Uint32Array,
  buffer: IRenderable,
  viewportY: number,
  sb: IScrollbackProvider | undefined,
  ctx: EncodeCellsContext
): { usedKittyImageIds: number[] } {
  const arr = cellArray;
  arr.fill(0);
  const dims = buffer.getDimensions();
  const sbLen = sb?.getScrollbackLength() ?? 0;
  const cursor = buffer.getCursor();
  const sel = ctx.selectionManager?.getSelectionCoords() ?? null;
  const inSel = (x: number, y: number): boolean => {
    if (!sel) return false;
    if (sel.startRow === sel.endRow) {
      return y === sel.startRow && x >= sel.startCol && x <= sel.endCol;
    }
    if (y === sel.startRow) return x >= sel.startCol;
    if (y === sel.endRow) return x <= sel.endCol;
    return y > sel.startRow && y < sel.endRow;
  };

  // Build virtual kitty placement index (only when kitty is enabled).
  const kittyVirtualPlacements = new Map<number, KittyPlacementInfo>();
  const usedKittyImageIds: number[] = [];
  const usedKittyImageIndex = new Map<number, number>();

  if (ctx.kittyEnabled && buffer.getKittyGraphics && buffer.iterPlacements) {
    const graphics = buffer.getKittyGraphics();
    if (graphics !== null) {
      for (const p of buffer.iterPlacements(graphics, false)) {
        if (p.isVirtual) {
          kittyVirtualPlacements.set(p.imageId, p);
          if (!usedKittyImageIndex.has(p.imageId) && usedKittyImageIds.length < 16) {
            usedKittyImageIndex.set(p.imageId, usedKittyImageIds.length);
            usedKittyImageIds.push(p.imageId);
          }
        }
      }
    }
  }

  const defaultEmptyFlags = (FLAG_USE_THEME_FG | FLAG_USE_THEME_BG) >>> 0;
  const cellW = ctx.metrics.width;
  const cellH = ctx.metrics.height;
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
    let pendingRightHalf: {
      slotU: number;
      slotV: number;
      slotH: number;
      fgPacked: number;
      bgPacked: number;
      flags: number;
    } | null = null;
    for (let x = 0; x < dims.cols; x++) {
      const i = (y * dims.cols + x) * CELL_U32S;
      const c = line && x < line.length ? line[x] : null;
      if (!c || c.width === 0) {
        if (pendingRightHalf) {
          arr[i + 0] = pendingRightHalf.fgPacked;
          arr[i + 1] = pendingRightHalf.bgPacked;
          arr[i + 2] =
            ((pendingRightHalf.slotU + cellW) & 0xffff) | ((pendingRightHalf.slotV & 0xffff) << 16);
          arr[i + 3] = (cellW & 0xffff) | ((pendingRightHalf.slotH & 0xffff) << 16);
          arr[i + 4] = pendingRightHalf.flags;
          pendingRightHalf = null;
        } else {
          arr[i + 4] = defaultEmptyFlags;
        }
        continue;
      }
      pendingRightHalf = null;
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
      if (c.hyperlink_id !== 0 && c.hyperlink_id === ctx.hoveredHyperlinkId) {
        flags |= FLAG_IS_HYPERLINK_HOVERED;
      }
      if (ctx.hoveredLinkRange) {
        const r = ctx.hoveredLinkRange;
        const inRange =
          (y === r.startY && x >= r.startX && (y < r.endY || x <= r.endX)) ||
          (y > r.startY && y < r.endY) ||
          (y === r.endY && x <= r.endX && (y > r.startY || x >= r.startX));
        if (inRange) flags |= FLAG_IS_LINK_RANGE_HOVERED;
      }
      const cp = c.codepoint || 0;
      if (ctx.kittyEnabled && cp === KITTY_PLACEHOLDER) {
        const codepoints = buffer.getGrapheme?.(y, x);
        if (codepoints && codepoints.length >= 3) {
          const rowD = diacriticToInt(codepoints[1]!);
          const colD = diacriticToInt(codepoints[2]!);
          if (rowD >= 0 && colD >= 0) {
            const fgRgb = (c.fg_r << 16) | (c.fg_g << 8) | c.fg_b;
            let imageId = fgRgb;
            if (codepoints.length >= 4) {
              const msb = diacriticToInt(codepoints[3]!);
              if (msb >= 0) imageId = (msb << 24) | fgRgb;
            }
            const placement = kittyVirtualPlacements.get(imageId);
            const idx = usedKittyImageIndex.get(imageId);
            if (placement && idx !== undefined) {
              flags |= FLAG_IS_KITTY_PLACEHOLDER;
              arr[i + 5] = (colD & 0xffff) | ((rowD & 0xffff) << 16);
              arr[i + 6] = idx;
              arr[i + 7] = (placement.gridCols & 0xffff) | ((placement.gridRows & 0xffff) << 16);
            }
          }
        }
      }
      if (ctx.blockElementShaderEnabled && cp >= 0x2580 && cp <= 0x259f && c.grapheme_len === 0) {
        flags |= FLAG_IS_BLOCK_ELEMENT;
        arr[i + 5] = cp - 0x2580;
      }
      // Pack colors as little-endian rgba8.
      arr[i + 0] = c.fg_r | (c.fg_g << 8) | (c.fg_b << 16);
      arr[i + 1] = c.bg_r | (c.bg_g << 8) | (c.bg_b << 16);
      // Skip atlas lookup for invisible / kitty-placeholder / block-element cells.
      const skipAtlas =
        (flags & (FLAG_INVISIBLE | FLAG_IS_KITTY_PLACEHOLDER | FLAG_IS_BLOCK_ELEMENT)) !== 0;
      if (!skipAtlas && ctx.atlas) {
        const grapheme =
          c.grapheme_len > 0 && buffer.getGraphemeString
            ? buffer.getGraphemeString(y, x)
            : String.fromCodePoint(c.codepoint || 32);
        const styleBits =
          (flags & FLAG_BOLD ? 1 : 0) |
          (flags & FLAG_ITALIC ? 2 : 0) |
          (flags & FLAG_FAINT ? 4 : 0);
        const widthInCells = c.width === 2 ? 2 : 1;
        const slot = ctx.atlas.getOrRaster(grapheme, styleBits, ctx.metrics.baseline, widthInCells);
        arr[i + 2] = (slot.u & 0xffff) | ((slot.v & 0xffff) << 16);
        arr[i + 3] =
          widthInCells === 2
            ? (cellW & 0xffff) | ((cellH & 0xffff) << 16)
            : (slot.w & 0xffff) | ((slot.h & 0xffff) << 16);
        if (widthInCells === 2) {
          pendingRightHalf = {
            slotU: slot.u,
            slotV: slot.v,
            slotH: slot.h,
            fgPacked: arr[i + 0]!,
            bgPacked: arr[i + 1]!,
            flags: 0,
          };
        }
      }
      arr[i + 4] = flags >>> 0;
      if (pendingRightHalf) pendingRightHalf.flags = flags >>> 0;
    }
  }

  // Cursor cell flag (block-style only — non-block cursors drawn as separate
  // quad in the cursor pipeline).
  if (cursor.visible && ctx.cursorBlinkVisible && ctx.cursorStyle === 'block') {
    const ci = (cursor.y * dims.cols + cursor.x) * CELL_U32S;
    arr[ci + 4] = (arr[ci + 4]! | FLAG_IS_CURSOR_CELL) >>> 0;
  }
  return { usedKittyImageIds };
}
