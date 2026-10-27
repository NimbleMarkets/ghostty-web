import { afterEach, expect, test } from 'bun:test';
import { Ghostty, type GhosttyTerminal } from './ghostty';
import { CanvasRenderer } from './renderer-canvas2d';
import { WebGL2Renderer } from './renderer-webgl';
import { installStubWebGL2 } from './test-helpers-webgl';

const terminals: GhosttyTerminal[] = [];
afterEach(() => {
  for (const term of terminals.splice(0)) term.free();
});
async function terminal(cols = 12, rows = 5) {
  const term = (await Ghostty.load()).createTerminal(cols, rows);
  term.setCellPixelSize(8, 16);
  terminals.push(term);
  return term;
}
const apc = (args: string, payload = '') => `\x1b_G${args}${payload ? `;${payload}` : ''}\x1b\\`;
const red = (id: number, options = '') =>
  apc(`a=T,f=32,s=1,v=1,i=${id},c=2,r=2,C=1${options}`, '/wAA/w==');

test('resolved frame includes multiple placements, layers, offsets and stable idle identity', async () => {
  const t = await terminal();
  t.write(red(1, ',z=-2147483648,X=2,Y=3'));
  t.write('\x1b[1;4H' + apc('a=p,i=1,p=2,c=2,r=2,z=-1,C=1'));
  t.write('\x1b[1;7H' + apc('a=p,i=1,p=3,c=2,r=2,z=1,C=1'));
  const frame = t.getImageFrame();
  expect(frame.placements.map((p) => p.layer)).toEqual([0, 1, 2]);
  expect(frame.placements[0]).toMatchObject({ offsetX: 2, offsetY: 3 });
  expect(frame.placements.map((p) => p.viewportCol)).toEqual([0, 3, 6]);
  expect(t.getImageFrame()).toBe(frame);
  expect(frame.pixels(1)).toBe(frame.pixels(1));
});

test('placeholder runs are resolved upstream, including omitted inherited diacritics', async () => {
  const t = await terminal();
  t.write(red(7, ',U=1'));
  t.write('\x1b[38;2;0;0;7m\u{10EEEE}\u0305\u0305\u{10EEEE}\x1b[0m');
  const frame = t.getImageFrame();
  expect(frame.placements).toHaveLength(1);
  expect(frame.placements[0]).toMatchObject({
    imageId: 7,
    pixelWidth: 16,
    pixelHeight: 8,
    offsetY: 8,
  });
});

test('scrollback images use the displayed viewport without moving active text/cursor', async () => {
  const t = await terminal(12, 3);
  t.write(red(1));
  t.write('\r\n1\r\n2\r\n3\r\n4');
  const cursor = t.getCursor();
  const line = t.getLine(2)!.map((c) => c.codepoint);
  expect(t.getImageFrame().placements).toHaveLength(0);
  expect(t.getImageFrame(3).placements[0].viewportRow).toBe(0);
  expect(t.getImageFrame(1).placements[0].viewportRow).toBe(-1);
  expect(t.getCursor()).toEqual(cursor);
  expect(t.getLine(2)!.map((c) => c.codepoint)).toEqual(line);
});

test('changing one image preserves another image pixel cache and borrowed bytes are copied', async () => {
  const t = await terminal();
  t.write(red(1) + red(2));
  const first = t.getImageFrame();
  const a = first.pixels(1)!;
  const b = first.pixels(2)!;
  t.write(apc('a=T,f=32,s=1,v=1,i=1,c=2,r=2,C=1', 'AAD//w=='));
  const next = t.getImageFrame();
  expect(next.pixels(1)!.revision).not.toBe(a.revision);
  expect(next.pixels(2)).toBe(b);
  expect(Array.from(a.data)).toEqual([255, 0, 0, 255]);
  expect(Array.from(next.pixels(1)!.data)).toEqual([0, 0, 255, 255]);
});

