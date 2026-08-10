/**
 * Playlog drag-to-reorder geometry — lib/playlogReorder.ts.
 *
 * Run: from app/, `node --experimental-strip-types --test lib/__tests__/*.test.ts`
 *
 * WHY THIS EXISTS: the drag gesture computes a drop slot from frozen row centres
 * and a finger delta, then splices the queue. A wrong index here silently
 * reorders the WRONG game — the sort of gesture-path bug that only ever shows up
 * on a device, never in a render. Both directions and the boundaries are pinned.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  arrayMove, computeDropIndex, reorderWithinSubset, rowCenters,
} from '../playlogReorder.ts';

// Three rows, centres 10 / 30 / 50 (variable-height rows would just change the
// numbers; the maths is the same).
const C = [10, 30, 50];

test('arrayMove: down, up, no-op, and index clamping', () => {
  assert.deepEqual(arrayMove(['a', 'b', 'c'], 0, 2), ['b', 'c', 'a']);
  assert.deepEqual(arrayMove(['a', 'b', 'c'], 2, 0), ['c', 'a', 'b']);
  assert.deepEqual(arrayMove(['a', 'b', 'c'], 0, 1), ['b', 'a', 'c']);
  assert.deepEqual(arrayMove(['a', 'b', 'c'], 1, 1), ['a', 'b', 'c']);
  // out-of-range never throws or drops the item
  assert.deepEqual(arrayMove(['a', 'b', 'c'], 0, 99), ['b', 'c', 'a']);
  assert.deepEqual(arrayMove(['a', 'b', 'c'], -5, 0), ['a', 'b', 'c']);
  assert.deepEqual(arrayMove([], 0, 0), []);
});

test('computeDropIndex: dragging the top row DOWN', () => {
  // held still over its own slot -> no move
  assert.equal(computeDropIndex(C, 0, 10), 0);
  // dragged to just past B's centre -> lands at index 1
  assert.equal(computeDropIndex(C, 0, 40), 1);
  // dragged past C -> lands at the bottom
  assert.equal(computeDropIndex(C, 0, 60), 2);
});

test('computeDropIndex: dragging the bottom row UP', () => {
  assert.equal(computeDropIndex(C, 2, 50), 2); // still
  assert.equal(computeDropIndex(C, 2, 20), 1); // between A and B
  assert.equal(computeDropIndex(C, 2, 5), 0);  // above everything
});

test('computeDropIndex: the round-trip actually moves the intended key', () => {
  const keys = ['a', 'b', 'c'];
  const to = computeDropIndex(C, 0, 60); // drag "a" to the bottom
  assert.deepEqual(arrayMove(keys, 0, to), ['b', 'c', 'a']);
});

test('computeDropIndex: single row is always a no-op', () => {
  assert.equal(computeDropIndex([25], 0, 999), 0);
  assert.equal(computeDropIndex([], 0, 0), 0);
});

test('rowCenters: measured rows give a running-sum of height+gap', () => {
  // heights 80,100,60 with gap 10 -> tops 0,90,200 -> centres 40,140,230
  const c = rowCenters(['a', 'b', 'c'], { a: 80, b: 100, c: 60 }, 10, 84);
  assert.deepEqual(c, [40, 140, 230]);
});

test('rowCenters: an UNMEASURED row uses the default, never 0', () => {
  // 'c' was never laid out (virtualized out). It must NOT collapse to 0 (which
  // would sort it to the top and corrupt the drop index) — it takes the default.
  const c = rowCenters(['a', 'b', 'c'], { a: 80, b: 80 }, 10, 84);
  // a: 0..80 centre 40 ; b: 90..170 centre 130 ; c: default 84 -> 180..264 centre 222
  assert.deepEqual(c, [40, 130, 222]);
  // strictly increasing -> ordering is preserved
  assert.ok(c[0] < c[1] && c[1] < c[2]);
});

test('reorderWithinSubset: full reorder when every key is named', () => {
  assert.deepEqual(reorderWithinSubset(['a', 'b', 'c'], ['c', 'a', 'b']), ['c', 'a', 'b']);
});

test('reorderWithinSubset: off-screen keys keep their exact position', () => {
  // i1,i2 are installed (shown); n1,n2 are not-installed (still loading, hidden).
  // Reordering the two visible rows must NOT relocate n1/n2 to the tail.
  const full = ['i1', 'n1', 'i2', 'n2'];
  const out = reorderWithinSubset(full, ['i2', 'i1']); // user moved i1 below i2
  assert.deepEqual(out, ['i2', 'n1', 'i1', 'n2']);
  // membership is unchanged (nothing added or dropped)
  assert.deepEqual([...out].sort(), [...full].sort());
});

test('reorderWithinSubset: unknown keys are ignored, dupes collapsed', () => {
  assert.deepEqual(reorderWithinSubset(['a', 'b'], ['b', 'zzz', 'b', 'a']), ['b', 'a']);
});
