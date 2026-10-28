import { readFileSync } from 'node:fs';
/** Pixel regression checks for captures from box-drawing-check.mjs. */
import { decode } from 'fast-png';
const root = new URL(
  process.env.BOX_FONT ? '../.vite/box-drawing/menlo/' : '../.vite/box-drawing/',
  import.meta.url
);
const read = (name) => readFileSync(new URL(name, root));
const phase = process.argv[2] || 'after';
const before = JSON.parse(read('before.json'));
const after = JSON.parse(read(`${phase}.json`));
let cases = 0;
for (let i = 0; i < after.length; i++) {
  const r = after[i],
    b = before[i];
  if (JSON.stringify(r.metrics) !== JSON.stringify(b.metrics)) throw Error('Cell metrics changed');
  const backend = ['canvas2d', 'webgl', 'webgpu'][i % 3];
  const suffix = `${backend}-${r.fontSize}-${r.dpr}.png`;
  const old = decode(read(`before-${suffix}`)),
    img = decode(read(`${phase}-${suffix}`));
  if (old.width !== img.width || old.height !== img.height)
    throw Error(`Canvas size changed: ${suffix}`);
  const { width: w, height: h } = r.metrics,
    dpr = r.dpr;
  for (let y = Math.ceil(14 * h * dpr) + 2; y < Math.floor(16 * h * dpr) - 2; y++) {
    for (let x = 0; x < img.width; x++)
      for (let c = 0; c < 3; c++) {
        if (
          old.data[(y * old.width + x) * old.channels + c] !==
          img.data[(y * img.width + x) * img.channels + c]
        )
          throw Error(`Text/emoji changed: ${suffix} ${x},${y}`);
      }
  }
  const value = (x, y) => img.data[(y * img.width + x) * img.channels];
  for (const row of [0, 3, 6, 9]) {
    for (let x = Math.ceil(w * dpr); x < Math.floor(21 * w * dpr); x++) {
      let peak = 0;
      for (
        let y = Math.floor((row * h + h / 2 - 5) * dpr);
        y < Math.ceil((row * h + h / 2 + 5) * dpr);
        y++
      )
        peak = Math.max(peak, value(x, y));
      if (peak < 80) throw Error(`Horizontal gap: ${suffix}, row=${row}, x=${x}, coverage=${peak}`);
    }
    for (const col of [0, 21])
      for (let y = Math.ceil((row + 0.75) * h * dpr); y < Math.floor((row + 2.25) * h * dpr); y++) {
        let peak = 0;
        for (let x = Math.floor(col * w * dpr); x < Math.ceil((col + 1) * w * dpr); x++)
          peak = Math.max(peak, value(x, y));
        if (peak < 80) throw Error(`Vertical gap: ${suffix}, col=${col}, y=${y}, coverage=${peak}`);
      }
  }
  cases++;
}
console.log(
  `${cases} cases: continuous border rails, identical text/emoji pixels and terminal dimensions`
);
