/**
 * Compact-Console RGB summary — lib/rgbConsole.ts.
 *
 * Run: from app/, `node --experimental-strip-types --test lib/__tests__/*.test.ts`
 *
 * The summary is pure (two poll payloads in, one compact summary or null out),
 * so it is checked against hand-built LedsState / OpenRgbState fixtures. The
 * load-bearing property is PRESENCE PARITY: `rgbSummary` must return non-null in
 * exactly the cases where at least one of StripLightCard / RgbLedCard /
 * OpenRgbCard would render, and null otherwise (probe-and-appear). We also check
 * the primary-surface priority and that the preview reflects the live state.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { rgbSummary, effectLabel, scaleRgb } from '../rgbConsole.ts';
import type { LedsState, OpenRgbState, LedInfo, Rgb } from '../api.ts';

/** A single notable/writable LED. */
function led(over: Partial<LedInfo> & { name: string }): LedInfo {
  return {
    name: over.name,
    desc: over.desc ?? over.name,
    rgb: over.rgb ?? false,
    notable: over.notable ?? true,
    writable: over.writable ?? true,
    max_brightness: over.max_brightness ?? 255,
    brightness: over.brightness ?? 255,
    brightness_pct: over.brightness_pct ?? 100,
    color: over.color ?? null,
  };
}

/** N addressable strip nodes named `<prefix>[i]`, all RGB. */
function stripNodes(prefix: string, n: number, color: Rgb | null, pct = 100): LedInfo[] {
  return Array.from({ length: n }, (_, i) =>
    led({ name: `${prefix}[${i}]`, rgb: true, color, brightness_pct: pct }));
}

function ledsState(over: Partial<LedsState>): LedsState {
  return { available: true, leds: [], ...over };
}

function orgbState(over: Partial<OpenRgbState>): OpenRgbState {
  return { available: true, server: '127.0.0.1:6742', controllers: [], ...over };
}

test('null when nothing controllable (both polls empty)', () => {
  assert.equal(rgbSummary(null, null), null);
  assert.equal(rgbSummary(ledsState({ available: false }), orgbState({ available: false })), null);
  // available but zero notable/writable LEDs and no controllers.
  assert.equal(rgbSummary(ledsState({ leds: [] }), orgbState({ controllers: [] })), null);
});

test('a mono status LED alone appears (single surface)', () => {
  const s = rgbSummary(ledsState({ leds: [led({ name: 'status', rgb: false, brightness_pct: 70 })] }), null);
  assert.ok(s, 'expected a summary');
  assert.equal(s!.source, 'single');
  assert.equal(s!.surfaces, 1);
  assert.equal(s!.brightness, 70);
  assert.equal(s!.swatches.length, 1);
});

test('an addressable strip takes priority over a single and reports its colours', () => {
  const red: Rgb = { r: 255, g: 0, b: 0 };
  const s = rgbSummary(
    ledsState({
      leds: [led({ name: 'status', rgb: true, color: { r: 0, g: 255, b: 0 } }), ...stripNodes('valve-leds', 5, red, 50)],
      strips: [{ prefix: 'valve-leds', count: 5, rgb: true, hw_effects: [] }],
      active: { 'strip:valve-leds': { effect: 'solid', color: red, speed: 55, brightness: 50 } },
    }),
    null,
  );
  assert.ok(s);
  assert.equal(s!.source, 'strip');
  assert.equal(s!.device, 'Steam Machine strip');
  assert.equal(s!.effectLabel, 'Solid');
  assert.equal(s!.brightness, 50);
  // 5 nodes, each red at 50% -> {128,0,0}.
  assert.equal(s!.swatches.length, 5);
  assert.deepEqual(s!.swatches[0], { r: 128, g: 0, b: 0 });
});

test('swatches are capped at maxSwatches', () => {
  const s = rgbSummary(
    ledsState({
      leds: stripNodes('rgb', 20, { r: 10, g: 20, b: 30 }),
      strips: [{ prefix: 'rgb', count: 20, rgb: true, hw_effects: [] }],
    }),
    null,
    6,
  );
  assert.ok(s);
  assert.equal(s!.swatches.length, 6);
});

