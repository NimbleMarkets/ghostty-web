# BiDi (RTL) Rendering Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** RTL scripts (Hebrew, Arabic, Persian) render in correct visual order via the Unicode Bidirectional Algorithm, with selection/copy, mouse reporting, and cursor placement staying correct.

**Architecture:** A new `lib/bidi.ts` module (`RowBidiMapper`) wraps `bidi-js` and produces a per-row visual↔logical permutation (`RowBidiMap`), cached by row content. The two paint paths (`renderLine`, `encodeCells`) iterate visual positions and fetch cells through the map; selection anchors stay in visual space with conversion only at copy time; mouse reporting and cursor placement convert at their boundaries. Spec: `docs/superpowers/specs/2026-07-29-bidi-rendering-design.md`.

**Tech Stack:** TypeScript, bidi-js 1.0.3 (new runtime dep), bun test, happy-dom.

## Global Constraints

- Branch: `nm-rtl` (already checked out); merge target `nm-webgpu`.
- Never reverse strings; never special-case Hebrew. All ordering goes through the permutation.
- Fixed **LTR paragraph direction** (`getEmbeddingLevels(text, 'ltr')`).
- Arabic cursive joining (shaping) is OUT OF SCOPE — harness row 11 stays visibly disconnected; do not try to fix it.
- Copy/clipboard text must be **logical order**. Mouse reports to the app must carry **logical** columns. Selection anchors/highlights are **visual**.
- Run tests with `bun test <file>`; typecheck with `bun run typecheck` (or `npx tsc --noEmit`). Full WASM build (only needed in final task): `nix develop --command bun run build` — Homebrew zig fails on this project.
- Test cells: reuse the `makeCell` pattern from `lib/renderer-core.test.ts:75` (all fields required by `GhosttyCell` in `lib/types.ts:1018`).
- One refinement vs the spec's §1 sketch: `RowBidiMap` carries a precomputed `mirror` map (logical col → mirrored codepoint) instead of raw `levels`; renderers never touch embedding levels directly.

---

### Task 1: Add bidi-js dependency + module declaration

**Files:**
- Modify: `package.json` (via `bun add bidi-js`)
- Create: `lib/bidi-js.d.ts`
- Create: `lib/bidi.test.ts` (smoke test only; grows in later tasks)

**Interfaces:**
- Consumes: nothing.
- Produces: importable typed `bidi-js` module for Task 2+. `bidiFactory(): BidiApi` with `getEmbeddingLevels`, `getReorderedIndices`, `getMirroredCharactersMap`, `getMirroredCharacter`.

Background: bidi-js 1.0.3 ships `dist/bidi.mjs` (self-contained ESM, no imports — its `require-from-string` npm dep never appears in the browser bundle, verified against the published tarball). It ships **no TypeScript types**, hence the local declaration.

- [ ] **Step 1: Add the dependency**

```bash
bun add bidi-js
```

Expected: `package.json` gains `"bidi-js": "^1.0.3"` under `dependencies`.

- [ ] **Step 2: Write the module declaration**

Create `lib/bidi-js.d.ts`:

```ts
/**
 * Local type declarations for bidi-js 1.0.3 (lojjic/bidi-js), which ships
 * no TypeScript types. API per its README; indices are UTF-16 code-unit
 * positions into the input string.
 */
declare module 'bidi-js' {
  export interface EmbeddingLevelsResult {
    /** Embedding level per code unit; odd = RTL scope. */
    levels: Uint8Array;
    paragraphs: { start: number; end: number; level: number }[];
  }
  export interface BidiApi {
    getEmbeddingLevels(text: string, explicitDirection?: 'ltr' | 'rtl'): EmbeddingLevelsResult;
    /** Returns indices in visual order: result[visualPos] = logical code-unit index. */
    getReorderedIndices(
      text: string,
      embeddingLevels: EmbeddingLevelsResult,
      start?: number,
      end?: number
    ): number[];
    getReorderSegments(
      text: string,
      embeddingLevels: EmbeddingLevelsResult,
      start?: number,
      end?: number
    ): [number, number][];
    getMirroredCharacter(char: string): string | null;
    /** Map of code-unit index → replacement character (UBA rule L4). */
    getMirroredCharactersMap(
      text: string,
      embeddingLevels: EmbeddingLevelsResult,
      start?: number,
      end?: number
    ): Map<number, string>;
  }
  export default function bidiFactory(): BidiApi;
}
```

- [ ] **Step 3: Write the smoke test**

Create `lib/bidi.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import bidiFactory from 'bidi-js';

describe('bidi-js smoke test', () => {
  test('factory initializes and reorders Hebrew', () => {
    const bidi = bidiFactory();
    const text = 'שלום'; // שלום
    const levels = bidi.getEmbeddingLevels(text, 'ltr');
    const indices = bidi.getReorderedIndices(text, levels);
    expect(indices).toEqual([3, 2, 1, 0]);
  });
});
```

- [ ] **Step 4: Run test + typecheck**

Run: `bun test lib/bidi.test.ts && bun run typecheck`
Expected: PASS, no type errors.

- [ ] **Step 5: Commit**

```bash
git add package.json bun.lock lib/bidi-js.d.ts lib/bidi.test.ts
git commit -m "feat(bidi): add bidi-js dependency with local type declarations"
```

---

### Task 2: `lib/bidi.ts` — RowBidiMap, RTL detection, identity fast path

**Files:**
- Create: `lib/bidi.ts`
- Modify: `lib/bidi.test.ts`

**Interfaces:**
- Consumes: `GhosttyCell` from `./types`, `KITTY_PLACEHOLDER` from `./kitty_diacritics`.
- Produces (used by every later task):
  - `interface RowBidiMap { isIdentity: boolean; visualToLogical: Uint16Array; logicalToVisual: Uint16Array; mirror: Map<number, number> | null }`
  - `class RowBidiMapper { getMap(line: GhosttyCell[]): RowBidiMap }`
  - `isIdentity === true` means "no bidi work at all for this row" (identity permutation AND nothing to mirror). Consumers may skip lookups when it's true; when false they must use the arrays.

- [ ] **Step 1: Write failing tests** (append to `lib/bidi.test.ts`)

```ts
import { RowBidiMapper } from './bidi';
import type { GhosttyCell } from './types';

function makeCell(overrides: Partial<GhosttyCell> = {}): GhosttyCell {
  return {
    codepoint: 0,
    fg_r: 0, fg_g: 0, fg_b: 0,
    bg_r: 0, bg_g: 0, bg_b: 0,
    fgIsDefault: true, bgIsDefault: true,
    flags: 0, width: 1, hyperlink_id: 0,
    grapheme_len: 0, grapheme: null,
    ...overrides,
  };
}

/** One cell per codepoint of `s`, width 1. Wide chars: use makeWide below. */
function cellsFrom(s: string): GhosttyCell[] {
  return [...s].map((ch) => makeCell({ codepoint: ch.codePointAt(0)! }));
}

describe('RowBidiMapper fast path', () => {
  const mapper = new RowBidiMapper();

  test('pure ASCII row returns identity', () => {
    const map = mapper.getMap(cellsFrom('hello'));
    expect(map.isIdentity).toBe(true);
    expect([...map.visualToLogical]).toEqual([0, 1, 2, 3, 4]);
    expect(map.mirror).toBeNull();
  });

  test('CJK row (codepoints above U+0590 but not RTL) returns identity', () => {
    const map = mapper.getMap(cellsFrom('漢字'));
    expect(map.isIdentity).toBe(true);
  });

  test('kitty placeholder row returns identity', () => {
    const line = [
      makeCell({ codepoint: 0x10eeee, grapheme_len: 2, grapheme: [0x305, 0x305] }),
      makeCell(),
    ];
    expect(mapper.getMap(line).isIdentity).toBe(true);
  });

  test('identity maps are shared per row length', () => {
    const a = mapper.getMap(cellsFrom('abc'));
    const b = mapper.getMap(cellsFrom('xyz'));
    expect(a).toBe(b);
  });

  test('empty row returns identity', () => {
    expect(mapper.getMap([]).isIdentity).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test lib/bidi.test.ts`
