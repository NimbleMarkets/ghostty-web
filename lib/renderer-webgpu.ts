/**
 * WebGPU renderer. Implementation grows across Tasks 6–16:
 *
 * - Task 6:  device init, configure() the canvas context, empty render pass that clears to theme.background
 * - Task 7:  paletteUBO, gridUBO, cellBuffer alloc/write
 * - Task 8:  glyph atlas (raster + texture upload)
 * - Task 9:  textPass shader — ASCII glyphs with fg/bg
 * - Task 10: style flags
 * - Task 11: selection coloring
 * - Task 12: link underlines
 * - Task 13: block elements
 * - Task 14: cursor pass + blink wiring
 * - Task 15: kitty direct placements
 * - Task 16: kitty virtual placements (U+10EEEE)
 * - Phase B: migrate virtual placements to shared KittyAtlasBase; drop requiredLimits
 */

import { CursorBlink } from './cursor-blink';
import type { ITheme } from './interfaces';
import type { SelectionManager } from './selection-manager';
import { DEFAULT_THEME } from './renderer';
import type {
  FontMetrics,
  IRenderable,
  IScrollbackProvider,
  LinkRange,
  Renderer,
  RendererOptions,
} from './renderer-types';
import {
  CELL_BYTES,
  CELL_U32S,
  measureFont as coreMeasureFont,
  parseHexColor as coreParseHexColor,
  buildPaletteUBOBytes,
  buildGridUBOBytes,
  GlyphAtlasBase,
  encodeCells as coreEncodeCells,
  type AtlasSlot,
  KittyTextureCacheBase,
  KittyAtlasBase,
} from './renderer-core';
import type { GridUBOState } from './renderer-core';

// ---------------------------------------------------------------------------
// TEXT_SHADER
// ---------------------------------------------------------------------------

