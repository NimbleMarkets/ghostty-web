# Renderer-swap Canvas Replacement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the WebGPU device-lost → WebGL2 → Canvas2D fallback cascade actually work by replacing the canvas DOM node before each renderer-type swap (browsers refuse to give a single `<canvas>` a second context type).

**Architecture:** Add a small `replaceCanvas(oldCanvas)` helper to `Terminal` that detaches the old canvas from its parent and creates a fresh one with copied styles. Refactor `swapRenderer` (currently broken at the second cascade hop) to: replace canvas before `pickRenderer`, re-attach the textarea-focus listeners on the new canvas, destroy the old `SelectionManager` and construct a new one for the new renderer, and add an `isSwapping` re-entrancy guard.

**Tech Stack:** TypeScript, DOM. Test runner: `bun test`. Pre-commit gate: `bun run fmt && bun run lint && bun run typecheck && bun test && bun run build`.

**Spec:** `docs/superpowers/specs/2026-05-09-renderer-swap-canvas-replacement-design.md`

---

## File Structure

| Path                   | Status | Purpose                                                                                                                                                                                                                                                                                    |
| ---------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `lib/terminal.ts`      | modify | Add `replaceCanvas(oldCanvas)` private method. Extract the inline textarea-focus listener into a reusable function. Refactor `swapRenderer(target, reason)` to call `replaceCanvas`, re-attach focus listeners, destroy + recreate `SelectionManager`, add `isSwapping` re-entrancy guard. |
| `lib/terminal.test.ts` | modify | New test cases for the `replaceCanvas` helper.                                                                                                                                                                                                                                             |

## Reference snapshots

- `lib/terminal.ts:405-409` — current canvas creation in `open()`
- `lib/terminal.ts:435-445` — current inline textarea-focus listeners (mousedown + touchend)
- `lib/terminal.ts:549-565` — current `SelectionManager` construction in `_finishOpen()`
- `lib/terminal.ts:600-655` (approximately) — current `swapRenderer` + `registerLossHandler` block
- `lib/selection-manager.ts:102-115` — `SelectionManager` constructor takes `(terminal, renderer, wasmTerm, textarea)`
- `lib/selection-manager.ts:431` — `attachEventListeners()` is called from the constructor
- `lib/selection-manager.ts:403-413` — `destroy()` correctly detaches all listeners

---

## Task CR1: `replaceCanvas` helper + tests

**Files:**

- Modify: `lib/terminal.ts` — add private `replaceCanvas` method
- Modify: `lib/terminal.test.ts` — add 6 test cases

This task is purely additive. The new method exists but isn't called yet. No behavior change. CR2 wires it into `swapRenderer`.

- [ ] **Step 1: Inspect the current `Terminal` class**

```bash
grep -n "private\|public" lib/terminal.ts | head -20
```

Find a sensible spot for a new private method — near other DOM-utility-style private methods. Reading the file briefly for spatial context is fine.

- [ ] **Step 2: Write the failing tests**

Append the following to `lib/terminal.test.ts`. If a `describe('Terminal')` block already exists, add a nested `describe('replaceCanvas', ...)`; otherwise add a new top-level describe.

