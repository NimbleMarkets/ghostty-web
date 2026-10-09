# ghostty-web

[![NPM Version](https://img.shields.io/npm/v/ghostty-web)](https://npmjs.com/package/ghostty-web) [![NPM Downloads](https://img.shields.io/npm/dw/ghostty-web)](https://npmjs.com/package/ghostty-web) [![npm bundle size](https://img.shields.io/bundlephobia/minzip/ghostty-web)](https://npmjs.com/package/ghostty-web) [![license](https://img.shields.io/github/license/coder/ghostty-web)](./LICENSE)

[Ghostty](https://github.com/ghostty-org/ghostty) for the web with [xterm.js](https://github.com/xtermjs/xterm.js) API compatibility — giving you a proper VT100 implementation in the browser.

- Migrate from xterm by changing your import: `@xterm/xterm` → `ghostty-web`
- WASM-compiled parser from Ghostty—the same code that runs the native app
- ~940 KiB WASM bundle

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

### Unicode and bidirectional text

`Terminal.unicode.activeVersion` reports Unicode 15.1 for Ghostty's terminal,
grapheme, and width behavior. Implicit right-to-left ordering currently uses
[`bidi-js` 1.0.3](https://github.com/lojjic/bidi-js), whose generated tables
implement Unicode Bidirectional Algorithm 13.0. Characters assigned after
Unicode 13 may therefore have outdated BiDi classifications. Matching Unicode
15.1 requires those tables to be updated upstream in `bidi-js`.

### Program status (OSC 7501)

Subscribe to structured program-status reports from applications:

```typescript
const subscription = term.onProgramStatus((report) => {
  console.log(report.state, report.app, report.message, report.progress);
});
// Later, stop receiving reports:
subscription.dispose();
```

`ProgramStatusReport` is exported from `ghostty-web`. Its `state` is `idle`,
`working`, `done`, `blocked`, `error`, or `clear`; `kind` is `permission`,
`question`, `auth`, or `null`. Progress is a percentage or `null`. The `id`,
`app`, `title`, and `message` fields are strings; title and message are already
decoded from base64 to UTF-8.

Subscriptions may be created before `open()`. The terminal answers OSC 7501
support queries only while at least one listener is subscribed. Reports arrive
synchronously during `write()`, after WASM parsing finishes. The host application
owns the status records: replace each record by `id`, remove a cleared id and its
descendants, and clear everything for a `clear` report with an empty id. Both RIS
and `term.reset()` emit that full clear. The host must also apply the protocol's
process-exit lifetime rules; the browser terminal cannot detect PTY process exits.

The Ghostty submodule is pinned to `a4aacd918ba9e79929ff608034c60a4341773ef0`
(October 6, 2026), which adds the public libghostty-vt program-status callback.
Rebuilding requires Zig **0.16.0**; use
`ZIG=/absolute/path/to/zig bun run build` if your system compiler differs.

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

## Browser Kitty shared memory

After a terminal is constructed, `globalThis.ghosttyKittySharedMemory` is a
`Map<string, Uint8Array>`. Its presence signals support for browser `t=s`
transmissions. Put tightly packed, straight-alpha RGBA bytes in the map under a
unique name, then send a Kitty command containing the base64-encoded name:

```js
const name = '/ntc-example-frame'; // use a unique name for every pending frame
const pixels = new Uint8Array([255, 0, 0, 255]); // one red pixel
const registry = globalThis.ghosttyKittySharedMemory;
if (registry) {
  registry.set(name, pixels);
  term.write(`\x1b_Ga=T,t=s,f=32,s=1,v=1,S=4,i=7,c=1,r=1,q=2;${btoa(name)}\x1b\\`);
}
```

The terminal copies and deletes the entry while processing the command. Missing
names and invalid sizes fail without a response when `q=2`. Buffers must match
`S` exactly, or the format-derived size when `S` is absent; this browser hook
reads whole objects and rejects non-zero `O` offsets. Normal Kitty pixel-format
and dimension validation still applies. Producers must remove entries for frames
they discard before writing the command.

Ship the matching JavaScript bundle and `ghostty-vt.wasm` together. This registry
is a browser convention; it does not create operating-system shared memory.

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
