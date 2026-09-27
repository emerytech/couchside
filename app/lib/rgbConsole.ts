/**
 * Compact-Console RGB summary — the pure logic behind RgbConsoleCard.
 *
 * The Console tab used to stack THREE full lighting cards (StripLightCard,
 * RgbLedCard, OpenRgbCard), which "took over" the tab (owner, 2026-09-27). Those
 * cards are unchanged; they now live in RgbConfiguratorSheet. This module folds
 * their three `poll.data` gates + a glanceable preview into ONE summary so the
 * compact card can:
 *   - probe-and-appear EXACTLY when at least one of the three cards would (so a
 *     box with no controllable lighting shows nothing, like today), and
 *   - render a small live preview (swatches + current effect + brightness).
 *
 * Pure by design (state in, summary out) so it is unit-tested with no RN/agent:
 * the only runtime import is `detectStrips` (itself pure, type-only imports).
 * The presence rules below are copied from the three cards' null-gates VERBATIM
 * — keep them in lock-step, or the compact card and the sheet disagree about
 * whether a box has lights.
 */
import type { LedsState, OpenRgbState, LedInfo, Rgb } from './api.ts';
import { detectStrips } from './ledStrip.ts';

/** Which control surface the compact preview is showing. */
export type RgbSource = 'strip' | 'single' | 'openrgb';

export type RgbSummary = {
  /** The richest present surface (strip > single > openrgb). */
  source: RgbSource;
  /** Friendly device name for the sub-label, e.g. "Steam Machine strip". */
  device: string;
  /** Human effect label, e.g. "Solid", "Rainbow", "CPU meter". */
  effectLabel: string;
  /** 0–100 brightness, or null when it isn't known/meaningful. */
  brightness: number | null;
  /** Preview swatches, already brightness-scaled; 1..N, never empty. */
  swatches: Rgb[];
  /** How many of the three surfaces exist (for a "+N more" hint). */
  surfaces: number;
};

const OFF: Rgb = { r: 0, g: 0, b: 0 };

const EFFECT_LABELS: Record<string, string> = {
  solid: 'Solid',
  off: 'Off',
  manual: 'Custom',
  breathe: 'Breathe',
  pulse: 'Pulse',
  rainbow: 'Rainbow',
  strobe: 'Strobe',
  scanner: 'Scanner',
  circle: 'Circle',
  comet: 'Comet',
  wipe: 'Wipe',
  twinkle: 'Twinkle',
  meter_cpu: 'CPU meter',
  meter_battery: 'Battery meter',
  playtime: 'Playtime',
  aura: 'Game Aura',
};

/** Effect id → display label; an unknown id falls back to itself (never blank). */
export function effectLabel(effect?: string | null): string {
  if (!effect) return 'Solid';
  return EFFECT_LABELS[effect] ?? effect;
}

const clamp255 = (n: number): number => Math.max(0, Math.min(255, Math.round(n)));

/** A colour dimmed to `pct` (0–100) of its value — the swatch as it actually shows. */
export function scaleRgb(c: Rgb, pct: number): Rgb {
  const f = Math.max(0, Math.min(100, pct)) / 100;
  return { r: clamp255(c.r * f), g: clamp255(c.g * f), b: clamp255(c.b * f) };
}

/** The notable, writable LEDs — the same filter all three cards apply first. */
function notableWritable(leds: LedsState): LedInfo[] {
  return (leds.leds ?? []).filter((l) => l.notable && l.writable);
}

/** "strip:valve-leds" → "valve-leds" (the agent's strip prefix). */
function stripPrefix(key: string): string {
  return key.startsWith('strip:') ? key.slice('strip:'.length) : key;
}

/** Friendly name for a known strip, mirroring StripLightCard.stripDeviceLabel. */
function stripDeviceLabel(prefix: string): string {
  if (prefix.startsWith('valve-leds')) return 'Steam Machine strip';
  return prefix.replace(/[:_-]+$/, '');
}

/**
 * StripLightCard's gate: `!poll.data || strips.length === 0 || !strip`. So a
 * strip is present iff detectStrips finds one among the notable/writable LEDs.
 * (It deliberately does NOT require `available`, so neither do we.)
 */
