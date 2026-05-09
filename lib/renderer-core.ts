/**
 * Shared rendering utilities used by Canvas2D, WebGPU, and WebGL2 renderers.
 *
 * This module is intentionally GPU-API-agnostic — it contains only pure CPU
 * utilities (color parsing, font measurement) and shared constants
 * (cell-buffer layout, flag bits). Backend-specific concerns (shaders,
 * pipelines, buffer uploads) stay in the per-renderer files.
 */

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
