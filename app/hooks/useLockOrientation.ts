/**
 * Per-screen orientation lock. Every tab is portrait-only except the Pad tab,
 * which allows landscape so the on-screen controller can spread out like a
 * real gamepad.
 *
 * Usage: call `useLockOrientation('portrait')` in a portrait-only screen and
 * `useLockOrientation('allow-landscape')` in the Pad screen. The lock is
 * (re)applied every time the screen gains focus and is a no-op on web (where
 * orientation control is unsupported / undesirable).
 */
import * as ScreenOrientation from 'expo-screen-orientation';
import { useFocusEffect } from 'expo-router';
import { useCallback } from 'react';
import { Platform } from 'react-native';

export type OrientationPolicy = 'portrait' | 'allow-landscape';

export function useLockOrientation(policy: OrientationPolicy): void {
  useFocusEffect(
    useCallback(() => {
      if (Platform.OS === 'web') return undefined;

      let cancelled = false;
      const apply = async () => {
        try {
          if (policy === 'allow-landscape') {
            // DEFAULT policy = all orientations (minus upside-down on iOS),
            // so the device's own rotation drives the Pad layout.
            await ScreenOrientation.unlockAsync();
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
      // Ignore the returned promise but guard against a focus/blur race.
      void apply();

      return () => {
        cancelled = true;
        void cancelled;
      };
    }, [policy]),
  );
}
