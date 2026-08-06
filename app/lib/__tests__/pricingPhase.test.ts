/**
 * Pricing copy is a CLAIM, and a stale claim is a false one.
 *
 * "Goes up on September 1" is true in August and a lie in October. These pin
 * that the urgency line disappears by itself once the date passes, that no
 * deadline is ever attached to the purchase-count step (nobody knows one), and
 * that the day maths does not go off by one on the boundary.
 */
import { test } from 'node:test';
import assert from 'node:assert';

import {
  FINAL_PRICE,
  PHASE_2_PRICE,
  pricingPhase,
} from '../pricingPhase.ts';

const on = (y: number, m: number, d: number) => new Date(y, m - 1, d, 12, 0, 0);

test('before the date: the rise is stated with real days remaining', () => {
  const p = pricingPhase(on(2026, 8, 6)); // 26 days out
  assert.equal(p.phase, 'early');
  assert.equal(p.daysUntil, 26);
  assert.match(p.urgency ?? '', /in 26 days/);
  assert.match(p.urgency ?? '', /\$9\.99/);
});

test('the day before reads "tomorrow", not "in 1 days"', () => {
  const p = pricingPhase(on(2026, 8, 31));
  assert.equal(p.daysUntil, 1);
  assert.match(p.urgency ?? '', /tomorrow/);
});

test('ON the day the price rises, the urgency claim is GONE', () => {
  // The whole reason this is computed. A frozen string would still be promising
  // an early price that no longer exists.
  const p = pricingPhase(on(2026, 9, 1));
  assert.equal(p.phase, 'phase2');
  assert.equal(p.urgency, null, 'must not still advertise a passed deadline');
  assert.equal(p.daysUntil, null);
});

test('long after the date it still makes no time-bound claim (control)', () => {
  const p = pricingPhase(on(2027, 3, 15));
  assert.equal(p.urgency, null);
  assert.equal(p.phase, 'phase2');
});

test('the final-price step NEVER carries a deadline, in either phase', () => {
  // It depends on a purchase count the app cannot see. Stating it as a date
  // would be inventing one.
  for (const d of [on(2026, 8, 6), on(2026, 9, 1), on(2027, 1, 1)]) {
    const p = pricingPhase(d);
    assert.match(p.plan, /after 1,000 purchases/);
    assert.ok(
      !/\b(soon|hurry|today only|limited time)\b/i.test(p.plan),
      `no invented urgency: ${p.plan}`,
    );
  }
});

test('each phase points at the price that actually comes next', () => {
  assert.equal(pricingPhase(on(2026, 8, 6)).nextPrice, PHASE_2_PRICE);
  assert.equal(pricingPhase(on(2026, 9, 2)).nextPrice, FINAL_PRICE);
});

test('the plan line names September only while September is ahead (control)', () => {
  assert.match(pricingPhase(on(2026, 8, 6)).plan, /1 September/);
  assert.ok(
    !/1 September/.test(pricingPhase(on(2026, 9, 2)).plan),
    'a passed date must not linger in the copy',
  );
});

test('time of day does not shift the day count', () => {
  const early = pricingPhase(new Date(2026, 7, 31, 0, 5));
  const late = pricingPhase(new Date(2026, 7, 31, 23, 55));
  assert.equal(early.daysUntil, late.daysUntil, 'same calendar day, same claim');
});