function stripSummary(leds: LedsState, max: number): RgbSummary | null {
  const { strips } = detectStrips(notableWritable(leds));
  if (strips.length === 0) return null;
  const strip = strips[0];
  const prefix = stripPrefix(strip.key);
  const active = leds.active?.[`strip:${prefix}`];

  let swatches: Rgb[];
  if (active?.effect === 'aura' && active.colors && active.colors.length > 0) {
    // Game Aura carries its palette in `colors`, one per LED.
    swatches = active.colors.slice(0, max).map((c) => c ?? OFF);
  } else {
    // Otherwise the strip's current per-LED colour × brightness IS the preview
    // (an honest snapshot; an animated effect just shows one frame).
    swatches = strip.leds
      .slice(0, max)
      .map((l) => (l.color && l.brightness_pct > 0 ? scaleRgb(l.color, l.brightness_pct) : OFF));
  }
  if (swatches.length === 0) swatches = [OFF];

  const litMax = strip.leds.reduce((m, l) => Math.max(m, l.brightness_pct || 0), 0);
  const brightness = active?.brightness ?? (litMax > 0 ? litMax : null);

  return {
    source: 'strip',
    device: stripDeviceLabel(prefix),
    effectLabel: effectLabel(active?.effect ?? 'solid'),
    brightness,
    swatches,
    surfaces: 0,
  };
}

/**
 * RgbLedCard's gate: `!d || !d.available || !led || leds.length === 0 ||
 * (strips.length > 0 && onlyMonoSingles)`, where `leds` are the single LEDs.
 */
function singleSummary(leds: LedsState, _max: number): RgbSummary | null {
  if (!leds.available) return null;
  const { strips, singles } = detectStrips(notableWritable(leds));
  if (singles.length === 0) return null;
  const onlyMonoSingles = singles.every((l) => !l.rgb);
  if (strips.length > 0 && onlyMonoSingles) return null;

  const led = singles[0];
  const active = leds.active?.[led.name];
  const color = active?.color ?? led.color;
  const brightness = active?.brightness ?? led.brightness_pct ?? null;

  let swatch: Rgb;
  if (active?.effect === 'off') {
    swatch = OFF;
  } else if (color) {
    swatch = scaleRgb(color, brightness ?? 100);
  } else {
    // Mono status LED with no colour reported: show a neutral dot at its level.
    swatch = scaleRgb({ r: 255, g: 255, b: 255 }, brightness ?? 100);
  }

  return {
    source: 'single',
    device: led.desc || led.name,
    effectLabel: effectLabel(active?.effect ?? 'solid'),
    brightness,
    swatches: [swatch],
    surfaces: 0,
  };
}

/** OpenRgbCard's gate: `!d || !d.available || !dev || ctrls.length === 0`. */
function openRgbSummary(orgb: OpenRgbState, _max: number): RgbSummary | null {
  if (!orgb.available) return null;
  const ctrls = orgb.controllers ?? [];
  if (ctrls.length === 0) return null;

  const dev = ctrls[0];
  const active = orgb.active?.[String(dev.index)];
  const brightness = active?.brightness ?? 100;
  const swatch =
    active?.effect === 'off' ? OFF : scaleRgb(active?.color ?? { r: 255, g: 0, b: 0 }, brightness);

  return {
    source: 'openrgb',
    device: dev.name,
    effectLabel: effectLabel(active?.effect ?? 'solid'),
    brightness,
    swatches: [swatch],
    surfaces: 0,
  };
}

/**
 * Fold the two polls (GET /api/leds, GET /api/openrgb) into ONE compact summary,
 * or null when the box has no controllable lighting at all — the compact card
 * then renders nothing, exactly like the three cards do today. The primary
 * surface is the richest one present (strip → single → openrgb); `surfaces`
 * counts how many exist so the card can say "+N more" and the sheet still shows
 * every one.
 */
export function rgbSummary(
  leds: LedsState | null,
  orgb: OpenRgbState | null,
  maxSwatches = 10,
): RgbSummary | null {
  const strip = leds ? stripSummary(leds, maxSwatches) : null;
  const single = leds ? singleSummary(leds, maxSwatches) : null;
  const open = orgb ? openRgbSummary(orgb, maxSwatches) : null;
  const surfaces = [strip, single, open].filter((s) => s !== null).length;
  const primary = strip ?? single ?? open;
  if (!primary) return null;
  return { ...primary, surfaces };
}
