import { expect, test } from 'bun:test';
import { Ghostty } from './ghostty';

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
