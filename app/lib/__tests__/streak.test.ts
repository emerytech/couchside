/**
 * Streak arithmetic. Date handling is where a streak silently goes wrong, and
 * "wrong" here means telling a user they lost a run they did not lose — so the
 * awkward cases (timezones, DST, month/year ends, clocks moving backwards) are
 * the point of this file, not the happy path.
 */
import { test } from 'node:test';
import assert from 'node:assert';

import {
  advance,
  dayKey,
  daysBetween,
  EMPTY_STREAK,
  MILESTONES,
  pendingMilestone,
  streakLabel,
  type StreakState,
} from '../streak.ts';

const at = (s: string) => new Date(s);

test('a first-ever open starts the streak at 1', () => {
  const s = advance(EMPTY_STREAK, at('2026-08-06T20:00:00'));
  assert.equal(s.days, 1);
  assert.equal(s.lastDay, '2026-08-06');
  assert.equal(s.best, 1);
});

test('opening the app twice in one day is not two days', () => {
  const a = advance(EMPTY_STREAK, at('2026-08-06T09:00:00'));
  const b = advance(a, at('2026-08-06T23:30:00'));
  assert.equal(b.days, 1);
  assert.deepEqual(b, a, 'same day must be a no-op, not a rewrite');
});

test('consecutive days increment', () => {
  let s = advance(EMPTY_STREAK, at('2026-08-06T12:00:00'));
  s = advance(s, at('2026-08-07T08:00:00'));
  s = advance(s, at('2026-08-08T22:00:00'));
  assert.equal(s.days, 3);
});

test('a missed day resets to 1, and best remembers the run', () => {
  let s: StreakState = { days: 9, lastDay: '2026-08-01', celebrated: 7, best: 9 };
  s = advance(s, at('2026-08-03T10:00:00')); // skipped the 2nd
  assert.equal(s.days, 1, 'streak restarts');
  assert.equal(s.best, 9, 'a broken streak must not erase that it happened');
  assert.equal(s.celebrated, 0, 'milestones can be earned again on the way back');
});

test('LOCAL days, not UTC: a late-evening open in a western timezone is still today', () => {
  // 8pm local. Under toISOString() this is already tomorrow in UTC for anyone
  // west of Greenwich, which would roll the streak over hours early.
  const evening = at('2026-08-06T20:00:00');
  assert.equal(dayKey(evening), '2026-08-06');
});

test('a clock moving BACKWARDS never destroys or inflates a streak', () => {
  const s: StreakState = { days: 5, lastDay: '2026-08-06', celebrated: 3, best: 5 };
  const back = advance(s, at('2026-08-04T10:00:00'));
  assert.deepEqual(back, s, 'travelling backwards is a no-op');
});

test('day counting survives month, year and leap boundaries', () => {
  assert.equal(daysBetween('2026-08-31', '2026-09-01'), 1);
  assert.equal(daysBetween('2026-12-31', '2027-01-01'), 1);
  assert.equal(daysBetween('2028-02-28', '2028-02-29'), 1, 'leap day is a real day');
  assert.equal(daysBetween('2026-08-06', '2026-08-06'), 0);
  assert.equal(daysBetween('2026-08-06', '2026-08-04'), -2);
});

test('DST does not create or swallow a day', () => {
  // US spring-forward (23h) and fall-back (25h) days must still be one day.
  assert.equal(daysBetween('2026-03-07', '2026-03-08'), 1);
  assert.equal(daysBetween('2026-11-01', '2026-11-02'), 1);
});

test('a milestone fires once, and only once', () => {
  const s: StreakState = { days: 7, lastDay: '2026-08-06', celebrated: 3, best: 7 };
  assert.equal(pendingMilestone(s), 7);
  const after = { ...s, celebrated: 7 };
  assert.equal(pendingMilestone(after), null, 'already celebrated must not re-fire');
});

test('a big jump celebrates ONE milestone, not a queue of them', () => {
  const s: StreakState = { days: 100, lastDay: '2026-08-06', celebrated: 0, best: 100 };
  assert.equal(pendingMilestone(s), 100, 'the highest earned, not 3 then 7 then 14…');
});

test('ordinary days celebrate nothing (control)', () => {
  // "Ordinary" means: not itself a milestone, with the earlier ones already
  // celebrated. That is the steady state; a day-4 user HAS celebrated day 3.
  for (const days of [1, 2, 4, 5, 6, 8, 13, 29]) {
    const earned = MILESTONES.filter((m) => m <= days);
    const celebrated = earned.length ? earned[earned.length - 1] : 0;
    const s: StreakState = { days, lastDay: '2026-08-06', celebrated, best: days };
    const hit = pendingMilestone(s);
    assert.equal(hit, null, `day ${days} must not interrupt anyone (got ${hit})`);
  }
});

test('a milestone missed while celebrations were OFF still fires when re-enabled', () => {
  // The flip side of the control above, and the reason pendingMilestone looks at
  // `celebrated` rather than at `days === milestone`: someone who turns the
  // toggle back on should still be told they hit 7, not silently skipped.
  const s: StreakState = { days: 9, lastDay: '2026-08-06', celebrated: 0, best: 9 };
  assert.equal(pendingMilestone(s), 7);
});

test('every milestone is reachable by counting one day at a time (control)', () => {
  // Guards the off-by-one that would make a milestone unreachable: walk 400 real
  // days and assert each milestone fires exactly once.
  let s = EMPTY_STREAK;
  const fired: number[] = [];
  const start = new Date('2026-01-01T12:00:00');
  for (let i = 0; i < 400; i++) {
    const d = new Date(start);
    d.setDate(start.getDate() + i);
    s = advance(s, d);
    const m = pendingMilestone(s);
    if (m != null) {
      fired.push(m);
      s = { ...s, celebrated: m };
    }
  }
  assert.deepEqual(fired, [...MILESTONES], 'each milestone fires once, in order');
});

test('the label reads naturally at 1', () => {
  assert.equal(streakLabel(1), '1 day');
  assert.equal(streakLabel(2), '2 days');
});