```ts
import { describe, expect, test } from 'bun:test';
import { Terminal } from './terminal';

describe('Terminal.replaceCanvas', () => {
  function fabricate() {
    const parent = document.createElement('div');
    document.body.appendChild(parent);
    const canvas = document.createElement('canvas');
    canvas.style.cssText = 'display: block; cursor: text;';
    canvas.width = 800;
    canvas.height = 600;
    parent.appendChild(canvas);
    // We access the private replaceCanvas via type-erased lookup.
    // The method is logically pure with respect to Terminal state — it
    // only reads/writes DOM — so we don't need a fully-initialized Terminal.
    const term = new Terminal({});
    return { term, parent, canvas };
  }

  test('returns a fresh canvas instance (not the old one)', () => {
    const { term, canvas: oldCanvas } = fabricate();
    const fresh = (term as any).replaceCanvas(oldCanvas);
    expect(fresh).not.toBe(oldCanvas);
    expect(fresh).toBeInstanceOf(HTMLCanvasElement);
  });

  test('new canvas is attached to the same parent', () => {
    const { term, parent, canvas: oldCanvas } = fabricate();
    const fresh = (term as any).replaceCanvas(oldCanvas);
    expect(fresh.parentNode).toBe(parent);
  });

  test('old canvas is detached from its parent', () => {
    const { term, canvas: oldCanvas } = fabricate();
    (term as any).replaceCanvas(oldCanvas);
    expect(oldCanvas.parentNode).toBe(null);
  });

  test('CSS state (style.cssText) is copied to the new canvas', () => {
    const { term, canvas: oldCanvas } = fabricate();
    const fresh = (term as any).replaceCanvas(oldCanvas);
    expect(fresh.style.display).toBe('block');
    expect(fresh.style.cursor).toBe('text');
  });

  test('drawing-buffer dimensions are copied to the new canvas', () => {
    const { term, canvas: oldCanvas } = fabricate();
    const fresh = (term as any).replaceCanvas(oldCanvas);
    expect(fresh.width).toBe(800);
    expect(fresh.height).toBe(600);
  });

  test('throws when old canvas has no parent', () => {
    const { term, canvas: oldCanvas } = fabricate();
    oldCanvas.parentNode!.removeChild(oldCanvas);
    expect(() => (term as any).replaceCanvas(oldCanvas)).toThrow(/no parent/i);
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

```bash
bun test lib/terminal.test.ts -t "replaceCanvas"
```

Expected: FAIL — `replaceCanvas` is not a method on `Terminal`.

- [ ] **Step 4: Add the `replaceCanvas` method to `Terminal`**

In `lib/terminal.ts`, find the existing private methods on the `Terminal` class. Add this method (place near other DOM-related private methods, e.g. near `_finishOpen` or near other init helpers):

```ts
  /**
   * Detach the old canvas from its parent and put a fresh canvas in its
   * place with the same parent, CSS, and drawing-buffer dimensions. Used
   * by the renderer-swap path because once a `<canvas>` has been used to
   * acquire a context (webgpu / webgl2 / 2d), browsers refuse to give it
   * a different context type — so the cascade fallback needs a fresh
   * canvas to claim.
   */
  private replaceCanvas(oldCanvas: HTMLCanvasElement): HTMLCanvasElement {
    const parent = oldCanvas.parentNode;
    if (!parent) {
      throw new Error('Terminal.replaceCanvas: old canvas has no parent');
    }
    const fresh = document.createElement('canvas');
    // Copy CSS-side state. The renderer will re-set width/height (drawing
    // buffer pixels) on its first resize; we copy them too to avoid a flash
    // of zero-sized canvas in the swap window.
    fresh.style.cssText = oldCanvas.style.cssText;
    fresh.width = oldCanvas.width;
    fresh.height = oldCanvas.height;
    parent.insertBefore(fresh, oldCanvas);
    parent.removeChild(oldCanvas);
    return fresh;
  }
