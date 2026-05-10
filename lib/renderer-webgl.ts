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
import { DEFAULT_THEME } from './renderer-core';
import {
  type AtlasSlot,
  CELL_U32S,
  GlyphAtlasBase,
  KittyAtlasBase,
  KittyTextureCacheBase,
  buildGridUBOBytes,
  buildPaletteUBOBytes,
  encodeCells as coreEncodeCells,
  measureFont as coreMeasureFont,
  parseHexColor as coreParseHexColor,
} from './renderer-core';
import type { GridUBOState } from './renderer-core';
import type {
  FontMetrics,
  IRenderable,
  IScrollbackProvider,
  LinkRange,
  Renderer,
  RendererOptions,
} from './renderer-types';
import type { SelectionManager } from './selection-manager';

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
const uint FLAG_IS_KITTY_PLACEHOLDER = 1u << 11;
const uint FLAG_USE_THEME_FG = 1u << 12;
const uint FLAG_USE_THEME_BG = 1u << 13;
const uint FLAG_IS_CURSOR_CELL = 1u << 14;
uniform highp usampler2D uCellTex;
uniform highp sampler2D uAtlasTex;
uniform highp sampler2D uKittyAtlas;
layout(std140) uniform KittyAtlasUBO {
  vec4 rects[256];
} kittyAtlas;
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
  if ((flags & FLAG_IS_KITTY_PLACEHOLDER) != 0u) {
    // Slice + grid encoded in c1.y / c1.w (was blockOrSlice / _r in WGSL).
    uint sliceCol = c1.y & 0xffffu;
    uint sliceRow = (c1.y >> 16) & 0xffffu;
    uint gridCols = c1.w & 0xffffu;
    uint gridRows = (c1.w >> 16) & 0xffffu;
    float uvX = (float(sliceCol) + vUv.x) / float(gridCols);
    float uvY = (float(sliceRow) + vUv.y) / float(gridRows);
    // c1.z holds the kittyImageIndex (0..255). Look up the atlas rect for that index.
    uint imgIdx = c1.z;
    vec4 rect = kittyAtlas.rects[imgIdx];  // (uMin, vMin, uMax, vMax) in atlas-normalized coords
    vec2 atlasUv = mix(rect.xy, rect.zw, vec2(uvX, uvY));
    fragColor = texture(uKittyAtlas, atlasUv);
    return;
  }
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

const KITTY_VS = `#version 300 es
precision highp float;
precision highp int;
layout(std140) uniform KittyParamsUBO {
  vec2 srcOrigin;
  vec2 srcSize;
  vec2 dstOrigin;
  vec2 dstSize;
  vec2 imgSize;
  vec2 canvasSize;
} kp;
out vec2 vUv;
const vec2 CORNERS[6] = vec2[6](
  vec2(0.0, 0.0), vec2(1.0, 0.0), vec2(1.0, 1.0),
  vec2(0.0, 0.0), vec2(1.0, 1.0), vec2(0.0, 1.0)
);
void main() {
  vec2 local = CORNERS[gl_VertexID];
  float cssX = kp.dstOrigin.x + local.x * kp.dstSize.x;
  float cssY = kp.dstOrigin.y + local.y * kp.dstSize.y;
  gl_Position = vec4(
    (cssX / kp.canvasSize.x) * 2.0 - 1.0,
    1.0 - (cssY / kp.canvasSize.y) * 2.0,
    0.0, 1.0
  );
  vUv = (kp.srcOrigin + local * kp.srcSize) / kp.imgSize;
}
`;

const KITTY_FS = `#version 300 es
precision highp float;
precision highp int;
uniform highp sampler2D uKittyImg;
in vec2 vUv;
out vec4 fragColor;
void main() {
  fragColor = texture(uKittyImg, vUv);
}
`;

export class GLGlyphAtlas extends GlyphAtlasBase {
  private gl: WebGL2RenderingContext;
  private texture: WebGLTexture;

