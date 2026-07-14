import { useEffect } from 'react';
import { Platform } from 'react-native';

import { subscribeUnlocked } from '@/lib/EntitlementContext';
import {
  emitReviewInvite,
  hasAskedForReview,
  markReviewAsked,
  subscribeReviewEarned,
} from '@/lib/review';

/**
 * Decides IF and HOW to ask for a review. Asks at most once, ever.
 *
 * Two earned moments trigger it:
 *   - the unlock — the happiest moment in the app's life (the user just paid
 *     and everything works), and
 *   - the app simply having done its job: EARNED_SESSIONS launches in which a
 *     paired box was reachable (see lib/review.ts). This is what lets a trial
 *     user who loves the app be asked too; before, only purchasers ever were.
 *
 * How: the native OS sheet, which is app-triggered and never wired to a button
 * (that is Apple's rule, and the reason there is no "Rate" button that calls
 * it). The OS keeps its own quota on top (~3×/year, and never in TestFlight),
 * so this is a polite request, not a guarantee.
 *
 * If the sheet cannot run — no `hasAction()`, web, a build without the native
 * module — we fall back to ReviewToast, which links OUT to the store's
 * write-review page instead. Both paths share ONE asked-flag, so a user is
 * never hit by both, and whichever fires first retires the other forever.
 *
 * Mounted at the root layout next to UnlockToast for the same reason it is:
 * the unlock signal fires the instant the Paywall unmounts, so anything living
 * inside the Paywall would die before it could act.
 */
const REVIEW_DELAY_MS = 4000;

export function ReviewPrompt() {
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    // In-memory guard: both triggers can fire in one launch (buy the unlock on
    // your third good session). Only ever queue one ask.
    let queued = false;

    const ask = () => {
      if (queued) return;
      queued = true;
      timer = setTimeout(() => {
        void (async () => {
          // Re-check at fire time, not at schedule time.
          if (await hasAskedForReview()) return;

          if (Platform.OS !== 'web') {
            try {
              // Lazy require, NOT a top-level import: expo-store-review is a
              // native module, and a top-level import crashes the entire app
              // at bundle-eval time on any binary built without it (dev
              // builds, web). Resolve it only at the moment of use.
              // eslint-disable-next-line @typescript-eslint/no-require-imports
              const StoreReview = require('expo-store-review') as typeof import('expo-store-review');
              if (await StoreReview.hasAction()) {
                // Mark BEFORE requesting: if the OS shows the sheet and the
                // app is killed mid-flow, better to never ask again than to
                // double-ask.
                await markReviewAsked();
                await StoreReview.requestReview();
                return;
              }
            } catch {
              // fall through to the toast
            }
          }

          // No native sheet here: invite via the toast, which links out to the
          // store rather than summoning the sheet from a tap.
          await markReviewAsked();
          emitReviewInvite();
        })();
      }, REVIEW_DELAY_MS);
    };

    const unsubUnlock = subscribeUnlocked(ask);
    const unsubEarned = subscribeReviewEarned(ask);

    return () => {
      unsubUnlock();
      unsubEarned();
      if (timer) clearTimeout(timer);
    };
  }, []);

  return null;
}
