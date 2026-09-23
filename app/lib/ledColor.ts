/**
 * Pure colour helpers shared by the LED editors (RgbLedCard, StripLightCard,
 * OpenRgbCard).
 *
 * Colour and brightness are INDEPENDENT on the box (the multi_intensity hue vs
 * the master brightness on a kernel LED; per-LED colour vs the effect brightness
 * on OpenRGB), so the picker yields a FULL-VALUE colour and the brightness slider
 * dims it separately. The picker exposes HUE + SATURATION (value stays 1): hue
 * chooses the tint, saturation pulls it toward white, so pastels and pure white
 * (saturation 0) are reachable — the agent already accepts any {r,g,b} 0-255, the
 * old hue-only picker just never sent them. `hueToRgb`/`rgbToHue` are kept as the
 * full-saturation special case so existing callers are unchanged.
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

/** hue 0–360 + saturation 0–100 → {r,g,b} 0–255 (value fixed at 1; the master
 *  brightness slider dims it). saturation 100 == hueToRgb(h); saturation 0 == white. */
export function hsToRgb(h: number, s: number): Rgb {
  const full = hueToRgb(h);
  const k = clamp(s, 0, 100) / 100;
  // Lerp from white (255,255,255) toward the full-saturation hue.
  return {
    r: Math.round(255 + (full.r - 255) * k),
    g: Math.round(255 + (full.g - 255) * k),
    b: Math.round(255 + (full.b - 255) * k),
  };
}

/** {r,g,b} → hue 0–360 (drops saturation/value). */
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

/** {r,g,b} → {hue 0–360, sat 0–100} for seeding the picker from the box's colour.
 *  Value is ignored (the brightness slider owns dimming); a near-black colour
 *  reads as sat 0 so the picker doesn't jump to a random hue. */
export function rgbToHs(c: Rgb): { h: number; s: number } {
  const max = Math.max(c.r, c.g, c.b), min = Math.min(c.r, c.g, c.b);
  const s = max === 0 ? 0 : Math.round(((max - min) / max) * 100);
  return { h: rgbToHue(c), s };
}

/** 18 fixed hue swatches for painting a rainbow track behind a hue slider
 *  (there is no LinearGradient dep in this app). */
export const HUE_STOPS = Array.from({ length: 18 }, (_, i) => cssRgb(hueToRgb((i / 18) * 360)));

/** Stops for a saturation track: white → the picked hue at full saturation.
 *  Rebuilt as the hue changes so the track always previews the current tint. */
export const satStops = (h: number): string[] =>
  Array.from({ length: 10 }, (_, i) => cssRgb(hsToRgb(h, (i / 9) * 100)));

/** Map a speed 1–100 to a per-frame interval (ms) for the OLD app-side fallback
 *  animation (used only against agents too old to render effects themselves).
 *  Higher speed = shorter interval; monotonic, continuous replacement for the
 *  former 3-step Slow/Med/Fast → 150/90/55 ms lookup. */
export const speedToMs = (pct: number): number =>
  Math.round(170 - (clamp(pct, 1, 100) / 100) * 130);
