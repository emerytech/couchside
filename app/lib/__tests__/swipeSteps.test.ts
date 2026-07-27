/**
 * Swipe-to-d-pad stepping — lib/swipeSteps.ts.
 *
 * Run: from app/, `node --experimental-strip-types --test lib/__tests__/*.test.ts`
 * Picked up by the CI `app-input` job's glob.
 *
 * REGRESSION UNDER TEST (reported 2026-07-26): pressing STEAM and swiping right
 * to reach the open-apps entry overshot it. The old rule emitted one step per
 * 56px with no first-vs-repeat distinction, so a natural ~200px flick sent
 * THREE presses and sailed past a short menu. The first test below is that
 * exact gesture, and it is the one to keep if this file is ever trimmed.
 *
 * This is the safety-critical input path (CLAUDE.md §4): "how many presses does
 * one gesture send" must not be verified by feel.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  SWIPE_FIRST_PX,
  SWIPE_REPEAT_PX,
  planSteps,
  type StepState,
} from '../swipeSteps.ts';

const fresh = (): StepState => ({ consumedX: 0, consumedY: 0, stepped: false });

/** Steps a whole gesture emits, fed in realistic incremental moves. */
function gesture(points: [number, number][], sens = 1): string[] {
  let st = fresh();
  const out: string[] = [];
  for (const [dx, dy] of points) {
    const p = planSteps(dx, dy, st, sens);
    out.push(...p.dirs);
    st = p.next;
  }
  return out;
}

test('THE BUG: a normal flick right emits exactly one step', () => {
  // ~200px, delivered as a real drag would be. Previously: 3 steps.
  const dirs = gesture([[40, 0], [90, 0], [150, 0], [200, 0]]);
  assert.deepEqual(dirs, ['dr'], `flick sent ${dirs.length} steps: ${dirs}`);
});

test('a deliberate long drag still scrolls several', () => {
  const dirs = gesture([[100, 0], [250, 0], [400, 0], [560, 0]]);
  assert.equal(dirs.length >= 3, true, `long drag sent only ${dirs.length}`);
  assert.equal(new Set(dirs).size, 1, 'a straight drag must not change axis');
  assert.equal(dirs[0], 'dr');
});

test('the first step fires as soon as the flick threshold is crossed', () => {
  assert.deepEqual(planSteps(SWIPE_FIRST_PX, 0, fresh()).dirs, ['dr']);
  // ...and not a pixel before it.
  assert.deepEqual(planSteps(SWIPE_FIRST_PX - 1, 0, fresh()).dirs, []);
});

test('a repeat costs much more travel than the first step', () => {
  // Just past the first threshold: one step, not two.
  const a = planSteps(SWIPE_FIRST_PX + SWIPE_REPEAT_PX - 1, 0, fresh());
  assert.equal(a.dirs.length, 1);
  // One pixel past first+repeat: the second step lands.
  const b = planSteps(SWIPE_FIRST_PX + SWIPE_REPEAT_PX, 0, fresh());
  assert.equal(b.dirs.length, 2);
});

test('all four directions, with the sign right', () => {
  assert.deepEqual(planSteps(200, 0, fresh()).dirs, ['dr']);
  assert.deepEqual(planSteps(-200, 0, fresh()).dirs, ['dl']);
  assert.deepEqual(planSteps(0, 200, fresh()).dirs, ['dd']);
  assert.deepEqual(planSteps(0, -200, fresh()).dirs, ['du']);
});

test('a diagonal drag never emits two axes at once', () => {
  // The dominant axis wins; a d-pad must never get two directions from one move.
  const p = planSteps(300, 90, fresh());
  assert.equal(new Set(p.dirs).size <= 1, true, `mixed axes: ${p.dirs}`);
  assert.equal(p.dirs[0], 'dr');
});

test('sensitivity scales both thresholds, preserving its meaning', () => {
  // Higher sensitivity = smaller steps = more of them for the same travel.
  const low = gesture([[400, 0]], 0.6).length;
  const mid = gesture([[400, 0]], 1).length;
  const high = gesture([[400, 0]], 1.6).length;
  assert.equal(low <= mid, true, `low=${low} mid=${mid}`);
  assert.equal(mid <= high, true, `mid=${mid} high=${high}`);
  assert.equal(high >= 2, true, 'high sensitivity should still scroll');
});

test('a zero or negative sensitivity cannot divide by zero or invert', () => {
  for (const s of [0, -1]) {
    const p = planSteps(200, 0, fresh(), s);
    assert.deepEqual(p.dirs, ['dr'], `sensitivity ${s} misbehaved`);
  }
});

test('no travel emits nothing, and state is unchanged', () => {
  const p = planSteps(0, 0, fresh());
  assert.deepEqual(p.dirs, []);
  assert.deepEqual(p.next, fresh());
});

test('step count is bounded — a runaway gesture cannot flood input', () => {
  // An absurd delta must not emit unbounded presses into the box.
  const p = planSteps(1e9, 0, fresh());
  assert.equal(p.dirs.length <= 64, true, `emitted ${p.dirs.length}`);
});

test('reversing mid-gesture steps back the other way', () => {
  // Swipe right past the threshold, then drag back left past it.
  const dirs = gesture([[220, 0], [0, 0], [-220, 0]]);
  assert.equal(dirs.includes('dr'), true);
  assert.equal(dirs.includes('dl'), true);
});