const TEXT_SHADER = /* wgsl */ `
struct GridUBO {
  gridSize: vec2<u32>,
  cellSize: vec2<f32>,
  dpr: f32,
  cursorVisible: u32,
  cursorPos: vec2<u32>,
  cursorStyle: u32,
  _pad0: f32,
  atlasSize: u32,
  _pad1: vec3<u32>,
};

struct PaletteUBO {
  ansi: array<vec4<f32>, 16>,
  defaultFg: vec4<f32>,
  defaultBg: vec4<f32>,
  cursorBg: vec4<f32>,
  cursorFg: vec4<f32>,
  selectionBg: vec4<f32>,
  selectionFg: vec4<f32>,
  linkUnderlineColor: vec4<f32>,
  _pad: vec4<f32>,
};

struct Cell {
  fg: u32,
  bg: u32,
  atlasUV: u32,
  atlasSize: u32,
  flags: u32,
  blockOrSlice: u32,
  kittyTexIndex: u32,
  _r: u32,
};

@group(0) @binding(0) var<uniform> grid: GridUBO;
@group(0) @binding(1) var<uniform> pal: PaletteUBO;
@group(0) @binding(2) var<storage, read> cells: array<Cell>;
@group(0) @binding(3) var atlasTex: texture_2d<f32>;
@group(0) @binding(4) var atlasSamp: sampler;
@group(0) @binding(5) var kittyAtlas: texture_2d<f32>;
@group(0) @binding(6) var kittySamp: sampler;

struct KittyAtlasUBO {
  rects: array<vec4<f32>, 256>,
};
@group(0) @binding(7) var<uniform> kittyAtlasU: KittyAtlasUBO;

const FLAG_UNDERLINE: u32 = 1u << 2u;
const FLAG_STRIKETHROUGH: u32 = 1u << 3u;
const FLAG_INVERSE: u32 = 1u << 4u;
const FLAG_FAINT: u32 = 1u << 5u;
const FLAG_INVISIBLE: u32 = 1u << 6u;
const FLAG_IS_SELECTED: u32 = 1u << 7u;
const FLAG_IS_HYPERLINK_HOVERED: u32 = 1u << 8u;
const FLAG_IS_LINK_RANGE_HOVERED: u32 = 1u << 9u;
const FLAG_IS_BLOCK_ELEMENT: u32 = 1u << 10u;
const FLAG_IS_KITTY_PLACEHOLDER: u32 = 1u << 11u;
const FLAG_USE_THEME_FG: u32 = 1u << 12u;
const FLAG_USE_THEME_BG: u32 = 1u << 13u;
const FLAG_IS_CURSOR_CELL: u32 = 1u << 14u;

fn drawBlockElement(idx: u32, uv: vec2<f32>) -> bool {
  switch idx {
    case 0u: { return uv.y < 0.5; }
    case 1u, 2u, 3u, 4u, 5u, 6u, 7u, 8u: {
      let n = f32(idx);
      return uv.y >= 1.0 - n / 8.0;
    }
    case 9u, 10u, 11u, 12u, 13u, 14u, 15u: {
      let n = 16.0 - f32(idx);
      return uv.x < n / 8.0;
    }
    case 16u: { return uv.x >= 0.5; }
    case 17u: { return false; }
    case 18u: { return false; }
    case 19u: { return false; }
    case 20u: { return uv.y < 1.0 / 8.0; }
    case 21u: { return uv.x >= 7.0 / 8.0; }
    case 22u: { return uv.x < 0.5 && uv.y >= 0.5; }
    case 23u: { return uv.x >= 0.5 && uv.y >= 0.5; }
    case 24u: { return uv.x < 0.5 && uv.y < 0.5; }
    case 25u: { return (uv.x < 0.5) || (uv.y >= 0.5); }
    case 26u: { return (uv.x < 0.5) == (uv.y < 0.5); }
    case 27u: { return !(uv.x >= 0.5 && uv.y >= 0.5); }
    case 28u: { return !(uv.x < 0.5 && uv.y >= 0.5); }
    case 29u: { return uv.x >= 0.5 && uv.y < 0.5; }
    case 30u: { return (uv.x < 0.5) != (uv.y < 0.5); }
    case 31u: { return uv.x >= 0.5 || uv.y >= 0.5; }
    default: { return false; }
  }
}

fn blockShade(idx: u32) -> f32 {
  switch idx {
    case 17u: { return 0.25; }
    case 18u: { return 0.5; }
    case 19u: { return 0.75; }
    default: { return 0.0; }
  }
}

struct VOut {
  @builtin(position) clip: vec4<f32>,
  @location(0) uv: vec2<f32>,
  @location(1) @interpolate(flat) cellIdx: u32,
};

@vertex
fn vsMain(@builtin(vertex_index) vid: u32, @builtin(instance_index) iid: u32) -> VOut {
  let col = iid % grid.gridSize.x;
  let row = iid / grid.gridSize.x;
  let corners = array<vec2<f32>, 6>(
    vec2<f32>(0.0, 0.0), vec2<f32>(1.0, 0.0), vec2<f32>(1.0, 1.0),
    vec2<f32>(0.0, 0.0), vec2<f32>(1.0, 1.0), vec2<f32>(0.0, 1.0),
  );
  let local = corners[vid];
  let cssX = (f32(col) + local.x) * grid.cellSize.x;
  let cssY = (f32(row) + local.y) * grid.cellSize.y;
  let canvasW = f32(grid.gridSize.x) * grid.cellSize.x;
  let canvasH = f32(grid.gridSize.y) * grid.cellSize.y;
  let ndcX = (cssX / canvasW) * 2.0 - 1.0;
  let ndcY = 1.0 - (cssY / canvasH) * 2.0;

  var out: VOut;
  out.clip = vec4<f32>(ndcX, ndcY, 0.0, 1.0);
  out.uv = local;
  out.cellIdx = iid;
  return out;
}

fn unpackRgb(p: u32) -> vec3<f32> {
  let r = f32(p & 0xffu) / 255.0;
  let g = f32((p >> 8u) & 0xffu) / 255.0;
  let b = f32((p >> 16u) & 0xffu) / 255.0;
  return vec3<f32>(r, g, b);
}

@fragment
fn fsMain(in: VOut) -> @location(0) vec4<f32> {
  let cell = cells[in.cellIdx];
  let flags = cell.flags;

  var fg = unpackRgb(cell.fg);
  var bg = unpackRgb(cell.bg);
  if ((flags & FLAG_USE_THEME_FG) != 0u) { fg = pal.defaultFg.rgb; }
  if ((flags & FLAG_USE_THEME_BG) != 0u) { bg = pal.defaultBg.rgb; }
  if ((flags & FLAG_INVERSE) != 0u) {
    let tmp = fg; fg = bg; bg = tmp;
  }
  if ((flags & FLAG_IS_SELECTED) != 0u) {
    bg = pal.selectionBg.rgb;
    fg = pal.selectionFg.rgb;
  }
  if ((flags & FLAG_IS_CURSOR_CELL) != 0u) {
    bg = pal.cursorBg.rgb;
    fg = pal.cursorFg.rgb;
  }

  // Invisible cells still get their (possibly selection/cursor/inverse-
  // overridden) bg painted, just no glyph or block-element content.
  // Matches CanvasRenderer's two-pass split where the bg pass always
  // runs and only the text pass returns early on INVISIBLE.
  if ((flags & FLAG_INVISIBLE) != 0u) {
    return vec4<f32>(bg, 1.0);
  }

  if ((flags & FLAG_IS_KITTY_PLACEHOLDER) != 0u) {
    let sliceCol = f32(cell.blockOrSlice & 0xffffu);
    let sliceRow = f32((cell.blockOrSlice >> 16u) & 0xffffu);
    let gridCols = f32(cell._r & 0xffffu);
    let gridRows = f32((cell._r >> 16u) & 0xffffu);
    let uvX = (sliceCol + in.uv.x) / gridCols;
    let uvY = (sliceRow + in.uv.y) / gridRows;
    let rect = kittyAtlasU.rects[cell.kittyTexIndex];
    let atlasUv = mix(rect.xy, rect.zw, vec2<f32>(uvX, uvY));
    return textureSampleLevel(kittyAtlas, kittySamp, atlasUv, 0.0);
  }

  if ((flags & FLAG_IS_BLOCK_ELEMENT) != 0u) {
    let idx = cell.blockOrSlice;
    let shade = blockShade(idx);
    if (shade > 0.0) {
      return vec4<f32>(mix(bg, fg, shade), 1.0);
    }
    if (drawBlockElement(idx, in.uv)) {
      return vec4<f32>(fg, 1.0);
    }
    return vec4<f32>(bg, 1.0);
  }

  let auv = vec2<f32>(
    f32(cell.atlasUV & 0xffffu),
    f32((cell.atlasUV >> 16u) & 0xffffu),
  );
  let asz = vec2<f32>(
    f32(cell.atlasSize & 0xffffu),
    f32((cell.atlasSize >> 16u) & 0xffffu),
  );
  let texCoord = (auv + in.uv * asz) / f32(grid.atlasSize);
  // textureSampleLevel (not textureSample) so this remains valid after
  // upstream non-uniform branches (block-element, kitty placeholder) make
  // the surrounding control flow non-uniform. Chrome's WGSL validator
  // rejects textureSample under non-uniform CF; Safari was lenient.
  // The atlas has no mips, so explicit LOD 0 is correct.
  let mask = textureSampleLevel(atlasTex, atlasSamp, texCoord, 0.0).a;

  let alpha = select(mask, mask * 0.5, (flags & FLAG_FAINT) != 0u);
  let outRgb = mix(bg, fg, alpha);

  // Underline (thin line near baseline) and strikethrough (mid-cell).
  let baselineFrac = 0.85;       // matches CanvasRenderer's renderCellText
  let underlineThickness = 1.0 / grid.cellSize.y;
  let hoverActive = (flags & (FLAG_IS_HYPERLINK_HOVERED | FLAG_IS_LINK_RANGE_HOVERED)) != 0u;
  if (hoverActive) {
    if (in.uv.y >= baselineFrac && in.uv.y < baselineFrac + underlineThickness * 2.0) {
      return pal.linkUnderlineColor;
    }
  }
  if ((flags & FLAG_UNDERLINE) != 0u) {
    if (in.uv.y >= baselineFrac && in.uv.y < baselineFrac + underlineThickness * 2.0) {
      return vec4<f32>(fg, 1.0);
    }
  }
  if ((flags & FLAG_STRIKETHROUGH) != 0u) {
    let strikeMid = 0.5;
    if (abs(in.uv.y - strikeMid) < underlineThickness) {
      return vec4<f32>(fg, 1.0);
    }
  }
  return vec4<f32>(outRgb, 1.0);
}
`;

