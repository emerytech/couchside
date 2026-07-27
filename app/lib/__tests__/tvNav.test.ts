/**
 * TV-mode cursor stepping — lib/tvNav.ts.
 *
 * Run: from app/, `node --experimental-strip-types --test lib/__tests__/*.test.ts`
 * Picked up by the existing CI `app-input` job's glob.
 *
 * This is input-path arithmetic (CLAUDE.md §4), and the failure it guards is
 * quiet rather than loud: a wrong sign sends the cursor the opposite way from
 * the swipe, and a fractional delta truncates on the wire so repeated steps
 * drift off the tile row instead of tracking it. Both directions of every axis
 * are asserted for that reason.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { TV_STEPS, TV_STEP_DEFAULT, isTvStep, tvStepDelta } from '../tvNav.ts';

test('each direction moves the pointer the right way', () => {
  // Both directions of both axes — a sign flip is the whole bug class here.
  assert.deepEqual(tvStepDelta('dr', 260), { dx: 260, dy: 0 });
  assert.deepEqual(tvStepDelta('dl', 260), { dx: -260, dy: 0 });
  assert.deepEqual(tvStepDelta('dd', 260), { dx: 0, dy: 260 });
  assert.deepEqual(tvStepDelta('du', 260), { dx: 0, dy: -260 });
});

test('a step moves exactly one axis', () => {
  for (const d of ['du', 'dd', 'dl', 'dr'] as const) {
    const { dx, dy } = tvStepDelta(d, 260);
    assert.equal(dx === 0 || dy === 0, true, `${d} moved diagonally`);
    assert.notEqual(dx === 0 && dy === 0, true, `${d} moved nothing`);
  }
});

test('deltas are always integers — the wire format truncates', () => {
  for (const px of [160.4, 259.6, 380.5, 0.2]) {
    for (const d of ['du', 'dd', 'dl', 'dr'] as const) {
      const { dx, dy } = tvStepDelta(d, px);
      assert.equal(Number.isInteger(dx), true, `${d}@${px} dx=${dx}`);
      assert.equal(Number.isInteger(dy), true, `${d}@${px} dy=${dy}`);
    }
  }
});

test('a step is never zero, however small the setting', () => {
  // A zero delta is dropped by sendMouseMove, so the swipe would feel dead.
  for (const px of [0, -5, 0.1]) {
    const { dx } = tvStepDelta('dr', px);
    assert.equal(dx >= 1, true, `${px} produced dx=${dx}`);
  }
});

test('opposite directions cancel exactly', () => {
  // Swipe right then left must land back where it started, or the cursor
  // walks away from the row over a session.
  for (const px of TV_STEPS) {
    const r = tvStepDelta('dr', px);
    const l = tvStepDelta('dl', px);
    assert.equal(r.dx + l.dx, 0, `${px} did not cancel on x`);
    const d = tvStepDelta('dd', px);
    const u = tvStepDelta('du', px);
    assert.equal(d.dy + u.dy, 0, `${px} did not cancel on y`);
  }
});

test('every offered step size is usable and distinct', () => {
  assert.equal(new Set(TV_STEPS).size, TV_STEPS.length);
  for (const px of TV_STEPS) {
    assert.equal(isTvStep(px), true);
    assert.equal(tvStepDelta('dr', px).dx, px);
  }
  // Ordered small-to-large, so the Settings labels stay truthful.
  assert.deepEqual([...TV_STEPS].sort((a, b) => a - b), [...TV_STEPS]);
});

test('the default is an offered size', () => {
  assert.equal(isTvStep(TV_STEP_DEFAULT), true);
  // Rejected rather than clamped, so a corrupt stored pref falls back.
  for (const bad of [0, 100, 200, 500, -260, NaN]) {
    assert.equal(isTvStep(bad), false, `${bad} must not be accepted`);
  }
});
