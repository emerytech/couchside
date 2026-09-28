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

import {
  AURAS, AURA_VIVIDNESS, auraToFrame, isAuraVividness, vivify,
  type AuraVividness, type RGB, type Rgb,
} from '../auraLibrary.ts';

const eq = (c: Rgb, r: number, g: number, b: number) => c.r === r && c.g === g && c.b === b;

/** Hue (0..360) of a colour, for the hue-preservation checks. Undefined for
 *  greys (delta 0); those tests use chromatic stops only. */
const hueOf = (c: Rgb): number => {
  const r = c.r / 255, g = c.g / 255, b = c.b / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  if (d === 0) return NaN;
  let h: number;
  if (max === r) h = ((g - b) / d) % 6;
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  h *= 60;
  return h < 0 ? h + 360 : h;
};
const maxCh = (c: Rgb) => Math.max(c.r, c.g, c.b);
/** Smallest signed angular gap between two hues, in degrees (0..180). */
const hueGap = (a: number, b: number) => {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
};

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

// ---- Vividness: vivify() ----
// The lift is a per-viewer DISPLAY choice for the aura library. Faithful must be
// a pure no-op; the lifts raise the HSV value to a floor and nudge saturation
// while preserving HUE, so a dark stop reads without going a different colour.

test('AURA_VIVIDNESS is the three known levels and the guard accepts only them', () => {
  assert.deepEqual([...AURA_VIVIDNESS], ['faithful', 'subtle', 'punchy']);
  for (const lv of AURA_VIVIDNESS) assert.ok(isAuraVividness(lv), `${lv} is valid`);
  for (const bad of ['bright', '', 'FAITHFUL', 0, null, undefined, {}]) {
    assert.ok(!isAuraVividness(bad), `${JSON.stringify(bad)} rejected`);
  }
});

test("vivify 'faithful' returns the input rounded+clamped, unchanged in range", () => {
  // In-range ints pass straight through (byte-identical to the old spreader).
  assert.deepEqual(vivify({ r: 20, g: 30, b: 70 }, 'faithful'), { r: 20, g: 30, b: 70 });
  // The default level is 'faithful'.
  assert.deepEqual(vivify({ r: 200, g: 25, b: 35 }), { r: 200, g: 25, b: 35 });
  // Floats round; out-of-range clamps — but no hue/level lift is applied.
  assert.deepEqual(vivify({ r: -5, g: 300, b: 128.6 }, 'faithful'), { r: 0, g: 255, b: 129 });
});

test("vivify 'punchy' lifts a dark stop's max channel above the floor and keeps its hue", () => {
  const dark: Rgb = { r: 20, g: 30, b: 70 }; // a dark blue brand-accent stop
  const before = maxCh(dark);
  const out = vivify(dark, 'punchy');
  const floorCh = Math.floor(0.62 * 255); // 158 — the punchy value floor in channels
  assert.ok(maxCh(out) > before, `max channel lifted: ${before} -> ${maxCh(out)}`);
  assert.ok(maxCh(out) >= floorCh, `max channel clears the floor: ${maxCh(out)} >= ${floorCh}`);
  // Hue is preserved — a dark blue becomes a bright blue, not a bright anything-else.
  assert.ok(hueGap(hueOf(dark), hueOf(out)) <= 6,
    `hue preserved: ${hueOf(dark).toFixed(1)} vs ${hueOf(out).toFixed(1)}`);
});

test('vivify barely changes an already-bright stop (its value is not lifted)', () => {
  const bright: Rgb = { r: 102, g: 192, b: 244 }; // value already well above the floor
  for (const lv of ['subtle', 'punchy'] as AuraVividness[]) {
    const out = vivify(bright, lv);
    // Value = the max channel; since it already clears the floor it is untouched.
    assert.equal(maxCh(out), 244, `${lv}: max channel unchanged`);
    // Overall it stays close to the original (saturation only nudges the low channel).
    for (const k of ['r', 'g', 'b'] as const) {
      assert.ok(Math.abs(out[k] - bright[k]) <= 40, `${lv}: ${k} barely moved (${bright[k]} -> ${out[k]})`);
    }
    // And hue is preserved.
    assert.ok(hueGap(hueOf(bright), hueOf(out)) <= 6, `${lv}: hue preserved`);
  }
});

