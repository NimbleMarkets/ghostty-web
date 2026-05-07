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
import { CellFlags } from './types';

const warnedUnparseableColors = new Set<string>();

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

const FLAG_UNDERLINE: u32 = 1u << 2u;
const FLAG_STRIKETHROUGH: u32 = 1u << 3u;
const FLAG_INVERSE: u32 = 1u << 4u;
const FLAG_FAINT: u32 = 1u << 5u;
const FLAG_INVISIBLE: u32 = 1u << 6u;
const FLAG_IS_SELECTED: u32 = 1u << 7u;
const FLAG_IS_HYPERLINK_HOVERED: u32 = 1u << 8u;
const FLAG_IS_LINK_RANGE_HOVERED: u32 = 1u << 9u;
const FLAG_USE_THEME_FG: u32 = 1u << 12u;
const FLAG_USE_THEME_BG: u32 = 1u << 13u;
const FLAG_IS_CURSOR_CELL: u32 = 1u << 14u;
const FLAG_IS_BLOCK_ELEMENT: u32 = 1u << 10u;

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

  if ((flags & FLAG_INVISIBLE) != 0u) {
    return vec4<f32>(0.0, 0.0, 0.0, 0.0);
  }

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
  let mask = textureSample(atlasTex, atlasSamp, texCoord).a;

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
// GlyphAtlas
// ---------------------------------------------------------------------------

type AtlasSlot = { u: number; v: number; w: number; h: number };

class GlyphAtlas {
  private device: GPUDevice;
  private texture: GPUTexture;
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
    device: GPUDevice,
    cellW: number,
    cellH: number,
    fontSize: number,
    fontFamily: string,
  ) {
    this.device = device;
    this.cellW = cellW;
    this.cellH = cellH;
    this.fontSize = fontSize;
    this.fontFamily = fontFamily;
    this.size = 1024;
    this.texture = device.createTexture({
      size: { width: this.size, height: this.size },
      format: 'rgba8unorm',
      usage:
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.COPY_DST |
        GPUTextureUsage.COPY_SRC |
        GPUTextureUsage.RENDER_ATTACHMENT,
      label: 'glyphAtlas',
    });
    this.offscreen.width = cellW;
    this.offscreen.height = cellH;
    this.offCtx = this.offscreen.getContext('2d', { willReadFrequently: true })!;
  }

  view(): GPUTextureView {
    return this.texture.createView();
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
    this.offscreen.width = cellW;
    this.offscreen.height = cellH;
    // Texture stays allocated; we just zero it conceptually by overwriting on demand.
  }

  /** Returns slot UV in pixels. Rasterizes + uploads on miss. */
  getOrRaster(grapheme: string, styleBits: number, baseline: number): AtlasSlot {
    const key = `${styleBits}|${grapheme}`;
    const cached = this.cache.get(key);
    if (cached) return cached;

    // Allocate slot.
    const w = this.cellW;
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

    // Rasterize.
    const ctx = this.offCtx;
    ctx.clearRect(0, 0, w, h);
    let style = '';
    if (styleBits & 1) style += 'bold ';
    if (styleBits & 2) style += 'italic ';
    ctx.font = `${style}${this.fontSize}px ${this.fontFamily}`;
    ctx.textBaseline = 'alphabetic';
    ctx.textAlign = 'left';
    ctx.fillStyle = styleBits & 4 ? 'rgba(255, 255, 255, 0.5)' : '#ffffff'; // FAINT
    ctx.fillText(grapheme, 0, baseline);

    const img = ctx.getImageData(0, 0, w, h);
    this.device.queue.writeTexture(
      { texture: this.texture, origin: { x: slot.u, y: slot.v } },
      img.data.buffer,
      { bytesPerRow: w * 4, rowsPerImage: h },
      { width: w, height: h },
    );

    return slot;
  }

  private grow(): void {
    const newSize = this.size * 2;
    const newTex = this.device.createTexture({
      size: { width: newSize, height: newSize },
      format: 'rgba8unorm',
      usage:
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.COPY_DST |
        GPUTextureUsage.COPY_SRC |
        GPUTextureUsage.RENDER_ATTACHMENT,
      label: 'glyphAtlas',
    });
    const enc = this.device.createCommandEncoder();
    enc.copyTextureToTexture(
      { texture: this.texture },
      { texture: newTex },
      { width: this.size, height: this.size },
    );
    this.device.queue.submit([enc.finish()]);
    this.texture.destroy();
    this.texture = newTex;
    this.size = newSize;
  }

  get atlasSize(): number {
    return this.size;
  }
}

// Cell encoding — see plan §"Cell Encoding Reference".
const CELL_BYTES = 32;
const CELL_U32S = 8;

