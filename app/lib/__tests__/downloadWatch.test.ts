/**
 * When a vanished Steam download counts as FINISHED.
 *
 * The expensive failure here is announcing a cancellation as a completion —
 * that sends someone to the TV for a game that is not there. The agent lists an
 * app only while an operation runs, so "it disappeared" is ambiguous by
 * construction and the last observed progress is the only evidence available.
 */
import { test } from 'node:test';
import assert from 'node:assert';

import {
  advanceWatch,
  DONE_PERCENT,
  EMPTY_WATCH,
  isActive,
  pollInterval,
} from '../downloadWatch.ts';

const dl = (over: Partial<{ appid: number; name: string; state: string; active?: boolean; percent: number }> = {}) => ({
  appid: 1,
  name: 'Elden Ring',
  state: 'downloading',
  percent: 50,
  ...over,
});

test('a download that vanishes near-complete is announced', () => {
  const a = advanceWatch(EMPTY_WATCH, [dl({ percent: 95 })]);
  assert.deepEqual(a.finished, [], 'nothing announced while it is still listed');
  const b = advanceWatch(a.next, []);
  assert.deepEqual(b.finished, ['Elden Ring']);
  assert.equal(b.changed, true);
});

test('a download that vanishes mid-progress is a CANCELLATION, not a finish', () => {
  // The whole reason this module exists. Announcing this would send someone to
  // the TV for a game that is not there.
  const a = advanceWatch(EMPTY_WATCH, [dl({ percent: 40 })]);
  const b = advanceWatch(a.next, []);
  assert.deepEqual(b.finished, [], 'no claim');
  assert.equal(b.changed, true, 'but the library still changed, so refresh');
});

test('finalizing counts however low the percentage reads', () => {
  const a = advanceWatch(EMPTY_WATCH, [dl({ state: 'finalizing', percent: 3 })]);
  assert.deepEqual(advanceWatch(a.next, []).finished, ['Elden Ring']);
});

test('a QUEUED entry that disappears was dequeued, never started', () => {
  const a = advanceWatch(EMPTY_WATCH, [dl({ state: 'queued', percent: 99 })]);
  const b = advanceWatch(a.next, []);
  assert.deepEqual(b.finished, [], 'it never actually ran');
  assert.equal(b.changed, true);
});

test('active:false is respected, and undefined still means active (control)', () => {
  // Agents older than 2.9.4 omit the field; treating undefined as inactive
  // would silence completions on every one of them.
  assert.equal(isActive(dl({ active: false })), false);
  assert.equal(isActive(dl({ active: undefined })), true);
  assert.equal(isActive(dl({ state: 'queued' })), false);
});

test('it announces once, not on every subsequent poll', () => {
  const a = advanceWatch(EMPTY_WATCH, [dl({ percent: 99 })]);
  const b = advanceWatch(a.next, []);
  assert.deepEqual(b.finished, ['Elden Ring']);
  const c = advanceWatch(b.next, []);
  assert.deepEqual(c.finished, [], 'the same completion must not repeat');
  assert.equal(c.changed, false);
});

test('a steady list produces no claims and no churn (control)', () => {
  const list = [dl({ percent: 10 }), dl({ appid: 2, name: 'Hades', percent: 80 })];
  const a = advanceWatch(EMPTY_WATCH, list);
  const b = advanceWatch(a.next, list);
  assert.deepEqual(b.finished, []);
  assert.equal(b.changed, false);
});

test('two finishing at once are both announced', () => {
  const a = advanceWatch(EMPTY_WATCH, [
    dl({ percent: 99 }),
    dl({ appid: 2, name: 'Hades', state: 'finalizing', percent: 5 }),
  ]);
  const b = advanceWatch(a.next, []);
  assert.deepEqual(b.finished.sort(), ['Elden Ring', 'Hades']);
});

test('the boundary is inclusive at DONE_PERCENT (control)', () => {
  const at = advanceWatch(advanceWatch(EMPTY_WATCH, [dl({ percent: DONE_PERCENT })]).next, []);
  assert.deepEqual(at.finished, ['Elden Ring']);
  const below = advanceWatch(advanceWatch(EMPTY_WATCH, [dl({ percent: DONE_PERCENT - 1 })]).next, []);
  assert.deepEqual(below.finished, []);
});

test('polling is fast only while bytes actually move', () => {
  assert.equal(pollInterval([dl()]), 5000);
  assert.equal(pollInterval([dl({ state: 'queued' })]), 20000, 'a parked queue must not hammer the box');
  assert.equal(pollInterval([]), 20000);
});
