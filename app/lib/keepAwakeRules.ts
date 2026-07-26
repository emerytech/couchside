/**
 * Wake-lock arbitration for the Pad, with ZERO runtime imports.
 *
 * Split out of keepAwake.ts so it can be unit-tested on bare Node the same way
 * lib/gamepad.ts is (see .github/workflows/ci.yml, job `app-input`): keepAwake.ts
 * itself pulls in expo-secure-store and react-native, neither of which resolves
 * without a bundler. The decision is the part worth testing — "is the lock held
 * right now" is exactly where a battery bug or a screen that sleeps mid-game
 * would live — so it lives here and keepAwake.ts re-exports it.
 *
 * Keep this file import-free. Adding one breaks the standalone test job.
 */

/** Selectable inactivity timeouts, in minutes. 0 = never release the lock. */
export const KEEP_AWAKE_TIMEOUTS = [0, 5, 10, 30, 60] as const;
export type KeepAwakeTimeoutMin = (typeof KEEP_AWAKE_TIMEOUTS)[number];

/**
 * Default for everyone, including users upgrading from the flag-only build.
 *
 * 30 minutes is chosen so it cannot fire mid-session — the timer resets on
 * every input frame — while still capping a phone left face-up on the couch.
 * Upgraders have no stored value, so they land here rather than on the old
 * unbounded behavior; that is a deliberate behavior change, not an oversight.
 */
export const KEEP_AWAKE_TIMEOUT_DEFAULT: KeepAwakeTimeoutMin = 30;

/** Is `n` one of the offered timeouts? Anything else is rejected, not clamped. */
export function isKeepAwakeTimeout(n: number): n is KeepAwakeTimeoutMin {
  return (KEEP_AWAKE_TIMEOUTS as readonly number[]).includes(n);
}

/**
 * Should the wake lock be held right now?
 *
 * Deliberately returns false when the Pad is not focused. Releasing on blur is
 * the caller's job too, but encoding it here means a missed blur event cannot
 * strand a lock held forever — the worst outcome for a battery setting.
 */
export function shouldHoldWakeLock(o: {
  enabled: boolean;
  timeoutMin: number;
  focused: boolean;
  msSinceActivity: number;
}): boolean {
  if (!o.enabled || !o.focused) return false;
  if (o.timeoutMin <= 0) return true; // "Always"
  return o.msSinceActivity < o.timeoutMin * 60_000;
}
