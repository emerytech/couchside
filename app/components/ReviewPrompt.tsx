import { useEffect } from 'react';
import { Platform } from 'react-native';
import * as SecureStore from 'expo-secure-store';

import { subscribeUnlocked } from '@/lib/EntitlementContext';

/**
 * One-shot in-app review request, fired off the unlock signal — the happiest
 * moment in the app's life (the user just paid and everything works). Waits a
 * few seconds so it never collides with the UnlockToast, asks the OS review
 * controller once, and never asks again (persisted flag). The OS keeps its own
 * quota on top (Apple shows the sheet at most ~3×/year and only outside
 * TestFlight), so this is a polite request, not a guarantee — which is exactly
 * the App Store rule.
 *
 * Mounted at the root layout next to UnlockToast for the same reason it is:
 * the unlock signal fires the instant the Paywall unmounts, so anything living
 * inside the Paywall would die before it could act.
 */
const ASKED_KEY = 'couchside.reviewAsked.v1';
const REVIEW_DELAY_MS = 4000;

export function ReviewPrompt() {
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const unsub = subscribeUnlocked(() => {
      timer = setTimeout(() => {
        void (async () => {
          try {
            if (Platform.OS === 'web') return;
            if ((await SecureStore.getItemAsync(ASKED_KEY)) === '1') return;
            // Lazy require, NOT a top-level import: expo-store-review is a
            // native module, and a top-level import crashes the entire app at
            // bundle-eval time on any binary built without it (dev builds,
            // web). Review is best-effort — resolve it only at the moment of
            // use, inside the try.
            // eslint-disable-next-line @typescript-eslint/no-require-imports
            const StoreReview = require('expo-store-review') as typeof import('expo-store-review');
            if (!(await StoreReview.hasAction())) return;
            // Mark BEFORE requesting: if the OS shows the sheet and the app is
            // killed mid-flow, better to never ask again than to double-ask.
            await SecureStore.setItemAsync(ASKED_KEY, '1');
            await StoreReview.requestReview();
          } catch {
            // Review is best-effort by definition; never surface a failure.
          }
        })();
      }, REVIEW_DELAY_MS);
    });
    return () => {
      unsub();
      if (timer) clearTimeout(timer);
    };
  }, []);

  return null;
}
