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
import { DEFAULT_THEME } from './renderer';
import type {
  FontMetrics,
  IRenderable,
  IScrollbackProvider,
  LinkRange,
  Renderer,
  RendererOptions,
} from './renderer-types';
import type { SelectionManager } from './selection-manager';
import { CellFlags } from './types';
import {
  CELL_BYTES,
  CELL_U32S,
  FLAG_BOLD,
  FLAG_ITALIC,
  FLAG_UNDERLINE,
  FLAG_STRIKETHROUGH,
  FLAG_INVERSE,
  FLAG_FAINT,
  FLAG_INVISIBLE,
  FLAG_IS_SELECTED,
  FLAG_IS_HYPERLINK_HOVERED,
  FLAG_IS_LINK_RANGE_HOVERED,
  FLAG_USE_THEME_FG,
  FLAG_USE_THEME_BG,
  FLAG_IS_CURSOR_CELL,
  measureFont as coreMeasureFont,
  parseHexColor as coreParseHexColor,
} from './renderer-core';

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
uniform highp sampler2D uAtlasTex;
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
  if (grid.cursorStyle == 0u) { fragColor = vec4(0.0); return; } // block handled in textPass
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
    gl.texSubImage2D(gl.TEXTURE_2D, 0, slot.u, slot.v, w, h, gl.RGBA, gl.UNSIGNED_BYTE, img.data);
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
    // We do not preserve old contents on grow. The WebGPU path uses
    // copyTextureToTexture; we instead clear the cache + packing cursor
    // and let getOrRaster re-rasterize each glyph on next miss. Simpler;
    // callers see the same logical behavior at the cost of one cycle of
    // re-rasterization right after a grow event.
    this.cache.clear();
    this.nextX = 0;
    this.nextY = 0;
    this.rowHeight = 0;
    gl.deleteTexture?.(this.texture);
    this.texture = newTex;
    this.size = newSize;
  }

  get atlasSize(): number {
    return this.size;
  }
}

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
  private cellArray = new Uint32Array(0);
  private atlas?: GLGlyphAtlas;
  private paletteUBO?: WebGLBuffer; // 384 B
  private gridUBO?: WebGLBuffer; // 80 B
  private cellTex?: WebGLTexture;
  private cellTexW = 0;
  private cellTexH = 0;
  private textProgram?: WebGLProgram;
  private cursorProgram?: WebGLProgram;
  private textProgramUniforms = {
    cellTex: null as WebGLUniformLocation | null,
    atlasTex: null as WebGLUniformLocation | null,
  };
  private vao?: WebGLVertexArrayObject;

  static async create(canvas: HTMLCanvasElement, opts: RendererOptions): Promise<WebGL2Renderer> {
    const r = new WebGL2Renderer(canvas, opts);
    await r.initialize();
    return r;
  }

  private constructor(canvas: HTMLCanvasElement, opts: RendererOptions) {
    this.canvas = canvas;
    this.fontSize = opts.fontSize ?? 15;
    this.fontFamily = opts.fontFamily ?? 'monospace';
    this.cursorStyle = opts.cursorStyle ?? 'block';
    this.dpr =
      opts.devicePixelRatio ?? (typeof window !== 'undefined' ? window.devicePixelRatio : 1) ?? 1;
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

    this.paletteUBO = gl.createBuffer() ?? undefined;
    if (!this.paletteUBO) throw new Error('WebGL2Renderer: createBuffer failed (paletteUBO)');
    gl.bindBuffer(gl.UNIFORM_BUFFER, this.paletteUBO);
    gl.bufferData(gl.UNIFORM_BUFFER, 384, gl.DYNAMIC_DRAW);

    this.gridUBO = gl.createBuffer() ?? undefined;
    if (!this.gridUBO) throw new Error('WebGL2Renderer: createBuffer failed (gridUBO)');
    gl.bindBuffer(gl.UNIFORM_BUFFER, this.gridUBO);
    gl.bufferData(gl.UNIFORM_BUFFER, 80, gl.DYNAMIC_DRAW);

    // Upload initial palette (theme already merged in constructor).
    this.uploadPaletteUBO();

    this.setupTextProgram();
    this.setupCursorProgram();

    const vao = gl.createVertexArray();
    if (!vao) throw new Error('WebGL2Renderer: createVertexArray failed');
    this.vao = vao;

    this.metrics = this.measureFont();
    this.canvas.addEventListener('webglcontextlost', (e) => {
      if (this.destroyed) return;
      e.preventDefault();
      const info = { reason: 'webglcontextlost' };
      console.error('[ghostty-web] WebGL context lost');
      for (const fn of this.contextLostListeners) fn(info);
    });
  }

  // -------- Font metrics --------

  private measureFont(): FontMetrics {
    return coreMeasureFont(this.fontSize, this.fontFamily);
  }

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
      gl.deleteShader(vsObj);
      gl.deleteShader(fsObj);
      gl.deleteProgram(prog);
      throw new Error(`buildProgram(${label}) link failed: ${info}`);
    }
    gl.deleteShader(vsObj);
    gl.deleteShader(fsObj);
    return prog;
  }

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

  private setupCursorProgram(): void {
    const gl = this.gl;
    const prog = this.buildProgram(CURSOR_VS, CURSOR_FS, 'cursor');
    this.cursorProgram = prog;
    gl.uniformBlockBinding(prog, gl.getUniformBlockIndex(prog, 'GridUBO'), 0);
    gl.uniformBlockBinding(prog, gl.getUniformBlockIndex(prog, 'PaletteUBO'), 1);
  }

  private parseHexColor(hex: string): [number, number, number] {
    return coreParseHexColor(hex);
  }

  // -------- Cell encoding --------

  private encodeCells(
    buffer: IRenderable,
    viewportY: number,
    sb?: IScrollbackProvider
  ): Uint32Array {
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

    if (cursor.visible && this.cursorBlink_.isVisible() && this.cursorStyle === 'block') {
      const ci = (cursor.y * dims.cols + cursor.x) * CELL_U32S;
      arr[ci + 4] = (arr[ci + 4]! | FLAG_IS_CURSOR_CELL) >>> 0;
    }
    return arr;
  }

  // -------- UBO byte builders --------

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
    w(0, t.black);
    w(1, t.red);
    w(2, t.green);
    w(3, t.yellow);
    w(4, t.blue);
    w(5, t.magenta);
    w(6, t.cyan);
    w(7, t.white);
    w(8, t.brightBlack);
    w(9, t.brightRed);
    w(10, t.brightGreen);
    w(11, t.brightYellow);
    w(12, t.brightBlue);
    w(13, t.brightMagenta);
    w(14, t.brightCyan);
    w(15, t.brightWhite);
    w(16, t.foreground);
    w(17, t.background);
    w(18, t.cursor);
    w(19, t.cursorAccent);
    w(20, t.selectionBackground);
    w(21, t.selectionForeground);
    w(22, '#4A90E2');
    // 23 reserved (zeroed by Float32Array constructor)
    return data;
  }

  private buildGridUBOBytes(
    _viewportY: number,
    cursor: { x: number; y: number; visible: boolean }
  ): Uint32Array {
    // 80 B = 20 × u32. Layout matches the WGSL GridUBO struct in
    // renderer-webgpu.ts (TEXT_SHADER:40-50). Float fields use a Float32Array
    // view aliased over the same buffer.
    const u32 = new Uint32Array(20);
    const f32 = new Float32Array(u32.buffer);
    u32[0] = this.cols; // gridSize.x
    u32[1] = this.rows; // gridSize.y
    f32[2] = this.metrics.width; // cellSize.x
    f32[3] = this.metrics.height; // cellSize.y
    f32[4] = this.dpr; // devicePixelRatio
    u32[5] = cursor.visible && this.cursorBlink_.isVisible() ? 1 : 0; // cursorVisible
    u32[6] = cursor.x; // cursorPos.x
    u32[7] = cursor.y; // cursorPos.y
    u32[8] = this.cursorStyle === 'block' ? 0 : this.cursorStyle === 'underline' ? 1 : 2;
    u32[9] = 0; // _pad0
    u32[10] = this.atlas?.atlasSize ?? 1024; // atlasSize
    // u32[11..19] reserved
    return u32;
  }

  private uploadPaletteUBO(): void {
    if (!this.paletteUBO) return;
    const gl = this.gl;
    const data = this.buildPaletteUBOBytes();
    gl.bindBuffer(gl.UNIFORM_BUFFER, this.paletteUBO);
    gl.bufferSubData(gl.UNIFORM_BUFFER, 0, data);
  }

  private uploadGridUBO(
    viewportY: number,
    cursor: { x: number; y: number; visible: boolean }
  ): void {
    if (!this.gridUBO) return;
    const gl = this.gl;
    const u32 = this.buildGridUBOBytes(viewportY, cursor);
    gl.bindBuffer(gl.UNIFORM_BUFFER, this.gridUBO);
    gl.bufferSubData(gl.UNIFORM_BUFFER, 0, u32);
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

    const desiredW = Math.max(1, cols * 2);
    const desiredH = Math.max(1, rows);
    if (!this.cellTex || this.cellTexW !== desiredW || this.cellTexH !== desiredH) {
      if (this.cellTex) this.gl.deleteTexture(this.cellTex);
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
  }

  render(buffer: IRenderable, viewportY: number = 0, sb?: IScrollbackProvider): void {
    if (this.cols === 0 || this.rows === 0) return;
    const gl = this.gl;
    const cursor = buffer.getCursor();
    this.encodeCells(buffer, viewportY, sb);
    this.uploadGridUBO(viewportY, cursor);

    // Cell texture upload.
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

    // Clear default framebuffer.
    const [tr, tg, tb] = this.parseHexColor(this.theme.background);
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.clearColor(tr / 255, tg / 255, tb / 255, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);

    // Text pass.
    if (
      this.textProgram &&
      this.vao &&
      this.cellTex &&
      this.atlas &&
      this.gridUBO &&
      this.paletteUBO
    ) {
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

    buffer.clearDirty();
    this.invalidateNext = false;
  }

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
    this.atlas?.reset(this.metrics.width, this.metrics.height, this.fontSize, this.fontFamily);
    this.invalidateNext = true;
  }

  destroy(): void {
    this.destroyed = true;
    this.cursorBlink_.destroy();
    // Known resource leak (v1): the renderer does not free its GL buffers,
    // textures, programs, or VAO on destroy. Acceptable in practice because
    // the canvas is typically GC'd shortly after destroy() and WebGL drivers
    // reclaim resources when the context is collected. Tracked as follow-up.
  }

  /** T13 will register a callback fired on webglcontextlost. */
  onContextLost(fn: (info: { reason: string }) => void): void {
    this.contextLostListeners.push(fn);
  }
}
