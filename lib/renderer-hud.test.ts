import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { installRendererHud, parseRendererFromURL } from './renderer-hud';
import type { Renderer, RendererBackend } from './renderer-types';
import type { Terminal } from './terminal';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const HUD_ID = 'ghostty-renderer-hud';
const HUD_STYLE_ID = 'ghostty-renderer-hud-styles';

interface LocationStub {
  capturedHref: string | null;
  restore: () => void;
}

function stubLocation(initialHref: string): LocationStub {
  const original = Object.getOwnPropertyDescriptor(window, 'location');
  const url = new URL(initialHref);
  let captured: string | null = null;
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: {
      get href() {
        return url.toString();
      },
      set href(next: string) {
        captured = next;
      },
      get search() {
        return url.search;
      },
      origin: url.origin,
      pathname: url.pathname,
    },
  });
  return {
    get capturedHref() {
      return captured;
    },
    restore() {
      if (original) {
        Object.defineProperty(window, 'location', original);
      } else {
        // biome-ignore lint/performance/noDelete: test cleanup
        delete (window as any).location;
      }
    },
  } as LocationStub;
}

function makeMockRenderer(backend: 'webgpu' | 'webgl' | 'canvas2d'): Renderer {
  return {
    backend,
    canvas: document.createElement('canvas'),
    getMetrics: () => ({ width: 8, height: 16, baseline: 12 }),
    resize: () => {},
    render: () => {},
    setTheme: () => {},
    setFontSize: () => {},
    setFontFamily: () => {},
    setCursorStyle: () => {},
    setCursorBlink: () => {},
    setOnRequestRender: () => {},
    setSelectionManager: () => {},
    setHoveredHyperlinkId: () => {},
    setHoveredLinkRange: () => {},
    invalidate: () => {},
    remeasureFont: () => {},
    destroy: () => {},
  } as Renderer;
}

function makeMockTerminal(backend: 'webgpu' | 'webgl' | 'canvas2d'): Terminal {
  return { renderer: makeMockRenderer(backend) } as unknown as Terminal;
}

function cleanupDom() {
  document.getElementById(HUD_ID)?.remove();
  document.getElementById(HUD_STYLE_ID)?.remove();
}

// ---------------------------------------------------------------------------
// parseRendererFromURL
// ---------------------------------------------------------------------------

describe('parseRendererFromURL', () => {
  let stub: LocationStub | null = null;
  let savedGhostty: RendererBackend | undefined;
  let savedBooba: RendererBackend | undefined;

  beforeEach(() => {
    savedGhostty = window.__ghosttyDefaultRenderer;
    savedBooba = window.__boobaDefaultRenderer;
    window.__ghosttyDefaultRenderer = undefined;
    window.__boobaDefaultRenderer = undefined;
  });

  afterEach(() => {
    stub?.restore();
    stub = null;
    window.__ghosttyDefaultRenderer = savedGhostty;
    window.__boobaDefaultRenderer = savedBooba;
  });

  test('?renderer=webgpu returns "webgpu"', () => {
    stub = stubLocation('http://example.com/?renderer=webgpu');
    expect(parseRendererFromURL()).toBe('webgpu');
  });

  test('?renderer=webgl returns "webgl"', () => {
    stub = stubLocation('http://example.com/?renderer=webgl');
    expect(parseRendererFromURL()).toBe('webgl');
  });

  test('?renderer=canvas2d returns "canvas2d"', () => {
    stub = stubLocation('http://example.com/?renderer=canvas2d');
    expect(parseRendererFromURL()).toBe('canvas2d');
  });

  test('?renderer=auto returns "auto"', () => {
    stub = stubLocation('http://example.com/?renderer=auto');
    expect(parseRendererFromURL()).toBe('auto');
  });

  test('garbage param falls back to __ghosttyDefaultRenderer', () => {
    stub = stubLocation('http://example.com/?renderer=garbage');
    window.__ghosttyDefaultRenderer = 'webgl';
    expect(parseRendererFromURL()).toBe('webgl');
  });

  test('garbage param falls back to deprecated __boobaDefaultRenderer when no ghostty global', () => {
    stub = stubLocation('http://example.com/?renderer=garbage');
    window.__boobaDefaultRenderer = 'canvas2d';
    expect(parseRendererFromURL()).toBe('canvas2d');
  });

  test('no param and no globals returns "auto"', () => {
    stub = stubLocation('http://example.com/');
    expect(parseRendererFromURL()).toBe('auto');
  });

  test('invalid global value falls through to "auto"', () => {
    stub = stubLocation('http://example.com/?renderer=garbage');
    (window as any).__ghosttyDefaultRenderer = 'badvalue';
    expect(parseRendererFromURL()).toBe('auto');
  });
});

