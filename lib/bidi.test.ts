import { describe, expect, test } from 'bun:test';
import bidiFactory from 'bidi-js';
import { RowBidiMapper } from './bidi';
import type { GhosttyCell } from './types';

function makeCell(overrides: Partial<GhosttyCell> = {}): GhosttyCell {
  return {
    codepoint: 0,
    fg_r: 0, fg_g: 0, fg_b: 0,
    bg_r: 0, bg_g: 0, bg_b: 0,
    fgIsDefault: true, bgIsDefault: true,
    flags: 0, width: 1, hyperlink_id: 0,
    grapheme_len: 0, grapheme: null,
    ...overrides,
  };
}

/** One cell per codepoint of `s`, width 1. Wide chars: use makeWide below. */
function cellsFrom(s: string): GhosttyCell[] {
  return [...s].map((ch) => makeCell({ codepoint: ch.codePointAt(0)! }));
}

describe('bidi-js smoke test', () => {
  test('factory initializes and reorders Hebrew', () => {
    const bidi = bidiFactory();
    const text = 'שלום'; // שלום
    const levels = bidi.getEmbeddingLevels(text, 'ltr');
    const indices = bidi.getReorderedIndices(text, levels);
    expect(indices).toEqual([3, 2, 1, 0]);
  });
});

describe('RowBidiMapper fast path', () => {
  const mapper = new RowBidiMapper();

  test('pure ASCII row returns identity', () => {
    const map = mapper.getMap(cellsFrom('hello'));
    expect(map.isIdentity).toBe(true);
    expect([...map.visualToLogical]).toEqual([0, 1, 2, 3, 4]);
    expect(map.mirror).toBeNull();
  });

  test('CJK row (codepoints above U+0590 but not RTL) returns identity', () => {
    const map = mapper.getMap(cellsFrom('漢字'));
    expect(map.isIdentity).toBe(true);
  });

  test('kitty placeholder row returns identity', () => {
    const line = [
      makeCell({ codepoint: 0x10eeee, grapheme_len: 2, grapheme: [0x305, 0x305] }),
      makeCell(),
    ];
    expect(mapper.getMap(line).isIdentity).toBe(true);
  });

  test('identity maps are shared per row length', () => {
    const a = mapper.getMap(cellsFrom('abc'));
    const b = mapper.getMap(cellsFrom('xyz'));
    expect(a).toBe(b);
  });

  test('empty row returns identity', () => {
    expect(mapper.getMap([]).isIdentity).toBe(true);
  });
});
