import { describe, expect, test } from 'bun:test';
import { EventEmitter } from './event-emitter';

describe('EventEmitter', () => {
  test('a listener that disposes itself during fire does not skip the next listener', () => {
    const emitter = new EventEmitter<number>();
    const seen: string[] = [];
    const first = emitter.event((n) => {
      seen.push(`first:${n}`);
      first.dispose();
    });
    emitter.event((n) => seen.push(`second:${n}`));
    emitter.fire(1);
    emitter.fire(2);
    expect(seen).toEqual(['first:1', 'second:1', 'second:2']);
  });
});