// Flag bits — must match WGSL.
const FLAG_BOLD = 1 << 0;
const FLAG_ITALIC = 1 << 1;
const FLAG_UNDERLINE = 1 << 2;
const FLAG_STRIKETHROUGH = 1 << 3;
const FLAG_INVERSE = 1 << 4;
const FLAG_FAINT = 1 << 5;
const FLAG_INVISIBLE = 1 << 6;
const FLAG_IS_SELECTED = 1 << 7;
const FLAG_IS_HYPERLINK_HOVERED = 1 << 8;
const FLAG_IS_LINK_RANGE_HOVERED = 1 << 9;
const FLAG_IS_BLOCK_ELEMENT = 1 << 10;
const FLAG_IS_KITTY_PLACEHOLDER = 1 << 11;
const FLAG_USE_THEME_FG = 1 << 12;
const FLAG_USE_THEME_BG = 1 << 13;
const FLAG_IS_CURSOR_CELL = 1 << 14;

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
  private gridUBO?: GPUBuffer;    // 80 B
  private cellArray = new Uint32Array(0); // staging
  private atlas?: GlyphAtlas;
  private atlasSampler?: GPUSampler;

  // Text pipeline
  private textPipeline?: GPURenderPipeline;
  private textBindGroupLayout?: GPUBindGroupLayout;
  private textBindGroup?: GPUBindGroup;

  // Cursor pipeline
  private cursorPipeline?: GPURenderPipeline;
  private cursorBindGroupLayout?: GPUBindGroupLayout;
  private cursorBindGroup?: GPUBindGroup;

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
      ],
    });

    const module = this.device.createShaderModule({ code: TEXT_SHADER, label: 'textShader' });
    const layout = this.device.createPipelineLayout({ bindGroupLayouts: [this.textBindGroupLayout] });
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
    const c = document.createElement('canvas');
    const ctx = c.getContext('2d')!;
    ctx.font = `${this.fontSize}px ${this.fontFamily}`;
    const m = ctx.measureText('M');
    const width = Math.ceil(m.width);
    const ascent = m.actualBoundingBoxAscent || this.fontSize * 0.8;
    const descent = m.actualBoundingBoxDescent || this.fontSize * 0.2;
    const height = Math.ceil(ascent + descent) + 2;
    const baseline = Math.ceil(ascent) + 1;
    return { width, height, baseline };
  }

  // -------- Buffer helpers --------

  private uploadPaletteUBO(): void {
    if (!this.paletteUBO) return;
    const data = new Float32Array(96);
    const w = (i: number, hex: string): void => {
      const [r, g, b] = this.parseHexColor(hex);
      data[i * 4 + 0] = r / 255;
      data[i * 4 + 1] = g / 255;
      data[i * 4 + 2] = b / 255;
      data[i * 4 + 3] = 1;
    };
    // 16 ANSI palette
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
    // theme entries
    w(16, t.foreground);
    w(17, t.background);
    w(18, t.cursor);
    w(19, t.cursorAccent);
    w(20, t.selectionBackground);
    w(21, t.selectionForeground);
    w(22, '#4A90E2'); // link underline color (matches CanvasRenderer)
    // 23 reserved (zeroed)
    this.device.queue.writeBuffer(this.paletteUBO, 0, data.buffer);
  }

  private uploadGridUBO(_viewportY: number, cursor: { x: number; y: number; visible: boolean }): void {
    if (!this.gridUBO) return;
    // 80 B = 20 × u32. Layout matches the WGSL GridUBO struct (Tasks 9, 14).
    const u32 = new Uint32Array(20);
    const f32 = new Float32Array(u32.buffer);
    u32[0] = this.cols;                                                  // gridSize.x
    u32[1] = this.rows;                                                  // gridSize.y
    f32[2] = this.metrics.width;                                         // cellSize.x
    f32[3] = this.metrics.height;                                        // cellSize.y
    f32[4] = this.dpr;                                                   // devicePixelRatio
    u32[5] = cursor.visible && this.cursorBlink_.isVisible() ? 1 : 0;    // cursorVisible
    u32[6] = cursor.x;                                                   // cursorPos.x
    u32[7] = cursor.y;                                                   // cursorPos.y
    u32[8] = this.cursorStyle === 'block' ? 0 : this.cursorStyle === 'underline' ? 1 : 2;
    u32[9] = 0;                                                          // _pad0
    u32[10] = this.atlas?.atlasSize ?? 1024;                             // atlasSize (Task 9 uses it)
    // u32[11..19] reserved
    this.device.queue.writeBuffer(this.gridUBO, 0, u32.buffer);
  }

  private rebuildBindGroup(): void {
    if (
      !this.textBindGroupLayout ||
      !this.gridUBO ||
      !this.paletteUBO ||
      !this.cellBuffer ||
      !this.atlas ||
      !this.atlasSampler
    ) {
      return;
    }
    this.textBindGroup = this.device.createBindGroup({
      layout: this.textBindGroupLayout,
      entries: [
        { binding: 0, resource: { buffer: this.gridUBO } },
        { binding: 1, resource: { buffer: this.paletteUBO } },
        { binding: 2, resource: { buffer: this.cellBuffer } },
        { binding: 3, resource: this.atlas.view() },
        { binding: 4, resource: this.atlasSampler },
      ],
    });
    if (this.cursorBindGroupLayout) {
      this.cursorBindGroup = this.device.createBindGroup({
        layout: this.cursorBindGroupLayout,
        entries: [
          { binding: 0, resource: { buffer: this.gridUBO } },
          { binding: 1, resource: { buffer: this.paletteUBO } },
        ],
      });
    }
  }

  private encodeCells(buffer: IRenderable, viewportY: number, sb?: IScrollbackProvider): void {
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
      if (!line) continue;
      for (let x = 0; x < line.length && x < dims.cols; x++) {
        const c = line[x];
        if (!c || c.width === 0) continue;
        const i = (y * dims.cols + x) * CELL_U32S;
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
        const cp = c.codepoint || 0;
        if (cp >= 0x2580 && cp <= 0x259f && c.grapheme_len === 0) {
          flags |= FLAG_IS_BLOCK_ELEMENT;
          arr[i + 5] = cp - 0x2580;
        }
        // Pack colors as little-endian rgba8.
        arr[i + 0] = c.fg_r | (c.fg_g << 8) | (c.fg_b << 16);
        arr[i + 1] = c.bg_r | (c.bg_g << 8) | (c.bg_b << 16);
        // Skip atlas lookup for invisible / kitty-placeholder / block-element cells.
        const skipAtlas =
          (flags & (FLAG_INVISIBLE | FLAG_IS_KITTY_PLACEHOLDER | FLAG_IS_BLOCK_ELEMENT)) !== 0;
        if (!skipAtlas && this.atlas) {
          const grapheme =
            c.grapheme_len > 0 && buffer.getGraphemeString
              ? buffer.getGraphemeString(y, x)
              : String.fromCodePoint(c.codepoint || 32);
          const styleBits =
            (flags & FLAG_BOLD ? 1 : 0) | (flags & FLAG_ITALIC ? 2 : 0) | (flags & FLAG_FAINT ? 4 : 0);
          const slot = this.atlas.getOrRaster(grapheme, styleBits, this.metrics.baseline);
          arr[i + 2] = (slot.u & 0xffff) | ((slot.v & 0xffff) << 16);
          arr[i + 3] = (slot.w & 0xffff) | ((slot.h & 0xffff) << 16);
        }
        arr[i + 4] = flags >>> 0;
        // arr[i + 6] = kittyTexIndex — Task 16
      }
    }

    if (cursor.visible && this.cursorBlink_.isVisible()) {
      const ci = (cursor.y * dims.cols + cursor.x) * CELL_U32S;
      arr[ci + 4] = (arr[ci + 4]! | FLAG_IS_CURSOR_CELL) >>> 0;
    }

    if (this.cellBuffer) {
      this.device.queue.writeBuffer(
        this.cellBuffer,
        0,
        arr.buffer,
        0,
        dims.cols * dims.rows * CELL_BYTES,
      );
    }
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
        this.fontFamily,
      );
    } else {
      this.atlas.reset(this.metrics.width, this.metrics.height, this.fontSize, this.fontFamily);
    }
    this.rebuildBindGroup();
  }

  render(buffer: IRenderable, viewportY: number = 0, sb?: IScrollbackProvider): void {
    if (this.cols === 0 || this.rows === 0) return;
    const cursor = buffer.getCursor();
    this.encodeCells(buffer, viewportY, sb);
    this.uploadGridUBO(viewportY, cursor);

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
    if (this.textPipeline && this.textBindGroup) {
      pass.setPipeline(this.textPipeline);
      pass.setBindGroup(0, this.textBindGroup);
      pass.draw(6, this.cols * this.rows);
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
    const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex.trim());
    if (!m) {
      if (!warnedUnparseableColors.has(hex)) {
        warnedUnparseableColors.add(hex);
        console.warn(
          '[ghostty-web] WebGPURenderer: unparseable theme color, falling back to black:',
          hex
        );
      }
      return [0, 0, 0];
    }
    return [Number.parseInt(m[1]!, 16), Number.parseInt(m[2]!, 16), Number.parseInt(m[3]!, 16)];
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
    // device.destroy() left to caller; we don't own it.
  }
}
