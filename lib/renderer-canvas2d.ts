/**
 * Canvas Renderer for Terminal Display
 *
 * High-performance canvas-based renderer that draws the terminal using
 * Ghostty's WASM terminal emulator. Features:
 * - Font metrics measurement with DPI scaling
 * - Full color support (256-color palette + RGB)
 * - All text styles (bold, italic, underline, strikethrough, etc.)
 * - Multiple cursor styles (block, underline, bar)
 * - Dirty line optimization for 60 FPS
 */

import type { RowBidiMapper } from './bidi';
import { CursorBlink } from './cursor-blink';
import type { ITheme } from './interfaces';
import { KITTY_PLACEHOLDER, diacriticToInt } from './kitty_diacritics';
import { DEFAULT_THEME, measureFont as coreMeasureFont } from './renderer-core';
import type {
  FontMetrics,
  IRenderable,
  IScrollbackProvider,
  LinkRange,
  Renderer,
  RendererOptions,
} from './renderer-types';
import type { SelectionManager } from './selection-manager';
import type { GhosttyCell, ILink, KittyImagePixels, KittyPlacementInfo } from './types';
import { CellFlags, KittyImageFormat } from './types';

// ============================================================================
// CanvasRenderer Class
// ============================================================================

/**
 * Staleness check for kittyImageCache: an entry is reusable iff every
 * identity field matches the just-fetched KittyImagePixels. Width/height/
 * format catch geometry/format changes (which can keep dataLen identical —
 * e.g., 100×50 RGBA and 50×100 RGBA both serialize to 20000 bytes), and
 * dataPtr (the WASM byteOffset) catches re-allocations from retransmits.
 */
function cachedMatchesPixels(
  cached: {
    width: number;
    height: number;
    format: KittyImageFormat;
    dataPtr: number;
    dataLen: number;
  },
  pixels: KittyImagePixels
): boolean {
  return (
    cached.width === pixels.width &&
    cached.height === pixels.height &&
    cached.format === pixels.format &&
    cached.dataPtr === pixels.data.byteOffset &&
    cached.dataLen === pixels.data.length
  );
}

export class CanvasRenderer implements Renderer {
  public readonly backend = 'canvas2d' as const;
  private canvasEl: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private fontSize: number;
  private fontFamily: string;
  private cursorStyle: 'block' | 'underline' | 'bar';
  private cursorBlink: boolean;
  private theme: Required<ITheme>;
  private devicePixelRatio: number;
  private metrics: FontMetrics;
  private palette: string[];

  // Cursor blinking state
  private cursorBlink_ = new CursorBlink();
  private lastCursorPosition: { x: number; y: number } = { x: 0, y: 0 };

  // Hook called whenever the renderer's own internal state (today: cursor
  // blink toggle) changes such that the next frame would look different.
  // Set by Terminal so it can wake its render scheduler. Without this, an
  // event-driven Terminal that has gone idle would never repaint the
  // blinking cursor.
  private onRequestRender: (() => void) | null = null;

  // Viewport tracking (for scrolling)
  private lastViewportY: number = 0;

  // Current buffer being rendered (for grapheme lookups)
  private currentBuffer: IRenderable | null = null;

  /**
   * Decoded kitty graphics images, keyed by image id. Each entry caches
   * a canvas painted from the WASM-side RGBA bytes so per-frame compositing
   * is just a drawImage call.
   *
   * Staleness key combines width/height/format/dataPtr/dataLen — the
   * kitty protocol allows reusing an id with new bytes, and dataLen alone
   * is too weak (transposed dims or format change can keep byte count
   * identical). dataPtr is the WASM byteOffset, which changes whenever
   * ghostty frees + re-allocates the image bytes (i.e., on retransmit).
   */
  private kittyImageCache = new Map<
    number,
    {
      canvas: HTMLCanvasElement;
      width: number;
      height: number;
      format: KittyImageFormat;
      dataPtr: number;
      dataLen: number;
    }
  >();

  /**
   * Per-frame index of virtual placements keyed by image id. Populated
   * once at the start of each render() pass (cheap — typically zero or
   * a handful of entries). Looked up by U+10EEEE placeholder cells in
   * renderPlaceholderCell to find the placement's grid dimensions.
   */
  private kittyVirtualPlacements = new Map<number, KittyPlacementInfo>();

  /**
   * Direct (non-virtual) placements that need compositing this frame.
   * Built once per render() in precomputeKittyState so renderKittyImages
   * doesn't re-walk the iterator. Empty when no kitty graphics are active.
   */
  private currentDirectPlacements: KittyPlacementInfo[] = [];

  /**
   * Last frame's direct-placement signatures, keyed by image id. Used to
   * detect placement add/remove/move/redecode so we can mark the affected
   * rows for repaint (clearing stale image pixels) and skip the composite
   * pass entirely when nothing has changed. dataLen is the same staleness
   * discriminator used by kittyImageCache.
   */
  private lastKittyDirectSigs = new Map<
    number,
    {
      viewportCol: number;
      viewportRow: number;
      pixelWidth: number;
      pixelHeight: number;
      sourceX: number;
      sourceY: number;
      sourceWidth: number;
      sourceHeight: number;
      imgWidth: number;
      imgHeight: number;
      imgFormat: KittyImageFormat;
      dataPtr: number;
      dataLen: number;
    }
  >();

  /**
   * Last frame's virtual-placement image-byte signatures, keyed by image
   * id. Virtual placements aren't composited by renderKittyImages — they
   * paint via per-cell renderPlaceholderCell substitution — so cells only
   * repaint when the row is otherwise dirty (cursor, selection, text
   * change). When the application transmits new bytes for the same
   * image_id, the placeholder cells themselves stay clean and Canvas2D
   * would skip them. Tracking these signatures lets us flag the whole
   * viewport as damaged on bytes-change so the per-cell substitution
   * runs and picks up the new (already re-decoded by getOrDecodeKittyImage)
   * bitmap. WebGPU/WebGL don't need this because they re-encode the cell
   * grid and re-sample the kitty atlas every frame.
   */
  private lastKittyVirtualSigs = new Map<
    number,
    {
      imgWidth: number;
      imgHeight: number;
      imgFormat: KittyImageFormat;
      dataPtr: number;
      dataLen: number;
    }
  >();

  /**
   * Rows whose image footprint changed since last frame (placement added,
   * removed, moved, resized, or re-decoded under the same id). Added to
   * rowsToRender so the underlying text repaints — which clears stale
   * image pixels — before we composite the current placements on top.
   */
  private kittyDamagedRows = new Set<number>();

  /**
   * Cached IRenderable on the current render() call so renderCellText
   * can call into it (e.g. getGrapheme) without us threading the buffer
   * through every helper. Set at the top of render(), cleared at the end.
   */
  private currentRenderBuffer: IRenderable | null = null;

  /** @internal Test-only accessor for kittyDamagedRows. Not part of the public API. */
  public _testGetKittyDamagedRows(): ReadonlySet<number> {
    return this.kittyDamagedRows;
  }

  /** @internal Test-only entry to precomputeKittyState. Not part of the public API. */
  public _testPrecomputeKittyState(buffer: IRenderable, rows: number): void {
    this.precomputeKittyState(buffer, rows);
  }

  // Frame-skip state. See WebGPURenderer for the full rationale; same
  // mechanism, same trade-offs. Canvas2D already had per-row dirty-skipping
  // inside render(), but the entry-level work (precomputeKittyState,
  // selection / hyperlink bookkeeping, cursor pass) ran every call. This
  // gate makes a no-op render() actually a no-op.
  private lastCursorVisible = false;
  private lastCursorBlinkVisible = true;
  private lastSelectionSig: string | null = null;
  private lastKittyPlacementSig: string | null = null;
  private currentKittyGraphics: number | null = null;

