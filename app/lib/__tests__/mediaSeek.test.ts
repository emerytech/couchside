/**
 * Relative-seek arithmetic — lib/mediaSeek.ts.
 *
 * Run: from app/, `node --experimental-strip-types --test lib/__tests__/*.test.ts`
 * (Node >= 22.6). Picked up by the existing CI `app-input` job's glob.
 *
 * These exist because the web harness CANNOT test this. Its mock player
 * advances position by a flat 3000ms per GET and ignores seeks entirely
 * (agent `_MOCK_MPRIS_POS`), so pressing the button there proves a well-formed
 * request goes out and nothing about whether the offset was correct. Confirmed
 * the hard way: an early "verified +10s" reading was arithmetic against that
 * synthetic counter and meant nothing.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  MEDIA_HOLD_SKIP_SECS,
  MEDIA_SKIP_SECS,
  nextSeekPosition,
} from '../mediaSeek.ts';

const LEN = 214_000; // the mock track's length, and a realistic one

test('forward and back move by exactly the requested offset', () => {
  // Both directions of the same rule.
  assert.equal(
    nextSeekPosition({ currentMs: 60_000, deltaMs: 10_000, lengthMs: LEN }),
    70_000,
  );
  assert.equal(
    nextSeekPosition({ currentMs: 60_000, deltaMs: -10_000, lengthMs: LEN }),
    50_000,
  );
});

test('clamps to the start instead of going negative', () => {
  // The agent 400s a negative position_ms, so this must never emit one.
  assert.equal(nextSeekPosition({ currentMs: 3_000, deltaMs: -10_000, lengthMs: LEN }), 0);
  assert.equal(nextSeekPosition({ currentMs: 0, deltaMs: -30_000, lengthMs: LEN }), 0);
  // Control: comfortably inside the track is untouched.
  assert.equal(nextSeekPosition({ currentMs: 30_000, deltaMs: -10_000, lengthMs: LEN }), 20_000);
});

test('clamps to the track end when a length is known', () => {
  assert.equal(nextSeekPosition({ currentMs: LEN - 2_000, deltaMs: 30_000, lengthMs: LEN }), LEN);
  // Control: the same jump earlier in the track is not clamped.
  assert.equal(nextSeekPosition({ currentMs: 100_000, deltaMs: 30_000, lengthMs: LEN }), 130_000);
});

test('an unknown length (0) still allows a skip, bounded only at the start', () => {
  // Live streams and players that report no duration. The bar refuses these
  // because it needs a length to map a tap; a relative offset does not.
  assert.equal(nextSeekPosition({ currentMs: 40_000, deltaMs: 30_000, lengthMs: 0 }), 70_000);
  assert.equal(nextSeekPosition({ currentMs: 5_000, deltaMs: -30_000, lengthMs: 0 }), 0);
});

test('always returns an integer — the agent rejects a non-int position_ms', () => {
  // displayedMs is interpolated from Date.now() and a playback rate, so it is
  // routinely fractional. Route 400s on `int(req.get("position_ms"))` failing.
  for (const cur of [1234.5678, 0.1, 99_999.99]) {
    for (const d of [10_000, -10_000, 30_000]) {
      const v = nextSeekPosition({ currentMs: cur, deltaMs: d, lengthMs: LEN });
      assert.equal(Number.isInteger(v), true, `${cur}+${d} produced ${v}`);
      assert.equal(v >= 0, true);
    }
  }
});

test('every offered skip amount stays in range from anywhere in the track', () => {
  const amounts = [...MEDIA_SKIP_SECS, ...MEDIA_HOLD_SKIP_SECS];
  assert.ok(amounts.length >= 4, 'expected both option sets to be non-empty');
  for (const sec of amounts) {
    for (const cur of [0, 1_000, LEN / 2, LEN - 1_000, LEN]) {
      for (const sign of [1, -1]) {
        const v = nextSeekPosition({ currentMs: cur, deltaMs: sign * sec * 1000, lengthMs: LEN });
        assert.ok(v >= 0 && v <= LEN, `${sec}s from ${cur} gave ${v}, outside [0, ${LEN}]`);
      }
    }
  }
});

test('the offered amounts are distinct and ordered small-to-large', () => {
  // A hold that jumps the same distance as a tap is a pointless gesture; guard
  // the option tables so that stays true if someone edits them.
  assert.ok(Math.min(...MEDIA_HOLD_SKIP_SECS) >= Math.max(...MEDIA_SKIP_SECS));
  assert.equal(new Set(MEDIA_SKIP_SECS).size, MEDIA_SKIP_SECS.length);
  assert.equal(new Set(MEDIA_HOLD_SKIP_SECS).size, MEDIA_HOLD_SKIP_SECS.length);
});
