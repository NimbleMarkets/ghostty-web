import { describe, expect, test } from 'bun:test';
import { RowBidiMapper } from './bidi';
import { KITTY_PLACEHOLDER, ROWCOLUMN_DIACRITICS } from './kitty_diacritics';
import {
  type AtlasSlot,
  CELL_BYTES,
  CELL_U32S,
  FLAG_IS_CURSOR_CELL,
  FLAG_IS_KITTY_PLACEHOLDER,
  FLAG_IS_LINK_RANGE_HOVERED,
  type GlyphAtlasBase,
  KittyAtlasBase,
  KittyTextureCacheBase,
  encodeCells,
  kittyImageToRGBA,
  visualCursorX,
} from './renderer-core';
import type { IRenderable } from './renderer-types';
import type { GhosttyCell, KittyPlacementInfo } from './types';
import { KittyImageFormat } from './types';

// Build a fresh GhosttyCell with safe defaults. Tests override fields they care about.
function makeCell(overrides: Partial<GhosttyCell> = {}): GhosttyCell {
  return {
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
    ...overrides,
  };
}

type StubRenderableOpts = {
  cols: number;
  rows: number;
  cells: GhosttyCell[];
  placements: KittyPlacementInfo[];
  graphicsHandle?: number;
  cursor?: { x: number; y: number; visible: boolean };
};

// Stub IRenderable that counts getGrapheme calls. Some tests assert this
// counter stays at zero — encodeCells must read cell.grapheme directly.
function makeStubBuffer(opts: StubRenderableOpts): IRenderable & {
  getGraphemeCalls: number;
  getGraphemeStringCalls: number;
} {
  let getGraphemeCalls = 0;
  let getGraphemeStringCalls = 0;
  const buffer: IRenderable & {
    getGraphemeCalls: number;
    getGraphemeStringCalls: number;
  } = {
    get getGraphemeCalls() {
      return getGraphemeCalls;
    },
    get getGraphemeStringCalls() {
      return getGraphemeStringCalls;
    },
    getLine(y: number): GhosttyCell[] | null {
      const start = y * opts.cols;
      return opts.cells.slice(start, start + opts.cols);
    },
    getViewport(): GhosttyCell[] {
      return opts.cells;
    },
    getCursor() {
      return opts.cursor ?? { x: 0, y: 0, visible: false };
    },
    getDimensions() {
      return { cols: opts.cols, rows: opts.rows };
    },
    isRowDirty() {
      return true;
    },
    clearDirty() {},
    getKittyGraphics() {
      return opts.graphicsHandle ?? 1;
    },
    iterPlacements(_g: number, _onlyVisible?: boolean) {
      return opts.placements[Symbol.iterator]();
    },
    getKittyImagePixels() {
      return null;
    },
    getGrapheme(_y: number, _x: number) {
      getGraphemeCalls++;
      return null;
    },
    getGraphemeString(_y: number, _x: number) {
      getGraphemeStringCalls++;
      return ' ';
    },
  };
  return buffer;
}

// Row: a ש ל ו b + empty  → visualToLogical [0,3,2,1,4,5].
// Tag each cell with a distinct fg_r so the test can see which logical
// cell landed at which visual slot.
function hebrewRow(cols: number): GhosttyCell[] {
  const cps = [0x61, 0x5e9, 0x5dc, 0x5d5, 0x62]; // a ש ל ו b
  const cells = cps.map((cp, i) => makeCell({ codepoint: cp, fg_r: i + 1, fgIsDefault: false }));
  while (cells.length < cols) cells.push(makeCell());
  return cells;
}