  // Selection manager (for rendering selection)
  private selectionManager?: SelectionManager;
  // Shared BiDi row mapper (absent = paint logical order)
  private bidiMapper: RowBidiMapper | null = null;
  // Cached selection coordinates for current render pass (viewport-relative)
  private currentSelectionCoords: {
    startCol: number;
    startRow: number;
    endCol: number;
    endRow: number;
  } | null = null;

  // Link rendering state
  private hoveredHyperlinkId: number = 0;
  private previousHoveredHyperlinkId: number = 0;

  // Regex link hover tracking (for links without hyperlink_id)
  private hoveredLinkRange: { startX: number; startY: number; endX: number; endY: number } | null =
    null;
  private previousHoveredLinkRange: {
    startX: number;
    startY: number;
    endX: number;
    endY: number;
  } | null = null;

  constructor(canvas: HTMLCanvasElement, options: RendererOptions = {}) {
    this.canvasEl = canvas;
    const ctx = canvas.getContext('2d', { alpha: true });
    if (!ctx) {
      throw new Error('Failed to get 2D rendering context');
    }
    this.ctx = ctx;

    // Apply options
    this.fontSize = options.fontSize ?? 15;
    this.fontFamily = options.fontFamily ?? 'monospace';
    this.cursorStyle = options.cursorStyle ?? 'block';
    this.cursorBlink = options.cursorBlink ?? false;
    this.theme = { ...DEFAULT_THEME, ...options.theme };
    this.devicePixelRatio = options.devicePixelRatio ?? window.devicePixelRatio ?? 1;

    // Build color palette (16 ANSI colors)
    this.palette = [
      this.theme.black,
      this.theme.red,
      this.theme.green,
      this.theme.yellow,
      this.theme.blue,
      this.theme.magenta,
      this.theme.cyan,
      this.theme.white,
      this.theme.brightBlack,
      this.theme.brightRed,
      this.theme.brightGreen,
      this.theme.brightYellow,
      this.theme.brightBlue,
      this.theme.brightMagenta,
      this.theme.brightCyan,
      this.theme.brightWhite,
    ];

    // Measure font metrics
    this.metrics = this.measureFont();

    // Setup cursor blinking if enabled
    this.cursorBlink_.setEnabled(this.cursorBlink);
  }

  // ==========================================================================
  // Font Metrics Measurement
  // ==========================================================================

  private measureFont(): FontMetrics {
    return coreMeasureFont(this.fontSize, this.fontFamily);
  }

  /**
   * Remeasure font metrics (call after font loads or changes)
   */
  public remeasureFont(): void {
    this.metrics = this.measureFont();
    this.invalidateNext = true;
  }

  // ==========================================================================
  // Color Conversion
  // ==========================================================================

  private rgbToCSS(r: number, g: number, b: number): string {
    return `rgb(${r}, ${g}, ${b})`;
  }

  // ==========================================================================
  // Canvas Sizing
  // ==========================================================================

  /**
   * Resize canvas to fit terminal dimensions
   */
  public resize(cols: number, rows: number): void {
    const cssWidth = cols * this.metrics.width;
    const cssHeight = rows * this.metrics.height;

    // Set CSS size (what user sees)
    this.canvasEl.style.width = `${cssWidth}px`;
    this.canvasEl.style.height = `${cssHeight}px`;

    // Set actual canvas size (scaled for DPI)
    this.canvasEl.width = cssWidth * this.devicePixelRatio;
    this.canvasEl.height = cssHeight * this.devicePixelRatio;

    // Scale context to match DPI (setting canvas.width/height resets the context)
    this.ctx.scale(this.devicePixelRatio, this.devicePixelRatio);

    // Set text rendering properties for crisp text
    this.ctx.textBaseline = 'alphabetic';
    this.ctx.textAlign = 'left';

    // Fill background after resize
    this.ctx.fillStyle = this.theme.background;
    this.ctx.fillRect(0, 0, cssWidth, cssHeight);
    this.invalidateNext = true;
  }

  // ==========================================================================
  // Main Rendering
  // ==========================================================================

  // Initialized true so the first render() after construction always
  // paints, matching WebGPU/WebGL. Pre-frame-skip Canvas2D survived a
  // false initial value because render()'s internal needsResize check
  // forced a full paint on the first call; once the top-level frame-skip
  // gate exists, an honest "nothing has changed yet" answer would
  // (incorrectly) skip frame 1.
  private invalidateNext = true;

  public invalidate(): void {
    this.invalidateNext = true;
  }

  /**
   * Render the terminal buffer to canvas
   */
  /** See WebGPURenderer.bufferAnyDirty. */
  private bufferAnyDirty(buffer: IRenderable): boolean {
    if (buffer.needsFullRedraw?.()) return true;
    const dims = buffer.getDimensions();
    for (let y = 0; y < dims.rows; y++) {
      if (buffer.isRowDirty(y)) return true;
    }
    return false;
  }

  /** See WebGPURenderer.computeSelectionSig. */
  private computeSelectionSig(): string | null {
    const sel = this.selectionManager?.getSelectionCoords() ?? null;
    if (!sel) return null;
    return `${sel.startRow},${sel.startCol}-${sel.endRow},${sel.endCol}`;
  }

  /** See WebGPURenderer.computeKittyPlacementSig. */
  private computeKittyPlacementSig(buffer: IRenderable): string | null {
    if (!buffer.getKittyGraphics || !buffer.iterPlacements) return null;
    const graphics = buffer.getKittyGraphics();
    if (graphics === null) return null;
    let sig = '';
    for (const p of buffer.iterPlacements(graphics, false)) {
      const pixels = buffer.getKittyImagePixels?.(graphics, p.imageId);
      sig += `${p.imageId}|${p.isVirtual ? 1 : 0}|${p.viewportCol},${p.viewportRow}|${p.pixelWidth}x${p.pixelHeight}|${p.sourceX},${p.sourceY},${p.sourceWidth}x${p.sourceHeight}|${pixels?.width ?? 0}x${pixels?.height ?? 0}|${pixels?.format ?? 0}|${pixels?.data.byteOffset ?? 0}+${pixels?.data.length ?? 0};`;
    }
    return sig;
  }

