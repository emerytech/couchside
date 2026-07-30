/**
 * The text tokens in lib/theme.ts must clear WCAG AA on the surfaces they are
 * actually drawn on.
 *
 * Run: from app/, `node --experimental-strip-types --test lib/__tests__/*.test.ts`
 * Picked up by the CI app-input glob.
 *
 * WHY THIS EXISTS. A design audit measured the faint tier at 2.99:1 (dark) and
 * 2.77:1 (light) — below AA's 4.5:1 and below even the 3:1 large-text floor.
 * Nothing here could have claimed that floor anyway: every one of the ~109
 * `textFaint` sites renders at 10-12px, so the app's SMALLEST text was carrying
 * its LOWEST contrast — the pairing hint, the box IP, every card title.
 *
 * It reads lib/theme.ts AS TEXT rather than importing it, because theme.ts
 * imports react-native and expo-secure-store and cannot be loaded by bare Node,
 * the only runner this repo has. Reading the real file is also the point: a
 * hard-coded copy of the palette would keep passing after someone edited the
 * source. If the extraction ever stops finding tokens the test FAILS rather than
 * silently passing over nothing — a vacuous green here would be worse than no
 * test at all.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const THEME = join(dirname(fileURLToPath(import.meta.url)), '..', 'theme.ts');

/** WCAG 2.1 relative luminance. */
function luminance(hex: string): number {
  const n = parseInt(hex.slice(1), 16);
  const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
}

/** WCAG 2.1 contrast ratio, 1.0 (identical) to 21.0 (black on white). */
function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** Pull one palette literal (`const dark: Palette = { … }`) out of the source. */
function palette(src: string, name: 'dark' | 'light'): Record<string, string> {
  const start = src.indexOf(`const ${name}: Palette = {`);
  assert.notEqual(start, -1, `could not find the ${name} palette in lib/theme.ts`);
  const body = src.slice(start, src.indexOf('\n};', start));
  const out: Record<string, string> = {};
  for (const m of body.matchAll(/^\s*(\w+):\s*'(#[0-9a-fA-F]{6})'/gm)) out[m[1]] = m[2].toLowerCase();
  return out;
}

const src = readFileSync(THEME, 'utf8');
const PALETTES = { dark: palette(src, 'dark'), light: palette(src, 'light') };

// Text tiers, and the two surfaces any of them can land on.
const TIERS = ['text', 'textDim', 'textFaint'] as const;
const SURFACES = ['card', 'bg'] as const;

test('the extraction actually found the palettes — no vacuous pass', () => {
  for (const [name, p] of Object.entries(PALETTES)) {
    for (const k of [...TIERS, ...SURFACES]) {
      assert.match(p[k] ?? '', /^#[0-9a-f]{6}$/, `${name}.${k} did not parse out of theme.ts`);
    }
  }
});

for (const [name, p] of Object.entries(PALETTES)) {
  for (const tier of TIERS) {
    for (const surface of SURFACES) {
      test(`${name}: ${tier} on ${surface} clears WCAG AA (4.5:1)`, () => {
        const r = contrast(p[tier], p[surface]);
        assert.ok(
          r >= 4.5,
          `${p[tier]} on ${p[surface]} = ${r.toFixed(2)}:1. ` +
            `Every textFaint site is 10-12px, so the 3:1 large-text allowance does not apply here.`,
        );
      });
    }
  }

  test(`${name}: the three text tiers stay visually distinct`, () => {
    // Raising faint to AA squeezes it toward dim; below ~1.25 two greys read as
    // one tier and the hierarchy the palette is FOR quietly disappears. This is
    // the constraint that forced dark's textDim to move up alongside textFaint.
    const faintDim = contrast(p.textFaint, p.textDim);
    const dimText = contrast(p.textDim, p.text);
    assert.ok(faintDim >= 1.25, `textFaint/textDim only ${faintDim.toFixed(2)} apart — same tier`);
    assert.ok(dimText >= 1.25, `textDim/text only ${dimText.toFixed(2)} apart — same tier`);
  });
}

for (const [name, p] of Object.entries(PALETTES)) {
  test(`${name}: onRedDeep is readable on redDeep`, () => {
    const r = contrast(p.onRedDeep, p.redDeep);
    assert.ok(r >= 4.5, `${p.onRedDeep} on ${p.redDeep} = ${r.toFixed(2)}:1`);
  });
}

test('no screen hardcodes a colour literal onto a redDeep surface', () => {
  // The original bug in one line: five call sites wrote `color: '#fecaca'`,
  // which IS light's redDeep, so in light mode the error text was drawn in
  // exactly its own background colour — 1.00:1, invisible. The literal is
  // banned outright; `t.onRedDeep` resolves per theme.
  const roots = ['components', 'app', 'lib/skin'];
  const app = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
  const offenders: string[] = [];
  const walk = (dir: string) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // a root that does not exist is not a failure
    }
    for (const e of entries) {
      const full = join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (/\.tsx?$/.test(e.name) && !full.includes('__tests__')) {
        const text = readFileSync(full, 'utf8');
        text.split('\n').forEach((line, i) => {
          if (/color:\s*'#fecaca'/.test(line)) offenders.push(`${full.slice(app.length + 1)}:${i + 1}`);
        });
      }
    }
  };
  for (const r of roots) walk(join(app, r));
  assert.deepEqual(offenders, [], `hardcoded '#fecaca' as a colour — use t.onRedDeep:\n  ${offenders.join('\n  ')}`);
});

test('CONTROL: the file scan can actually see the source tree', () => {
  // Without this, a wrong path would make the scan above walk nothing and pass
  // over zero files forever.
  const app = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
  assert.ok(readdirSync(join(app, 'components')).some((f) => f.endsWith('.tsx')), 'components/ looked empty');
});

test('CONTROL: the contrast function agrees with the WCAG worked examples', () => {
  // Without this, a broken luminance formula could return a large number for
  // everything and every assertion above would pass on unreadable colours.
  assert.equal(contrast('#000000', '#ffffff').toFixed(2), '21.00');
  assert.equal(contrast('#ffffff', '#ffffff').toFixed(2), '1.00');
  assert.equal(contrast('#767676', '#ffffff').toFixed(2), '4.54'); // AA boundary grey
});

test('CONTROL: a known-bad colour is still rejected', () => {
  // The exact value this audit replaced. If the assertion above ever stops
  // failing this, the threshold has been loosened rather than the colour fixed.
  assert.ok(contrast('#8b97ad', '#ffffff') < 4.5, 'the old light textFaint now passes — threshold drifted');
  assert.ok(contrast('#5b6780', '#141c2e') < 4.5, 'the old dark textFaint now passes — threshold drifted');
});