  constructor(
    gl: WebGL2RenderingContext,
    cellW: number,
    cellH: number,
    fontSize: number,
    fontFamily: string
  ) {
    super(cellW, cellH, fontSize, fontFamily);
    this.gl = gl;
    const tex = this.createBackingTexture(this.size);
    if (!tex) throw new Error('GLGlyphAtlas: createTexture failed');
    this.texture = tex;
  }

  glTexture(): WebGLTexture {
    return this.texture;
  }

  destroy(): void {
    this.gl.deleteTexture(this.texture);
  }

  private createBackingTexture(size: number): WebGLTexture | null {
    const gl = this.gl;
    const tex = gl.createTexture();
    if (!tex) return null;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, size, size);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return tex;
  }

  protected uploadRegion(slot: AtlasSlot, rgba: Uint8ClampedArray, w: number, h: number): void {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.pixelStorei(/* UNPACK_ALIGNMENT */ 0x0cf5, 1);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, slot.u, slot.v, w, h, gl.RGBA, gl.UNSIGNED_BYTE, rgba);
  }

  protected growTexture(newSize: number): void {
    const newTex = this.createBackingTexture(newSize);
    if (!newTex) {
      console.warn('[ghostty-web] GLGlyphAtlas: grow() failed; keeping existing atlas');
      return;
    }
    this.gl.deleteTexture?.(this.texture);
    this.texture = newTex;
  }
}

class GLKittyTextureCache extends KittyTextureCacheBase<WebGLTexture> {
  constructor(private gl: WebGL2RenderingContext) {
    super();
  }
  protected createTexture(width: number, height: number): WebGLTexture | null {
    const gl = this.gl;
    const tex = gl.createTexture();
    if (!tex) return null;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, width, height);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return tex;
  }
  protected uploadFull(
    handle: WebGLTexture,
    rgba: Uint8Array,
    width: number,
    height: number
  ): void {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, handle);
    gl.pixelStorei(/* UNPACK_ALIGNMENT */ 0x0cf5, 1);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, rgba);
  }
  protected destroyTexture(handle: WebGLTexture): void {
    this.gl.deleteTexture(handle);
  }
}

class GLKittyAtlas extends KittyAtlasBase {
  private gl: WebGL2RenderingContext;
  private texture: WebGLTexture;

