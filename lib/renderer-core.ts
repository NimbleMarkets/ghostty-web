/**
 * Shared rendering utilities used by Canvas2D, WebGPU, and WebGL2 renderers.
 *
 * This module is intentionally GPU-API-agnostic — it contains only pure CPU
 * utilities (color parsing, font measurement) and shared constants
 * (cell-buffer layout, flag bits). Backend-specific concerns (shaders,
 * pipelines, buffer uploads) stay in the per-renderer files.
 */

import type { ITheme } from './interfaces';
import { KITTY_PLACEHOLDER, diacriticToInt } from './kitty_diacritics';
import type { FontMetrics, IRenderable, IScrollbackProvider, LinkRange } from './renderer-types';
import type { SelectionManager } from './selection-manager';
import { CellFlags, KittyImageFormat } from './types';
import type { GhosttyCell, KittyImagePixels, KittyPlacementInfo } from './types';

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
// Default theme
// ---------------------------------------------------------------------------

/**
 * Default colors used when an ITheme override doesn't specify a slot.
 * Shared by every renderer backend; lives here (not in any one renderer
 * file) so backends can be added or removed without re-locating the
 * default palette.
 *
 * Selection colors follow Ghostty's convention: selection bg = default fg,
 * selection fg = default bg — solid colors that *replace* cell colors when
 * a cell is selected, rather than a translucent overlay.
 */