describe('kittyImageToRGBA', () => {
  test('RGBA passes through unchanged', () => {
    const data = new Uint8Array([10, 20, 30, 40, 50, 60, 70, 80]);
    const out = kittyImageToRGBA({ width: 2, height: 1, format: KittyImageFormat.RGBA, data });
    expect(out).not.toBeNull();
    expect(Array.from(out!)).toEqual([10, 20, 30, 40, 50, 60, 70, 80]);
  });

  test('RGB inserts alpha=255 per pixel', () => {
    const data = new Uint8Array([10, 20, 30, 40, 50, 60]);
    const out = kittyImageToRGBA({ width: 2, height: 1, format: KittyImageFormat.RGB, data });
    expect(out).not.toBeNull();
    expect(Array.from(out!)).toEqual([10, 20, 30, 255, 40, 50, 60, 255]);
  });

  test('GRAY broadcasts to RGB and inserts alpha=255', () => {
    const data = new Uint8Array([100, 200]);
    const out = kittyImageToRGBA({ width: 2, height: 1, format: KittyImageFormat.GRAY, data });
    expect(out).not.toBeNull();
    expect(Array.from(out!)).toEqual([100, 100, 100, 255, 200, 200, 200, 255]);
  });

  test('GRAY_ALPHA broadcasts gray and uses provided alpha', () => {
    const data = new Uint8Array([100, 50, 200, 150]);
    const out = kittyImageToRGBA({
      width: 2,
      height: 1,
      format: KittyImageFormat.GRAY_ALPHA,
      data,
    });
    expect(out).not.toBeNull();
    expect(Array.from(out!)).toEqual([100, 100, 100, 50, 200, 200, 200, 150]);
  });

  test('PNG (undecoded) returns null', () => {
    const out = kittyImageToRGBA({
      width: 2,
      height: 1,
      format: KittyImageFormat.PNG,
      data: new Uint8Array([1, 2, 3]),
    });
    expect(out).toBeNull();
  });

  test('zero-dimension image returns null', () => {
    const out = kittyImageToRGBA({
      width: 0,
      height: 1,
      format: KittyImageFormat.RGBA,
      data: new Uint8Array(0),
    });
    expect(out).toBeNull();
  });
});

