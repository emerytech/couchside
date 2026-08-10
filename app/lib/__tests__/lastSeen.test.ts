/**
 * Per-box "last seen" — the persist throttle and the elapsed-time label.
 *
 * The bug this guards: the unreachable banner read usePoll's in-memory
 * lastSuccess, which is null on a cold launch to an already-offline box and is
 * cleared on every box switch, so it showed "last seen: never" for a box seen
 * hundreds of times. The fix persists a per-box timestamp and falls back to it;
 * these tests pin the throttle (so a healthy box does not write every poll) and
 * the formatter (including the "never" case that started this).
 */
import { test } from 'node:test';
import assert from 'node:assert';

import { fmtLastSeen, noteBoxSeen, __resetLastSeenThrottle } from '../lastSeen.ts';

test('fmtLastSeen: no contact reads "never", not a bogus age', () => {
  assert.equal(fmtLastSeen(null), 'never');
  assert.equal(fmtLastSeen(undefined), 'never');
  assert.equal(fmtLastSeen(0), 'never'); // 0 is "never seen", not the epoch
});

test('fmtLastSeen: buckets seconds / minutes / hours', () => {
  const now = Date.now();
  assert.equal(fmtLastSeen(now - 5_000), '5s ago');
  assert.equal(fmtLastSeen(now - 90_000), '1m ago');
  assert.equal(fmtLastSeen(now - 45 * 60_000), '45m ago');
  assert.equal(fmtLastSeen(now - (2 * 3600 + 5 * 60) * 1000), '2h 5m ago');
});

test('fmtLastSeen: a future timestamp (clock skew) reads "just now"', () => {
  assert.equal(fmtLastSeen(Date.now() + 10_000), 'just now');
});

test('noteBoxSeen: persists the first contact, then throttles', () => {
  __resetLastSeenThrottle();
  const writes: number[] = [];
  const persist = (ts: number) => writes.push(ts);

  const t0 = 1_000_000_000_000;
  noteBoxSeen('box-a', t0, persist);
  assert.deepEqual(writes, [t0], 'first contact is persisted');

  // A poll a few seconds later must NOT write (throttle window is 60s).
  noteBoxSeen('box-a', t0 + 8_000, persist);
  noteBoxSeen('box-a', t0 + 30_000, persist);
  assert.deepEqual(writes, [t0], 'polls within the window are throttled');

  // Past the window, it records the fresher time.
  noteBoxSeen('box-a', t0 + 61_000, persist);
  assert.deepEqual(writes, [t0, t0 + 61_000], 'a value >= 60s newer is persisted');
});

test('noteBoxSeen: throttle is per box, and a zero ts is ignored', () => {
  __resetLastSeenThrottle();
  const writes: Array<[string, number]> = [];
  const persistFor = (key: string) => (ts: number) => writes.push([key, ts]);

  const t = 2_000_000_000_000;
  noteBoxSeen('box-a', t, persistFor('box-a'));
  noteBoxSeen('box-b', t, persistFor('box-b')); // different box: not throttled by a's write
  assert.deepEqual(writes, [['box-a', t], ['box-b', t]]);

  // No contact to record.
  noteBoxSeen('box-c', 0, persistFor('box-c'));
  assert.deepEqual(writes.length, 2, 'a zero timestamp never persists');
});
