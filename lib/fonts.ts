import type { ITerminalOptions } from './interfaces';

export const DEFAULT_FONT_FAMILY =
  '"JetBrains Mono", "Cascadia Code", "Iosevka", "Source Code Pro", "ui-monospace", "SF Mono", Menlo, Consolas, monospace';

/** Load before measuring; failed or slow faces leave the fallback stack available. */
export async function loadFontFaces(faces: ITerminalOptions['fontFaces']): Promise<void> {
  if (!faces?.length || typeof FontFace === 'undefined' || !document.fonts) return;
  let expired = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const loads = faces.map(async ({ family, src, weight, style, display }) => {
    try {
      const sources = (Array.isArray(src) ? src : [src]).map((source) =>
        /^(url|local)\(/.test(source.trim()) ? source : `url(${JSON.stringify(source)})`
      );
      const face = new FontFace(family, sources.join(', '), {
        ...(weight !== undefined ? { weight: String(weight) } : {}),
        ...(style ? { style } : {}),
        ...(display ? { display } : {}),
      });
      await face.load();
      // Don't introduce a late font swap with stale cell metrics after timeout.
      if (!expired) (document.fonts as FontFaceSet & { add(face: FontFace): void }).add(face);
    } catch {
      // Invalid descriptors and unavailable files fall back to the configured stack.
    }
  });
  await Promise.race([
    Promise.all(loads),
    new Promise<void>((resolve) => {
      timer = setTimeout(() => {
        expired = true;
        resolve();
      }, 3000);
    }),
  ]);
  clearTimeout(timer);
}
