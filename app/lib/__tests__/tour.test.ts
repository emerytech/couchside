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
  anchorHole,
  cardSlot,
  currentStep,
  dimRects,
  dismissTour,
  scrollDeltaFor,
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

test('the hole EXCLUDES the home-indicator inset (seen clipped on a real phone)', () => {
  // Including the inset made the ring taller than the tab, so it hung into the
  // gesture strip and read as clipped at the bottom edge.
  const W = 400, H = 800, BAR = 49, INSET = 34, N = 6;
  const r = spotlightRect(W, H, BAR, N, 0, INSET);
  assert.equal(r.height, BAR, 'the hole is the tab row, not the row plus the strip');
  assert.equal(r.y + r.height, H - INSET, 'it sits directly above the inset');
});

test('with no inset the hole still reaches the bottom (control)', () => {
  const r = spotlightRect(400, 800, 49, 6, 0);
  assert.equal(r.y + r.height, 800);
});

test('the dim panels still tile exactly around an inset hole (control)', () => {
  const W = 400, H = 800, BAR = 49, INSET = 34, N = 6;
  const hole = spotlightRect(W, H, BAR, N, 3, INSET);
  const area = dimRects(W, H, hole).reduce((a, r) => a + r.width * r.height, 0);
  assert.equal(area, W * H - hole.width * hole.height, 'no gap, no overlap below the hole either');
});

// ---------------------------------------------------------------------------
// Element anchors
//
// The tour can now spotlight a card or a button rather than a tab icon. Two new
// ways to be confidently wrong: the hole lands somewhere the element is not, or
// a step names an anchor NO SCREEN REGISTERS — which does not crash, it just
// silently skips the step forever. The last test below is the one that catches
// the typo, by reading the actual source.
// ---------------------------------------------------------------------------

test('an anchor hole hugs the element, with padding', () => {
  const r = anchorHole({ x: 40, y: 200, width: 120, height: 80 }, 6, 400, 900);
  assert.deepEqual(r, { x: 34, y: 194, width: 132, height: 92 });
});

test('an anchor hole is clamped to the screen, never negative (control)', () => {
  // A full-bleed row at the very top: padding must not push it off-screen, or
  // dimRects gets a negative-width panel and drops it, leaving an undimmed strip.
  const r = anchorHole({ x: 0, y: 0, width: 400, height: 60 }, 8, 400, 900);
  assert.deepEqual(r, { x: 0, y: 0, width: 400, height: 68 });
  const off = anchorHole({ x: 380, y: 880, width: 100, height: 100 }, 8, 400, 900);
  assert.ok(off.x + off.width <= 400 && off.y + off.height <= 900, 'stays on screen');
  assert.ok(off.width > 0 && off.height > 0, 'still a real rect');
});

test('the dim panels tile exactly around an INTERIOR hole too', () => {
  const W = 400, H = 900;
  const hole = anchorHole({ x: 40, y: 300, width: 200, height: 100 }, 6, W, H);
  const panels = dimRects(W, H, hole);
  const area = panels.reduce((n, r) => n + r.width * r.height, 0);
  assert.equal(area, W * H - hole.width * hole.height, 'no gap, no overlap');
  for (const r of panels) {
    const overlapsX = r.x < hole.x + hole.width && hole.x < r.x + r.width;
    const overlapsY = r.y < hole.y + hole.height && hole.y < r.y + r.height;
    assert.ok(!(overlapsX && overlapsY), `dim rect covers the spotlight: ${JSON.stringify(r)}`);
  }
});

test('scrolling: below the fold scrolls down, above scrolls up, visible does nothing', () => {
  const TOP = 100, BOT = 700;
  assert.equal(scrollDeltaFor({ x: 0, y: 300, width: 10, height: 100 }, TOP, BOT), 0, 'already visible (control)');
  assert.ok(scrollDeltaFor({ x: 0, y: 800, width: 10, height: 100 }, TOP, BOT) > 0, 'below the fold scrolls down');
  assert.ok(scrollDeltaFor({ x: 0, y: 20, width: 10, height: 40 }, TOP, BOT) < 0, 'above the band scrolls up');
});

test('an element taller than the band aligns its top rather than its middle', () => {
  const TOP = 100, BOT = 400;
  const d = scrollDeltaFor({ x: 0, y: 500, width: 10, height: 900 }, TOP, BOT, 24);
  assert.equal(d, 500 - 24 - TOP, 'top edge lands at the top of the band');
});

test('the card goes below a high element and above a low one, never over it', () => {
  const H = 900, CARD = 160, GAP = 14;
  const high = cardSlot({ x: 0, y: 80, width: 400, height: 100 }, H, CARD, GAP, 50, 30);
  assert.equal(high.placement, 'below');
  assert.ok(high.top >= 80 + 100, 'starts under the element');

  const low = cardSlot({ x: 0, y: 700, width: 400, height: 100 }, H, CARD, GAP, 50, 30);
  assert.equal(low.placement, 'above');
  assert.ok(low.top + CARD <= 700, 'ends above the element');
});

test('the card stays inside the safe area even when the element fills the screen (control)', () => {
  const H = 900, CARD = 160;
  const slot = cardSlot({ x: 0, y: 0, width: 400, height: 900 }, H, CARD, 14, 60, 40);
  assert.ok(slot.top >= 60, 'never under the notch');
  assert.ok(slot.top + CARD <= H - 40, 'never behind the home indicator');
});

test('every anchor a step names is registered by some screen', async () => {
  // THE TYPO TEST. An anchor id is a string shared between lib/tour.ts and a
  // screen; a mismatch is invisible at runtime because an unregistered anchor
  // is the SAME signal as "this box does not have this feature" — the step
  // just quietly never shows. Nothing else would catch it, so read the source.
  const { readFileSync, readdirSync } = await import('node:fs');
  const { join } = await import('node:path');
  const roots = ['app/(tabs)', 'components'];
  let src = '';
  for (const r of roots) {
    const dir = join(import.meta.dirname, '../..', r);
    for (const f of readdirSync(dir)) {
      if (f.endsWith('.tsx')) src += readFileSync(join(dir, f), 'utf8');
    }
  }
  const named = TOUR_STEPS.map((s) => s.anchor).filter((a): a is string => a != null);
  assert.ok(named.length > 0, 'the tour should anchor to real elements');
  for (const id of named) {
    // Either quote style — JSX attributes use double, object literals single.
    const found = src.includes(`"${id}"`) || src.includes(`'${id}'`);
    assert.ok(found, `no screen registers the anchor "${id}"`);
  }
});

test('a step points at a tab that exists (control)', () => {
  const TABS = ['index', 'launch', 'pad', 'actions', 'setup'];
  for (const s of TOUR_STEPS) assert.ok(TABS.includes(s.tab), `unknown tab ${s.tab}`);
});