  public render(
    buffer: IRenderable,
    viewportY: number = 0,
    scrollbackProvider?: IScrollbackProvider
  ): void {
    // Frame-skip gate. See WebGPURenderer.render() for rationale. Must
    // run BEFORE invalidateNext is reset and BEFORE precomputeKittyState
    // (which mutates this.lastKittyVirtualSigs) — when the gate decides
    // to skip, none of the per-frame state should change.
    const cursorEarly = buffer.getCursor();
    const cursorBlinkVisible = this.cursorBlink_.isVisible();
    let stateChanged =
      this.invalidateNext ||
      cursorEarly.x !== this.lastCursorPosition.x ||
      cursorEarly.y !== this.lastCursorPosition.y ||
      cursorEarly.visible !== this.lastCursorVisible ||
      cursorBlinkVisible !== this.lastCursorBlinkVisible ||
      viewportY !== this.lastViewportY ||
      this.bufferAnyDirty(buffer);
    const selSig = stateChanged ? null : this.computeSelectionSig();
    if (!stateChanged && selSig !== this.lastSelectionSig) stateChanged = true;
    const kittySig = stateChanged ? null : this.computeKittyPlacementSig(buffer);
    if (!stateChanged && kittySig !== this.lastKittyPlacementSig) stateChanged = true;
    if (!stateChanged) return;
    // Refresh trackers managed only by the gate; the existing render()
    // body keeps lastCursorPosition / lastViewportY / invalidateNext
    // up to date through its own paths.
    this.lastCursorVisible = cursorEarly.visible;
    this.lastCursorBlinkVisible = cursorBlinkVisible;
    this.lastSelectionSig = selSig ?? this.computeSelectionSig();
    this.lastKittyPlacementSig = kittySig ?? this.computeKittyPlacementSig(buffer);

    const forceAll = this.invalidateNext;
    this.invalidateNext = false;

    // Store buffer reference for grapheme lookups in renderCell
    this.currentBuffer = buffer;
    this.currentRenderBuffer = buffer;

    // getCursor() calls update() internally to ensure fresh state.
    // Multiple update() calls are safe - dirty state persists until clearDirty().
    const cursor = buffer.getCursor();
    const dims = buffer.getDimensions();

    // Pre-frame: build the virtual-placement index so unicode-placeholder
    // cells can look up their target image's grid layout in O(1) during
    // the per-cell text pass. Also collects direct placements + computes
    // kittyDamagedRows (rows where a placement was added/removed/moved/
    // re-decoded, so the text underneath needs repainting to clear stale
    // image pixels).
    this.precomputeKittyState(buffer, dims.rows);
    const scrollbackLength = scrollbackProvider ? scrollbackProvider.getScrollbackLength() : 0;

    // Check if buffer needs full redraw (e.g., screen change between normal/alternate)
    let forceAllMut = forceAll;
    if (buffer.needsFullRedraw?.()) {
      forceAllMut = true;
    }

    // Resize canvas if dimensions changed
    const needsResize =
      this.canvasEl.width !== dims.cols * this.metrics.width * this.devicePixelRatio ||
      this.canvasEl.height !== dims.rows * this.metrics.height * this.devicePixelRatio;

    if (needsResize) {
      this.resize(dims.cols, dims.rows);
      forceAllMut = true; // Force full render after resize
    }

    // Force re-render when viewport changes (scrolling)
    if (viewportY !== this.lastViewportY) {
      forceAllMut = true;
      this.lastViewportY = viewportY;
    }

    // Check if cursor position changed or if blinking (need to redraw cursor line)
    const cursorMoved =
      cursor.x !== this.lastCursorPosition.x || cursor.y !== this.lastCursorPosition.y;
    if (cursorMoved || this.cursorBlink) {
      // Mark cursor lines as needing redraw
      if (!forceAllMut && !buffer.isRowDirty(cursor.y)) {
        // Need to redraw cursor line
        const line = buffer.getLine(cursor.y);
        if (line) {
          this.renderLine(line, cursor.y, dims.cols);
        }
      }
      if (cursorMoved && this.lastCursorPosition.y !== cursor.y) {
        // Also redraw old cursor line if cursor moved to different line
        if (!forceAllMut && !buffer.isRowDirty(this.lastCursorPosition.y)) {
          const line = buffer.getLine(this.lastCursorPosition.y);
          if (line) {
            this.renderLine(line, this.lastCursorPosition.y, dims.cols);
          }
        }
      }
    }

    // Check if we need to redraw selection-related lines
    const hasSelection = this.selectionManager && this.selectionManager.hasSelection();
    const selectionRows = new Set<number>();

    // Cache selection coordinates for use during cell rendering
    // This is used by isInSelection() to determine if a cell needs selection colors
    this.currentSelectionCoords = hasSelection ? this.selectionManager!.getSelectionCoords() : null;

    // Mark current selection rows for redraw (includes programmatic selections)
    if (this.currentSelectionCoords) {
      const coords = this.currentSelectionCoords;
      for (let row = coords.startRow; row <= coords.endRow; row++) {
        selectionRows.add(row);
      }
    }

    // Always mark dirty selection rows for redraw (to clear old overlay)
    if (this.selectionManager) {
      const dirtyRows = this.selectionManager.getDirtySelectionRows();
      if (dirtyRows.size > 0) {
        for (const row of dirtyRows) {
          selectionRows.add(row);
        }
        // Clear the dirty rows tracking after marking for redraw
        this.selectionManager.clearDirtySelectionRows();
      }
    }

    // Track rows with hyperlinks that need redraw when hover changes
    const hyperlinkRows = new Set<number>();
    const hyperlinkChanged = this.hoveredHyperlinkId !== this.previousHoveredHyperlinkId;
    const linkRangeChanged =
      JSON.stringify(this.hoveredLinkRange) !== JSON.stringify(this.previousHoveredLinkRange);

    if (hyperlinkChanged) {
      // Find rows containing the old or new hovered hyperlink
      // Must check the correct buffer based on viewportY (scrollback vs screen)
      for (let y = 0; y < dims.rows; y++) {
        let line: GhosttyCell[] | null = null;

        // Same logic as rendering: fetch from scrollback or screen
        if (viewportY > 0) {
          if (y < viewportY && scrollbackProvider) {
            // This row is from scrollback
            // Floor viewportY for array access (handles fractional values during smooth scroll)
            const scrollbackOffset = scrollbackLength - Math.floor(viewportY) + y;
            line = scrollbackProvider.getScrollbackLine(scrollbackOffset);
          } else {
            // This row is from visible screen
            const screenRow = y - Math.floor(viewportY);
            line = buffer.getLine(screenRow);
          }
        } else {
          // At bottom - fetch from visible screen
          line = buffer.getLine(y);
        }

        if (line) {
          for (const cell of line) {
            if (
              cell.hyperlink_id === this.hoveredHyperlinkId ||
              cell.hyperlink_id === this.previousHoveredHyperlinkId
            ) {
              hyperlinkRows.add(y);
              break; // Found hyperlink in this row
            }
          }
        }
      }
      // Update previous state
      this.previousHoveredHyperlinkId = this.hoveredHyperlinkId;
    }

    // Track rows affected by link range changes (for regex URLs)
    if (linkRangeChanged) {
      // Add rows from old range
      if (this.previousHoveredLinkRange) {
        for (
          let y = this.previousHoveredLinkRange.startY;
          y <= this.previousHoveredLinkRange.endY;
          y++
        ) {
          hyperlinkRows.add(y);
        }
      }
      // Add rows from new range
      if (this.hoveredLinkRange) {
        for (let y = this.hoveredLinkRange.startY; y <= this.hoveredLinkRange.endY; y++) {
          hyperlinkRows.add(y);
        }
      }
      this.previousHoveredLinkRange = this.hoveredLinkRange;
    }

    // Track if anything was actually rendered
    let anyLinesRendered = false;

    // Determine which rows need rendering.
    // We also include adjacent rows (above and below) for each dirty row to handle
    // glyph overflow - tall glyphs like Devanagari vowel signs can extend into
    // adjacent rows' visual space.
    const rowsToRender = new Set<number>();
    for (let y = 0; y < dims.rows; y++) {
      // When scrolled, always force render all lines since we're showing scrollback
      const needsRender =
        viewportY > 0
          ? true
          : forceAllMut ||
            buffer.isRowDirty(y) ||
            selectionRows.has(y) ||
            hyperlinkRows.has(y) ||
            this.kittyDamagedRows.has(y);

      if (needsRender) {
        rowsToRender.add(y);
        // Include adjacent rows to handle glyph overflow
        if (y > 0) rowsToRender.add(y - 1);
        if (y < dims.rows - 1) rowsToRender.add(y + 1);
      }
    }

    // Render each line
    for (let y = 0; y < dims.rows; y++) {
      if (!rowsToRender.has(y)) {
        continue;
      }

      anyLinesRendered = true;

      // Fetch line from scrollback or visible screen
      let line: GhosttyCell[] | null = null;
      if (viewportY > 0) {
        // Scrolled up - need to fetch from scrollback + visible screen
        // When scrolled up N lines, we want to show:
        // - Scrollback lines (from the end) + visible screen lines

        // Check if this row should come from scrollback or visible screen
        if (y < viewportY && scrollbackProvider) {
          // This row is from scrollback (upper part of viewport)
          // Get from end of scrollback buffer
          // Floor viewportY for array access (handles fractional values during smooth scroll)
          const scrollbackOffset = scrollbackLength - Math.floor(viewportY) + y;
          line = scrollbackProvider.getScrollbackLine(scrollbackOffset);
        } else {
          // This row is from visible screen (lower part of viewport)
          const screenRow = viewportY > 0 ? y - Math.floor(viewportY) : y;
          line = buffer.getLine(screenRow);
        }
      } else {
        // At bottom - fetch from visible screen
        line = buffer.getLine(y);
      }

      if (line) {
        this.renderLine(line, y, dims.cols);
      }
    }

    // Selection highlighting is now integrated into renderCellBackground/renderCellText
    // No separate overlay pass needed - this fixes z-order issues with complex glyphs

    // Link underlines are drawn during cell rendering (see renderCell)

    // Composite kitty graphics images on top of the text. MVP z-order is
    // "above text" — programs sending images typically clear the cell area
    // first, so there's nothing meaningful underneath. A future commit can
    // split into below/above-text passes via PlacementLayer if real apps
    // need it.
    //
    // Skip when no rows were repainted: the previous frame's image pixels
    // are still on the canvas and unchanged, and re-issuing drawImage with
    // source-over compositing onto translucent images would accumulate
    // alpha. Placement adds/removes/moves seed kittyDamagedRows in
    // precomputeKittyState, which forces those rows into rowsToRender and
    // flips anyLinesRendered to true.
    if (this.currentDirectPlacements.length > 0 && anyLinesRendered) {
      this.renderKittyImages();
    }

    // Render cursor (only if we're at the bottom, not scrolled)
    if (viewportY === 0 && cursor.visible && this.cursorBlink_.isVisible()) {
      this.renderCursor(cursor.x, cursor.y);
    }

    // Update last cursor position
    this.lastCursorPosition = { x: cursor.x, y: cursor.y };

    // ALWAYS clear dirty flags after rendering, regardless of forceAll.
    // This is critical - if we don't clear after a full redraw, the dirty
    // state persists and the next frame might not detect new changes properly.
    buffer.clearDirty();
  }

