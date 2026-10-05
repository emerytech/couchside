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
  absentAnchorVerdict,
  advanceTour,
  anchorHole,
  cardSlot,
  currentStep,
  dimRects,
  dismissTour,
  onlineSinceMs,
  previousTour,
  isFinalStep,
  scrollDeltaFor,
  shouldRun,
  spotlightRect,
  stepLabel,
  tourLink,
  TOUR_CHECK_CAP_MS,
  TOUR_CHECKING,
  TOUR_HOLD_RECHECK_MS,
  TOUR_LINK_SETTLE_MS,
  TOUR_NOT_STARTED,
  TOUR_OFFLINE_AFTER_MS,
  TOUR_OFFLINE_BODY,
  TOUR_OFFLINE_TITLE,
  TOUR_STEPS,
  type TourLink,
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

test('only the LAST step is final — skipping earlier must not count as finishing', () => {
  // The thank-you note is gated on this. Skipping is someone asking to be left
  // alone, and both skip and finish land on TOUR_FINISHED, so the difference has
  // to be caught BEFORE the state is written or it is lost.
  assert.equal(isFinalStep(TOUR_NOT_STARTED), false, 'step 1 of many is not the end');
  let s = TOUR_NOT_STARTED;
  for (let i = 0; i < TOUR_STEPS.length - 1; i += 1) {
    assert.equal(isFinalStep(s), i === TOUR_STEPS.length - 1, `step ${i} finality`);
    s = advanceTour(s);
  }
  assert.equal(isFinalStep(s), true, 'the last step reports final');
  assert.equal(advanceTour(s).done, true, 'and advancing from it finishes the tour');
});

test('back steps one at a time and cannot exit the tour', () => {
  // A mis-tapped GOT IT should be recoverable. Back must NOT double as "leave" —
  // that is the conflation the first-run flow already had to fix, and SKIP is
  // what leaving is for.
  let s = TOUR_NOT_STARTED;
  s = advanceTour(s);
  s = advanceTour(s);
  assert.equal(s.step, 2);
  assert.deepEqual(previousTour(s), { step: 1, done: false });
  assert.deepEqual(previousTour({ step: 0, done: false }), { step: 0, done: false }, 'clamped, not negative');
  assert.equal(previousTour({ step: 3, done: false }).done, false, 'back never finishes the tour');
});

test('back out of a finished tour returns to its last step (control)', () => {
  // TOUR_FINISHED sits one past the end; stepping back from it must land on a
  // real step rather than the empty slot.
  const back = previousTour({ step: TOUR_STEPS.length, done: true });
  assert.equal(back.step, TOUR_STEPS.length - 1);
  assert.equal(back.done, false);
  assert.ok(currentStep(back) !== null, 'and that step actually renders');
});

// ---------------------------------------------------------------------------
// A box step whose anchor is absent: skip quietly, wait, or say the box is down.
//
// The shipped bug: with the box unreachable the tour walked past every step
// the box draws and opened on "3 of 6", saying nothing. Found on a real iPhone.
// ---------------------------------------------------------------------------

test('no answer yet is CHECKING — never reported as "not connected"', () => {
  assert.equal(tourLink({ hasData: false, hasError: false }), 'checking');
  assert.equal(tourLink({ hasData: true, hasError: false }), 'online', '(control)');
  assert.equal(tourLink({ hasData: false, hasError: true }), 'offline');
  // The poll keeps its last payload across a failure. Old data is not evidence
  // that the box is there now.
  assert.equal(tourLink({ hasData: true, hasError: true }), 'offline', 'stale data does not mean online');
});

test('exactly the box-drawn steps are tagged needsBox, and never the last one', () => {
  assert.deepEqual(
    TOUR_STEPS.filter((s) => s.needsBox).map((s) => s.anchor),
    ['console.cpu', 'launch.grid', 'actions.high'],
  );
  // A notice must never be the card whose Next finishes the tour: the thank-you
  // note is for someone who saw the last step, not someone told it was missing.
  assert.notEqual(TOUR_STEPS[TOUR_STEPS.length - 1].needsBox, true);
});