test('animation changes pixels on deadlines without any terminal writes', async () => {
  const t = await terminal();
  t.write(
    red(1) +
      apc('a=f,f=32,i=1,s=1,v=1,z=40', 'AAD//w==') +
      apc('a=a,i=1,r=1,z=30') +
      apc('a=a,i=1,s=3')
  );
  expect(t.tickImageAnimations(1000)).toBe(1030);
  const first = t.getImageFrame();
  expect(Array.from(first.pixels(1)!.data)).toEqual([255, 0, 0, 255]);
  expect(t.tickImageAnimations(1010)).toBe(1030);
  expect(t.getImageFrame()).toBe(first);
  expect(t.tickImageAnimations(1030)).toBe(1070);
  expect(Array.from(t.getImageFrame().pixels(1)!.data)).toEqual([0, 0, 255, 255]);
  t.write(apc('a=a,i=1,s=1'));
  expect(t.tickImageAnimations(1100)).toBeNull();
});

test('screen switches and deletion invalidate images', async () => {
  const t = await terminal();
  t.write(red(1));
  const first = t.getImageFrame();
  t.write('\x1b[?1049h');
  expect(t.getImageFrame().placements).toHaveLength(0);
  t.write('\x1b[?1049l');
  expect(t.getImageFrame().placements).toHaveLength(1);
  expect(t.getImageFrame().revision).not.toBe(first.revision);
  t.write(apc('a=d,d=A'));
  expect(t.getImageFrame().placements).toHaveLength(0);
});

test('WebGL interleaves images with backgrounds and glyphs; idle frames issue no GPU calls', async () => {
  const { getStub, uninstall } = installStubWebGL2();
  const t = await terminal();
  const renderer = await WebGL2Renderer.create(document.createElement('canvas'), {});
  try {
    renderer.resize(12, 5);
    t.write('\x1b[?25l' + red(1, ',z=-2147483648') + red(2, ',z=-1') + red(3, ',z=1'));
    const stub = getStub();
    stub.calls.length = 0;
    renderer.render(t);
    expect(
      stub.calls
        .filter((c) => c.method === 'drawArrays' || c.method === 'drawArraysInstanced')
        .map((c) => c.method)
    ).toEqual([
      'drawArrays',
      'drawArraysInstanced',
      'drawArrays',
      'drawArraysInstanced',
      'drawArrays',
    ]);
    const count = stub.calls.length;
    renderer.render(t);
    expect(stub.calls).toHaveLength(count);
  } finally {
    renderer.destroy();
    uninstall();
  }
});

test('Canvas clips image layers to repainted rows and does not redraw idle translucent images', async () => {
  const t = await terminal();
  const canvas = document.createElement('canvas');
  const renderer = new CanvasRenderer(canvas, {});
  const context = (renderer as any).ctx as CanvasRenderingContext2D;
  const { spyOn } = await import('bun:test');
  const decode = spyOn(renderer as any, 'decodeKittyImageToCanvas').mockReturnValue(
    document.createElement('canvas')
  );
  const draw = spyOn(context, 'drawImage');
  const clip = spyOn(context, 'clip');
  try {
    t.write('\x1b[?25l' + red(1, ',z=-1'));
    renderer.render(t);
    expect(draw).toHaveBeenCalled();
    expect(clip).toHaveBeenCalled();
    const count = draw.mock.calls.length;
    renderer.render(t);
    expect(draw.mock.calls.length).toBe(count);
  } finally {
    decode.mockRestore();
    draw.mockRestore();
    clip.mockRestore();
    renderer.destroy();
  }
});

test('image snapshots do not consume text damage or leave cells stale', async () => {
  const t = await terminal();
  t.write('old');
  t.getImageFrame();
  t.getViewport();
  t.clearDirty();
  t.write('\rnew');
  t.getImageFrame();
  expect(t.isRowDirty(0)).toBe(true);
  expect(
    t
      .getLine(0)!
      .slice(0, 3)
      .map((c) => String.fromCodePoint(c.codepoint))
      .join('')
  ).toBe('new');
});