describe('encodeCells: kitty placeholder grapheme cache', () => {
  test('reads grapheme from cell.grapheme without calling buffer.getGrapheme', () => {
    const cols = 4;
    const rows = 3;
    // Place a kitty placeholder at row 2, col 1 — the row that previously
    // forced getGrapheme to walk the row iterator from 0 to 2.
    const cells: GhosttyCell[] = [];
    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < cols; x++) {
        if (y === 2 && x === 1) {
          // image_id 0xAA, row diacritic index 5, col diacritic index 7.
          cells.push(
            makeCell({
              codepoint: KITTY_PLACEHOLDER,
              grapheme_len: 2,
              grapheme: [ROWCOLUMN_DIACRITICS[5]!, ROWCOLUMN_DIACRITICS[7]!],
              fg_r: 0,
              fg_g: 0,
              fg_b: 0xaa,
              fgIsDefault: false,
            })
          );
        } else {
          cells.push(makeCell());
        }
      }
    }

    const placement: KittyPlacementInfo = {
      imageId: 0xaa,
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
    const buffer = makeStubBuffer({ cols, rows, cells, placements: [placement] });
    const cellArray = new Uint32Array(cols * rows * CELL_U32S);
    const ctx = {
      metrics: { width: 8, height: 16, baseline: 12 },
      selectionManager: undefined,
      hoveredHyperlinkId: 0,
      hoveredLinkRange: null,
      cursorStyle: 'block' as const,
      cursorBlinkVisible: false,
      atlas: undefined,
      kittyEnabled: true,
      blockElementShaderEnabled: false,
      maxKittyImages: 256,
    };

    const result = encodeCells(cellArray, buffer, 0, undefined, ctx);

    // Grapheme came from cell.grapheme, not from a WASM crossing.
    expect(buffer.getGraphemeCalls).toBe(0);
    // Placeholder cell got the placeholder flag set.
    const placeholderIdx = (2 * cols + 1) * CELL_U32S;
    expect(cellArray[placeholderIdx + 4]! & FLAG_IS_KITTY_PLACEHOLDER).toBeTruthy();
    // colD/rowD are packed into u32 at offset +5.
    expect(cellArray[placeholderIdx + 5]).toBe((7 & 0xffff) | ((5 & 0xffff) << 16));
    // imageId 0xAA shows up in usedKittyImageIds (index 0 the first time).
    expect(result.usedKittyImageIds).toEqual([0xaa]);
  });

  test('skips placeholder when cell.grapheme is missing or too short', () => {
    const cols = 2;
    const rows = 1;
    // Placeholder cell with no grapheme array — should NOT be flagged and
    // must still not call getGrapheme (the optimization is unconditional).
    const cells: GhosttyCell[] = [
      makeCell({ codepoint: KITTY_PLACEHOLDER, grapheme_len: 0, grapheme: null }),
      makeCell(),
    ];
    const buffer = makeStubBuffer({ cols, rows, cells, placements: [] });
    const cellArray = new Uint32Array(cols * rows * CELL_U32S);
    const ctx = {
      metrics: { width: 8, height: 16, baseline: 12 },
      selectionManager: undefined,
      hoveredHyperlinkId: 0,
      hoveredLinkRange: null,
      cursorStyle: 'block' as const,
      cursorBlinkVisible: false,
      atlas: undefined,
      kittyEnabled: true,
      blockElementShaderEnabled: false,
    };

    encodeCells(cellArray, buffer, 0, undefined, ctx);

    expect(buffer.getGraphemeCalls).toBe(0);
    expect(cellArray[0 * CELL_U32S + 4]! & FLAG_IS_KITTY_PLACEHOLDER).toBeFalsy();
  });

  test('builds grapheme string from cell.grapheme without calling buffer.getGraphemeString', () => {
    // Non-placeholder multi-codepoint cell — e.g. a ZWJ family emoji
    // sequence. Pre-fix, encodeCells crossed into WASM via
    // buffer.getGraphemeString(y, x) for every such cell, which itself
    // walked the row iterator from row 0 (O(row) per call).
    const cols = 2;
    const rows = 2;
    // Minimal atlas stub — only getOrRaster is read; record the
    // grapheme strings encodeCells asks us to raster so we can verify
    // cell.grapheme actually flowed through.
    const rasterRequests: string[] = [];
    const stubAtlas = {
      getOrRaster: (grapheme: string) => {
        rasterRequests.push(grapheme);
        return { u: 0, v: 0, w: 8, h: 16 };
      },
    };

    // Cell at (1, 1) is a ZWJ family: 👨‍👩‍👧.
    // Codepoints: 0x1F468 0x200D 0x1F469 0x200D 0x1F467.
    const cells: GhosttyCell[] = [];
    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < cols; x++) {
        if (y === 1 && x === 1) {
          cells.push(
            makeCell({
              codepoint: 0x1f468,
              grapheme_len: 4,
              grapheme: [0x200d, 0x1f469, 0x200d, 0x1f467],
              fg_r: 200,
              fg_g: 200,
              fg_b: 200,
              fgIsDefault: false,
            })
          );
        } else {
          cells.push(makeCell({ codepoint: 0x41 })); // 'A'
        }
      }
    }
    const buffer = makeStubBuffer({ cols, rows, cells, placements: [] });
    const cellArray = new Uint32Array(cols * rows * CELL_U32S);
    const ctx = {
      metrics: { width: 8, height: 16, baseline: 12 },
      selectionManager: undefined,
      hoveredHyperlinkId: 0,
      hoveredLinkRange: null,
      cursorStyle: 'block' as const,
      cursorBlinkVisible: false,
      atlas: stubAtlas as unknown as GlyphAtlasBase,
      kittyEnabled: false,
      blockElementShaderEnabled: false,
    };

    encodeCells(cellArray, buffer, 0, undefined, ctx);

    // Zero WASM crossings for grapheme lookup — neither getGrapheme nor
    // getGraphemeString should fire when cell.grapheme is populated.
    expect(buffer.getGraphemeCalls).toBe(0);
    expect(buffer.getGraphemeStringCalls).toBe(0);
    // The ZWJ cluster reached the atlas as a single grapheme string
    // built from cell.codepoint + cell.grapheme.
    expect(rasterRequests).toContain('👨‍👩‍👧');
  });

  // Confirm the test imports are wired — exercises CELL_BYTES so its import is used.
  test('CELL_BYTES matches CELL_U32S * 4', () => {
    expect(CELL_BYTES).toBe(CELL_U32S * 4);
  });
});

