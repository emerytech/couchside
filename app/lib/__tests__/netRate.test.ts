/**
 * fmtRate — lib/netRate.ts.
 *
 * Run: from app/, `node --experimental-strip-types --test lib/__tests__/*.test.ts`
 * Picked up by the CI app-input glob.
 *
 * Both directions on every threshold (CLAUDE.md §11.3): each unit is checked
 * with a value that lands in it AND the boundary that should tip to the next
 * unit, so a wrong comparator would fail.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { fmtRate } from '../netRate.ts';

test('picks the unit by magnitude, decimal (÷1000)', () => {
  assert.equal(fmtRate(0), '0/s');
  assert.equal(fmtRate(512), '512B/s');
  assert.equal(fmtRate(999), '999B/s');
  assert.equal(fmtRate(1000), '1K/s'); // tips to K exactly at 1e3
  assert.equal(fmtRate(340_000), '340K/s');
  assert.equal(fmtRate(1_000_000), '1.0M/s'); // tips to M exactly at 1e6
  assert.equal(fmtRate(12_400_000), '12.4M/s'); // the mock down-rate
  assert.equal(fmtRate(1_120_000), '1.1M/s'); // the mock up-rate
  assert.equal(fmtRate(1_000_000_000), '1.0G/s'); // tips to G exactly at 1e9
  assert.equal(fmtRate(2_500_000_000), '2.5G/s');
});

test('degrades closed: a non-finite or negative rate is "0/s", never "NaN/s"', () => {
  assert.equal(fmtRate(-1), '0/s');
  assert.equal(fmtRate(NaN), '0/s');
  assert.equal(fmtRate(Infinity), '0/s');
  // CONTROL: a real positive rate is NOT swallowed by the guard.
  assert.equal(fmtRate(5_000_000), '5.0M/s');
});