  /**
   * Render a single line using two-pass approach:
   * 1. First pass: Draw all cell backgrounds
   * 2. Second pass: Draw all cell text and decorations
   *
   * This two-pass approach is necessary for proper rendering of complex scripts
   * like Devanagari where diacritics (like vowel sign ि) can extend LEFT of the
   * base character into the previous cell's visual area. If we draw backgrounds
   * and text in a single pass (cell by cell), the background of cell N would
   * cover any left-extending portions of graphemes from cell N-1.
   */
  private renderLine(line: GhosttyCell[], y: number, cols: number): void {
    const lineY = y * this.metrics.height;
    const lineWidth = cols * this.metrics.width;

    // Clear line background then fill with theme color.
    // We clear just the cell area - glyph overflow is handled by also
    // redrawing adjacent rows (see render() method).
    // clearRect is needed because fillRect composites rather than replaces,
    // so transparent/translucent backgrounds wouldn't clear previous content.
    this.ctx.clearRect(0, lineY, lineWidth, this.metrics.height);
    this.ctx.fillStyle = this.theme.background;
    this.ctx.fillRect(0, lineY, lineWidth, this.metrics.height);

    // PASS 1: Draw all cell backgrounds first
    // This ensures all backgrounds are painted before any text, allowing text
    // to "bleed" across cell boundaries without being covered by adjacent backgrounds
    for (let x = 0; x < line.length; x++) {
      const cell = line[x];
      if (cell.width === 0) continue; // Skip spacer cells for wide characters
      this.renderCellBackground(cell, x, y);
    }

    // PASS 2: Draw all cell text and decorations
    // Now text can safely extend beyond cell boundaries (for complex scripts)
    for (let x = 0; x < line.length; x++) {
      const cell = line[x];
      if (cell.width === 0) continue; // Skip spacer cells for wide characters
      this.renderCellText(cell, x, y);
    }
  }

  /**
   * Render a cell's background only (Pass 1 of two-pass rendering)
   * Selection highlighting is integrated here to avoid z-order issues with
   * complex glyphs (like Devanagari) that extend outside their cell bounds.
   */
  private renderCellBackground(cell: GhosttyCell, x: number, y: number): void {
    const cellX = x * this.metrics.width;
    const cellY = y * this.metrics.height;
    const cellWidth = this.metrics.width * cell.width;

    // Check if this cell is selected
    const isSelected = this.isInSelection(x, y);

    if (isSelected) {
      // Draw selection background (solid color, not overlay)
      this.ctx.fillStyle = this.theme.selectionBackground;
      this.ctx.fillRect(cellX, cellY, cellWidth, this.metrics.height);
      return; // Selection background replaces cell background
    }

    // Extract background color and handle inverse
    let bg_r = cell.bg_r,
      bg_g = cell.bg_g,
      bg_b = cell.bg_b;

    if (cell.flags & CellFlags.INVERSE) {
      // When inverted, background becomes foreground
      bg_r = cell.fg_r;
      bg_g = cell.fg_g;
      bg_b = cell.fg_b;
    }

    // Cells with the default bg let the line-level theme.background fill
    // (drawn earlier in renderLine) show through. Cells with an explicit
    // bg — including literal RGB(0,0,0) — get painted here. The cell's
    // bgIsDefault flag carries the GhosttyStyleColor tag from upstream;
    // we cannot infer it from the RGB triple because (0,0,0) is a valid
    // explicit color (programs emit it for "true black" backgrounds, e.g.
    // letterboxed image renderings).
    const useThemeBg = cell.flags & CellFlags.INVERSE ? cell.fgIsDefault : cell.bgIsDefault;
    if (!useThemeBg) {
      this.ctx.fillStyle = this.rgbToCSS(bg_r, bg_g, bg_b);
      this.ctx.fillRect(cellX, cellY, cellWidth, this.metrics.height);
    }
  }