describe('encodeCells: bidi reordering', () => {
  const baseCtx = {
    metrics: { width: 8, height: 16, baseline: 12 },
    selectionManager: undefined,
    hoveredHyperlinkId: 0,
    hoveredLinkRange: null,
    cursorStyle: 'block' as const,
    cursorBlinkVisible: false,
    atlas: undefined,
    kittyEnabled: false,
    blockElementShaderEnabled: false,
    bidiMapper: new RowBidiMapper(),
  };

  test('cells land at visual positions', () => {
    const cols = 6,
      rows = 1;
    const buffer = makeStubBuffer({ cols, rows, cells: hebrewRow(cols), placements: [] });
    const cellArray = new Uint32Array(cols * rows * CELL_U32S);
    encodeCells(cellArray, buffer, 0, undefined, baseCtx);
    // visual x=1 must hold logical cell 3 (ו, fg_r=4); x=3 holds logical 1 (ש, fg_r=2)
    expect(cellArray[(0 * cols + 1) * CELL_U32S + 0]! & 0xff).toBe(4);
    expect(cellArray[(0 * cols + 3) * CELL_U32S + 0]! & 0xff).toBe(2);
    // LTR cells stay put
    expect(cellArray[(0 * cols + 0) * CELL_U32S + 0]! & 0xff).toBe(1);
    expect(cellArray[(0 * cols + 4) * CELL_U32S + 0]! & 0xff).toBe(5);
  });

  test('hovered link range flags follow LOGICAL columns', () => {
    const cols = 6,
      rows = 1;
    const buffer = makeStubBuffer({ cols, rows, cells: hebrewRow(cols), placements: [] });
    const cellArray = new Uint32Array(cols * rows * CELL_U32S);
    const ctx = {
      ...baseCtx,
      // Logical col 1 only (ש) — its glyph paints at visual x=3.
      hoveredLinkRange: { startX: 1, startY: 0, endX: 1, endY: 0 },
    };
    encodeCells(cellArray, buffer, 0, undefined, ctx);
    expect(cellArray[(0 * cols + 3) * CELL_U32S + 4]! & FLAG_IS_LINK_RANGE_HOVERED).toBeTruthy();
    expect(cellArray[(0 * cols + 1) * CELL_U32S + 4]! & FLAG_IS_LINK_RANGE_HOVERED).toBeFalsy();
  });

  test('block cursor flag lands at the visual cursor cell', () => {
    const cols = 6,
      rows = 1;
    const buffer = makeStubBuffer({
      cols,
      rows,
      cells: hebrewRow(cols),
      placements: [],
      // stub cursor: logical x=1 (ש) → visual x=3
      cursor: { x: 1, y: 0, visible: true },
    });
    const cellArray = new Uint32Array(cols * rows * CELL_U32S);
    encodeCells(cellArray, buffer, 0, undefined, { ...baseCtx, cursorBlinkVisible: true });
    expect(cellArray[(0 * cols + 3) * CELL_U32S + 4]! & FLAG_IS_CURSOR_CELL).toBeTruthy();
    expect(cellArray[(0 * cols + 1) * CELL_U32S + 4]! & FLAG_IS_CURSOR_CELL).toBeFalsy();
  });

  test('mirrored characters reach the atlas mirrored', () => {
    const cols = 5,
      rows = 1;
    const rastered: string[] = [];
    const atlas = {
      getOrRaster(grapheme: string) {
        rastered.push(grapheme);
        return { u: 0, v: 0, w: 8, h: 16 };
      },
    };
    // א ( ב ) ג — parens on odd level mirror at paint time. The whole row
    // reverses (visualToLogical = [4,3,2,1,0]), so getOrRaster is called in
    // visual order: logical ')' (col 3) paints at visual 1 as '(', and
    // logical '(' (col 1) paints at visual 3 as ')'. Asserting the exact
    // sequence (not just membership) is what actually gates mirroring —
    // the unmirrored multiset would be indistinguishable from this one.
    const cells = [...'א(ב)ג'].map((ch) => makeCell({ codepoint: ch.codePointAt(0)! }));
    const buffer = makeStubBuffer({ cols, rows, cells, placements: [] });
    const cellArray = new Uint32Array(cols * rows * CELL_U32S);
    encodeCells(cellArray, buffer, 0, undefined, { ...baseCtx, atlas: atlas as any });
    expect(rastered).toEqual(['ג', '(', 'ב', ')', 'א']);
  });
});

