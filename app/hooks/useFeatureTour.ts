/**
 * Tour state, persisted on device. Logic lives in lib/tour.ts; this is storage
 * and the trigger.
 *
 * Fires once the phone has at least one box, never before — see lib/tour.ts for
 * why. On device only, like every other preference: no account, nothing sent.
 *
 * AN EXTERNAL STORE, not per-component state, and that is the whole point.
 * This used to load the key in a mount effect. The hook lives in the tabs
 * layout, which never unmounts, so the read happened exactly once per app
 * launch — and `resetFeatureTour` (called from Setup when the switch goes back
 * on) wrote to storage nobody would read again until a relaunch. The switch
 * looked dead: you turned it on, its own copy promised the tour would play
 * again, and nothing happened. Same module-level-store shape as lib/prefs.ts so
 * a write is observed live by whoever is rendering.
 */
import * as SecureStore from 'expo-secure-store';
import { useCallback, useSyncExternalStore } from 'react';
import { Platform } from 'react-native';

import { advanceTour, dismissTour, previousTour, shouldRun, TOUR_FINISHED, TOUR_NOT_STARTED, type TourState } from '@/lib/tour';

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

// ---------- external store ----------

type Snapshot = {
  state: TourState;
  /** False until the stored value has been read. */
  ready: boolean;
};

/** Starts FINISHED so a slow keychain read can never flash the overlay over the
 *  app before we know whether it was already dismissed. */
let snap: Snapshot = { state: TOUR_FINISHED, ready: false };
const listeners = new Set<() => void>();

function commit(next: Snapshot): void {
  // A NEW object every time: useSyncExternalStore compares by identity, and
  // mutating in place would leave subscribers showing the old step.
  snap = next;
  for (const l of listeners) l();
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

function getSnapshot(): Snapshot {
  return snap;
}

let loadStarted = false;
/** Read the persisted state once. Safe to call repeatedly. */
export async function loadFeatureTour(): Promise<void> {
  if (loadStarted) return;
  loadStarted = true;
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
  commit({ state: loaded, ready: true });
}
// Kick the read off at import, like lib/prefs.ts does.
void loadFeatureTour();

function save(s: TourState): void {
  // Memory first so the UI reacts on this frame; storage after.
  commit({ state: s, ready: true });
  void set(KEY, JSON.stringify(s));
}

/**
 * Forget that the tour ran, so it plays again.
 *
 * Turning the pref back on MUST do this. The pref only gates whether the tour
 * may run; "already finished" is separate state, so without this the switch is
 * dead once the tour has been seen — you can turn it off, and turning it back
 * on does nothing, forever. Found by trying exactly that on a device.
 *
 * Marks `ready` too: a reset is itself proof of what the state should be, so
 * the tour must not wait on a load that may already have finished.
 */
export async function resetFeatureTour(): Promise<void> {
  commit({ state: TOUR_NOT_STARTED, ready: true });
  await set(KEY, JSON.stringify(TOUR_NOT_STARTED));
}

export function useFeatureTour(paired: boolean, enabled: boolean) {
  const s = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  return {
    visible: s.ready && shouldRun(s.state, paired, enabled),
    state: s.state,
    next: useCallback(() => save(advanceTour(snap.state)), []),
    back: useCallback(() => save(previousTour(snap.state)), []),
    skip: useCallback(() => save(dismissTour()), []),
  };
}
