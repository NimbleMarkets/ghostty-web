import { describe, expect, test } from 'bun:test';
import { kittyImageToRGBA } from './renderer-core';
import { KittyImageFormat } from './types';

describe('kittyImageToRGBA', () => {
  test('RGBA passes through unchanged', () => {
    const data = new Uint8Array([10, 20, 30, 40, 50, 60, 70, 80]);
    const out = kittyImageToRGBA({ width: 2, height: 1, format: KittyImageFormat.RGBA, data });
    expect(out).not.toBeNull();
    expect(Array.from(out!)).toEqual([10, 20, 30, 40, 50, 60, 70, 80]);
  });

  test('RGB inserts alpha=255 per pixel', () => {
    const data = new Uint8Array([10, 20, 30, 40, 50, 60]);
    const out = kittyImageToRGBA({ width: 2, height: 1, format: KittyImageFormat.RGB, data });
    expect(out).not.toBeNull();
    expect(Array.from(out!)).toEqual([10, 20, 30, 255, 40, 50, 60, 255]);
  });

  test('GRAY broadcasts to RGB and inserts alpha=255', () => {
    const data = new Uint8Array([100, 200]);
    const out = kittyImageToRGBA({ width: 2, height: 1, format: KittyImageFormat.GRAY, data });
    expect(out).not.toBeNull();
    expect(Array.from(out!)).toEqual([100, 100, 100, 255, 200, 200, 200, 255]);
  });

  test('GRAY_ALPHA broadcasts gray and uses provided alpha', () => {
    const data = new Uint8Array([100, 50, 200, 150]);
    const out = kittyImageToRGBA({
      width: 2,
      height: 1,
      format: KittyImageFormat.GRAY_ALPHA,
      data,
    });
    expect(out).not.toBeNull();
    expect(Array.from(out!)).toEqual([100, 100, 100, 50, 200, 200, 200, 150]);
  });

  test('PNG (undecoded) returns null', () => {
    const out = kittyImageToRGBA({
      width: 2,
      height: 1,
      format: KittyImageFormat.PNG,
      data: new Uint8Array([1, 2, 3]),
    });
    expect(out).toBeNull();
  });

  test('zero-dimension image returns null', () => {
    const out = kittyImageToRGBA({
      width: 0,
      height: 1,
      format: KittyImageFormat.RGBA,
      data: new Uint8Array(0),
    });
    expect(out).toBeNull();
  });
});