  /**
   * Render a cell's text and decorations (Pass 2 of two-pass rendering)
   * Selection foreground color is applied here to match the selection background.
   */
  private renderCellText(cell: GhosttyCell, x: number, y: number, colorOverride?: string): void {
    const cellX = x * this.metrics.width;
    const cellY = y * this.metrics.height;
    const cellWidth = this.metrics.width * cell.width;

    // Kitty unicode placeholder: cells with codepoint U+10EEEE represent
    // a slice of a virtually-placed image. Substitute the slice draw for
    // text rendering. If it's not a valid placeholder (e.g., the image
    // hasn't been transmitted yet), fall through and render as text —
    // typically the system "missing glyph" box, which is the expected
    // behavior for a stray U+10EEEE.
    if (cell.codepoint === KITTY_PLACEHOLDER) {
      if (this.renderPlaceholderCell(cell, x, y)) return;
    }

    // Skip rendering if invisible
    if (cell.flags & CellFlags.INVISIBLE) {
      return;
    }

    // Check if this cell is selected
    const isSelected = this.isInSelection(x, y);

    // Set text style
    let fontStyle = '';
    if (cell.flags & CellFlags.ITALIC) fontStyle += 'italic ';
    if (cell.flags & CellFlags.BOLD) fontStyle += 'bold ';
    this.ctx.font = `${fontStyle}${this.fontSize}px ${this.fontFamily}`;

    // Set text color - use override, selection foreground, or normal color
    if (colorOverride) {
      this.ctx.fillStyle = colorOverride;
    } else if (isSelected) {
      this.ctx.fillStyle = this.theme.selectionForeground;
    } else {
      // Extract colors and handle inverse. Mirrors the background path
      // above: cells with no explicit color come back as (0,0,0) — treat
      // that as a sentinel for "use theme default" rather than rendering
      // literal black. Without this, default-fg text on a dark theme is
      // invisible.
      let fg_r = cell.fg_r,
        fg_g = cell.fg_g,
        fg_b = cell.fg_b;

      if (cell.flags & CellFlags.INVERSE) {
        // When inverted, foreground becomes background.
        fg_r = cell.bg_r;
        fg_g = cell.bg_g;
        fg_b = cell.bg_b;
      }

      // Same reasoning as the bg path: only fall back to theme.foreground
      // when the cell has the default fg (tag NONE), not when its explicit
      // RGB happens to be (0,0,0).
      const useThemeFg = cell.flags & CellFlags.INVERSE ? cell.bgIsDefault : cell.fgIsDefault;
      this.ctx.fillStyle = useThemeFg ? this.theme.foreground : this.rgbToCSS(fg_r, fg_g, fg_b);
    }

    // Apply faint effect
    if (cell.flags & CellFlags.FAINT) {
      this.ctx.globalAlpha = 0.5;
    }

    // Draw text
    const textX = cellX;
    const textY = cellY + this.metrics.baseline;

    // Get the character to render. cell.grapheme (extras) is populated
    // by GhosttyTerminal.getViewport during its per-cell walk, so we
    // build the cluster locally — going through getGraphemeString would
    // cost an O(row) WASM crossing per multi-codepoint cell.
    const extras = cell.grapheme;
    const char =
      extras && extras.length > 0
        ? String.fromCodePoint(cell.codepoint || 32, ...extras)
        : String.fromCodePoint(cell.codepoint || 32);

    // Block elements (U+2580..U+259F) draw as fillRect using the same
    // fillStyle. The browser's font rasterization of these glyphs leaves
    // sub-pixel gaps that line up into a visible cell grid in half-block
    // image renderings (ansimage, pixterm) at dpr=1; native terminals
    // (Ghostty, kitty, alacritty) draw them programmatically for the same
    // reason. Only takes the fast path for simple (non-grapheme) cells.
    if (
      cell.grapheme_len === 0 &&
      this.renderBlockElement(cell.codepoint, cellX, cellY, cellWidth)
    ) {
      // handled by renderBlockElement
    } else {
      this.ctx.fillText(char, textX, textY);
    }

    // Reset alpha
    if (cell.flags & CellFlags.FAINT) {
      this.ctx.globalAlpha = 1.0;
    }

    // Draw underline
    if (cell.flags & CellFlags.UNDERLINE) {
      const underlineY = cellY + this.metrics.baseline + 2;
      this.ctx.strokeStyle = this.ctx.fillStyle;
      this.ctx.lineWidth = 1;
      this.ctx.beginPath();
      this.ctx.moveTo(cellX, underlineY);
      this.ctx.lineTo(cellX + cellWidth, underlineY);
      this.ctx.stroke();
    }

    // Draw strikethrough
    if (cell.flags & CellFlags.STRIKETHROUGH) {
      const strikeY = cellY + this.metrics.height / 2;
      this.ctx.strokeStyle = this.ctx.fillStyle;
      this.ctx.lineWidth = 1;
      this.ctx.beginPath();
      this.ctx.moveTo(cellX, strikeY);
      this.ctx.lineTo(cellX + cellWidth, strikeY);
      this.ctx.stroke();
    }

    // Draw hyperlink underline (for OSC8 hyperlinks)
    if (cell.hyperlink_id > 0) {
      const isHovered = cell.hyperlink_id === this.hoveredHyperlinkId;

      // Only show underline when hovered (cleaner look)
      if (isHovered) {
        const underlineY = cellY + this.metrics.baseline + 2;
        this.ctx.strokeStyle = '#4A90E2'; // Blue underline on hover
        this.ctx.lineWidth = 1;
        this.ctx.beginPath();
        this.ctx.moveTo(cellX, underlineY);
        this.ctx.lineTo(cellX + cellWidth, underlineY);
        this.ctx.stroke();
      }
    }

    // Draw regex link underline (for plain text URLs)
    if (this.hoveredLinkRange) {
      const range = this.hoveredLinkRange;
      // Check if this cell is within the hovered link range
      const isInRange =
        (y === range.startY && x >= range.startX && (y < range.endY || x <= range.endX)) ||
        (y > range.startY && y < range.endY) ||
        (y === range.endY && x <= range.endX && (y > range.startY || x >= range.startX));

      if (isInRange) {
        const underlineY = cellY + this.metrics.baseline + 2;
        this.ctx.strokeStyle = '#4A90E2'; // Blue underline on hover
        this.ctx.lineWidth = 1;
        this.ctx.beginPath();
        this.ctx.moveTo(cellX, underlineY);
        this.ctx.lineTo(cellX + cellWidth, underlineY);
        this.ctx.stroke();
      }
    }
  }

  /**
   * Composite all visible kitty graphics placements onto the canvas.
   * Cheap when no graphics are active (one method check, one terminal_get).
   * Decode work is amortized across frames via kittyImageCache.
   */
  /**
   * Walk the placement iterator once at frame start, partitioning the
   * results: virtual placements go into kittyVirtualPlacements (keyed
   * by image id) for placeholder-cell lookup; direct visible placements
   * stay implicit and get re-iterated by renderKittyImages later.
   *
   * Also caches the storage handle for renderPlaceholderCell so the
   * per-cell hot path doesn't have to re-resolve it.
   */
  private precomputeKittyState(buffer: IRenderable, dimsRows: number): void {
    this.kittyVirtualPlacements.clear();
    this.currentDirectPlacements = [];
    this.kittyDamagedRows.clear();
    this.currentKittyGraphics = null;

    const newSigs: typeof this.lastKittyDirectSigs = new Map();
    const cellH = this.metrics.height;
    const markRows = (viewportRow: number, pixelHeight: number): void => {
      const rowStart = Math.max(0, Math.floor(viewportRow));
      const rowEnd = Math.min(dimsRows, Math.ceil(viewportRow + pixelHeight / cellH));
      for (let r = rowStart; r < rowEnd; r++) this.kittyDamagedRows.add(r);
    };

    const newVirtualSigs: typeof this.lastKittyVirtualSigs = new Map();
    let virtualBytesChanged = false;
    const markAllRows = (): void => {
      for (let r = 0; r < dimsRows; r++) this.kittyDamagedRows.add(r);
    };

    if (buffer.getKittyGraphics && buffer.iterPlacements) {
      const graphics = buffer.getKittyGraphics();
      if (graphics !== null) {
        this.currentKittyGraphics = graphics;
        // onlyVisible=false so virtual placements come through too. We
        // partition: virtuals into kittyVirtualPlacements (placeholder-cell
        // lookup), directs into currentDirectPlacements (composite pass).
        for (const p of buffer.iterPlacements(graphics, false)) {
          if (p.isVirtual) {
            this.kittyVirtualPlacements.set(p.imageId, p);
            // Sign the image bytes so we can spot bytes-change between
            // frames. Cheap: getKittyImagePixels returns a borrowed view,
            // we copy 5 numbers out. See lastKittyVirtualSigs for the full
            // rationale (Canvas2D-only damage gap, doesn't affect GPU
            // renderers).
            if (!virtualBytesChanged) {
              const pixels = buffer.getKittyImagePixels?.(graphics, p.imageId);
              const sig = {
                imgWidth: pixels?.width ?? 0,
                imgHeight: pixels?.height ?? 0,
                imgFormat: pixels?.format ?? (0 as KittyImageFormat),
                dataPtr: pixels?.data.byteOffset ?? 0,
                dataLen: pixels?.data.length ?? 0,
              };
              newVirtualSigs.set(p.imageId, sig);
              const prev = this.lastKittyVirtualSigs.get(p.imageId);
              if (
                !prev ||
                prev.imgWidth !== sig.imgWidth ||
                prev.imgHeight !== sig.imgHeight ||
                prev.imgFormat !== sig.imgFormat ||
                prev.dataPtr !== sig.dataPtr ||
                prev.dataLen !== sig.dataLen
              ) {
                virtualBytesChanged = true;
              }
            } else {
              // Already going to invalidate everything; still record sig so
              // future frames have something to compare against.
              const pixels = buffer.getKittyImagePixels?.(graphics, p.imageId);
              newVirtualSigs.set(p.imageId, {
                imgWidth: pixels?.width ?? 0,
                imgHeight: pixels?.height ?? 0,
                imgFormat: pixels?.format ?? (0 as KittyImageFormat),
                dataPtr: pixels?.data.byteOffset ?? 0,
                dataLen: pixels?.data.length ?? 0,
              });
            }
            continue;
          }
          this.currentDirectPlacements.push(p);
          const pixels = buffer.getKittyImagePixels?.(graphics, p.imageId);
          const sig = {
            viewportCol: p.viewportCol,
            viewportRow: p.viewportRow,
            pixelWidth: p.pixelWidth,
            pixelHeight: p.pixelHeight,
            sourceX: p.sourceX,
            sourceY: p.sourceY,
            sourceWidth: p.sourceWidth,
            sourceHeight: p.sourceHeight,
            imgWidth: pixels?.width ?? 0,
            imgHeight: pixels?.height ?? 0,
            imgFormat: pixels?.format ?? (0 as KittyImageFormat),
            dataPtr: pixels?.data.byteOffset ?? 0,
            dataLen: pixels?.data.length ?? 0,
          };
          newSigs.set(p.imageId, sig);
          const prev = this.lastKittyDirectSigs.get(p.imageId);
          const changed =
            !prev ||
            prev.viewportCol !== sig.viewportCol ||
            prev.viewportRow !== sig.viewportRow ||
            prev.pixelWidth !== sig.pixelWidth ||
            prev.pixelHeight !== sig.pixelHeight ||
            prev.sourceX !== sig.sourceX ||
            prev.sourceY !== sig.sourceY ||
            prev.sourceWidth !== sig.sourceWidth ||
            prev.sourceHeight !== sig.sourceHeight ||
            prev.imgWidth !== sig.imgWidth ||
            prev.imgHeight !== sig.imgHeight ||
            prev.imgFormat !== sig.imgFormat ||
            prev.dataPtr !== sig.dataPtr ||
            prev.dataLen !== sig.dataLen;
          if (changed) {
            markRows(sig.viewportRow, sig.pixelHeight);
            if (prev) markRows(prev.viewportRow, prev.pixelHeight);
          }
        }
      }
    }

    // Removed placements (were drawn last frame, gone now): mark their
    // rows so text repaint clears stale image pixels.
    for (const [id, prev] of this.lastKittyDirectSigs) {
      if (!newSigs.has(id)) markRows(prev.viewportRow, prev.pixelHeight);
    }
    this.lastKittyDirectSigs = newSigs;

    // Virtual-placement bookkeeping. Bytes-change OR removed-virtual flips
    // virtualBytesChanged; we then mark every row in the viewport damaged.
    // Coarse but correct: there's no cheap "rows referencing image_id X"
    // query at this point (the cell pool isn't populated until renderLine),
    // and in placeholder-heavy workloads (heatmaps, inline previews) most
    // rows already contain placeholder cells anyway.
    if (!virtualBytesChanged) {
      for (const id of this.lastKittyVirtualSigs.keys()) {
        if (!newVirtualSigs.has(id)) {
          virtualBytesChanged = true;
          break;
        }
      }
    }
    if (virtualBytesChanged) markAllRows();
    this.lastKittyVirtualSigs = newVirtualSigs;
  }