export const DEFAULT_THEME: Required<ITheme> = {
  foreground: '#d4d4d4',
  background: '#1e1e1e',
  cursor: '#ffffff',
  cursorAccent: '#1e1e1e',
  selectionBackground: '#d4d4d4',
  selectionForeground: '#1e1e1e',
  black: '#000000',
  red: '#cd3131',
  green: '#0dbc79',
  yellow: '#e5e510',
  blue: '#2472c8',
  magenta: '#bc3fbc',
  cyan: '#11a8cd',
  white: '#e5e5e5',
  brightBlack: '#666666',
  brightRed: '#f14c4c',
  brightGreen: '#23d18b',
  brightYellow: '#f5f543',
  brightBlue: '#3b8eea',
  brightMagenta: '#d670d6',
  brightCyan: '#29b8db',
  brightWhite: '#ffffff',
};

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
 * Style bits: 0x1 = bold, 0x2 = italic. FAINT is intentionally excluded —
 * atlas always rasterizes at full alpha; shaders apply the 0.5 multiplier.
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
    // Always full alpha. FAINT is applied in the shader as a 0.5 mask multiplier
    // rather than baked into the rasterization, so faint and non-faint glyphs
    // share the same atlas slot (the cache key drops the FAINT bit too).
    ctx.fillStyle = '#ffffff';
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
  /**
   * Maximum number of distinct kitty image ids to track in usedKittyImageIds
   * for this frame. Cells whose imageId would exceed this cap render as
   * background only. Defaults to 16 (WebGPU's 16-sampler limit). WebGL with
   * the kitty atlas can safely raise this to e.g. 256.
   */
  maxKittyImages?: number;
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

  // Pre-calculate selection range for the rows we'll be visiting.
  let selStartCol = -1;
  let selEndCol = -1;
  const updateRowSel = (y: number): void => {
    if (!sel) {
      selStartCol = -1;
      selEndCol = -1;
      return;
    }
    if (sel.startRow === sel.endRow) {
      if (y === sel.startRow) {
        selStartCol = sel.startCol;
        selEndCol = sel.endCol;
      } else {
        selStartCol = -1;
        selEndCol = -1;
      }
      return;
    }
    if (y === sel.startRow) {
      selStartCol = sel.startCol;
      selEndCol = Number.MAX_SAFE_INTEGER;
    } else if (y === sel.endRow) {
      selStartCol = 0;
      selEndCol = sel.endCol;
    } else if (y > sel.startRow && y < sel.endRow) {
      selStartCol = 0;
      selEndCol = Number.MAX_SAFE_INTEGER;
    } else {
      selStartCol = -1;
      selEndCol = -1;
    }
  };

  // Build virtual kitty placement index (only when kitty is enabled).
  const maxKitty = ctx.maxKittyImages ?? 16;
  const kittyVirtualPlacements = new Map<number, KittyPlacementInfo>();
  const usedKittyImageIds: number[] = [];
  const usedKittyImageIndex = new Map<number, number>();

  if (ctx.kittyEnabled && buffer.getKittyGraphics && buffer.iterPlacements) {
    const graphics = buffer.getKittyGraphics();
    if (graphics !== null) {
      for (const p of buffer.iterPlacements(graphics, false)) {
        if (p.isVirtual) {
          kittyVirtualPlacements.set(p.imageId, p);
          if (!usedKittyImageIndex.has(p.imageId) && usedKittyImageIds.length < maxKitty) {
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

  // Batch-fetch the entire viewport once to avoid the WASM crossing cost
  // of getLine(y) inside the loop.
  const viewport = buffer.getViewport();

  for (let y = 0; y < dims.rows; y++) {
    updateRowSel(y);
    let line: GhosttyCell[] | null = null;
    if (viewportY > 0) {
      if (y < viewportY && sb) {
        const off = sbLen - Math.floor(viewportY) + y;
        line = sb.getScrollbackLine(off);
      } else {
        const viewportRelativeY = y - Math.floor(viewportY);
        const start = viewportRelativeY * dims.cols;
        line = viewport.slice(start, start + dims.cols);
      }
    } else {
      const start = y * dims.cols;
      line = viewport.slice(start, start + dims.cols);
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
      if (x >= selStartCol && x <= selEndCol) flags |= FLAG_IS_SELECTED;
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
        // Combining diacritics ride on the cell as `c.grapheme` (extras
        // beyond the base codepoint), populated by GhosttyTerminal.getViewport
        // during the existing per-cell walk. Reading them here avoids the
        // O(row) buffer.getGrapheme(y, x) crossing — for placeholder-heavy
        // viewports that single change drops per-frame WASM crossings from
        // tens of thousands to ~zero.
        const extras = c.grapheme;
        if (extras && extras.length >= 2) {
          const rowD = diacriticToInt(extras[0]!);
          const colD = diacriticToInt(extras[1]!);
          if (rowD >= 0 && colD >= 0) {
            const fgRgb = (c.fg_r << 16) | (c.fg_g << 8) | c.fg_b;
            let imageId = fgRgb;
            if (extras.length >= 3) {
              const msb = diacriticToInt(extras[2]!);
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
        // Build the grapheme cluster string from cell-resident data.
        // c.grapheme (extras) was populated by GhosttyTerminal.getViewport
        // during its existing per-cell walk; reading it here avoids the
        // O(row) buffer.getGraphemeString(y, x) crossing for every emoji /
        // ZWJ / Indic-cluster cell.
        const extras = c.grapheme;
        const grapheme =
          extras && extras.length > 0
            ? String.fromCodePoint(c.codepoint || 32, ...extras)
            : String.fromCodePoint(c.codepoint || 32);
        // FAINT is intentionally NOT included in the atlas style bits. The atlas
        // always rasterizes glyphs at full alpha; shaders apply the 0.5 alpha
        // multiplier for FAINT cells. Including FAINT here would (a) double the
        // fade (atlas 0.5 × shader 0.5 = 0.25) and (b) inflate the atlas cache
        // with redundant per-glyph faint variants.
        const styleBits = (flags & FLAG_BOLD ? 1 : 0) | (flags & FLAG_ITALIC ? 2 : 0);
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

// ---------------------------------------------------------------------------
// Kitty graphics
// ---------------------------------------------------------------------------

/**
 * Convert a `KittyImagePixels` payload (RGB / GRAY / GRAY_ALPHA / RGBA) to
 * a packed `width × height × 4` RGBA8 Uint8Array. Returns null for
 * unsupported formats (PNG should be pre-decoded; if it isn't, callers
 * skip the placement) or zero-dimension images.
 *
 * Lifted from the inlined WebGPU implementation; behavior is identical.
 */
export function kittyImageToRGBA(pixels: KittyImagePixels): Uint8Array | null {
  const { width, height, format, data } = pixels;
  if (width === 0 || height === 0) return null;
  const rgba = new Uint8Array(width * height * 4);
  switch (format) {
    case KittyImageFormat.RGBA:
      rgba.set(data);
      return rgba;
    case KittyImageFormat.RGB:
      for (let i = 0, o = 0; i < data.length; i += 3, o += 4) {
        rgba[o] = data[i]!;
        rgba[o + 1] = data[i + 1]!;
        rgba[o + 2] = data[i + 2]!;
        rgba[o + 3] = 255;
      }
      return rgba;
    case KittyImageFormat.GRAY:
      for (let i = 0, o = 0; i < data.length; i++, o += 4) {
        const v = data[i]!;
        rgba[o] = v;
        rgba[o + 1] = v;
        rgba[o + 2] = v;
        rgba[o + 3] = 255;
      }
      return rgba;
    case KittyImageFormat.GRAY_ALPHA:
      for (let i = 0, o = 0; i < data.length; i += 2, o += 4) {
        const v = data[i]!;
        rgba[o] = v;
        rgba[o + 1] = v;
        rgba[o + 2] = v;
        rgba[o + 3] = data[i + 1]!;
      }
      return rgba;
    default:
      return null; // PNG (should be pre-decoded) / unknown
  }
}

/**
 * Per-image GPU texture cache for direct-placement kitty images, abstract
 * over backend texture handles. Subclasses provide createTexture / uploadFull
 * / destroyTexture for their backend.
 *
 * Cache is keyed by imageId. Each entry stores a signature (width, height,
 * format, data byteOffset, data length) so we re-upload only when the
 * underlying image data changes (caller passes the same KittyImagePixels
 * object whose .data is a view into WASM memory; if the WASM image changes
 * the byteOffset/length will too).
 */
export abstract class KittyTextureCacheBase<TBackendTexture> {
  private cache = new Map<
    number,
    {
      handle: TBackendTexture;
      width: number;
      height: number;
      format: number;
      dataPtr: number;
      dataLen: number;
      dataBuf: ArrayBufferLike;
    }
  >();

  protected abstract createTexture(width: number, height: number): TBackendTexture | null;
  protected abstract uploadFull(
    handle: TBackendTexture,
    rgba: Uint8Array,
    width: number,
    height: number
  ): void;
  protected abstract destroyTexture(handle: TBackendTexture): void;

  /**
   * Returns the cached or newly-uploaded texture for the given imageId.
   * Returns null if the image cannot be converted (e.g. undecoded PNG) or
   * if texture allocation fails.
   *
   * Signature: width × height × format × data.byteOffset × data.length ×
   * data.buffer (object identity). In practice the WASM heap never moves so
   * byteOffset/length alone would be stable, but including the buffer
   * reference ensures correctness in test environments where each
   * KittyImagePixels carries an independent allocation.
   */
  getOrUpload(imageId: number, pixels: KittyImagePixels): TBackendTexture | null {
    const cached = this.cache.get(imageId);
    const sigMatches =
      cached &&
      cached.width === pixels.width &&
      cached.height === pixels.height &&
      cached.format === pixels.format &&
      cached.dataPtr === pixels.data.byteOffset &&
      cached.dataLen === pixels.data.length &&
      cached.dataBuf === pixels.data.buffer;
    if (sigMatches) return cached.handle;

    const rgba = kittyImageToRGBA(pixels);
    if (!rgba) return null;

    if (cached) this.destroyTexture(cached.handle);
    const handle = this.createTexture(pixels.width, pixels.height);
    if (!handle) return null;
    this.uploadFull(handle, rgba, pixels.width, pixels.height);
    this.cache.set(imageId, {
      handle,
      width: pixels.width,
      height: pixels.height,
      format: pixels.format,
      dataPtr: pixels.data.byteOffset,
      dataLen: pixels.data.length,
      dataBuf: pixels.data.buffer,
    });
    return handle;
  }

  /** Lookup without upload. */
  get(imageId: number): TBackendTexture | undefined {
    return this.cache.get(imageId)?.handle;
  }

  /** Release all backend textures. Called by renderer destroy(). */
  destroyAll(): void {
    for (const entry of this.cache.values()) this.destroyTexture(entry.handle);
    this.cache.clear();
  }
}

export type KittyAtlasEntry = {
  slot: AtlasSlot;
  signature: {
    width: number;
    height: number;
    format: number;
    dataPtr: number;
    dataLen: number;
    dataBuf: ArrayBufferLike;
  };
};

/**
 * Upper bound for kitty atlas auto-growth. WebGPU & WebGL2 guarantee at least
 * 8192² for `texture_2d` / `TEXTURE_2D`; staying at-or-below keeps us inside
 * the conservative limit on every browser. An 8192² RGBA8 atlas is 256 MiB —
 * if we hit this in practice, oversize images need a per-image fallback path.
 */
const MAX_ATLAS_SIZE = 8192;

function nextPow2(n: number): number {
  let p = 1;
  while (p < n) p <<= 1;
  return p;
}

/**
 * Variable-size shelf-packed atlas for virtual-placement kitty images.
 * Parallel to GlyphAtlasBase but for arbitrary-dimension RGBA8 images.
 *
 * Atlas starts at the default size (1024²) and grows on demand — when an
 * image won't fit even after a clearAndReset, the backing texture is
 * reallocated at the next power of two that holds it (capped by
 * MAX_ATLAS_SIZE). Growth invalidates the in-flight cache (slots are
 * coordinate-tied to the old texture), and the next frame's walk re-uploads.
 * If the image exceeds MAX_ATLAS_SIZE, addOrUpdate returns null and the
 * caller skips that placement for the frame.
 *
 * Subclasses provide the backend texture upload primitive.
 */
export abstract class KittyAtlasBase {
  protected size: number;
  private nextX = 0;
  private nextY = 0;
  private rowHeight = 0;
  private cache = new Map<number, KittyAtlasEntry>();

  constructor(size = 1024) {
    this.size = size;
  }

  /** Subclass: upload a freshly-converted RGBA region into the backing texture. */
  protected abstract uploadRegion(slot: AtlasSlot, rgba: Uint8Array, w: number, h: number): void;

  /**
   * Subclass: replace the backing texture with a fresh one of `newSize × newSize`.
   * Called when an image arrives that doesn't fit (or no longer fits after a
   * clearAndReset) — see addOrUpdate. The base class has already updated
   * `this.size` and called clearAndReset() before invoking this, so the
   * subclass only needs to swap the GPU resource.
   */
  protected abstract growTexture(newSize: number): void;

  /**
   * Add (or refresh) the image for `imageId`. On signature match returns the
   * cached entry. On miss converts to RGBA, shelf-packs into the atlas, and
   * uploads. If the image doesn't fit (even after a clearAndReset retry) the
   * atlas grows to the next power of two large enough to hold it (subject to
   * MAX_ATLAS_SIZE) and retries once more. Returns null only when the image
   * is fundamentally too large or RGBA conversion failed.
   */
  addOrUpdate(imageId: number, pixels: KittyImagePixels): KittyAtlasEntry | null {
    const cached = this.cache.get(imageId);
    const sigMatches =
      cached &&
      cached.signature.width === pixels.width &&
      cached.signature.height === pixels.height &&
      cached.signature.format === pixels.format &&
      cached.signature.dataPtr === pixels.data.byteOffset &&
      cached.signature.dataLen === pixels.data.length &&
      cached.signature.dataBuf === pixels.data.buffer;
    if (sigMatches) return cached;

    const rgba = kittyImageToRGBA(pixels);
    if (!rgba) return null;

    let slot = this.tryPack(pixels.width, pixels.height);
    if (!slot) {
      this.clearAndReset();
      slot = this.tryPack(pixels.width, pixels.height);
    }
    if (!slot) {
      // Image doesn't fit at current atlas size. Grow to the next power of
      // two that holds it (capped at MAX_ATLAS_SIZE); if that's still not
      // enough, give up — caller skips the placement for the frame.
      const needed = Math.max(pixels.width, pixels.height);
      const target = nextPow2(needed);
      if (target > MAX_ATLAS_SIZE || target <= this.size) return null;
      this.size = target;
      this.clearAndReset();
      this.growTexture(target);
      slot = this.tryPack(pixels.width, pixels.height);
      if (!slot) return null;
    }
    this.uploadRegion(slot, rgba, pixels.width, pixels.height);
    const entry: KittyAtlasEntry = {
      slot,
      signature: {
        width: pixels.width,
        height: pixels.height,
        format: pixels.format,
        dataPtr: pixels.data.byteOffset,
        dataLen: pixels.data.length,
        dataBuf: pixels.data.buffer,
      },
    };
    this.cache.set(imageId, entry);
    return entry;
  }

  /** Lookup a cached entry without uploading. */
  getEntry(imageId: number): KittyAtlasEntry | undefined {
    return this.cache.get(imageId);
  }

  /** Clear cache + reset packing cursor. Surviving images get re-uploaded on next walk. */
  clearAndReset(): void {
    this.cache.clear();
    this.nextX = 0;
    this.nextY = 0;
    this.rowHeight = 0;
  }

  get atlasSize(): number {
    return this.size;
  }

  private tryPack(w: number, h: number): AtlasSlot | null {
    if (w > this.size || h > this.size) return null;
    if (this.nextX + w > this.size) {
      this.nextX = 0;
      this.nextY += this.rowHeight;
      this.rowHeight = 0;
    }
    if (this.nextY + h > this.size) return null;
    const slot: AtlasSlot = { u: this.nextX, v: this.nextY, w, h };
    this.nextX += w;
    if (h > this.rowHeight) this.rowHeight = h;
    return slot;
  }
}
