/**
 * Shared rendering utilities used by Canvas2D, WebGPU, and WebGL2 renderers.
 *
 * This module is intentionally GPU-API-agnostic — it contains only pure CPU
 * utilities (color parsing, font measurement) and shared constants
 * (cell-buffer layout, flag bits). Backend-specific concerns (shaders,
 * pipelines, buffer uploads) stay in the per-renderer files.
 */

import type { ITheme } from './interfaces';
import type { FontMetrics } from './renderer-types';

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
