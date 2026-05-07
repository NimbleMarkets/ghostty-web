import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { CursorBlink } from './cursor-blink';

describe('CursorBlink', () => {
  let originalSetInterval: typeof setInterval;
  let originalClearInterval: typeof clearInterval;
  let now = 0;
  let intervals: { id: number; fn: () => void; delay: number; nextFire: number }[] = [];
  let nextId = 1;

  beforeEach(() => {
    now = 0;
    intervals = [];
    nextId = 1;
    originalSetInterval = globalThis.setInterval;
    originalClearInterval = globalThis.clearInterval;
    // @ts-expect-error fake setInterval
    globalThis.setInterval = ((fn: () => void, delay: number) => {
      const id = nextId++;
      intervals.push({ id, fn, delay, nextFire: now + delay });
      return id;
    }) as any;
    // @ts-expect-error fake clearInterval
    globalThis.clearInterval = ((id: number) => {
      intervals = intervals.filter((i) => i.id !== id);
    }) as any;
  });

  afterEach(() => {
    globalThis.setInterval = originalSetInterval;
    globalThis.clearInterval = originalClearInterval;
  });

  function advance(ms: number) {
    now += ms;
    for (const i of intervals) {
      while (i.nextFire <= now) {
        i.fn();
        i.nextFire += i.delay;
      }
    }
  }

  test('starts visible and toggles every 530ms when enabled', () => {
    const blink = new CursorBlink();
    expect(blink.isVisible()).toBe(true);

    blink.setEnabled(true);
    expect(blink.isVisible()).toBe(true);
    advance(530);
    expect(blink.isVisible()).toBe(false);
    advance(530);
    expect(blink.isVisible()).toBe(true);
  });

  test('does not toggle when disabled', () => {
    const blink = new CursorBlink();
    blink.setEnabled(false);
    advance(2000);
    expect(blink.isVisible()).toBe(true);
  });

  test('calls onRequestRender on each toggle', () => {
    const blink = new CursorBlink();
    const onRender = mock(() => {});
    blink.setOnRequestRender(onRender);
    blink.setEnabled(true);
    advance(530 * 3);
    expect(onRender).toHaveBeenCalledTimes(3);
  });

  test('stops the timer on destroy', () => {
    const blink = new CursorBlink();
    blink.setEnabled(true);
    blink.destroy();
    expect(intervals.length).toBe(0);
  });
});
