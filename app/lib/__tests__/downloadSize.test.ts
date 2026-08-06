/**
 * KI-056 — "0.0 / 0.0 GB" on a small download.
 *
 * Reported TWICE by the same tester. The agent was always truthful; the display
 * rounded any total under ~50 MB to "0.0", so a real download read as broken.
 * The fix shipped WITHOUT tests because these formatters lived in a screen file
 * the install-free glob cannot reach. They now live in lib/, and this is the
 * regression net.
 */
import { test } from 'node:test';
import assert from 'node:assert';

import { fmtGB, fmtPair, fmtTotal, MB_FLOOR } from '../downloadSize.ts';

test('THE REPORTED BUG: a small content patch no longer renders as 0.0 GB', () => {
  // 28 MB of 31 MB — the shape of the patch that was reported.
  const shown = fmtPair(28e6, 31e6);
  assert.equal(shown, '28 / 31 MB');
  assert.ok(!shown.includes('0.0'), `must never print 0.0 for a live download: ${shown}`);
});

test('CONTROL: the old formatter really did print 0.0 for that same input', () => {
  // Proves the test above is testing something. This is what the user saw.
  assert.equal(`${fmtGB(28e6)} / ${fmtGB(31e6)} GB`, '0.0 / 0.0 GB');
});

test('a queued small download shows MB too, not 0.0 GB', () => {
  assert.equal(fmtTotal(31e6), '31 MB');
  assert.equal(fmtTotal(1e6), '1 MB');
});

test('normal game-sized downloads still read in GB', () => {
  assert.equal(fmtPair(1.2e9, 42e9), '1.2 / 42.0 GB');
  assert.equal(fmtTotal(42e9), '42.0 GB');
});

test('the unit is chosen by the TOTAL, so a row never mixes units', () => {
  // Just above the floor: both halves must be GB even though the downloaded
  // part alone would round to 0.0.
  const shown = fmtPair(2e6, MB_FLOOR + 1);
  assert.ok(shown.endsWith('GB'), shown);
  assert.ok(!shown.includes('MB'), `one unit per row: ${shown}`);
});

test('the floor boundary is exact and does not straddle', () => {
  assert.ok(fmtTotal(MB_FLOOR - 1).endsWith('MB'));
  assert.ok(fmtTotal(MB_FLOOR).endsWith('GB'));
});

test('a genuinely empty download is not dressed up as progress', () => {
  // The agent sends 0 when it knows nothing; the app must not invent a size.
  assert.equal(fmtPair(0, 0), '0 / 0 MB');
  assert.equal(fmtTotal(0), '0 MB');
});