Expected: FAIL — `./bidi` module not found.

- [ ] **Step 3: Implement the skeleton**

Create `lib/bidi.ts`. In this task `getMap` only implements the fast path; the full path throws (replaced in Task 3):

```ts
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test lib/bidi.test.ts`
Expected: PASS (fast-path tests only touch `identity`).

- [ ] **Step 5: Commit**

```bash
git add lib/bidi.ts lib/bidi.test.ts
git commit -m "feat(bidi): RowBidiMapper skeleton with RTL detection and identity fast path"
```

---

### Task 3: `lib/bidi.ts` — full UBA path (permutation, wide-cell fusing, mirroring)

**Files:**
- Modify: `lib/bidi.ts` (replace `compute`)
- Modify: `lib/bidi.test.ts`

**Interfaces:**
- Consumes: Task 2's skeleton.
- Produces: fully working `getMap` (uncached; caching is Task 4).

- [ ] **Step 1: Write failing tests** (append to `lib/bidi.test.ts`; `makeCell`/`cellsFrom` from Task 2)

```ts
describe('RowBidiMapper full path', () => {
  const mapper = new RowBidiMapper();

  test('pure Hebrew row reverses', () => {
    const map = mapper.getMap(cellsFrom('שלום')); // 4 cells, class R
    expect(map.isIdentity).toBe(false);
    expect([...map.visualToLogical]).toEqual([3, 2, 1, 0]);
    expect([...map.logicalToVisual]).toEqual([3, 2, 1, 0]);
  });

  test('mixed LTR/RTL reorders only the RTL run', () => {
    // logical: a b ␠ ש ל ו ם ␠ c d   (indices 0..9)
    const map = mapper.getMap(cellsFrom('ab שלום cd'));
    expect([...map.visualToLogical]).toEqual([0, 1, 2, 6, 5, 4, 3, 7, 8, 9]);
  });

  test('logicalToVisual is the exact inverse of visualToLogical', () => {
    const map = mapper.getMap(cellsFrom('ab שלום cd'));
    for (let v = 0; v < map.visualToLogical.length; v++) {
      expect(map.logicalToVisual[map.visualToLogical[v]!]).toBe(v);
    }
  });

  test('Arabic (class AL) reverses like Hebrew (class R)', () => {
    const map = mapper.getMap(cellsFrom('عربي'));
    expect([...map.visualToLogical]).toEqual([3, 2, 1, 0]);
  });

  test('European digits (EN) inside Hebrew stay in LTR order', () => {
    // אב 12 גד — digits must read left-to-right within the RTL context
    const map = mapper.getMap(cellsFrom('אב 12 גד'));
    const d1 = map.logicalToVisual[3]!; // '1'
    const d2 = map.logicalToVisual[4]!; // '2'
    expect(d2).toBe(d1 + 1); // adjacent, '1' left of '2'
    // Hebrew still reversed: א paints right of ב
    expect(map.logicalToVisual[0]!).toBeGreaterThan(map.logicalToVisual[1]!);
  });

  test('Arabic-Indic digits (AN) inside Arabic stay in LTR order', () => {
    // ﻋﺮﺑﻲ + ٤٥٦ (U+0664..0666, class AN)
    const map = mapper.getMap(cellsFrom('عربي ٤٥٦'));
    const d4 = map.logicalToVisual[5]!; // ٤
    const d5 = map.logicalToVisual[6]!; // ٥
    const d6 = map.logicalToVisual[7]!; // ٦
    expect(d5).toBe(d4 + 1);
    expect(d6).toBe(d5 + 1);
  });

  test('Persian Extended digits (EN class) inside Persian stay in LTR order', () => {
    // ۴۵۶ are U+06F4..06F6, class EN — different class from ٤٥٦, same visual expectation
    const map = mapper.getMap(cellsFrom('فارسی ۴۵۶'));
    const d4 = map.logicalToVisual[6]!;
    const d5 = map.logicalToVisual[7]!;
    expect(d5).toBe(d4 + 1);
  });

  test('parentheses in an RTL run are mirrored (UBA L4)', () => {
    // א(ב)ג — the parens sit between strong R chars → odd level → mirrored
    const line = cellsFrom('א(ב)ג');
    const map = mapper.getMap(line);
    expect(map.mirror).not.toBeNull();
    expect(map.mirror!.get(1)).toBe(')'.codePointAt(0)!); // logical '(' paints as ')'
    expect(map.mirror!.get(3)).toBe('('.codePointAt(0)!); // logical ')' paints as '('
  });

  test('wide cell and its spacer move as a fused unit', () => {
    // logical: a b 漢 [spacer] ש ל ו ם   (漢 is width 2, spacer width 0)
    const line = [
      ...cellsFrom('ab'),
      makeCell({ codepoint: '漢'.codePointAt(0)!, width: 2 }),
      makeCell({ codepoint: 0, width: 0 }),
      ...cellsFrom('שלום'),
    ];
    const map = mapper.getMap(line);
    expect([...map.visualToLogical]).toEqual([0, 1, 2, 3, 7, 6, 5, 4]);
    // spacer (logical 3) immediately follows its base (logical 2) visually
    expect(map.logicalToVisual[3]).toBe(map.logicalToVisual[2]! + 1);
  });

  test('trailing empty cells stay in place (LTR base direction)', () => {
    const line = [...cellsFrom('שלום'), makeCell(), makeCell()];
    const map = mapper.getMap(line);
    expect([...map.visualToLogical]).toEqual([3, 2, 1, 0, 4, 5]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test lib/bidi.test.ts`
Expected: FAIL with "implemented in the next commit".

- [ ] **Step 3: Implement `compute`**

Replace the `compute` stub in `lib/bidi.ts`:

