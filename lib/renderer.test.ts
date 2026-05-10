/**
 * Tests for Canvas Renderer
 *
 * Note: Most renderer tests are visual and require a browser environment.
 * These tests verify non-visual aspects like theme configuration.
 * Full visual tests are in examples/renderer-demo.html
 */

import { describe, expect, test } from 'bun:test';
import { CanvasRenderer, DEFAULT_THEME } from './renderer';
import type { IRenderable } from './renderer-types';
import type { GhosttyCell, KittyImagePixels, KittyPlacementInfo } from './types';
import { KittyImageFormat } from './types';

describe('CanvasRenderer', () => {
  describe('Default Theme', () => {
    test('has all required ANSI colors', () => {
      expect(DEFAULT_THEME.black).toBe('#000000');
      expect(DEFAULT_THEME.red).toBe('#cd3131');
      expect(DEFAULT_THEME.green).toBe('#0dbc79');
      expect(DEFAULT_THEME.yellow).toBe('#e5e510');
      expect(DEFAULT_THEME.blue).toBe('#2472c8');
      expect(DEFAULT_THEME.magenta).toBe('#bc3fbc');
      expect(DEFAULT_THEME.cyan).toBe('#11a8cd');
      expect(DEFAULT_THEME.white).toBe('#e5e5e5');
    });

    test('has all bright ANSI colors', () => {
      expect(DEFAULT_THEME.brightBlack).toBe('#666666');
      expect(DEFAULT_THEME.brightRed).toBe('#f14c4c');
      expect(DEFAULT_THEME.brightGreen).toBe('#23d18b');
      expect(DEFAULT_THEME.brightYellow).toBe('#f5f543');
      expect(DEFAULT_THEME.brightBlue).toBe('#3b8eea');
      expect(DEFAULT_THEME.brightMagenta).toBe('#d670d6');
      expect(DEFAULT_THEME.brightCyan).toBe('#29b8db');
      expect(DEFAULT_THEME.brightWhite).toBe('#ffffff');
    });

    test('has foreground and background colors', () => {
      expect(DEFAULT_THEME.foreground).toBe('#d4d4d4');
      expect(DEFAULT_THEME.background).toBe('#1e1e1e');
    });

    test('has cursor colors', () => {
      expect(DEFAULT_THEME.cursor).toBe('#ffffff');
      expect(DEFAULT_THEME.cursorAccent).toBe('#1e1e1e');
    });

    test('has selection colors', () => {
      // Selection colors are now solid (not semi-transparent overlay)
      // Ghostty-style: selection bg = foreground color, selection fg = background color
      expect(DEFAULT_THEME.selectionBackground).toBe('#d4d4d4');
      expect(DEFAULT_THEME.selectionForeground).toBe('#1e1e1e');
    });
  });

  describe('Theme Color Format', () => {
    test('all colors are valid hex strings', () => {
      const hexPattern = /^#[0-9a-f]{6}$/i;

      expect(DEFAULT_THEME.black).toMatch(hexPattern);
      expect(DEFAULT_THEME.foreground).toMatch(hexPattern);
      expect(DEFAULT_THEME.background).toMatch(hexPattern);
      expect(DEFAULT_THEME.cursor).toMatch(hexPattern);
    });
  });

  describe('virtual-placement damage tracking', () => {
    // Build a stub IRenderable that exposes a single virtual placement
    // whose image bytes the test controls between calls. Cells stay empty
    // (we're testing precomputeKittyState only — render() isn't invoked).
    function makeStub(opts: {
      cols: number;
      rows: number;
      placements: KittyPlacementInfo[];
      pixelsByImageId: Map<number, KittyImagePixels>;
    }): IRenderable {
      const empties: GhosttyCell[] = Array.from({ length: opts.cols * opts.rows }, () => ({
        codepoint: 0,
        fg_r: 0,
        fg_g: 0,
        fg_b: 0,
        bg_r: 0,
        bg_g: 0,
        bg_b: 0,
        fgIsDefault: true,
        bgIsDefault: true,
        flags: 0,
        width: 1,
        hyperlink_id: 0,
        grapheme_len: 0,
        grapheme: null,
      }));
      return {
        getLine: (_y: number) => empties.slice(0, opts.cols),
        getViewport: () => empties,
        getCursor: () => ({ x: 0, y: 0, visible: false }),
        getDimensions: () => ({ cols: opts.cols, rows: opts.rows }),
        isRowDirty: () => false,
        clearDirty: () => {},
        getKittyGraphics: () => 1,
        iterPlacements: () => opts.placements[Symbol.iterator](),
        getKittyImagePixels: (_g: number, id: number) => opts.pixelsByImageId.get(id) ?? null,
      };
    }

    function vp(imageId: number): KittyPlacementInfo {
      return {
        imageId,
        pixelWidth: 100,
        pixelHeight: 100,
        gridCols: 10,
        gridRows: 10,
        viewportCol: 0,
        viewportRow: 0,
        viewportVisible: false,
        sourceX: 0,
        sourceY: 0,
        sourceWidth: 100,
        sourceHeight: 100,
        isVirtual: true,
      };
    }

    test('image-byte change marks every viewport row damaged', () => {
      const canvas = document.createElement('canvas');
      const renderer = new CanvasRenderer(canvas);
      const cols = 4;
      const rows = 12;

      // Mimic the WASM layout: two image-byte slots live in different
      // regions of one shared buffer (so they have distinct byteOffsets
      // even at the same length). On each fresh APC the WASM allocator
      // typically returns a new offset; using subarray() recreates that
      // contract in the test without stubbing wasm memory.
      const sharedBuf = new ArrayBuffer(2 * 100 * 100 * 4);
      const slotA = new Uint8Array(sharedBuf, 0, 100 * 100 * 4);
      const slotB = new Uint8Array(sharedBuf, 100 * 100 * 4, 100 * 100 * 4);
      slotA.fill(1);
      slotB.fill(2);

      // First frame: virtual placement with image bytes A. The very first
      // sighting always invalidates (no prior signature).
      const pixA: KittyImagePixels = {
        width: 100,
        height: 100,
        format: KittyImageFormat.RGBA,
        data: slotA,
      };
      const stubA = makeStub({
        cols,
        rows,
        placements: [vp(42)],
        pixelsByImageId: new Map([[42, pixA]]),
      });
      renderer._testPrecomputeKittyState(stubA, rows);
      expect(renderer._testGetKittyDamagedRows().size).toBe(rows);

      // Second frame, *same* image bytes (same buffer, same dataPtr/dataLen).
      // Nothing should be marked damaged on bytes-stability — the only thing
      // that should drive Canvas2D repaints is normal dirty/cursor/selection.
      renderer._testPrecomputeKittyState(stubA, rows);
      expect(renderer._testGetKittyDamagedRows().size).toBe(0);

      // Third frame: fresh APC payload at a new byteOffset (the ntcharts
      // perlin scenario: the application transmits new bytes for the same
      // image_id). Must invalidate the whole viewport so the per-cell
      // substitution picks up the re-decoded bitmap.
      const pixB: KittyImagePixels = {
        width: 100,
        height: 100,
        format: KittyImageFormat.RGBA,
        data: slotB,
      };
      const stubB = makeStub({
        cols,
        rows,
        placements: [vp(42)],
        pixelsByImageId: new Map([[42, pixB]]),
      });
      renderer._testPrecomputeKittyState(stubB, rows);
      expect(renderer._testGetKittyDamagedRows().size).toBe(rows);

      renderer.destroy();
    });

    test('virtual placement removed since last frame triggers full repaint', () => {
      const canvas = document.createElement('canvas');
      const renderer = new CanvasRenderer(canvas);
      const cols = 4;
      const rows = 8;

      const pix: KittyImagePixels = {
        width: 50,
        height: 50,
        format: KittyImageFormat.RGBA,
        data: new Uint8Array(50 * 50 * 4),
      };
      // Frame 1: register a virtual placement.
      renderer._testPrecomputeKittyState(
        makeStub({
          cols,
          rows,
          placements: [vp(7)],
          pixelsByImageId: new Map([[7, pix]]),
        }),
        rows
      );
      // Frame 2: stable.
      renderer._testPrecomputeKittyState(
        makeStub({
          cols,
          rows,
          placements: [vp(7)],
          pixelsByImageId: new Map([[7, pix]]),
        }),
        rows
      );
      expect(renderer._testGetKittyDamagedRows().size).toBe(0);
      // Frame 3: placement gone — must invalidate to clear stale image pixels.
      renderer._testPrecomputeKittyState(
        makeStub({ cols, rows, placements: [], pixelsByImageId: new Map() }),
        rows
      );
      expect(renderer._testGetKittyDamagedRows().size).toBe(rows);

      renderer.destroy();
    });
  });
});
