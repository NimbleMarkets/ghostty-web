# Renderer-swap Canvas Replacement — Design

**Status:** Approved (design)
**Date:** 2026-05-09
**Branch (anticipated):** `nm-webgpu` (continuation)
**Predecessor specs:**
- `docs/superpowers/specs/2026-05-08-webgl-backend-design.md` (T15 introduced the cascade)

## Goal

Make the WebGPU device-lost → WebGL2 → Canvas2D fallback cascade actually work. Today the cascade is broken at the second hop because `swapRenderer` reuses the same canvas, and browsers refuse to give a single `<canvas>` a second context type after the first has been acquired.

## Root cause

The HTMLCanvasElement spec is unambiguous: once `canvas.getContext('webgpu')` returns a context, subsequent `canvas.getContext('webgl2')` or `canvas.getContext('2d')` calls return `null`. The current `swapRenderer` in `lib/terminal.ts:625-651` calls `pickRenderer(target, this.canvas, opts)` with the same canvas the dying renderer was using. Result: the new renderer's `initialize()` throws "failed to acquire context", catch-block falls through to canvas2d, which has the same problem. User is stuck on a dead renderer.

## Non-goals

- **Preserving SelectionManager state across swap.** Selection coordinates and in-progress drag are dropped. A renderer swap is a once-per-session event triggered by GPU failure; the user can re-select.
- **Preserving in-flight scroll animation, link hover state, etc.** These reset.
- **Automated testing of the full swap path.** Test infrastructure for swapping between stub WebGPU and stub WebGL contexts is substantial. Manual verification only for the end-to-end swap.
- **Concurrency for multiple Terminals on the same canvas.** Each Terminal owns its canvas exclusively (already true; not changed by this fix).

## Architecture

### File layout

| Path | Status | Purpose |
|---|---|---|
| `lib/terminal.ts` | modify | Add `replaceCanvas(oldCanvas)` private helper. Refactor `swapRenderer(target, reason)` to call `replaceCanvas` before `pickRenderer`, re-attach Terminal-level listeners on the new canvas, recreate `SelectionManager`. Add an `isSwapping` guard to prevent re-entrancy. |
| `lib/terminal.test.ts` | modify | New test cases for `replaceCanvas` helper (parent attachment, style preservation, old-canvas detachment, fresh-instance return). |
| `lib/selection-manager.ts` | untouched | Existing `destroy()` already detaches all listeners cleanly; we use destroy + recreate. |
| `lib/renderer-webgpu.ts`, `lib/renderer-webgl.ts`, `lib/renderer.ts` | untouched | The fix is at the Terminal level. |
| `lib/renderer-factory.ts` | untouched | The factory's behavior is correct; the bug is the canvas reuse, not the factory. |

### `replaceCanvas` helper (new)

Pure DOM operation, ~15 lines. Lives as a private method on `Terminal` (kept private since it's only relevant to Terminal's swap flow):

```ts
private replaceCanvas(oldCanvas: HTMLCanvasElement): HTMLCanvasElement {
  const parent = oldCanvas.parentNode;
  if (!parent) {
    throw new Error('Terminal.replaceCanvas: old canvas has no parent');
  }
  const fresh = document.createElement('canvas');
  // Copy CSS-side state. The renderer will re-set width/height (drawing buffer
  // pixels) on its first resize; we copy them too to avoid a flash of zero-sized
  // canvas in the swap window.
  fresh.style.cssText = oldCanvas.style.cssText;
  fresh.width = oldCanvas.width;
  fresh.height = oldCanvas.height;
  parent.insertBefore(fresh, oldCanvas);
  parent.removeChild(oldCanvas);
  return fresh;
}
```

### Refactored `swapRenderer` flow

```
swapRenderer(target, reason):
  if (isDisposed || !canvas) return
  if (isSwapping) return                     // re-entrancy guard
  isSwapping = true
  try {
    console.warn(reason)
    this.renderer.destroy()
    this.selectionManager?.destroy()

    this.canvas = this.replaceCanvas(this.canvas)
    this.canvas.addEventListener('mousedown', focusTextareaHandler)
    this.canvas.addEventListener('touchend', focusTextareaHandler)

    try {
      this.renderer = await pickRenderer(target, this.canvas, opts)
    } catch (e) {
      console.warn(`${target} fallback failed; using canvas2d:`, e)
      this.renderer = await pickRenderer('canvas2d', this.canvas, opts)
    }

    this.renderer.resize(this.cols, this.rows)
    this.renderer.setOnRequestRender(() => this.requestRender())

    this.selectionManager = new SelectionManager(this.renderer, ...)
    this.renderer.setSelectionManager(this.selectionManager)

    this.renderer.invalidate()
    this.requestRender()

    registerLossHandler()                    // re-arm cascade for new renderer
  } finally {
    isSwapping = false
  }
```

The `focusTextareaHandler` is the existing inline closure that captures `textarea`. We extract it to a named handler (or a method) so it can be re-attached on swap.

### Why destroy + recreate SelectionManager (not rewire)

`SelectionManager` (`lib/selection-manager.ts`) attaches mousedown / mousemove / mouseleave / mouseenter / contextmenu listeners directly to the canvas, plus document-level mousemove and mouseup listeners. Rewiring would require a `rewire(newRenderer)` method that detaches old listeners and re-attaches to the new canvas. That adds API surface for negligible UX gain — selection state mid-renderer-swap is rare.