test('contiguous placeholder rows coalesce into one textured rectangle', async () => {
  const t = await terminal();
  t.write(apc('a=T,f=32,s=1,v=2,i=7,c=2,r=2,U=1', '/wAA//8AAP8='));
  t.write('\x1b[38;2;0;0;7m\u{10EEEE}\u0305\u0305\u{10EEEE}\r\n\u{10EEEE}\u030d\u0305\u{10EEEE}');
  expect(t.getImageFrame().placements).toHaveLength(1);
  expect(t.getImageFrame().placements[0]).toMatchObject({
    pixelWidth: 16,
    pixelHeight: 32,
    sourceHeight: 2,
  });
});

test('new renderer path supports more than 256 visible images without legacy placement walks', async () => {
  const { getStub, uninstall } = installStubWebGL2();
  const t = await terminal(260, 2);
  const renderer = await WebGL2Renderer.create(document.createElement('canvas'), {});
  try {
    renderer.resize(260, 2);
    t.write('\x1b[?25l');
    for (let i = 1; i <= 260; i++) t.write(`\x1b[1;${i}H` + red(i));
    t.iterPlacements = () => {
      throw new Error('Legacy placements must not be read');
    };
    expect(t.getImageFrame().placements).toHaveLength(260);
    const stub = getStub();
    stub.calls.length = 0;
    renderer.render(t);
    expect(stub.countCalls('drawArrays')).toBe(260);
  } finally {
    renderer.destroy();
    uninstall();
  }
});

test('Terminal owns animation timers, respects render holds and cancels on disposal', async () => {
  const { Terminal } = await import('./terminal');
  const { spyOn } = await import('bun:test');
  const term = new Terminal({ ghostty: await Ghostty.load(), renderer: 'canvas2d' });
  await term.open(document.createElement('div'));
  const internal = term as any;
  const draw = spyOn(internal.renderer, 'render').mockImplementation(() => {});
  const tick = spyOn(term.wasmTerm!, 'tickImageAnimations');
  try {
    term.write(
      red(1) +
        apc('a=f,f=32,i=1,s=1,v=1,z=40', 'AAD//w==') +
        apc('a=a,i=1,r=1,z=30') +
        apc('a=a,i=1,s=3')
    );
    internal.renderFrame();
    expect(internal.imageAnimationTimer).toBeDefined();
    const calls = tick.mock.calls.length;
    term.write('\x1b[?2026h');
    expect(internal.renderFrame()).toBe(false);
    expect(tick.mock.calls.length).toBe(calls);
    term.write('\x1b[?2026l' + apc('a=a,i=1,s=1'));
    internal.renderFrame();
    expect(internal.imageAnimationTimer).toBeUndefined();
    term.write(apc('a=a,i=1,s=3'));
    internal.renderFrame();
    expect(internal.imageAnimationTimer).toBeDefined();
    term.dispose();
    expect(internal.imageAnimationTimer).toBeUndefined();
  } finally {
    draw.mockRestore();
    tick.mockRestore();
    term.dispose();
  }
});

test('relative placements inherit their parent position and preserve source cropping', async () => {
  const t = await terminal();
  t.write('\x1b[2;3H' + red(1, ',p=11'));
  t.write(apc('a=t,f=32,s=4,v=4,i=2', Buffer.alloc(4 * 4 * 4, 255).toString('base64')));
  t.write(apc('a=p,i=2,p=22,P=1,Q=11,H=2,V=1,c=2,r=2,x=1,y=1,w=2,h=2'));
  const child = t.getImageFrame().placements.find((p) => p.imageId === 2)!;
  expect(child).toMatchObject({
    viewportCol: 4,
    viewportRow: 2,
    sourceX: 1,
    sourceY: 1,
    sourceWidth: 2,
    sourceHeight: 2,
  });
});
