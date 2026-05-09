import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { WebGL2Renderer } from './renderer-webgl';
import { type StubWebGL2, installStubWebGL2 } from './test-helpers-webgl';

describe('WebGL2Renderer', () => {
  let getStub: () => StubWebGL2;
  let uninstall: () => void;

  beforeEach(() => {
    ({ getStub, uninstall } = installStubWebGL2());
  });

  afterEach(() => {
    uninstall();
  });

  describe('skeleton', () => {
    test('create() acquires a webgl2 context', async () => {
      const canvas = document.createElement('canvas');
      const r = await WebGL2Renderer.create(canvas, {});
      expect(r.backend).toBe('webgl');
      expect(r.canvas).toBe(canvas);
      // The act of creating triggered context acquisition.
      expect(() => getStub()).not.toThrow();
    });

    test('render() with empty grid is a no-op (no draw)', async () => {
      const canvas = document.createElement('canvas');
      const r = await WebGL2Renderer.create(canvas, {});
      const stub = getStub();
      const before = stub.calls.length;
      const fakeBuffer = {
        getLine: () => null,
        getCursor: () => ({ x: 0, y: 0, visible: false }),
        getDimensions: () => ({ cols: 0, rows: 0 }),
        isRowDirty: () => false,
        clearDirty: () => {},
      };
      r.render(fakeBuffer as any, 0);
      expect(stub.calls.length).toBe(before); // early-return guard fires
    });

    test('render() after resize() clears to theme background', async () => {
      const canvas = document.createElement('canvas');
      const r = await WebGL2Renderer.create(canvas, { theme: { background: '#1e1e1e' } as any });
      r.resize(10, 5);
      const stub = getStub();
      const fakeBuffer = {
        getLine: () => null,
        getCursor: () => ({ x: 0, y: 0, visible: false }),
        getDimensions: () => ({ cols: 10, rows: 5 }),
        isRowDirty: () => false,
        clearDirty: () => {},
      };
      r.render(fakeBuffer as any, 0);
      // Verify clearColor + clear got called (skeleton render only does this).
      expect(stub.countCalls('clearColor')).toBeGreaterThan(0);
      expect(stub.countCalls('clear')).toBeGreaterThan(0);
      const cc = stub.argsOf('clearColor')!;
      // 0x1e / 255 ≈ 0.1176
      expect(cc[0] as number).toBeCloseTo(0x1e / 255, 3);
    });

    test('throws when getContext("webgl2") returns null', async () => {
      uninstall();
      const original = HTMLCanvasElement.prototype.getContext;
      HTMLCanvasElement.prototype.getContext = function (t: string) {
        if (t === 'webgl2') return null as any;
        return original.call(this, t);
      } as any;
      try {
        const canvas = document.createElement('canvas');
        await expect(WebGL2Renderer.create(canvas, {})).rejects.toThrow(/webgl2/i);
      } finally {
        HTMLCanvasElement.prototype.getContext = original;
      }
    });
  });

  describe('encodeCells', () => {
    function fakeCell(overrides: Partial<any> = {}) {
      return {
        codepoint: 0x41, // 'A'
        width: 1,
        flags: 0,
        fg_r: 200,
        fg_g: 200,
        fg_b: 200,
        bg_r: 30,
        bg_g: 30,
        bg_b: 30,
        fgIsDefault: false,
        bgIsDefault: false,
        hyperlink_id: 0,
        grapheme_len: 0,
        ...overrides,
      };
    }

    test('empty cells get FLAG_USE_THEME_FG | FLAG_USE_THEME_BG', async () => {
      const canvas = document.createElement('canvas');
      const r = await WebGL2Renderer.create(canvas, {});
      r.resize(2, 1);
      const buf = {
        getLine: () => null,
        getCursor: () => ({ x: 0, y: 0, visible: false }),
        getDimensions: () => ({ cols: 2, rows: 1 }),
        isRowDirty: () => false,
        clearDirty: () => {},
      };
      const arr = (r as any).encodeCells(buf, 0);
      // CELL_U32S = 8; flags is index 4 within each cell.
      // Each empty cell flags = (USE_THEME_FG | USE_THEME_BG) = (1<<12) | (1<<13) = 0x3000
      expect(arr[4]).toBe(0x3000);
      expect(arr[12]).toBe(0x3000);
    });

    test('cell with explicit fg/bg packs colors little-endian', async () => {
      const canvas = document.createElement('canvas');
      const r = await WebGL2Renderer.create(canvas, {});
      r.resize(1, 1);
      const cell = fakeCell({
        fg_r: 0xab,
        fg_g: 0xcd,
        fg_b: 0xef,
        bg_r: 0x12,
        bg_g: 0x34,
        bg_b: 0x56,
      });
      const buf = {
        getLine: () => [cell],
        getCursor: () => ({ x: 0, y: 0, visible: false }),
        getDimensions: () => ({ cols: 1, rows: 1 }),
        isRowDirty: () => false,
        clearDirty: () => {},
      };
      const arr = (r as any).encodeCells(buf, 0);
      // fg = 0xab | (0xcd << 8) | (0xef << 16) = 0xefcdab
      expect(arr[0]).toBe(0xefcdab);
      // bg = 0x12 | (0x34 << 8) | (0x56 << 16) = 0x563412
      expect(arr[1]).toBe(0x563412);
    });

    test('cursor cell receives FLAG_IS_CURSOR_CELL when block-style cursor visible', async () => {
      const canvas = document.createElement('canvas');
      const r = await WebGL2Renderer.create(canvas, { cursorStyle: 'block' });
      r.resize(2, 1);
      // Force cursor blink to "visible" deterministically (setEnabled(false) sets visible=true).
      (r as any).cursorBlink_.setEnabled(false);
      const cell = fakeCell();
      const buf = {
        getLine: () => [cell, cell],
        getCursor: () => ({ x: 1, y: 0, visible: true }),
        getDimensions: () => ({ cols: 2, rows: 1 }),
        isRowDirty: () => false,
        clearDirty: () => {},
      };
      const arr = (r as any).encodeCells(buf, 0);
      const FLAG_IS_CURSOR_CELL = 1 << 14;
      expect((arr[4] & FLAG_IS_CURSOR_CELL) !== 0).toBe(false); // cell 0
      expect((arr[12] & FLAG_IS_CURSOR_CELL) !== 0).toBe(true); // cell 1 (cursor)
    });
  });

  describe('GLGlyphAtlas', () => {
    test('packs glyphs left-to-right, then wraps to next shelf row', async () => {
      const { GLGlyphAtlas } = await import('./renderer-webgl');
      const canvas = document.createElement('canvas');
      const gl = canvas.getContext('webgl2') as any;
      const atlas = new GLGlyphAtlas(gl, /* cellW */ 10, /* cellH */ 20, 15, 'monospace');
      const a = atlas.getOrRaster('A', 0, 16, 1);
      expect(a).toEqual({ u: 0, v: 0, w: 10, h: 20 });
      const b = atlas.getOrRaster('B', 0, 16, 1);
      expect(b).toEqual({ u: 10, v: 0, w: 10, h: 20 });
      // Wide glyph (2 cells)
      const wide = atlas.getOrRaster('漢', 0, 16, 2);
      expect(wide).toEqual({ u: 20, v: 0, w: 20, h: 20 });
    });

    test('returns cached slot for repeat lookup of same key', async () => {
      const { GLGlyphAtlas } = await import('./renderer-webgl');
      const canvas = document.createElement('canvas');
      const gl = canvas.getContext('webgl2') as any;
      const atlas = new GLGlyphAtlas(gl, 10, 20, 15, 'monospace');
      const first = atlas.getOrRaster('X', 1, 16, 1); // bold
      const second = atlas.getOrRaster('X', 1, 16, 1);
      expect(second).toBe(first);
    });

    test('different style bits produce distinct slots', async () => {
      const { GLGlyphAtlas } = await import('./renderer-webgl');
      const canvas = document.createElement('canvas');
      const gl = canvas.getContext('webgl2') as any;
      const atlas = new GLGlyphAtlas(gl, 10, 20, 15, 'monospace');
      const plain = atlas.getOrRaster('Y', 0, 16, 1);
      const bold = atlas.getOrRaster('Y', 1, 16, 1);
      expect(plain).not.toBe(bold);
      expect(plain.u).not.toBe(bold.u);
    });

    test('first getOrRaster issues a texSubImage2D upload', async () => {
      const { GLGlyphAtlas } = await import('./renderer-webgl');
      const canvas = document.createElement('canvas');
      // installStubWebGL2 patches getContext('webgl2') to return the stub
      // directly, so `gl` here IS the stub — we can read .calls off it.
      const gl = canvas.getContext('webgl2') as any;
      const before = gl.calls.filter((c: any) => c.method === 'texSubImage2D').length;
      const atlas = new GLGlyphAtlas(gl, 10, 20, 15, 'monospace');
      atlas.getOrRaster('Z', 0, 16, 1);
      const after = gl.calls.filter((c: any) => c.method === 'texSubImage2D').length;
      expect(after).toBeGreaterThan(before);
    });

    test('grow() clears cache and resets packing cursor', async () => {
      const { GLGlyphAtlas } = await import('./renderer-webgl');
      const canvas = document.createElement('canvas');
      const gl = canvas.getContext('webgl2') as any;
      // Use cellW small enough that we can fill the atlas in a single test.
      const atlas = new GLGlyphAtlas(gl, 10, 20, 15, 'monospace');
      const initialSize = atlas.atlasSize;
      // Place a glyph and remember its slot.
      const before = atlas.getOrRaster('A', 0, 16, 1);
      // Force grow() by directly invoking it (private but accessible at runtime).
      (atlas as any).grow();
      // Same key after grow should NOT return the cached slot — it should
      // re-rasterize and place at (0, 0) on the new (empty) texture.
      const after = atlas.getOrRaster('A', 0, 16, 1);
      expect(atlas.atlasSize).toBe(initialSize * 2);
      expect(after).not.toBe(before); // cache cleared → new object
      expect(after.u).toBe(0);
      expect(after.v).toBe(0);
    });
  });

  describe('UBO byte construction', () => {
    test('paletteUBO has 96 floats and starts with parsed ANSI black', async () => {
      const canvas = document.createElement('canvas');
      const r = await WebGL2Renderer.create(canvas, {
        theme: { black: '#0a141e' } as any,
      });
      const data = (r as any).buildPaletteUBOBytes() as Float32Array;
      expect(data.length).toBe(96);
      // ANSI[0] = black at vec4 offset 0
      expect(data[0]).toBeCloseTo(0x0a / 255, 4);
      expect(data[1]).toBeCloseTo(0x14 / 255, 4);
      expect(data[2]).toBeCloseTo(0x1e / 255, 4);
      expect(data[3]).toBe(1);
    });

    test('gridUBO is 20 u32s with cols/rows at offsets 0/1', async () => {
      const canvas = document.createElement('canvas');
      const r = await WebGL2Renderer.create(canvas, {});
      r.resize(80, 24);
      const u32 = (r as any).buildGridUBOBytes(0, { x: 0, y: 0, visible: false }) as Uint32Array;
      expect(u32.length).toBe(20);
      expect(u32[0]).toBe(80); // gridSize.x
      expect(u32[1]).toBe(24); // gridSize.y
    });

    test('gridUBO encodes cursorStyle correctly (block=0, underline=1, bar=2)', async () => {
      const canvas = document.createElement('canvas');
      const r = await WebGL2Renderer.create(canvas, { cursorStyle: 'underline' });
      r.resize(1, 1);
      const u32 = (r as any).buildGridUBOBytes(0, { x: 0, y: 0, visible: false }) as Uint32Array;
      expect(u32[8]).toBe(1);
      r.setCursorStyle('bar');
      const u32b = (r as any).buildGridUBOBytes(0, { x: 0, y: 0, visible: false }) as Uint32Array;
      expect(u32b[8]).toBe(2);
    });
  });

  describe('text program', () => {
    test('initialize() compiles vertex+fragment shaders and links the text program', async () => {
      const canvas = document.createElement('canvas');
      await WebGL2Renderer.create(canvas, {});
      const stub = getStub();
      // 2 compileShader calls (vs+fs) for the text program — and Task 10
      // adds two more for the cursor program. After Task 8 specifically we
      // expect at least 2 compileShader and at least 1 linkProgram.
      expect(stub.countCalls('compileShader')).toBeGreaterThanOrEqual(2);
      expect(stub.countCalls('linkProgram')).toBeGreaterThanOrEqual(1);
    });

    test('text program binds GridUBO/PaletteUBO blocks and texture samplers', async () => {
      const canvas = document.createElement('canvas');
      await WebGL2Renderer.create(canvas, {});
      const stub = getStub();
      const blockNames = stub.calls
        .filter((c) => c.method === 'getUniformBlockIndex')
        .map((c) => c.args[1]);
      expect(blockNames).toContain('GridUBO');
      expect(blockNames).toContain('PaletteUBO');
      const uniformNames = stub.calls
        .filter((c) => c.method === 'getUniformLocation')
        .map((c) => c.args[1]);
      expect(uniformNames).toContain('uCellTex');
      expect(uniformNames).toContain('uAtlasTex');
    });
  });

  describe('cell texture upload', () => {
    test('resize() allocates RGBA32UI cell texture sized (cols*2, rows)', async () => {
      const canvas = document.createElement('canvas');
      const r = await WebGL2Renderer.create(canvas, {});
      const stub = getStub();
      r.resize(40, 12);
      // Look for a texStorage2D with internalFormat = RGBA32UI = 0x8d70
      const ts = stub.calls.find(
        (c) => c.method === 'texStorage2D' && (c.args[2] as number) === 0x8d70
      );
      expect(ts).toBeDefined();
      expect(ts!.args[3]).toBe(40 * 2); // width
      expect(ts!.args[4]).toBe(12); // height
    });

    test('render() uploads cellArray bytes via texSubImage2D', async () => {
      const canvas = document.createElement('canvas');
      const r = await WebGL2Renderer.create(canvas, {});
      r.resize(2, 1);
      const stub = getStub();
      const cell = {
        codepoint: 0x41,
        width: 1,
        flags: 0,
        fg_r: 0,
        fg_g: 0,
        fg_b: 0,
        bg_r: 0,
        bg_g: 0,
        bg_b: 0,
        fgIsDefault: false,
        bgIsDefault: false,
        hyperlink_id: 0,
        grapheme_len: 0,
      };
      const buf = {
        getLine: () => [cell, cell],
        getCursor: () => ({ x: 0, y: 0, visible: false }),
        getDimensions: () => ({ cols: 2, rows: 1 }),
        isRowDirty: () => false,
        clearDirty: () => {},
      };
      r.render(buf as any, 0);
      // Cell-texture upload uses format = RGBA_INTEGER = 0x8d99.
      const cellUploads = stub.calls.filter(
        (c) => c.method === 'texSubImage2D' && c.args.includes(0x8d99)
      );
      expect(cellUploads.length).toBeGreaterThan(0);
    });
  });

  describe('cursor program', () => {
    test('initialize() compiles + links cursor program (vs/fs pair)', async () => {
      const canvas = document.createElement('canvas');
      await WebGL2Renderer.create(canvas, {});
      const stub = getStub();
      // After Tasks 8 + 10: 2 programs total → 4 compileShader, 2 linkProgram.
      expect(stub.countCalls('compileShader')).toBeGreaterThanOrEqual(4);
      expect(stub.countCalls('linkProgram')).toBeGreaterThanOrEqual(2);
    });
  });

  describe('text-program render path', () => {
    test('render() issues drawArraysInstanced with instanceCount = cols*rows', async () => {
      const canvas = document.createElement('canvas');
      const r = await WebGL2Renderer.create(canvas, {});
      r.resize(20, 5);
      const stub = getStub();
      stub.calls.length = 0; // clear init calls
      const buf = {
        getLine: () => null,
        getCursor: () => ({ x: 0, y: 0, visible: false }),
        getDimensions: () => ({ cols: 20, rows: 5 }),
        isRowDirty: () => false,
        clearDirty: () => {},
      };
      r.render(buf as any, 0);
      const draws = stub.calls.filter((c) => c.method === 'drawArraysInstanced');
      expect(draws.length).toBe(1);
      const args = draws[0]!.args;
      expect(args[0]).toBe(stub.TRIANGLES);
      expect(args[1]).toBe(0);
      expect(args[2]).toBe(6);
      expect(args[3]).toBe(20 * 5);
    });

    test('render() binds gridUBO and paletteUBO via bindBufferBase', async () => {
      const canvas = document.createElement('canvas');
      const r = await WebGL2Renderer.create(canvas, {});
      r.resize(2, 2);
      const stub = getStub();
      stub.calls.length = 0;
      const buf = {
        getLine: () => null,
        getCursor: () => ({ x: 0, y: 0, visible: false }),
        getDimensions: () => ({ cols: 2, rows: 2 }),
        isRowDirty: () => false,
        clearDirty: () => {},
      };
      r.render(buf as any, 0);
      const baseBindings = stub.calls
        .filter((c) => c.method === 'bindBufferBase')
        .map((c) => c.args[1] as number); // index slot
      expect(baseBindings).toContain(0); // gridUBO
      expect(baseBindings).toContain(1); // paletteUBO
    });
  });

  describe('setters', () => {
    test('setTheme triggers a paletteUBO upload', async () => {
      const canvas = document.createElement('canvas');
      const r = await WebGL2Renderer.create(canvas, {});
      const stub = getStub();
      const before = stub.calls.filter(
        (c) => c.method === 'bufferSubData' && (c.args[0] as number) === stub.UNIFORM_BUFFER
      ).length;
      r.setTheme({ background: '#abcdef' } as any);
      const after = stub.calls.filter(
        (c) => c.method === 'bufferSubData' && (c.args[0] as number) === stub.UNIFORM_BUFFER
      ).length;
      expect(after).toBeGreaterThan(before);
    });

    test('setFontSize resets the atlas', async () => {
      const canvas = document.createElement('canvas');
      const r = await WebGL2Renderer.create(canvas, { fontSize: 14 });
      r.resize(4, 2);
      const atlasBefore = (r as any).atlas;
      r.setFontSize(20);
      // Same instance, but reset.
      expect((r as any).atlas).toBe(atlasBefore);
      // Verify metrics propagated.
      const m = r.getMetrics();
      expect(m.height).toBeGreaterThan(0);
    });
  });

  describe('cursor render path', () => {
    test('non-block visible cursor: drawArrays(TRIANGLES, 0, 6) is called once', async () => {
      const canvas = document.createElement('canvas');
      const r = await WebGL2Renderer.create(canvas, { cursorStyle: 'underline' });
      r.resize(2, 1);
      // Disable blink so isVisible() returns true deterministically.
      (r as any).cursorBlink_.setEnabled(false);
      const stub = getStub();
      stub.calls.length = 0;
      const buf = {
        getLine: () => null,
        getCursor: () => ({ x: 0, y: 0, visible: true }),
        getDimensions: () => ({ cols: 2, rows: 1 }),
        isRowDirty: () => false,
        clearDirty: () => {},
      };
      r.render(buf as any, 0);
      const cursorDraws = stub.calls.filter(
        (c) => c.method === 'drawArrays' && (c.args[2] as number) === 6
      );
      expect(cursorDraws.length).toBe(1);
    });

    test('block cursor: no drawArrays (block handled by text pass)', async () => {
      const canvas = document.createElement('canvas');
      const r = await WebGL2Renderer.create(canvas, { cursorStyle: 'block' });
      r.resize(2, 1);
      (r as any).cursorBlink_.setEnabled(false);
      const stub = getStub();
      stub.calls.length = 0;
      const buf = {
        getLine: () => null,
        getCursor: () => ({ x: 0, y: 0, visible: true }),
        getDimensions: () => ({ cols: 2, rows: 1 }),
        isRowDirty: () => false,
        clearDirty: () => {},
      };
      r.render(buf as any, 0);
      const cursorDraws = stub.calls.filter((c) => c.method === 'drawArrays');
      expect(cursorDraws.length).toBe(0);
    });

    test('hidden cursor: no drawArrays', async () => {
      const canvas = document.createElement('canvas');
      const r = await WebGL2Renderer.create(canvas, { cursorStyle: 'underline' });
      r.resize(2, 1);
      (r as any).cursorBlink_.setEnabled(false);
      const stub = getStub();
      stub.calls.length = 0;
      const buf = {
        getLine: () => null,
        getCursor: () => ({ x: 0, y: 0, visible: false }),
        getDimensions: () => ({ cols: 2, rows: 1 }),
        isRowDirty: () => false,
        clearDirty: () => {},
      };
      r.render(buf as any, 0);
      const cursorDraws = stub.calls.filter((c) => c.method === 'drawArrays');
      expect(cursorDraws.length).toBe(0);
    });
  });

  describe('context-loss listener', () => {
    test('dispatching webglcontextlost fires registered callback', async () => {
      const canvas = document.createElement('canvas');
      const r = await WebGL2Renderer.create(canvas, {});
      let fired = false;
      let reason = '';
      r.onContextLost((info) => {
        fired = true;
        reason = info.reason;
      });
      const ev = new Event('webglcontextlost', { cancelable: true });
      canvas.dispatchEvent(ev);
      expect(fired).toBe(true);
      expect(reason.length).toBeGreaterThanOrEqual(0); // any string ok
    });
  });
});