test('onlineSinceMs marks where one unbroken online run began', () => {
  assert.equal(onlineSinceMs(null, 'online', 300), 300);
  assert.equal(onlineSinceMs(300, 'online', 900), 300, 'the run keeps its start');
  assert.equal(onlineSinceMs(0, 'online', 900), 0, 'a run that began at zero is not mistaken for "no run"');
  assert.equal(onlineSinceMs(300, 'offline', 900), null, 'a failure ends the run');
  assert.equal(onlineSinceMs(300, 'checking', 900), null);
  assert.equal(onlineSinceMs(null, 'checking', 0), null, '(control)');
});

/**
 * Drive the SHIPPED rule the way FeatureTour's measuring loop does when the
 * anchor never measures, recording each change of verdict as "verdict@waitedMs".
 * Uses only shipped functions and the shipped hold interval; the 100 is
 * RETRY_EVERY_MS, pinned by the wiring guard at the bottom of this file.
 */
function timeline(
  at: (waitedMs: number) => { link: TourLink; confirmed: boolean },
  opts: { needsBox?: boolean; budgetMs?: number; untilMs?: number } = {},
): string[] {
  const { needsBox = true, budgetMs = 700, untilMs = 60_000 } = opts;
  const out: string[] = [];
  let since: number | null = null;
  let last = '';
  for (let waited = 0; waited <= untilMs; ) {
    const { link, confirmed } = at(waited);
    since = onlineSinceMs(since, link, waited);
    const v = absentAnchorVerdict({ needsBox, link, waitedMs: waited, budgetMs, onlineSince: since, confirmed });
    if (v !== last) {
      out.push(`${v}@${waited}`);
      last = v;
    }
    if (v === 'skip') break;
    waited += v === 'offline' ? TOUR_HOLD_RECHECK_MS : 100;
  }
  return out;
}

const OFFLINE = { link: 'offline' as TourLink, confirmed: false };
const CHECKING = { link: 'checking' as TourLink, confirmed: false };
const ONLINE = { link: 'online' as TourLink, confirmed: true };
const STALE = { link: 'online' as TourLink, confirmed: false };

test('THE BUG: a box that is down HOLDS the step — it is never skipped', () => {
  // Through a full minute: told at 0.7s, and no skip however long it stays down.
  assert.deepEqual(timeline(() => OFFLINE, { budgetMs: 700 }), ['wait@0', 'offline@700']);
});

test('a known-down box does not sit out the 4s first-poll budget before saying so', () => {
  // Launch and Actions have no measurable sibling offline, so their budget is
  // the full 4000ms. A failed poll is already an answer.
  assert.deepEqual(timeline(() => OFFLINE, { budgetMs: 4000 }), ['wait@0', 'offline@700']);
});

test('still probing says "checking", and only a FAILED poll turns it into the notice', () => {
  assert.deepEqual(
    timeline((w) => (w < 5000 ? CHECKING : OFFLINE), { budgetMs: 700 }),
    ['wait@0', 'checking@700', 'offline@5000'],
  );
});

test('a poll that never settles is capped, so the step cannot wait forever', () => {
  assert.deepEqual(timeline(() => CHECKING), ['wait@0', 'checking@700', `offline@${TOUR_CHECK_CAP_MS}`]);
});

test('an answering box that lacks the feature still skips quietly at the old budget (control)', () => {
  // Online from the moment the step opened; the confirming answer lands at 100ms.
  const steady = (w: number) => (w < 100 ? STALE : ONLINE);
  assert.deepEqual(timeline(steady, { budgetMs: 700 }), ['wait@0', 'skip@700']);
  assert.deepEqual(timeline(steady, { budgetMs: 4000 }), ['wait@0', 'skip@4000']);
});

