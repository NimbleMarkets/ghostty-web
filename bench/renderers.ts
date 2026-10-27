/** Run with `bun bench/renderers.ts`; open http://localhost:8002. */
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dir, '..');
const output = resolve(root, '.vite/renderer-bench');
mkdirSync(output, { recursive: true });
const revisions = { before: process.argv[2] ?? 'efd00b1', after: process.argv[3] ?? '5d75d88' };
const metadata: Record<string, string> = {};
for (const [label, ref] of Object.entries(revisions)) {
  const hash =
    ref === 'working'
      ? 'working'
      : execFileSync('git', ['rev-parse', ref], { cwd: root, encoding: 'utf8' }).trim();
  metadata[label] = hash;
  const source = resolve(output, hash);
  mkdirSync(source, { recursive: true });
  if (ref === 'working') {
    cpSync(resolve(root, 'lib'), resolve(source, 'lib'), { recursive: true });
    metadata.workingDiff = execFileSync('git', ['diff', 'HEAD', '--', 'lib'], {
      cwd: root,
      encoding: 'utf8',
    });
  } else {
    const archive = execFileSync('git', ['archive', hash, 'lib'], { cwd: root });
    execFileSync('tar', ['-x', '-C', source], { input: archive });
  }
  try {
    symlinkSync(resolve(root, 'node_modules'), resolve(source, 'node_modules'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  const entry = resolve(source, 'entry.ts');
  writeFileSync(
    entry,
    `export { Ghostty } from './lib/ghostty';
export { CanvasRenderer } from './lib/renderer-canvas2d';
export { WebGL2Renderer } from './lib/renderer-webgl';
export { WebGPURenderer } from './lib/renderer-webgpu';
export { ROWCOLUMN_DIACRITICS } from './lib/kitty_diacritics';`
  );
  const build = await Bun.build({ entrypoints: [entry], target: 'browser', minify: true });
  if (!build.success) throw new Error(build.logs.join('\n'));
  await Bun.write(resolve(output, `${label}.js`), build.outputs[0]);
}
const wasm = Bun.file(resolve(root, 'ghostty-vt.wasm'));
const wasmHash = new Bun.CryptoHasher('sha256').update(await wasm.arrayBuffer()).digest('hex');
const server = Bun.serve({
  hostname: '127.0.0.1',
  port: Number(process.env.PORT ?? 8002),
  async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === '/results' && request.method === 'POST') {
      const results = await request.json();
      await Bun.write(resolve(output, 'results.json'), JSON.stringify(results, null, 2));
      console.log('Saved results:', resolve(output, 'results.json'));
      return new Response('saved');
    }
    if (path === '/metadata') return Response.json({ ...metadata, wasmHash });
    if (path === '/ghostty-vt.wasm') return new Response(wasm);
    if (path === '/before.js' || path === '/after.js')
      return new Response(Bun.file(resolve(output, path.slice(1))));
    if (path === '/') return new Response(Bun.file(resolve(root, 'bench/renderers.html')));
    return new Response('Not found', { status: 404 });
  },
});
console.log(`Renderer benchmark: ${server.url}`);
