/**
 * Flatpak-update completion — lib/flatpakUpdate.ts.
 *
 * Run: from app/, `node --experimental-strip-types --test lib/__tests__/*.test.ts`
 * Picked up by the CI app-input glob.
 *
 * THE BUG (KI-036, device-confirmed 2026-07-27): "done" was `count === 0`, but
 * an end-of-life runtime `flatpak update` can't apply pins the count above zero,
 * so done was unreachable — the card spun ten minutes and blocked the OS update
 * behind it. The first test is that exact scenario: a NEW agent reports the
 * process finished (running=false) while the count is still nonzero, and that
 * MUST read as complete.
 *
 * Controls run both directions (CLAUDE.md §11.3): every "complete" case is
 * paired with a "not complete" one, so a function that always returned true
 * would fail.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { isFlatpakUpdateComplete } from '../flatpakUpdate.ts';

test('THE BUG: a finished update with an un-updatable app left over is COMPLETE', () => {
  // New agent: process done, but the EOL runtime keeps count at 1.
  assert.equal(isFlatpakUpdateComplete({ running: false, count: 1 }), true);
  // ...even with several stuck EOL apps.
  assert.equal(isFlatpakUpdateComplete({ running: false, count: 5 }), true);
  // CONTROL, opposite direction: while the process is still running it is NOT
  // complete, whatever the count — so this cannot pass by always returning true.
  assert.equal(isFlatpakUpdateComplete({ running: true, count: 0 }), false);
  assert.equal(isFlatpakUpdateComplete({ running: true, count: 5 }), false);
});

test('new agent: running is the sole signal, count is ignored', () => {
  assert.equal(isFlatpakUpdateComplete({ running: false, count: 0 }), true);
  assert.equal(isFlatpakUpdateComplete({ running: true, count: 0 }), false);
});

test('old agent (no running field) falls back to count === 0, unchanged', () => {
  assert.equal(isFlatpakUpdateComplete({ count: 0 }), true);
  assert.equal(isFlatpakUpdateComplete({ count: 1 }), false);
  // The EOL runtime is exactly why the old path hangs — documented, not fixed
  // for old agents (they never send `running`). This asserts the pre-fix
  // behaviour is preserved so upgrading the app alone changes nothing there.
  assert.equal(isFlatpakUpdateComplete({ count: 3 }), false);
});

test('a not-yet-readable status keeps the poller waiting', () => {
  assert.equal(isFlatpakUpdateComplete(null), false);
  assert.equal(isFlatpakUpdateComplete(undefined), false);
});

test('running takes precedence even when count would say otherwise', () => {
  // Both fields present and disagreeing: the process signal wins in both
  // directions — done-with-leftovers is done; still-running-at-zero is not.
  assert.equal(isFlatpakUpdateComplete({ running: false, count: 9 }), true);
  assert.equal(isFlatpakUpdateComplete({ running: true, count: 0 }), false);
});