  /**
   * Get (or decode + cache) the canvas-ready bitmap for a kitty image.
   * Returns null if the image isn't stored or decode fails. Shared by
   * renderKittyImages (direct placements) and renderPlaceholderCell
   * (unicode-placeholder cells).
   */
  private getOrDecodeKittyImage(
    buffer: IRenderable,
    graphics: number,
    imageId: number
  ): HTMLCanvasElement | null {
    const cached = this.kittyImageCache.get(imageId);
    const pixels = buffer.getKittyImagePixels?.(graphics, imageId);
    if (!pixels) return cached?.canvas ?? null;
    if (cached && cachedMatchesPixels(cached, pixels)) return cached.canvas;
    const canvas = this.decodeKittyImageToCanvas(pixels);
    if (!canvas) return null;
    this.kittyImageCache.set(imageId, {
      canvas,
      width: pixels.width,
      height: pixels.height,
      format: pixels.format,
      dataPtr: pixels.data.byteOffset,
      dataLen: pixels.data.length,
    });
    return canvas;
  }

  /**
   * Render a Block Elements codepoint (U+2580..U+259F) as fillRect(s) in
   * the current fillStyle. Returns true if the codepoint is a handled
   * block element; false to fall through to fillText.
   *
   * Drawing block elements through the font produces ~1-device-px gaps
   * at cell edges at integer dpr because the rasterized glyph doesn't
   * exactly fill the cell box. In half-block image renderings (ansimage,
   * pixterm) those gaps line up into a visible cell grid. Native
   * terminals draw block elements programmatically for the same reason.
   *
   * The eighths blocks (U+2581..U+2587 lower; U+2589..U+258F left) and
   * full block (U+2588) are stripes of n/8 of the cell. Shading blocks
   * (U+2591..U+2593) modulate globalAlpha for 25/50/75% fill. Quadrant
   * blocks (U+2596..U+259F) split the cell into a 2x2 grid and fill
   * some subset.
   */
  private renderBlockElement(
    codepoint: number,
    cellX: number,
    cellY: number,
    cellWidth: number
  ): boolean {
    if (codepoint < 0x2580 || codepoint > 0x259f) return false;

    const w = cellWidth;
    const h = this.metrics.height;

    // Upper half ▀
    if (codepoint === 0x2580) {
      this.ctx.fillRect(cellX, cellY, w, Math.round(h / 2));
      return true;
    }

    // Lower n/8 blocks ▁▂▃▄▅▆▇ + full block █ (= 8/8)
    if (codepoint >= 0x2581 && codepoint <= 0x2588) {
      const eighths = codepoint - 0x2580;
      const blockH = Math.round((h * eighths) / 8);
      this.ctx.fillRect(cellX, cellY + h - blockH, w, blockH);
      return true;
    }

    // Left n/8 blocks ▉▊▋▌▍▎▏ — eighths decreases as codepoint increases
    if (codepoint >= 0x2589 && codepoint <= 0x258f) {
      const eighths = 0x2590 - codepoint;
      const blockW = Math.round((w * eighths) / 8);
      this.ctx.fillRect(cellX, cellY, blockW, h);
      return true;
    }

    // Right half ▐
    if (codepoint === 0x2590) {
      const left = Math.round(w / 2);
      this.ctx.fillRect(cellX + left, cellY, w - left, h);
      return true;
    }

    // Shading ░▒▓ — modulate globalAlpha against current fillStyle
    if (codepoint >= 0x2591 && codepoint <= 0x2593) {
      const alphaForShade = [0.25, 0.5, 0.75][codepoint - 0x2591];
      const prev = this.ctx.globalAlpha;
      this.ctx.globalAlpha = prev * alphaForShade;
      this.ctx.fillRect(cellX, cellY, w, h);
      this.ctx.globalAlpha = prev;
      return true;
    }

    // Upper 1/8 ▔
    if (codepoint === 0x2594) {
      this.ctx.fillRect(cellX, cellY, w, Math.round(h / 8));
      return true;
    }

    // Right 1/8 ▕
    if (codepoint === 0x2595) {
      const left = Math.round((w * 7) / 8);
      this.ctx.fillRect(cellX + left, cellY, w - left, h);
      return true;
    }

    // Quadrants ▖▗▘▙▚▛▜▝▞▟ at U+2596..U+259F. Bitmap of which corners
    // (UL, UR, LL, LR) are filled per codepoint.
    const QUAD_UL = 0b1000;
    const QUAD_UR = 0b0100;
    const QUAD_LL = 0b0010;
    const QUAD_LR = 0b0001;
    // Hex literals are intentional: these are Unicode codepoints for box-drawing
    // quadrant characters U+2596..U+259F. Decimal would be unreadable.
    const quadMap: Record<number, number> = {
      // biome-ignore lint/complexity/useSimpleNumberKeys: unicode codepoints
      0x2596: QUAD_LL,
      // biome-ignore lint/complexity/useSimpleNumberKeys: unicode codepoints
      0x2597: QUAD_LR,
      // biome-ignore lint/complexity/useSimpleNumberKeys: unicode codepoints
      0x2598: QUAD_UL,
      // biome-ignore lint/complexity/useSimpleNumberKeys: unicode codepoints
      0x2599: QUAD_UL | QUAD_LL | QUAD_LR,
      // biome-ignore lint/complexity/useSimpleNumberKeys: unicode codepoints
      0x259a: QUAD_UL | QUAD_LR,
      // biome-ignore lint/complexity/useSimpleNumberKeys: unicode codepoints
      0x259b: QUAD_UL | QUAD_UR | QUAD_LL,
      // biome-ignore lint/complexity/useSimpleNumberKeys: unicode codepoints
      0x259c: QUAD_UL | QUAD_UR | QUAD_LR,
      // biome-ignore lint/complexity/useSimpleNumberKeys: unicode codepoints
      0x259d: QUAD_UR,
      // biome-ignore lint/complexity/useSimpleNumberKeys: unicode codepoints
      0x259e: QUAD_UR | QUAD_LL,
      // biome-ignore lint/complexity/useSimpleNumberKeys: unicode codepoints
      0x259f: QUAD_UR | QUAD_LL | QUAD_LR,
    };
    const quads = quadMap[codepoint];
    if (quads === undefined) return false;
    const halfW = Math.round(w / 2);
    const halfH = Math.round(h / 2);
    if (quads & QUAD_UL) this.ctx.fillRect(cellX, cellY, halfW, halfH);
    if (quads & QUAD_UR) this.ctx.fillRect(cellX + halfW, cellY, w - halfW, halfH);
    if (quads & QUAD_LL) this.ctx.fillRect(cellX, cellY + halfH, halfW, h - halfH);
    if (quads & QUAD_LR) this.ctx.fillRect(cellX + halfW, cellY + halfH, w - halfW, h - halfH);
    return true;
  }