// ---------------------------------------------------------------------------
// CURSOR_SHADER
// ---------------------------------------------------------------------------

const CURSOR_SHADER = /* wgsl */ `
struct GridUBO {
  gridSize: vec2<u32>,
  cellSize: vec2<f32>,
  dpr: f32,
  cursorVisible: u32,
  cursorPos: vec2<u32>,
  cursorStyle: u32,
  _pad0: f32,
  atlasSize: u32,
  _pad1: vec3<u32>,
};

struct PaletteUBO {
  ansi: array<vec4<f32>, 16>,
  defaultFg: vec4<f32>,
  defaultBg: vec4<f32>,
  cursorBg: vec4<f32>,
  cursorFg: vec4<f32>,
  selectionBg: vec4<f32>,
  selectionFg: vec4<f32>,
  linkUnderlineColor: vec4<f32>,
  _pad: vec4<f32>,
};

@group(0) @binding(0) var<uniform> grid: GridUBO;
@group(0) @binding(1) var<uniform> pal: PaletteUBO;

struct VOut {
  @builtin(position) clip: vec4<f32>,
  @location(0) uv: vec2<f32>,
};

@vertex
fn vsMain(@builtin(vertex_index) vid: u32) -> VOut {
  let corners = array<vec2<f32>, 6>(
    vec2<f32>(0.0, 0.0), vec2<f32>(1.0, 0.0), vec2<f32>(1.0, 1.0),
    vec2<f32>(0.0, 0.0), vec2<f32>(1.0, 1.0), vec2<f32>(0.0, 1.0),
  );
  let local = corners[vid];
  let cssX = (f32(grid.cursorPos.x) + local.x) * grid.cellSize.x;
  let cssY = (f32(grid.cursorPos.y) + local.y) * grid.cellSize.y;
  let canvasW = f32(grid.gridSize.x) * grid.cellSize.x;
  let canvasH = f32(grid.gridSize.y) * grid.cellSize.y;
  var out: VOut;
  out.clip = vec4<f32>((cssX / canvasW) * 2.0 - 1.0, 1.0 - (cssY / canvasH) * 2.0, 0.0, 1.0);
  out.uv = local;
  return out;
}

@fragment
fn fsMain(in: VOut) -> @location(0) vec4<f32> {
  if (grid.cursorVisible == 0u) { return vec4<f32>(0.0); }
  // style: 0 = block (handled by textPass), 1 = underline, 2 = bar
  if (grid.cursorStyle == 0u) { return vec4<f32>(0.0); }
  if (grid.cursorStyle == 1u) {
    if (in.uv.y >= 0.85) { return pal.cursorBg; }
    return vec4<f32>(0.0);
  }
  if (grid.cursorStyle == 2u) {
    if (in.uv.x < 0.15) { return pal.cursorBg; }
    return vec4<f32>(0.0);
  }
  return vec4<f32>(0.0);
}
`;

