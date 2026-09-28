/**
 * Game Aura — sample a decoded image into an N-colour strip palette.
 *
 * PURE and platform-free on purpose: it takes already-decoded RGBA pixels (the
 * decode is the platform-specific bit, done by the caller — a <canvas> on web,
 * a native decoder on device) and returns N `{r,g,b}` — one colour per strip
 * LED. Keeping it free of any react-native / expo import is what lets it run in
 * the install-free app test glob (`node --experimental-strip-types --test
 * lib/__tests__/*.test.ts`) with a tiny synthetic image and a known answer.
 *
 * The colours are DATA sent to POST /api/leds/aura; the agent re-validates every
 * channel and writes them to the strip's own members through its fixed-literal
 * writers, so nothing produced here can become anything but colour values on the
 * wire (see the agent's apply_strip_aura + CLAUDE.md §3).
 *
 * Method: take a horizontal BAND across the image (default the centre 60% of
 * height, where a game cover's key art usually is), split its width into N equal
 * cells, and average each cell to one colour — with an optional light saturation
 * lift so a muted cover still reads as colour on the strip. Deterministic: the
 * same pixels always yield the same palette.
 */
import type { Rgb } from './api';

export type { Rgb };

export type SampleOpts = {
  /** Fraction of the image HEIGHT to sample, centred (0..1]. Default 0.6. */
  band?: number;
  /** Saturation lift, 0 = none. Pushes each channel away from its luma by this
   *  factor so a washed-out cover still shows colour. Default 0. */
  satLift?: number;
  /** Weight each pixel by its alpha (so transparent PNG edges don't wash the
   *  average toward black). Default true. Opaque covers are unaffected. */
  alphaWeighted?: boolean;
};

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);
/** Round to an int in 0..255 (what a colour channel must be). */
const chan = (v: number): number => {
  const r = Math.round(v);
  return r < 0 ? 0 : r > 255 ? 255 : r;
};

/** Push (r,g,b) away from their shared luma by `lift` (0 = unchanged). A pure
 *  grey (r==g==b) is left exactly where it is. */
function liftSaturation(r: number, g: number, b: number, lift: number): [number, number, number] {
  if (lift <= 0) return [r, g, b];
  const luma = 0.299 * r + 0.587 * g + 0.114 * b;
  const f = 1 + lift;
  return [luma + (r - luma) * f, luma + (g - luma) * f, luma + (b - luma) * f];
}

/**
 * Sample `rgba` (a flat RGBA pixel array, row-major, length ≥ width*height*4)
 * into exactly `n` colours. Returns [] for a degenerate request (non-positive
 * width/height/n) rather than throwing, so a failed decode degrades to "no
 * palette" at the call site.
 */
export function samplePalette(
  rgba: ArrayLike<number>,
  width: number,
  height: number,
  n: number,
  opts: SampleOpts = {},
): Rgb[] {
  const N = Math.floor(n);
  const W = Math.floor(width);
  const H = Math.floor(height);
  if (!(W > 0) || !(H > 0) || !(N > 0)) return [];

  const band = clamp01(opts.band ?? 0.6) || 1; // 0 -> treat as the whole image
  const satLift = Math.max(0, opts.satLift ?? 0);
  const alphaWeighted = opts.alphaWeighted !== false;

  // Centre band of rows.
  const bandH = Math.max(1, Math.round(H * band));
  const y0 = Math.floor((H - bandH) / 2);
  const y1 = Math.min(H, y0 + bandH);

  const out: Rgb[] = [];
  for (let i = 0; i < N; i++) {
    // Equal-width cell; guarantee at least one column even when W < N.
    let x0 = Math.floor((i * W) / N);
    let x1 = Math.floor(((i + 1) * W) / N);
    if (x1 <= x0) x1 = Math.min(W, x0 + 1);

    let sr = 0;
    let sg = 0;
    let sb = 0;
    let sw = 0;
    for (let y = y0; y < y1; y++) {
      const row = y * W * 4;
      for (let x = x0; x < x1; x++) {
        const p = row + x * 4;
        const a = alphaWeighted ? rgba[p + 3] ?? 255 : 255;
        if (a <= 0) continue;
        sr += (rgba[p] ?? 0) * a;
        sg += (rgba[p + 1] ?? 0) * a;
        sb += (rgba[p + 2] ?? 0) * a;
        sw += a;
      }
    }
    if (sw <= 0) {
      out.push({ r: 0, g: 0, b: 0 });
      continue;
    }
    let r = sr / sw;
    let g = sg / sw;
    let b = sb / sw;
    if (satLift > 0) [r, g, b] = liftSaturation(r, g, b, satLift);
    out.push({ r: chan(r), g: chan(g), b: chan(b) });
  }
  return out;
}