  /**
   * Substitute a cell's text rendering with a slice of a kitty graphics
   * image. Called from renderCellText when the cell's codepoint is
   * U+10EEEE.
   *
   * Decodes the image_id from cell.fg_*  (low 24 bits; high byte from
   * an optional third combining diacritic) and the row/col-of-image
   * from the first two combining diacritics on the cell. Looks up the
   * virtual placement (from precomputeKittyState) for grid dims, then
   * draws the matching slice scaled to one terminal cell.
   *
   * Returns true if the cell was handled as a placeholder; false to
   * fall through to normal text rendering (e.g., unknown image, no
   * matching virtual placement, or malformed diacritics).
   */
  private renderPlaceholderCell(cell: GhosttyCell, x: number, y: number): boolean {
    const buffer = this.currentRenderBuffer;
    const graphics = this.currentKittyGraphics;
    if (!buffer || graphics === null) return false;

    // Image id from fg color (low 24 bits) + optional 3rd diacritic
    // (high byte). The base codepoint U+10EEEE is in `cell.codepoint`;
    // `cell.grapheme` carries the *extras* — [0]=row, [1]=col,
    // [2]=image_id_msb (optional). Populated by GhosttyTerminal.getViewport
    // so we don't pay a per-cell WASM crossing here.
    const extras = cell.grapheme;
    if (!extras || extras.length < 2) return false;
    const rowD = diacriticToInt(extras[0]!);
    const colD = diacriticToInt(extras[1]!);
    if (rowD < 0 || colD < 0) return false;
    void x;
    void y;
    const fgRgb = (cell.fg_r << 16) | (cell.fg_g << 8) | cell.fg_b;
    let imageId = fgRgb;
    if (extras.length >= 3) {
      const msb = diacriticToInt(extras[2]!);
      if (msb >= 0) imageId = (msb << 24) | fgRgb;
    }

    const placement = this.kittyVirtualPlacements.get(imageId);
    if (!placement) return false;

    const pixels = buffer.getKittyImagePixels?.(graphics, imageId);
    if (!pixels) return false;
    const canvas = this.getOrDecodeKittyImage(buffer, graphics, imageId);
    if (!canvas) return false;

    // Slice geometry: image is conceptually scaled to fit
    // gridCols × gridRows cells; this cell shows one of those cells.
    const srcW = pixels.width / placement.gridCols;
    const srcH = pixels.height / placement.gridRows;
    const srcX = colD * srcW;
    const srcY = rowD * srcH;
    const destX = x * this.metrics.width;
    const destY = y * this.metrics.height;

    // Source-rect coords are fractional whenever pixels.{width,height} doesn't
    // divide evenly by placement.{gridCols,gridRows}. With smoothing on, each
    // slice is sampled with bilinear interpolation clamped to its own source
    // rect, producing visible seams between adjacent cells (the classic
    // tile-edge artifact). Disable smoothing for the slice draw.
    const prevSmoothing = this.ctx.imageSmoothingEnabled;
    this.ctx.imageSmoothingEnabled = false;
    this.ctx.drawImage(
      canvas,
      srcX,
      srcY,
      srcW,
      srcH,
      destX,
      destY,
      this.metrics.width,
      this.metrics.height
    );
    this.ctx.imageSmoothingEnabled = prevSmoothing;
    return true;
  }

  private renderKittyImages(): void {
    const buffer = this.currentRenderBuffer;
    const graphics = this.currentKittyGraphics;
    if (!buffer || graphics === null || !buffer.getKittyImagePixels) return;

    for (const p of this.currentDirectPlacements) {
      let cached = this.kittyImageCache.get(p.imageId);
      const pixels = buffer.getKittyImagePixels(graphics, p.imageId);
      if (!pixels) continue;

      // Cache miss or stale (image was re-transmitted under the same id).
      // See kittyImageCache docstring for staleness-key rationale.
      if (!cached || !cachedMatchesPixels(cached, pixels)) {
        const canvas = this.decodeKittyImageToCanvas(pixels);
        if (!canvas) continue;
        cached = {
          canvas,
          width: pixels.width,
          height: pixels.height,
          format: pixels.format,
          dataPtr: pixels.data.byteOffset,
          dataLen: pixels.data.length,
        };
        this.kittyImageCache.set(p.imageId, cached);
      }

      // Composite. Source/dest rects come straight from the C ABI's
      // PlacementRenderInfo; viewport_col/row may be negative when a
      // placement has scrolled partway off the top — drawImage handles
      // that correctly (clips to the canvas).
      this.ctx.drawImage(
        cached.canvas,
        p.sourceX,
        p.sourceY,
        p.sourceWidth,
        p.sourceHeight,
        p.viewportCol * this.metrics.width,
        p.viewportRow * this.metrics.height,
        p.pixelWidth,
        p.pixelHeight
      );
    }
  }