// ---------------------------------------------------------------------------
// installRendererHud — mount, styles, uninstall
// ---------------------------------------------------------------------------

describe('installRendererHud — mount and styles', () => {
  let stub: LocationStub | null = null;

  beforeEach(() => {
    cleanupDom();
    stub = stubLocation('http://example.com/');
  });

  afterEach(() => {
    cleanupDom();
    stub?.restore();
    stub = null;
  });

  test('mounts a div with the canonical id under document.body by default', () => {
    const term = makeMockTerminal('webgpu');
    const uninstall = installRendererHud(term);
    const badge = document.getElementById(HUD_ID);
    expect(badge).not.toBeNull();
    expect(badge?.parentElement).toBe(document.body);
    uninstall();
  });

  test('mounts under opts.parent when provided', () => {
    const term = makeMockTerminal('webgpu');
    const parent = document.createElement('div');
    document.body.appendChild(parent);
    const uninstall = installRendererHud(term, { parent });
    expect(document.getElementById(HUD_ID)?.parentElement).toBe(parent);
    uninstall();
    parent.remove();
  });

  test('applies opts.className on the badge', () => {
    const term = makeMockTerminal('webgpu');
    const uninstall = installRendererHud(term, { className: 'my-custom' });
    expect(document.getElementById(HUD_ID)?.classList.contains('my-custom')).toBe(true);
    uninstall();
  });

  test('inline position defaults to "fixed"', () => {
    const term = makeMockTerminal('webgpu');
    const uninstall = installRendererHud(term);
    expect(document.getElementById(HUD_ID)?.style.position).toBe('fixed');
    uninstall();
  });

  test('inline position honors opts.position = "absolute"', () => {
    const term = makeMockTerminal('webgpu');
    const uninstall = installRendererHud(term, { position: 'absolute' });
    expect(document.getElementById(HUD_ID)?.style.position).toBe('absolute');
    uninstall();
  });

  test('uninstall removes the badge, the style block, and stops listening', () => {
    const term = makeMockTerminal('webgpu');
    const uninstall = installRendererHud(term);
    expect(document.getElementById(HUD_ID)).not.toBeNull();
    expect(document.getElementById(HUD_STYLE_ID)).not.toBeNull();
    uninstall();
    expect(document.getElementById(HUD_ID)).toBeNull();
    expect(document.getElementById(HUD_STYLE_ID)).toBeNull();
  });

  test('reinstall after uninstall with a different position works (no frozen style block)', () => {
    const term = makeMockTerminal('webgpu');
    const u1 = installRendererHud(term, { position: 'fixed' });
    expect(document.getElementById(HUD_ID)?.style.position).toBe('fixed');
    u1();
    const u2 = installRendererHud(term, { position: 'absolute' });
    expect(document.getElementById(HUD_ID)?.style.position).toBe('absolute');
    u2();
  });
});

// ---------------------------------------------------------------------------
// Click toggle
// ---------------------------------------------------------------------------

describe('installRendererHud — click toggle', () => {
  let stub: LocationStub | null = null;

  beforeEach(() => {
    cleanupDom();
  });

  afterEach(() => {
    cleanupDom();
    stub?.restore();
    stub = null;
  });

  test('webgpu → webgl on click', () => {
    stub = stubLocation('http://example.com/');
    const uninstall = installRendererHud(makeMockTerminal('webgpu'));
    document.getElementById(HUD_ID)?.click();
    expect(stub.capturedHref).toContain('renderer=webgl');
    uninstall();
  });

  test('webgl → canvas2d on click', () => {
    stub = stubLocation('http://example.com/');
    const uninstall = installRendererHud(makeMockTerminal('webgl'));
    document.getElementById(HUD_ID)?.click();
    expect(stub.capturedHref).toContain('renderer=canvas2d');
    uninstall();
  });

  test('canvas2d → webgpu on click (cycle wraps)', () => {
    stub = stubLocation('http://example.com/');
    const uninstall = installRendererHud(makeMockTerminal('canvas2d'));
    document.getElementById(HUD_ID)?.click();
    expect(stub.capturedHref).toContain('renderer=webgpu');
    uninstall();
  });

  test('clickToToggle: false makes click a no-op (no navigation)', () => {
    stub = stubLocation('http://example.com/');
    const uninstall = installRendererHud(makeMockTerminal('webgpu'), {
      clickToToggle: false,
    });
    document.getElementById(HUD_ID)?.click();
    expect(stub.capturedHref).toBeNull();
    uninstall();
  });
});

// ---------------------------------------------------------------------------
// Hotkey toggle
// ---------------------------------------------------------------------------

