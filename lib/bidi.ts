/**
 * BiDi (Unicode Bidirectional Algorithm) support.
 *
 * Terminals store text in LOGICAL order (the order the PTY received it);
 * RTL scripts must be PAINTED in visual order. This module produces, for a
 * row of cells, the permutation between the two. Everything downstream —
 * both paint paths, selection copy, mouse reporting, cursor placement —
 * routes through this map. Strings are never reversed.
 *
 * Paragraph direction is fixed LTR (per spec: cursor-addressed TUIs expect
 * rows anchored at their left-hand columns; an all-RTL row reorders in
 * place). See docs/superpowers/specs/2026-07-29-bidi-rendering-design.md.
 */
import bidiFactory from 'bidi-js';
import type { BidiApi } from 'bidi-js';
import { KITTY_PLACEHOLDER } from './kitty_diacritics';
import type { GhosttyCell } from './types';

export interface RowBidiMap {
  /**
   * True when the row needs no bidi work at all: identity permutation and
   * nothing to mirror. Consumers may skip map lookups entirely.
   */
  isIdentity: boolean;
  /** Visual column → logical column. Length === row length. */
  visualToLogical: Uint16Array;
  /** Logical column → visual column. Inverse of visualToLogical. */
  logicalToVisual: Uint16Array;
  /**
   * Logical column → replacement codepoint for UBA rule L4 glyph mirroring
   * (e.g. "(" inside an RTL run paints as ")"). Null when nothing mirrors.
   * Applies to PAINTING only — copy reads the logical cell untouched.
   */
  mirror: Map<number, number> | null;
}

/**
 * Codepoints that can trigger RTL reordering. Everything below U+0590 is
 * strongly LTR or neutral. Ranges: Hebrew through Arabic Extended-A
 * (0590–08FF), RTL directional formatting controls, Hebrew/Arabic
 * presentation forms, and the astral RTL blocks (ancient scripts at
 * 10800–10FFF, Adlam etc. at 1E800–1EFFF). Deliberately conservative:
 * a false positive only costs a UBA run that resolves to identity.
 */
function isRtlTrigger(cp: number): boolean {
  if (cp < 0x0590) return false;
  if (cp <= 0x08ff) return true;
  if (cp === 0x200f) return true; // RLM
  if (cp >= 0x202a && cp <= 0x202e) return true; // LRE/RLE/PDF/LRO/RLO
  if (cp >= 0x2066 && cp <= 0x2069) return true; // LRI/RLI/FSI/PDI
  if (cp >= 0xfb1d && cp <= 0xfdff) return true;
  if (cp >= 0xfe70 && cp <= 0xfeff) return true;
  if (cp >= 0x10800 && cp <= 0x10fff) return true;
  if (cp >= 0x1e800 && cp <= 0x1efff) return true;
  return false;
}

export class RowBidiMapper {
  private bidi: BidiApi | null;
  private identityByLen = new Map<number, RowBidiMap>();

  constructor() {
    // Degrade to identity (today's behavior) rather than crash the
    // renderer if bidi-js ever fails to initialize.
    try {
      this.bidi = bidiFactory();
    } catch {
      this.bidi = null;
    }
  }

  getMap(line: GhosttyCell[]): RowBidiMap {
    let hasRtl = false;
    for (let i = 0; i < line.length; i++) {
      const cp = line[i]!.codepoint;
      if (cp >= 0x0590 && cp !== KITTY_PLACEHOLDER && isRtlTrigger(cp)) {
        hasRtl = true;
        break;
      }
    }
    if (!hasRtl || this.bidi === null) return this.identity(line.length);
    return this.compute(line);
  }

  private identity(len: number): RowBidiMap {
    let m = this.identityByLen.get(len);
    if (!m) {
      const v2l = new Uint16Array(len);
      for (let i = 0; i < len; i++) v2l[i] = i;
      // Identity is its own inverse; consumers must not mutate the arrays.
      m = { isIdentity: true, visualToLogical: v2l, logicalToVisual: v2l, mirror: null };
      this.identityByLen.set(len, m);
    }
    return m;
  }

  private compute(line: GhosttyCell[]): RowBidiMap {
    throw new Error('implemented in the next commit');
  }
}