```ts
  private compute(line: GhosttyCell[]): RowBidiMap {
    const n = line.length;
    const bidi = this.bidi!; // caller guarantees non-null

    // Build the row string with one codepoint per non-spacer cell,
    // recording which cell owns each UTF-16 code unit (astral codepoints
    // occupy two units). Spacer cells (width 0) contribute nothing and are
    // re-attached after their wide base below. Grapheme extras are omitted:
    // they are combining marks (class NSM), which UBA rule W1 resolves to
    // the base character's class anyway — invisible at cell granularity.
    let text = '';
    const cellForUnit: number[] = [];
    for (let i = 0; i < n; i++) {
      const cell = line[i]!;
      if (cell.width === 0) continue;
      // Empty cells → space (neutral). Kitty placeholders → 'A' (strong
      // LTR): they are image slices whose row/col diacritics must never
      // reorder, so pin them, don't let them resolve like neutrals.
      const cp = cell.codepoint === KITTY_PLACEHOLDER ? 0x41 : cell.codepoint || 0x20;
      const s = String.fromCodePoint(cp);
      text += s;
      for (let u = 0; u < s.length; u++) cellForUnit.push(i);
    }

    const levels = bidi.getEmbeddingLevels(text, 'ltr');
    const indices = bidi.getReorderedIndices(text, levels);

    // Project the code-unit permutation to cell level: walk visual order,
    // appending each owning cell the first time one of its units appears.
    // (Both units of a surrogate pair own the same cell, so pair-order
    // inside the reordered output is irrelevant here.)
    const visualOrder: number[] = [];
    const seen = new Uint8Array(n);
    for (let v = 0; v < indices.length; v++) {
      const cellIdx = cellForUnit[indices[v]!]!;
      if (seen[cellIdx]) continue;
      seen[cellIdx] = 1;
      visualOrder.push(cellIdx);
      // Fuse wide pairs: the width-0 spacer that follows a wide base in
      // logical order rides immediately after it in visual order, keeping
      // the two-column glyph span intact for the renderers.
      if (line[cellIdx]!.width === 2 && cellIdx + 1 < n && line[cellIdx + 1]!.width === 0) {
        seen[cellIdx + 1] = 1;
        visualOrder.push(cellIdx + 1);
      }
    }
    // Defensive: any cell not seen (e.g. an orphaned spacer with no wide
    // base before it) keeps its relative order at the end.
    for (let i = 0; i < n; i++) if (!seen[i]) visualOrder.push(i);

    const visualToLogical = new Uint16Array(n);
    const logicalToVisual = new Uint16Array(n);
    let identityPerm = true;
    for (let v = 0; v < n; v++) {
      const l = visualOrder[v]!;
      visualToLogical[v] = l;
      logicalToVisual[l] = v;
      if (l !== v) identityPerm = false;
    }

    let mirror: Map<number, number> | null = null;
    const mirrorUnits = bidi.getMirroredCharactersMap(text, levels);
    if (mirrorUnits.size > 0) {
      mirror = new Map();
      for (const [unit, char] of mirrorUnits) {
        mirror.set(cellForUnit[unit]!, char.codePointAt(0)!);
      }
    }

    return {
      isIdentity: identityPerm && mirror === null,
      visualToLogical,
      logicalToVisual,
      mirror,
    };
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test lib/bidi.test.ts`
Expected: PASS. If the `mixed LTR/RTL` expectation fails, print the actual array and verify against a browser `<div>` rendering (see spec §6) before adjusting the expectation — the test encodes UBA ground truth, not the implementation's opinion.

- [ ] **Step 5: Commit**

```bash
git add lib/bidi.ts lib/bidi.test.ts
git commit -m "feat(bidi): full UBA permutation with wide-cell fusing and L4 mirroring"
```

---

### Task 4: `lib/bidi.ts` — content-keyed LRU cache

**Files:**
- Modify: `lib/bidi.ts`
- Modify: `lib/bidi.test.ts`

**Interfaces:**
- Consumes: Tasks 2–3.
- Produces: same public API; repeated `getMap` calls with identical content return the same object.

- [ ] **Step 1: Write failing tests** (append)

```ts
describe('RowBidiMapper cache', () => {
  test('same content returns the same map object', () => {
    const mapper = new RowBidiMapper();
    const a = mapper.getMap(cellsFrom('שלום'));
    const b = mapper.getMap(cellsFrom('שלום'));
    expect(a).toBe(b);
  });

  test('different content with same length gets a different map', () => {
    const mapper = new RowBidiMapper();
    const a = mapper.getMap(cellsFrom('שלום'));
    const b = mapper.getMap(cellsFrom('םולש'));
    expect(a).not.toBe(b);
  });

  test('width participates in the cache key', () => {
    const mapper = new RowBidiMapper();
    // Same codepoints, different width layout must not collide.
    const narrow = [...cellsFrom('ש'), makeCell({ codepoint: 0x6f22, width: 1 })];
    const wide = [...cellsFrom('ש'), makeCell({ codepoint: 0x6f22, width: 2 })];
    expect(mapper.getMap(narrow)).not.toBe(mapper.getMap(wide));
  });

  test('cache evicts oldest beyond capacity without breaking correctness', () => {
    const mapper = new RowBidiMapper();
    const first = cellsFrom('שלום');
    const firstMap = mapper.getMap(first);
    for (let i = 0; i < 600; i++) {
      // 600 DISTINCT rows (0x0591+i stays within the 0x0590–0x08FF RTL
      // trigger range for i < 600) — must exceed CACHE_MAX=512 to evict.
      mapper.getMap([...cellsFrom('א'), makeCell({ codepoint: 0x0591 + i })]);
    }
    // Recompute after eviction: equal content, correct values (object identity not required).
    expect([...mapper.getMap(first).visualToLogical]).toEqual([...firstMap.visualToLogical]);
  });
});
```

- [ ] **Step 2: Run tests to verify the identity assertions fail**

Run: `bun test lib/bidi.test.ts`
Expected: `same content returns the same map object` FAILS (compute allocates fresh maps today); the others pass vacuously or fail — fine.

- [ ] **Step 3: Implement the cache**

In `RowBidiMapper`, add fields and rewrite the full-path tail of `getMap`:

```ts
  /** FNV-1a-hashed, content-verified LRU. ~512 entries ≈ several screens of
   *  distinct RTL rows; maps are cheap to recompute on miss. */
  private static readonly CACHE_MAX = 512;
  private cache = new Map<number, { key: Uint32Array; map: RowBidiMap }>();
```

In `getMap`, replace `return this.compute(line);` with:

```ts
    // Content key: codepoint + width per cell (width matters — it drives
    // wide-pair fusing). Verified on hit: a hash collision must recompute,
    // never silently permute with the wrong map.
    const key = new Uint32Array(line.length);
    let h = 0x811c9dc5;
    for (let i = 0; i < line.length; i++) {
      const k = ((line[i]!.codepoint << 2) | (line[i]!.width & 3)) >>> 0;
      key[i] = k;
      h = Math.imul(h ^ k, 0x01000193) >>> 0;
    }
    const hit = this.cache.get(h);
    if (hit && hit.key.length === key.length && hit.key.every((v, i) => v === key[i])) {
      this.cache.delete(h); // LRU touch: re-insert as newest
      this.cache.set(h, hit);
      return hit.map;
    }
    const map = this.compute(line);
    this.cache.set(h, { key, map });
    if (this.cache.size > RowBidiMapper.CACHE_MAX) {
      this.cache.delete(this.cache.keys().next().value!);
    }
    return map;
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test lib/bidi.test.ts && bun run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/bidi.ts lib/bidi.test.ts
git commit -m "feat(bidi): content-keyed LRU cache with collision verification"
```

---

### Task 5: Plumbing — `setBidiMapper` on renderers, `EncodeCellsContext`, Terminal wiring

No behavior change yet: the mapper flows to every consumer but nothing reads it. This task is pure wiring so Tasks 6–10 each stay small.

**Files:**
- Modify: `lib/renderer-types.ts` (Renderer interface, ~line 95, next to `setSelectionManager`)
- Modify: `lib/renderer-core.ts` (`EncodeCellsContext`, ~line 377)
- Modify: `lib/renderer-canvas2d.ts`, `lib/renderer-webgl.ts`, `lib/renderer-webgpu.ts` (field + setter; GPU wrappers pass ctx field)
- Modify: `lib/selection-manager.ts` (constructor 5th param, ~line 102)
- Modify: `lib/terminal.ts` (mapper field; `setBidiMapper` after `setSelectionManager` at ~line 551; SelectionManager construction at ~line 543 AND the renderer-swap site at ~line 664)

