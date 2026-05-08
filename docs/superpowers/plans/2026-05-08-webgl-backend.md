# WebGL2 Renderer Backend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a WebGL2 rendering backend (`WebGL2Renderer`) implementing the existing `Renderer` interface, wired into the renderer factory's auto-fallback chain (WebGPU → WebGL → Canvas2D). Feature-parity scope is core text only: text + colors + cursor + selection + link/hyperlink underlines. No kitty graphics, no in-shader block-element drawing.

**Architecture:** Standalone `lib/renderer-webgl.ts` paralleling `lib/renderer-webgpu.ts`. CPU-side logic (`encodeCells`, glyph atlas packing, palette/grid byte layout, font measurement) is copied and adapted from the WebGPU renderer with kitty-specific branches removed. Cell data is uploaded as an `RGBA32UI` 2D texture sized `(cols * 2, rows)` and read in the fragment shader via `texelFetch`. Two GL programs (`textProgram`, `cursorProgram`) mirror the WebGPU `textPipeline`/`cursorPipeline`. UBO byte layouts match WebGPU exactly. The kitty pipeline is omitted entirely.

**Tech Stack:** TypeScript, WebGL2, GLSL ES 3.00. Test runner: `bun test`. Pre-commit gate: `bun run fmt && bun run lint && bun run typecheck && bun test && bun run build`.

**Spec:** `docs/superpowers/specs/2026-05-08-webgl-backend-design.md`

---

## File Structure

| Path | Status | Purpose |
|---|---|---|
| `lib/renderer-types.ts` | modify | Widen `RendererBackend` and `Renderer.backend` union to include `'webgl'` |
| `lib/renderer-factory.ts` | modify | Add WebGL branch; `'auto'` chain becomes WebGPU → WebGL → Canvas2D |
| `lib/renderer-factory.test.ts` | modify | Cover new chain |
| `lib/renderer-webgl.ts` | add | `WebGL2Renderer` class, GL programs, GLGlyphAtlas, encodeCells |
| `lib/renderer-webgl.test.ts` | add | Stub-context tests for renderer wiring |
| `lib/test-helpers-webgl.ts` | add | `StubWebGL2Context` recorder + `installStubWebGL2` for happy-dom |
| `lib/terminal.ts` | modify | WebGPU `onDeviceLost` falls back to WebGL2 first; new `webglcontextlost` handler that falls back to Canvas2D |
| `demo/index.html` | modify | Accept `?renderer=webgl` |
| `lib/renderer-webgpu.ts` | untouched | Zero changes |

The new `WebGL2Renderer` class is single-responsibility (manages its own GL context lifecycle), and the test stub lives in its own file so the helper isn't pulled into production bundles.

## Reference snapshots (for the implementer)

These point to the equivalent code in `renderer-webgpu.ts` you'll be adapting. Read them before each port task; commit hashes capture the current state of the file.

- `lib/renderer-webgpu.ts:39-307` — `TEXT_SHADER` (WGSL). Translation target for Task 8.
- `lib/renderer-webgpu.ts:313-378` — `CURSOR_SHADER` (WGSL). Translation target for Task 10.
- `lib/renderer-webgpu.ts:444-588` — `GlyphAtlas` class. Adapted in Task 4.
- `lib/renderer-webgpu.ts:591-609` — Cell-encoding constants (`CELL_BYTES`, `CELL_U32S`, flag bits). Used verbatim.
- `lib/renderer-webgpu.ts:1074-1283` — `encodeCells`. Adapted in Task 5 (kitty branches dropped).
- `lib/renderer-webgpu.ts:886-897` — `measureFont`. Reused verbatim.
- `lib/renderer-webgpu.ts:901-962` — `uploadPaletteUBO`/`uploadGridUBO` byte construction. Reused verbatim; only the upload call differs.
- `lib/renderer-webgpu.ts:1456-1469` — `parseHexColor`. Reused verbatim.
- `lib/terminal.ts:599-623` — Existing WebGPU device-lost fallback. Modified in Task 15.
- `lib/renderer-factory.test.ts` (entire file) — Test patterns to follow for Task 14.

---

## Task 1: Widen `RendererBackend` union to include `'webgl'`

**Files:**
- Modify: `lib/renderer-types.ts:24` (the `RendererBackend` type)
- Modify: `lib/renderer-types.ts:74` (the `Renderer.backend` field)
- Modify: `lib/renderer-factory.ts` (return error path for unrecognized 'webgl' before factory wiring lands in Task 14)

This task is a pure type widening. No behavior changes. The factory throws "WebGL backend not yet implemented" for `'webgl'` until Task 14 wires it up. Existing tests must continue to pass.

- [ ] **Step 1: Update `RendererBackend` and `Renderer.backend`**

In `lib/renderer-types.ts`, change line 24:

```ts
export type RendererBackend = 'webgpu' | 'webgl' | 'canvas2d' | 'auto';
```

And line 74 (the `Renderer` interface field):

```ts
export interface Renderer {
  readonly backend: 'webgpu' | 'webgl' | 'canvas2d';
  readonly canvas: HTMLCanvasElement;
  // ...rest unchanged
}
```

- [ ] **Step 2: Add the explicit-throw branch to the factory**

In `lib/renderer-factory.ts`, immediately after the `if (backend === 'canvas2d') { ... }` block, add:

```ts
  if (backend === 'webgl') {
    throw new Error('WebGL backend not yet implemented');
  }
```

This makes explicit `'webgl'` requests fail loudly until Task 14, while `'auto'` continues to use the existing WebGPU-or-Canvas2D path unchanged.

- [ ] **Step 3: Run typecheck + existing tests**

Run: `bun run typecheck && bun test lib/renderer-factory.test.ts`
Expected: All pass. The widened union is a strict superset; nothing breaks.

- [ ] **Step 4: Commit**

```bash
git add lib/renderer-types.ts lib/renderer-factory.ts
git commit -m "feat(render): widen RendererBackend to include 'webgl'"
```

---

## Task 2: Stub `WebGL2RenderingContext` test helper

