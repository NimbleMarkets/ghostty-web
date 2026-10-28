// Run with Vite on port 8000. Set PLAYWRIGHT_MODULE to an existing Playwright install if needed.
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const baselineDir = new URL('../.vite/box-drawing/', import.meta.url);
const output = new URL(process.env.BOX_FONT ? 'menlo/' : './', baselineDir);
mkdirSync(output, { recursive: true });
if (process.argv[2] === 'before') {
  const archive = execFileSync('git', ['archive', process.argv[3] || 'HEAD', 'lib']);
  execFileSync('tar', ['-x', '-C', baselineDir.pathname], { input: archive });
}

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const results = [];
try {
  for (const dpr of [1, 1.25, 2]) {
    const context = await browser.newContext({
      deviceScaleFactor: dpr,
      viewport: { width: 900, height: 850 },
    });
    const page = await context.newPage();
    page.on('pageerror', (e) => console.error(e));
    for (const size of [12, 14, 15, 18, 24])
      for (const renderer of ['canvas2d', 'webgl', 'webgpu']) {
        const phase = process.argv[2] || 'before';
        await page.goto(
          `http://127.0.0.1:8000/demo/box-drawing-check.html?renderer=${renderer}&size=${size}&${phase}&font=${encodeURIComponent(process.env.BOX_FONT || '')}`
        );
        await page.waitForFunction(() => window.result, undefined, { timeout: 10000 });
        const result = await page.evaluate(() => window.result);
        const cdp = await context.newCDPSession(page);
        await cdp.send('DOM.enable');
        await cdp.send('CSS.enable');
        const { root } = await cdp.send('DOM.getDocument');
        result.fonts = {};
        for (const id of ['latin', 'horizontal', 'vertical', 'rounded', 'emoji']) {
          const { nodeId } = await cdp.send('DOM.querySelector', {
            nodeId: root.nodeId,
            selector: '#' + id,
          });
          result.fonts[id] = (await cdp.send('CSS.getPlatformFontsForNode', { nodeId })).fonts;
        }
        await cdp.detach();
        await page
          .locator('#terminal canvas')
          .first()
          .screenshot({ path: `${output.pathname}${phase}-${renderer}-${size}-${dpr}.png` });
        results.push(result);
        console.log(phase, renderer, size, dpr, result.backend);
      }
    await context.close();
  }
  writeFileSync(
    `${output.pathname}${process.argv[2] || 'before'}.json`,
    JSON.stringify(results, null, 2)
  );
} finally {
  await browser.close();
}