describe('KittyTextureCacheBase', () => {
  // Concrete stub subclass for testing — no GL needed.
  class StubCache extends KittyTextureCacheBase<{ id: number }> {
    public created: Array<{ id: number; w: number; h: number }> = [];
    public destroyed: Array<{ id: number }> = [];
    public uploaded: Array<{ id: number; bytes: number }> = [];
    private nextId = 1;
    protected createTexture(_w: number, _h: number): { id: number } | null {
      const t = { id: this.nextId++ };
      this.created.push({ id: t.id, w: _w, h: _h });
      return t;
    }
    protected uploadFull(handle: { id: number }, rgba: Uint8Array, _w: number, _h: number): void {
      this.uploaded.push({ id: handle.id, bytes: rgba.length });
    }
    protected destroyTexture(handle: { id: number }): void {
      this.destroyed.push({ id: handle.id });
    }
  }

  test('first call creates and uploads', () => {
    const cache = new StubCache();
    const px = {
      width: 2,
      height: 1,
      format: 1, // RGBA
      data: new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]),
    };
    const handle = cache.getOrUpload(42, px as any);
    expect(handle).not.toBeNull();
    expect(cache.created.length).toBe(1);
    expect(cache.uploaded.length).toBe(1);
  });

  test('second call with identical signature returns cached handle', () => {
    const cache = new StubCache();
    const px = {
      width: 2,
      height: 1,
      format: 1,
      data: new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]),
    };
    const a = cache.getOrUpload(42, px as any);
    const b = cache.getOrUpload(42, px as any);
    expect(a).toBe(b);
    expect(cache.created.length).toBe(1); // no new texture
  });

  test('signature mismatch destroys old and creates new', () => {
    const cache = new StubCache();
    const px1 = {
      width: 2,
      height: 1,
      format: 1,
      data: new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]),
    };
    const px2 = {
      width: 2,
      height: 1,
      format: 1,
      data: new Uint8Array([10, 20, 30, 40, 50, 60, 70, 80]),
    };
    cache.getOrUpload(42, px1 as any);
    cache.getOrUpload(42, px2 as any);
    expect(cache.created.length).toBe(2);
    expect(cache.destroyed.length).toBe(1);
  });

  test('unsupported format returns null without creating', () => {
    const cache = new StubCache();
    const px = {
      width: 2,
      height: 1,
      format: 2, // PNG
      data: new Uint8Array([1, 2, 3]),
    };
    const handle = cache.getOrUpload(42, px as any);
    expect(handle).toBeNull();
    expect(cache.created.length).toBe(0);
  });

  test('destroyAll cleans up every entry', () => {
    const cache = new StubCache();
    const px = {
      width: 2,
      height: 1,
      format: 1,
      data: new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]),
    };
    cache.getOrUpload(42, px as any);
    cache.getOrUpload(43, px as any);
    cache.destroyAll();
    expect(cache.destroyed.length).toBe(2);
  });
});

