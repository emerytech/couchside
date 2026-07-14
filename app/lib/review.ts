/**
 * Store-review plumbing. The "have we already asked?" rule lives here, in ONE
 * place, because there are two ways a review gets requested and a user must
 * never be hit by both:
 *
 *   1. The native OS sheet (`StoreReview.requestReview`). App-triggered, on an
 *      earned moment. Best conversion, and it must NEVER be wired to a button:
 *      Apple's rule is that the sheet is requested by the app, not summoned by
 *      a tap. (components/ReviewPrompt.tsx)
 *   2. A dismissible in-app toast that links OUT to the App Store write-review
 *      page. This is the fallback for when the native sheet isn't available
 *      (no `hasAction()`, web, unsupported build). (components/ReviewToast.tsx)
 *
 * Both share ASKED_KEY, so whichever fires first retires the other forever.
 *
 * The "Rate Couchside" row in Setup > Account is deliberately OUTSIDE this
 * machinery: it is user-initiated, always available, unflagged, and it links
 * out to the store — it never calls requestReview(). That is what keeps it
 * legal.
 *
 * "Earned moment" = the app actually did its job. We count launches in which a
 * paired box was reachable (at most one per launch); at EARNED_SESSIONS we
 * consider the app to have proven itself. Buying the unlock is also an earned
 * moment, and a happier one — that signal comes from EntitlementContext.
 */
import { Linking, Platform } from 'react-native';

import { storageGet, storageSet } from './entitlement';

/** Shared with the pre-existing ReviewPrompt flag: users already asked stay asked. */
const ASKED_KEY = 'couchside.reviewAsked.v1';
const GOOD_SESSIONS_KEY = 'couchside.goodSessions.v1';

/** Launches-with-a-reachable-box before we consider a review earned. */
export const EARNED_SESSIONS = 3;

const IOS_APP_ID = '6786884115';
const ANDROID_PACKAGE = 'com.ets3d.rescueremote';

/** True once either the native sheet or the toast has asked. Never ask twice. */
export async function hasAskedForReview(): Promise<boolean> {
  try {
    return (await storageGet(ASKED_KEY)) === '1';
  } catch {
    // An unreadable flag must not turn into a nag loop: assume we asked.
    return true;
  }
}

export async function markReviewAsked(): Promise<void> {
  try {
    await storageSet(ASKED_KEY, '1');
  } catch {
    // Best effort. Worst case the user sees one extra invite, never a loop
    // within a launch (the in-memory guard below covers that).
  }
}

/**
 * Open the store's own write-review page. This is the ONLY thing a tap is
 * allowed to do — see the header note about requestReview().
 */
export async function openWriteReview(): Promise<void> {
  const url =
    Platform.OS === 'ios'
      ? `itms-apps://apps.apple.com/app/id${IOS_APP_ID}?action=write-review`
      : `market://details?id=${ANDROID_PACKAGE}`;
  const web =
    Platform.OS === 'ios'
      ? `https://apps.apple.com/app/id${IOS_APP_ID}?action=write-review`
      : `https://play.google.com/store/apps/details?id=${ANDROID_PACKAGE}`;
  try {
    if (await Linking.canOpenURL(url)) {
      await Linking.openURL(url);
      return;
    }
  } catch {
    // fall through to the https form, which always resolves to something
  }
  try {
    await Linking.openURL(web);
  } catch {
    // Nothing sensible left to do; never crash over a review link.
  }
}

// ---------------------------------------------------------------------------
// Earned-moment signal
// ---------------------------------------------------------------------------

type Listener = () => void;
const listeners = new Set<Listener>();

/** Guards against counting the same launch twice (polls fire repeatedly). */
let notedThisLaunch = false;

/**
 * Subscribe to "the app has proven itself" — fired once, when the good-session
 * count crosses EARNED_SESSIONS. Returns an unsubscribe.
 */
export function subscribeReviewEarned(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

// ---------------------------------------------------------------------------
// Fallback-invite signal (native sheet unavailable -> show the toast instead)
// ---------------------------------------------------------------------------

const inviteListeners = new Set<Listener>();

/** ReviewToast subscribes; ReviewPrompt emits when the OS sheet can't run. */
export function subscribeReviewInvite(fn: Listener): () => void {
  inviteListeners.add(fn);
  return () => inviteListeners.delete(fn);
}

export function emitReviewInvite(): void {
  inviteListeners.forEach((l) => l());
}

/**
 * Call when a paired box is confirmed reachable. Counts at most once per app
 * launch; emits the earned signal the moment the threshold is crossed.
 */
export async function noteBoxReachable(): Promise<void> {
  if (notedThisLaunch) return;
  notedThisLaunch = true;
  if (await hasAskedForReview()) return;
  let n = 0;
  try {
    n = Number(await storageGet(GOOD_SESSIONS_KEY)) || 0;
  } catch {
    return;
  }
  n += 1;
  await storageSet(GOOD_SESSIONS_KEY, String(n)).catch(() => {});
  if (n >= EARNED_SESSIONS) listeners.forEach((l) => l());
}
