/**
 * Game Aura palette sampler — lib/auraPalette.ts.
 *
 * Run: from app/, `node --experimental-strip-types --test lib/__tests__/*.test.ts`
 *
 * The sampler is pure (decoded RGBA in, N `{r,g,b}` out), so it is checked
 * against tiny SYNTHETIC images with hand-computed answers: exact averages, the
 * centre-band selection, the saturation lift, and the degenerate/edge cases. A
 * green run here means a real cover will sample deterministically; the decode
 * step is the caller's platform code and is out of scope for this unit.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { samplePalette, type Rgb } from '../auraPalette.ts';

/** Build a flat RGBA image (row-major, alpha 255) from a per-pixel colour fn. */
function image(w: number, h: number, at: (x: number, y: number) => [number, number, number]): number[] {
  const px: number[] = [];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const [r, g, b] = at(x, y);
      px.push(r, g, b, 255);
    }
  }
  return px;
}

const RED: [number, number, number] = [255, 0, 0];
const GREEN: [number, number, number] = [0, 255, 0];
const BLUE: [number, number, number] = [0, 0, 255];
const eq = (c: Rgb, r: number, g: number, b: number) => c.r === r && c.g === g && c.b === b;

test('splits width into N cells and averages each exactly', () => {
  // 4x2, left half red, right half blue; whole-image band, N=2.
  const img = image(4, 2, (x) => (x < 2 ? RED : BLUE));
  const pal = samplePalette(img, 4, 2, 2, { band: 1 });
  assert.equal(pal.length, 2);
  assert.ok(eq(pal[0], 255, 0, 0), `left cell red, got ${JSON.stringify(pal[0])}`);
  assert.ok(eq(pal[1], 0, 0, 255), `right cell blue, got ${JSON.stringify(pal[1])}`);
});

test('a cell straddling two colours averages them', () => {
  // 2x1: one red pixel + one blue pixel, N=1 -> the mean of the two.
  const img = image(2, 1, (x) => (x === 0 ? RED : BLUE));
  const pal = samplePalette(img, 2, 1, 1, { band: 1 });
  assert.ok(eq(pal[0], 128, 0, 128), `magenta-ish mean, got ${JSON.stringify(pal[0])}`);
});

test('the centre band is what gets sampled, not the whole image', () => {
  // 1x6 stack: rows 0-1 red, rows 2-3 green (centre), rows 4-5 blue.
  const band = image(1, 6, (_x, y) => (y < 2 ? RED : y < 4 ? GREEN : BLUE));
  // band≈0.34 -> 2 rows tall, centred on rows 2-3 -> pure green.
  const centre = samplePalette(band, 1, 6, 1, { band: 0.34 });
  assert.ok(eq(centre[0], 0, 255, 0), `centre band is green, got ${JSON.stringify(centre[0])}`);
  // The WHOLE image is the mean of red+green+blue = (85,85,85).
  const whole = samplePalette(band, 1, 6, 1, { band: 1 });
  assert.ok(eq(whole[0], 85, 85, 85), `whole image is the grey mean, got ${JSON.stringify(whole[0])}`);
});

test('saturation lift pushes a muted colour outward and leaves grey alone', () => {
  const muted = image(1, 1, () => [200, 100, 100]);
  const plain = samplePalette(muted, 1, 1, 1, { band: 1 })[0];
  const lifted = samplePalette(muted, 1, 1, 1, { band: 1, satLift: 0.5 })[0];
  assert.ok(eq(plain, 200, 100, 100), 'no lift -> the raw average');
  assert.ok(lifted.r > plain.r, 'lift raises the dominant channel');
  assert.ok(lifted.g < plain.g && lifted.b < plain.b, 'lift lowers the weaker channels');

  // A pure grey has no dominant channel, so a lift must not tint it.
  const grey = image(1, 1, () => [128, 128, 128]);
  const g = samplePalette(grey, 1, 1, 1, { band: 1, satLift: 0.9 })[0];
  assert.ok(eq(g, 128, 128, 128), `grey stays grey under a lift, got ${JSON.stringify(g)}`);
});

test('always returns exactly N colours, even when width < N', () => {
  // 2 pixels wide but 5 LEDs: every cell still resolves to a real colour.
  const img = image(2, 1, (x) => (x === 0 ? RED : BLUE));
  const pal = samplePalette(img, 2, 1, 5, { band: 1 });
  assert.equal(pal.length, 5);
  for (const c of pal) {
    assert.ok(c.r >= 0 && c.r <= 255 && c.g >= 0 && c.g <= 255 && c.b >= 0 && c.b <= 255,
      `channels in range: ${JSON.stringify(c)}`);
  }
  // First cell maps to column 0 (red), last to column 1 (blue).
  assert.ok(eq(pal[0], 255, 0, 0), 'first LED takes the leftmost column');
  assert.ok(eq(pal[4], 0, 0, 255), 'last LED takes the rightmost column');
});

test('alpha-weighting ignores fully transparent pixels', () => {
  // 2x1: a transparent pixel next to an opaque red one -> pure red, not halved.
  const px = [0, 0, 0, 0, 255, 0, 0, 255];
  const pal = samplePalette(px, 2, 1, 1, { band: 1 });
  assert.ok(eq(pal[0], 255, 0, 0), `transparent pixel dropped, got ${JSON.stringify(pal[0])}`);
  // With alpha-weighting OFF the transparent (black) pixel drags the average down.
  const off = samplePalette(px, 2, 1, 1, { band: 1, alphaWeighted: false });
  assert.ok(eq(off[0], 128, 0, 0), `unweighted halves the red, got ${JSON.stringify(off[0])}`);
});

test('a fully transparent cell degrades to black, not NaN', () => {
  const px = [10, 20, 30, 0]; // one transparent pixel
  const pal = samplePalette(px, 1, 1, 1, { band: 1 });
  assert.ok(eq(pal[0], 0, 0, 0), `all-transparent -> black, got ${JSON.stringify(pal[0])}`);
});

test('degenerate requests return [] instead of throwing', () => {
  assert.deepEqual(samplePalette([], 0, 0, 5), []);
  assert.deepEqual(samplePalette([1, 2, 3, 4], 1, 1, 0), []);
  assert.deepEqual(samplePalette([1, 2, 3, 4], -3, 1, 2), []);
});

test('is deterministic — same pixels, same palette', () => {
  const img = image(17, 9, (x, y) => [(x * 13) % 256, (y * 29) % 256, (x * y) % 256]);
  const a = samplePalette(img, 17, 9, 17, { band: 0.6, satLift: 0.2 });
  const b = samplePalette(img, 17, 9, 17, { band: 0.6, satLift: 0.2 });
  assert.deepEqual(a, b);
  assert.equal(a.length, 17);
});