```

- [ ] **Step 5: Run tests to verify they pass**

```bash
bun test lib/terminal.test.ts -t "replaceCanvas"
```

Expected: 6 pass.

- [ ] **Step 6: Run full pre-commit gate**

```bash
bun run typecheck
bun test
npx prettier --write lib/terminal.ts lib/terminal.test.ts
npx prettier --check lib/terminal.ts lib/terminal.test.ts
```

Expected: typecheck green; full suite green; prettier clean.

- [ ] **Step 7: Commit**

```bash
git add lib/terminal.ts lib/terminal.test.ts
git commit -m "feat(terminal): add replaceCanvas helper for renderer-swap cascade"
```

DO NOT include unstaged docs changes. Use specific file paths in `git add`.

---

## Task CR2: Refactor `swapRenderer` to use `replaceCanvas`

**Files:**

- Modify: `lib/terminal.ts` — extract focus-textarea listener; refactor `swapRenderer`; add `isSwapping` guard

This is the substantive change. After CR2, the cascade actually works end-to-end. There are no automated tests for the swap path itself (per the spec); manual verification via Chrome DevTools is the gate.

- [ ] **Step 1: Inspect current `swapRenderer` and the textarea-focus listener**

Read `lib/terminal.ts` around line 435-445 (the inline focus listener attachment) and lines ~600-655 (the `swapRenderer` + `registerLossHandler` block). Understand the existing structure before editing.

- [ ] **Step 2: Extract the focus-textarea listener into a reusable function**

Find this block in `open()` (currently around line 435-445):

```ts
const textarea = this.textarea;
// Desktop: mousedown
this.canvas.addEventListener('mousedown', (ev) => {
  ev.preventDefault();
  textarea.focus();
});
// Mobile: touchend with preventDefault to suppress iOS caret
this.canvas.addEventListener('touchend', (ev) => {
  ev.preventDefault();
  textarea.focus();
});
```

Replace with:

```ts
this.attachCanvasFocusListeners(this.canvas, this.textarea);
```

And add the new private method to `Terminal` (place near the other private DOM helpers, e.g. near `replaceCanvas` from CR1):

```ts
  /**
   * Attach the click-to-focus-textarea listeners on a canvas. Extracted so
   * the renderer-swap path can re-attach them after canvas replacement.
   */
  private attachCanvasFocusListeners(
    canvas: HTMLCanvasElement,
    textarea: HTMLTextAreaElement
  ): void {
    // Desktop: mousedown
    canvas.addEventListener('mousedown', (ev) => {
      ev.preventDefault();
      textarea.focus();
    });
    // Mobile: touchend with preventDefault to suppress iOS caret
    canvas.addEventListener('touchend', (ev) => {
      ev.preventDefault();
      textarea.focus();
    });
  }
```

This is purely a refactoring: the new helper does exactly what the old inline code did. Behavior unchanged.

- [ ] **Step 3: Add the `isSwapping` guard field**

Find the `Terminal` private fields. Add:

```ts
  private isSwapping = false;
