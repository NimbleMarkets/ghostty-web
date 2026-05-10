/**
 * Renderer interface and shared types.
 *
 * The Renderer is a pluggable boundary for terminal rendering backends.
 * Today there are two: CanvasRenderer (lib/renderer.ts) and WebGPURenderer
 * (lib/renderer-webgpu.ts). Both consume IRenderable + IScrollbackProvider
 * exactly as before; selection state, link-hover state, theme, and font
 * metrics are part of the renderer's own state.
 *
 * What is NOT in the renderer:
 * - Scrollbar drawing (lib/scrollbar-overlay.ts on a sibling canvas)
 * - Cursor-blink timer (lib/cursor-blink.ts)
 *
 * The renderer signals "I changed my own state, please schedule a frame"
 * via setOnRequestRender. The Terminal owns the actual scheduler.
 */

import type { ITheme } from './interfaces';
import type { SelectionManager } from './selection-manager';
import type { GhosttyCell, KittyImagePixels, KittyPlacementInfo } from './types';

export type RendererBackend = 'webgpu' | 'webgl' | 'canvas2d' | 'auto';

export interface RendererOptions {
  fontSize?: number;
  fontFamily?: string;
  cursorStyle?: 'block' | 'underline' | 'bar';
  cursorBlink?: boolean;
  theme?: ITheme;
  devicePixelRatio?: number;
}

export interface FontMetrics {
  width: number;
  height: number;
  baseline: number;
}

export interface LinkRange {
  startX: number;
  startY: number;
  endX: number;
  endY: number;
}

/**
 * Buffer adapter consumed by renderers. CanvasRenderer and WebGPURenderer
 * both read cells through this surface; the GhosttyTerminal implements it.
 */
export interface IRenderable {
  getLine(y: number): GhosttyCell[] | null;
  getViewport(): GhosttyCell[];
  getCursor(): { x: number; y: number; visible: boolean };
  getDimensions(): { cols: number; rows: number };
  isRowDirty(y: number): boolean;
  needsFullRedraw?(): boolean;
  clearDirty(): void;
  getGraphemeString?(row: number, col: number): string;

  // Kitty graphics — optional; absent on test fakes.
  getKittyGraphics?(): number | null;
  iterPlacements?(graphics: number, onlyVisible?: boolean): Iterable<KittyPlacementInfo>;
  getKittyImagePixels?(graphics: number, imageId: number): KittyImagePixels | null;
  getGrapheme?(row: number, col: number): number[] | null;
}

export interface IScrollbackProvider {
  getScrollbackLine(offset: number): GhosttyCell[] | null;
  getScrollbackLength(): number;
}

/**
 * Pluggable terminal renderer. Implemented by CanvasRenderer and WebGPURenderer.
 */
export interface Renderer {
  readonly backend: 'webgpu' | 'webgl' | 'canvas2d';
  readonly canvas: HTMLCanvasElement;

  getMetrics(): FontMetrics;
  resize(cols: number, rows: number): void;

  /**
   * Render one frame. Cheap when nothing has changed (steady-state cost is
   * one walk + one buffer write).
   */
  render(buffer: IRenderable, viewportY?: number, scrollbackProvider?: IScrollbackProvider): void;

  setTheme(theme: ITheme): void;
  setFontSize(size: number): void;
  setFontFamily(family: string): void;
  setCursorStyle(style: 'block' | 'underline' | 'bar'): void;
  setCursorBlink(enabled: boolean): void;

  setOnRequestRender(fn: (() => void) | null): void;
  setSelectionManager(mgr: SelectionManager): void;
  setHoveredHyperlinkId(id: number): void;
  setHoveredLinkRange(range: LinkRange | null): void;

  /** Force a full repaint on next render() (e.g. after font change). */
  invalidate(): void;

  /** Best-effort remeasure when the font has loaded after construction. */
  remeasureFont(): void;

  destroy(): void;
}