**Files:**
- Create: `lib/test-helpers-webgl.ts`
- Test: (no test for the helper itself; it's exercised by Task 3+ tests)

A recording stub is the only practical way to test the GL renderer under bun + happy-dom (no real WebGL2 there). The stub captures every method call into a `calls: { method, args }[]` log and returns plausible values for the queries we make (`getShaderParameter` → true, `getProgramParameter` → true, `getError` → 0, `createX` → distinct numeric ids, `getUniformLocation`/`getUniformBlockIndex` → ids).

- [ ] **Step 1: Create `lib/test-helpers-webgl.ts`**

```ts
/**
 * Stub WebGL2 context for unit tests. Records every method call and
 * returns plausible values for the queries we make. Pair with
 * installStubWebGL2() to monkey-patch HTMLCanvasElement.getContext.
 *
 * The stub does not validate GL semantics — it only verifies that the
 * renderer issues the calls we expect, in the order we expect.
 */

export type GLCall = { method: string; args: unknown[] };

export class StubWebGL2 {
  public calls: GLCall[] = [];

  // GL constants we rely on inside the renderer.
  readonly ARRAY_BUFFER = 0x8892;
  readonly UNIFORM_BUFFER = 0x8a11;
  readonly STATIC_DRAW = 0x88e4;
  readonly DYNAMIC_DRAW = 0x88e8;
  readonly TEXTURE_2D = 0x0de1;
  readonly TEXTURE0 = 0x84c0;
  readonly TEXTURE1 = 0x84c1;
  readonly RGBA = 0x1908;
  readonly RGBA8 = 0x8058;
  readonly RGBA32UI = 0x8d70;
  readonly RGBA_INTEGER = 0x8d99;
  readonly UNSIGNED_BYTE = 0x1401;
  readonly UNSIGNED_INT = 0x1405;
  readonly NEAREST = 0x2600;
  readonly LINEAR = 0x2601;
  readonly CLAMP_TO_EDGE = 0x812f;
  readonly TEXTURE_MIN_FILTER = 0x2800;
  readonly TEXTURE_MAG_FILTER = 0x2801;
  readonly TEXTURE_WRAP_S = 0x2802;
  readonly TEXTURE_WRAP_T = 0x2803;
  readonly VERTEX_SHADER = 0x8b31;
  readonly FRAGMENT_SHADER = 0x8b30;
  readonly COMPILE_STATUS = 0x8b81;
  readonly LINK_STATUS = 0x8b82;
  readonly TRIANGLES = 0x0004;
  readonly COLOR_BUFFER_BIT = 0x4000;
  readonly NO_ERROR = 0;
  readonly BLEND = 0x0be2;
  readonly SRC_ALPHA = 0x0302;
  readonly ONE = 1;
  readonly ZERO = 0;
  readonly ONE_MINUS_SRC_ALPHA = 0x0303;
  readonly FUNC_ADD = 0x8006;

  drawingBufferWidth = 800;
  drawingBufferHeight = 600;

  private nextId = 1;
  private newId(): { _id: number } {
    return { _id: this.nextId++ };
  }

  // ---- Methods we record-and-return ------------------------------------

  createShader(_type: number) {
    this.calls.push({ method: 'createShader', args: [_type] });
    return this.newId();
  }
  shaderSource(shader: unknown, src: string) {
    this.calls.push({ method: 'shaderSource', args: [shader, src] });
  }
  compileShader(shader: unknown) {
    this.calls.push({ method: 'compileShader', args: [shader] });
  }
  getShaderParameter(_shader: unknown, pname: number) {
    this.calls.push({ method: 'getShaderParameter', args: [_shader, pname] });
    if (pname === this.COMPILE_STATUS) return true;
    return 0;
  }
  getShaderInfoLog(_shader: unknown) {
    return '';
  }
  createProgram() {
    this.calls.push({ method: 'createProgram', args: [] });
    return this.newId();
  }
  attachShader(p: unknown, s: unknown) {
    this.calls.push({ method: 'attachShader', args: [p, s] });
  }
  linkProgram(p: unknown) {
    this.calls.push({ method: 'linkProgram', args: [p] });
  }
  getProgramParameter(_p: unknown, pname: number) {
    this.calls.push({ method: 'getProgramParameter', args: [_p, pname] });
    if (pname === this.LINK_STATUS) return true;
    return 0;
  }
  getProgramInfoLog(_p: unknown) {
    return '';
  }
  useProgram(p: unknown) {
    this.calls.push({ method: 'useProgram', args: [p] });
  }
  deleteShader(s: unknown) {
    this.calls.push({ method: 'deleteShader', args: [s] });
  }
  deleteProgram(p: unknown) {
    this.calls.push({ method: 'deleteProgram', args: [p] });
  }
  getUniformLocation(_p: unknown, name: string) {
    this.calls.push({ method: 'getUniformLocation', args: [_p, name] });
    return this.newId();
  }
  getUniformBlockIndex(_p: unknown, name: string) {
    this.calls.push({ method: 'getUniformBlockIndex', args: [_p, name] });
    return this.nextId++;
  }
  uniformBlockBinding(p: unknown, idx: number, binding: number) {
    this.calls.push({ method: 'uniformBlockBinding', args: [p, idx, binding] });
  }
  uniform1i(loc: unknown, v: number) {
    this.calls.push({ method: 'uniform1i', args: [loc, v] });
  }

  createBuffer() {
    this.calls.push({ method: 'createBuffer', args: [] });
    return this.newId();
  }
  bindBuffer(target: number, buf: unknown) {
    this.calls.push({ method: 'bindBuffer', args: [target, buf] });
  }
  bindBufferBase(target: number, idx: number, buf: unknown) {
    this.calls.push({ method: 'bindBufferBase', args: [target, idx, buf] });
  }
  bufferData(target: number, sizeOrData: unknown, usage: number) {
    this.calls.push({ method: 'bufferData', args: [target, sizeOrData, usage] });
  }
  bufferSubData(target: number, off: number, data: unknown) {
    this.calls.push({ method: 'bufferSubData', args: [target, off, data] });
  }

  createTexture() {
    this.calls.push({ method: 'createTexture', args: [] });
    return this.newId();
  }
  bindTexture(target: number, tex: unknown) {
    this.calls.push({ method: 'bindTexture', args: [target, tex] });
  }
  activeTexture(slot: number) {
    this.calls.push({ method: 'activeTexture', args: [slot] });
  }
  texParameteri(t: number, p: number, v: number) {
    this.calls.push({ method: 'texParameteri', args: [t, p, v] });
  }
  texStorage2D(t: number, levels: number, fmt: number, w: number, h: number) {
    this.calls.push({ method: 'texStorage2D', args: [t, levels, fmt, w, h] });
  }
  texSubImage2D(...args: unknown[]) {
    this.calls.push({ method: 'texSubImage2D', args });
  }
  pixelStorei(name: number, value: number) {
    this.calls.push({ method: 'pixelStorei', args: [name, value] });
  }

  createVertexArray() {
    this.calls.push({ method: 'createVertexArray', args: [] });
    return this.newId();
  }
  bindVertexArray(v: unknown) {
    this.calls.push({ method: 'bindVertexArray', args: [v] });
  }
  enableVertexAttribArray(i: number) {
    this.calls.push({ method: 'enableVertexAttribArray', args: [i] });
  }

  enable(cap: number) {
    this.calls.push({ method: 'enable', args: [cap] });
  }
  disable(cap: number) {
    this.calls.push({ method: 'disable', args: [cap] });
  }
  blendFuncSeparate(...args: unknown[]) {
    this.calls.push({ method: 'blendFuncSeparate', args });
  }
  blendEquation(mode: number) {
    this.calls.push({ method: 'blendEquation', args: [mode] });
  }
  viewport(x: number, y: number, w: number, h: number) {
    this.calls.push({ method: 'viewport', args: [x, y, w, h] });
  }
  clearColor(r: number, g: number, b: number, a: number) {
    this.calls.push({ method: 'clearColor', args: [r, g, b, a] });
  }
  clear(mask: number) {
    this.calls.push({ method: 'clear', args: [mask] });
  }

  drawArrays(mode: number, first: number, count: number) {
    this.calls.push({ method: 'drawArrays', args: [mode, first, count] });
  }
  drawArraysInstanced(mode: number, first: number, count: number, ic: number) {
    this.calls.push({ method: 'drawArraysInstanced', args: [mode, first, count, ic] });
  }

  getError() {
    return this.NO_ERROR;
  }

  /** Convenience: number of times a method appears in the call log. */
  countCalls(method: string): number {
    return this.calls.filter((c) => c.method === method).length;
  }

  /** Convenience: extract the args of the Nth occurrence (0-indexed). */
  argsOf(method: string, occurrence = 0): unknown[] | undefined {
    let seen = 0;
    for (const c of this.calls) {
      if (c.method === method) {
        if (seen === occurrence) return c.args;
        seen++;
      }
    }
    return undefined;
  }
}

/**
 * Monkey-patches HTMLCanvasElement.prototype.getContext('webgl2') to
 * return a fresh StubWebGL2 each call. Returns the most-recent stub.
 * Call uninstall() in afterEach.
 */
export function installStubWebGL2(): {
  getStub: () => StubWebGL2;
  uninstall: () => void;
} {
  const original = HTMLCanvasElement.prototype.getContext;
  let lastStub: StubWebGL2 | null = null;
  HTMLCanvasElement.prototype.getContext = function (
    contextType: string,
    options?: unknown
  ): unknown {
    if (contextType === 'webgl2') {
      lastStub = new StubWebGL2();
      return lastStub as unknown;
    }
    return original.call(this, contextType, options as undefined);
  } as typeof HTMLCanvasElement.prototype.getContext;
  return {
    getStub: () => {
      if (!lastStub) throw new Error('No webgl2 context was created');
      return lastStub;
    },
    uninstall: () => {
      HTMLCanvasElement.prototype.getContext = original;
      lastStub = null;
    },
  };
}
```

- [ ] **Step 2: Verify file compiles**

Run: `bun run typecheck`
Expected: PASS (no consumers yet, but the file itself must type-check).

- [ ] **Step 3: Commit**

```bash
git add lib/test-helpers-webgl.ts
git commit -m "test(render): add stub WebGL2 context recorder"
```

---

## Task 3: WebGL2Renderer skeleton — context init + clear-only render

**Files:**
- Create: `lib/renderer-webgl.ts`
- Create: `lib/renderer-webgl.test.ts`

A minimal `WebGL2Renderer` that gets a `webgl2` context, sets DPR-aware canvas sizing, exposes `backend = 'webgl'` and the rest of the `Renderer` interface as stubs (no-ops or sensible defaults), and on `render()` only sets the viewport, clears to `theme.background`, and returns. Establishes the file skeleton; all subsequent tasks fill in pieces.

- [ ] **Step 1: Write the failing test**

Create `lib/renderer-webgl.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { WebGL2Renderer } from './renderer-webgl';
import { installStubWebGL2, type StubWebGL2 } from './test-helpers-webgl';

describe('WebGL2Renderer', () => {
  let getStub: () => StubWebGL2;
  let uninstall: () => void;

  beforeEach(() => {
    ({ getStub, uninstall } = installStubWebGL2());
  });

  afterEach(() => {
    uninstall();
  });

  describe('skeleton', () => {
    test('create() acquires a webgl2 context', async () => {
      const canvas = document.createElement('canvas');
      const r = await WebGL2Renderer.create(canvas, {});
      expect(r.backend).toBe('webgl');
      expect(r.canvas).toBe(canvas);
      // The act of creating triggered context acquisition.
      expect(() => getStub()).not.toThrow();
    });

    test('render() with empty grid is a no-op (no draw)', async () => {
      const canvas = document.createElement('canvas');
      const r = await WebGL2Renderer.create(canvas, {});
      const stub = getStub();
      const before = stub.calls.length;
      const fakeBuffer = {
        getLine: () => null,
        getCursor: () => ({ x: 0, y: 0, visible: false }),
        getDimensions: () => ({ cols: 0, rows: 0 }),
        isRowDirty: () => false,
        clearDirty: () => {},
      };
      r.render(fakeBuffer as any, 0);
      expect(stub.calls.length).toBe(before); // early-return guard fires
    });

    test('render() after resize() clears to theme background', async () => {
      const canvas = document.createElement('canvas');
      const r = await WebGL2Renderer.create(canvas, { theme: { background: '#1e1e1e' } as any });
      r.resize(10, 5);
      const stub = getStub();
      const fakeBuffer = {
        getLine: () => null,
        getCursor: () => ({ x: 0, y: 0, visible: false }),
        getDimensions: () => ({ cols: 10, rows: 5 }),
        isRowDirty: () => false,
        clearDirty: () => {},
      };
      r.render(fakeBuffer as any, 0);
      // Verify clearColor + clear got called (skeleton render only does this).
      expect(stub.countCalls('clearColor')).toBeGreaterThan(0);
      expect(stub.countCalls('clear')).toBeGreaterThan(0);
      const cc = stub.argsOf('clearColor')!;
      // 0x1e / 255 ≈ 0.1176
      expect((cc[0] as number)).toBeCloseTo(0x1e / 255, 3);
    });

    test('throws when getContext("webgl2") returns null', async () => {
      uninstall();
      const original = HTMLCanvasElement.prototype.getContext;
      HTMLCanvasElement.prototype.getContext = function (t: string) {
        if (t === 'webgl2') return null as any;
        return original.call(this, t);
      } as any;
      try {
        const canvas = document.createElement('canvas');
        await expect(WebGL2Renderer.create(canvas, {})).rejects.toThrow(/webgl2/i);
      } finally {
        HTMLCanvasElement.prototype.getContext = original;
      }
    });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test lib/renderer-webgl.test.ts`
Expected: FAIL with module-resolution error ("Cannot find module './renderer-webgl'") — the file doesn't exist yet.

- [ ] **Step 3: Create the skeleton renderer**

Create `lib/renderer-webgl.ts`:

```ts
/**
 * WebGL2 renderer.
 *
 * Implementation grows across the WebGL backend plan tasks:
 *   T3:  context init, DPR-aware canvas sizing, clear-only render
 *   T4:  GLGlyphAtlas
 *   T5:  encodeCells (kitty branches removed)
 *   T6:  paletteUBO + gridUBO byte construction
 *   T7:  cell texture allocation + upload
 *   T8:  text vertex/fragment shaders + program
 *   T9:  text-program render path
 *   T10: cursor shader + program
 *   T11: cursor render path + cursor-blink
 *   T12: setters / lifecycle
 *   T13: webglcontextlost listener API
 *
 * No kitty graphics, no in-shader block-element drawing in v1.
 */

import { CursorBlink } from './cursor-blink';
import type { ITheme } from './interfaces';
import type { SelectionManager } from './selection-manager';
import { DEFAULT_THEME } from './renderer';
import type {
  FontMetrics,
  IRenderable,
  IScrollbackProvider,
  LinkRange,
  Renderer,
  RendererOptions,
} from './renderer-types';

const warnedUnparseableColors = new Set<string>();

export class WebGL2Renderer implements Renderer {
  public readonly backend = 'webgl' as const;
  public readonly canvas: HTMLCanvasElement;

  private gl!: WebGL2RenderingContext;
  private theme: Required<ITheme> = DEFAULT_THEME;
  private fontSize: number;
  private fontFamily: string;
  private cursorStyle: 'block' | 'underline' | 'bar';
  private dpr: number;
  private metrics: FontMetrics = { width: 0, height: 0, baseline: 0 };
  private cols = 0;
  private rows = 0;
  private cursorBlink_ = new CursorBlink();
  private selectionManager?: SelectionManager;
  private hoveredHyperlinkId = 0;
  private hoveredLinkRange: LinkRange | null = null;
  private onRequestRender: (() => void) | null = null;
  private invalidateNext = true;
  private destroyed = false;
  private contextLostListeners: Array<(info: { reason: string }) => void> = [];

  static async create(
    canvas: HTMLCanvasElement,
    opts: RendererOptions
  ): Promise<WebGL2Renderer> {
    const r = new WebGL2Renderer(canvas, opts);
    await r.initialize();
    return r;
  }

  private constructor(canvas: HTMLCanvasElement, opts: RendererOptions) {
    this.canvas = canvas;
    this.fontSize = opts.fontSize ?? 15;
    this.fontFamily = opts.fontFamily ?? 'monospace';
    this.cursorStyle = opts.cursorStyle ?? 'block';
    this.dpr = opts.devicePixelRatio ?? window.devicePixelRatio ?? 1;
    this.theme = { ...DEFAULT_THEME, ...opts.theme };
    this.cursorBlink_.setEnabled(opts.cursorBlink ?? false);
  }

  private async initialize(): Promise<void> {
    const gl = this.canvas.getContext('webgl2', {
      alpha: false,
      antialias: false,
      preserveDrawingBuffer: false,
    }) as WebGL2RenderingContext | null;
    if (!gl) throw new Error('WebGL2Renderer: failed to acquire webgl2 context');
    this.gl = gl;
    this.metrics = this.measureFont();
    // T13: this.canvas.addEventListener('webglcontextlost', ...)
  }

  // -------- Font metrics --------

  private measureFont(): FontMetrics {
    const c = document.createElement('canvas');
    const ctx = c.getContext('2d')!;
    ctx.font = `${this.fontSize}px ${this.fontFamily}`;
    const m = ctx.measureText('M');
    const width = Math.ceil(m.width);
    const ascent = m.actualBoundingBoxAscent || this.fontSize * 0.8;
    const descent = m.actualBoundingBoxDescent || this.fontSize * 0.2;
    const height = Math.ceil(ascent + descent) + 2;
    const baseline = Math.ceil(ascent) + 1;
    return { width, height, baseline };
  }

  private parseHexColor(hex: string): [number, number, number] {
    const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex.trim());
    if (!m) {
      if (!warnedUnparseableColors.has(hex)) {
        warnedUnparseableColors.add(hex);
        console.warn(
          '[ghostty-web] WebGL2Renderer: unparseable theme color, falling back to black:',
          hex
        );
      }
      return [0, 0, 0];
    }
    return [Number.parseInt(m[1]!, 16), Number.parseInt(m[2]!, 16), Number.parseInt(m[3]!, 16)];
  }

  // -------- Renderer interface --------

  getMetrics(): FontMetrics {
    return { ...this.metrics };
  }

  resize(cols: number, rows: number): void {
    this.cols = cols;
    this.rows = rows;
    const cssW = cols * this.metrics.width;
    const cssH = rows * this.metrics.height;
    this.canvas.style.width = `${cssW}px`;
    this.canvas.style.height = `${cssH}px`;
    this.canvas.width = Math.round(cssW * this.dpr);
    this.canvas.height = Math.round(cssH * this.dpr);
    this.invalidateNext = true;
  }

  render(_buffer: IRenderable, _viewportY: number = 0, _sb?: IScrollbackProvider): void {
    if (this.cols === 0 || this.rows === 0) return;
    const gl = this.gl;
    const [r, g, b] = this.parseHexColor(this.theme.background);
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.clearColor(r / 255, g / 255, b / 255, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    this.invalidateNext = false;
  }

  setTheme(theme: ITheme): void {
    this.theme = { ...DEFAULT_THEME, ...theme };
    this.invalidateNext = true;
    this.onRequestRender?.();
  }

  setFontSize(size: number): void {
    this.fontSize = size;
    this.metrics = this.measureFont();
    this.invalidateNext = true;
    this.onRequestRender?.();
  }

  setFontFamily(family: string): void {
    this.fontFamily = family;
    this.metrics = this.measureFont();
    this.invalidateNext = true;
    this.onRequestRender?.();
  }

  setCursorStyle(style: 'block' | 'underline' | 'bar'): void {
    this.cursorStyle = style;
    this.invalidateNext = true;
    this.onRequestRender?.();
  }

  setCursorBlink(enabled: boolean): void {
    this.cursorBlink_.setEnabled(enabled);
  }

  setOnRequestRender(fn: (() => void) | null): void {
    this.onRequestRender = fn;
    this.cursorBlink_.setOnRequestRender(fn);
  }

  setSelectionManager(mgr: SelectionManager): void {
    this.selectionManager = mgr;
    this.invalidateNext = true;
  }

  setHoveredHyperlinkId(id: number): void {
    if (this.hoveredHyperlinkId === id) return;
    this.hoveredHyperlinkId = id;
    this.invalidateNext = true;
    this.onRequestRender?.();
  }

  setHoveredLinkRange(range: LinkRange | null): void {
    if (this.hoveredLinkRange === range) return;
    this.hoveredLinkRange = range;
    this.invalidateNext = true;
    this.onRequestRender?.();
  }

  invalidate(): void {
    this.invalidateNext = true;
  }

  remeasureFont(): void {
    this.metrics = this.measureFont();
    this.invalidateNext = true;
  }

  destroy(): void {
    this.destroyed = true;
    this.cursorBlink_.destroy();
  }

  /** T13 will register a callback fired on webglcontextlost. */
  onContextLost(fn: (info: { reason: string }) => void): void {
    this.contextLostListeners.push(fn);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test lib/renderer-webgl.test.ts`
Expected: PASS — all 4 tests green.

- [ ] **Step 5: Run full pre-commit gate**

Run: `bun run fmt && bun run lint && bun run typecheck && bun test`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add lib/renderer-webgl.ts lib/renderer-webgl.test.ts
git commit -m "feat(render): WebGL2 renderer skeleton with clear-only render"
```

---

## Task 4: GLGlyphAtlas — port `GlyphAtlas` from WebGPU

**Files:**
- Modify: `lib/renderer-webgl.ts` — add `GLGlyphAtlas` class
- Modify: `lib/renderer-webgl.test.ts` — add atlas test cases

The `GlyphAtlas` shelf-packing logic is API-agnostic. We copy it as `GLGlyphAtlas`, swapping `device.queue.writeTexture` for `gl.texSubImage2D` and the WebGPU texture handle for a GL texture id. The pure-logic test verifies the slot positions returned by a known sequence of `getOrRaster` calls; the GL-side test verifies `texSubImage2D` is called with the expected origin and size.

- [ ] **Step 1: Write the failing tests**

Append to `lib/renderer-webgl.test.ts` (inside the existing `describe('WebGL2Renderer', ...)`):

```ts
  describe('GLGlyphAtlas', () => {
    test('packs glyphs left-to-right, then wraps to next shelf row', async () => {
      // Use the renderer to construct an atlas indirectly: call resize() so
      // the atlas is allocated (Task 4 wires this), then trigger glyph
      // rasterizations via render() (later tasks do this implicitly). For
      // this isolated test we import the class directly.
      const { GLGlyphAtlas } = await import('./renderer-webgl');
      const canvas = document.createElement('canvas');
      const gl = canvas.getContext('webgl2') as any;
      const atlas = new GLGlyphAtlas(gl, /* cellW */ 10, /* cellH */ 20, 15, 'monospace');
      const a = atlas.getOrRaster('A', 0, 16, 1);
      expect(a).toEqual({ u: 0, v: 0, w: 10, h: 20 });
      const b = atlas.getOrRaster('B', 0, 16, 1);
      expect(b).toEqual({ u: 10, v: 0, w: 10, h: 20 });
      // Wide glyph (2 cells)
      const wide = atlas.getOrRaster('漢', 0, 16, 2);
      expect(wide).toEqual({ u: 20, v: 0, w: 20, h: 20 });
    });

    test('returns cached slot for repeat lookup of same key', async () => {
      const { GLGlyphAtlas } = await import('./renderer-webgl');
      const canvas = document.createElement('canvas');
      const gl = canvas.getContext('webgl2') as any;
      const atlas = new GLGlyphAtlas(gl, 10, 20, 15, 'monospace');
      const first = atlas.getOrRaster('X', 1, 16, 1); // bold
      const second = atlas.getOrRaster('X', 1, 16, 1);
      expect(second).toBe(first);
    });

    test('different style bits produce distinct slots', async () => {
      const { GLGlyphAtlas } = await import('./renderer-webgl');
      const canvas = document.createElement('canvas');
      const gl = canvas.getContext('webgl2') as any;
      const atlas = new GLGlyphAtlas(gl, 10, 20, 15, 'monospace');
      const plain = atlas.getOrRaster('Y', 0, 16, 1);
      const bold = atlas.getOrRaster('Y', 1, 16, 1);
      expect(plain).not.toBe(bold);
      expect(plain.u).not.toBe(bold.u);
    });

    test('first getOrRaster issues a texSubImage2D upload', async () => {
      const { GLGlyphAtlas } = await import('./renderer-webgl');
      const canvas = document.createElement('canvas');
      // installStubWebGL2 patches getContext('webgl2') to return the stub
      // directly, so `gl` here IS the stub — we can read .calls off it.
      const gl = canvas.getContext('webgl2') as any;
      const before = gl.calls.filter((c: any) => c.method === 'texSubImage2D').length;
      const atlas = new GLGlyphAtlas(gl, 10, 20, 15, 'monospace');
      atlas.getOrRaster('Z', 0, 16, 1);
      const after = gl.calls.filter((c: any) => c.method === 'texSubImage2D').length;
      expect(after).toBeGreaterThan(before);
    });
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test lib/renderer-webgl.test.ts -t "GLGlyphAtlas"`
Expected: FAIL — `GLGlyphAtlas` is not exported from `renderer-webgl.ts`.

- [ ] **Step 3: Add `GLGlyphAtlas` class to `lib/renderer-webgl.ts`**

Insert directly after the `warnedUnparseableColors` constant and before `export class WebGL2Renderer`:

```ts
type AtlasSlot = { u: number; v: number; w: number; h: number };

export class GLGlyphAtlas {
  private gl: WebGL2RenderingContext;
  private texture: WebGLTexture;
  private size: number; // square; powers of 2
  private nextX = 0;
  private nextY = 0;
  private rowHeight = 0;
  private cache = new Map<string, AtlasSlot>();
  private cellW: number;
  private cellH: number;
  private fontSize: number;
  private fontFamily: string;
  private offscreen = document.createElement('canvas');
  private offCtx: CanvasRenderingContext2D;

  constructor(
    gl: WebGL2RenderingContext,
    cellW: number,
    cellH: number,
    fontSize: number,
    fontFamily: string
  ) {
    this.gl = gl;
    this.cellW = cellW;
    this.cellH = cellH;
    this.fontSize = fontSize;
    this.fontFamily = fontFamily;
    this.size = 1024;
    const tex = gl.createTexture();
    if (!tex) throw new Error('GLGlyphAtlas: createTexture failed');
    this.texture = tex;
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, this.size, this.size);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    this.offscreen.width = cellW * 2;
    this.offscreen.height = cellH;
    this.offCtx = this.offscreen.getContext('2d', { willReadFrequently: true })!;
  }

  glTexture(): WebGLTexture {
    return this.texture;
  }

  reset(cellW: number, cellH: number, fontSize: number, fontFamily: string): void {
    this.cellW = cellW;
    this.cellH = cellH;
    this.fontSize = fontSize;
    this.fontFamily = fontFamily;
    this.cache.clear();
    this.nextX = 0;
    this.nextY = 0;
    this.rowHeight = 0;
    this.offscreen.width = cellW * 2;
    this.offscreen.height = cellH;
  }

  getOrRaster(
    grapheme: string,
    styleBits: number,
    baseline: number,
    widthInCells: number = 1
  ): AtlasSlot {
    const key = `${widthInCells}|${styleBits}|${grapheme}`;
    const cached = this.cache.get(key);
    if (cached) return cached;

    const w = this.cellW * widthInCells;
    const h = this.cellH;
    if (this.nextX + w > this.size) {
      this.nextX = 0;
      this.nextY += this.rowHeight;
      this.rowHeight = 0;
    }
    if (this.nextY + h > this.size) {
      this.grow();
    }
    const slot: AtlasSlot = { u: this.nextX, v: this.nextY, w, h };
    this.nextX += w;
    if (h > this.rowHeight) this.rowHeight = h;
    this.cache.set(key, slot);

    const ctx = this.offCtx;
    ctx.clearRect(0, 0, w, h);
    let style = '';
    if (styleBits & 1) style += 'bold ';
    if (styleBits & 2) style += 'italic ';
    ctx.font = `${style}${this.fontSize}px ${this.fontFamily}`;
    ctx.textBaseline = 'alphabetic';
    ctx.textAlign = 'left';
    ctx.fillStyle = styleBits & 4 ? 'rgba(255, 255, 255, 0.5)' : '#ffffff';
    ctx.fillText(grapheme, 0, baseline);

    const img = ctx.getImageData(0, 0, w, h);
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.pixelStorei(/* UNPACK_ALIGNMENT */ 0x0cf5, 1);
    gl.texSubImage2D(
      gl.TEXTURE_2D,
      0,
      slot.u,
      slot.v,
      w,
      h,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      img.data
    );
    return slot;
  }

  private grow(): void {
    const newSize = this.size * 2;
    const gl = this.gl;
    const newTex = gl.createTexture();
    if (!newTex) {
      console.warn('[ghostty-web] GLGlyphAtlas: grow() failed; keeping existing atlas');
      return;
    }
    gl.bindTexture(gl.TEXTURE_2D, newTex);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, newSize, newSize);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    // We do not preserve old contents on grow — the cache is going to
    // re-rasterize misses on demand. (Same trade-off as the WebGPU path's
    // copyTextureToTexture, just simpler.)
    gl.deleteTexture?.(this.texture);
    this.texture = newTex;
    this.size = newSize;
  }

  get atlasSize(): number {
    return this.size;
  }
}
```

Note: the WebGPU `GlyphAtlas.grow()` copies the old texture into the new one to preserve glyphs. The simpler approach above re-rasterizes on miss; for the v1 atlas size of 1024² and a 60-row terminal at 14px font, growth is rare in practice. If profiling shows hitches, swap in a copy-via-FBO approach in a follow-up.

You'll also need to add `deleteTexture` to the stub. In `lib/test-helpers-webgl.ts`, add inside `StubWebGL2`:

```ts
  deleteTexture(t: unknown) {
    this.calls.push({ method: 'deleteTexture', args: [t] });
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test lib/renderer-webgl.test.ts -t "GLGlyphAtlas"`
Expected: PASS — all 4 atlas tests green.

- [ ] **Step 5: Run pre-commit gate**

Run: `bun run fmt && bun run lint && bun run typecheck && bun test`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add lib/renderer-webgl.ts lib/renderer-webgl.test.ts lib/test-helpers-webgl.ts
git commit -m "feat(render): port GlyphAtlas to WebGL2 (GLGlyphAtlas)"
```

---

## Task 5: encodeCells — port from WebGPU, kitty branches removed

**Files:**
- Modify: `lib/renderer-webgl.ts` — add cell-encoding constants + `encodeCells` method
- Modify: `lib/renderer-webgl.test.ts` — add encodeCells tests

The encoding writes a packed `Uint32Array` of `cols*rows*8` u32s. Kitty branches are dropped (no `FLAG_IS_KITTY_PLACEHOLDER`, no virtual placement index, no `iterPlacements` walk). The block-element flag bit is also dropped because we don't have a shader path for it; block-drawing characters fall through to the atlas path and render as font glyphs. All other behavior — selection, hyperlink/link-range hover, theme-fg/bg flag, wide-glyph spacer cell — is preserved.

- [ ] **Step 1: Write the failing tests**

Append to `lib/renderer-webgl.test.ts` (inside the existing `describe('WebGL2Renderer', ...)`):

```ts
  describe('encodeCells', () => {
    function fakeCell(overrides: Partial<any> = {}) {
      return {
        codepoint: 0x41, // 'A'
        width: 1,
        flags: 0,
        fg_r: 200, fg_g: 200, fg_b: 200,
        bg_r: 30, bg_g: 30, bg_b: 30,
        fgIsDefault: false,
        bgIsDefault: false,
        hyperlink_id: 0,
        grapheme_len: 0,
        ...overrides,
      };
    }

    test('empty cells get FLAG_USE_THEME_FG | FLAG_USE_THEME_BG', async () => {
      const canvas = document.createElement('canvas');
      const r = await WebGL2Renderer.create(canvas, {});
      r.resize(2, 1);
      const buf = {
        getLine: () => null,
        getCursor: () => ({ x: 0, y: 0, visible: false }),
        getDimensions: () => ({ cols: 2, rows: 1 }),
        isRowDirty: () => false,
        clearDirty: () => {},
      };
      const arr = (r as any).encodeCells(buf, 0);
      // CELL_U32S = 8; flags is index 4 within each cell.
      // Each empty cell flags = (USE_THEME_FG | USE_THEME_BG) = (1<<12) | (1<<13) = 0x3000
      expect(arr[4]).toBe(0x3000);
      expect(arr[12]).toBe(0x3000);
    });

    test('cell with explicit fg/bg packs colors little-endian', async () => {
      const canvas = document.createElement('canvas');
      const r = await WebGL2Renderer.create(canvas, {});
      r.resize(1, 1);
      const cell = fakeCell({ fg_r: 0xab, fg_g: 0xcd, fg_b: 0xef, bg_r: 0x12, bg_g: 0x34, bg_b: 0x56 });
      const buf = {
        getLine: () => [cell],
        getCursor: () => ({ x: 0, y: 0, visible: false }),
        getDimensions: () => ({ cols: 1, rows: 1 }),
        isRowDirty: () => false,
        clearDirty: () => {},
      };
      const arr = (r as any).encodeCells(buf, 0);
      // fg = 0xab | (0xcd << 8) | (0xef << 16) = 0xefcdab
      expect(arr[0]).toBe(0xefcdab);
      // bg = 0x12 | (0x34 << 8) | (0x56 << 16) = 0x563412
      expect(arr[1]).toBe(0x563412);
    });

    test('cursor cell receives FLAG_IS_CURSOR_CELL when block-style cursor visible', async () => {
      const canvas = document.createElement('canvas');
      const r = await WebGL2Renderer.create(canvas, { cursorStyle: 'block' });
      r.resize(2, 1);
      // Force cursor blink to "visible" deterministically.
      (r as any).cursorBlink_.setEnabled(false);
      const cell = fakeCell();
      const buf = {
        getLine: () => [cell, cell],
        getCursor: () => ({ x: 1, y: 0, visible: true }),
        getDimensions: () => ({ cols: 2, rows: 1 }),
        isRowDirty: () => false,
        clearDirty: () => {},
      };
      const arr = (r as any).encodeCells(buf, 0);
      const FLAG_IS_CURSOR_CELL = 1 << 14;
      expect((arr[4] & FLAG_IS_CURSOR_CELL) !== 0).toBe(false); // cell 0
      expect((arr[12] & FLAG_IS_CURSOR_CELL) !== 0).toBe(true); // cell 1 (cursor)
    });
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test lib/renderer-webgl.test.ts -t "encodeCells"`
Expected: FAIL — `(r as any).encodeCells` is undefined.

- [ ] **Step 3: Add cell-encoding constants and the `encodeCells` method**

In `lib/renderer-webgl.ts`, after the imports and before the `GLGlyphAtlas` class, add:

```ts
import { CellFlags } from './types';

const CELL_BYTES = 32;
const CELL_U32S = 8;

const FLAG_BOLD = 1 << 0;
const FLAG_ITALIC = 1 << 1;
const FLAG_UNDERLINE = 1 << 2;
const FLAG_STRIKETHROUGH = 1 << 3;
const FLAG_INVERSE = 1 << 4;
const FLAG_FAINT = 1 << 5;
const FLAG_INVISIBLE = 1 << 6;
const FLAG_IS_SELECTED = 1 << 7;
const FLAG_IS_HYPERLINK_HOVERED = 1 << 8;
const FLAG_IS_LINK_RANGE_HOVERED = 1 << 9;
const FLAG_USE_THEME_FG = 1 << 12;
const FLAG_USE_THEME_BG = 1 << 13;
const FLAG_IS_CURSOR_CELL = 1 << 14;
```

Add a `cellArray` field to `WebGL2Renderer`:

```ts
  private cellArray = new Uint32Array(0);
  private atlas?: GLGlyphAtlas;
```

In `resize()`, after the canvas-size block, allocate `cellArray` and create the atlas:

```ts
  resize(cols: number, rows: number): void {
    this.cols = cols;
    this.rows = rows;
    const cssW = cols * this.metrics.width;
    const cssH = rows * this.metrics.height;
    this.canvas.style.width = `${cssW}px`;
    this.canvas.style.height = `${cssH}px`;
    this.canvas.width = Math.round(cssW * this.dpr);
    this.canvas.height = Math.round(cssH * this.dpr);
    this.invalidateNext = true;

    const requiredU32s = Math.max(1, cols * rows * CELL_U32S);
    if (this.cellArray.length !== requiredU32s) {
      this.cellArray = new Uint32Array(requiredU32s);
    }

    if (!this.atlas) {
      this.atlas = new GLGlyphAtlas(
        this.gl,
        this.metrics.width,
        this.metrics.height,
        this.fontSize,
        this.fontFamily
      );
    } else {
      this.atlas.reset(this.metrics.width, this.metrics.height, this.fontSize, this.fontFamily);
    }
  }
```

Add `encodeCells` as a private method on `WebGL2Renderer` (place it just above the renderer-interface methods):

```ts
  private encodeCells(buffer: IRenderable, viewportY: number, sb?: IScrollbackProvider): Uint32Array {
    const arr = this.cellArray;
    arr.fill(0);
    const dims = buffer.getDimensions();
    const sbLen = sb?.getScrollbackLength() ?? 0;
    const cursor = buffer.getCursor();
    const sel = this.selectionManager?.getSelectionCoords() ?? null;
    const inSel = (x: number, y: number): boolean => {
      if (!sel) return false;
      if (sel.startRow === sel.endRow) {
        return y === sel.startRow && x >= sel.startCol && x <= sel.endCol;
      }
      if (y === sel.startRow) return x >= sel.startCol;
      if (y === sel.endRow) return x <= sel.endCol;
      return y > sel.startRow && y < sel.endRow;
    };

    const defaultEmptyFlags = (FLAG_USE_THEME_FG | FLAG_USE_THEME_BG) >>> 0;
    const cellW = this.metrics.width;
    const cellH = this.metrics.height;
    for (let y = 0; y < dims.rows; y++) {
      let line: ReturnType<IRenderable['getLine']> = null;
      if (viewportY > 0) {
        if (y < viewportY && sb) {
          const off = sbLen - Math.floor(viewportY) + y;
          line = sb.getScrollbackLine(off);
        } else {
          line = buffer.getLine(y - Math.floor(viewportY));
        }
      } else {
        line = buffer.getLine(y);
      }
      let pendingRightHalf: {
        slotU: number;
        slotV: number;
        slotH: number;
        fgPacked: number;
        bgPacked: number;
        flags: number;
      } | null = null;
      for (let x = 0; x < dims.cols; x++) {
        const i = (y * dims.cols + x) * CELL_U32S;
        const c = line && x < line.length ? line[x] : null;
        if (!c || c.width === 0) {
          if (pendingRightHalf) {
            arr[i + 0] = pendingRightHalf.fgPacked;
            arr[i + 1] = pendingRightHalf.bgPacked;
            arr[i + 2] =
              ((pendingRightHalf.slotU + cellW) & 0xffff) |
              ((pendingRightHalf.slotV & 0xffff) << 16);
            arr[i + 3] = (cellW & 0xffff) | ((pendingRightHalf.slotH & 0xffff) << 16);
            arr[i + 4] = pendingRightHalf.flags;
            pendingRightHalf = null;
          } else {
            arr[i + 4] = defaultEmptyFlags;
          }
          continue;
        }
        pendingRightHalf = null;
        let flags = 0;
        if (c.flags & CellFlags.BOLD) flags |= FLAG_BOLD;
        if (c.flags & CellFlags.ITALIC) flags |= FLAG_ITALIC;
        if (c.flags & CellFlags.UNDERLINE) flags |= FLAG_UNDERLINE;
        if (c.flags & CellFlags.STRIKETHROUGH) flags |= FLAG_STRIKETHROUGH;
        if (c.flags & CellFlags.INVERSE) flags |= FLAG_INVERSE;
        if (c.flags & CellFlags.FAINT) flags |= FLAG_FAINT;
        if (c.flags & CellFlags.INVISIBLE) flags |= FLAG_INVISIBLE;
        if (c.fgIsDefault) flags |= FLAG_USE_THEME_FG;
        if (c.bgIsDefault) flags |= FLAG_USE_THEME_BG;
        if (inSel(x, y)) flags |= FLAG_IS_SELECTED;
        if (c.hyperlink_id !== 0 && c.hyperlink_id === this.hoveredHyperlinkId) {
          flags |= FLAG_IS_HYPERLINK_HOVERED;
        }
        if (this.hoveredLinkRange) {
          const r = this.hoveredLinkRange;
          const inRange =
            (y === r.startY && x >= r.startX && (y < r.endY || x <= r.endX)) ||
            (y > r.startY && y < r.endY) ||
            (y === r.endY && x <= r.endX && (y > r.startY || x >= r.startX));
          if (inRange) flags |= FLAG_IS_LINK_RANGE_HOVERED;
        }
        arr[i + 0] = c.fg_r | (c.fg_g << 8) | (c.fg_b << 16);
        arr[i + 1] = c.bg_r | (c.bg_g << 8) | (c.bg_b << 16);
        const skipAtlas = (flags & FLAG_INVISIBLE) !== 0;
        if (!skipAtlas && this.atlas) {
          const grapheme =
            c.grapheme_len > 0 && buffer.getGraphemeString
              ? buffer.getGraphemeString(y, x)
              : String.fromCodePoint(c.codepoint || 32);
          const styleBits =
            (flags & FLAG_BOLD ? 1 : 0) |
            (flags & FLAG_ITALIC ? 2 : 0) |
            (flags & FLAG_FAINT ? 4 : 0);
          const widthInCells = c.width === 2 ? 2 : 1;
          const slot = this.atlas.getOrRaster(
            grapheme,
            styleBits,
            this.metrics.baseline,
            widthInCells
          );
          arr[i + 2] = (slot.u & 0xffff) | ((slot.v & 0xffff) << 16);
          arr[i + 3] =
            widthInCells === 2
              ? (cellW & 0xffff) | ((cellH & 0xffff) << 16)
              : (slot.w & 0xffff) | ((slot.h & 0xffff) << 16);
          if (widthInCells === 2) {
            pendingRightHalf = {
              slotU: slot.u,
              slotV: slot.v,
              slotH: slot.h,
              fgPacked: arr[i + 0]!,
              bgPacked: arr[i + 1]!,
              flags: 0,
            };
          }
        }
        arr[i + 4] = flags >>> 0;
        if (pendingRightHalf) pendingRightHalf.flags = flags >>> 0;
      }
    }

    if (
      cursor.visible &&
      this.cursorBlink_.isVisible() &&
      this.cursorStyle === 'block'
    ) {
      const ci = (cursor.y * dims.cols + cursor.x) * CELL_U32S;
      arr[ci + 4] = (arr[ci + 4]! | FLAG_IS_CURSOR_CELL) >>> 0;
    }
    return arr;
  }
```

Note: the test calls `(r as any).encodeCells(buf, 0)` and expects to read the returned `Uint32Array`. The implementation returns `this.cellArray` directly (no copy needed for the test).

The test "block-style cursor" disables blink with `setEnabled(false)`. The `CursorBlink.isVisible()` method must return true when blink is disabled (this is the existing behavior — verify with `lib/cursor-blink.ts` if anything looks off). If `isVisible()` returns false in that path, the test should explicitly drive blink visibility instead.

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test lib/renderer-webgl.test.ts -t "encodeCells"`
Expected: PASS — all 3 tests green.

- [ ] **Step 5: Run pre-commit gate**

Run: `bun run fmt && bun run lint && bun run typecheck && bun test`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add lib/renderer-webgl.ts lib/renderer-webgl.test.ts
git commit -m "feat(render): port encodeCells to WebGL renderer (no kitty)"
```

---

## Task 6: Palette + grid UBO byte construction

**Files:**
- Modify: `lib/renderer-webgl.ts` — add UBO byte builders + GL UBO creation/upload
- Modify: `lib/renderer-webgl.test.ts` — add UBO byte tests

The byte layouts match WebGPU exactly (384 B palette, 80 B grid). The construction code is copied verbatim; only the upload differs (`gl.bufferSubData(UNIFORM_BUFFER, ...)` instead of `device.queue.writeBuffer`). UBOs are GL buffers with `gl.UNIFORM_BUFFER` target.

- [ ] **Step 1: Write the failing tests**

Append to `lib/renderer-webgl.test.ts`:

```ts
  describe('UBO byte construction', () => {
    test('paletteUBO has 96 floats and starts with parsed ANSI black', async () => {
      const canvas = document.createElement('canvas');
      const r = await WebGL2Renderer.create(canvas, {
        theme: { black: '#0a141e' } as any,
      });
      const data = (r as any).buildPaletteUBOBytes() as Float32Array;
      expect(data.length).toBe(96);
      // ANSI[0] = black at vec4 offset 0
      expect(data[0]).toBeCloseTo(0x0a / 255, 4);
      expect(data[1]).toBeCloseTo(0x14 / 255, 4);
      expect(data[2]).toBeCloseTo(0x1e / 255, 4);
      expect(data[3]).toBe(1);
    });

    test('gridUBO is 20 u32s with cols/rows at offsets 0/1', async () => {
      const canvas = document.createElement('canvas');
      const r = await WebGL2Renderer.create(canvas, {});
      r.resize(80, 24);
      const u32 = (r as any).buildGridUBOBytes(0, { x: 0, y: 0, visible: false }) as Uint32Array;
      expect(u32.length).toBe(20);
      expect(u32[0]).toBe(80); // gridSize.x
      expect(u32[1]).toBe(24); // gridSize.y
    });

    test('gridUBO encodes cursorStyle correctly (block=0, underline=1, bar=2)', async () => {
      const canvas = document.createElement('canvas');
      const r = await WebGL2Renderer.create(canvas, { cursorStyle: 'underline' });
      r.resize(1, 1);
      const u32 = (r as any).buildGridUBOBytes(0, { x: 0, y: 0, visible: false }) as Uint32Array;
      expect(u32[8]).toBe(1);
      r.setCursorStyle('bar');
      const u32b = (r as any).buildGridUBOBytes(0, { x: 0, y: 0, visible: false }) as Uint32Array;
      expect(u32b[8]).toBe(2);
    });
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test lib/renderer-webgl.test.ts -t "UBO byte construction"`
Expected: FAIL — `buildPaletteUBOBytes` / `buildGridUBOBytes` undefined.

- [ ] **Step 3: Add UBO byte builders + GL UBO creation**

Add fields to `WebGL2Renderer`:

```ts
  private paletteUBO?: WebGLBuffer; // 384 B
  private gridUBO?: WebGLBuffer;    // 80 B
```

Add the byte builders + upload methods near the bottom of the class, before `destroy()`:

```ts
  private buildPaletteUBOBytes(): Float32Array {
    const data = new Float32Array(96);
    const w = (i: number, hex: string): void => {
      const [r, g, b] = this.parseHexColor(hex);
      data[i * 4 + 0] = r / 255;
      data[i * 4 + 1] = g / 255;
      data[i * 4 + 2] = b / 255;
      data[i * 4 + 3] = 1;
    };
    const t = this.theme;
    w(0, t.black); w(1, t.red); w(2, t.green); w(3, t.yellow);
    w(4, t.blue); w(5, t.magenta); w(6, t.cyan); w(7, t.white);
    w(8, t.brightBlack); w(9, t.brightRed); w(10, t.brightGreen); w(11, t.brightYellow);
    w(12, t.brightBlue); w(13, t.brightMagenta); w(14, t.brightCyan); w(15, t.brightWhite);
    w(16, t.foreground); w(17, t.background); w(18, t.cursor); w(19, t.cursorAccent);
    w(20, t.selectionBackground); w(21, t.selectionForeground); w(22, '#4A90E2');
    return data;
  }

  private buildGridUBOBytes(
    _viewportY: number,
    cursor: { x: number; y: number; visible: boolean }
  ): Uint32Array {
    const u32 = new Uint32Array(20);
    const f32 = new Float32Array(u32.buffer);
    u32[0] = this.cols;
    u32[1] = this.rows;
    f32[2] = this.metrics.width;
    f32[3] = this.metrics.height;
    f32[4] = this.dpr;
    u32[5] = cursor.visible && this.cursorBlink_.isVisible() ? 1 : 0;
    u32[6] = cursor.x;
    u32[7] = cursor.y;
    u32[8] = this.cursorStyle === 'block' ? 0 : this.cursorStyle === 'underline' ? 1 : 2;
    u32[9] = 0;
    u32[10] = this.atlas?.atlasSize ?? 1024;
    return u32;
  }

  private uploadPaletteUBO(): void {
    if (!this.paletteUBO) return;
    const gl = this.gl;
    const data = this.buildPaletteUBOBytes();
    gl.bindBuffer(gl.UNIFORM_BUFFER, this.paletteUBO);
    gl.bufferSubData(gl.UNIFORM_BUFFER, 0, data);
  }

  private uploadGridUBO(viewportY: number, cursor: { x: number; y: number; visible: boolean }): void {
    if (!this.gridUBO) return;
    const gl = this.gl;
    const u32 = this.buildGridUBOBytes(viewportY, cursor);
    gl.bindBuffer(gl.UNIFORM_BUFFER, this.gridUBO);
    gl.bufferSubData(gl.UNIFORM_BUFFER, 0, u32);
  }
```

In `initialize()`, after acquiring the gl context, allocate the UBOs:

```ts
    this.paletteUBO = gl.createBuffer() ?? undefined;
    if (!this.paletteUBO) throw new Error('WebGL2Renderer: createBuffer failed (paletteUBO)');
    gl.bindBuffer(gl.UNIFORM_BUFFER, this.paletteUBO);
    gl.bufferData(gl.UNIFORM_BUFFER, 384, gl.DYNAMIC_DRAW);

    this.gridUBO = gl.createBuffer() ?? undefined;
    if (!this.gridUBO) throw new Error('WebGL2Renderer: createBuffer failed (gridUBO)');
    gl.bindBuffer(gl.UNIFORM_BUFFER, this.gridUBO);
    gl.bufferData(gl.UNIFORM_BUFFER, 80, gl.DYNAMIC_DRAW);

    // Upload initial palette (theme already merged in constructor).
    // Note: we have to do this AFTER the buffer is created.
    {
      const data = this.buildPaletteUBOBytes();
      gl.bindBuffer(gl.UNIFORM_BUFFER, this.paletteUBO);
      gl.bufferSubData(gl.UNIFORM_BUFFER, 0, data);
    }
```

In `setTheme()`, after updating `this.theme`, call `this.uploadPaletteUBO()`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test lib/renderer-webgl.test.ts -t "UBO byte construction"`
Expected: PASS — all 3 tests green.

- [ ] **Step 5: Run pre-commit gate**

Run: `bun run fmt && bun run lint && bun run typecheck && bun test`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add lib/renderer-webgl.ts lib/renderer-webgl.test.ts
git commit -m "feat(render): WebGL palette + grid UBO byte builders"
```

---

## Task 7: Cell texture allocation + per-frame upload

**Files:**
- Modify: `lib/renderer-webgl.ts` — add cell texture state + upload in render()
- Modify: `lib/renderer-webgl.test.ts` — add cell-texture upload test

A 2D `RGBA32UI` texture sized `(cols * 2, rows)` holds the packed cell data. `texStorage2D` allocates immutable storage at resize; `texSubImage2D` uploads `cellArray` per frame. The fragment shader (Task 8) will `texelFetch` it.

- [ ] **Step 1: Write the failing test**

Append to `lib/renderer-webgl.test.ts`:

```ts
  describe('cell texture upload', () => {
    test('render() allocates RGBA32UI cell texture sized (cols*2, rows)', async () => {
      const canvas = document.createElement('canvas');
      const r = await WebGL2Renderer.create(canvas, {});
      const stub = getStub();
      r.resize(40, 12);
      // Look for a texStorage2D with internalFormat = RGBA32UI = 0x8d70
      const ts = stub.calls.find(
        (c) => c.method === 'texStorage2D' && (c.args[2] as number) === 0x8d70
      );
      expect(ts).toBeDefined();
      expect(ts!.args[3]).toBe(40 * 2); // width
      expect(ts!.args[4]).toBe(12);     // height
    });

    test('render() uploads cellArray bytes via texSubImage2D', async () => {
      const canvas = document.createElement('canvas');
      const r = await WebGL2Renderer.create(canvas, {});
      r.resize(2, 1);
      const stub = getStub();
      const before = stub.countCalls('texSubImage2D');
      const cell = {
        codepoint: 0x41, width: 1, flags: 0,
        fg_r: 0, fg_g: 0, fg_b: 0, bg_r: 0, bg_g: 0, bg_b: 0,
        fgIsDefault: false, bgIsDefault: false,
        hyperlink_id: 0, grapheme_len: 0,
      };
      const buf = {
        getLine: () => [cell, cell],
        getCursor: () => ({ x: 0, y: 0, visible: false }),
        getDimensions: () => ({ cols: 2, rows: 1 }),
        isRowDirty: () => false,
        clearDirty: () => {},
      };
      r.render(buf as any, 0);
      // At least one texSubImage2D call beyond the atlas's glyph upload.
      // Cell-texture upload uses format = RGBA_INTEGER = 0x8d99; filter for
      // those specifically.
      const cellUploads = stub.calls.filter(
        (c) => c.method === 'texSubImage2D' && c.args.includes(0x8d99)
      );
      expect(cellUploads.length).toBeGreaterThan(0);
    });
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test lib/renderer-webgl.test.ts -t "cell texture upload"`
Expected: FAIL — neither call is yet made; render() is still clear-only.

- [ ] **Step 3: Add cell texture state + upload**

Add fields to `WebGL2Renderer`:

```ts
  private cellTex?: WebGLTexture;
  private cellTexW = 0;
  private cellTexH = 0;
```

In `resize()`, after the cellArray block, allocate or re-allocate the cell texture:

```ts
    const desiredW = Math.max(1, cols * 2);
    const desiredH = Math.max(1, rows);
    if (!this.cellTex || this.cellTexW !== desiredW || this.cellTexH !== desiredH) {
      if (this.cellTex) gl.deleteTexture(this.cellTex);
      const tex = this.gl.createTexture();
      if (!tex) throw new Error('WebGL2Renderer: cellTex createTexture failed');
      this.cellTex = tex;
      this.cellTexW = desiredW;
      this.cellTexH = desiredH;
      this.gl.bindTexture(this.gl.TEXTURE_2D, tex);
      this.gl.texStorage2D(this.gl.TEXTURE_2D, 1, this.gl.RGBA32UI, desiredW, desiredH);
      // Integer textures must use NEAREST filters.
      this.gl.texParameteri(this.gl.TEXTURE_2D, this.gl.TEXTURE_MIN_FILTER, this.gl.NEAREST);
      this.gl.texParameteri(this.gl.TEXTURE_2D, this.gl.TEXTURE_MAG_FILTER, this.gl.NEAREST);
      this.gl.texParameteri(this.gl.TEXTURE_2D, this.gl.TEXTURE_WRAP_S, this.gl.CLAMP_TO_EDGE);
      this.gl.texParameteri(this.gl.TEXTURE_2D, this.gl.TEXTURE_WRAP_T, this.gl.CLAMP_TO_EDGE);
    }
```

(Hoist `gl` to a local at top of `resize()` to avoid the verbose `this.gl.` repetition: `const gl = this.gl;`.)

Replace the body of `render()` with:

```ts
  render(buffer: IRenderable, viewportY: number = 0, sb?: IScrollbackProvider): void {
    if (this.cols === 0 || this.rows === 0) return;
    const gl = this.gl;
    const cursor = buffer.getCursor();
    this.encodeCells(buffer, viewportY, sb);
    this.uploadGridUBO(viewportY, cursor);

    // Upload cell texture.
    if (this.cellTex) {
      gl.bindTexture(gl.TEXTURE_2D, this.cellTex);
      gl.pixelStorei(/* UNPACK_ALIGNMENT */ 0x0cf5, 1);
      gl.texSubImage2D(
        gl.TEXTURE_2D,
        0,
        0,
        0,
        this.cellTexW,
        this.cellTexH,
        gl.RGBA_INTEGER,
        gl.UNSIGNED_INT,
        this.cellArray
      );
    }

    // Clear (text + cursor passes added in T9 / T11).
    const [r, g, b] = this.parseHexColor(this.theme.background);
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.clearColor(r / 255, g / 255, b / 255, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);

    buffer.clearDirty();
    this.invalidateNext = false;
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test lib/renderer-webgl.test.ts -t "cell texture upload"`
Expected: PASS — both tests green.

- [ ] **Step 5: Run pre-commit gate**

Run: `bun run fmt && bun run lint && bun run typecheck && bun test`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add lib/renderer-webgl.ts lib/renderer-webgl.test.ts
git commit -m "feat(render): WebGL cell texture allocation and per-frame upload"
```

---

## Task 8: Text shader source + program creation

**Files:**
- Modify: `lib/renderer-webgl.ts` — add `TEXT_VS` / `TEXT_FS` GLSL ES 3.00 sources, `createProgram` helper, text-program creation in `initialize()`
- Modify: `lib/renderer-webgl.test.ts` — add text-program creation test

GLSL ES 3.00 shaders that mirror `TEXT_SHADER` from `renderer-webgpu.ts:39-307`, minus the kitty branch (lines 80-95, 116-136, 243-252) and minus the procedural block-element branch (lines 138-176, 254-264). UBO layouts use std140 with explicit padding to match the WebGPU 80-byte / 384-byte byte layouts.

- [ ] **Step 1: Write the failing test**

Append to `lib/renderer-webgl.test.ts`:

```ts
  describe('text program', () => {
    test('initialize() compiles vertex+fragment shaders and links the text program', async () => {
      const canvas = document.createElement('canvas');
      await WebGL2Renderer.create(canvas, {});
      const stub = getStub();
      // Two compileShader calls (vs+fs) for the text program — and Task 10
      // adds two more for the cursor program. After Task 8 specifically we
      // expect at least 2 compileShader and at least 1 linkProgram.
      expect(stub.countCalls('compileShader')).toBeGreaterThanOrEqual(2);
      expect(stub.countCalls('linkProgram')).toBeGreaterThanOrEqual(1);
    });

    test('text program binds GridUBO/PaletteUBO blocks and texture samplers', async () => {
      const canvas = document.createElement('canvas');
      await WebGL2Renderer.create(canvas, {});
      const stub = getStub();
      // We expect at minimum: lookups for "GridUBO" and "PaletteUBO" block
      // indices, and uniform locations for "uCellTex" and "uAtlasTex".
      const blockNames = stub.calls
        .filter((c) => c.method === 'getUniformBlockIndex')
        .map((c) => c.args[1]);
      expect(blockNames).toContain('GridUBO');
      expect(blockNames).toContain('PaletteUBO');
      const uniformNames = stub.calls
        .filter((c) => c.method === 'getUniformLocation')
        .map((c) => c.args[1]);
      expect(uniformNames).toContain('uCellTex');
      expect(uniformNames).toContain('uAtlasTex');
    });
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test lib/renderer-webgl.test.ts -t "text program"`
Expected: FAIL — no shader compilation yet.

- [ ] **Step 3: Add shader sources, compile/link helper, and program creation**

In `lib/renderer-webgl.ts`, add at the top (after the FLAG constants):

```ts
const GRID_UBO_GLSL = `
layout(std140) uniform GridUBO {
  uvec2 gridSize;
  vec2 cellSize;
  float dpr;
  uint cursorVisible;
  uvec2 cursorPos;
  uint cursorStyle;
  float _pad0;
  uint atlasSize;
  uint _r1; uint _r2; uint _r3; uint _r4;
  uint _r5; uint _r6; uint _r7; uint _r8; uint _r9;
} grid;
`;

const PALETTE_UBO_GLSL = `
layout(std140) uniform PaletteUBO {
  vec4 ansi[16];
  vec4 defaultFg;
  vec4 defaultBg;
  vec4 cursorBg;
  vec4 cursorFg;
  vec4 selectionBg;
  vec4 selectionFg;
  vec4 linkUnderlineColor;
  vec4 _pad;
} pal;
`;

const TEXT_VS = `#version 300 es
precision highp float;
precision highp int;
${GRID_UBO_GLSL}
out vec2 vUv;
flat out int vCellIdx;
const vec2 CORNERS[6] = vec2[6](
  vec2(0.0, 0.0), vec2(1.0, 0.0), vec2(1.0, 1.0),
  vec2(0.0, 0.0), vec2(1.0, 1.0), vec2(0.0, 1.0)
);
void main() {
  uint col = uint(gl_InstanceID) % grid.gridSize.x;
  uint row = uint(gl_InstanceID) / grid.gridSize.x;
  vec2 local = CORNERS[gl_VertexID];
  float cssX = (float(col) + local.x) * grid.cellSize.x;
  float cssY = (float(row) + local.y) * grid.cellSize.y;
  float canvasW = float(grid.gridSize.x) * grid.cellSize.x;
  float canvasH = float(grid.gridSize.y) * grid.cellSize.y;
  float ndcX = (cssX / canvasW) * 2.0 - 1.0;
  float ndcY = 1.0 - (cssY / canvasH) * 2.0;
  gl_Position = vec4(ndcX, ndcY, 0.0, 1.0);
  vUv = local;
  vCellIdx = gl_InstanceID;
}
`;

const TEXT_FS = `#version 300 es
precision highp float;
precision highp int;
precision highp usampler2D;
${GRID_UBO_GLSL}
${PALETTE_UBO_GLSL}
const uint FLAG_UNDERLINE = 1u << 2;
const uint FLAG_STRIKETHROUGH = 1u << 3;
const uint FLAG_INVERSE = 1u << 4;
const uint FLAG_FAINT = 1u << 5;
const uint FLAG_INVISIBLE = 1u << 6;
const uint FLAG_IS_SELECTED = 1u << 7;
const uint FLAG_IS_HYPERLINK_HOVERED = 1u << 8;
const uint FLAG_IS_LINK_RANGE_HOVERED = 1u << 9;
const uint FLAG_USE_THEME_FG = 1u << 12;
const uint FLAG_USE_THEME_BG = 1u << 13;
const uint FLAG_IS_CURSOR_CELL = 1u << 14;
uniform highp usampler2D uCellTex;
uniform sampler2D uAtlasTex;
in vec2 vUv;
flat in int vCellIdx;
out vec4 fragColor;
vec3 unpackRgb(uint p) {
  float r = float(p & 0xffu) / 255.0;
  float g = float((p >> 8) & 0xffu) / 255.0;
  float b = float((p >> 16) & 0xffu) / 255.0;
  return vec3(r, g, b);
}
void main() {
  int cellX = vCellIdx % int(grid.gridSize.x);
  int cellY = vCellIdx / int(grid.gridSize.x);
  uvec4 c0 = texelFetch(uCellTex, ivec2(cellX * 2 + 0, cellY), 0);
  uvec4 c1 = texelFetch(uCellTex, ivec2(cellX * 2 + 1, cellY), 0);
  uint cellFg = c0.x;
  uint cellBg = c0.y;
  uint atlasUV = c0.z;
  uint atlasSize = c0.w;
  uint flags = c1.x;
  vec3 fg = unpackRgb(cellFg);
  vec3 bg = unpackRgb(cellBg);
  if ((flags & FLAG_USE_THEME_FG) != 0u) fg = pal.defaultFg.rgb;
  if ((flags & FLAG_USE_THEME_BG) != 0u) bg = pal.defaultBg.rgb;
  if ((flags & FLAG_INVERSE) != 0u) { vec3 tmp = fg; fg = bg; bg = tmp; }
  if ((flags & FLAG_IS_SELECTED) != 0u) { bg = pal.selectionBg.rgb; fg = pal.selectionFg.rgb; }
  if ((flags & FLAG_IS_CURSOR_CELL) != 0u) { bg = pal.cursorBg.rgb; fg = pal.cursorFg.rgb; }
  if ((flags & FLAG_INVISIBLE) != 0u) { fragColor = vec4(bg, 1.0); return; }
  vec2 auv = vec2(float(atlasUV & 0xffffu), float((atlasUV >> 16) & 0xffffu));
  vec2 asz = vec2(float(atlasSize & 0xffffu), float((atlasSize >> 16) & 0xffffu));
  vec2 texCoord = (auv + vUv * asz) / float(grid.atlasSize);
  float mask = textureLod(uAtlasTex, texCoord, 0.0).a;
  float alpha = (flags & FLAG_FAINT) != 0u ? mask * 0.5 : mask;
  vec3 outRgb = mix(bg, fg, alpha);
  float baselineFrac = 0.85;
  float underlineThickness = 1.0 / grid.cellSize.y;
  bool hoverActive = (flags & (FLAG_IS_HYPERLINK_HOVERED | FLAG_IS_LINK_RANGE_HOVERED)) != 0u;
  if (hoverActive && vUv.y >= baselineFrac && vUv.y < baselineFrac + underlineThickness * 2.0) {
    fragColor = pal.linkUnderlineColor; return;
  }
  if ((flags & FLAG_UNDERLINE) != 0u && vUv.y >= baselineFrac && vUv.y < baselineFrac + underlineThickness * 2.0) {
    fragColor = vec4(fg, 1.0); return;
  }
  if ((flags & FLAG_STRIKETHROUGH) != 0u && abs(vUv.y - 0.5) < underlineThickness) {
    fragColor = vec4(fg, 1.0); return;
  }
  fragColor = vec4(outRgb, 1.0);
}
`;
```

Add the compile/link helper and program-state fields:

```ts
  private textProgram?: WebGLProgram;
  private textProgramUniforms = {
    cellTex: null as WebGLUniformLocation | null,
    atlasTex: null as WebGLUniformLocation | null,
  };

  private compileShader(source: string, type: number, label: string): WebGLShader {
    const gl = this.gl;
    const sh = gl.createShader(type);
    if (!sh) throw new Error(`compileShader(${label}): createShader failed`);
    gl.shaderSource(sh, source);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      const info = gl.getShaderInfoLog(sh) ?? '<no info log>';
      gl.deleteShader(sh);
      throw new Error(`compileShader(${label}) failed: ${info}`);
    }
    return sh;
  }

  private buildProgram(vs: string, fs: string, label: string): WebGLProgram {
    const gl = this.gl;
    const vsObj = this.compileShader(vs, gl.VERTEX_SHADER, `${label}.vs`);
    const fsObj = this.compileShader(fs, gl.FRAGMENT_SHADER, `${label}.fs`);
    const prog = gl.createProgram();
    if (!prog) throw new Error(`buildProgram(${label}): createProgram failed`);
    gl.attachShader(prog, vsObj);
    gl.attachShader(prog, fsObj);
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      const info = gl.getProgramInfoLog(prog) ?? '<no info log>';
      gl.deleteProgram(prog);
      throw new Error(`buildProgram(${label}) link failed: ${info}`);
    }
    gl.deleteShader(vsObj);
    gl.deleteShader(fsObj);
    return prog;
  }
```

Add a `setupTextProgram` method, called from `initialize()` after the UBO setup:

```ts
  private setupTextProgram(): void {
    const gl = this.gl;
    const prog = this.buildProgram(TEXT_VS, TEXT_FS, 'text');
    this.textProgram = prog;
    // UBO bindings: index 0 = grid, index 1 = palette.
    const gridIdx = gl.getUniformBlockIndex(prog, 'GridUBO');
    const palIdx = gl.getUniformBlockIndex(prog, 'PaletteUBO');
    gl.uniformBlockBinding(prog, gridIdx, 0);
    gl.uniformBlockBinding(prog, palIdx, 1);
    // Texture-sampler uniform locations.
    this.textProgramUniforms.cellTex = gl.getUniformLocation(prog, 'uCellTex');
    this.textProgramUniforms.atlasTex = gl.getUniformLocation(prog, 'uAtlasTex');
    // Bind sampler texture units (0 = cellTex, 1 = atlasTex).
    gl.useProgram(prog);
    gl.uniform1i(this.textProgramUniforms.cellTex, 0);
    gl.uniform1i(this.textProgramUniforms.atlasTex, 1);
  }
```

Call it from `initialize()` after the UBO blocks:

```ts
    this.setupTextProgram();
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test lib/renderer-webgl.test.ts -t "text program"`
Expected: PASS — both tests green.

- [ ] **Step 5: Run pre-commit gate**

Run: `bun run fmt && bun run lint && bun run typecheck && bun test`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add lib/renderer-webgl.ts lib/renderer-webgl.test.ts
git commit -m "feat(render): WebGL text shaders + program (GLSL ES 3.00)"
```

---

## Task 9: Text-program render path — drawArraysInstanced

**Files:**
- Modify: `lib/renderer-webgl.ts` — wire bindings + draw in `render()`
- Modify: `lib/renderer-webgl.test.ts` — add draw test

After uploading cell texture and UBOs, bind the text program, bind UBOs at indices 0 and 1, bind cell texture at TEXTURE0 and atlas at TEXTURE1, then `drawArraysInstanced(TRIANGLES, 0, 6, cols*rows)`.

- [ ] **Step 1: Write the failing test**

Append to `lib/renderer-webgl.test.ts`:

```ts
  describe('text-program render path', () => {
    test('render() issues drawArraysInstanced with instanceCount = cols*rows', async () => {
      const canvas = document.createElement('canvas');
      const r = await WebGL2Renderer.create(canvas, {});
      r.resize(20, 5);
      const stub = getStub();
      stub.calls.length = 0; // clear init calls
      const buf = {
        getLine: () => null,
        getCursor: () => ({ x: 0, y: 0, visible: false }),
        getDimensions: () => ({ cols: 20, rows: 5 }),
        isRowDirty: () => false,
        clearDirty: () => {},
      };
      r.render(buf as any, 0);
      const draws = stub.calls.filter((c) => c.method === 'drawArraysInstanced');
      expect(draws.length).toBe(1);
      const args = draws[0]!.args;
      expect(args[0]).toBe(stub.TRIANGLES);
      expect(args[1]).toBe(0);
      expect(args[2]).toBe(6);
      expect(args[3]).toBe(20 * 5);
    });

    test('render() binds gridUBO and paletteUBO via bindBufferBase', async () => {
      const canvas = document.createElement('canvas');
      const r = await WebGL2Renderer.create(canvas, {});
      r.resize(2, 2);
      const stub = getStub();
      stub.calls.length = 0;
      const buf = {
        getLine: () => null,
        getCursor: () => ({ x: 0, y: 0, visible: false }),
        getDimensions: () => ({ cols: 2, rows: 2 }),
        isRowDirty: () => false,
        clearDirty: () => {},
      };
      r.render(buf as any, 0);
      const baseBindings = stub.calls
        .filter((c) => c.method === 'bindBufferBase')
        .map((c) => c.args[1] as number); // index slot
      expect(baseBindings).toContain(0); // gridUBO
      expect(baseBindings).toContain(1); // paletteUBO
    });
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test lib/renderer-webgl.test.ts -t "text-program render path"`
Expected: FAIL — render() does not yet draw.

- [ ] **Step 3: Wire the text-program draw**

A VAO is needed because WebGL2 requires one to be bound for any draw call. Add a field and create it once:

```ts
  private vao?: WebGLVertexArrayObject;
```

In `initialize()`, after `setupTextProgram()`:

```ts
    const vao = gl.createVertexArray();
    if (!vao) throw new Error('WebGL2Renderer: createVertexArray failed');
    this.vao = vao;
```

Modify `render()` to perform the text draw after the cell-texture upload, just before the existing clear:

```ts
  render(buffer: IRenderable, viewportY: number = 0, sb?: IScrollbackProvider): void {
    if (this.cols === 0 || this.rows === 0) return;
    const gl = this.gl;
    const cursor = buffer.getCursor();
    this.encodeCells(buffer, viewportY, sb);
    this.uploadGridUBO(viewportY, cursor);

    // Cell texture upload.
    if (this.cellTex) {
      gl.bindTexture(gl.TEXTURE_2D, this.cellTex);
      gl.pixelStorei(0x0cf5, 1);
      gl.texSubImage2D(
        gl.TEXTURE_2D, 0, 0, 0,
        this.cellTexW, this.cellTexH,
        gl.RGBA_INTEGER, gl.UNSIGNED_INT, this.cellArray
      );
    }

    // Clear default framebuffer.
    const [tr, tg, tb] = this.parseHexColor(this.theme.background);
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.clearColor(tr / 255, tg / 255, tb / 255, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);

    // Text pass.
    if (this.textProgram && this.vao && this.cellTex && this.atlas && this.gridUBO && this.paletteUBO) {
      gl.useProgram(this.textProgram);
      gl.bindVertexArray(this.vao);
      gl.bindBufferBase(gl.UNIFORM_BUFFER, 0, this.gridUBO);
      gl.bindBufferBase(gl.UNIFORM_BUFFER, 1, this.paletteUBO);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.cellTex);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, this.atlas.glTexture());
      gl.disable(gl.BLEND); // text pass overwrites
      gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, this.cols * this.rows);
    }

    buffer.clearDirty();
    this.invalidateNext = false;
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test lib/renderer-webgl.test.ts -t "text-program render path"`
Expected: PASS — both tests green.

- [ ] **Step 5: Run pre-commit gate**

Run: `bun run fmt && bun run lint && bun run typecheck && bun test`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add lib/renderer-webgl.ts lib/renderer-webgl.test.ts
git commit -m "feat(render): WebGL text-program render path"
```

---

## Task 10: Cursor shader source + program

**Files:**
- Modify: `lib/renderer-webgl.ts` — add `CURSOR_VS` / `CURSOR_FS` GLSL sources + `cursorProgram` setup
- Modify: `lib/renderer-webgl.test.ts` — assert cursor program compiled

The cursor shader mirrors `CURSOR_SHADER` in `renderer-webgpu.ts:313-378`. It is a single quad (no instancing) at the cursor position; the fragment paints based on `grid.cursorVisible` and `grid.cursorStyle` (1 = underline, 2 = bar; 0 is block, handled by the text pass and emits transparent).

- [ ] **Step 1: Write the failing test**

Append to `lib/renderer-webgl.test.ts`:

```ts
  describe('cursor program', () => {
    test('initialize() compiles + links cursor program (vs/fs pair)', async () => {
      const canvas = document.createElement('canvas');
      await WebGL2Renderer.create(canvas, {});
      const stub = getStub();
      // After Tasks 8 + 10: 2 programs total → 4 compileShader, 2 linkProgram.
      expect(stub.countCalls('compileShader')).toBeGreaterThanOrEqual(4);
      expect(stub.countCalls('linkProgram')).toBeGreaterThanOrEqual(2);
    });
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test lib/renderer-webgl.test.ts -t "cursor program"`
Expected: FAIL — only one program is currently created.

- [ ] **Step 3: Add cursor shader sources + program**

Append to the GLSL constants block:

```ts
const CURSOR_VS = `#version 300 es
precision highp float;
precision highp int;
${GRID_UBO_GLSL}
out vec2 vUv;
const vec2 CORNERS[6] = vec2[6](
  vec2(0.0, 0.0), vec2(1.0, 0.0), vec2(1.0, 1.0),
  vec2(0.0, 0.0), vec2(1.0, 1.0), vec2(0.0, 1.0)
);
void main() {
  vec2 local = CORNERS[gl_VertexID];
  float cssX = (float(grid.cursorPos.x) + local.x) * grid.cellSize.x;
  float cssY = (float(grid.cursorPos.y) + local.y) * grid.cellSize.y;
  float canvasW = float(grid.gridSize.x) * grid.cellSize.x;
  float canvasH = float(grid.gridSize.y) * grid.cellSize.y;
  gl_Position = vec4((cssX / canvasW) * 2.0 - 1.0, 1.0 - (cssY / canvasH) * 2.0, 0.0, 1.0);
  vUv = local;
}
`;

const CURSOR_FS = `#version 300 es
precision highp float;
precision highp int;
${GRID_UBO_GLSL}
${PALETTE_UBO_GLSL}
in vec2 vUv;
out vec4 fragColor;
void main() {
  if (grid.cursorVisible == 0u) { fragColor = vec4(0.0); return; }
  if (grid.cursorStyle == 0u) { fragColor = vec4(0.0); return; }
  if (grid.cursorStyle == 1u) {
    if (vUv.y >= 0.85) { fragColor = pal.cursorBg; return; }
    fragColor = vec4(0.0); return;
  }
  if (grid.cursorStyle == 2u) {
    if (vUv.x < 0.15) { fragColor = pal.cursorBg; return; }
    fragColor = vec4(0.0); return;
  }
  fragColor = vec4(0.0);
}
`;
```

Add field + setup method:

```ts
  private cursorProgram?: WebGLProgram;

  private setupCursorProgram(): void {
    const gl = this.gl;
    const prog = this.buildProgram(CURSOR_VS, CURSOR_FS, 'cursor');
    this.cursorProgram = prog;
    gl.uniformBlockBinding(prog, gl.getUniformBlockIndex(prog, 'GridUBO'), 0);
    gl.uniformBlockBinding(prog, gl.getUniformBlockIndex(prog, 'PaletteUBO'), 1);
  }
```

Call it from `initialize()` after `setupTextProgram()`:

```ts
    this.setupCursorProgram();
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test lib/renderer-webgl.test.ts -t "cursor program"`
Expected: PASS

- [ ] **Step 5: Run pre-commit gate**

Run: `bun run fmt && bun run lint && bun run typecheck && bun test`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add lib/renderer-webgl.ts lib/renderer-webgl.test.ts
git commit -m "feat(render): WebGL cursor shaders + program"
```

---

## Task 11: Cursor render path + cursor-blink wiring

**Files:**
- Modify: `lib/renderer-webgl.ts` — add cursor draw in `render()`
- Modify: `lib/renderer-webgl.test.ts` — assert cursor draw is invoked iff visible AND non-block

After the text pass, draw the cursor if `cursor.visible && cursorBlink_.isVisible() && cursorStyle !== 'block'`. The cursor needs alpha blending (its fragment emits `vec4(0)` outside the cursor stripe and `pal.cursorBg` inside). For block cursors, the text pass already handles inversion via `FLAG_IS_CURSOR_CELL`.

- [ ] **Step 1: Write the failing test**

Append to `lib/renderer-webgl.test.ts`:

```ts
  describe('cursor render path', () => {
    test('non-block visible cursor: drawArrays(TRIANGLES, 0, 6) is called once', async () => {
      const canvas = document.createElement('canvas');
      const r = await WebGL2Renderer.create(canvas, { cursorStyle: 'underline' });
      r.resize(2, 1);
      // Disable blink so isVisible() returns true deterministically.
      (r as any).cursorBlink_.setEnabled(false);
      const stub = getStub();
      stub.calls.length = 0;
      const buf = {
        getLine: () => null,
        getCursor: () => ({ x: 0, y: 0, visible: true }),
        getDimensions: () => ({ cols: 2, rows: 1 }),
        isRowDirty: () => false,
        clearDirty: () => {},
      };
      r.render(buf as any, 0);
      const cursorDraws = stub.calls.filter(
        (c) => c.method === 'drawArrays' && (c.args[2] as number) === 6
      );
      expect(cursorDraws.length).toBe(1);
    });

    test('block cursor: no drawArrays (block handled by text pass)', async () => {
      const canvas = document.createElement('canvas');
      const r = await WebGL2Renderer.create(canvas, { cursorStyle: 'block' });
      r.resize(2, 1);
      (r as any).cursorBlink_.setEnabled(false);
      const stub = getStub();
      stub.calls.length = 0;
      const buf = {
        getLine: () => null,
        getCursor: () => ({ x: 0, y: 0, visible: true }),
        getDimensions: () => ({ cols: 2, rows: 1 }),
        isRowDirty: () => false,
        clearDirty: () => {},
      };
      r.render(buf as any, 0);
      const cursorDraws = stub.calls.filter((c) => c.method === 'drawArrays');
      expect(cursorDraws.length).toBe(0);
    });

    test('hidden cursor: no drawArrays', async () => {
      const canvas = document.createElement('canvas');
      const r = await WebGL2Renderer.create(canvas, { cursorStyle: 'underline' });
      r.resize(2, 1);
      (r as any).cursorBlink_.setEnabled(false);
      const stub = getStub();
      stub.calls.length = 0;
      const buf = {
        getLine: () => null,
        getCursor: () => ({ x: 0, y: 0, visible: false }),
        getDimensions: () => ({ cols: 2, rows: 1 }),
        isRowDirty: () => false,
        clearDirty: () => {},
      };
      r.render(buf as any, 0);
      const cursorDraws = stub.calls.filter((c) => c.method === 'drawArrays');
      expect(cursorDraws.length).toBe(0);
    });
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test lib/renderer-webgl.test.ts -t "cursor render path"`
Expected: FAIL — render() never calls drawArrays.

- [ ] **Step 3: Add cursor draw to `render()`**

Modify `render()`, immediately after the text pass:

```ts
    // Cursor pass — only for non-block styles. Block cursor is handled by the
    // text pass via FLAG_IS_CURSOR_CELL.
    if (
      this.cursorProgram &&
      this.vao &&
      this.gridUBO &&
      this.paletteUBO &&
      cursor.visible &&
      this.cursorBlink_.isVisible() &&
      this.cursorStyle !== 'block'
    ) {
      gl.useProgram(this.cursorProgram);
      gl.bindVertexArray(this.vao);
      gl.bindBufferBase(gl.UNIFORM_BUFFER, 0, this.gridUBO);
      gl.bindBufferBase(gl.UNIFORM_BUFFER, 1, this.paletteUBO);
      gl.enable(gl.BLEND);
      gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      gl.blendEquation(gl.FUNC_ADD);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
      gl.disable(gl.BLEND);
    }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test lib/renderer-webgl.test.ts -t "cursor render path"`
Expected: PASS — all 3 tests green.

- [ ] **Step 5: Run pre-commit gate**

Run: `bun run fmt && bun run lint && bun run typecheck && bun test`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add lib/renderer-webgl.ts lib/renderer-webgl.test.ts
git commit -m "feat(render): WebGL cursor render path (underline, bar)"
```

---

## Task 12: Setters that need re-uploads + lifecycle

**Files:**
- Modify: `lib/renderer-webgl.ts` — make `setTheme` re-upload the palette UBO; make font/theme setters re-allocate the atlas

The skeleton's setters set fields and `invalidateNext = true`, which is enough for theme changes that only affect cells (selection, link colors). But for theme changes that affect the palette UBO (`defaultFg`, `defaultBg`, etc.), we must call `uploadPaletteUBO()`. Font changes must re-allocate the atlas.

- [ ] **Step 1: Write the failing test**

Append to `lib/renderer-webgl.test.ts`:

```ts
  describe('setters', () => {
    test('setTheme triggers a paletteUBO upload', async () => {
      const canvas = document.createElement('canvas');
      const r = await WebGL2Renderer.create(canvas, {});
      const stub = getStub();
      const before = stub.calls.filter(
        (c) => c.method === 'bufferSubData' && (c.args[0] as number) === stub.UNIFORM_BUFFER
      ).length;
      r.setTheme({ background: '#abcdef' } as any);
      const after = stub.calls.filter(
        (c) => c.method === 'bufferSubData' && (c.args[0] as number) === stub.UNIFORM_BUFFER
      ).length;
      expect(after).toBeGreaterThan(before);
    });

    test('setFontSize resets the atlas', async () => {
      const canvas = document.createElement('canvas');
      const r = await WebGL2Renderer.create(canvas, { fontSize: 14 });
      r.resize(4, 2);
      const atlasBefore = (r as any).atlas;
      r.setFontSize(20);
      // Same instance, but reset.
      expect((r as any).atlas).toBe(atlasBefore);
      // We don't have a direct cache-cleared probe, so verify the metric
      // change propagated.
      const m = r.getMetrics();
      expect(m.height).toBeGreaterThan(0);
    });
  });
```

- [ ] **Step 2: Run tests to verify they fail (or pass already)**

Run: `bun test lib/renderer-webgl.test.ts -t "setters"`
Expected: probably FAIL — `setTheme` does not yet call `uploadPaletteUBO`.

- [ ] **Step 3: Update setters**

Replace the existing `setTheme`, `setFontSize`, `setFontFamily`, `remeasureFont` bodies with:

```ts
  setTheme(theme: ITheme): void {
    this.theme = { ...DEFAULT_THEME, ...theme };
    this.uploadPaletteUBO();
    this.invalidateNext = true;
    this.onRequestRender?.();
  }

  setFontSize(size: number): void {
    this.fontSize = size;
    this.metrics = this.measureFont();
    this.atlas?.reset(this.metrics.width, this.metrics.height, this.fontSize, this.fontFamily);
    this.invalidateNext = true;
    this.onRequestRender?.();
  }

  setFontFamily(family: string): void {
    this.fontFamily = family;
    this.metrics = this.measureFont();
    this.atlas?.reset(this.metrics.width, this.metrics.height, this.fontSize, this.fontFamily);
    this.invalidateNext = true;
    this.onRequestRender?.();
  }

  remeasureFont(): void {
    this.metrics = this.measureFont();
    this.atlas?.reset(this.metrics.width, this.metrics.height, this.fontSize, this.fontFamily);
    this.invalidateNext = true;
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test lib/renderer-webgl.test.ts -t "setters"`
Expected: PASS

- [ ] **Step 5: Run pre-commit gate**

Run: `bun run fmt && bun run lint && bun run typecheck && bun test`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add lib/renderer-webgl.ts lib/renderer-webgl.test.ts
git commit -m "feat(render): WebGL setters re-upload palette and reset atlas"
```

---

## Task 13: webglcontextlost listener API

**Files:**
- Modify: `lib/renderer-webgl.ts` — wire `addEventListener('webglcontextlost')`
- Modify: `lib/renderer-webgl.test.ts` — assert dispatching the event fires registered callbacks

Mirrors WebGPU's `onDeviceLost`. `terminal.ts` (Task 15) registers a callback that falls back to Canvas2D.

- [ ] **Step 1: Write the failing test**

Append to `lib/renderer-webgl.test.ts`:

```ts
  describe('context-loss listener', () => {
    test('dispatching webglcontextlost fires registered callback', async () => {
      const canvas = document.createElement('canvas');
      const r = await WebGL2Renderer.create(canvas, {});
      let fired = false;
      let reason = '';
      r.onContextLost((info) => {
        fired = true;
        reason = info.reason;
      });
      const ev = new Event('webglcontextlost', { cancelable: true });
      canvas.dispatchEvent(ev);
      expect(fired).toBe(true);
      expect(reason.length).toBeGreaterThanOrEqual(0); // any string ok
    });
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test lib/renderer-webgl.test.ts -t "context-loss"`
Expected: FAIL — no listener wired.

- [ ] **Step 3: Wire `webglcontextlost`**

In `initialize()`, after `this.gl = gl`, add:

```ts
    this.canvas.addEventListener('webglcontextlost', (e) => {
      if (this.destroyed) return;
      e.preventDefault();
      const info = { reason: 'webglcontextlost' };
      console.error('[ghostty-web] WebGL context lost');
      for (const fn of this.contextLostListeners) fn(info);
    });
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test lib/renderer-webgl.test.ts -t "context-loss"`
Expected: PASS

- [ ] **Step 5: Run pre-commit gate**

Run: `bun run fmt && bun run lint && bun run typecheck && bun test`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add lib/renderer-webgl.ts lib/renderer-webgl.test.ts
git commit -m "feat(render): WebGL context-lost listener API"
```

---

## Task 14: Factory wiring — explicit 'webgl' + auto chain

**Files:**
- Modify: `lib/renderer-factory.ts`
- Modify: `lib/renderer-factory.test.ts`

Replace the placeholder throw from Task 1 with the real WebGL2 instantiation. Update the `'auto'` branch so it tries WebGL after WebGPU fails or is missing, falling through to Canvas2D only when WebGL also fails.

- [ ] **Step 1: Write the failing tests**

Append to `lib/renderer-factory.test.ts`:

```ts
  test("returns WebGL2 when backend='webgl'", async () => {
    // Stub canvas.getContext('webgl2') to return a stub.
    const { installStubWebGL2 } = await import('./test-helpers-webgl');
    const { uninstall } = installStubWebGL2();
    try {
      const canvas = document.createElement('canvas');
      const r = await pickRenderer('webgl', canvas, {});
      expect(r.backend).toBe('webgl');
    } finally {
      uninstall();
    }
  });

  test("throws under 'webgl' when getContext returns null", async () => {
    const original = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (t: string) {
      if (t === 'webgl2') return null as any;
      return original.call(this, t);
    } as any;
    try {
      const canvas = document.createElement('canvas');
      await expect(pickRenderer('webgl', canvas, {})).rejects.toThrow(/webgl2/i);
    } finally {
      HTMLCanvasElement.prototype.getContext = original;
    }
  });

  test("falls through WebGPU → WebGL → Canvas2D under 'auto'", async () => {
    (navigator as any).gpu = undefined; // skip WebGPU
    const { installStubWebGL2 } = await import('./test-helpers-webgl');
    const { uninstall } = installStubWebGL2();
    try {
      const canvas = document.createElement('canvas');
      const r = await pickRenderer('auto', canvas, {});
      expect(r.backend).toBe('webgl');
    } finally {
      uninstall();
    }
  });

  test("'auto' falls back to Canvas2D when both WebGPU and WebGL are unavailable", async () => {
    (navigator as any).gpu = undefined;
    const original = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (t: string, opts?: any) {
      if (t === 'webgl2') return null as any;
      return original.call(this, t, opts);
    } as any;
    // Silence the factory's one-time warn.
    const originalWarn = console.warn;
    console.warn = () => {};
    try {
      const canvas = document.createElement('canvas');
      const r = await pickRenderer('auto', canvas, {});
      expect(r.backend).toBe('canvas2d');
    } finally {
      console.warn = originalWarn;
      HTMLCanvasElement.prototype.getContext = original;
    }
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test lib/renderer-factory.test.ts`
Expected: FAIL — factory still throws for 'webgl' and the auto chain still falls through to Canvas2D directly.

- [ ] **Step 3: Update the factory**

Replace the contents of `lib/renderer-factory.ts` with:

```ts
/**
 * Renderer factory. Resolves a RendererBackend choice into a concrete
 * Renderer instance, with auto-fallback chain WebGPU → WebGL2 → Canvas2D.
 *
 * - 'canvas2d' → CanvasRenderer
 * - 'webgpu'   → WebGPURenderer; throws if WebGPU is unavailable
 * - 'webgl'    → WebGL2Renderer; throws if WebGL2 is unavailable
 * - 'auto'     → tries WebGPU first, then WebGL2, then Canvas2D.
 *                Logs a one-line warning on each fallback (one per kind).
 */

import { CanvasRenderer } from './renderer';
import type { Renderer, RendererBackend, RendererOptions } from './renderer-types';
import { WebGPURenderer } from './renderer-webgpu';
import { WebGL2Renderer } from './renderer-webgl';

let warnedWebGPUFallback = false;
let warnedWebGLFallback = false;

async function tryWebGPU(
  canvas: HTMLCanvasElement,
  opts: RendererOptions,
  explicit: boolean
): Promise<Renderer | null> {
  const gpu = (navigator as any).gpu as
    | { requestAdapter: (opts?: any) => Promise<any> }
    | undefined;
  if (!gpu) {
    if (explicit) throw new Error('WebGPU not available in this browser');
    return null;
  }
  try {
    const adapter = await gpu.requestAdapter({ powerPreference: 'high-performance' });
    if (!adapter) {
      if (explicit) throw new Error('WebGPU adapter unavailable');
      return null;
    }
    const adapterMax = adapter.limits?.maxSampledTexturesPerShaderStage ?? 16;
    const requiredLimits: Record<string, number> = {};
    if (adapterMax >= 17) {
      requiredLimits.maxSampledTexturesPerShaderStage = Math.min(32, adapterMax);
    }
    const device = await adapter.requestDevice({ requiredLimits });
    return await WebGPURenderer.create(canvas, device, opts);
  } catch (e) {
    if (explicit) throw e;
    if (!warnedWebGPUFallback) {
      warnedWebGPUFallback = true;
      console.warn('[ghostty-web] WebGPU init failed, trying WebGL2:', e);
    }
    return null;
  }
}

async function tryWebGL(
  canvas: HTMLCanvasElement,
  opts: RendererOptions,
  explicit: boolean
): Promise<Renderer | null> {
  try {
    return await WebGL2Renderer.create(canvas, opts);
  } catch (e) {
    if (explicit) throw e;
    if (!warnedWebGLFallback) {
      warnedWebGLFallback = true;
      console.warn('[ghostty-web] WebGL2 init failed, falling back to Canvas2D:', e);
    }
    return null;
  }
}

export async function pickRenderer(
  backend: RendererBackend,
  canvas: HTMLCanvasElement,
  opts: RendererOptions
): Promise<Renderer> {
  if (backend === 'canvas2d') {
    return new CanvasRenderer(canvas, opts);
  }
  if (backend === 'webgpu') {
    const r = await tryWebGPU(canvas, opts, true);
    if (!r) throw new Error('WebGPU initialization failed');
    return r;
  }
  if (backend === 'webgl') {
    const r = await tryWebGL(canvas, opts, true);
    if (!r) throw new Error('WebGL2 initialization failed');
    return r;
  }
  // backend === 'auto'
  const wgpu = await tryWebGPU(canvas, opts, false);
  if (wgpu) return wgpu;
  const wgl = await tryWebGL(canvas, opts, false);
  if (wgl) return wgl;
  return new CanvasRenderer(canvas, opts);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test lib/renderer-factory.test.ts`
Expected: PASS — all factory tests green (existing + new).

- [ ] **Step 5: Run full suite**

Run: `bun run fmt && bun run lint && bun run typecheck && bun test`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add lib/renderer-factory.ts lib/renderer-factory.test.ts
git commit -m "feat(render): factory chain WebGPU → WebGL → Canvas2D"
```

---

## Task 15: Terminal integration — fallback chains for device-lost / context-lost

**Files:**
- Modify: `lib/terminal.ts` — extend WebGPU device-lost handler to try WebGL first, and add a symmetric WebGL context-lost handler that falls back to Canvas2D

The existing handler at `lib/terminal.ts:602-622` re-creates Canvas2D when WebGPU's device is lost. After this change, WebGPU loss tries WebGL2 first; if that also fails, falls back to Canvas2D. WebGL2 context loss falls back directly to Canvas2D.

- [ ] **Step 1: Read the current terminal device-lost handler**

Read `lib/terminal.ts:595-625`. The existing flow: `setOnRequestRender` → conditional `onDeviceLost` registration for WebGPU. We extend that block.

- [ ] **Step 2: Add the WebGL2Renderer import**

In `lib/terminal.ts`, alongside the existing `import type { WebGPURenderer } from './renderer-webgpu'`, add:

```ts
import type { WebGL2Renderer } from './renderer-webgl';
```

- [ ] **Step 3: Extract the rebind helper**

Replace the existing block at `lib/terminal.ts:599-623` with:

```ts
      // Rebind the renderer-dependent state after a fallback. Used by both
      // WebGPU device-lost and WebGL context-lost handlers.
      const swapRenderer = async (target: 'webgl' | 'canvas2d', reason: string): Promise<void> => {
        if (this.isDisposed || !this.canvas) return;
        console.warn(`[ghostty-web] renderer falling back to ${target}:`, reason);
        this.renderer?.destroy();
        try {
          this.renderer = await pickRenderer(target, this.canvas, {
            fontSize: this.options.fontSize,
            fontFamily: this.options.fontFamily,
            cursorStyle: this.options.cursorStyle,
            cursorBlink: this.options.cursorBlink,
            theme: this.options.theme,
          });
        } catch (e) {
          // If the requested target also fails, drop straight to Canvas2D.
          console.warn(`[ghostty-web] ${target} fallback failed; using canvas2d:`, e);
          this.renderer = await pickRenderer('canvas2d', this.canvas, {
            fontSize: this.options.fontSize,
            fontFamily: this.options.fontFamily,
            cursorStyle: this.options.cursorStyle,
            cursorBlink: this.options.cursorBlink,
            theme: this.options.theme,
          });
        }
        this.renderer.resize(this.cols, this.rows);
        this.renderer.setOnRequestRender(() => this.requestRender());
        if (this.selectionManager) {
          this.renderer.setSelectionManager(this.selectionManager);
        }
        this.renderer.invalidate();
        this.requestRender();
      };

      if (this.renderer && this.renderer.backend === 'webgpu') {
        (this.renderer as WebGPURenderer).onDeviceLost(async (info) => {
          // Try WebGL first; swapRenderer will fall through to Canvas2D if WebGL also fails.
          await swapRenderer('webgl', `GPU device lost (${info.reason})`);
        });
      } else if (this.renderer && this.renderer.backend === 'webgl') {
        (this.renderer as WebGL2Renderer).onContextLost(async (info) => {
          await swapRenderer('canvas2d', `WebGL context lost (${info.reason})`);
        });
      }
```

- [ ] **Step 4: Run the existing terminal/renderer tests**

Run: `bun test lib/terminal.test.ts lib/renderer-factory.test.ts`
Expected: PASS — no regressions. (No automated test exercises the device-lost path; visual verification is manual via the demo, covered in Task 16.)

- [ ] **Step 5: Run full suite + build**

Run: `bun run fmt && bun run lint && bun run typecheck && bun test && bun run build`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add lib/terminal.ts
git commit -m "feat(terminal): cascade GPU loss WebGPU → WebGL → Canvas2D"
```

---

## Task 16: Demo wiring + manual verification

**Files:**
- Modify: `demo/index.html` — accept `?renderer=webgl`

The FPS overlay in `demo/index.html` already reads `term.renderer.backend`, so the label updates automatically once `pickRenderer` is given the new string. We just need to plumb the query string through.

- [ ] **Step 1: Inspect current renderer-selection logic**

Read `demo/index.html` and find where the `renderer` option is set on `Terminal` construction (search for `'renderer'` or `renderer:`).

- [ ] **Step 2: Add `'webgl'` to the allowed query-string values**

Find the existing query-string parser (it currently accepts at minimum `'webgpu'`, `'canvas2d'`, `'auto'`). Extend the allowed set to include `'webgl'`:

```js
// Example — actual file may use a different style; keep the existing pattern.
const validBackends = new Set(['auto', 'webgpu', 'webgl', 'canvas2d']);
const requested = new URLSearchParams(window.location.search).get('renderer');
const renderer = validBackends.has(requested) ? requested : 'auto';
```

If the file uses a different conditional (e.g., `param === 'webgpu' ? 'webgpu' : 'auto'`), add a `'webgl'` branch alongside.

- [ ] **Step 3: Manual verification (browser)**

Run the dev server:

```bash
bun run dev
# In another terminal:
cd demo/server && bun run start
```

Open three URLs in sequence and verify each renders identically (text, colors, cursor blink, selection, link hover). Run `vim` or `htop` over the WebSocket PTY in each:

- `http://localhost:8000/demo/?renderer=webgpu`
- `http://localhost:8000/demo/?renderer=webgl`
- `http://localhost:8000/demo/?renderer=canvas2d`

Confirm the FPS overlay shows the correct backend name in each. The WebGL backend should NOT render kitty graphics (silent skip) and may render block-drawing characters slightly differently from WebGPU (font glyph vs procedural fillRect) — that's expected per the spec.

If any visual defect appears, capture: which URL, what text/state was on screen, and what the WebGPU version showed. Use that to file a follow-up — do not fix mid-task unless it's a crash.

- [ ] **Step 4: Run full pre-commit gate one more time**

Run: `bun run fmt && bun run lint && bun run typecheck && bun test && bun run build`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add demo/index.html
git commit -m "feat(demo): \?renderer=webgl query-string toggle"
```

---

## Verification checklist

After all 16 tasks land, verify:

- [ ] `bun test` reports all green (existing tests + new `renderer-webgl.test.ts`)
- [ ] `bun run typecheck` passes
- [ ] `bun run lint` passes
- [ ] `bun run build` produces `dist/` artifacts
- [ ] Manual: `?renderer=webgl` in the demo renders text + colors + cursor + selection + link hover correctly
- [ ] Manual: forced WebGPU loss (Chrome DevTools → Rendering → WebGL: Disable, or kill GPU process) gracefully falls back through WebGL → Canvas2D without crash
- [ ] Manual: `?renderer=auto` on a WebGPU-disabled browser (e.g., Firefox Stable) picks WebGL2

## Notes for the implementer

- **Order matters in `initialize()`.** Buffers must be created before they're bound (`bindBufferBase`); programs must exist before `uniformBlockBinding` runs against them; the cell texture is created in `resize()` (not `initialize()`) because we need the dimensions. The plan tasks above lay out the order; don't rearrange casually.
- **`gl.getError()` is not free.** Don't sprinkle it through the hot path. The compile/link helpers above check `COMPILE_STATUS` / `LINK_STATUS`, which are appropriate one-shot validations.
- **No `bun test --watch` for the GL renderer.** The stub-context tests are deterministic but if you change shaders, manual demo verification is the only way to catch visual regressions.
- **If `renderer.test.ts` tests start failing** after type-widening in Task 1, double-check that `Renderer.backend` was widened to `'webgpu' | 'webgl' | 'canvas2d'` and that no test asserts a narrowed string.
- **Atlas grow is rare in v1.** The atlas starts at 1024² which fits ~6500 unique 12×24 glyph slots. For typical terminals this is plenty. If a session ever needs to grow, the WebGL implementation re-rasterizes on next miss (vs WebGPU's `copyTextureToTexture`) — slightly worse but correct.
- **Reference for WGSL→GLSL deltas already applied in `TEXT_FS`:**
  - `let x = ...` → `<type> x = ...`
  - `(p & 0xffu)` ok in both
  - `textureSampleLevel(tex, samp, uv, 0.0)` → `textureLod(tex, uv, 0.0)` (WebGL2 has no separate sampler objects in GLSL ES 3.00; the sampler is part of the sampler2D uniform)
  - WGSL `select(a, b, cond)` → GLSL `cond ? b : a` (note arg order reversal, but in our use `select(mask, mask*0.5, FAINT)` becomes `FAINT ? mask*0.5 : mask`)
  - WGSL `array<vec2<f32>, 6>` initializer → GLSL `vec2[6](...)`
  - Storage buffer + `arrayLength` → `texelFetch` from RGBA32UI integer texture

