import { expect, test } from 'bun:test';
import { Ghostty } from './ghostty';
import { KittyGraphicsRevision } from './kitty-graphics-revision';

test('every split of a graphics command changes the revision only on completion', () => {
  const command = '\x1b_Ga=T,f=32,s=1,v=1,i=42;ChQe/w==\x1b\\';
  for (let split = 1; split < command.length; split++) {
    const revision = new KittyGraphicsRevision();
    const first = revision.value;
    revision.write(command.slice(0, split));
    expect(revision.value).toBe(first);
    revision.write(new TextEncoder().encode(command.slice(split)));
    expect(revision.value).toBeGreaterThan(first);
    const completed = revision.value;
    revision.write('ordinary text\x1b[31mcolored text\x1b[0m');
    expect(revision.value).toBe(completed);
  }
});

test('separate terminals and resets have distinct graphics revisions', () => {
  expect(new KittyGraphicsRevision().value).not.toBe(new KittyGraphicsRevision().value);
});

test('real WASM retransmissions carry revisions while text keeps image caches valid', async () => {
  const ghostty = await Ghostty.load(new URL('../ghostty-vt.wasm', import.meta.url).pathname);
  const terminal = ghostty.createTerminal(20, 8);
  try {
    const put = (red: number) =>
      terminal.write(
        `\x1b_Ga=T,f=32,s=1,v=1,i=42;${Buffer.from([red, 20, 30, 255]).toString('base64')}\x1b\\`
      );
    put(10);
    const graphics = terminal.getKittyGraphics()!;
    const first = terminal.getKittyImagePixels(graphics, 42)!;
    expect(first.data[0]).toBe(10);
    const revision = first.revision;
    terminal.write('hello');
    expect(terminal.getKittyImagePixels(graphics, 42)!.revision).toBe(revision);
    put(200);
    const second = terminal.getKittyImagePixels(graphics, 42)!;
    expect(second.data[0]).toBe(200);
    expect(second.revision).toBeGreaterThan(revision!);
  } finally {
    terminal.free();
  }
});
