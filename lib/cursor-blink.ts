/**
 * Cursor blink timer.
 *
 * Owns the periodic "blink toggle" that flips cursor visibility on and off.
 * The renderer queries isVisible() at draw time; the timer wakes the
 * scheduler via onRequestRender so an event-driven Terminal still repaints
 * when blink fires.
 *
 * Carved out of CanvasRenderer in commit history — keeps both Canvas2D and
 * WebGPU backends from re-implementing the same setInterval dance.
 */

const BLINK_INTERVAL_MS = 530; // matches xterm.js

export class CursorBlink {
  private enabled = false;
  private visible = true;
  private intervalId?: ReturnType<typeof setInterval>;
  private onRequestRender: (() => void) | null = null;

  setEnabled(enabled: boolean): void {
    if (this.enabled === enabled) return;
    this.enabled = enabled;
    if (enabled) {
      this.visible = true;
      this.intervalId = setInterval(() => {
        this.visible = !this.visible;
        this.onRequestRender?.();
      }, BLINK_INTERVAL_MS);
    } else {
      if (this.intervalId !== undefined) clearInterval(this.intervalId);
      this.intervalId = undefined;
      this.visible = true;
    }
  }

  isVisible(): boolean {
    return this.visible;
  }

  setOnRequestRender(fn: (() => void) | null): void {
    this.onRequestRender = fn;
  }

  destroy(): void {
    if (this.intervalId !== undefined) clearInterval(this.intervalId);
    this.intervalId = undefined;
  }
}
