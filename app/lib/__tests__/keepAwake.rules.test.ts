/**
 * Wake-lock arbitration tests — lib/keepAwakeRules.ts.
 *
 * Run: from app/, `node --experimental-strip-types --test lib/__tests__/*.test.ts`
 * (Node >= 22.6). Picked up by the existing CI `app-input` job's glob.
 *
 * Both states are asserted for every rule (CLAUDE.md §11): a timeout that can
 * only ever be observed expiring, or only ever observed holding, is an
 * unverified timeout. The two failures this guards are opposite and both bad —
 * a lock stranded on forever (the battery complaint that motivated the setting)
 * and a screen that sleeps mid-session (worse than having no setting at all).
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  KEEP_AWAKE_TIMEOUTS,
  KEEP_AWAKE_TIMEOUT_DEFAULT,
  isKeepAwakeTimeout,
  shouldHoldWakeLock,
} from '../keepAwakeRules.ts';

const MIN = 60_000;
/** Defaults describing an active session; each test overrides one thing. */
const ACTIVE = { enabled: true, timeoutMin: 30, focused: true, msSinceActivity: 0 };

test('held while active, released once idle past the timeout', () => {
  // Both states of the SAME rule, which is the point.
  assert.equal(shouldHoldWakeLock({ ...ACTIVE, msSinceActivity: 29 * MIN }), true);
  assert.equal(shouldHoldWakeLock({ ...ACTIVE, msSinceActivity: 31 * MIN }), false);
});

test('the boundary is exclusive: exactly at the timeout releases', () => {
  assert.equal(shouldHoldWakeLock({ ...ACTIVE, msSinceActivity: 30 * MIN - 1 }), true);
  assert.equal(shouldHoldWakeLock({ ...ACTIVE, msSinceActivity: 30 * MIN }), false);
});

test('"Always" (0) never releases, no matter how long idle', () => {
  const a = { ...ACTIVE, timeoutMin: 0 };
  assert.equal(shouldHoldWakeLock({ ...a, msSinceActivity: 0 }), true);
  // A full day idle. This is the historical behavior and must stay reachable.
  assert.equal(shouldHoldWakeLock({ ...a, msSinceActivity: 24 * 60 * MIN }), true);
});

test('the pref off always wins, even with fresh activity', () => {
  assert.equal(shouldHoldWakeLock({ ...ACTIVE, enabled: false }), false);
  // ...including under "Always", where the timeout would otherwise short-circuit.
  assert.equal(
    shouldHoldWakeLock({ ...ACTIVE, enabled: false, timeoutMin: 0 }),
    false,
  );
});

test('unfocused never holds — a missed blur cannot strand the lock', () => {
  assert.equal(shouldHoldWakeLock({ ...ACTIVE, focused: false }), false);
  assert.equal(
    shouldHoldWakeLock({ ...ACTIVE, focused: false, timeoutMin: 0 }),
    false,
  );
  // Control: the only difference from the held case is `focused`.
  assert.equal(shouldHoldWakeLock({ ...ACTIVE, focused: true }), true);
});

test('every offered timeout holds just under and releases just over', () => {
  for (const m of KEEP_AWAKE_TIMEOUTS) {
    if (m === 0) continue; // covered by the "Always" test
    const o = { ...ACTIVE, timeoutMin: m };
    assert.equal(
      shouldHoldWakeLock({ ...o, msSinceActivity: m * MIN - 1000 }),
      true,
      `${m}m should still be held 1s before expiry`,
    );
    assert.equal(
      shouldHoldWakeLock({ ...o, msSinceActivity: m * MIN + 1000 }),
      false,
      `${m}m should be released 1s after expiry`,
    );
  }
});

test('timeout values are validated, not clamped', () => {
  // Positive control: everything we actually offer is accepted.
  for (const m of KEEP_AWAKE_TIMEOUTS) assert.equal(isKeepAwakeTimeout(m), true);
  // Negative control: plausible-but-unoffered values are rejected outright,
  // so a corrupted stored pref falls back to the default instead of silently
  // becoming some other duration.
  for (const bad of [1, 15, 45, 90, -30, 0.5, NaN, Infinity]) {
    assert.equal(isKeepAwakeTimeout(bad), false, `${bad} must not be accepted`);
  }
});

test('the default is a real offered option and is not "Always"', () => {
  assert.equal(isKeepAwakeTimeout(KEEP_AWAKE_TIMEOUT_DEFAULT), true);
  // Upgraders inherit this default. If it were 0 the feature would ship inert,
  // which is the exact failure mode of "add a setting nobody changes".
  assert.notEqual(KEEP_AWAKE_TIMEOUT_DEFAULT, 0);
});
