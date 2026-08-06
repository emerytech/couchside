/**
 * Pricing copy is a CLAIM, and a stale claim is a false one.
 *
 * "Goes up on September 1" is true in August and a lie in October. These pin
 * that each step retires itself, that the ladder's prices match what
 * couchside.tv states publicly, and that once the ladder finishes the app stops
 * selling a deadline instead of inventing one.
 */
import { test } from 'node:test';
import assert from 'node:assert';

import { EARLY_PRICE, LADDER, pricingPhase } from '../pricingPhase.ts';

const on = (y: number, m: number, d: number) => new Date(y, m - 1, d, 12, 0, 0);

test('the ladder matches what the public site promises', () => {
  // If these drift, the app and couchside.tv are making two different promises
  // about the same product. That is the failure this test exists to catch.
  assert.equal(EARLY_PRICE, '$4.99');
  assert.deepEqual(
    LADDER.map((s) => [s.from.getFullYear(), s.from.getMonth() + 1, s.from.getDate(), s.price]),
    [
      [2026, 9, 1, '$7.99'],
      [2026, 10, 1, '$9.99'],
      [2026, 11, 1, '$14.99'],
    ],
  );
});

test('in August: early price, next step is $7.99', () => {
  const p = pricingPhase(on(2026, 8, 6));
  assert.equal(p.currentPrice, '$4.99');
  assert.equal(p.nextPrice, '$7.99');
  assert.equal(p.daysUntil, 26);
  assert.match(p.urgency ?? '', /Early-adopter price/);
  assert.match(p.urgency ?? '', /in 26 days/);
  assert.match(p.plan, /1 September/);
});

test('the day before a rise reads "tomorrow", not "in 1 days"', () => {
  const p = pricingPhase(on(2026, 8, 31));
  assert.equal(p.daysUntil, 1);
  assert.match(p.urgency ?? '', /tomorrow/);
});

test('ON the day of a rise, the price steps up and the old deadline is gone', () => {
  const p = pricingPhase(on(2026, 9, 1));
  assert.equal(p.currentPrice, '$7.99', 'the rise took effect');
  assert.equal(p.nextPrice, '$9.99', 'now pointing at the NEXT step');
  assert.ok(!/September/.test(p.plan), 'a passed date must not linger in the copy');
  assert.match(p.plan, /1 October/);
});

test('mid-ladder no longer claims to be an early-adopter price (control)', () => {
  const p = pricingPhase(on(2026, 10, 5));
  assert.equal(p.currentPrice, '$9.99');
  assert.equal(p.nextPrice, '$14.99');
  assert.ok(!/Early-adopter/.test(p.urgency ?? ''), `stale framing: ${p.urgency}`);
  assert.match(p.urgency ?? '', /Current price/);
});

test('once the ladder finishes there is NO urgency at all', () => {
  // $14.99 is held indefinitely. Manufacturing a deadline here would be the
  // exact dark pattern this module exists to avoid.
  const p = pricingPhase(on(2026, 11, 1));
  assert.equal(p.currentPrice, '$14.99');
  assert.equal(p.nextPrice, null);
  assert.equal(p.daysUntil, null);
  assert.equal(p.urgency, null);
});

test('long after the ladder, still no time-bound claim (control)', () => {
  const p = pricingPhase(on(2028, 4, 20));
  assert.equal(p.currentPrice, '$14.99');
  assert.equal(p.urgency, null);
  assert.ok(
    !/\b(soon|hurry|today only|limited time)\b/i.test(p.plan),
    `no invented urgency: ${p.plan}`,
  );
});

test('every step is reachable, and prices only ever go up (control)', () => {
  // Walks the whole ladder a day at a time and asserts the price never regresses
  // — an out-of-order LADDER entry would otherwise show a price DROP to a user.
  let last = 0;
  const num = (s: string) => Number(s.replace('$', ''));
  const seen = new Set<string>();
  for (let i = 0; i < 500; i++) {
    const d = new Date(2026, 7, 1);
    d.setDate(d.getDate() + i);
    const p = pricingPhase(d);
    const v = num(p.currentPrice);
    assert.ok(v >= last, `price went DOWN on ${d.toDateString()}: ${last} -> ${v}`);
    last = v;
    seen.add(p.currentPrice);
  }
  assert.deepEqual([...seen], ['$4.99', '$7.99', '$9.99', '$14.99'], 'each step is reached');
});

test('time of day does not shift the day count', () => {
  const early = pricingPhase(new Date(2026, 7, 31, 0, 5));
  const late = pricingPhase(new Date(2026, 7, 31, 23, 55));
  assert.equal(early.daysUntil, late.daysUntil, 'same calendar day, same claim');
});