// ---------------------------------------------------------------------------
// KITTY_SHADER
// ---------------------------------------------------------------------------

const KITTY_SHADER = /* wgsl */ `
struct KittyParams {
  srcOrigin: vec2<f32>,
  srcSize: vec2<f32>,
  dstOrigin: vec2<f32>,
  dstSize: vec2<f32>,
  imgSize: vec2<f32>,
  canvasSize: vec2<f32>,
};

@group(0) @binding(0) var<uniform> params: KittyParams;
@group(0) @binding(1) var imgTex: texture_2d<f32>;
@group(0) @binding(2) var imgSamp: sampler;

struct VOut {
  @builtin(position) clip: vec4<f32>,
  @location(0) uv: vec2<f32>,
};

@vertex
fn vsMain(@builtin(vertex_index) vid: u32) -> VOut {
  let corners = array<vec2<f32>, 6>(
    vec2<f32>(0.0, 0.0), vec2<f32>(1.0, 0.0), vec2<f32>(1.0, 1.0),
    vec2<f32>(0.0, 0.0), vec2<f32>(1.0, 1.0), vec2<f32>(0.0, 1.0),
  );
  let local = corners[vid];
  let cssX = params.dstOrigin.x + local.x * params.dstSize.x;
  let cssY = params.dstOrigin.y + local.y * params.dstSize.y;
  var out: VOut;
  out.clip = vec4<f32>(
    (cssX / params.canvasSize.x) * 2.0 - 1.0,
    1.0 - (cssY / params.canvasSize.y) * 2.0,
    0.0, 1.0,
  );
  out.uv = (params.srcOrigin + local * params.srcSize) / params.imgSize;
  return out;
}

@fragment
fn fsMain(in: VOut) -> @location(0) vec4<f32> {
  return textureSample(imgTex, imgSamp, in.uv);
}
`;

// ---------------------------------------------------------------------------
// GlyphAtlas
// ---------------------------------------------------------------------------

class WebGPUKittyTextureCache extends KittyTextureCacheBase<GPUTexture> {
  constructor(private device: GPUDevice) {
    super();
  }
  protected createTexture(width: number, height: number): GPUTexture | null {
    return this.device.createTexture({
      size: { width, height },
      format: 'rgba8unorm',
      usage:
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.COPY_DST |
        GPUTextureUsage.RENDER_ATTACHMENT,
      label: 'kittyImg',
    });
  }
  protected uploadFull(handle: GPUTexture, rgba: Uint8Array, width: number, height: number): void {
    this.device.queue.writeTexture(
      { texture: handle },
      rgba.buffer,
      { bytesPerRow: width * 4, rowsPerImage: height },
      { width, height }
    );
  }
  protected destroyTexture(handle: GPUTexture): void {
    handle.destroy();
  }
}

class WebGPUKittyAtlas extends KittyAtlasBase {
  private device: GPUDevice;
  private texture: GPUTexture;

  constructor(device: GPUDevice, size = 1024) {
    super(size);
    this.device = device;
    this.texture = device.createTexture({
      size: { width: size, height: size },
      format: 'rgba8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
      label: 'kittyAtlas',
    });
  }

  view(): GPUTextureView {
    return this.texture.createView();
  }

  destroy(): void {
    this.texture.destroy();
  }

  protected uploadRegion(slot: AtlasSlot, rgba: Uint8Array, w: number, h: number): void {
    this.device.queue.writeTexture(
      { texture: this.texture, origin: { x: slot.u, y: slot.v } },
      rgba.buffer,
      { bytesPerRow: w * 4, rowsPerImage: h },
      { width: w, height: h }
    );
  }

  protected growTexture(_newSize: number): void {
    // v1: never grows; clearAndReset reuses the existing texture.
  }
}

