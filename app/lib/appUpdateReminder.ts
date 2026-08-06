/**
 * Timing for the "check for an app update" reminder toast.
 *
 * The update CHECK is manual (a button in Setup > Account). This is only the
 * gentle nudge that the button exists — shown at most once every REMIND_DAYS,
 * and only while the `appUpdateReminder` pref is on. The toast itself offers a
 * "Don't show again" that flips that pref off, so this timing is the secondary
 * gate: even with the pref on, it fires rarely.
 *
 * The pref (on/off) lives in prefs.ts; the "last shown" timestamp lives here in
 * the same key-value store the trial nudges use.
 */
import { storageGet, storageSet } from './entitlement';

const LAST_SHOWN_KEY = 'couchside.appUpdateReminder.lastShown.v1';
/** Don't nudge more than once every few days. */
export const REMIND_DAYS = 4;
const REMIND_MS = REMIND_DAYS * 24 * 60 * 60 * 1000;

/**
 * True when enough time has passed since the last nudge (or it has never
 * shown). On an unreadable clock we return FALSE — a nudge is a nicety, and a
 * broken store should never turn it into a nag on every launch.
 */
export async function reminderDue(now: number): Promise<boolean> {
  try {
    const raw = await storageGet(LAST_SHOWN_KEY);
    // NO STAMP = FIRST EVER LAUNCH. Start the clock instead of nudging: telling
    // somebody to "check for an app update now and then" seconds after they
    // installed the newest version is noise at the worst possible moment, and
    // it lands on the setup screen a brand-new user is already trying to read.
    // Seen on a genuinely clean simulator install.
    if (!raw) {
      await markReminderShown(now);
      return false;
    }
    const last = parseInt(raw, 10);
    // An unparseable stamp is treated the same way — restart the clock rather
    // than nag, since we cannot tell how long it has been.
    if (!Number.isFinite(last)) {
      await markReminderShown(now);
      return false;
    }
    return now - last >= REMIND_MS;
  } catch {
    return false;
  }
}

export async function markReminderShown(now: number): Promise<void> {
  try {
    await storageSet(LAST_SHOWN_KEY, String(now));
  } catch {
    // best effort — worst case it nudges again next window
  }
}
