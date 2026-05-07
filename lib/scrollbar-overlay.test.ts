import { describe, expect, test } from 'bun:test';
import { ScrollbarOverlay } from './scrollbar-overlay';

function makeStubCanvas(width = 800, height = 480): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = width;
  c.height = height;
  return c;
}

describe('ScrollbarOverlay', () => {
  test('hides itself when scrollback length is 0', () => {
    const overlay = new ScrollbarOverlay(makeStubCanvas(), 1);
    const calls = overlay._renderForTest({
      viewportY: 0,
      scrollbackLength: 0,
      visibleRows: 24,
      opacity: 1,
    });
    expect(calls.thumb).toBeNull();
  });

  test('places thumb at the bottom when viewportY = 0', () => {
    const overlay = new ScrollbarOverlay(makeStubCanvas(800, 480), 1);
    const calls = overlay._renderForTest({
      viewportY: 0,
      scrollbackLength: 100,
      visibleRows: 24,
      opacity: 1,
    });
    expect(calls.thumb).not.toBeNull();
    // viewportY=0 puts the thumb at the bottom, so its top is far down.
    expect(calls.thumb!.y).toBeGreaterThan(200);
  });

  test('places thumb at the top when viewportY = scrollbackLength', () => {
    const overlay = new ScrollbarOverlay(makeStubCanvas(800, 480), 1);
    const calls = overlay._renderForTest({
      viewportY: 100,
      scrollbackLength: 100,
      visibleRows: 24,
      opacity: 1,
    });
    expect(calls.thumb!.y).toBeLessThan(20);
  });

  test('skips drawing when opacity is 0', () => {
    const overlay = new ScrollbarOverlay(makeStubCanvas(), 1);
    const calls = overlay._renderForTest({
      viewportY: 50,
      scrollbackLength: 100,
      visibleRows: 24,
      opacity: 0,
    });
    expect(calls.thumb).toBeNull();
  });
});