class GlyphAtlas extends GlyphAtlasBase {
  private device: GPUDevice;
  private texture: GPUTexture;

  constructor(
    device: GPUDevice,
    cellW: number,
    cellH: number,
    fontSize: number,
    fontFamily: string
  ) {
    super(cellW, cellH, fontSize, fontFamily);
    this.device = device;
    this.texture = this.createBackingTexture(this.size);
  }

  view(): GPUTextureView {
    return this.texture.createView();
  }

  destroy(): void {
    this.texture.destroy();
  }

  private createBackingTexture(size: number): GPUTexture {
    return this.device.createTexture({
      size: { width: size, height: size },
      format: 'rgba8unorm',
      usage:
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.COPY_DST |
        GPUTextureUsage.COPY_SRC |
        GPUTextureUsage.RENDER_ATTACHMENT,
      label: 'glyphAtlas',
    });
  }

  protected uploadRegion(slot: AtlasSlot, rgba: Uint8ClampedArray, w: number, h: number): void {
    this.device.queue.writeTexture(
      { texture: this.texture, origin: { x: slot.u, y: slot.v } },
      rgba.buffer,
      { bytesPerRow: w * 4, rowsPerImage: h },
      { width: w, height: h }
    );
  }

  protected growTexture(newSize: number): void {
    const newTex = this.createBackingTexture(newSize);
    // Note: cache is already cleared by GlyphAtlasBase.grow(), so we don't
    // need to copy old contents — re-rasterize on miss. Previous behavior
    // did copyTextureToTexture, which is no longer needed.
    this.texture.destroy();
    this.texture = newTex;
  }
}

export class WebGPURenderer implements Renderer {
  public readonly backend = 'webgpu' as const;
  public readonly canvas: HTMLCanvasElement;

  private device!: GPUDevice;
  private context!: GPUCanvasContext;
  private preferredFormat!: GPUTextureFormat;
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
  private deviceLostListeners: Array<(info: GPUDeviceLostInfo) => void> = [];

  // Buffers
  private cellBuffer?: GPUBuffer;
  private cellBufferCapacity = 0; // bytes
  private paletteUBO?: GPUBuffer; // 384 B
  private gridUBO?: GPUBuffer; // 80 B
  private cellArray = new Uint32Array(0); // staging
  private atlas?: GlyphAtlas;
  private atlasSampler?: GPUSampler;

  // Text pipeline
  private textPipeline?: GPURenderPipeline;
  private textBindGroupLayout?: GPUBindGroupLayout;

  // Cursor pipeline
  private cursorPipeline?: GPURenderPipeline;
  private cursorBindGroupLayout?: GPUBindGroupLayout;
  private cursorBindGroup?: GPUBindGroup;

  // Kitty pipeline
  private kittyTextures!: WebGPUKittyTextureCache;
  private kittySampler?: GPUSampler;
  private kittyPipeline?: GPURenderPipeline;
  private kittyBindGroupLayout?: GPUBindGroupLayout;
  private kittyParamsRing: GPUBuffer[] = [];

  // Kitty atlas for virtual placements (Phase B).
  private kittyAtlas?: WebGPUKittyAtlas;
  private kittyAtlasUBO?: GPUBuffer;
  private kittyAtlasRects = new Float32Array(256 * 4); // host-side staging (256 vec4)

  static async create(
    canvas: HTMLCanvasElement,
    device: GPUDevice,
    opts: RendererOptions
  ): Promise<WebGPURenderer> {
    const r = new WebGPURenderer(canvas, device, opts);
    await r.initialize();
    return r;
  }

  private constructor(canvas: HTMLCanvasElement, device: GPUDevice, opts: RendererOptions) {
    this.canvas = canvas;
    this.device = device;
    this.kittyTextures = new WebGPUKittyTextureCache(device);
    this.fontSize = opts.fontSize ?? 15;
    this.fontFamily = opts.fontFamily ?? 'monospace';
    this.cursorStyle = opts.cursorStyle ?? 'block';
    this.dpr = opts.devicePixelRatio ?? window.devicePixelRatio ?? 1;
    this.theme = { ...DEFAULT_THEME, ...opts.theme };
    this.cursorBlink_.setEnabled(opts.cursorBlink ?? false);
  }