  /**
   * Decode a kitty graphics image into a canvas suitable for drawImage.
   * Expands non-RGBA formats into RGBA via putImageData; PNG payloads
   * (which require a JS-side decoder set up via ghostty_sys_set) are
   * not supported in this MVP and return null.
   */
  private decodeKittyImageToCanvas(pixels: KittyImagePixels): HTMLCanvasElement | null {
    const { width, height, format, data } = pixels;
    if (width === 0 || height === 0) return null;

    // Allocate a fresh ArrayBuffer (not a WASM-memory view) so that
    //   (a) the bytes survive the next vt_write that might detach the
    //       WASM memory buffer, and
    //   (b) ImageData accepts the buffer (it rejects ArrayBufferLike
    //       which would include SharedArrayBuffer).
    const rgba = new Uint8ClampedArray(new ArrayBuffer(width * height * 4));
    switch (format) {
      case KittyImageFormat.RGBA:
        rgba.set(data);
        break;
      case KittyImageFormat.RGB:
        for (let i = 0, o = 0; i < data.length; i += 3, o += 4) {
          rgba[o] = data[i]!;
          rgba[o + 1] = data[i + 1]!;
          rgba[o + 2] = data[i + 2]!;
          rgba[o + 3] = 255;
        }
        break;
      case KittyImageFormat.GRAY:
        for (let i = 0, o = 0; i < data.length; i++, o += 4) {
          const v = data[i]!;
          rgba[o] = v;
          rgba[o + 1] = v;
          rgba[o + 2] = v;
          rgba[o + 3] = 255;
        }
        break;
      case KittyImageFormat.GRAY_ALPHA:
        for (let i = 0, o = 0; i < data.length; i += 2, o += 4) {
          const v = data[i]!;
          rgba[o] = v;
          rgba[o + 1] = v;
          rgba[o + 2] = v;
          rgba[o + 3] = data[i + 1]!;
        }
        break;
      default:
        // PNG and unknown formats — skip silently. The terminal would have
        // dropped a PNG payload at parse time anyway unless a decoder was
        // installed via ghostty_sys_set(DECODE_PNG, fn).
        return null;
    }

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.putImageData(new ImageData(rgba, width, height), 0, 0);
    return canvas;
  }

  /**
   * Render cursor
   */
  private renderCursor(x: number, y: number): void {
    const cursorX = x * this.metrics.width;
    const cursorY = y * this.metrics.height;

    this.ctx.fillStyle = this.theme.cursor;

    switch (this.cursorStyle) {
      case 'block':
        // Full cell block
        this.ctx.fillRect(cursorX, cursorY, this.metrics.width, this.metrics.height);
        // Re-draw character under cursor with cursorAccent color
        {
          const line = this.currentBuffer?.getLine(y);
          if (line?.[x]) {
            this.ctx.save();
            this.ctx.beginPath();
            this.ctx.rect(cursorX, cursorY, this.metrics.width, this.metrics.height);
            this.ctx.clip();
            this.renderCellText(line[x], x, y, this.theme.cursorAccent);
            this.ctx.restore();
          }
        }
        break;

      case 'underline':
        // Underline at bottom of cell
        const underlineHeight = Math.max(2, Math.floor(this.metrics.height * 0.15));
        this.ctx.fillRect(
          cursorX,
          cursorY + this.metrics.height - underlineHeight,
          this.metrics.width,
          underlineHeight
        );
        break;

      case 'bar':
        // Vertical bar at left of cell
        const barWidth = Math.max(2, Math.floor(this.metrics.width * 0.15));
        this.ctx.fillRect(cursorX, cursorY, barWidth, this.metrics.height);
        break;
    }
  }

  // ==========================================================================
  // Cursor Blinking
  // ==========================================================================

  /**
   * Set a callback the renderer invokes when its internal state changes
   * outside the normal render-driven path (today: cursor-blink toggles).
   * Lets an event-driven Terminal wake its render scheduler instead of
   * polling every frame to catch the blink flip.
   */
  public setOnRequestRender(fn: (() => void) | null): void {
    this.onRequestRender = fn;
    this.cursorBlink_.setOnRequestRender(fn);
  }

  // ==========================================================================
  // Public API
  // ==========================================================================

  /**
   * Update theme colors
   */
  public setTheme(theme: ITheme): void {
    this.theme = { ...DEFAULT_THEME, ...theme };

    // Rebuild palette
    this.palette = [
      this.theme.black,
      this.theme.red,
      this.theme.green,
      this.theme.yellow,
      this.theme.blue,
      this.theme.magenta,
      this.theme.cyan,
      this.theme.white,
      this.theme.brightBlack,
      this.theme.brightRed,
      this.theme.brightGreen,
      this.theme.brightYellow,
      this.theme.brightBlue,
      this.theme.brightMagenta,
      this.theme.brightCyan,
      this.theme.brightWhite,
    ];
    this.invalidateNext = true;
    this.onRequestRender?.();
  }

  /**
   * Update font size
   */
  public setFontSize(size: number): void {
    this.fontSize = size;
    this.metrics = this.measureFont();
    this.invalidateNext = true;
    this.onRequestRender?.();
  }

  /**
   * Update font family
   */
  public setFontFamily(family: string): void {
    this.fontFamily = family;
    this.metrics = this.measureFont();
    this.invalidateNext = true;
    this.onRequestRender?.();
  }

  /**
   * Update cursor style
   */
  public setCursorStyle(style: 'block' | 'underline' | 'bar'): void {
    this.cursorStyle = style;
    this.invalidateNext = true;
    this.onRequestRender?.();
  }

  /**
   * Enable/disable cursor blinking
   */
  public setCursorBlink(enabled: boolean): void {
    this.cursorBlink = enabled;
    this.cursorBlink_.setEnabled(enabled);
  }

  /**
   * Get current font metrics
   */

  public getMetrics(): FontMetrics {
    return { ...this.metrics };
  }

  public get canvas(): HTMLCanvasElement {
    return this.canvasEl;
  }

  /**
   * Set selection manager (for rendering selection)
   */
  public setSelectionManager(manager: SelectionManager): void {
    this.selectionManager = manager;
    this.invalidateNext = true;
  }

  setBidiMapper(mapper: RowBidiMapper): void {
    this.bidiMapper = mapper;
    this.invalidateNext = true; // repaint with reordering active
  }

  /**
   * Check if a cell at (x, y) is within the current selection.
   * Uses cached selection coordinates for performance.
   */
  private isInSelection(x: number, y: number): boolean {
    const sel = this.currentSelectionCoords;
    if (!sel) return false;

    const { startCol, startRow, endCol, endRow } = sel;

    // Single line selection
    if (startRow === endRow) {
      return y === startRow && x >= startCol && x <= endCol;
    }

    // Multi-line selection
    if (y === startRow) {
      // First line: from startCol to end of line
      return x >= startCol;
    } else if (y === endRow) {
      // Last line: from start of line to endCol
      return x <= endCol;
    } else if (y > startRow && y < endRow) {
      // Middle lines: entire line is selected
      return true;
    }

    return false;
  }

  /**
   * Set the currently hovered hyperlink ID for rendering underlines
   */
  public setHoveredHyperlinkId(hyperlinkId: number): void {
    if (this.hoveredHyperlinkId === hyperlinkId) return;
    this.hoveredHyperlinkId = hyperlinkId;
    this.invalidateNext = true;
    this.onRequestRender?.();
  }

  /**
   * Set the currently hovered link range for rendering underlines (for regex-detected URLs)
   * Pass null to clear the hover state
   */
  public setHoveredLinkRange(
    range: {
      startX: number;
      startY: number;
      endX: number;
      endY: number;
    } | null
  ): void {
    // Coarse change check — link-detection is rate-limited upstream and
    // these setters are only called on hover transitions, so identity
    // comparison is enough to dedupe back-to-back clears.
    if (this.hoveredLinkRange === range) return;
    this.hoveredLinkRange = range;
    this.invalidateNext = true;
    this.onRequestRender?.();
  }

  /**
   * Get character cell width (for coordinate conversion)
   */
  public get charWidth(): number {
    return this.metrics.width;
  }

  /**
   * Get character cell height (for coordinate conversion)
   */
  public get charHeight(): number {
    return this.metrics.height;
  }

  /**
   * Clear entire canvas
   */
  public clear(): void {
    // clearRect first because fillRect composites rather than replaces,
    // so transparent/translucent backgrounds wouldn't clear previous content.
    this.ctx.clearRect(0, 0, this.canvasEl.width, this.canvasEl.height);
    this.ctx.fillStyle = this.theme.background;
    this.ctx.fillRect(0, 0, this.canvasEl.width, this.canvasEl.height);
  }

  /**
   * Cleanup resources
   */
  public destroy(): void {
    this.cursorBlink_.destroy();
  }

  /** @deprecated Use destroy() */
  public dispose(): void {
    this.destroy();
  }
}