describe('KittyAtlasBase', () => {
  // Concrete stub subclass — no GL.
  class StubAtlas extends KittyAtlasBase {
    public uploads: Array<{ slot: AtlasSlot; w: number; h: number }> = [];
    constructor(size = 1024) {
      super(size);
    }
    protected uploadRegion(slot: AtlasSlot, _rgba: Uint8Array, w: number, h: number): void {
      this.uploads.push({ slot: { ...slot }, w, h });
    }
    protected growTexture(_newSize: number): void {
      /* v1: no-op */
    }
  }

  function pixels(width: number, height: number, dataLen = width * height * 4) {
    return {
      width,
      height,
      format: 1, // RGBA
      data: new Uint8Array(dataLen),
    } as any;
  }

  test('first add packs at (0,0)', () => {
    const atlas = new StubAtlas();
    const e = atlas.addOrUpdate(1, pixels(64, 32));
    expect(e).not.toBeNull();
    expect(e!.slot).toEqual({ u: 0, v: 0, w: 64, h: 32 });
    expect(atlas.uploads.length).toBe(1);
  });

  test('second add lands to the right of the first on the same shelf', () => {
    const atlas = new StubAtlas();
    atlas.addOrUpdate(1, pixels(64, 32));
    const e = atlas.addOrUpdate(2, pixels(64, 32));
    expect(e!.slot).toEqual({ u: 64, v: 0, w: 64, h: 32 });
  });

  test('signature match returns cached entry, no re-upload', () => {
    const atlas = new StubAtlas();
    const p = pixels(64, 32); // same object ⇒ same buffer identity
    const a = atlas.addOrUpdate(1, p);
    const b = atlas.addOrUpdate(1, p);
    expect(b).toBe(a);
    expect(atlas.uploads.length).toBe(1); // no second upload
  });

  test('overflow triggers clearAndReset and packs at (0,0) again', () => {
    const atlas = new StubAtlas(128); // small atlas
    // 4 64x64 images fill the atlas exactly: (0,0) (64,0) (0,64) (64,64).
    atlas.addOrUpdate(1, pixels(64, 64));
    atlas.addOrUpdate(2, pixels(64, 64));
    atlas.addOrUpdate(3, pixels(64, 64));
    atlas.addOrUpdate(4, pixels(64, 64));
    // 5th 64x64 image overflows; clearAndReset fires and packs at (0,0).
    const e5 = atlas.addOrUpdate(5, pixels(64, 64));
    expect(e5).not.toBeNull();
    expect(e5!.slot).toEqual({ u: 0, v: 0, w: 64, h: 64 });
    // Cache for 1-4 cleared.
    expect(atlas.getEntry(1)).toBeUndefined();
    expect(atlas.getEntry(4)).toBeUndefined();
    expect(atlas.getEntry(5)).toBe(e5!);
  });

  test('mixed-height images do not pack out-of-bounds after wrap', () => {
    const atlas = new StubAtlas(128);
    // Tall image first sets rowHeight = 100.
    const tall = atlas.addOrUpdate(1, pixels(100, 100));
    expect(tall!.slot).toEqual({ u: 0, v: 0, w: 100, h: 100 });
    // Next image at 64×64 wraps horizontally (100+64 > 128) and lands on
    // shelf row 2 at v=100. With the buggy pre-wrap height check, this
    // would have packed at v=100 with h=64 → bottom edge at 164 > 128.
    // Correct algorithm: post-wrap check (100 + 64 > 128) → null → retry.
    const wrap = atlas.addOrUpdate(2, pixels(64, 64));
    expect(wrap).not.toBeNull();
    // After clearAndReset, the 64x64 image packs at (0, 0).
    expect(wrap!.slot).toEqual({ u: 0, v: 0, w: 64, h: 64 });
  });

  test('image larger than atlas grows the backing texture and packs', () => {
    const atlas = new StubAtlas(128);
    const e = atlas.addOrUpdate(1, pixels(256, 256));
    expect(e).not.toBeNull();
    // Atlas grew to the next power of two large enough to hold the image.
    expect(atlas.atlasSize).toBe(256);
    expect(e!.slot).toEqual({ u: 0, v: 0, w: 256, h: 256 });
  });

  test('non-square oversize image grows to fit the larger dimension', () => {
    const atlas = new StubAtlas(1024);
    // Mirrors the ntcharts heatpicture-perlin shape (1070×384) that
    // previously fell through to a null entry and rendered as black.
    const e = atlas.addOrUpdate(143, pixels(1070, 384));
    expect(e).not.toBeNull();
    expect(atlas.atlasSize).toBe(2048);
    expect(e!.slot).toEqual({ u: 0, v: 0, w: 1070, h: 384 });
  });

  test('atlasSize getter returns current size', () => {
    const atlas = new StubAtlas(2048);
    expect(atlas.atlasSize).toBe(2048);
  });
});

describe('visualCursorX', () => {
  test('maps logical cursor column to visual on an RTL row', () => {
    const cols = 6, rows = 1;
    const buffer = makeStubBuffer({ cols, rows, cells: hebrewRow(cols), placements: [] });
    const mapper = new RowBidiMapper();
    // hebrewRow: a ש ל ו b _  → logical 1 (ש) paints at visual 3
    expect(visualCursorX(buffer, { x: 1, y: 0 }, mapper)).toBe(3);
    expect(visualCursorX(buffer, { x: 0, y: 0 }, mapper)).toBe(0);
    expect(visualCursorX(buffer, { x: 1, y: 0 }, null)).toBe(1);
  });
});