**Interfaces:**
- Consumes: `RowBidiMapper` from Task 2.
- Produces:
  - `Renderer.setBidiMapper?(mapper: RowBidiMapper): void` (optional in the interface so existing test mocks stay valid; all three real renderers implement it and store `private bidiMapper: RowBidiMapper | null = null`).
  - `EncodeCellsContext.bidiMapper?: RowBidiMapper | null` (optional for the same reason).
  - `SelectionManager` constructor: `(terminal, renderer, wasmTerm, textarea, bidiMapper: RowBidiMapper)` storing `private bidiMapper`.
  - `Terminal` owns `private bidiMapper = new RowBidiMapper();`

- [ ] **Step 1: Renderer interface** — in `lib/renderer-types.ts` add after `setSelectionManager(mgr: SelectionManager): void;`:

```ts
  /**
   * Provide the shared BiDi row mapper. Optional: renderers without it
   * paint logical order (pre-BiDi behavior).
   */
  setBidiMapper?(mapper: RowBidiMapper): void;
```

with `import type { RowBidiMapper } from './bidi';` at the top.

- [ ] **Step 2: EncodeCellsContext** — in `lib/renderer-core.ts` add to the interface:

```ts
  /** BiDi row mapper; when absent, cells paint in logical order. */
  bidiMapper?: RowBidiMapper | null;
```

with `import type { RowBidiMapper } from './bidi';`.

- [ ] **Step 3: All three renderers** — add to each class (`CanvasRenderer`, `WebGLRenderer`, `WebGPURenderer`):

```ts
  private bidiMapper: RowBidiMapper | null = null;

  setBidiMapper(mapper: RowBidiMapper): void {
    this.bidiMapper = mapper;
    this.invalidateNext = true; // repaint with reordering active
  }
```

