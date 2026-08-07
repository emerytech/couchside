/**
 * Surface-change detection — lib/padSurface.ts.
 *
 * Run: from app/, `node --experimental-strip-types --test lib/__tests__/*.test.ts`
 *
 * WHY THIS EXISTS: this predicate is the ONLY thing that releases a held
 * input when the pad's components are swapped or removed under a finger.
 * React fires no responder-terminate and no onPressOut on unmount, and the
 * agent latches the last frame it received on a healthy socket — so a missed
 * transition here means the game keeps walking with nobody touching the
 * screen. Two of these cases were shipped bugs found in review, one per
 * release; both are pinned below.
 *
 * This is the safety-critical input path (CLAUDE.md §4).
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { surfaceChanged, type PadSurface } from '../padSurface.ts';

const S = (o: Partial<PadSurface> = {}): PadSurface =>
  ({ mounted: true, mode: 'move', landscape: false, ...o });

test('an unchanged surface releases nothing', () => {
  // The predicate runs every render; firing on identity would spam the wire.
  assert.equal(surfaceChanged(S(), S()), false);
});

test('leaving the pad releases — EXIT, blur, or a window below the floors', () => {
  assert.equal(surfaceChanged(S({ mounted: true }), S({ mounted: false })), true);
  assert.equal(surfaceChanged(S({ mounted: false }), S({ mounted: true })), true);
});

test('a mode switch releases — different components entirely', () => {
  assert.equal(surfaceChanged(S({ mode: 'move' }), S({ mode: 'gamepad' })), true);
  assert.equal(surfaceChanged(S({ mode: 'move' }), S({ mode: 'swipe' })), true);
});

test('REGRESSION: rotating INSIDE move mode releases', () => {
  // Found in the vertical-mode review. Rotation swaps the vertical table for
  // the spread one — every PanResponder is remounted — while `mounted` and
  // `mode` both stay exactly the same. A tuple of those two alone misses it,
  // and a stick held through the rotation stays pinned on the agent.
  assert.equal(
    surfaceChanged(S({ mode: 'move', landscape: false }), S({ mode: 'move', landscape: true })),
    true,
  );
});

test('REGRESSION: a window shrinking below the floors releases', () => {
  // Found in the movement-mode review. Stage Manager / Android freeform can
  // shrink a still-landscape window under the layout floors, swapping the pad
  // for the too-small card. `mounted` folds landGeom.ok in precisely so this
  // is not invisible to the guard.
  assert.equal(
    surfaceChanged(S({ mounted: true, landscape: true }), S({ mounted: false, landscape: true })),
    true,
  );
});

test('CONTROL — the predicate can return false, so the tests above are not vacuous', () => {
  // If it always returned true every assertion here would pass while proving
  // nothing. Vary a field the signature deliberately does NOT carry.
  const a = { ...S(), extra: 1 } as PadSurface;
  const b = { ...S(), extra: 2 } as PadSurface;
  assert.equal(surfaceChanged(a, b), false);
});
