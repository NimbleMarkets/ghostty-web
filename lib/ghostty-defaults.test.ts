import { afterEach, describe, expect, test } from 'bun:test';
import { Ghostty, type GhosttyTerminal } from './ghostty';

const terminals: GhosttyTerminal[] = [];

async function create(scrollbackLimit?: number) {
  const ghostty = await Ghostty.load();
  const term = ghostty.createTerminal(80, 24, scrollbackLimit ? { scrollbackLimit } : undefined);
  terminals.push(term);
  return term;
}

afterEach(() => {
  for (const term of terminals.splice(0)) term.free();
});

describe('GhosttyTerminal defaults', () => {
  test('scrollbackLimit is a line count, not capped by a byte budget', async () => {
    const term = await create(10000);
    for (let i = 0; i < 5000; i++) term.write(`line ${i} ${'x'.repeat(40)}\r\n`);
    expect(term.getScrollbackLength()).toBeGreaterThanOrEqual(4900);
  });

  test('grapheme clustering (mode 2027) survives a full reset (RIS)', async () => {
    const term = await create();
    term.write('\x1bc');
    expect(term.getMode(2027)).toBe(true);
    term.write('\u{1F1FA}\u{1F1F8}');
    expect(term.getCursor().x).toBe(2);
  });
});
