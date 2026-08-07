/**
 * Per-screen orientation lock. Every tab is portrait-only except the Pad tab,
 * which allows landscape so the on-screen controller can spread out like a real
 * gamepad — and can PIN itself there while someone is playing.
 *
 * Usage: call `useLockOrientation('portrait')` in a portrait-only screen. The
 * policy is (re)applied every time the screen gains focus and is a no-op on web
 * (where orientation control is unsupported / undesirable).
 *
 * `app.json` sets `"orientation": "default"`, so nothing is locked natively and
 * these calls are the only thing deciding what rotates. Every screen in the app
 * states a policy — there is a test in lib/__tests__/onboarding.test.ts that
 * fails if one forgets — which is what makes releasing the lock on blur safe.
 */
import * as ScreenOrientation from 'expo-screen-orientation';
import { useFocusEffect } from 'expo-router';
import { useCallback } from 'react';
import { Platform } from 'react-native';

export type OrientationPolicy =
  /** Portrait only. */
  | 'portrait'
  /** Let the device decide — the Pad's gamepad mode follows the phone. */
  | 'allow-landscape'
  /** Pinned sideways: the user asked for it with the LOCK button. */
  | 'landscape-locked'
  /** Pinned upright — movement mode's LOCK while held vertically. */
  | 'portrait-locked';

export function useLockOrientation(policy: OrientationPolicy): void {
  useFocusEffect(
    useCallback(() => {
      if (Platform.OS === 'web') return undefined;

      const apply = async () => {
        try {
          if (policy === 'allow-landscape') {
            // DEFAULT policy = all orientations (minus upside-down on iOS),
            // so the device's own rotation drives the Pad layout.
            await ScreenOrientation.unlockAsync();
          } else if (policy === 'portrait-locked') {
            // The mirror of landscape-locked, for the vertical movement
            // layout. PORTRAIT_UP (not PORTRAIT): upside-down portrait is
            // nothing anyone locks into on purpose, and iOS refuses it anyway.
            await ScreenOrientation.lockAsync(
              ScreenOrientation.OrientationLock.PORTRAIT_UP,
            );
          } else if (policy === 'landscape-locked') {
            // LANDSCAPE, not LANDSCAPE_LEFT: both directions stay legal, so the
            // lock never fights the user's grip or which side they turned the
            // phone. Pinning one direction would flip the notch to the other
            // edge for half of them.
            await ScreenOrientation.lockAsync(
              ScreenOrientation.OrientationLock.LANDSCAPE,
            );
          } else {
            await ScreenOrientation.lockAsync(
              ScreenOrientation.OrientationLock.PORTRAIT_UP,
            );
          }
        } catch {
          // Orientation control can be unavailable (simulator, split view);
          // failing to lock is non-fatal.
        }
      };
      void apply();

      return () => {
        // RELEASE THE LOCK ON BLUR. This used to set a `cancelled` flag that
        // nothing read, which was the same as no cleanup at all — and with the
        // 'landscape-locked' policy added, no cleanup means leaving the Pad tab
        // while pinned would pin the ENTIRE APP sideways, with the Console,
        // Launch and Setup screens rendered into a shape none of them has a
        // layout for. The next screen to focus applies its own policy
        // immediately; every screen has one.
        if (policy === 'portrait') return;
        void ScreenOrientation.unlockAsync().catch(() => {});
      };
    }, [policy]),
  );
}
