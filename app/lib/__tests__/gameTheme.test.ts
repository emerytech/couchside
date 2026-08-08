/**
 * Per-game themes — lib/gameTheme.ts.
 *
 * Run: from app/, `node --experimental-strip-types --test lib/__tests__/*.test.ts`
 *
 * A game theme dresses the controller for whatever is running. The whole point
 * of restricting it to the accent family (see the module header) is that every
 * game palette stays contrast-safe BY CONSTRUCTION. This proves it: every
 * accent and every face tint clears AA large-text (3:1) on the surfaces it is
 * actually drawn on, in BOTH schemes — and proves the restriction itself, so a
 * future entry cannot quietly reach a text or card token.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  THEMES,
  THEME_PICKER,
  applyGameTheme,
  isControllerThemePref,
  resolveTheme,
  themeForAppid,
  type GameTheme,
} from '../gameTheme.ts';

// ---------- WCAG, same math as themeContrast.test.ts ----------

function luminance(hex: string): number {
  const n = parseInt(hex.slice(1), 16);
  const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
}
function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

// The controller draws its accent/tints as ~4-5U glyphs and rings on the card
// surface. That is large text; AA's floor is 3:1. Pull the real card colours
// out of theme.ts so a palette edit cannot silently drop a game theme below
// the line.
const THEME = join(dirname(fileURLToPath(import.meta.url)), '..', 'theme.ts');
function cardOf(scheme: 'dark' | 'light'): string {
  const src = readFileSync(THEME, 'utf8');
  const start = src.indexOf(`const ${scheme}: Palette = {`);
  assert.notEqual(start, -1, `no ${scheme} palette in theme.ts`);
  const body = src.slice(start, src.indexOf('\n};', start));
  const m = body.match(/^\s*card:\s*'(#[0-9a-fA-F]{6})'/m);
  assert.ok(m, `no card colour in ${scheme} palette`);
  return m![1].toLowerCase();
}
const CARD = { dark: cardOf('dark'), light: cardOf('light') };
const MIN = 3.0; // AA large text

// ---------- Palette hygiene ----------

const HEX = /^#[0-9a-fA-F]{6}$/;

test('every game theme has valid hex in both schemes', () => {
  for (const [appid, th] of Object.entries(THEMES)) {
    assert.match(th.accent.dark, HEX, `${appid} accent.dark`);
    assert.match(th.accent.light, HEX, `${appid} accent.light`);
    for (const k of ['a', 'b', 'x', 'y'] as const) {
      const v = th.face?.[k];
      if (v) {
        assert.match(v.dark, HEX, `${appid} face.${k}.dark`);
        assert.match(v.light, HEX, `${appid} face.${k}.light`);
      }
    }
  }
});

test('every accent and face tint clears 3:1 on card, both schemes', () => {
  for (const [appid, th] of Object.entries(THEMES)) {
    for (const scheme of ['dark', 'light'] as const) {
      const acc = contrast(th.accent[scheme], CARD[scheme]);
      assert.ok(acc >= MIN, `${appid} accent ${scheme}: ${acc.toFixed(2)}:1 on card`);
      for (const k of ['a', 'b', 'x', 'y'] as const) {
        const v = th.face?.[k];
        if (v) {
          const r = contrast(v[scheme], CARD[scheme]);
          assert.ok(r >= MIN, `${appid} face.${k} ${scheme}: ${r.toFixed(2)}:1 on card`);
        }
      }
    }
  }
});

test('the contrast test is not vacuous — the registry is non-empty', () => {
  assert.ok(Object.keys(THEMES).length >= 1, 'no game themes to test');
});

// ---------- Lookup ----------

test('a known appid resolves, an unknown one is null', () => {
  assert.equal(themeForAppid(1794680)?.label, 'Dark Gothic');
  assert.equal(themeForAppid(999999999), null);
  assert.equal(themeForAppid(null), null);
  assert.equal(themeForAppid(undefined), null);
});

// ---------- Composition: accent moves, protected tokens do NOT ----------

const BASE = {
  bg: '#0b1220', card: '#141c2e', cardBorder: '#1e2942', text: '#e5ecf8',
  textDim: '#9ca6b9', textFaint: '#7a8298', green: '#34d399', amber: '#f0c25a',
  red: '#f07a6a', accent: '#60a5fa', blue: '#60a5fa',
} as unknown as Parameters<typeof applyGameTheme>[0];

test('applying a theme moves accent + blue and nothing else in the base', () => {
  const th = themeForAppid(1794680)!;
  const out = applyGameTheme(BASE, th, 'dark');
  assert.equal(out.accent, th.accent.dark);
  assert.equal(out.blue, th.accent.dark);
  // Protected tokens are untouched — a game cannot restyle text/card/status.
  for (const k of ['bg', 'card', 'cardBorder', 'text', 'textDim', 'textFaint', 'green', 'red'] as const) {
    assert.equal((out as Record<string, unknown>)[k], BASE[k], `${k} must not change`);
  }
});

test('face tints ride ALONGSIDE the palette, never overwriting green/red', () => {
  // A game tints B red-ish; the palette's own `red` (used by error strips)
  // must be exactly what it was. faceTint is a separate field for this reason.
  const th = themeForAppid(1794680)!;
  const out = applyGameTheme(BASE, th, 'dark');
  assert.equal(out.red, BASE.red, 'palette.red is status, not a game tint');
  assert.equal(out.green, BASE.green, 'palette.green is status, not a game tint');
  assert.equal(out.faceTint.b, th.face!.b!.dark);
  assert.equal(out.faceTint.a, th.face!.a!.dark);
});

test('no theme = identity plus empty tint', () => {
  const out = applyGameTheme(BASE, null, 'dark');
  assert.equal(out.accent, BASE.accent);
  assert.deepEqual(out.faceTint, {});
  assert.equal(out.gameLabel, null);
});

test('GUARD — no game theme may name a protected token', () => {
  // Structural: the type already forbids it, but a future refactor could widen
  // GameTheme. Assert the shape stays accent+face only, so this fails loudly if
  // someone adds a `card` or `text` field to a theme entry.
  // `backdrop` is allowed: it names an asset key + a glow colour, and NEITHER
  // can reach a palette token — the backdrop renders BEHIND the controls with a
  // scrim and touches nothing in the Palette type. Everything else stays banned.
  const allowed = new Set(['label', 'accent', 'face', 'backdrop']);
  for (const [appid, th] of Object.entries(THEMES)) {
    for (const key of Object.keys(th as GameTheme)) {
      assert.ok(allowed.has(key), `${appid} theme has forbidden key '${key}'`);
    }
  }
});

// ---------- Backdrop composition ----------

test('a theme with a backdrop resolves key + scheme glow; none = null', () => {
  const vs = applyGameTheme(BASE, themeForAppid(1794680), 'dark');
  assert.equal(vs.backdrop?.key, 'vampire-survivors');
  assert.match(vs.backdrop!.glow, HEX);
  const none = applyGameTheme(BASE, null, 'dark');
  assert.equal(none.backdrop, null);
});

test('the backdrop glow is the scheme-correct colour', () => {
  const th = themeForAppid(1794680)!;
  assert.equal(applyGameTheme(BASE, th, 'dark').backdrop!.glow, th.backdrop!.glow.dark);
  assert.equal(applyGameTheme(BASE, th, 'light').backdrop!.glow, th.backdrop!.glow.light);
});

// NOTE deliberately NOT asserting the backdrop glow's contrast on card: it is
// decoration drawn at low opacity on the dark base, never text, and every
// button carries its own opaque card background, so a control's glyph legibility
// is independent of the backdrop. What protects legibility is the scrim
// (GameBackdrop.Scrim) + the per-button card bg, not the glow colour. The glyph
// COLOURS are covered by the accent/face-tint contrast test above.
test('every backdrop glow is valid hex in both schemes', () => {
  for (const [appid, th] of Object.entries(THEMES)) {
    if (!th.backdrop) continue;
    assert.match(th.backdrop.glow.dark, HEX, `${appid} backdrop glow.dark`);
    assert.match(th.backdrop.glow.light, HEX, `${appid} backdrop glow.light`);
  }
});

// ---------- Picker resolution ----------

test('resolveTheme: OFF is always null', () => {
  assert.equal(resolveTheme('off', 1794680), null);
  assert.equal(resolveTheme('off', null), null);
  assert.equal(resolveTheme('off', 999999), null);
});

test('resolveTheme: AUTO follows the running game', () => {
  assert.equal(resolveTheme('auto', 1794680)?.label, 'Dark Gothic'); // VS -> gothic
  assert.equal(resolveTheme('auto', 3405340)?.label, 'Neon Arcade'); // Megabonk -> neon
  assert.equal(resolveTheme('auto', 999999), null); // unmapped game
  assert.equal(resolveTheme('auto', null), null);   // nothing running
});

test('resolveTheme: a named key applies ALWAYS, regardless of the game', () => {
  assert.equal(resolveTheme('dark-gothic', null)?.label, 'Dark Gothic');
  assert.equal(resolveTheme('dark-gothic', 999999)?.label, 'Dark Gothic');
  assert.equal(resolveTheme('dark-gothic', 1794680)?.label, 'Dark Gothic');
});

test('the picker lists Off, Auto, and every registered theme — no orphans', () => {
  const values = THEME_PICKER.map((o) => o.value);
  assert.deepEqual(values.slice(0, 2), ['off', 'auto']);
  // Every theme key appears exactly once after off/auto.
  const keys = Object.keys(THEMES).sort();
  assert.deepEqual(values.slice(2).sort(), keys);
  // Every picker value beyond off/auto is a resolvable theme.
  for (const v of values.slice(2)) {
    assert.ok(resolveTheme(v, null), `picker offers '${v}' but resolveTheme returns null`);
  }
  // Labels are non-empty.
  for (const o of THEME_PICKER) assert.ok(o.label.length > 0, `empty label for ${o.value}`);
});

test('the pref normalizer only accepts off / auto / a real theme key', () => {
  // Mirrors lib/prefs.ts normalize: anything else falls back to auto. Assert the
  // set the picker can produce is exactly what the normalizer keeps.
  const accepted = new Set(['off', 'auto', ...Object.keys(THEMES)]);
  for (const o of THEME_PICKER) assert.ok(accepted.has(o.value), `picker value ${o.value} not accepted`);
});

// ---------- Neon Arcade + the pref validator ----------

test('Neon Arcade resolves and Megabonk auto-selects it', () => {
  assert.equal(resolveTheme('neon-arcade', null)?.label, 'Neon Arcade');
  assert.equal(resolveTheme('auto', 3405340)?.label, 'Neon Arcade'); // Megabonk
  assert.equal(resolveTheme('auto', 1794680)?.label, 'Dark Gothic'); // VS unchanged
});

test('isControllerThemePref accepts off/auto/every theme key, rejects junk', () => {
  assert.ok(isControllerThemePref('off'));
  assert.ok(isControllerThemePref('auto'));
  for (const k of Object.keys(THEMES)) assert.ok(isControllerThemePref(k), `rejected real key ${k}`);
  for (const bad of ['', 'nope', 'DARK-GOTHIC', 42, null, undefined, {}]) {
    assert.ok(!isControllerThemePref(bad), `accepted junk ${JSON.stringify(bad)}`);
  }
});

test('a saved theme key survives normalization (regression: was dropped to auto)', () => {
  // The whole point of validating against the registry rather than a hardcoded
  // list: a new theme the normalizer had never heard of used to fall back to
  // 'auto', silently losing the user's pick.
  assert.ok(isControllerThemePref('neon-arcade'));
});
