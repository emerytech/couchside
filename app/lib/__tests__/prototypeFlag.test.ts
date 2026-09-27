/**
 * PROTOTYPE build gate — source guard.
 *
 * Prototype-only, unfinished features (the "what to play next" Reserve screen and
 * its doorway) must NEVER appear in a production/store build. That guarantee is a
 * single build-time flag, IS_PROTOTYPE_BUILD, set only on the `prototype` EAS
 * profile via EXPO_PUBLIC_PROTOTYPE=1. Bare Node can't execute entitlement.ts
 * (it imports react-native), so — like entitlementDirect.test.ts — this pins the
 * wiring by reading the source: the flag's definition, and that the Console
 * doorway is actually gated on it. A refactor that drops the gate fails here.
 */
import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ent = readFileSync(join(import.meta.dirname, '..', 'entitlement.ts'), 'utf8');
const index = readFileSync(join(import.meta.dirname, '..', '..', 'app', '(tabs)', 'index.tsx'), 'utf8');

test('IS_PROTOTYPE_BUILD is a per-build flag from EXPO_PUBLIC_PROTOTYPE', () => {
  assert.match(ent, /export const IS_PROTOTYPE_BUILD\s*=\s*process\.env\.EXPO_PUBLIC_PROTOTYPE === '1'/);
});

test('the Reserve doorway is gated on IS_PROTOTYPE_BUILD (never in production)', () => {
  assert.ok(index.includes('import { IS_PROTOTYPE_BUILD }'),
    'index.tsx must import IS_PROTOTYPE_BUILD');
  const gate = index.indexOf('IS_PROTOTYPE_BUILD &&');
  const push = index.indexOf("router.push('/reserve')");
  assert.ok(gate >= 0, 'the doorway must be rendered behind an IS_PROTOTYPE_BUILD && guard');
  assert.ok(push > gate, 'the /reserve navigation must sit inside the IS_PROTOTYPE_BUILD block');
});