describe('installRendererHud — hotkey toggle', () => {
  let stub: LocationStub | null = null;

  beforeEach(() => {
    cleanupDom();
  });

  afterEach(() => {
    cleanupDom();
    stub?.restore();
    stub = null;
  });

  test('Alt+Shift+R (code: KeyR) cycles renderer', () => {
    stub = stubLocation('http://example.com/');
    const uninstall = installRendererHud(makeMockTerminal('webgpu'));
    window.dispatchEvent(
      new KeyboardEvent('keydown', { altKey: true, shiftKey: true, code: 'KeyR' })
    );
    expect(stub.capturedHref).toContain('renderer=webgl');
    uninstall();
  });

  test('macOS Option-Shift-R produces dead-key key="Ω" but code="KeyR" — must still cycle', () => {
    // This is the regression: booba's hud bound on e.key === 'R', which is
    // never true on macOS US layout because Option+R maps to a dead-key char.
    stub = stubLocation('http://example.com/');
    const uninstall = installRendererHud(makeMockTerminal('webgpu'));
    window.dispatchEvent(
      new KeyboardEvent('keydown', {
        altKey: true,
        shiftKey: true,
        key: 'Ω',
        code: 'KeyR',
      })
    );
    expect(stub.capturedHref).toContain('renderer=webgl');
    uninstall();
  });

  test('bindToggleHotkey: false disables the hotkey', () => {
    stub = stubLocation('http://example.com/');
    const uninstall = installRendererHud(makeMockTerminal('webgpu'), {
      bindToggleHotkey: false,
    });
    window.dispatchEvent(
      new KeyboardEvent('keydown', { altKey: true, shiftKey: true, code: 'KeyR' })
    );
    expect(stub.capturedHref).toBeNull();
    uninstall();
  });

  test('uninstall removes the keydown listener', () => {
    stub = stubLocation('http://example.com/');
    const uninstall = installRendererHud(makeMockTerminal('webgpu'));
    uninstall();
    window.dispatchEvent(
      new KeyboardEvent('keydown', { altKey: true, shiftKey: true, code: 'KeyR' })
    );
    expect(stub.capturedHref).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Custom cycle option
// ---------------------------------------------------------------------------

describe('installRendererHud — custom cycle', () => {
  let stub: LocationStub | null = null;

  beforeEach(() => {
    cleanupDom();
  });

  afterEach(() => {
    cleanupDom();
    stub?.restore();
    stub = null;
  });

  test('cycle = ["webgpu","canvas2d"] skips webgl: webgpu → canvas2d', () => {
    stub = stubLocation('http://example.com/');
    const uninstall = installRendererHud(makeMockTerminal('webgpu'), {
      cycle: ['webgpu', 'canvas2d'],
    });
    document.getElementById(HUD_ID)?.click();
    expect(stub.capturedHref).toContain('renderer=canvas2d');
    uninstall();
  });

  test('starting backend not in cycle defaults to first cycle entry', () => {
    stub = stubLocation('http://example.com/');
    const uninstall = installRendererHud(makeMockTerminal('webgl'), {
      cycle: ['webgpu', 'canvas2d'],
    });
    document.getElementById(HUD_ID)?.click();
    expect(stub.capturedHref).toContain('renderer=webgpu');
    uninstall();
  });
});

// ---------------------------------------------------------------------------
// Idempotency / double-install
// ---------------------------------------------------------------------------

describe('installRendererHud — idempotency', () => {
  let stub: LocationStub | null = null;
  let warnSpy: ReturnType<typeof mock>;
  let originalWarn: typeof console.warn;

  beforeEach(() => {
    cleanupDom();
    stub = stubLocation('http://example.com/');
    originalWarn = console.warn;
    warnSpy = mock(() => {});
    console.warn = warnSpy as unknown as typeof console.warn;
  });

  afterEach(() => {
    console.warn = originalWarn;
    cleanupDom();
    stub?.restore();
    stub = null;
  });

  test('second install without uninstall warns and returns no-op', () => {
    const term = makeMockTerminal('webgpu');
    const u1 = installRendererHud(term);
    const u2 = installRendererHud(term);
    expect(warnSpy).toHaveBeenCalled();
    expect(document.querySelectorAll(`#${HUD_ID}`).length).toBe(1);
    // The no-op uninstaller must not remove the still-installed badge.
    u2();
    expect(document.getElementById(HUD_ID)).not.toBeNull();
    u1();
    expect(document.getElementById(HUD_ID)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Defensive null check
// ---------------------------------------------------------------------------

describe('installRendererHud — defensive null check', () => {
  test('throws with a clear message mentioning term.open() when terminal is null', () => {
    expect(() => installRendererHud(null as unknown as Terminal)).toThrow(/term\.open\(\)/);
  });
});
