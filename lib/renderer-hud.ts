/**
 * Renderer HUD — small corner badge that shows the active renderer backend
 * and live FPS, with optional click + Alt+Shift+R cycling between renderers.
 *
 * Lifted from the demo's inline overlay so consumers (booba, etc.) can drop
 * in the same widget without re-implementing it. The default cycle covers
 * all three concrete backends — webgpu → webgl → canvas2d → wrap.
 */

import type { RendererBackend } from './renderer-types';
import type { Terminal } from './terminal';

declare global {
  interface Window {
    __ghosttyDefaultRenderer?: RendererBackend;
    /** @deprecated booba consumers — read-through fallback only. */
    __boobaDefaultRenderer?: RendererBackend;
  }
}

export interface RendererHudOptions {
  /** Where to mount the badge. Default: `document.body`. */
  parent?: HTMLElement;
  /** `'fixed'` (viewport, default) or `'absolute'` (relative to parent). */
  position?: 'fixed' | 'absolute';
  /** CSS class applied to the badge for custom styling. */
  className?: string;
  /** Default `true`. When `true`, clicking the badge cycles the renderer. */
  clickToToggle?: boolean;
  /** Default `true`. When `true`, Alt+Shift+R cycles the renderer. */
  bindToggleHotkey?: boolean;
  /** Override the cycle order. Default: `['webgpu', 'webgl', 'canvas2d']`. */
  cycle?: ReadonlyArray<Exclude<RendererBackend, 'auto'>>;
}

const HUD_ID = 'ghostty-renderer-hud';
const HUD_STYLE_ID = 'ghostty-renderer-hud-styles';
const DEFAULT_CYCLE: ReadonlyArray<Exclude<RendererBackend, 'auto'>> = [
  'webgpu',
  'webgl',
  'canvas2d',
];

function isConcreteBackend(v: unknown): v is Exclude<RendererBackend, 'auto'> {
  return v === 'webgpu' || v === 'webgl' || v === 'canvas2d';
}

function isAnyBackend(v: unknown): v is RendererBackend {
  return v === 'auto' || isConcreteBackend(v);
}

/**
 * Parse `?renderer=` from `window.location`, validating against
 * `RendererBackend`. Falls back to `window.__ghosttyDefaultRenderer`, then
 * `window.__boobaDefaultRenderer` (deprecated alias for backwards compat
 * with go-booba's existing servers), then `'auto'`.
 */
export function parseRendererFromURL(): RendererBackend {
  const params = new URLSearchParams(window.location.search);
  const q = params.get('renderer');
  if (isAnyBackend(q)) return q;

  const ghostty = window.__ghosttyDefaultRenderer;
  if (isAnyBackend(ghostty)) return ghostty;

  const booba = window.__boobaDefaultRenderer;
  if (isAnyBackend(booba)) return booba;

  return 'auto';
}

function ensureStyleBlock(): void {
  if (document.getElementById(HUD_STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = HUD_STYLE_ID;
  // :where(...) gives the default rules specificity 0, so a consumer's
  // className styles win for everything except `position` (which we set
  // inline on the badge so it can vary per instance).
  style.textContent = `
    :where(#${HUD_ID}) {
      bottom: 12px;
      right: 12px;
      font-family: monospace;
      font-size: 11px;
      color: #ccc;
      background: rgba(0, 0, 0, 0.4);
      padding: 2px 6px;
      border-radius: 3px;
      user-select: none;
      z-index: 10;
    }
  `;
  document.head.appendChild(style);
}

function nextInCycle(
  cur: string | undefined,
  cycle: ReadonlyArray<Exclude<RendererBackend, 'auto'>>
): Exclude<RendererBackend, 'auto'> {
  const idx = cur === undefined ? -1 : cycle.indexOf(cur as Exclude<RendererBackend, 'auto'>);
  if (idx < 0) return cycle[0];
  return cycle[(idx + 1) % cycle.length];
}

function navigateToRenderer(next: RendererBackend): void {
  const url = new URL(window.location.href);
  url.searchParams.set('renderer', next);
  window.location.href = url.toString();
}

/**
 * Install a corner HUD showing the active renderer backend and live FPS.
 * Returns an uninstall function that removes the badge, the injected style
 * block, the rAF loop, and any listeners.
 */
export function installRendererHud(terminal: Terminal, opts: RendererHudOptions = {}): () => void {
  if (!terminal) {
    throw new Error(
      'installRendererHud: terminal is null/undefined — call after term.open() so terminal.renderer exists.'
    );
  }

  if (document.getElementById(HUD_ID)) {
    console.warn(
      `installRendererHud: a HUD with id "${HUD_ID}" is already installed. Uninstall first if you need to reinstall.`
    );
    return () => {};
  }

  const parent = opts.parent ?? document.body;
  const position: 'fixed' | 'absolute' = opts.position ?? 'fixed';
  const clickToToggle = opts.clickToToggle ?? true;
  const bindToggleHotkey = opts.bindToggleHotkey ?? true;
  const cycle = opts.cycle && opts.cycle.length > 0 ? opts.cycle : DEFAULT_CYCLE;

  ensureStyleBlock();

  const badge = document.createElement('div');
  badge.id = HUD_ID;
  badge.style.position = position;
  if (opts.className) badge.className = opts.className;

  if (clickToToggle && bindToggleHotkey) {
    badge.title = 'Click or Alt+Shift+R: cycle renderer';
  } else if (clickToToggle) {
    badge.title = 'Click: cycle renderer';
  } else if (bindToggleHotkey) {
    badge.title = 'Alt+Shift+R: cycle renderer';
  }

  if (clickToToggle) {
    badge.style.cursor = 'pointer';
    badge.style.pointerEvents = 'auto';
  } else {
    badge.style.pointerEvents = 'none';
  }

  parent.appendChild(badge);

  // rAF loop for the FPS counter — text updates once per second.
  let frames = 0;
  let lastTick = performance.now();
  let rafId: number | null = null;
  const tick = () => {
    frames += 1;
    const now = performance.now();
    if (now - lastTick >= 1000) {
      const backend = terminal.renderer?.backend ?? '?';
      badge.textContent = `${backend} ${frames} fps`;
      frames = 0;
      lastTick = now;
    }
    rafId = requestAnimationFrame(tick);
  };
  rafId = requestAnimationFrame(tick);

  const cycleNow = () => {
    const next = nextInCycle(terminal.renderer?.backend, cycle);
    navigateToRenderer(next);
  };

  const onClick = () => cycleNow();
  if (clickToToggle) badge.addEventListener('click', onClick);

  // Use e.code (physical key) rather than e.key — on macOS, holding Option
  // transforms 'R' into a dead-key character before keydown, so e.key would
  // never match. This is the bug booba's earlier hud.ts had.
  const onKeydown = (e: KeyboardEvent) => {
    if (e.altKey && e.shiftKey && e.code === 'KeyR') {
      e.preventDefault();
      cycleNow();
    }
  };
  if (bindToggleHotkey) window.addEventListener('keydown', onKeydown);

  return () => {
    if (rafId !== null) cancelAnimationFrame(rafId);
    if (clickToToggle) badge.removeEventListener('click', onClick);
    if (bindToggleHotkey) window.removeEventListener('keydown', onKeydown);
    badge.remove();
    document.getElementById(HUD_STYLE_ID)?.remove();
  };
}
