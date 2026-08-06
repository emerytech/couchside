/**
 * The feature tour: sequencing and spotlight geometry.
 *
 * Two ways this fails badly. It repeats forever (a tour you cannot finish is
 * worse than none), or the spotlight lands on the WRONG tab — pointing
 * confidently at something unrelated while the copy describes another screen.
 */
import { test } from 'node:test';
import assert from 'node:assert';

import {
  advanceTour,
  currentStep,
  dimRects,
  dismissTour,
  shouldRun,
  spotlightRect,
  stepLabel,
  TOUR_NOT_STARTED,
  TOUR_STEPS,
} from '../tour.ts';

test('the tour does NOT run before a box is paired', () => {
  // Every step points at a tab that does nothing without a box.
  assert.equal(shouldRun(TOUR_NOT_STARTED, false, true), false);
  assert.equal(shouldRun(TOUR_NOT_STARTED, true, true), true);
});

test('the opt-out silences it entirely (control)', () => {
  assert.equal(shouldRun(TOUR_NOT_STARTED, true, false), false);
});

test('it walks every step exactly once and then stops forever', () => {
  let s = TOUR_NOT_STARTED;
  const seen: string[] = [];
  for (let i = 0; i < 20; i++) {
    const step = currentStep(s);
    if (!step) break;
    seen.push(step.tab);
    s = advanceTour(s);
  }
  assert.deepEqual(seen, TOUR_STEPS.map((x) => x.tab), 'each step once, in order');
  assert.equal(s.done, true, 'finishing marks it done');
  assert.equal(shouldRun(s, true, true), false, 'and it never runs again');
  assert.equal(currentStep(s), null, 'no empty toast one past the end');
});

test('skipping is permanent, like finishing', () => {
  const s = dismissTour();
  assert.equal(shouldRun(s, true, true), false);
  assert.equal(currentStep(s), null);
});

test('the counter reads 1 of N, never 0 or N+1', () => {
  assert.equal(stepLabel(TOUR_NOT_STARTED), `1 of ${TOUR_STEPS.length}`);
  let s = TOUR_NOT_STARTED;
  for (let i = 0; i < TOUR_STEPS.length; i++) s = advanceTour(s);
  assert.equal(stepLabel(s), `${TOUR_STEPS.length} of ${TOUR_STEPS.length}`);
});

test('the spotlight lands on the right tab, and the last tab reaches the edge', () => {
  const W = 400, H = 800, BAR = 80, N = 5;
  const first = spotlightRect(W, H, BAR, N, 0);
  assert.deepEqual(first, { x: 0, y: 720, width: 80, height: 80 });
  const last = spotlightRect(W, H, BAR, N, 4);
  assert.equal(last.x + last.width, W, 'the final tab must touch the screen edge');
});

test('an out-of-range index is clamped, never spotlighting empty space (control)', () => {
  // A tab hidden by caps could otherwise index past the end.
  const W = 400, H = 800, BAR = 80, N = 3;
  assert.equal(spotlightRect(W, H, BAR, N, 99).x, spotlightRect(W, H, BAR, N, 2).x);
  assert.equal(spotlightRect(W, H, BAR, N, -5).x, 0);
  assert.equal(spotlightRect(W, H, BAR, 0, 0).width, W, 'zero tabs must not divide by zero');
});

test('the dim rectangles cover the whole screen EXCEPT the hole (control)', () => {
  const W = 400, H = 800, BAR = 80, N = 5;
  const hole = spotlightRect(W, H, BAR, N, 2);
  const rects = dimRects(W, H, hole);
  const area = rects.reduce((a, r) => a + r.width * r.height, 0);
  assert.equal(area, W * H - hole.width * hole.height, 'no gap, no overlap');
  // and nothing overlaps the hole itself
  for (const r of rects) {
    const overlapsX = r.x < hole.x + hole.width && r.x + r.width > hole.x;
    const overlapsY = r.y < hole.y + hole.height && r.y + r.height > hole.y;
    assert.ok(!(overlapsX && overlapsY), `dim rect covers the spotlight: ${JSON.stringify(r)}`);
  }
});