test('a cold start is given until the box answers, then a full settle, before skipping', () => {
  // This is also the old cold-pair skip: Console has siblings that measure at
  // once, so its budget is 700ms — shorter than a first status poll. The step
  // used to be gone before the box had said anything.
  assert.deepEqual(
    timeline((w) => (w < 1500 ? CHECKING : ONLINE), { budgetMs: 700 }),
    ['wait@0', 'checking@700', 'wait@1500', `skip@${1500 + TOUR_LINK_SETTLE_MS}`],
  );
});

test('a box that comes back under the notice clears it and gets a full settle', () => {
  // Offline re-checks every 500ms, so the recovery at 9000 is seen at 9200.
  assert.deepEqual(
    timeline((w) => (w < 9000 ? OFFLINE : ONLINE), { budgetMs: 700 }),
    ['wait@0', 'offline@700', 'wait@9200', `skip@${9200 + TOUR_LINK_SETTLE_MS}`],
  );
});

test('one failed poll shows the notice briefly, then a recovery still never costs the step', () => {
  assert.deepEqual(
    timeline((w) => (w < 2000 ? OFFLINE : ONLINE), { budgetMs: 4000 }),
    ['wait@0', 'offline@700', 'wait@2200', `skip@${2200 + TOUR_LINK_SETTLE_MS}`],
  );
});

test('a box that drops mid-tour cannot be skipped on its stale "online" reading', () => {
  // The poll still says online from 30s ago; the fresh request fails at 4300.
  assert.deepEqual(
    timeline((w) => (w < 4300 ? STALE : OFFLINE), { budgetMs: 4000 }),
    ['wait@0', 'checking@4000', 'offline@4300'],
  );
  // And a stale reading that is never refreshed ends at the cap, not at a skip.
  assert.deepEqual(timeline(() => STALE), ['wait@0', 'checking@700', `offline@${TOUR_CHECK_CAP_MS}`]);
});

test('a restarted loop that first sees the box online still settles if the box was down this step', () => {
  // The measuring loop restarts when the box's first answer reshuffles the tab
  // bar (its caps arrive with it) or the window resizes. A fresh loop's first
  // pass sees 'online', so onlineSince is 0 — which alone reads as "answering
  // since the step opened". Found by a reviewer in a React rig: the step was
  // skipped 0.7s after the box came back, before the screen had drawn it.
  const at = (sawDown: boolean, waitedMs: number) =>
    absentAnchorVerdict({ needsBox: true, link: 'online', waitedMs, budgetMs: 700, onlineSince: 0, confirmed: true, sawDown });
  assert.equal(at(false, 700), 'skip', 'answering all step long: the old budget (control)');
  assert.equal(at(true, 700), 'wait', 'was down this step: no shortcut');
  assert.equal(at(true, TOUR_LINK_SETTLE_MS - 100), 'wait');
  assert.equal(at(true, TOUR_LINK_SETTLE_MS), 'skip', 'and a full settle from the restart');
});