test('vivify keeps a grey stop grey (saturation 0 stays 0) while it may brighten', () => {
  for (const lv of ['subtle', 'punchy'] as AuraVividness[]) {
    const mid = vivify({ r: 120, g: 120, b: 120 }, lv);
    assert.ok(mid.r === mid.g && mid.g === mid.b, `${lv}: mid grey stays grey -> ${JSON.stringify(mid)}`);
    const dark = vivify({ r: 30, g: 30, b: 30 }, lv);
    assert.ok(dark.r === dark.g && dark.g === dark.b, `${lv}: dark grey stays grey -> ${JSON.stringify(dark)}`);
    assert.ok(dark.r > 30, `${lv}: dark grey is lifted (${dark.r} > 30)`);
  }
});

test('vivify preserves hue across chromatic stops and both lift levels', () => {
  const stops: Rgb[] = [
    { r: 20, g: 30, b: 70 },   // dark blue
    { r: 110, g: 40, b: 20 },  // dark brown/orange
    { r: 40, g: 90, b: 30 },   // dark green
    { r: 90, g: 20, b: 90 },   // dark magenta
  ];
  for (const s of stops) {
    for (const lv of ['subtle', 'punchy'] as AuraVividness[]) {
      const out = vivify(s, lv);
      assert.ok(hueGap(hueOf(s), hueOf(out)) <= 6,
        `${lv}: hue of ${JSON.stringify(s)} preserved (${hueOf(s).toFixed(1)} vs ${hueOf(out).toFixed(1)})`);
    }
  }
});

// ---- Vividness: auraToFrame(palette, n, level) ----

test("auraToFrame default level is 'faithful' — byte-identical to the 2-arg call", () => {
  const pal: RGB[] = [[200, 230, 240], [20, 30, 70], [60, 150, 160]];
  for (const n of [1, 3, 8, 17]) {
    assert.deepEqual(auraToFrame(pal, n), auraToFrame(pal, n, 'faithful'),
      `n=${n}: omitting the level equals passing 'faithful'`);
  }
  // And still the exact known interpolation (guards against a regression in the
  // faithful path even though vivify now sits in the loop).
  assert.deepEqual(auraToFrame([[0, 0, 0], [100, 100, 100], [200, 200, 200]], 5, 'faithful'), [
    { r: 0, g: 0, b: 0 },
    { r: 50, g: 50, b: 50 },
    { r: 100, g: 100, b: 100 },
    { r: 150, g: 150, b: 150 },
    { r: 200, g: 200, b: 200 },
  ]);
});

test("auraToFrame 'punchy' leaves NO muddy cell — every LED clears the value floor", () => {
  // Hollow Knight's palette carries a near-black {20,30,70} stop, so the raw
  // (faithful) spread has dim cells; punchy must lift every cell above the floor.
  const pal: RGB[] = [[200, 230, 240], [20, 30, 70], [60, 150, 160]];
  const faithful = auraToFrame(pal, 17, 'faithful');
  const punchy = auraToFrame(pal, 17, 'punchy');
  assert.equal(punchy.length, 17);
  // The test is only meaningful if faithful actually HAS a muddy region.
  assert.ok(faithful.some((c) => maxCh(c) < 120), 'faithful spread has a dim cell (control)');
  // Punchy: no cell below the ~0.62 value floor (158 in channel terms, allow -1 for rounding).
  for (const c of punchy) {
    assert.ok(maxCh(c) >= 157, `punchy cell not muddy: ${JSON.stringify(c)} maxCh=${maxCh(c)}`);
  }
  // The two levels genuinely differ (fails if auraToFrame ignored the level).
  assert.notDeepEqual(punchy, faithful, 'punchy differs from faithful');
});

test("auraToFrame 'subtle' lifts less than 'punchy' but still floors the dim cells", () => {
  const pal: RGB[] = [[200, 230, 240], [20, 30, 70], [60, 150, 160]];
  const subtle = auraToFrame(pal, 17, 'subtle');
  const punchy = auraToFrame(pal, 17, 'punchy');
  // Subtle floor is ~0.45 -> 115 in channels (allow -1 for rounding).
  for (const c of subtle) {
    assert.ok(maxCh(c) >= 114, `subtle cell floored: ${JSON.stringify(c)} maxCh=${maxCh(c)}`);
  }
  // The dimmest cell under subtle is no brighter than the dimmest under punchy.
  const dimSubtle = Math.min(...subtle.map(maxCh));
  const dimPunchy = Math.min(...punchy.map(maxCh));
  assert.ok(dimSubtle <= dimPunchy, `subtle floor (${dimSubtle}) <= punchy floor (${dimPunchy})`);
});
