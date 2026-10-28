import { describe, expect, spyOn, test } from 'bun:test';
import { drawBoxDrawing } from './box-drawing';
import { GlyphAtlasBase } from './renderer-core';
class TestAtlas extends GlyphAtlasBase {
  protected uploadRegion(): void {}
  protected growTexture(): void {}
}

describe('cell-filling box drawing', () => {
  test('unsupported characters and grapheme clusters leave the context untouched', () => {
    const ctx = document.createElement('canvas').getContext('2d')!;
    const path = spyOn(ctx, 'beginPath');
    for (const text of ['M', '😀', '─\u0301', '╱', '┄', '╒']) {
      expect(drawBoxDrawing(ctx, text, 0, 0, 9, 22, 14)).toBe(false);
    }
    expect(path).not.toHaveBeenCalled();
  });

  test('straight light, heavy and double rails reach both cell edges', () => {
    for (const fontSize of [12, 14, 15, 18, 24]) {
      const ctx = document.createElement('canvas').getContext('2d')!;
      const rect = spyOn(ctx, 'rect');
      const fill = spyOn(ctx, 'fill');
      for (const [horizontal, vertical] of [
        ['─', '│'],
        ['━', '┃'],
        ['═', '║'],
      ]) {
        rect.mockClear();
        fill.mockClear();
        expect(drawBoxDrawing(ctx, horizontal, 0, 0, 9, 22, fontSize)).toBe(true);
        const rectangles = rect.mock.calls;
        // The union covers every horizontal sample; no dependence on font ink.
        for (let x = 0.25; x < 9; x += 0.5) {
          expect(rectangles.some(([rx, , rw]) => rx <= x && rx + rw >= x)).toBe(true);
        }
        expect(fill).toHaveBeenCalledTimes(1); // faint alpha isn't accumulated at joins
        rect.mockClear();
        drawBoxDrawing(ctx, vertical, 0, 0, 9, 22, fontSize);
        for (let y = 0.25; y < 22; y += 0.5) {
          expect(rect.mock.calls.some(([, ry, , rh]) => ry <= y && ry + rh >= y)).toBe(true);
        }
      }
    }
  });

  test('double corners and junctions retain a hollow center', () => {
    const ctx = document.createElement('canvas').getContext('2d')!;
    const rect = spyOn(ctx, 'rect');
    for (const char of '╔╗╚╝╠╣╦╩╬') {
      rect.mockClear();
      drawBoxDrawing(ctx, char, 0, 0, 9, 22, 14);
      expect(
        rect.mock.calls.some(([x, y, w, h]) => x < 4.5 && x + w > 4.5 && y < 10.5 && y + h > 10.5)
      ).toBe(false);
    }
  });

  test('rounded corners use curves with endpoints on the cell edges', () => {
    const ctx = document.createElement('canvas').getContext('2d')!;
    const curve = spyOn(ctx, 'quadraticCurveTo');
    const move = spyOn(ctx, 'moveTo');
    const line = spyOn(ctx, 'lineTo');
    for (const [char, x, y] of [
      ['╭', 9, 22],
      ['╮', 0, 22],
      ['╰', 9, 0],
      ['╯', 0, 0],
    ] as const) {
      curve.mockClear();
      move.mockClear();
      line.mockClear();
      drawBoxDrawing(ctx, char, 0, 0, 9, 22, 14);
      expect(curve).toHaveBeenCalledTimes(1);
      expect(move.mock.calls[0][0]).toBe(x);
      expect(line.mock.calls.at(-1)![1]).toBe(y);
    }
  });

  test('GPU atlas uses geometry but retains the font path for text, emoji and clusters', () => {
    const ctx = document.createElement('canvas').getContext('2d')!;
    const create = spyOn(document, 'createElement').mockReturnValue({
      getContext: () => ctx,
    } as unknown as HTMLCanvasElement);
    try {
      const text = spyOn(ctx, 'fillText');
      const atlas = new TestAtlas(9, 22, 14, 'monospace');
      for (const glyph of ['─', '┃', '╬', '╭']) atlas.getOrRaster(glyph, 0, 16);
      expect(text).not.toHaveBeenCalled();
      for (const glyph of ['M', '😀', '─\u0301']) atlas.getOrRaster(glyph, 0, 16);
      expect(text.mock.calls.map((call) => call[0])).toEqual(['M', '😀', '─\u0301']);
    } finally {
      create.mockRestore();
    }
  });
});
