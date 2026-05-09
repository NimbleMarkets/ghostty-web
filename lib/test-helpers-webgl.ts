/**
 * Stub WebGL2 context for unit tests. Records every method call and
 * returns plausible values for the queries we make. Pair with
 * installStubWebGL2() to monkey-patch HTMLCanvasElement.getContext.
 *
 * The stub does not validate GL semantics — it only verifies that the
 * renderer issues the calls we expect, in the order we expect.
 */

export type GLCall = { method: string; args: unknown[] };

export class StubWebGL2 {
  public calls: GLCall[] = [];

  // GL constants we rely on inside the renderer.
  readonly ARRAY_BUFFER = 0x8892;
  readonly UNIFORM_BUFFER = 0x8a11;
  readonly STATIC_DRAW = 0x88e4;
  readonly DYNAMIC_DRAW = 0x88e8;
  readonly TEXTURE_2D = 0x0de1;
  readonly TEXTURE0 = 0x84c0;
  readonly TEXTURE1 = 0x84c1;
  readonly RGBA = 0x1908;
  readonly RGBA8 = 0x8058;
  readonly RGBA32UI = 0x8d70;
  readonly RGBA_INTEGER = 0x8d99;
  readonly UNSIGNED_BYTE = 0x1401;
  readonly UNSIGNED_INT = 0x1405;
  readonly NEAREST = 0x2600;
  readonly LINEAR = 0x2601;
  readonly CLAMP_TO_EDGE = 0x812f;
  readonly TEXTURE_MIN_FILTER = 0x2800;
  readonly TEXTURE_MAG_FILTER = 0x2801;
  readonly TEXTURE_WRAP_S = 0x2802;
  readonly TEXTURE_WRAP_T = 0x2803;
  readonly VERTEX_SHADER = 0x8b31;
  readonly FRAGMENT_SHADER = 0x8b30;
  readonly COMPILE_STATUS = 0x8b81;
  readonly LINK_STATUS = 0x8b82;
  readonly TRIANGLES = 0x0004;
  readonly COLOR_BUFFER_BIT = 0x4000;
  readonly NO_ERROR = 0;
  readonly BLEND = 0x0be2;
  readonly SRC_ALPHA = 0x0302;
  readonly ONE = 1;
  readonly ZERO = 0;
  readonly ONE_MINUS_SRC_ALPHA = 0x0303;
  readonly FUNC_ADD = 0x8006;

  drawingBufferWidth = 800;
  drawingBufferHeight = 600;

  private nextId = 1;
  private newId(): { _id: number } {
    return { _id: this.nextId++ };
  }

  // ---- Methods we record-and-return ------------------------------------

  createShader(_type: number) {
    this.calls.push({ method: 'createShader', args: [_type] });
    return this.newId();
  }
  shaderSource(shader: unknown, src: string) {
    this.calls.push({ method: 'shaderSource', args: [shader, src] });
  }
  compileShader(shader: unknown) {
    this.calls.push({ method: 'compileShader', args: [shader] });
  }
  getShaderParameter(_shader: unknown, pname: number) {
    this.calls.push({ method: 'getShaderParameter', args: [_shader, pname] });
    if (pname === this.COMPILE_STATUS) return true;
    return 0;
  }
  getShaderInfoLog(_shader: unknown) {
    return '';
  }
  createProgram() {
    this.calls.push({ method: 'createProgram', args: [] });
    return this.newId();
  }
  attachShader(p: unknown, s: unknown) {
    this.calls.push({ method: 'attachShader', args: [p, s] });
  }
  linkProgram(p: unknown) {
    this.calls.push({ method: 'linkProgram', args: [p] });
  }
  getProgramParameter(_p: unknown, pname: number) {
    this.calls.push({ method: 'getProgramParameter', args: [_p, pname] });
    if (pname === this.LINK_STATUS) return true;
    return 0;
  }
  getProgramInfoLog(_p: unknown) {
    return '';
  }
  useProgram(p: unknown) {
    this.calls.push({ method: 'useProgram', args: [p] });
  }
  deleteShader(s: unknown) {
    this.calls.push({ method: 'deleteShader', args: [s] });
  }
  deleteProgram(p: unknown) {
    this.calls.push({ method: 'deleteProgram', args: [p] });
  }
  deleteTexture(t: unknown) {
    this.calls.push({ method: 'deleteTexture', args: [t] });
  }
  getUniformLocation(_p: unknown, name: string) {
    this.calls.push({ method: 'getUniformLocation', args: [_p, name] });
    return this.newId();
  }
  getUniformBlockIndex(_p: unknown, name: string) {
    this.calls.push({ method: 'getUniformBlockIndex', args: [_p, name] });
    return this.nextId++;
  }
  uniformBlockBinding(p: unknown, idx: number, binding: number) {
    this.calls.push({ method: 'uniformBlockBinding', args: [p, idx, binding] });
  }
  uniform1i(loc: unknown, v: number) {
    this.calls.push({ method: 'uniform1i', args: [loc, v] });
  }

