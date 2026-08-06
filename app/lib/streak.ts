/**
 * "Days in a row you used Couchside" — the arithmetic only.
 *
 * ZERO runtime imports so the date handling, which is where a streak silently
 * goes wrong, is testable in bare Node. Nothing here touches storage, the
 * network, or the clock: the caller passes `now` in. That is deliberate — a
 * streak that reads the clock internally can only be tested by waiting a day.
 *
 * LOCAL DAYS, NOT UTC. A user in UTC-6 opening the app at 8pm is on today, not
 * tomorrow. Using toISOString() here would roll the streak over at 6pm for them
 * and read as the app losing their progress.
 *
 * NOTHING LEAVES THE PHONE. The streak lives in on-device prefs like every other
 * setting; there is no account, no server and no analytics behind it, and adding
 * one would break the promise the whole product is built on.
 */

/** Local calendar day as YYYY-MM-DD. Local, per the note above. */
export function dayKey(now: Date): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** Whole days from `a` to `b`, both YYYY-MM-DD. Negative if b is before a. */
export function daysBetween(a: string, b: string): number {
  // Parsed as UTC midnight on both sides, so DST cannot make a day 23 or 25
  // hours and round the wrong way — the strings are already local calendar days.
  const [ay, am, ad] = a.split('-').map(Number);
  const [by, bm, bd] = b.split('-').map(Number);
  const ms = Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad);
  return Math.round(ms / 86400000);
}

export type StreakState = {
  /** Consecutive days including today. 0 means "never used". */
  days: number;
  /** Last day counted, YYYY-MM-DD. Empty when never used. */
  lastDay: string;
  /** Highest milestone already celebrated, so it fires once and only once. */
  celebrated: number;
  /** Longest run ever reached, kept across breaks — a broken streak should not
   *  erase the fact that it happened. */
  best: number;
};

export const EMPTY_STREAK: StreakState = { days: 0, lastDay: '', celebrated: 0, best: 0 };

/**
 * Milestones worth interrupting someone for. Deliberately sparse: a popup every
 * single day is wallpaper by day four, and this app's promise is that it works
 * when the TV is black — it must not train people to dismiss it on sight.
 */
export const MILESTONES = [3, 7, 14, 30, 60, 100, 365] as const;

/**
 * Fold today into the streak. Pure; returns a NEW state.
 *
 * - same day        -> unchanged (opening the app twice is not two days)
 * - next day        -> +1
 * - a gap           -> back to 1, today counts as a fresh start
 * - clock went BACK -> unchanged. A user changing timezone or a device clock
 *                      correcting itself must never destroy a real streak, and
 *                      must never inflate one either.
 */
export function advance(prev: StreakState, now: Date): StreakState {
  const today = dayKey(now);
  if (!prev.lastDay) {
    return { days: 1, lastDay: today, celebrated: 0, best: Math.max(1, prev.best) };
  }
  const gap = daysBetween(prev.lastDay, today);
  if (gap === 0) return prev;
  if (gap < 0) return prev; // clock moved backwards — see the docstring
  const days = gap === 1 ? prev.days + 1 : 1;
  return {
    days,
    lastDay: today,
    // A broken streak clears the celebration ceiling so the milestones can be
    // earned again on the way back up.
    celebrated: gap === 1 ? prev.celebrated : 0,
    best: Math.max(prev.best, days),
  };
}

/**
 * The milestone to celebrate right now, or null. Returns the HIGHEST milestone
 * reached but not yet celebrated, so a user who jumps state (restore, clock
 * change) gets one popup rather than a queue of them.
 */
export function pendingMilestone(s: StreakState): number | null {
  let hit: number | null = null;
  for (const m of MILESTONES) {
    if (s.days >= m && m > s.celebrated) hit = m;
  }
  return hit;
}

/** Short label for the badge: "5 days", "1 day". */
export function streakLabel(days: number): string {
  return `${days} day${days === 1 ? '' : 's'}`;
}