  constructor(gl: WebGL2RenderingContext, size = 1024) {
    super(size);
    this.gl = gl;
    const tex = gl.createTexture();
    if (!tex) throw new Error('GLKittyAtlas: createTexture failed');
    this.texture = tex;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, size, size);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  }

  glTexture(): WebGLTexture {
    return this.texture;
  }

  destroy(): void {
    this.gl.deleteTexture(this.texture);
  }

  protected uploadRegion(
    slot: { u: number; v: number; w: number; h: number },
    rgba: Uint8Array,
    w: number,
    h: number
  ): void {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.pixelStorei(/* UNPACK_ALIGNMENT */ 0x0cf5, 1);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, slot.u, slot.v, w, h, gl.RGBA, gl.UNSIGNED_BYTE, rgba);
  }

  protected growTexture(_newSize: number): void {
    // v1: never grows; clearAndReset reuses the existing texture.
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

  // Frame-skip state. See WebGPURenderer for the full rationale; same
  // mechanism, same trade-offs.
  private lastCursorX = -1;
  private lastCursorY = -1;
  private lastCursorVisible = false;
  private lastCursorBlinkVisible = true;
  private lastViewportYRendered = Number.NaN;
  private lastSelectionSig: string | null = null;
  private lastKittyPlacementSig: string | null = null;
  private cellArray = new Uint32Array(0);
  private atlas?: GLGlyphAtlas;
  private kittyAtlas?: GLKittyAtlas;
  private kittyTextures!: GLKittyTextureCache;
  private paletteUBO?: WebGLBuffer; // 384 B
  private gridUBO?: WebGLBuffer; // 80 B
  private kittyAtlasUBO?: WebGLBuffer; // 4096 B (256 vec4)
  private kittyAtlasRects = new Float32Array(256 * 4); // host-side staging (256 vec4)
  private cellTex?: WebGLTexture;
  private cellTexW = 0;
  private cellTexH = 0;
  private textProgram?: WebGLProgram;
  private cursorProgram?: WebGLProgram;
  private kittyProgram?: WebGLProgram;
  private textProgramUniforms = {
    cellTex: null as WebGLUniformLocation | null,
    atlasTex: null as WebGLUniformLocation | null,
  };
  private kittyProgramUniforms = {
    kittyImg: null as WebGLUniformLocation | null,
  };
  private kittyParamsRing: WebGLBuffer[] = [];
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
    this.kittyTextures = new GLKittyTextureCache(this.gl);

    this.paletteUBO = gl.createBuffer() ?? undefined;
    if (!this.paletteUBO) throw new Error('WebGL2Renderer: createBuffer failed (paletteUBO)');
    gl.bindBuffer(gl.UNIFORM_BUFFER, this.paletteUBO);
    gl.bufferData(gl.UNIFORM_BUFFER, 384, gl.DYNAMIC_DRAW);

    this.gridUBO = gl.createBuffer() ?? undefined;
    if (!this.gridUBO) throw new Error('WebGL2Renderer: createBuffer failed (gridUBO)');
    gl.bindBuffer(gl.UNIFORM_BUFFER, this.gridUBO);
    gl.bufferData(gl.UNIFORM_BUFFER, 80, gl.DYNAMIC_DRAW);

    this.kittyAtlasUBO = gl.createBuffer() ?? undefined;
    if (!this.kittyAtlasUBO) throw new Error('WebGL2Renderer: createBuffer failed (kittyAtlasUBO)');
    gl.bindBuffer(gl.UNIFORM_BUFFER, this.kittyAtlasUBO);
    gl.bufferData(gl.UNIFORM_BUFFER, 256 * 4 * 4, gl.DYNAMIC_DRAW);

    // Upload initial palette (theme already merged in constructor).
    this.uploadPaletteUBO();

    this.setupTextProgram();
    this.setupCursorProgram();
    this.setupKittyProgram();

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
    // UBO bindings: index 0 = grid, index 1 = palette, index 2 = kitty atlas.
    const gridIdx = gl.getUniformBlockIndex(prog, 'GridUBO');
    const palIdx = gl.getUniformBlockIndex(prog, 'PaletteUBO');
    gl.uniformBlockBinding(prog, gridIdx, 0);
    gl.uniformBlockBinding(prog, palIdx, 1);
    gl.uniformBlockBinding(prog, gl.getUniformBlockIndex(prog, 'KittyAtlasUBO'), 2);
    // Texture-sampler uniform locations.
    this.textProgramUniforms.cellTex = gl.getUniformLocation(prog, 'uCellTex');
    this.textProgramUniforms.atlasTex = gl.getUniformLocation(prog, 'uAtlasTex');
    // Bind sampler texture units (0 = cellTex, 1 = atlasTex, 2 = kitty atlas).
    gl.useProgram(prog);
    gl.uniform1i(this.textProgramUniforms.cellTex, 0);
    gl.uniform1i(this.textProgramUniforms.atlasTex, 1);
    const kittyAtlasLoc = gl.getUniformLocation(prog, 'uKittyAtlas');
    gl.uniform1i(kittyAtlasLoc, 2);
  }

  private setupCursorProgram(): void {
    const gl = this.gl;
    const prog = this.buildProgram(CURSOR_VS, CURSOR_FS, 'cursor');
    this.cursorProgram = prog;
    gl.uniformBlockBinding(prog, gl.getUniformBlockIndex(prog, 'GridUBO'), 0);
    gl.uniformBlockBinding(prog, gl.getUniformBlockIndex(prog, 'PaletteUBO'), 1);
  }

  private setupKittyProgram(): void {
    const gl = this.gl;
    const prog = this.buildProgram(KITTY_VS, KITTY_FS, 'kitty');
    this.kittyProgram = prog;
    // KittyParamsUBO is bound to slot 0 (kitty pipeline's only block).
    gl.uniformBlockBinding(prog, gl.getUniformBlockIndex(prog, 'KittyParamsUBO'), 0);
    this.kittyProgramUniforms.kittyImg = gl.getUniformLocation(prog, 'uKittyImg');
    gl.useProgram(prog);
    gl.uniform1i(this.kittyProgramUniforms.kittyImg, 0);
  }

  private ensureKittyRingSize(n: number): void {
    const gl = this.gl;
    while (this.kittyParamsRing.length < n) {
      const buf = gl.createBuffer();
      if (!buf) throw new Error('WebGL2Renderer: createBuffer failed (kittyParamsRing)');
      gl.bindBuffer(gl.UNIFORM_BUFFER, buf);
      gl.bufferData(gl.UNIFORM_BUFFER, 64, gl.DYNAMIC_DRAW); // 16 floats
      this.kittyParamsRing.push(buf);
    }
  }

  private parseHexColor(hex: string): [number, number, number] {
    return coreParseHexColor(hex);
  }

  // -------- Cell encoding --------

  private encodeCells(
    buffer: IRenderable,
    viewportY: number,
    sb?: IScrollbackProvider
  ): { cellArray: Uint32Array; usedKittyImageIds: number[] } {
    const { usedKittyImageIds } = coreEncodeCells(this.cellArray, buffer, viewportY, sb, {
      metrics: this.metrics,
      selectionManager: this.selectionManager,
      hoveredHyperlinkId: this.hoveredHyperlinkId,
      hoveredLinkRange: this.hoveredLinkRange,
      cursorStyle: this.cursorStyle,
      cursorBlinkVisible: this.cursorBlink_.isVisible(),
      atlas: this.atlas,
      kittyEnabled: true,
      blockElementShaderEnabled: false,
      maxKittyImages: 256,
    });
    return { cellArray: this.cellArray, usedKittyImageIds };
  }

  // -------- UBO upload --------

  private uploadPaletteUBO(): void {
    if (!this.paletteUBO) return;
    const gl = this.gl;
    const data = buildPaletteUBOBytes(this.theme);
    gl.bindBuffer(gl.UNIFORM_BUFFER, this.paletteUBO);
    gl.bufferSubData(gl.UNIFORM_BUFFER, 0, data);
  }

  private uploadGridUBO(
    _viewportY: number,
    cursor: { x: number; y: number; visible: boolean }
  ): void {
    if (!this.gridUBO) return;
    const gl = this.gl;
    const u32 = buildGridUBOBytes({
      cols: this.cols,
      rows: this.rows,
      cellWidth: this.metrics.width,
      cellHeight: this.metrics.height,
      dpr: this.dpr,
      cursorX: cursor.x,
      cursorY: cursor.y,
      cursorVisible: cursor.visible,
      cursorBlinkVisible: this.cursorBlink_.isVisible(),
      cursorStyle: this.cursorStyle,
      atlasSize: this.atlas?.atlasSize ?? 1024,
    } satisfies GridUBOState);
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

    if (!this.kittyAtlas) {
      this.kittyAtlas = new GLKittyAtlas(this.gl);
    }
    // Note: the kitty atlas is fixed-size and persists across resizes.

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

  /** See WebGPURenderer.bufferAnyDirty. */
  private bufferAnyDirty(buffer: IRenderable): boolean {
    if (buffer.needsFullRedraw?.()) return true;
    for (let y = 0; y < this.rows; y++) {
      if (buffer.isRowDirty(y)) return true;
    }
    return false;
  }

  /** See WebGPURenderer.computeSelectionSig. */
  private computeSelectionSig(): string | null {
    const sel = this.selectionManager?.getSelectionCoords() ?? null;
    if (!sel) return null;
    return `${sel.startRow},${sel.startCol}-${sel.endRow},${sel.endCol}`;
  }

  /** See WebGPURenderer.computeKittyPlacementSig. */
  private computeKittyPlacementSig(buffer: IRenderable): string | null {
    if (!buffer.getKittyGraphics || !buffer.iterPlacements) return null;
    const graphics = buffer.getKittyGraphics();
    if (graphics === null) return null;
    let sig = '';
    for (const p of buffer.iterPlacements(graphics, false)) {
      const pixels = buffer.getKittyImagePixels?.(graphics, p.imageId);
      sig += `${p.imageId}|${p.isVirtual ? 1 : 0}|${p.viewportCol},${p.viewportRow}|${p.pixelWidth}x${p.pixelHeight}|${p.sourceX},${p.sourceY},${p.sourceWidth}x${p.sourceHeight}|${pixels?.width ?? 0}x${pixels?.height ?? 0}|${pixels?.format ?? 0}|${pixels?.data.byteOffset ?? 0}+${pixels?.data.length ?? 0};`;
    }
    return sig;
  }

  render(buffer: IRenderable, viewportY: number = 0, sb?: IScrollbackProvider): void {
    if (this.cols === 0 || this.rows === 0) return;
    const gl = this.gl;
    const cursor = buffer.getCursor();

    // Frame-skip gate. See WebGPURenderer.render() for rationale.
    const cursorBlinkVisible = this.cursorBlink_.isVisible();
    let stateChanged =
      this.invalidateNext ||
      cursor.x !== this.lastCursorX ||
      cursor.y !== this.lastCursorY ||
      cursor.visible !== this.lastCursorVisible ||
      cursorBlinkVisible !== this.lastCursorBlinkVisible ||
      viewportY !== this.lastViewportYRendered ||
      this.bufferAnyDirty(buffer);
    const selSig = stateChanged ? null : this.computeSelectionSig();
    if (!stateChanged && selSig !== this.lastSelectionSig) stateChanged = true;
    const kittySig = stateChanged ? null : this.computeKittyPlacementSig(buffer);
    if (!stateChanged && kittySig !== this.lastKittyPlacementSig) stateChanged = true;
    if (!stateChanged) return;

    this.lastCursorX = cursor.x;
    this.lastCursorY = cursor.y;
    this.lastCursorVisible = cursor.visible;
    this.lastCursorBlinkVisible = cursorBlinkVisible;
    this.lastViewportYRendered = viewportY;
    this.lastSelectionSig = selSig ?? this.computeSelectionSig();
    this.lastKittyPlacementSig = kittySig ?? this.computeKittyPlacementSig(buffer);

    const { usedKittyImageIds } = this.encodeCells(buffer, viewportY, sb);
    this.uploadGridUBO(viewportY, cursor);

    // Update kitty atlas for any virtual-placement images used this frame, and
    // build the rect lookup table for the text shader.
    this.kittyAtlasRects.fill(0);
    const kittyGraphics = buffer.getKittyGraphics?.() ?? null;
    if (kittyGraphics !== null && this.kittyAtlas && usedKittyImageIds.length > 0) {
      for (let i = 0; i < usedKittyImageIds.length; i++) {
        const id = usedKittyImageIds[i]!;
        const pixels = buffer.getKittyImagePixels?.(kittyGraphics, id);
        if (!pixels) continue;
        const entry = this.kittyAtlas.addOrUpdate(id, pixels);
        if (!entry) continue;
        const size = this.kittyAtlas.atlasSize;
        this.kittyAtlasRects[i * 4 + 0] = entry.slot.u / size;
        this.kittyAtlasRects[i * 4 + 1] = entry.slot.v / size;
        this.kittyAtlasRects[i * 4 + 2] = (entry.slot.u + entry.slot.w) / size;
        this.kittyAtlasRects[i * 4 + 3] = (entry.slot.v + entry.slot.h) / size;
      }
    }
    if (this.kittyAtlasUBO) {
      gl.bindBuffer(gl.UNIFORM_BUFFER, this.kittyAtlasUBO);
      gl.bufferSubData(gl.UNIFORM_BUFFER, 0, this.kittyAtlasRects);
    }

    // Direct kitty placements pre-walk (must happen before draw, so the params
    // UBOs are already populated by the time we issue the kitty draw loop).
    const directPlacements: Array<{ params: Float32Array; tex: WebGLTexture }> = [];
    if (kittyGraphics !== null && buffer.iterPlacements) {
      const cssW = this.cols * this.metrics.width;
      const cssH = this.rows * this.metrics.height;
      for (const p of buffer.iterPlacements(kittyGraphics, true)) {
        if (p.isVirtual) continue;
        const pixels = buffer.getKittyImagePixels?.(kittyGraphics, p.imageId);
        if (!pixels) continue;
        const tex = this.kittyTextures.getOrUpload(p.imageId, pixels);
        if (!tex) continue;
        const params = new Float32Array(16);
        params[0] = p.sourceX;
        params[1] = p.sourceY;
        params[2] = p.sourceWidth;
        params[3] = p.sourceHeight;
        params[4] = p.viewportCol * this.metrics.width;
        params[5] = p.viewportRow * this.metrics.height;
        params[6] = p.pixelWidth;
        params[7] = p.pixelHeight;
        params[8] = pixels.width;
        params[9] = pixels.height;
        params[10] = cssW;
        params[11] = cssH;
        directPlacements.push({ params, tex });
      }
    }
    this.ensureKittyRingSize(directPlacements.length);
    for (let i = 0; i < directPlacements.length; i++) {
      gl.bindBuffer(gl.UNIFORM_BUFFER, this.kittyParamsRing[i]!);
      gl.bufferSubData(gl.UNIFORM_BUFFER, 0, directPlacements[i]!.params);
    }

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
      this.paletteUBO &&
      this.kittyAtlas &&
      this.kittyAtlasUBO
    ) {
      gl.useProgram(this.textProgram);
      gl.bindVertexArray(this.vao);
      gl.bindBufferBase(gl.UNIFORM_BUFFER, 0, this.gridUBO);
      gl.bindBufferBase(gl.UNIFORM_BUFFER, 1, this.paletteUBO);
      gl.bindBufferBase(gl.UNIFORM_BUFFER, 2, this.kittyAtlasUBO);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.cellTex);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, this.atlas.glTexture());
      gl.activeTexture(gl.TEXTURE2);
      gl.bindTexture(gl.TEXTURE_2D, this.kittyAtlas.glTexture());
      gl.disable(gl.BLEND); // text pass overwrites
      gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, this.cols * this.rows);
    }

    // Direct kitty placements — draw between text and cursor so images sit over
    // text but under the cursor (matches WebGPU ordering).
    if (this.kittyProgram && directPlacements.length > 0) {
      gl.useProgram(this.kittyProgram);
      gl.bindVertexArray(this.vao!);
      gl.enable(gl.BLEND);
      gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      gl.blendEquation(gl.FUNC_ADD);
      for (let i = 0; i < directPlacements.length; i++) {
        gl.bindBufferBase(gl.UNIFORM_BUFFER, 0, this.kittyParamsRing[i]!);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, directPlacements[i]!.tex);
        gl.drawArrays(gl.TRIANGLES, 0, 6);
      }
      gl.disable(gl.BLEND);
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
    // Kitty resources
    this.kittyAtlas?.destroy();
    this.kittyTextures.destroyAll();
    if (this.kittyAtlasUBO) this.gl.deleteBuffer(this.kittyAtlasUBO);
    if (this.kittyProgram) this.gl.deleteProgram(this.kittyProgram);
    for (const buf of this.kittyParamsRing) this.gl.deleteBuffer(buf);
    this.kittyParamsRing.length = 0;
    // Text + cursor + glyph atlas + cell texture
    if (this.paletteUBO) this.gl.deleteBuffer(this.paletteUBO);
    if (this.gridUBO) this.gl.deleteBuffer(this.gridUBO);
    if (this.cellTex) this.gl.deleteTexture(this.cellTex);
    this.atlas?.destroy();
    if (this.textProgram) this.gl.deleteProgram(this.textProgram);
    if (this.cursorProgram) this.gl.deleteProgram(this.cursorProgram);
    if (this.vao) this.gl.deleteVertexArray(this.vao);
    // The WebGL context itself isn't explicitly deletable; it dies when the
    // canvas is GC'd. Our renderer-swap path detaches the canvas so GC can
    // reclaim it.
  }

  /** T13 will register a callback fired on webglcontextlost. */
  onContextLost(fn: (info: { reason: string }) => void): void {
    this.contextLostListeners.push(fn);
  }
}
