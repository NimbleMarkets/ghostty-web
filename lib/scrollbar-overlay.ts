/**
 * Scrollbar overlay drawn on a sibling <canvas> element stacked above the
 * renderer's canvas. Backend-agnostic: the same instance works for both
 * Canvas2D and WebGPU renderers because the scrollbar lives outside the
 * renderer's surface.
 *
 * Thumb size and position match the logic that lived in CanvasRenderer
 * before commit history (see git log lib/renderer.ts for renderScrollbar).
 */

const SCROLLBAR_WIDTH = 8;
const SCROLLBAR_PADDING = 4;

export interface ScrollbarRenderInput {
  viewportY: number;
  scrollbackLength: number;
  visibleRows: number;
  opacity: number;
}

export class ScrollbarOverlay {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private dpr: number;

  constructor(canvas: HTMLCanvasElement, devicePixelRatio: number) {
    this.canvas = canvas;
    this.dpr = devicePixelRatio;
    const ctx = canvas.getContext('2d', { alpha: true });
    if (!ctx) throw new Error('ScrollbarOverlay: failed to acquire 2D context');
    this.ctx = ctx;
  }

  /** CSS dimensions follow the underlying renderer canvas. */
  resize(cssWidth: number, cssHeight: number): void {
    this.canvas.style.width = `${cssWidth}px`;
    this.canvas.style.height = `${cssHeight}px`;
    this.canvas.width = Math.round(cssWidth * this.dpr);
    this.canvas.height = Math.round(cssHeight * this.dpr);
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
  }

  setDevicePixelRatio(dpr: number): void {
    this.dpr = dpr;
  }

  /** Draw the scrollbar. Clears the entire overlay each call. */
  render(input: ScrollbarRenderInput): void {
    const ctx = this.ctx;
    const cssW = this.canvas.width / this.dpr;
    const cssH = this.canvas.height / this.dpr;

    ctx.clearRect(0, 0, cssW, cssH);

    if (input.opacity <= 0 || input.scrollbackLength === 0) return;

    const trackX = cssW - SCROLLBAR_WIDTH - SCROLLBAR_PADDING;
    const trackTop = SCROLLBAR_PADDING;
    const trackHeight = cssH - SCROLLBAR_PADDING * 2;
    if (trackHeight <= 0) return;

    const totalLines = input.scrollbackLength + input.visibleRows;
    const thumbHeight = Math.max(20, (input.visibleRows / totalLines) * trackHeight);
    const scrollPosition = input.viewportY / input.scrollbackLength;
    const thumbY = trackTop + (trackHeight - thumbHeight) * (1 - scrollPosition);

    ctx.fillStyle = `rgba(128, 128, 128, ${0.1 * input.opacity})`;
    ctx.fillRect(trackX, trackTop, SCROLLBAR_WIDTH, trackHeight);

    const isScrolled = input.viewportY > 0;
    const baseAlpha = isScrolled ? 0.5 : 0.3;
    ctx.fillStyle = `rgba(128, 128, 128, ${baseAlpha * input.opacity})`;
    ctx.fillRect(trackX, thumbY, SCROLLBAR_WIDTH, thumbHeight);
  }

  /**
   * Test hook: returns what render() *would* draw without touching ctx state.
   * Used by unit tests since happy-dom's mock canvas can't readback fillRect.
   */
  _renderForTest(input: ScrollbarRenderInput): { thumb: { y: number; height: number } | null } {
    if (input.opacity <= 0 || input.scrollbackLength === 0) return { thumb: null };
    const cssH = this.canvas.height / this.dpr;
    const trackHeight = cssH - SCROLLBAR_PADDING * 2;
    if (trackHeight <= 0) return { thumb: null };
    const totalLines = input.scrollbackLength + input.visibleRows;
    const thumbHeight = Math.max(20, (input.visibleRows / totalLines) * trackHeight);
    const scrollPosition = input.viewportY / input.scrollbackLength;
    const thumbY = SCROLLBAR_PADDING + (trackHeight - thumbHeight) * (1 - scrollPosition);
    return { thumb: { y: thumbY, height: thumbHeight } };
  }

  /** Hit-test helper (Terminal's drag handler uses this). */
  hitTest(
    cssX: number,
    cssY: number,
    scrollbackLength: number,
    visibleRows: number
  ): 'thumb' | 'track' | null {
    if (scrollbackLength === 0) return null;
    const cssW = this.canvas.width / this.dpr;
    const cssH = this.canvas.height / this.dpr;
    const trackX = cssW - SCROLLBAR_WIDTH - SCROLLBAR_PADDING;
    const trackHeight = cssH - SCROLLBAR_PADDING * 2;
    if (cssX < trackX || cssX > trackX + SCROLLBAR_WIDTH) return null;
    if (cssY < SCROLLBAR_PADDING || cssY > SCROLLBAR_PADDING + trackHeight) return null;
    return 'thumb'; // simple hit zone; thumb-vs-track refinement done by Terminal
  }

  destroy(): void {
    // No timers; the canvas is owned by the DOM.
  }
}
