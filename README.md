# ghostty-web

[![NPM Version](https://img.shields.io/npm/v/ghostty-web)](https://npmjs.com/package/ghostty-web) [![NPM Downloads](https://img.shields.io/npm/dw/ghostty-web)](https://npmjs.com/package/ghostty-web) [![npm bundle size](https://img.shields.io/bundlephobia/minzip/ghostty-web)](https://npmjs.com/package/ghostty-web) [![license](https://img.shields.io/github/license/coder/ghostty-web)](./LICENSE)

[Ghostty](https://github.com/ghostty-org/ghostty) for the web with [xterm.js](https://github.com/xtermjs/xterm.js) API compatibility — giving you a proper VT100 implementation in the browser.

- Migrate from xterm by changing your import: `@xterm/xterm` → `ghostty-web`
- WASM-compiled parser from Ghostty—the same code that runs the native app
- Zero runtime dependencies, ~400KB WASM bundle

Originally created for [Mux](https://github.com/coder/mux) (a desktop app for isolated, parallel agentic development), but designed to be used anywhere.

## Try It

- [Live Demo](https://ghostty.ondis.co) on an ephemeral VM (thank you to Greg from [disco.cloud](https://disco.cloud) for hosting).

- On your computer:

  ```bash
  npx @ghostty-web/demo@next
  ```

  This starts a local HTTP server with a real shell on `http://localhost:8080`. Works best on Linux and macOS.

![ghostty](https://github.com/user-attachments/assets/aceee7eb-d57b-4d89-ac3d-ee1885d0187a)

## Comparison with xterm.js

xterm.js is everywhere—VS Code, Hyper, countless web terminals. But it has fundamental issues:

| Issue                                    | xterm.js                                                         | ghostty-web                |
| ---------------------------------------- | ---------------------------------------------------------------- | -------------------------- |
| **Complex scripts** (Devanagari, Arabic) | Rendering issues                                                 | ✓ Proper grapheme handling |
| **XTPUSHSGR/XTPOPSGR**                   | [Not supported](https://github.com/xtermjs/xterm.js/issues/2570) | ✓ Full support             |

xterm.js reimplements terminal emulation in JavaScript. Every escape sequence, every edge case, every Unicode quirk—all hand-coded. Ghostty's emulator is the same battle-tested code that runs the native Ghostty app.

## Installation

```bash
npm install ghostty-web
```

## Usage

ghostty-web aims to be API-compatible with the xterm.js API.

```javascript
import { init, Terminal } from 'ghostty-web';

await init();

const term = new Terminal({
  fontSize: 14,
  theme: {
    background: '#1a1b26',
    foreground: '#a9b1d6',
  },
});

await term.open(document.getElementById('terminal'));
term.onData((data) => websocket.send(data));
websocket.onmessage = (e) => term.write(e.data);
```

For a comprehensive client <-> server example, refer to the [demo](./demo/index.html#L141).

### Renderers

Three GPU/CPU rendering backends are supported. Pass
`{ renderer: 'webgpu' | 'webgl' | 'canvas2d' | 'auto' }` (default `'auto'`) to the
`Terminal` constructor.

- **WebGPU** — preferred; required for full kitty graphics atlas performance
- **WebGL2** — fallback for browsers without WebGPU (notably Safari < 26 and
  Firefox without the flag); shares the same atlas-based kitty path
- **Canvas2D** — universal fallback; supports kitty graphics via 2D context

`'auto'` tries WebGPU → WebGL2 → Canvas2D in order, transparently falling
through to the next on init failure. At runtime, GPU device-loss (WebGPU) or
context-loss (WebGL) automatically demotes to the next available backend on
a fresh canvas.

### Renderer HUD

A small corner badge that shows the active renderer backend and live FPS,
with click-to-cycle and `Alt+Shift+R` cycling between renderers. Useful for
demos and during development; opt-in.

```javascript
import { init, Terminal, installRendererHud, parseRendererFromURL } from 'ghostty-web';

await init();
const term = new Terminal({ renderer: parseRendererFromURL() });
await term.open(document.getElementById('terminal'));

const uninstall = installRendererHud(term, {
  parent: document.getElementById('terminal'),
  position: 'absolute',
});
// later: uninstall();
```

`parseRendererFromURL()` reads `?renderer=webgpu|webgl|canvas2d|auto` from
the current URL and falls back to `window.__ghosttyDefaultRenderer` if a
server has injected one, then `'auto'`.

`installRendererHud(terminal, opts?)` options:

| Option             | Default                         | Description                                                |
| ------------------ | ------------------------------- | ---------------------------------------------------------- |
| `parent`           | `document.body`                 | Where to mount the badge.                                  |
| `position`         | `'fixed'`                       | `'fixed'` (viewport) or `'absolute'` (relative to parent). |
| `className`        | —                               | CSS class applied to the badge for custom styling.         |
| `clickToToggle`    | `true`                          | Click the badge to cycle the renderer.                     |
| `bindToggleHotkey` | `true`                          | Bind `Alt+Shift+R` on `window` to cycle the renderer.      |
| `cycle`            | `['webgpu','webgl','canvas2d']` | Cycle order; pass a subset to skip backends.               |

The toggle navigates `window.location.href` with the new `?renderer=` value,
so the page reloads with the chosen backend.

## Development

ghostty-web builds from Ghostty's source with a [patch](./patches/ghostty-wasm-api.patch) to expose additional
functionality.

> Requires Zig and Bun.

```bash
bun run build
```

Mitchell Hashimoto (author of Ghostty) has [been working](https://mitchellh.com/writing/libghostty-is-coming) on `libghostty` which makes this all possible. The patches are very minimal thanks to the work the Ghostty team has done, and we expect them to get smaller.

This library will eventually consume a native Ghostty WASM distribution once available, and will continue to provide an xterm.js compatible API.

At Coder we're big fans of Ghostty, so kudos to that team for all the amazing work.

## License

[MIT](./LICENSE)
