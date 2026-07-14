/**
 * Trial nudges: the ramp that stops day 7 being a cliff.
 *
 * Today the app runs a silent 7-day countdown and then, with no warning,
 * replaces five of six tabs with a paywall. This softens that: a dismissible
 * banner when the trial is nearly out, and a toast on the final day, so the
 * wall is never a surprise.
 *
 * Rules, deliberately gentle:
 *   - Nothing at all until the trial has NUDGE_DAYS (3) or fewer left.
 *   - Each threshold shows AT MOST ONCE, ever, and stays dismissed (persisted).
 *     Crossing into the next threshold is a new, separate nudge.
 *   - Dismissing is permanent for that threshold. No re-nagging on every launch.
 *   - Purchasing retires all of it (the banner keys off `state === 'trial'`).
 */
import { storageGet, storageSet } from './entitlement';

/** Days-left thresholds that earn a nudge, high to low. */
export const NUDGE_THRESHOLDS = [3, 1] as const;
export type NudgeThreshold = (typeof NUDGE_THRESHOLDS)[number];

const DISMISSED_KEY = (t: number) => `couchside.trialNudge.v1.${t}`;
const LAST_DAY_TOAST_KEY = 'couchside.trialLastDayToast.v1';

/**
 * The threshold a given days-left falls into, or null when the trial still has
 * room. 2 days left is still the "3" nudge — it does not re-fire — but 1 day
 * left crosses into its own.
 */
export function thresholdFor(daysLeft: number): NudgeThreshold | null {
  for (const t of [...NUDGE_THRESHOLDS].sort((a, b) => a - b)) {
    if (daysLeft <= t) return t;
  }
  return null;
}

export async function isNudgeDismissed(t: NudgeThreshold): Promise<boolean> {
  try {
    return (await storageGet(DISMISSED_KEY(t))) === '1';
  } catch {
    // Unreadable flag: assume dismissed rather than risk nagging every launch.
    return true;
  }
}

/**
 * Every mounted tab renders its own TrialNudge, each holding its own state, so
 * a dismissal has to be broadcast: without this, dismissing on Console leaves
 * the already-mounted Actions instance still showing the banner when you
 * switch back to it — the flag is persisted, but the live component never
 * re-read it.
 */
type DismissListener = () => void;
const dismissListeners = new Set<DismissListener>();

export function subscribeNudgeDismissed(fn: DismissListener): () => void {
  dismissListeners.add(fn);
  return () => dismissListeners.delete(fn);
}

export async function dismissNudge(t: NudgeThreshold): Promise<void> {
  try {
    await storageSet(DISMISSED_KEY(t), '1');
  } catch {
    // best effort
  }
  dismissListeners.forEach((l) => l());
}

/** The final-day toast is one-shot for the life of the install. */
export async function lastDayToastShown(): Promise<boolean> {
  try {
    return (await storageGet(LAST_DAY_TOAST_KEY)) === '1';
  } catch {
    return true;
  }
}

export async function markLastDayToastShown(): Promise<void> {
  try {
    await storageSet(LAST_DAY_TOAST_KEY, '1');
  } catch {
    // best effort
  }
}

/** Copy for the banner, by threshold. */
export function nudgeCopy(daysLeft: number): { title: string; sub: string } {
  if (daysLeft <= 1) {
    return {
      title: 'Trial ends today',
      sub: 'Unlock Couchside to keep the console, pad, and launcher.',
    };
  }
  return {
    title: `${daysLeft} days left in your trial`,
    sub: 'One-time unlock · no subscription, no account.',
  };
}
