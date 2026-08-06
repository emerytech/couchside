/**
 * Tour state, persisted on device. Logic lives in lib/tour.ts; this is storage
 * and the trigger.
 *
 * Fires once the phone has at least one box, never before — see lib/tour.ts for
 * why. On device only, like every other preference: no account, nothing sent.
 */
import * as SecureStore from 'expo-secure-store';
import { useCallback, useEffect, useState } from 'react';
import { Platform } from 'react-native';

import { advanceTour, dismissTour, shouldRun, TOUR_FINISHED, TOUR_NOT_STARTED, type TourState } from '@/lib/tour';

const KEY = 'couchside.tour.v1';

async function get(k: string): Promise<string | null> {
  if (Platform.OS === 'web') {
    try {
      return typeof window !== 'undefined' && window.localStorage ? window.localStorage.getItem(k) : null;
    } catch {
      return null;
    }
  }
  return SecureStore.getItemAsync(k);
}

async function set(k: string, v: string): Promise<void> {
  if (Platform.OS === 'web') {
    try {
      if (typeof window !== 'undefined' && window.localStorage) window.localStorage.setItem(k, v);
    } catch {
      // storage unavailable: the tour simply reappears next launch
    }
    return;
  }
  await SecureStore.setItemAsync(k, v);
}

export function useFeatureTour(paired: boolean, enabled: boolean) {
  const [state, setState] = useState<TourState>(TOUR_FINISHED); // assume done until proven otherwise
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let alive = true;
    void (async () => {
      let loaded = TOUR_NOT_STARTED;
      try {
        const raw = await get(KEY);
        if (raw) {
          const o = JSON.parse(raw) as Partial<TourState>;
          loaded = {
            step: Number.isFinite(o.step) ? Math.max(0, Math.floor(o.step as number)) : 0,
            done: o.done === true,
          };
        }
      } catch {
        loaded = TOUR_NOT_STARTED;
      }
      if (!alive) return;
      setState(loaded);
      setReady(true);
    })();
    return () => {
      alive = false;
    };
  }, []);

  const save = useCallback((s: TourState) => {
    setState(s);
    void set(KEY, JSON.stringify(s));
  }, []);

  return {
    // Starting from FINISHED means a slow keychain read can never flash the
    // overlay over the app before we know whether it was already dismissed.
    visible: ready && shouldRun(state, paired, enabled),
    state,
    next: useCallback(() => save(advanceTour(state)), [save, state]),
    skip: useCallback(() => save(dismissTour()), [save]),
  };
}
