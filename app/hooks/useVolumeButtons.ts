/**
 * Repurpose the phone's hardware volume buttons (Vol +/-) into box/TV volume
 * steps while the Remote screen owns them.
 *
 * The mechanism is deliberately the same on both platforms: sit on a mid-range
 * baseline system volume, listen for the OS volume changing under a physical
 * press, derive the direction from the delta, fire the matching callback, then
 * snap the system volume back to the baseline so there is always headroom in
 * both directions (a phone pinned at 0% or 100% would swallow further presses).
 *
 *   Android — `showNativeVolumeUI(false)` hides the system volume HUD, so the
 *     hijack is invisible; the OS still moves the music stream, which the
 *     baseline reset absorbs. Primary, review-safe target.
 *   iOS — no public key-intercept API, so this observes AVAudioSession's
 *     outputVolume (the library's KVO listener) and needs an active audio
 *     session + the app foregrounded. The volume HUD still flashes (can't be
 *     suppressed) and locked-screen / Control-Center presses won't route here.
 *     Experimental, and off by default (App Review risk — see the setting).
 *
 * `enabled` gates the whole thing: pass it the AND of the user setting and a
 * live box connection. Flipping it off (screen blur, disconnect, unmount)
 * tears the listener down and restores normal system-volume behavior.
 */
import { useEffect, useRef } from 'react';
import { Platform } from 'react-native';
import { VolumeManager } from 'react-native-volume-manager';

/** Mid-range resting volume: every press has room to move up OR down from here. */
const BASELINE = 0.5;
/**
 * Deltas smaller than this are our own baseline write echoing back (or float
 * noise), not a press. One hardware step is ~1/15 (Android) or 1/16 (iOS) of
 * the range — comfortably above this.
 */
const EPSILON = 0.012;
/** Min gap between emitted commands, so a held button paces (~7/s) not floods. */
const MIN_STEP_MS = 140;

export function useVolumeButtons({
  enabled,
  onUp,
  onDown,
}: {
  enabled: boolean;
  onUp: () => void;
  onDown: () => void;
}): void {
  // Keep the callbacks current WITHOUT re-subscribing the native listener on
  // every render (the effect keys only on `enabled`).
  const cbs = useRef({ onUp, onDown });
  cbs.current = { onUp, onDown };

  useEffect(() => {
    // Web has no hardware volume buttons and no native module — never touch it.
    if (!enabled || Platform.OS === 'web') return undefined;

    let cancelled = false;
    let sub: { remove: () => void } | null = null;
    let lastEmit = 0;
    // True while our own setVolume(BASELINE) is in flight, so its listener echo
    // is ignored even before the EPSILON test would catch it.
    let resetting = false;

    const recenter = () => {
      resetting = true;
      VolumeManager.setVolume(BASELINE, { showUI: false })
        .catch(() => {})
        .finally(() => {
          resetting = false;
        });
    };

    const setup = async () => {
      try {
        if (Platform.OS === 'ios') {
          // outputVolume KVO only reports while a session is active; ambient
          // category mixes with (never ducks or interrupts) other audio.
          await VolumeManager.enable(true);
          await VolumeManager.setActive(true);
        } else {
          await VolumeManager.showNativeVolumeUI({ enabled: false });
        }
        await VolumeManager.setVolume(BASELINE, { showUI: false });
        if (cancelled) return;

        sub = VolumeManager.addVolumeListener(({ volume }) => {
          if (resetting) return; // our own recenter write
          const delta = volume - BASELINE;
          if (Math.abs(delta) < EPSILON) return; // noise / already centered
          const now = Date.now();
          if (now - lastEmit >= MIN_STEP_MS) {
            lastEmit = now;
            if (delta > 0) cbs.current.onUp();
            else cbs.current.onDown();
          }
          // Recenter even when throttled, so volume never creeps to a dead zone.
          recenter();
        });
      } catch {
        // Native module absent (not-yet-prebuilt / Expo Go) or a platform
        // quirk: fail silent and leave the phone's volume buttons alone.
      }
    };
    void setup();

    return () => {
      cancelled = true;
      if (sub) sub.remove();
      // Hand the buttons back to the OS.
      if (Platform.OS === 'ios') {
        VolumeManager.setActive(false).catch(() => {});
      } else {
        VolumeManager.showNativeVolumeUI({ enabled: true }).catch(() => {});
      }
    };
  }, [enabled]);
}