`SelectionManager.destroy()` already exists and cleanly detaches all listeners (lines 403-413). Recreate is one-line.

### Why no changes to LinkDetector / Scrollbar / Input handlers

- **LinkDetector** reads `this.canvas.getBoundingClientRect()` per call (terminal.ts:1561, 1736, 1846). It picks up the new canvas naturally once `this.canvas` is updated.
- **ScrollbarOverlay** uses a separate `scrollbarCanvas` element — unaffected.
- **Input handlers** (mouse/wheel/click) are attached to `parent`, not canvas. Unaffected.

## Data flow on swap

See Section 2 of the brainstorm transcript. Summary: the swap detaches the dying canvas, creates a fresh one with the same parent + styles, re-attaches Terminal's two canvas-specific listeners, recreates SelectionManager, then calls `pickRenderer` with the fresh canvas (which has no associated GL/GPU context yet, so `getContext()` works). On any pickRenderer failure, the existing catch-fallback to canvas2d succeeds because canvas2d's `getContext('2d')` works on the fresh canvas.

## Error handling

| Failure mode | Behavior |
|---|---|
| `replaceCanvas` called when `oldCanvas.parentNode === null` | Throw `Terminal.replaceCanvas: old canvas has no parent`. Shouldn't happen in practice (canvas is always parent-attached after `open()`). |
| `pickRenderer(target, ...)` throws AND the canvas2d fallback throws | Re-throw. Terminal is left without a renderer. Same as today — no regression. |
| `selectionManager?.destroy()` called when SM was already destroyed | `SelectionManager.destroy()` is idempotent (guards each detach with the bound-handler null check). Safe. |
| Concurrent swap calls | `isSwapping` guard prevents re-entrancy. Second call early-returns; the first call wins. |
| Swap fires before `open()` completes | `if (isDisposed \|\| !canvas) return` guard catches this (`canvas` is undefined until `open()` runs). Same as today. |
| Browser doesn't allow even the fresh canvas to acquire a context (extreme OOM, GPU process killed) | All of WebGPU/WebGL/Canvas2D would fail. Canvas2D effectively never fails on a fresh canvas in practice; if it does, the catch falls all the way through and the terminal becomes nonfunctional. Acceptable degradation. |

## Testing

### Unit tests (new)

In `lib/terminal.test.ts`, test `Terminal.replaceCanvas` (accessed via `(terminal as any).replaceCanvas`) with a happy-dom-fabricated canvas:

- **Returns a fresh canvas instance:** `expect(newCanvas).not.toBe(oldCanvas)`
- **New canvas is attached to the same parent:** `expect(newCanvas.parentNode).toBe(parent)`
- **Old canvas is detached:** `expect(oldCanvas.parentNode).toBe(null)`
- **CSS state is copied:** set `oldCanvas.style.cssText = 'display: block; cursor: text;'` before, verify on new
- **Drawing-buffer dims are copied:** set `oldCanvas.width = 800; oldCanvas.height = 600;` before, verify on new
- **DOM position is preserved:** with siblings present, verify the new canvas occupies the old canvas's index in `parent.children`
- **Throws on parentless canvas:** detach old before calling, expect throw

### Manual verification

The end-to-end swap path is verified manually via Chrome DevTools:

- **Force WebGPU loss:** Chrome → DevTools → three-dot menu → More tools → Rendering → "Disable WebGPU" toggle. Reload with `?renderer=webgpu`. Verify the cascade demotes through WebGL2 to Canvas2D as appropriate, and the terminal continues to render text + cursor + selection.
- **Force WebGL context loss:** in console, after the renderer is `webgl`:
  ```js
  const cv = document.querySelector('#terminal-container canvas, #terminal canvas');
  const gl = cv.getContext('webgl2');
  gl.getExtension('WEBGL_lose_context').loseContext();
  ```
  Verify cascade demotes to Canvas2D and rendering continues.
- **Cycle test:** Alt+Shift+R between webgpu / webgl / canvas2d. Each transition should work without errors. (This already worked because Alt+Shift+R navigates to a fresh page with a fresh canvas — the bug is only on `swapRenderer`'s in-place transitions.)

## Behavior preserved

- **Existing 401 tests** continue to pass. The `replaceCanvas` helper is additive; the `swapRenderer` refactor preserves the same external contract.
- **No-failure happy path** (browser supports WebGPU, no device loss): `swapRenderer` is never called. Zero impact.
- **Auto-fallback at first init** (browser lacks WebGPU): `pickRenderer` already handles this on a fresh canvas — no change needed.

## Out of scope (explicit)

- Automated end-to-end test of the swap path (manual verification only).
- SelectionManager state preservation across swap.
- Concurrency / locking beyond the simple `isSwapping` re-entrancy guard.
- Surface any internal "renderer is unhealthy, please refresh" UI to the user.
- Recovery when the same backend's context-loss event fires repeatedly (e.g., flapping driver). The cascade demotes once per loss event; if loss fires repeatedly on canvas2d we just keep recreating canvases. Not addressed; acceptable.