test('a mono-only single next to a strip is suppressed as its own surface (matches RgbLedCard)', () => {
  // Strip present + the only single is mono => RgbLedCard hides, so `surfaces`
  // counts the strip only (single suppressed).
  const s = rgbSummary(
    ledsState({
      leds: [led({ name: 'status', rgb: false }), ...stripNodes('valve-leds', 4, { r: 1, g: 2, b: 3 })],
      strips: [{ prefix: 'valve-leds', count: 4, rgb: true, hw_effects: [] }],
    }),
    null,
  );
  assert.ok(s);
  assert.equal(s!.source, 'strip');
  assert.equal(s!.surfaces, 1);
});

test('an RGB single alongside a strip counts as two surfaces', () => {
  const s = rgbSummary(
    ledsState({
      leds: [led({ name: 'bar', rgb: true, color: { r: 9, g: 9, b: 9 } }), ...stripNodes('valve-leds', 4, { r: 1, g: 2, b: 3 })],
      strips: [{ prefix: 'valve-leds', count: 4, rgb: true, hw_effects: [] }],
    }),
    null,
  );
  assert.ok(s);
  assert.equal(s!.source, 'strip');
  assert.equal(s!.surfaces, 2);
});

test('OpenRGB alone appears and shows its active effect', () => {
  const s = rgbSummary(
    null,
    orgbState({
      controllers: [{ index: 0, name: 'ASUS Aura Motherboard', led_count: 12, zones: [] }],
      active: { '0': { effect: 'rainbow', color: null, speed: 55, brightness: 80 } },
    }),
  );
  assert.ok(s);
  assert.equal(s!.source, 'openrgb');
  assert.equal(s!.device, 'ASUS Aura Motherboard');
  assert.equal(s!.effectLabel, 'Rainbow');
  assert.equal(s!.brightness, 80);
});

test('OpenRGB counts as an extra surface alongside LEDs', () => {
  const s = rgbSummary(
    ledsState({
      leds: stripNodes('valve-leds', 4, { r: 1, g: 2, b: 3 }),
      strips: [{ prefix: 'valve-leds', count: 4, rgb: true, hw_effects: [] }],
    }),
    orgbState({ controllers: [{ index: 0, name: 'RAM', led_count: 8, zones: [] }] }),
  );
  assert.ok(s);
  assert.equal(s!.source, 'strip');
  assert.equal(s!.surfaces, 2);
});

test('Game Aura uses the painted palette for the preview', () => {
  const palette: Rgb[] = [
    { r: 200, g: 0, b: 0 },
    { r: 0, g: 200, b: 0 },
    { r: 0, g: 0, b: 200 },
  ];
  const s = rgbSummary(
    ledsState({
      leds: stripNodes('valve-leds', 3, { r: 5, g: 5, b: 5 }),
      strips: [{ prefix: 'valve-leds', count: 3, rgb: true, hw_effects: [] }],
      aura: true,
      active: { 'strip:valve-leds': { effect: 'aura', color: null, speed: 0, brightness: 100, colors: palette } },
    }),
    null,
  );
  assert.ok(s);
  assert.equal(s!.effectLabel, 'Game Aura');
  assert.deepEqual(s!.swatches, palette);
});

test('effectLabel maps known ids and Title-cases an unmapped id', () => {
  assert.equal(effectLabel('meter_cpu'), 'CPU meter');
  assert.equal(effectLabel('manual'), 'Custom');
  assert.equal(effectLabel('sequence'), 'Sequence');
  assert.equal(effectLabel('aura'), 'Game Aura');
  assert.equal(effectLabel(undefined), 'Solid');
  // an unmapped id (a newer agent's effect) reads as a proper noun, not raw lowercase
  assert.equal(effectLabel('mystery'), 'Mystery');
  assert.equal(effectLabel('my_new_fx'), 'My new fx');
});

test('scaleRgb dims and clamps', () => {
  assert.deepEqual(scaleRgb({ r: 255, g: 100, b: 0 }, 50), { r: 128, g: 50, b: 0 });
  assert.deepEqual(scaleRgb({ r: 255, g: 255, b: 255 }, 0), { r: 0, g: 0, b: 0 });
  assert.deepEqual(scaleRgb({ r: 255, g: 255, b: 255 }, 100), { r: 255, g: 255, b: 255 });
});
