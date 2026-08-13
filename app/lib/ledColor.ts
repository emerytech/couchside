/**
 * Pure colour helpers shared by the LED editors (RgbLedCard, OpenRgbCard).
 *
 * Colour and brightness are INDEPENDENT on the box (the multi_intensity hue vs
 * the master brightness on a kernel LED; per-LED colour vs the effect brightness
 * on OpenRGB), so the picker always yields a FULL-value hue and the brightness
 * slider dims it separately.
 */
import type { Rgb } from './api';

export const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

export const cssRgb = (c: Rgb) => `rgb(${c.r}, ${c.g}, ${c.b})`;

export const hexRgb = (c: Rgb) =>
  '#' + [c.r, c.g, c.b].map((v) => clamp(Math.round(v), 0, 255).toString(16).padStart(2, '0'))
    .join('').toUpperCase();

/** hue 0–360 (full saturation + value) → {r,g,b} 0–255. */
export function hueToRgb(h: number): Rgb {
  const c = 1, x = 1 - Math.abs(((h / 60) % 2) - 1);
  let r = 0, g = 0, b = 0;
  if (h < 60) [r, g, b] = [c, x, 0];
  else if (h < 120) [r, g, b] = [x, c, 0];
  else if (h < 180) [r, g, b] = [0, c, x];
  else if (h < 240) [r, g, b] = [0, x, c];
  else if (h < 300) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  return { r: Math.round(r * 255), g: Math.round(g * 255), b: Math.round(b * 255) };
}

/** {r,g,b} → hue 0–360 (drops saturation/value; the picker is hue-only). */
export function rgbToHue(c: Rgb): number {
  const r = c.r / 255, g = c.g / 255, b = c.b / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  if (d === 0) return 0;
  let h = 0;
  if (max === r) h = ((g - b) / d) % 6;
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  h *= 60;
  return h < 0 ? h + 360 : h;
}

/** 18 fixed hue swatches for painting a rainbow track behind a hue slider
 *  (there is no LinearGradient dep in this app). */
export const HUE_STOPS = Array.from({ length: 18 }, (_, i) => cssRgb(hueToRgb((i / 18) * 360)));
