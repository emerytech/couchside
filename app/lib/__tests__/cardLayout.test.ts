/**
 * cardLayout — the reorder/hide reconciliation shared by the Console, Fleet and
 * Actions tabs. These pin the two pure helpers (effectiveOrder, moveSection)
 * that decide what renders and how a move lands. The store itself is thin glue
 * over useSyncExternalStore + storage and is exercised in the harness.
 *
 * Run: node --experimental-strip-types --test lib/__tests__/cardLayout.test.ts
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { effectiveOrder, moveSection } from '../cardOrder.ts';

test('effectiveOrder: empty stored order falls back to canonical', () => {
  assert.deepEqual(effectiveOrder([], ['a', 'b', 'c']), ['a', 'b', 'c']);
});

test('effectiveOrder: honours a saved order', () => {
  assert.deepEqual(effectiveOrder(['c', 'a', 'b'], ['a', 'b', 'c']), ['c', 'a', 'b']);
});

test('effectiveOrder: drops ids that no longer exist (unpaired box / removed section)', () => {
  // 'x' was saved but is gone now; it must not appear.
  assert.deepEqual(effectiveOrder(['x', 'b', 'a'], ['a', 'b']), ['b', 'a']);
});

test('effectiveOrder: appends a NEW canonical id at its canonical position', () => {
  // 'b' was never ordered by the user; it slots in at index 1, not lost, not last.
  assert.deepEqual(effectiveOrder(['a', 'c'], ['a', 'b', 'c']), ['a', 'b', 'c']);
});

test('effectiveOrder: a brand-new id after a fully custom order still appears', () => {
  // User ordered every old id; a freshly-paired box ('d') must show up.
  const out = effectiveOrder(['c', 'a', 'b'], ['a', 'b', 'c', 'd']);
  assert.ok(out.includes('d'), 'the new id is present');
  assert.equal(out.length, 4);
  assert.deepEqual(new Set(out), new Set(['a', 'b', 'c', 'd']));
});

test('moveSection: down swaps a section with its next VISIBLE neighbour', () => {
  assert.deepEqual(moveSection(['a', 'b', 'c'], ['a', 'b', 'c'], 'a', 1), ['b', 'a', 'c']);
});

test('moveSection: up swaps with the previous visible neighbour', () => {
  assert.deepEqual(moveSection(['a', 'b', 'c'], ['a', 'b', 'c'], 'c', -1), ['a', 'c', 'b']);
});

test('moveSection: at the top edge, up is a no-op (same array contents)', () => {
  assert.deepEqual(moveSection(['a', 'b', 'c'], ['a', 'b', 'c'], 'a', -1), ['a', 'b', 'c']);
});

test('moveSection: at the bottom edge, down is a no-op', () => {
  assert.deepEqual(moveSection(['a', 'b', 'c'], ['a', 'b', 'c'], 'c', 1), ['a', 'b', 'c']);
});

test('moveSection: a HIDDEN/absent id between two visible ones is jumped over', () => {
  // 'b' is not visible (hidden or a null card), so moving 'a' down swaps it past
  // 'b' with 'c' — the arrows step through visible neighbours only, and the FULL
  // order (including 'b') is preserved otherwise.
  const out = moveSection(['a', 'b', 'c'], ['a', 'c'], 'a', 1);
  assert.deepEqual(out, ['c', 'b', 'a']);
});

test('moveSection: moving a hidden id (not in visible) is a no-op', () => {
  assert.deepEqual(moveSection(['a', 'b', 'c'], ['a', 'c'], 'b', 1), ['a', 'b', 'c']);
});

test('effectiveOrder + moveSection compose: reorder survives a reconcile', () => {
  const canonical = ['boot', 'routine', 'medium', 'high'];
  const moved = moveSection(effectiveOrder([], canonical), canonical, 'high', -1);
  assert.deepEqual(moved, ['boot', 'routine', 'high', 'medium']);
  // and it is stable through another reconcile against the same canonical set
  assert.deepEqual(effectiveOrder(moved, canonical), ['boot', 'routine', 'high', 'medium']);
});
