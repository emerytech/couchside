/**
 * Trackpad gesture-classification tests (CLAUDE.md §4 — input path). The logic
 * lives in a pure module because useTrackpad.ts imports react-native's
 * PanResponder (not node-loadable) and RN-Web emits mouse, not touch events, so
 * the harness can't exercise these gestures. Run:
 *   node --experimental-strip-types --test --test-force-exit hooks/__tests__/*.test.ts
 *
 * The two cases the tester reported (right-click flaky, two-finger scroll leaks a
 * click) are pinned as BUG1 / BUG2 below. Pre-fix, a motionless two-finger tap
 * classified as a left-click, and a short two-finger stroke as a right-click.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

const { classifyRelease, TP_TAP_MS } = await import('../trackpadGesture.ts');

test('one-finger quick still tap -> left-click', () => {
  assert.equal(
    classifyRelease({ maxTouches: 1, moved: false, scrolled: false, elapsedMs: 100 }),
    'left-click',
  );
});

test('one-finger drag -> none (pointer move, not a click)', () => {
  assert.equal(
    classifyRelease({ maxTouches: 1, moved: true, scrolled: false, elapsedMs: 100 }),
    'none',
  );
});

test('one-finger slow press -> none', () => {
  assert.equal(
    classifyRelease({ maxTouches: 1, moved: false, scrolled: false, elapsedMs: 400 }),
    'none',
  );
});

test('BUG1: motionless two-finger tap -> right-click (was misfiring as left)', () => {
  assert.equal(
    classifyRelease({ maxTouches: 2, moved: false, scrolled: false, elapsedMs: 120 }),
    'right-click',
  );
});

test('BUG2: short two-finger scroll -> none (no spurious right-click)', () => {
  assert.equal(
    classifyRelease({ maxTouches: 2, moved: false, scrolled: true, elapsedMs: 150 }),
    'none',
  );
});

test('two-finger gesture never falls through to a left-click', () => {
  // classifies on `scrolled`, not the one-finger `moved` slop: a quick still
  // two-finger release is a right-click, and it is NEVER a left-click.
  for (const moved of [false, true]) {
    const a = classifyRelease({ maxTouches: 2, moved, scrolled: false, elapsedMs: 100 });
    assert.notEqual(a, 'left-click', `maxTouches=2 moved=${moved} must not left-click`);
    assert.equal(a, 'right-click');
  }
});

test('two-finger slow press -> none', () => {
  assert.equal(
    classifyRelease({ maxTouches: 2, moved: false, scrolled: false, elapsedMs: 400 }),
    'none',
  );
});

test('boundary: elapsed exactly TP_TAP_MS is too slow -> none', () => {
  assert.equal(
    classifyRelease({ maxTouches: 1, moved: false, scrolled: false, elapsedMs: TP_TAP_MS }),
    'none',
  );
});
