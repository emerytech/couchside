/**
 * Navigation-stack hygiene — the phantom-duplicate-(tabs) bug.
 *
 * Run: from app/, `node --experimental-strip-types --test lib/__tests__/*.test.ts`
 *
 * REGRESSION UNDER TEST (owner video, 2026-08-07, iOS): dragging the landscape
 * pad's left stick swiped the whole screen away to Setup. Two causes stacked:
 *
 *  1. `router.push('/(tabs)/...')` from inside the tab group creates a SECOND
 *     `(tabs)` entry on the root stack. Tab switches must use `router.navigate`
 *     (or `.replace`), which switch in place. Without a duplicate entry the
 *     back gesture has nothing to pop to and cannot fire at all.
 *  2. iOS 26 flipped `fullScreenGestureEnabled` to default TRUE, so the
 *     back-swipe worked across the whole screen — and a JS PanResponder cannot
 *     veto a native recogniser. Android has neither option; the report was
 *     "only occurs in iOS", which is exactly that.
 *
 * Both halves are asserted here as source properties: no tab-internal push
 * anywhere, and the root stack pinning the gesture options. Lint-grade, like
 * the percentage guard in padLayout.test.ts, and for the same reason: the bug
 * is trivially reintroducible by one innocent-looking line.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const APP = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    if (e === 'node_modules' || e.startsWith('.')) continue;
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(e) && !p.includes('__tests__')) out.push(p);
  }
  return out;
}

test('no router.push into the (tabs) group — tab switches must navigate', () => {
  const offenders: string[] = [];
  for (const p of [...walk(join(APP, 'app')), ...walk(join(APP, 'components')), ...walk(join(APP, 'lib')), ...walk(join(APP, 'hooks'))]) {
    const src = readFileSync(p, 'utf8');
    // push to any route inside the tab group, however quoted or templated.
    if (/router\.push\(\s*[`'"]\/\(tabs\)/.test(src)) offenders.push(p.slice(APP.length + 1));
  }
  assert.deepEqual(offenders, [],
    `push() stacks a duplicate (tabs) entry that the iOS back-swipe pops to: ${offenders.join(', ')}`);
});

test('CONTROL — the push detector actually matches the bad pattern', () => {
  assert.ok(/router\.push\(\s*[`'"]\/\(tabs\)/.test("router.push('/(tabs)/setup?tab=account')"));
  assert.ok(/router\.push\(\s*[`'"]\/\(tabs\)/.test('router.push(`/(tabs)/pad`)'));
  assert.ok(!/router\.push\(\s*[`'"]\/\(tabs\)/.test("router.navigate('/(tabs)/setup')"));
  assert.ok(!/router\.push\(\s*[`'"]\/\(tabs\)/.test("router.push('/onboarding')"));
});

test('the root stack pins the iOS back gesture', () => {
  const src = readFileSync(join(APP, 'app', '_layout.tsx'), 'utf8');
  assert.ok(src.includes('fullScreenGestureEnabled: false'),
    'iOS 26 defaults fullScreenGestureEnabled to TRUE — the whole screen becomes a back gesture over an app made of drag surfaces');
  assert.ok(/gestureEnabled:\s*!immersive/.test(src),
    'the immersive controller must refuse the dismissal gesture outright; it has its own EXIT');
});
