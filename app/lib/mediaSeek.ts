/**
 * Relative-seek arithmetic for the now-playing card, with ZERO runtime imports.
 *
 * Split out so it can be unit-tested on bare Node like lib/gamepad.ts and
 * lib/keepAwakeRules.ts (see the `app-input` CI job). That matters here more
 * than usual: the web harness CANNOT verify this. Its mock player advances
 * position by a fixed 3000ms per GET and ignores seeks entirely
 * (agent/couchsided.py `_MOCK_MPRIS_POS`), so the harness can only show that a
 * request fires with a well-formed body — never that the offset was right.
 * The arithmetic is therefore tested here or not at all.
 *
 * Keep this file import-free. Adding one breaks the standalone test job.
 */

/** Tap-to-skip amounts offered in Settings, in seconds. */
export const MEDIA_SKIP_SECS = [10, 30] as const;
export type MediaSkipSec = (typeof MEDIA_SKIP_SECS)[number];

/** Hold-to-skip amounts offered in Settings, in seconds. */
export const MEDIA_HOLD_SKIP_SECS = [30, 60] as const;
export type MediaHoldSkipSec = (typeof MEDIA_HOLD_SKIP_SECS)[number];

/**
 * Hold threshold. RN's default is 500ms — too eager here, where a slightly slow
 * tap should still mean the small skip, not a surprise long one.
 */
export const MEDIA_HOLD_MS = 1500;

/**
 * Where a relative skip should land.
 *
 * `lengthMs <= 0` means the player reports no duration (live streams, and some
 * browser players). That is NOT a reason to refuse: a relative offset does not
 * need a known length, unlike the scrub bar, which must map a tap fraction onto
 * one. In that case only the lower bound is enforced and the agent decides what
 * the player can actually do — it clamps to the real track length when it knows
 * one, and falls back to a relative MPRIS Seek when SetPosition is rejected.
 *
 * Returns an integer: the agent requires position_ms to be an int and 400s a
 * body that is not.
 */
export function nextSeekPosition(o: {
  currentMs: number;
  deltaMs: number;
  lengthMs: number;
}): number {
  let next = o.currentMs + o.deltaMs;
  if (o.lengthMs > 0) next = Math.min(next, o.lengthMs);
  return Math.max(0, Math.round(next));
}
