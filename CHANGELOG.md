# Changelog

## Unreleased

### Fixed

- Repaint Canvas2D image revisions even when terminal cells are unchanged.
  Read each viewport and image once per frame, and avoid repeated canvas
  clears at fractional display scaling.

- Keep valid image placeholders out of the font fallback while their image
  placement is unavailable, preventing grids of missing-glyph boxes.

- Honor synchronized output (DEC mode 2026) across split writes and input
  echoes, so partial screen updates are never painted. A one-second timeout
  releases an interrupted hold; disposal cancels the timer.

- Redraw retransmitted Kitty images when WASM reuses a pixel allocation.
  Graphics revisions invalidate Canvas2D, WebGL and WebGPU caches; ordinary
  text writes retain cached images. Same-size atlas updates reuse their slot.

### Added

- `installRendererHud(terminal, opts?)` and `parseRendererFromURL()` — lift
  the demo's renderer-info HUD (active backend + live FPS, click-to-cycle,
  `Alt+Shift+R` cycling) into the public API. The default cycle covers all
  three concrete backends (`webgpu` → `webgl` → `canvas2d`); pass `cycle` to
  customize.

### Changed

- The HUD's badge id changed from `booba-renderer-hud` to
  `ghostty-renderer-hud`. Consumers that targeted the old id by selector
  must update. (booba's HUD did not expose this id externally.)
- `demo/index.html` migrated to the new public API; the inline
  `installFpsOverlay` helper and inline keydown handler were removed.
- The new `Alt+Shift+R` hotkey binds on `e.code === 'KeyR'` rather than
  `e.key === 'R'`, fixing a silent failure on macOS where `Option` transforms
  `R` into a dead-key character before keydown fires.
