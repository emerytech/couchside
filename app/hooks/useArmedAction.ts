import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';

/** Default window a destructive action waits, cancellable, before it fires. */
export const ARMED_ACTION_SECS = 5;

export type Armed = { label: string; secs: number };

/**
 * A cancellable countdown before a destructive action fires. Confirm once
 * elsewhere, then `arm(label, onFire)`: a visible N-second window the caller
 * renders (see ArmedActionBar) with two ways out — Cancel aborts, "Do it now"
 * skips the wait. The request is not sent until the window elapses, so a box
 * switch, the app going to the background, or this hook unmounting all abort it
 * for free. A reboot must never fire from a phone the user put in their pocket.
 *
 * This began inline in app/(tabs)/actions.tsx (#429). It was lifted here so the
 * Decky screen's reboot and the System Updates card's reboot get the SAME window
 * instead of a one-shot Alert that fires the instant you tap through.
 *
 * `boxKey` is hostKey(settings): when it changes the arm is cancelled, so a
 * countdown can never fire on a box other than the one it was armed for.
 */
export function useArmedAction(boxKey: string) {
  const [armed, setArmed] = useState<Armed | null>(null);
  // The thunk to run when the current arm fires. Held in a ref, not state, so
  // nulling it is SYNCHRONOUS — that null is the whole double-fire guard below.
  const fireRef = useRef<(() => void) | null>(null);

  const cancel = useCallback(() => {
    fireRef.current = null;
    setArmed(null);
  }, []);

  const arm = useCallback(
    (label: string, onFire: () => void, secs: number = ARMED_ACTION_SECS) => {
      fireRef.current = onFire;
      setArmed({ label, secs });
    },
    [],
  );

  // Run the armed action exactly once. Nulling fireRef synchronously is the
  // guard: whichever of {timer expiry, "Do it now"} runs first consumes the
  // thunk and the other finds null. A doubled reboot POST is a real hazard —
  // api.request() never retries POSTs precisely for this reason.
  const fireNow = useCallback(() => {
    const run = fireRef.current;
    fireRef.current = null;
    setArmed(null);
    run?.();
  }, []);

  // Tick once a second; fire at zero. Depends on `armed` alone so a parent
  // re-render cannot re-arm mid-count (which would reset the current second).
  useEffect(() => {
    if (!armed) return;
    const id = setTimeout(() => {
      if (armed.secs <= 1) fireNow();
      else setArmed({ label: armed.label, secs: armed.secs - 1 });
    }, 1000);
    return () => clearTimeout(id);
  }, [armed, fireNow]);

  // Switching boxes aborts a pending arm — otherwise it would fire on whatever
  // box is now selected. (Also runs once on mount; nothing is armed then.)
  useEffect(() => {
    cancel();
  }, [boxKey, cancel]);

  // The app leaving the foreground aborts it (degrade closed). JS timers pause
  // in the background, so a countdown would otherwise resume and fire minutes
  // later when the user unlocks — a reboot from a pocketed phone. Cancelling is
  // the safe reading of "I walked away".
  useEffect(() => {
    const sub = AppState.addEventListener('change', (s) => {
      if (s !== 'active') cancel();
    });
    return () => sub.remove();
  }, [cancel]);

  return { armed, arm, cancel, fireNow };
}