(canvas2d: check the class's existing invalidate mechanism — it has `invalidate()`; call `this.invalidate()` instead if there is no `invalidateNext` field. Use whatever the class already uses to force the next frame.)

In `lib/renderer-webgl.ts:634` and `lib/renderer-webgpu.ts:908`, add to the ctx object literal passed to `coreEncodeCells`:

```ts
      bidiMapper: this.bidiMapper,
```

- [ ] **Step 4: SelectionManager constructor** — 5th parameter:

```ts
  constructor(
    terminal: Terminal,
    renderer: Renderer,
    wasmTerm: GhosttyTerminal,
    textarea: HTMLTextAreaElement,
    bidiMapper: RowBidiMapper
  ) {
    ...
    this.bidiMapper = bidiMapper;
```

with field `private bidiMapper: RowBidiMapper;` and the type import.

- [ ] **Step 5: Terminal wiring** — in `lib/terminal.ts`:
  - Field: `private bidiMapper = new RowBidiMapper();` (plus import).
  - Both `new SelectionManager(...)` sites (~543 and ~664): append `this.bidiMapper` as 5th arg.
  - After each `renderer.setSelectionManager(...)` call (~551 and ~670): `this.renderer!.setBidiMapper?.(this.bidiMapper);`

- [ ] **Step 6: Verify — typecheck + full test suite**

Run: `bun run typecheck && bun test`
Expected: clean typecheck; all existing tests still pass (no behavior changed).

- [ ] **Step 7: Commit**

```bash
git add lib/renderer-types.ts lib/renderer-core.ts lib/renderer-canvas2d.ts lib/renderer-webgl.ts lib/renderer-webgpu.ts lib/selection-manager.ts lib/terminal.ts
git commit -m "feat(bidi): plumb RowBidiMapper to renderers, selection manager, and terminal"
```

---

### Task 6: `encodeCells` — visual reordering, logical link ranges, mirroring, block-cursor flag

**Files:**
- Modify: `lib/renderer-core.ts:491-641` (`encodeCells` row/col loops + cursor-flag tail)
- Modify: `lib/renderer-core.test.ts`

**Interfaces:**
- Consumes: `ctx.bidiMapper` (Task 5), `RowBidiMap` (Task 2).
- Produces: GPU instance data in visual order for both GPU backends. No shader changes.

- [ ] **Step 1: Write failing tests** (new `describe('encodeCells: bidi reordering', ...)` in `lib/renderer-core.test.ts`, reusing that file's existing `makeCell`/`makeStubBuffer` — hoist them to file scope if they are local to another describe block)

```ts
import { RowBidiMapper } from './bidi';

describe('encodeCells: bidi reordering', () => {
  const baseCtx = {
    metrics: { width: 8, height: 16, baseline: 12 },
    selectionManager: undefined,
    hoveredHyperlinkId: 0,
    hoveredLinkRange: null,
    cursorStyle: 'block' as const,
    cursorBlinkVisible: false,
    atlas: undefined,
    kittyEnabled: false,
    blockElementShaderEnabled: false,
    bidiMapper: new RowBidiMapper(),
  };

  // Row: a ש ל ו b + empty  → visualToLogical [0,3,2,1,4,5].
  // Tag each cell with a distinct fg_r so the test can see which logical
  // cell landed at which visual slot.
  function hebrewRow(cols: number): GhosttyCell[] {
    const cps = [0x61, 0x5e9, 0x5dc, 0x5d5, 0x62]; // a ש ל ו b
    const cells = cps.map((cp, i) =>
      makeCell({ codepoint: cp, fg_r: i + 1, fgIsDefault: false })
    );
    while (cells.length < cols) cells.push(makeCell());
    return cells;
  }

  test('cells land at visual positions', () => {
    const cols = 6, rows = 1;
    const buffer = makeStubBuffer({ cols, rows, cells: hebrewRow(cols), placements: [] });
    const cellArray = new Uint32Array(cols * rows * CELL_U32S);
    encodeCells(cellArray, buffer, 0, undefined, baseCtx);
    // visual x=1 must hold logical cell 3 (ו, fg_r=4); x=3 holds logical 1 (ש, fg_r=2)
    expect(cellArray[(0 * cols + 1) * CELL_U32S + 0]! & 0xff).toBe(4);
    expect(cellArray[(0 * cols + 3) * CELL_U32S + 0]! & 0xff).toBe(2);
    // LTR cells stay put
    expect(cellArray[(0 * cols + 0) * CELL_U32S + 0]! & 0xff).toBe(1);
    expect(cellArray[(0 * cols + 4) * CELL_U32S + 0]! & 0xff).toBe(5);
  });

  test('hovered link range flags follow LOGICAL columns', () => {
    const cols = 6, rows = 1;
    const buffer = makeStubBuffer({ cols, rows, cells: hebrewRow(cols), placements: [] });
    const cellArray = new Uint32Array(cols * rows * CELL_U32S);
    const ctx = {
      ...baseCtx,
      // Logical col 1 only (ש) — its glyph paints at visual x=3.
      hoveredLinkRange: { startX: 1, startY: 0, endX: 1, endY: 0 },
    };
    encodeCells(cellArray, buffer, 0, undefined, ctx);
    expect(cellArray[(0 * cols + 3) * CELL_U32S + 4]! & FLAG_IS_LINK_RANGE_HOVERED).toBeTruthy();
    expect(cellArray[(0 * cols + 1) * CELL_U32S + 4]! & FLAG_IS_LINK_RANGE_HOVERED).toBeFalsy();
  });

  test('block cursor flag lands at the visual cursor cell', () => {
    const cols = 6, rows = 1;
    const buffer = makeStubBuffer({ cols, rows, cells: hebrewRow(cols), placements: [] });
    // stub cursor: logical x=1 (ש) → visual x=3
    buffer.getCursor = () => ({ x: 1, y: 0, visible: true });
    const cellArray = new Uint32Array(cols * rows * CELL_U32S);
    encodeCells(cellArray, buffer, 0, undefined, { ...baseCtx, cursorBlinkVisible: true });
    expect(cellArray[(0 * cols + 3) * CELL_U32S + 4]! & FLAG_IS_CURSOR_CELL).toBeTruthy();
    expect(cellArray[(0 * cols + 1) * CELL_U32S + 4]! & FLAG_IS_CURSOR_CELL).toBeFalsy();
  });

  test('mirrored characters reach the atlas mirrored', () => {
    const cols = 5, rows = 1;
    const rastered: string[] = [];
    const atlas = {
      getOrRaster(grapheme: string) {
        rastered.push(grapheme);
        return { u: 0, v: 0, w: 8, h: 16 };
      },
    };
    // א ( ב ) ג — parens on odd level mirror at paint time
    const cells = [...'א(ב)ג'].map((ch) => makeCell({ codepoint: ch.codePointAt(0)! }));
    const buffer = makeStubBuffer({ cols, rows, cells, placements: [] });
    const cellArray = new Uint32Array(cols * rows * CELL_U32S);
    encodeCells(cellArray, buffer, 0, undefined, { ...baseCtx, atlas: atlas as any });
    expect(rastered).toContain(')'); // both get rastered…
    expect(rastered).toContain('(');
    // …and the '(' logical cell produced a ')' raster call count-wise:
    expect(rastered.filter((g) => g === ')').length).toBe(1);
  });
});
```

Adjust imports at the top of the test file as needed (`FLAG_IS_LINK_RANGE_HOVERED`, `FLAG_IS_CURSOR_CELL` are exported from `./renderer-core`). If `makeStubBuffer`'s `getCursor` is not writable, extend `StubRenderableOpts` with an optional `cursor` field instead.

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test lib/renderer-core.test.ts`
Expected: the four new tests FAIL (cells land at logical positions today).

- [ ] **Step 3: Implement**

In `encodeCells` (`lib/renderer-core.ts`):

(a) After the `line` fetch (line ~506), resolve the row map:

```ts
    const bidiMap = ctx.bidiMapper && line ? ctx.bidiMapper.getMap(line) : null;
    const reorder = bidiMap !== null && !bidiMap.isIdentity;
```

(b) In the `for (let x = 0; x < dims.cols; x++)` loop (line ~516), fetch through the map — the visual write index `i` is untouched:

```ts
      const i = (y * dims.cols + x) * CELL_U32S;
      const lx = reorder && x < bidiMap!.visualToLogical.length ? bidiMap!.visualToLogical[x]! : x;
      const c = line && lx < line.length ? line[lx] : null;
```

(c) The two range checks compare **logical** columns — replace `x` with `lx` ONLY in these:
- hyperlink hover: unchanged (`c.hyperlink_id` is per-cell).
- `hoveredLinkRange` block (~line 548): every `x` inside the `inRange` expression becomes `lx`.
- selection (`if (x >= selStartCol && x <= selEndCol)`) stays `x` — selection is visual.

(d) Mirroring — where the grapheme string is built for the atlas (~line 603):

```ts
        const mirroredCp = reorder ? bidiMap!.mirror?.get(lx) : undefined;
        const baseCp = mirroredCp ?? (c.codepoint || 32);
        const grapheme =
          extras && extras.length > 0
            ? String.fromCodePoint(baseCp, ...extras)
            : String.fromCodePoint(baseCp);
```

(e) Block-cursor flag (~line 638) — map the cursor column through the cursor row's map:

```ts
  if (cursor.visible && ctx.cursorBlinkVisible && ctx.cursorStyle === 'block') {
    let cursorX = cursor.x;
    if (ctx.bidiMapper) {
      const start = cursor.y * dims.cols;
      const cline = viewport.slice(start, start + dims.cols);
      const m = ctx.bidiMapper.getMap(cline);
      if (!m.isIdentity && cursor.x < m.logicalToVisual.length) {
        cursorX = m.logicalToVisual[cursor.x]!;
      }
    }
    const ci = (cursor.y * dims.cols + cursorX) * CELL_U32S;
    arr[ci + 4] = (arr[ci + 4]! | FLAG_IS_CURSOR_CELL) >>> 0;
  }
```

Do NOT touch the `pendingRightHalf` logic — wide-pair fusing (Task 3) guarantees the spacer arrives at the visual position right after its base, which is exactly the invariant that code depends on.

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test lib/renderer-core.test.ts && bun test`
Expected: new tests PASS; the whole suite stays green (identity fast path keeps LTR rows byte-identical).

- [ ] **Step 5: Commit**

```bash
git add lib/renderer-core.ts lib/renderer-core.test.ts
git commit -m "feat(bidi): encodeCells paints visual order (WebGL+WebGPU) with logical link ranges and mirrored glyphs"
```

---

### Task 7: canvas2d — `renderLine` + `renderCursor`

**Files:**
- Modify: `lib/renderer-canvas2d.ts:687-716` (`renderLine`), `:768` (`renderCellText` signature), `:1411-1452` (`renderCursor`)
- Modify: `lib/renderer-canvas2d.test.ts`

**Interfaces:**
- Consumes: `this.bidiMapper` (Task 5), `RowBidiMap` (Task 2).
- Produces: `renderCellText(cell, x, y, colorOverride?, mirrorCodepoint?)` — new optional 5th param.

- [ ] **Step 1: Write failing test** (append to `lib/renderer-canvas2d.test.ts`)

```ts
import { RowBidiMapper } from './bidi';

describe('bidi reordering (canvas2d)', () => {
  function makeCellC(overrides: Partial<GhosttyCell> = {}): GhosttyCell {
    return {
      codepoint: 0,
      fg_r: 0, fg_g: 0, fg_b: 0,
      bg_r: 0, bg_g: 0, bg_b: 0,
      fgIsDefault: true, bgIsDefault: true,
      flags: 0, width: 1, hyperlink_id: 0,
      grapheme_len: 0, grapheme: null,
      ...overrides,
    };
  }

  test('renderLine draws glyphs at visual x positions', () => {
    const canvas = document.createElement('canvas');
    const renderer = new CanvasRenderer(canvas);
    renderer.setBidiMapper(new RowBidiMapper());

    // Deterministic metrics + a recording ctx stub (happy-dom's 2d context
    // is not a real rasterizer; we only need the call log).
    (renderer as any).metrics = { width: 10, height: 20, baseline: 15 };
    const fillTexts: { char: string; x: number }[] = [];
    (renderer as any).ctx = {
      clearRect() {}, fillRect() {}, beginPath() {}, rect() {}, clip() {},
      save() {}, restore() {}, stroke() {}, strokeRect() {},
      moveTo() {}, lineTo() {}, setLineDash() {}, drawImage() {},
      measureText() { return { width: 10 }; },
      fillText(char: string, x: number) { fillTexts.push({ char, x }); },
      set font(_v: string) {}, set fillStyle(_v: string) {},
      set strokeStyle(_v: string) {}, set lineWidth(_v: number) {},
      set globalAlpha(_v: number) {},
    };

    // logical: a ש ל b  → visual: a ל ש b  (v2l = [0,2,1,3])
    const line = ['a', 'ש', 'ל', 'b'].map((ch) =>
      makeCellC({ codepoint: ch.codePointAt(0)! })
    );
    (renderer as any).renderLine(line, 0, 4);

    const at = (x: number) => fillTexts.find((f) => f.x === x)?.char;
    expect(at(0)).toBe('a');
    expect(at(10)).toBe('ל');
    expect(at(20)).toBe('ש');
    expect(at(30)).toBe('b');
  });
});
```

(If the ctx stub setters clash with how the class reads properties back — e.g. `this.ctx.fillStyle` is read for underline color — switch the setters to plain writable fields: `font: '', fillStyle: '', strokeStyle: '', lineWidth: 1, globalAlpha: 1`.)

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test lib/renderer-canvas2d.test.ts`
Expected: new test FAILS — `ש` painted at x=10 (logical order).

- [ ] **Step 3: Implement**

(a) `renderLine` (line ~687): resolve the map once, iterate visual positions:

```ts
  private renderLine(line: GhosttyCell[], y: number, cols: number): void {
    ...
    const map = this.bidiMapper?.getMap(line) ?? null;
    const reorder = map !== null && !map.isIdentity;

    // PASS 1: backgrounds, in visual order
    for (let x = 0; x < line.length; x++) {
      const cell = line[reorder ? map!.visualToLogical[x]! : x]!;
      if (cell.width === 0) continue;
      this.renderCellBackground(cell, x, y);
    }

    // PASS 2: text and decorations, in visual order
    for (let x = 0; x < line.length; x++) {
      const lx = reorder ? map!.visualToLogical[x]! : x;
      const cell = line[lx]!;
      if (cell.width === 0) continue;
      this.renderCellText(cell, x, y, undefined, reorder ? map!.mirror?.get(lx) : undefined);
    }
  }
```

(b) `renderCellText` (line ~768): add the optional param and use it when building the drawn string:

```ts
  private renderCellText(
    cell: GhosttyCell,
    x: number,
    y: number,
    colorOverride?: string,
    mirrorCodepoint?: number
  ): void {
```

and at the char-building site (~line 839):

```ts
    const extras = cell.grapheme;
    const baseCp = mirrorCodepoint ?? (cell.codepoint || 32);
    const char =
      extras && extras.length > 0
        ? String.fromCodePoint(baseCp, ...extras)
        : String.fromCodePoint(baseCp);
```

(The block-element fast path at ~line 851 keys on `cell.codepoint` — leave it; block elements are class ON and never mirror or join RTL runs.)

(c) `renderCursor` (line ~1411): map position AND keep drawing the logical cell:

```ts
  private renderCursor(x: number, y: number): void {
    const line = this.currentBuffer?.getLine(y) ?? null;
    const map = line ? (this.bidiMapper?.getMap(line) ?? null) : null;
    const vx =
      map && !map.isIdentity && x < map.logicalToVisual.length
        ? map.logicalToVisual[x]!
        : x;
    const cursorX = vx * this.metrics.width;
    const cursorY = y * this.metrics.height;
    ...
      case 'block':
        this.ctx.fillRect(cursorX, cursorY, this.metrics.width, this.metrics.height);
        {
          if (line?.[x]) {
            this.ctx.save();
            this.ctx.beginPath();
            this.ctx.rect(cursorX, cursorY, this.metrics.width, this.metrics.height);
            this.ctx.clip();
            this.renderCellText(line[x], vx, y, this.theme.cursorAccent, map?.mirror?.get(x));
            this.ctx.restore();
          }
        }
        break;
```

(`underline`/`bar` cases already position off `cursorX` — they inherit the fix.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test lib/renderer-canvas2d.test.ts && bun test`
Expected: PASS, suite green.

- [ ] **Step 5: Commit**

```bash
git add lib/renderer-canvas2d.ts lib/renderer-canvas2d.test.ts
git commit -m "feat(bidi): canvas2d paints visual order with mirrored glyphs and mapped cursor"
```

---

### Task 8: GPU cursor quad — `visualCursorX` helper + both uniform callsites

The block-style cursor was handled inside `encodeCells` (Task 6). Underline/bar cursors on GPU backends are drawn as a separate quad positioned by the `cursorX` uniform — that still carries the logical column.

**Files:**
- Modify: `lib/renderer-core.ts` (new exported helper, near `encodeCells`)
- Modify: `lib/renderer-webgl.ts` (~line 799, the `uploadGridUBO(viewportY, cursor)` call in `render()`)
- Modify: `lib/renderer-webgpu.ts` (same pattern, `render()` at ~line 1063+)
- Modify: `lib/renderer-core.test.ts`

**Interfaces:**
- Consumes: `RowBidiMapper` (Task 2), `IRenderable.getLine`/`getCursor`.
- Produces: `export function visualCursorX(buffer: IRenderable, cursor: { x: number; y: number }, mapper: RowBidiMapper | null): number`

- [ ] **Step 1: Write failing test** (append to `lib/renderer-core.test.ts`)

```ts
describe('visualCursorX', () => {
  test('maps logical cursor column to visual on an RTL row', () => {
    const cols = 6, rows = 1;
    const buffer = makeStubBuffer({ cols, rows, cells: hebrewRow(cols), placements: [] });
    const mapper = new RowBidiMapper();
    // hebrewRow: a ש ל ו b _  → logical 1 (ש) paints at visual 3
    expect(visualCursorX(buffer, { x: 1, y: 0 }, mapper)).toBe(3);
    expect(visualCursorX(buffer, { x: 0, y: 0 }, mapper)).toBe(0);
    expect(visualCursorX(buffer, { x: 1, y: 0 }, null)).toBe(1);
  });
});
```

(`hebrewRow` from Task 6 — hoist it to file scope alongside `makeCell` if it isn't already.)

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test lib/renderer-core.test.ts`
Expected: FAIL — `visualCursorX` not exported.

- [ ] **Step 3: Implement**

In `lib/renderer-core.ts`:

```ts
/**
 * Map the VT cursor's logical column to its visual column on the cursor's
 * row. Used for the GPU backends' cursor-quad uniform; canvas2d does the
 * equivalent inline in renderCursor().
 */
export function visualCursorX(
  buffer: IRenderable,
  cursor: { x: number; y: number },
  mapper: RowBidiMapper | null
): number {
  if (!mapper) return cursor.x;
  const line = buffer.getLine(cursor.y);
  if (!line) return cursor.x;
  const m = mapper.getMap(line);
  if (m.isIdentity || cursor.x >= m.logicalToVisual.length) return cursor.x;
  return m.logicalToVisual[cursor.x]!;
}
```

In `lib/renderer-webgl.ts` `render()` (~line 799) and `lib/renderer-webgpu.ts` `render()` — replace the `uploadGridUBO(viewportY, cursor)` call in each:

```ts
    this.uploadGridUBO(viewportY, {
      ...cursor,
      x: visualCursorX(buffer, cursor, this.bidiMapper),
    });
```

(add `visualCursorX` to each file's existing `from './renderer-core'` import list). The frame-skip trackers (`lastCursorX` etc.) keep comparing the **logical** `cursor.x` — do not change those lines; logical movement is exactly what should invalidate the gate.

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test lib/renderer-core.test.ts && bun run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/renderer-core.ts lib/renderer-core.test.ts lib/renderer-webgl.ts lib/renderer-webgpu.ts
git commit -m "feat(bidi): GPU cursor quad positions at the visual cursor column"
```

---

### Task 9: Selection — logical-order copy, word/line select

**Files:**
- Modify: `lib/selection-manager.ts:124-200` (`getSelection`), `:597-617` (dblclick handler — no change needed, verify only), `:909-946` (`getWordAtCell`)
- Modify: `lib/selection-manager.test.ts`

**Interfaces:**
- Consumes: `this.bidiMapper` (Task 5).
- Produces: `getSelection()` returns logical-order text for visual spans; `getWordAtCell(col, row)` takes a VISUAL col and returns a VISUAL span (its scan is logical internally).

- [ ] **Step 1: Write failing tests** (append to `lib/selection-manager.test.ts`, using its existing `setSelectionAbsolute` helper and `createIsolatedTerminal`)

```ts
describe('BiDi selection', () => {
  test('full-row selection over Hebrew copies logical order', async () => {
    if (!container) return;
    const term = await createIsolatedTerminal({ cols: 80, rows: 24 });
    await term.open(container);
    term.write('אבג');
    setSelectionAbsolute(term, 0, 0, 2, 0);
    const selMgr = (term as any).selectionManager;
    expect(selMgr.getSelection()).toBe('אבג');
    term.dispose();
  });

  test('partial visual selection maps to the correct logical cells', async () => {
    if (!container) return;
    const term = await createIsolatedTerminal({ cols: 80, rows: 24 });
    await term.open(container);
    term.write('אבג'); // visual: ג ב א — visual cols 0..1 are ג ב = logical 1..2
    setSelectionAbsolute(term, 0, 0, 1, 0);
    const selMgr = (term as any).selectionManager;
    expect(selMgr.getSelection()).toBe('בג');
    term.dispose();
  });

  test('visual selection across an LTR/RTL boundary yields disjoint logical ranges in logical order', async () => {
    if (!container) return;
    const term = await createIsolatedTerminal({ cols: 80, rows: 24 });
    await term.open(container);
    term.write('ab אבג cd');
    // logical: a b ␠ א ב ג ␠ c d ; visual: a b ␠ ג ב א ␠ c d
    // visual cols 2..4 hold logical {2, 5, 4}; sorted ascending = [2, 4, 5]
    // = '␠', 'ב', 'ג' → clipboard carries ' בג'
    setSelectionAbsolute(term, 2, 0, 4, 0);
    const selMgr = (term as any).selectionManager;
    expect(selMgr.getSelection()).toBe(' בג');
    term.dispose();
  });

  test('double-click word selection works on a Hebrew word', async () => {
    if (!container) return;
    const term = await createIsolatedTerminal({ cols: 80, rows: 24 });
    await term.open(container);
    term.write('שלום עולם');
    const selMgr = (term as any).selectionManager;
    // First word שלום: logical cols 0..3, visual span also 0..3 (run maps
    // onto itself). Click at visual col 1.
    const word = (selMgr as any).getWordAtCell(1, 0);
    expect(word).toEqual({ startCol: 0, endCol: 3 });
    setSelectionAbsolute(term, word.startCol, 0, word.endCol, 0);
    expect(selMgr.getSelection()).toBe('שלום');
    term.dispose();
  });
});
```

- [ ] **Step 2: Run tests to verify current behavior fails**

Run: `bun test lib/selection-manager.test.ts`
Expected: `partial visual selection` and `LTR/RTL boundary` FAIL (today's copy walks visual==logical). `full-row` may pass already (full permutation sorts back to the whole row) — that's fine, it pins the invariant. `word selection` FAILS (`isWordChar` rejects Hebrew).

- [ ] **Step 3: Implement**

(a) `getSelection` (line ~160): replace the per-row column walk. Old code iterates `col = colStart..colEnd` directly; new code converts the visual span to sorted logical columns first:

```ts
      // Determine the VISUAL column range for this row (anchors are visual)
      const colStart = absRow === startAbsRow ? startCol : 0;
      const colEnd = absRow === endAbsRow ? endCol : line.length - 1;

      // Map the visual span to logical columns, ascending. A visually
      // contiguous span over mixed LTR/RTL text is several disjoint logical
      // ranges; sorting yields the PTY's logical order, which is what the
      // clipboard must carry.
      const map = this.bidiMapper.getMap(line);
      const logicalCols: number[] = [];
      for (let v = colStart; v <= colEnd && v < line.length; v++) {
        if (v < 0) continue;
        logicalCols.push(map.isIdentity ? v : map.visualToLogical[v]!);
      }
      logicalCols.sort((a, b) => a - b);

      let lineText = '';
      for (const col of logicalCols) {
        const cell = line[col];
        ... // body identical to the old loop: grapheme lookup / fromCodePoint / ' '
      }
```

Keep the existing `lastNonEmpty` trailing-space trimming exactly as is (it operates on `lineText`, which is now logical-ordered — correct).

(b) `getWordAtCell` (line ~909): convert the incoming visual col to logical, scan logically, return the visual span:

```ts
    if (!line) return null;

    const map = this.bidiMapper.getMap(line);
    const lcol = map.isIdentity || col >= map.visualToLogical.length
      ? col
      : map.visualToLogical[col]!;

    // Word characters: Unicode letters/digits plus common path/URL chars.
    // \p{L}\p{N} (not \w) so RTL scripts are word chars too.
    const isWordChar = (cell: GhosttyCell) => {
      if (!cell || cell.codepoint === 0) return false;
      const char = String.fromCodePoint(cell.codepoint);
      return /[\p{L}\p{N}_\-./~@+]/u.test(char);
    };

    if (!isWordChar(line[lcol])) return null;

    let startCol = lcol;
    while (startCol > 0 && isWordChar(line[startCol - 1])) startCol--;
    let endCol = lcol;
    while (endCol < line.length - 1 && isWordChar(line[endCol + 1])) endCol++;

    if (map.isIdentity) return { startCol, endCol };
    // A word is a uniform-direction run, so its visual image is contiguous;
    // min/max over the logical range is exact, and the anchors are visual.
    let vMin = Number.MAX_SAFE_INTEGER;
    let vMax = -1;
    for (let c = startCol; c <= endCol; c++) {
      const v = map.logicalToVisual[c]!;
      if (v < vMin) vMin = v;
      if (v > vMax) vMax = v;
    }
    return { startCol: vMin, endCol: vMax };
```

(c) The dblclick handler (line ~597) and triple-click line selection need **no code change**: dblclick already feeds `pixelToCell` (visual) into `getWordAtCell` and stores the returned span as anchors — both sides are now consistently visual. Triple-click selects logical prefix `0..endCol`; with LTR base direction everything after the last non-space stays in place, so the permutation maps `{0..endCol}` onto itself and the visual anchors coincide. Verify both by reading the code; the tests in Step 1 cover the underlying conversions.

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test lib/selection-manager.test.ts && bun test`
Expected: PASS, suite green.

- [ ] **Step 5: Commit**

```bash
git add lib/selection-manager.ts lib/selection-manager.test.ts
git commit -m "feat(bidi): visual selection copies logical-order text; word select handles RTL"
```

---

### Task 10: Mouse reporting — logical columns to the application

**Files:**
- Modify: `lib/input-handler.ts:163-172` (`MouseTrackingConfig`), `:726-746` (`pixelToCell`)
- Modify: `lib/terminal.ts` (~line 493, the `mouseConfig` literal)
- Modify: `lib/input-handler.test.ts`

**Interfaces:**
- Consumes: `Terminal.bidiMapper` + `wasmTerm.getLine` (wired in terminal.ts).
- Produces: `MouseTrackingConfig.visualToLogicalCol?: (col: number, row: number) => number` — 0-based visual col + 0-based viewport row in, 0-based logical col out.

- [ ] **Step 1: Write failing test** (append to `lib/input-handler.test.ts`)

```ts
describe('Mouse reporting BiDi conversion', () => {
  test('pixelToCell reports the logical column through visualToLogicalCol', () => {
    const handler = new InputHandler(
      ghostty,
      container as any,
      (data) => dataReceived.push(data),
      () => {}
    );
    // Row 0 is `aשלוb` → visual col 3 holds logical col 1.
    (handler as any).mouseConfig = {
      hasMouseTracking: () => true,
      hasSgrMouseMode: () => true,
      getCellDimensions: () => ({ width: 10, height: 20 }),
      getCanvasOffset: () => ({ left: 0, top: 0 }),
      visualToLogicalCol: (col: number, _row: number) => [0, 3, 2, 1, 4][col] ?? col,
    };
    const cell = (handler as any).pixelToCell(
      new MouseEvent('mousedown', { clientX: 35, clientY: 5 }) // visual col 3, row 0
    );
    expect(cell).toEqual({ col: 2, row: 1 }); // logical col 1 → 1-based 2
    handler.dispose();
  });

  test('pixelToCell is unchanged without the callback', () => {
    const handler = new InputHandler(
      ghostty,
      container as any,
      (data) => dataReceived.push(data),
      () => {}
    );
    (handler as any).mouseConfig = {
      hasMouseTracking: () => true,
      hasSgrMouseMode: () => true,
      getCellDimensions: () => ({ width: 10, height: 20 }),
      getCanvasOffset: () => ({ left: 0, top: 0 }),
    };
    const cell = (handler as any).pixelToCell(
      new MouseEvent('mousedown', { clientX: 35, clientY: 5 })
    );
    expect(cell).toEqual({ col: 4, row: 1 });
    handler.dispose();
  });
});
```

- [ ] **Step 2: Run tests to verify the first fails**

Run: `bun test lib/input-handler.test.ts`
Expected: first test FAILS with `col: 4` (raw visual), second passes.

- [ ] **Step 3: Implement**

(a) `MouseTrackingConfig` (line ~163) gains:

```ts
  /**
   * Map a visual (screen) column to the logical column on BiDi-reordered
   * rows. Both 0-based. Identity when absent. Mouse reports must carry the
   * LOGICAL column — the app knows nothing about visual reordering, and a
   * raw visual column makes clicks land on the wrong widget with nothing
   * looking wrong on screen.
   */
  visualToLogicalCol?: (col: number, row: number) => number;
```

(b) `pixelToCell` (line ~726):

```ts
    const x = event.clientX - offset.left;
    const y = event.clientY - offset.top;

    let col = Math.floor(x / dims.width);
    const row = Math.floor(y / dims.height);
    if (this.mouseConfig.visualToLogicalCol && col >= 0 && row >= 0) {
      col = this.mouseConfig.visualToLogicalCol(col, row);
    }

    // Convert to 1-based cell coordinates (terminal uses 1-based)
    return {
      col: Math.max(1, col + 1),
      row: Math.max(1, row + 1),
    };
```

(c) Terminal's `mouseConfig` literal (line ~493) gains:

```ts
        visualToLogicalCol: (col: number, row: number) => {
          if (!this.wasmTerm) return col;
          const dims = this.wasmTerm.getDimensions();
          if (row >= dims.rows || col >= dims.cols) return col;
          const line = this.wasmTerm.getLine(row);
          if (!line) return col;
          const m = this.bidiMapper.getMap(line);
          if (m.isIdentity || col >= m.visualToLogical.length) return col;
          return m.visualToLogical[col]!;
        },
```

(Mouse-tracking apps run on the alt screen with `viewportY === 0`, so the screen line at `row` is the visible line — same assumption the existing raw-coordinate path already makes.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test lib/input-handler.test.ts && bun run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/input-handler.ts lib/input-handler.test.ts lib/terminal.ts
git commit -m "feat(bidi): mouse reports carry logical columns on reordered rows"
```

---

### Task 11: Full verification — suite, lint, build, manual harness

**Files:**
- No new code expected; fix anything the gates surface.

- [ ] **Step 1: Full automated gates**

Run: `bun test && bun run typecheck && bun run lint && bun run fmt`
Expected: all green. Fix formatting with `bun run fmt:fix` / `bun run lint:fix` if needed (commit fixes with the relevant task's scope, e.g. `style(bidi): ...`).

- [ ] **Step 2: Full build**

Run: `nix develop --command bun run build`
Expected: clean build including WASM. (Homebrew zig / ziglang.org tarball do NOT work for this project.)

- [ ] **Step 3: Manual harness verification (canvas2d AND WebGPU)**

From the booba repo (`NimbleMarkets/go-booba` @ `rtl-text`): `go run ./tests/rtl-text --listen :8099`, open it against this build. The HUD bottom-right names the active backend; `renderer-factory.ts` picks it.

Checklist (from the upstream brief):
- Rows 5 and 10: the **red** word renders to the **right** of the blue word. Red-on-left = failure.
- Ground truth: render the same strings in two `<div>`s over `http://` — one plain (correct UBA), one `unicode-bidi: bidi-override; direction: ltr` (the old defect) — and compare the canvas against both. Do NOT compare against native Ghostty (it has no BiDi; both would agree and both would be wrong).
- Inspect the canvas by CSS-upscaling **every** canvas layer (there are two — text and overlay):
  ```js
  document.querySelectorAll('canvas').forEach(c => {
    c.style.transformOrigin = '0 0';
    c.style.transform = 'scale(6) translate(-186px, -102px)';
    c.style.imageRendering = 'pixelated';
  });
  ```
- Row 11 (`عربي`): letters correctly ORDERED but still DISCONNECTED — expected; shaping is out of scope. Note it, don't chase it.
- Punctuation row: brackets/parens inside RTL runs render mirrored.
- Select mixed-text spans with the mouse; paste elsewhere; confirm logical order. Click around a mouse-aware TUI over RTL rows and confirm the right widgets react.

- [ ] **Step 4: Commit any fixes and stop**

Do NOT merge to `nm-webgpu` in this plan — that is a separate review/merge step (see spec §7). Use the superpowers:finishing-a-development-branch skill.

---

## Self-review (done at plan-writing time)

- **Spec coverage:** §1→Tasks 1–4; §2→Tasks 6–7; §3→Tasks 9–10; §4→Tasks 6(e), 7(c), 8; §5 edge cases→Tasks 2 (placeholder/empty/short rows, factory-throw degrade), 3 (defensive orphan-spacer), 4 (collision verify); §6 tests→Tasks 1–10 + manual in 11; §7 rollout→commit series above.
- **Type consistency:** `RowBidiMap`/`RowBidiMapper` names and shapes are identical across Tasks 2–10; `visualCursorX` defined in Task 8 before use in the same task; `hebrewRow`/`makeStubBuffer` reuse is called out where hoisting is needed.
- **Known deviation from spec:** `RowBidiMap.mirror` replaces the spec's `levels` field (noted in Global Constraints).
