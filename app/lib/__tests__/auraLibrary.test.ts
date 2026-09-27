/**
 * Game Aura LIBRARY — lib/auraLibrary.ts.
 *
 * Run: from app/, `node --experimental-strip-types --test lib/__tests__/*.test.ts`
 *
 * Two things are checked here, both pure and platform-free:
 *  1. auraToFrame() — the linear-interpolation spreader. Hand-computed answers so
 *     a broken interpolation (nearest-neighbour, no rounding, wrong length, a
 *     missing clamp) fails a specific case rather than sliding by.
 *  2. The AURAS table itself — exactly 35, order preserved, unique ids, every
 *     channel an int in 0..255. This is the guard against a transcription slip
 *     in the baked literal (the palettes are DATA on the wire).
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { AURAS, auraToFrame, type RGB, type Rgb } from '../auraLibrary.ts';

const eq = (c: Rgb, r: number, g: number, b: number) => c.r === r && c.g === g && c.b === b;

test('a 2-colour palette over 3 cells is [c0, midpoint, c1]', () => {
  const pal: RGB[] = [[0, 0, 0], [20, 40, 60]];
  const f = auraToFrame(pal, 3);
  assert.equal(f.length, 3);
  assert.ok(eq(f[0], 0, 0, 0), `first cell is c0, got ${JSON.stringify(f[0])}`);
  assert.ok(eq(f[1], 10, 20, 30), `middle cell is the interpolated midpoint, got ${JSON.stringify(f[1])}`);
  assert.ok(eq(f[2], 20, 40, 60), `last cell is c1, got ${JSON.stringify(f[2])}`);
});

test('a 3-stop palette over 5 cells hits each stop and interpolates between', () => {
  const pal: RGB[] = [[0, 0, 0], [100, 100, 100], [200, 200, 200]];
  const f = auraToFrame(pal, 5);
  assert.deepEqual(f, [
    { r: 0, g: 0, b: 0 },
    { r: 50, g: 50, b: 50 },
    { r: 100, g: 100, b: 100 },
    { r: 150, g: 150, b: 150 },
    { r: 200, g: 200, b: 200 },
  ]);
});

test('a 1-colour palette paints every cell that colour', () => {
  const f = auraToFrame([[7, 8, 9]], 4);
  assert.equal(f.length, 4);
  for (const c of f) assert.ok(eq(c, 7, 8, 9), `all cells equal the sole stop, got ${JSON.stringify(c)}`);
});

test('n=1 edge: a single cell takes the first stop', () => {
  const f = auraToFrame([[3, 4, 5], [200, 200, 200]], 1);
  assert.equal(f.length, 1);
  assert.ok(eq(f[0], 3, 4, 5), `single cell is the first stop, got ${JSON.stringify(f[0])}`);
});

test('channels are rounded to the nearest integer', () => {
  // t = 0, 1/3, 2/3, 1 over a 0..10 ramp -> 0, 3.33->3, 6.66->7, 10.
  const f = auraToFrame([[0, 0, 0], [10, 10, 10]], 4);
  assert.deepEqual(f.map((c) => c.r), [0, 3, 7, 10]);
});

test('channels are clamped to 0..255 even if a stop is out of range', () => {
  // A defensive check: the spreader must never emit an out-of-range channel.
  const pal: RGB[] = [[-40, 300, 128], [-40, 300, 128]];
  const f = auraToFrame(pal, 2);
  for (const c of f) {
    assert.ok(eq(c, 0, 255, 128), `clamped to range, got ${JSON.stringify(c)}`);
  }
});

test('always returns exactly n cells, all channels in range', () => {
  const pal: RGB[] = [[10, 20, 30], [200, 100, 50], [0, 255, 90]];
  for (const n of [1, 2, 3, 8, 17, 60]) {
    const f = auraToFrame(pal, n);
    assert.equal(f.length, n, `n=${n} -> ${n} cells`);
    for (const c of f) {
      assert.ok(c.r >= 0 && c.r <= 255 && c.g >= 0 && c.g <= 255 && c.b >= 0 && c.b <= 255,
        `channels in range for n=${n}: ${JSON.stringify(c)}`);
      assert.ok(Number.isInteger(c.r) && Number.isInteger(c.g) && Number.isInteger(c.b),
        `channels are ints for n=${n}: ${JSON.stringify(c)}`);
    }
  }
});

test('degenerate requests return [] instead of throwing', () => {
  assert.deepEqual(auraToFrame([[1, 2, 3]], 0), []);
  assert.deepEqual(auraToFrame([[1, 2, 3]], -3), []);
  assert.deepEqual(auraToFrame([], 5), []);
});

test('is deterministic — same palette and n, same frame', () => {
  const pal: RGB[] = [[13, 200, 40], [90, 5, 240], [255, 128, 0]];
  const a = auraToFrame(pal, 17);
  const b = auraToFrame(pal, 17);
  assert.deepEqual(a, b);
  assert.equal(a.length, 17);
});

// ---- The shipped library table ----

test('AURAS is exactly 35 entries, order preserved', () => {
  assert.equal(AURAS.length, 35, 'the curated library is 35 auras');
  assert.equal(AURAS[0].id, 'home', 'first entry preserved');
  assert.equal(AURAS[AURAS.length - 1].id, 'among-us', 'last entry preserved');
});

test('every aura is well-formed: unique id, non-empty palette, int channels 0..255', () => {
  const ids = new Set<string>();
  for (const a of AURAS) {
    assert.ok(a.id && typeof a.id === 'string', `id present: ${JSON.stringify(a)}`);
    assert.ok(!ids.has(a.id), `id unique: ${a.id}`);
    ids.add(a.id);
    assert.ok(a.label && typeof a.label === 'string', `label present: ${a.id}`);
    assert.equal(typeof a.appid, 'string', `appid is a string: ${a.id}`);
    assert.ok(a.effect && typeof a.effect === 'string', `effect present: ${a.id}`);
    assert.ok(a.palette.length >= 1, `palette non-empty: ${a.id}`);
    for (const [r, g, b] of a.palette) {
      for (const v of [r, g, b]) {
        assert.ok(Number.isInteger(v) && v >= 0 && v <= 255,
          `channel int in range for ${a.id}: got ${v}`);
      }
    }
  }
});

test('game auras carry a numeric-looking appid; ambient ones are blank', () => {
  const withApp = AURAS.filter((a) => a.appid !== '');
  const blank = AURAS.filter((a) => a.appid === '');
  assert.ok(withApp.length >= 30, 'most auras map to a game appid');
  assert.ok(blank.length >= 1, 'at least one ambient (no-game) aura exists');
  for (const a of withApp) {
    assert.match(a.appid, /^\d+$/, `game appid is digits: ${a.id} -> ${a.appid}`);
  }
});

test('the table is frozen (cannot be mutated at runtime)', () => {
  assert.ok(Object.isFrozen(AURAS), 'AURAS array frozen');
  assert.ok(Object.isFrozen(AURAS[0]), 'each aura frozen');
  assert.ok(Object.isFrozen(AURAS[0].palette), 'each palette frozen');
});