```

Place it near other lifecycle flags like `isDisposed`.

- [ ] **Step 4: Refactor `swapRenderer`**

Find the existing `swapRenderer` arrow function (currently inside the `open()` method body, with `registerLossHandler` defined near it). Replace its body. The current code looks approximately like:

```ts
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
  registerLossHandler();
};
```

Replace with the canvas-replacement-aware version:

```ts
const swapRenderer = async (target: 'webgl' | 'canvas2d', reason: string): Promise<void> => {
  if (this.isDisposed || !this.canvas || !this.textarea || !this.wasmTerm) return;
  if (this.isSwapping) return;
  this.isSwapping = true;
  try {
    console.warn(`[ghostty-web] renderer falling back to ${target}:`, reason);

    // Tear down the old renderer's GPU resources and the SelectionManager
    // (which holds canvas-attached event listeners on the old canvas).
    this.renderer?.destroy();
    this.selectionManager?.destroy();

    // Replace the canvas DOM node. Browsers refuse to give an existing
    // canvas a second context type, so the new renderer needs a fresh
    // canvas to claim.
    const oldCanvas = this.canvas;
    this.canvas = this.replaceCanvas(oldCanvas);
    this.attachCanvasFocusListeners(this.canvas, this.textarea);

    // Resolve the new renderer; fall back to canvas2d on failure.
    try {
      this.renderer = await pickRenderer(target, this.canvas, {
        fontSize: this.options.fontSize,
        fontFamily: this.options.fontFamily,
        cursorStyle: this.options.cursorStyle,
        cursorBlink: this.options.cursorBlink,
        theme: this.options.theme,
      });
    } catch (e) {
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

    // Recreate the SelectionManager around the new renderer + canvas.
    // Selection state in progress is dropped — acceptable during a
    // GPU-loss swap event.
    this.selectionManager = new SelectionManager(this, this.renderer, this.wasmTerm, this.textarea);
    this.renderer.setSelectionManager(this.selectionManager);
    this.selectionManager.onSelectionChange(() => {
      this.selectionChangeEmitter.fire();
      this.requestRender();
    });

    this.renderer.invalidate();
    this.requestRender();
    registerLossHandler();
  } finally {
    this.isSwapping = false;
  }
};
```

Three substantive changes from before:

1. Wraps the body in `try/finally` with the `isSwapping` re-entrancy guard.
2. Replaces the canvas via `replaceCanvas` and re-attaches focus listeners.
3. Destroys the old `SelectionManager` and constructs a new one (rather than just re-pointing the renderer at the old, now-broken one).

- [ ] **Step 5: Verify**

```bash
bun run typecheck
bun test
```

Expected: typecheck clean; all 401+ tests still pass (including the 6 new `replaceCanvas` tests from CR1).

- [ ] **Step 6: Format**

```bash
npx prettier --write lib/terminal.ts
npx prettier --check lib/terminal.ts
```

Expected: prettier clean.

- [ ] **Step 7: Commit**

```bash
git add lib/terminal.ts
git commit -m "fix(terminal): swap renderer with fresh canvas to actually fall back

Browsers refuse to give a canvas a second context type once the first
has been acquired (webgpu → webgl2 was always going to fail). Replace
the canvas DOM node on swap so the new renderer has a fresh canvas to
claim. Also recreate the SelectionManager (its listeners point at the
detached old canvas) and add an isSwapping re-entrancy guard."
```

DO NOT include unstaged docs changes.

- [ ] **Step 8: Manual verification**

The end-to-end swap path is verified manually because we don't have stub-context infrastructure for two different context types in sequence.

```bash
bun run demo
```

Open `http://localhost:8080/?renderer=webgpu`. Then:

**Force WebGPU device loss (Chrome):**

1. Open DevTools → three-dot menu → More tools → Rendering
2. Toggle "Disable WebGPU"
3. Reload the page (`?renderer=webgpu` will fall back via factory's `auto`-style behavior — actually explicit webgpu will throw at init now because navigator.gpu is gated by the toggle)
4. To force a _runtime_ device loss, you need to navigate while WebGPU is enabled, then trigger via Chrome's GPU-process kill (chrome://gpu) or use the WebGPU `requestDevice().lost` mechanism if exposed

**Easier — force WebGL context loss after manual swap:**

1. Load `?renderer=webgl`
2. In DevTools console:
   ```js
   const cv = document.querySelector('#terminal canvas');
   cv.getContext('webgl2').getExtension('WEBGL_lose_context').loseContext();
   ```
3. Verify the page recovers (cascade should swap to canvas2d), text continues rendering.

**Cycle test:**

- Alt+Shift+R cycles webgpu → webgl → canvas2d → webgpu by reloading. Each transition gets a fresh page (and therefore a fresh canvas), so this path always worked. The bug was only on in-place `swapRenderer` triggered by loss events.

If the manual test reveals a regression, capture: which renderer was active, what action triggered the swap, and what behavior was observed (white screen, frozen text, error in console).

---

## Verification checklist

After CR1 and CR2 land:

- [ ] `bun test` passes (407+ tests; 6 new from CR1)
- [ ] `bun run typecheck` clean
- [ ] `bun run build` produces `dist/` artifacts
- [ ] Manual: forced WebGL context loss in `?renderer=webgl` recovers via cascade to canvas2d
- [ ] Manual: terminal text continues to render after the swap; cursor blink resumes; mouse selection works on the new canvas
- [ ] No regressions in the 401 pre-existing tests

## Notes for the implementer

- **CR2 is where the user-visible fix lands.** CR1 is preparatory.
- **No new automated test for the swap path itself.** The risk is real but the test infrastructure cost is high (need stub support across multiple context types in sequence). Manual verification is the safety net.
- **`SelectionManager.onSelectionChange` re-registration** is critical — without it, copy-on-select-change events break after a swap. The plan's CR2 step 4 includes the re-registration; don't drop it.
- **If `wasmTerm` is null when swap fires**, the early-return `if (... !this.wasmTerm)` handles it. This is a defensive addition over the existing code; the wasmTerm should always be valid post-`open()`.
- **`isSwapping` guard is conservative.** A second swap call while one is in flight just early-returns. Loss events that fire during a swap are silently dropped, which is fine for v1 — the swap target was canvas2d which itself rarely loses context.
