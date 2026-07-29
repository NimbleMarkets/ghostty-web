import { describe, expect, test } from 'bun:test';
import bidiFactory from 'bidi-js';

describe('bidi-js smoke test', () => {
  test('factory initializes and reorders Hebrew', () => {
    const bidi = bidiFactory();
    const text = 'שלום'; // שלום
    const levels = bidi.getEmbeddingLevels(text, 'ltr');
    const indices = bidi.getReorderedIndices(text, levels);
    expect(indices).toEqual([3, 2, 1, 0]);
  });
});