  createBuffer() {
    this.calls.push({ method: 'createBuffer', args: [] });
    return this.newId();
  }
  bindBuffer(target: number, buf: unknown) {
    this.calls.push({ method: 'bindBuffer', args: [target, buf] });
  }
  bindBufferBase(target: number, idx: number, buf: unknown) {
    this.calls.push({ method: 'bindBufferBase', args: [target, idx, buf] });
  }
  bufferData(target: number, sizeOrData: unknown, usage: number) {
    this.calls.push({ method: 'bufferData', args: [target, sizeOrData, usage] });
  }
  bufferSubData(target: number, off: number, data: unknown) {
    this.calls.push({ method: 'bufferSubData', args: [target, off, data] });
  }

  createTexture() {
    this.calls.push({ method: 'createTexture', args: [] });
    return this.newId();
  }
  bindTexture(target: number, tex: unknown) {
    this.calls.push({ method: 'bindTexture', args: [target, tex] });
  }
  activeTexture(slot: number) {
    this.calls.push({ method: 'activeTexture', args: [slot] });
  }
  texParameteri(t: number, p: number, v: number) {
    this.calls.push({ method: 'texParameteri', args: [t, p, v] });
  }
  texStorage2D(t: number, levels: number, fmt: number, w: number, h: number) {
    this.calls.push({ method: 'texStorage2D', args: [t, levels, fmt, w, h] });
  }
  texSubImage2D(...args: unknown[]) {
    this.calls.push({ method: 'texSubImage2D', args });
  }
  pixelStorei(name: number, value: number) {
    this.calls.push({ method: 'pixelStorei', args: [name, value] });
  }

  createVertexArray() {
    this.calls.push({ method: 'createVertexArray', args: [] });
    return this.newId();
  }
  bindVertexArray(v: unknown) {
    this.calls.push({ method: 'bindVertexArray', args: [v] });
  }
  enableVertexAttribArray(i: number) {
    this.calls.push({ method: 'enableVertexAttribArray', args: [i] });
  }

  enable(cap: number) {
    this.calls.push({ method: 'enable', args: [cap] });
  }
  disable(cap: number) {
    this.calls.push({ method: 'disable', args: [cap] });
  }
  blendFuncSeparate(...args: unknown[]) {
    this.calls.push({ method: 'blendFuncSeparate', args });
  }
  blendEquation(mode: number) {
    this.calls.push({ method: 'blendEquation', args: [mode] });
  }
  viewport(x: number, y: number, w: number, h: number) {
    this.calls.push({ method: 'viewport', args: [x, y, w, h] });
  }
  clearColor(r: number, g: number, b: number, a: number) {
    this.calls.push({ method: 'clearColor', args: [r, g, b, a] });
  }
  clear(mask: number) {
    this.calls.push({ method: 'clear', args: [mask] });
  }

  drawArrays(mode: number, first: number, count: number) {
    this.calls.push({ method: 'drawArrays', args: [mode, first, count] });
  }
  drawArraysInstanced(mode: number, first: number, count: number, ic: number) {
    this.calls.push({ method: 'drawArraysInstanced', args: [mode, first, count, ic] });
  }

  getError() {
    return this.NO_ERROR;
  }

  /** Convenience: number of times a method appears in the call log. */
  countCalls(method: string): number {
    return this.calls.filter((c) => c.method === method).length;
  }

  /** Convenience: extract the args of the Nth occurrence (0-indexed). */
  argsOf(method: string, occurrence = 0): unknown[] | undefined {
    let seen = 0;
    for (const c of this.calls) {
      if (c.method === method) {
        if (seen === occurrence) return c.args;
        seen++;
      }
    }
    return undefined;
  }
}

/**
 * Monkey-patches HTMLCanvasElement.prototype.getContext('webgl2') to
 * return a fresh StubWebGL2 each call. Returns the most-recent stub.
 * Call uninstall() in afterEach.
 */
export function installStubWebGL2(): {
  getStub: () => StubWebGL2;
  uninstall: () => void;
} {
  const original = HTMLCanvasElement.prototype.getContext;
  let lastStub: StubWebGL2 | null = null;
  HTMLCanvasElement.prototype.getContext = function (
    this: HTMLCanvasElement,
    contextType: string,
    options?: any
  ): any {
    if (contextType === 'webgl2') {
      lastStub = new StubWebGL2();
      return lastStub as unknown;
    }
    return (original as any).call(this, contextType, options);
  } as typeof HTMLCanvasElement.prototype.getContext;
  return {
    getStub: () => {
      if (!lastStub) throw new Error('No webgl2 context was created');
      return lastStub;
    },
    uninstall: () => {
      HTMLCanvasElement.prototype.getContext = original;
      lastStub = null;
    },
  };
}