  private async initialize(): Promise<void> {
    const ctx = this.canvas.getContext('webgpu') as GPUCanvasContext | null;
    if (!ctx) throw new Error('WebGPURenderer: failed to acquire webgpu context');
    this.context = ctx;
    this.preferredFormat = navigator.gpu.getPreferredCanvasFormat();
    this.context.configure({
      device: this.device,
      format: this.preferredFormat,
      alphaMode: 'premultiplied',
    });

    this.paletteUBO = this.device.createBuffer({
      size: 384,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      label: 'paletteUBO',
    });
    this.gridUBO = this.device.createBuffer({
      size: 80,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      label: 'gridUBO',
    });
    this.kittyAtlasUBO = this.device.createBuffer({
      size: 256 * 4 * 4, // 256 vec4 × 4 floats × 4 bytes = 4096 bytes
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      label: 'kittyAtlasUBO',
    });
    this.uploadPaletteUBO();

    this.atlasSampler = this.device.createSampler({
      magFilter: 'nearest',
      minFilter: 'nearest',
      label: 'atlasSampler',
    });
    // atlas itself constructed lazily in resize() once we have metrics

    this.textBindGroupLayout = this.device.createBindGroupLayout({
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
          buffer: { type: 'uniform' },
        },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
        {
          binding: 2,
          visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
          buffer: { type: 'read-only-storage' },
        },
        { binding: 3, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
        { binding: 4, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
        {
          binding: 5,
          visibility: GPUShaderStage.FRAGMENT,
          texture: { sampleType: 'float' as const },
        },
        {
          binding: 6,
          visibility: GPUShaderStage.FRAGMENT,
          sampler: { type: 'filtering' as const },
        },
        {
          binding: 7,
          visibility: GPUShaderStage.FRAGMENT,
          buffer: { type: 'uniform' as const },
        },
      ],
    });

    const module = this.device.createShaderModule({ code: TEXT_SHADER, label: 'textShader' });
    const layout = this.device.createPipelineLayout({
      bindGroupLayouts: [this.textBindGroupLayout],
    });
    this.textPipeline = this.device.createRenderPipeline({
      layout,
      vertex: { module, entryPoint: 'vsMain' },
      fragment: {
        module,
        entryPoint: 'fsMain',
        targets: [
          {
            format: this.preferredFormat,
            blend: {
              color: { srcFactor: 'one', dstFactor: 'zero', operation: 'add' },
              alpha: { srcFactor: 'one', dstFactor: 'zero', operation: 'add' },
            },
          },
        ],
      },
      primitive: { topology: 'triangle-list' },
      label: 'textPipeline',
    });

    this.cursorBindGroupLayout = this.device.createBindGroupLayout({
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
          buffer: { type: 'uniform' },
        },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
      ],
    });
    const cursorModule = this.device.createShaderModule({
      code: CURSOR_SHADER,
      label: 'cursorShader',
    });
    const cursorLayout = this.device.createPipelineLayout({
      bindGroupLayouts: [this.cursorBindGroupLayout],
    });
    this.cursorPipeline = this.device.createRenderPipeline({
      layout: cursorLayout,
      vertex: { module: cursorModule, entryPoint: 'vsMain' },
      fragment: {
        module: cursorModule,
        entryPoint: 'fsMain',
        targets: [
          {
            format: this.preferredFormat,
            blend: {
              color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
              alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
            },
          },
        ],
      },
      primitive: { topology: 'triangle-list' },
      label: 'cursorPipeline',
    });

    this.kittySampler = this.device.createSampler({
      magFilter: 'linear',
      minFilter: 'linear',
      addressModeU: 'clamp-to-edge',
      addressModeV: 'clamp-to-edge',
      label: 'kittySampler',
    });

    this.kittyBindGroupLayout = this.device.createBindGroupLayout({
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
          buffer: { type: 'uniform' },
        },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
      ],
    });
    const kittyModule = this.device.createShaderModule({
      code: KITTY_SHADER,
      label: 'kittyShader',
    });
    const kittyLayout = this.device.createPipelineLayout({
      bindGroupLayouts: [this.kittyBindGroupLayout],
    });
    this.kittyPipeline = this.device.createRenderPipeline({
      layout: kittyLayout,
      vertex: { module: kittyModule, entryPoint: 'vsMain' },
      fragment: {
        module: kittyModule,
        entryPoint: 'fsMain',
        targets: [
          {
            format: this.preferredFormat,
            blend: {
              color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
              alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
            },
          },
        ],
      },
      primitive: { topology: 'triangle-list' },
      label: 'kittyPipeline',
    });

    this.metrics = this.measureFont();

    this.device.lost.then((info) => {
      if (this.destroyed) return;
      console.error('[ghostty-web] GPUDevice lost:', info.reason, info.message);
      // Task 17 wires this to the Terminal-level fallback.
      for (const fn of this.deviceLostListeners) fn(info);
    });
  }

  /** Internal hook used by Terminal's fallback path (Task 17). */
  onDeviceLost(fn: (info: GPUDeviceLostInfo) => void): void {
    this.deviceLostListeners.push(fn);
  }

  // -------- Font metrics (same logic as CanvasRenderer.measureFont) --------

  private measureFont(): FontMetrics {
    return coreMeasureFont(this.fontSize, this.fontFamily);
  }

  // -------- Buffer helpers --------

  private uploadPaletteUBO(): void {
    if (!this.paletteUBO) return;
    const data = buildPaletteUBOBytes(this.theme);
    this.device.queue.writeBuffer(this.paletteUBO, 0, data.buffer);
  }

  private uploadGridUBO(
    _viewportY: number,
    cursor: { x: number; y: number; visible: boolean }
  ): void {
    if (!this.gridUBO) return;
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
    this.device.queue.writeBuffer(this.gridUBO, 0, u32.buffer);
  }

  private rebuildBindGroup(): void {
    // textBindGroup is now built per-frame in render() because kitty texture views change.
    // Only rebuild the cursorBindGroup here (static across frames).
    if (this.cursorBindGroupLayout && this.gridUBO && this.paletteUBO) {
      this.cursorBindGroup = this.device.createBindGroup({
        layout: this.cursorBindGroupLayout,
        entries: [
          { binding: 0, resource: { buffer: this.gridUBO } },
          { binding: 1, resource: { buffer: this.paletteUBO } },
        ],
      });
    }
  }

  private ensureKittyRingSize(n: number): void {
    while (this.kittyParamsRing.length < n) {
      const buf = this.device.createBuffer({
        size: 64,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        label: `kittyParams[${this.kittyParamsRing.length}]`,
      });
      this.kittyParamsRing.push(buf);
    }
  }

  private encodeCells(
    buffer: IRenderable,
    viewportY: number,
    sb?: IScrollbackProvider
  ): { usedKittyImageIds: number[] } {
    const dims = buffer.getDimensions();
    const result = coreEncodeCells(this.cellArray, buffer, viewportY, sb, {
      metrics: this.metrics,
      selectionManager: this.selectionManager,
      hoveredHyperlinkId: this.hoveredHyperlinkId,
      hoveredLinkRange: this.hoveredLinkRange,
      cursorStyle: this.cursorStyle,
      cursorBlinkVisible: this.cursorBlink_.isVisible(),
      atlas: this.atlas,
      kittyEnabled: true,
      blockElementShaderEnabled: true,
      maxKittyImages: 256,
    });
    if (this.cellBuffer) {
      this.device.queue.writeBuffer(
        this.cellBuffer,
        0,
        this.cellArray.buffer,
        0,
        dims.cols * dims.rows * CELL_BYTES
      );
    }
    return result;
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

    const requiredBytes = Math.max(1, cols * rows * CELL_BYTES);
    if (!this.cellBuffer || this.cellBufferCapacity < requiredBytes) {
      this.cellBuffer?.destroy();
      this.cellBuffer = this.device.createBuffer({
        size: requiredBytes,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
        label: 'cellBuffer',
      });
      this.cellBufferCapacity = requiredBytes;
      this.cellArray = new Uint32Array(cols * rows * CELL_U32S);
    } else if (this.cellArray.length !== cols * rows * CELL_U32S) {
      this.cellArray = new Uint32Array(cols * rows * CELL_U32S);
    }

    if (!this.atlas) {
      this.atlas = new GlyphAtlas(
        this.device,
        this.metrics.width,
        this.metrics.height,
        this.fontSize,
        this.fontFamily
      );
    } else {
      this.atlas.reset(this.metrics.width, this.metrics.height, this.fontSize, this.fontFamily);
    }

    if (!this.kittyAtlas) {
      this.kittyAtlas = new WebGPUKittyAtlas(this.device);
    }
    // Note: the kitty atlas is fixed-size and persists across resizes.

    this.rebuildBindGroup();
  }

  render(buffer: IRenderable, viewportY: number = 0, sb?: IScrollbackProvider): void {
    if (this.cols === 0 || this.rows === 0) return;
    const cursor = buffer.getCursor();
    const { usedKittyImageIds } = this.encodeCells(buffer, viewportY, sb);
    this.uploadGridUBO(viewportY, cursor);

    // Update kitty atlas for any virtual-placement images used this frame, and
    // build the rect lookup table for the text shader (mirrors Phase A WebGL).
    this.kittyAtlasRects.fill(0);
    const graphics2 = buffer.getKittyGraphics?.() ?? null;
    if (graphics2 !== null && this.kittyAtlas && usedKittyImageIds.length > 0) {
      for (let i = 0; i < usedKittyImageIds.length; i++) {
        const id = usedKittyImageIds[i]!;
        const pixels = buffer.getKittyImagePixels?.(graphics2, id);
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
      this.device.queue.writeBuffer(this.kittyAtlasUBO, 0, this.kittyAtlasRects.buffer);
    }

    // Build per-frame textBindGroup (kitty atlas UBO updated each frame).
    const textBindGroup =
      this.textBindGroupLayout &&
      this.gridUBO &&
      this.paletteUBO &&
      this.cellBuffer &&
      this.atlas &&
      this.atlasSampler &&
      this.kittyAtlas &&
      this.kittySampler &&
      this.kittyAtlasUBO
        ? this.device.createBindGroup({
            layout: this.textBindGroupLayout,
            entries: [
              { binding: 0, resource: { buffer: this.gridUBO } },
              { binding: 1, resource: { buffer: this.paletteUBO } },
              { binding: 2, resource: { buffer: this.cellBuffer } },
              { binding: 3, resource: this.atlas.view() },
              { binding: 4, resource: this.atlasSampler },
              { binding: 5, resource: this.kittyAtlas.view() },
              { binding: 6, resource: this.kittySampler },
              { binding: 7, resource: { buffer: this.kittyAtlasUBO } },
            ],
          })
        : null;

    // Collect kitty direct placements (must happen before beginRenderPass — writeBuffer
    // during a render pass is a validation error).
    const directPlacements: Array<{ params: Float32Array; view: GPUTextureView }> = [];
    if (this.kittyPipeline && buffer.getKittyGraphics && buffer.iterPlacements) {
      const graphics = buffer.getKittyGraphics();
      if (graphics !== null) {
        const cssW = this.cols * this.metrics.width;
        const cssH = this.rows * this.metrics.height;
        for (const p of buffer.iterPlacements(graphics, true)) {
          if (p.isVirtual) continue;
          const pixels = buffer.getKittyImagePixels?.(graphics, p.imageId);
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
          directPlacements.push({ params, view: tex.createView() });
        }
      }
    }
    this.ensureKittyRingSize(directPlacements.length);
    for (let i = 0; i < directPlacements.length; i++) {
      this.device.queue.writeBuffer(
        this.kittyParamsRing[i]!,
        0,
        directPlacements[i]!.params.buffer
      );
    }
    const kittyBindGroups: GPUBindGroup[] = directPlacements.map((p, i) =>
      this.device.createBindGroup({
        layout: this.kittyBindGroupLayout!,
        entries: [
          { binding: 0, resource: { buffer: this.kittyParamsRing[i]! } },
          { binding: 1, resource: p.view },
          { binding: 2, resource: this.kittySampler! },
        ],
      })
    );

    const view = this.context.getCurrentTexture().createView();
    const [r, g, b] = this.parseHexColor(this.theme.background);
    const encoder = this.device.createCommandEncoder();
    const pass = encoder.beginRenderPass({
      colorAttachments: [
        {
          view,
          clearValue: { r: r / 255, g: g / 255, b: b / 255, a: 1 },
          loadOp: 'clear',
          storeOp: 'store',
        },
      ],
    });
    // Order matches CanvasRenderer: text grid → kitty image composite →
    // cursor on top. Drawing kitty after the cursor would let images
    // cover the cursor, which Canvas2D never does.
    if (this.textPipeline && textBindGroup) {
      pass.setPipeline(this.textPipeline);
      pass.setBindGroup(0, textBindGroup);
      pass.draw(6, this.cols * this.rows);
    }
    for (let i = 0; i < kittyBindGroups.length; i++) {
      pass.setPipeline(this.kittyPipeline!);
      pass.setBindGroup(0, kittyBindGroups[i]!);
      pass.draw(6);
    }
    if (this.cursorPipeline && this.cursorBindGroup) {
      pass.setPipeline(this.cursorPipeline);
      pass.setBindGroup(0, this.cursorBindGroup);
      pass.draw(6);
    }
    pass.end();
    this.device.queue.submit([encoder.finish()]);

    buffer.clearDirty();
    this.invalidateNext = false;
  }

  private parseHexColor(hex: string): [number, number, number] {
    return coreParseHexColor(hex);
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
    this.rebuildBindGroup();
    this.invalidateNext = true;
    this.onRequestRender?.();
  }

  setFontFamily(family: string): void {
    this.fontFamily = family;
    this.metrics = this.measureFont();
    this.atlas?.reset(this.metrics.width, this.metrics.height, this.fontSize, this.fontFamily);
    this.rebuildBindGroup();
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
    // Destroying the device releases ALL GPUBuffer / GPUTexture / GPUSampler /
    // GPURenderPipeline / GPUBindGroup it owns — i.e. the entire WebGPU resource
    // set this renderer ever created (paletteUBO, gridUBO, cellBuffer, glyph
    // atlas, kitty atlas + UBO + ring, kitty cache textures, all pipelines).
    // The kitty resources we explicitly destroy below are redundant given the
    // device.destroy() call but we keep them as a tightening (in case the
    // browser implementation defers GPU-side reclamation past device destroy).
    this.kittyTextures.destroyAll();
    for (const buf of this.kittyParamsRing) buf.destroy();
    this.kittyParamsRing.length = 0;
    this.kittyAtlas?.destroy();
    if (this.kittyAtlasUBO) this.kittyAtlasUBO.destroy();
    this.device.destroy();
  }
}