test('the settle outlasts one full retry cycle of the screen’s own poll', async () => {
  // The screen draws the control from its OWN request on its own timer. When
  // the box comes back that request may be about to time out and then wait out
  // its back-off. Settling sooner skips the step the notice just promised.
  const { readFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const read = (p: string) => readFileSync(join(import.meta.dirname, '../..', p), 'utf8');
  const retry = Number(/const ERROR_RETRY_MS = (\d+);/.exec(read('hooks/usePoll.ts'))?.[1]);
  const timeout = Number(/const TIMEOUT_MS = (\d+);/.exec(read('lib/api.ts'))?.[1]);
  assert.ok(retry > 0 && timeout > 0, 'found both constants (control)');
  assert.ok(TOUR_LINK_SETTLE_MS >= retry + timeout, `settle ${TOUR_LINK_SETTLE_MS} < retry ${retry} + timeout ${timeout}`);
  // A probe still in flight (abort + 1s hard deadline) must not be capped into
  // "not connected", and the cap must sit beyond a recovery settle.
  assert.ok(TOUR_CHECK_CAP_MS > timeout + 1000 && TOUR_CHECK_CAP_MS > TOUR_LINK_SETTLE_MS);
  assert.equal(TOUR_OFFLINE_AFTER_MS, 700, 'matches READY_GIVE_UP_MS: a screen holding old data gets its usual chance');
});

test('a step the phone draws by itself ignores the box entirely (control)', () => {
  assert.deepEqual(timeline(() => OFFLINE, { needsBox: false, budgetMs: 700 }), ['wait@0', 'skip@700']);
  assert.deepEqual(timeline(() => OFFLINE, { needsBox: false, budgetMs: 4000 }), ['wait@0', 'skip@4000']);
  assert.deepEqual(timeline(() => CHECKING, { needsBox: false, budgetMs: 700 }), ['wait@0', 'skip@700']);
});

test('the verdict holds its invariants across every combination', () => {
  const links: TourLink[] = ['checking', 'online', 'offline'];
  const waits = [0, 100, 600, 700, 3900, 4000, 11_900, 12_000, 60_000];
  let cases = 0;
  for (const needsBox of [true, false]) {
    for (const link of links) {
      for (const confirmed of [true, false]) {
        for (const budgetMs of [700, 4000]) {
          for (const waitedMs of waits) {
            const sinces = link === 'online' ? [0, Math.floor(waitedMs / 2), waitedMs] : [null];
            for (const onlineSince of sinces) {
              cases += 1;
              const v = absentAnchorVerdict({ needsBox, link, waitedMs, budgetMs, onlineSince, confirmed });
              const tag = JSON.stringify({ needsBox, link, confirmed, budgetMs, waitedMs, onlineSince });
              if (!needsBox) {
                assert.equal(v, waitedMs >= budgetMs ? 'skip' : 'wait', `a phone-drawn step keeps the old rule ${tag}`);
                continue;
              }
              if (v === 'skip') {
                assert.ok(link === 'online' && confirmed, `skipped without a fresh answer from the box ${tag}`);
                assert.ok(waitedMs >= budgetMs, `skipped before the screen's own budget ${tag}`);
              }
              if (link === 'offline') {
                assert.equal(v, waitedMs >= TOUR_OFFLINE_AFTER_MS ? 'offline' : 'wait', tag);
              }
              if (link === 'checking' && waitedMs < TOUR_CHECK_CAP_MS) {
                assert.ok(v === 'wait' || v === 'checking', `probing was reported as down ${tag}`);
              }
              if (link !== 'offline' && (link === 'checking' || !confirmed) && waitedMs >= TOUR_CHECK_CAP_MS && waitedMs >= budgetMs) {
                assert.equal(v, 'offline', `nothing waits past the cap ${tag}`);
              }
              if (link === 'online' && waitedMs < budgetMs) assert.equal(v, 'wait', tag);
            }
          }
        }
      }
    }
  }
  assert.ok(cases > 300, 'the sweep actually ran (control)');
});

test('the notice says what happened and names the replay control as Setup labels it', async () => {
  assert.equal(TOUR_OFFLINE_TITLE, 'Box not connected');
  assert.equal(TOUR_CHECKING, 'Checking the box…');
  assert.ok(TOUR_OFFLINE_BODY.includes('Next'), 'says how to carry on');
  assert.ok(TOUR_OFFLINE_BODY.includes('Setup › Prefs › Replay the feature tour'), 'says how to see the step later');
  assert.ok(!TOUR_OFFLINE_BODY.includes("'"), 'typographic apostrophes, like the rest of the 2.9.74 copy');
  // The path in the copy is a promise about another screen. Pin the other end.
  const { readFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const setup = readFileSync(join(import.meta.dirname, '../../app/(tabs)/setup.tsx'), 'utf8');
  assert.ok(setup.includes('label="Replay the feature tour"'), 'Setup still has that control');
  assert.ok(setup.includes("label: 'Prefs'"), 'under a tab still called Prefs');
});

test('the component is actually wired to the rule (source guard)', async () => {
  // FeatureTour imports react-native and cannot run in bare Node, so the wiring
  // that makes the tests above mean anything is pinned by reading the source.
  const { readFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const read = (p: string) => readFileSync(join(import.meta.dirname, '../..', p), 'utf8');

  const tour = read('components/FeatureTour.tsx');
  // CODE ONLY: comments and the import block mention every name below, so a
  // plain includes() passed with the bug reintroduced (a reviewer proved it).
  const code = tour
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    .replace(/^import[\s\S]*?from '[^']+';$/gm, '');
  for (const site of [
    'const verdict = absentAnchorVerdict({',
    // The ONE way out of the loop without a measured anchor. A break on
    // 'offline' as well is the shipped bug.
    "if (verdict === 'skip') break;",
    'since = onlineSinceMs(since, now.link, waited);',
    'now.linkAt >= mem.startedAt',
    'now.onRecheck();',
    "if (now.link !== 'online') mem.sawDown = true;",
    'sawDown: mem.sawDown,',
    "verdict === 'offline' ? TOUR_HOLD_RECHECK_MS : RETRY_EVERY_MS",
    '{TOUR_OFFLINE_TITLE}',
    '{TOUR_OFFLINE_BODY}',
    'TOUR_CHECKING',
    // VoiceOver is told the tour is waiting for a press (role="alert" on a
    // plain View is inert on iOS).
    'if (showOffline) AccessibilityInfo.announceForAccessibility(',
    "const showOffline = held === 'offline' && idx >= 0;",
  ]) {
    assert.ok(code.includes(site), `FeatureTour no longer does: ${site}`);
  }
  assert.equal((code.match(/verdict === 'skip'/g) ?? []).length, 1, 'skip is decided in exactly one place');
  // The notice's Next advances; its Skip ends. Not swapped, not merged.
  const notice = code.slice(code.indexOf('if (showOffline)'), code.indexOf('Finding the next control'));
  assert.match(notice, /onSkip\(\);[\s\S]*accessibilityLabel="Skip the tour"[\s\S]*onNext\(\);/);
  // timeline() above steps at 100ms; that is only honest while this holds.
  assert.ok(tour.includes('const RETRY_EVERY_MS = 100;'), 'the retry interval the timelines assume');
  // A held step measures with no time limit. Unmount must invalidate the loop
  // on every path, or Skip leaves one alive that can advance a later replay.
  assert.match(tour, /useEffect\(\(\) => \(\) => \{\s*runId\.current \+= 1;?\s*\}, \[\]\)/, 'unmount invalidates the measuring loop');
  // A poll result must never RESTART the step: the loop reads the box through a
  // ref, so the box must stay out of the measuring effect's dependencies.
  assert.ok(
    tour.includes('}, [state.step, anchor, tab, idx, order, width, height, insets.bottom]);'),
    'the measuring effect depends on the step and geometry only',
  );

  const layout = read('app/(tabs)/_layout.tsx');
  assert.match(layout, /const boxPoll = useCapsSync\(\)/, 'the layout keeps the poll it mounts');
  assert.match(
    layout,
    /<FeatureTour[\s\S]{0,400}?link=\{tourLink\(\{ hasData: boxPoll\.data != null, hasError: boxPoll\.error != null \}\)\}/,
    'and hands the tour that poll’s verdict',
  );
  assert.match(layout, /<FeatureTour[\s\S]{0,400}?linkAt=\{boxPoll\.lastSuccess\}/, 'with the time of its last answer');
  assert.match(layout, /<FeatureTour[\s\S]{0,400}?onRecheck=\{boxPoll\.refresh\}/, 'and a way to ask again');

  assert.ok(read('hooks/useCapsSync.ts').includes('return status;'), 'useCapsSync returns its poll');
});
