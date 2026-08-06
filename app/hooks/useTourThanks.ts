/**
 * The one-time thank-you shown after someone WALKS the whole feature tour.
 *
 * Same module-level external-store shape as lib/prefs.ts and useFeatureTour —
 * it is written from the tabs layout and read by a component mounted alongside
 * it, so a per-hook useState would have the same "the write is invisible"
 * problem the tour state itself had.
 *
 * SHOWN ONCE, EVER, and only on a genuine finish. Pressing "Skip tour" is
 * someone asking to be left alone; answering that with a note about buying is
 * the exact move that makes an app feel like it wants something from you. The
 * caller decides — see lib/tour.ts isFinalStep — and this module only remembers
 * whether it has already happened.
 */
import * as SecureStore from 'expo-secure-store';
import { useCallback, useSyncExternalStore } from 'react';
import { Platform } from 'react-native';

const KEY = 'couchside.tour.thanks.v1';

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
      // storage unavailable: it may appear once more next launch, never worse
    }
    return;
  }
  await SecureStore.setItemAsync(k, v);
}

type Snapshot = {
  /** True while the note should be on screen. */
  visible: boolean;
  /** True once it has been shown and dismissed, ever. */
  done: boolean;
  /** False until storage has been read — never show before we know. */
  ready: boolean;
};

let snap: Snapshot = { visible: false, done: true, ready: false };
const listeners = new Set<() => void>();

function commit(next: Snapshot): void {
  snap = next;
  for (const l of listeners) l();
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

const getSnapshot = () => snap;

let loadStarted = false;
export async function loadTourThanks(): Promise<void> {
  if (loadStarted) return;
  loadStarted = true;
  let done = false;
  try {
    done = (await get(KEY)) === '1';
  } catch {
    done = false;
  }
  commit({ visible: false, done, ready: true });
}
void loadTourThanks();

/** Called when the tour is FINISHED (not skipped). No-op if already shown. */
export function showTourThanks(): void {
  if (!snap.ready || snap.done || snap.visible) return;
  commit({ ...snap, visible: true });
}

/** Dismiss and never show again. */
export function dismissTourThanks(): void {
  commit({ visible: false, done: true, ready: true });
  void set(KEY, '1');
}

export function useTourThanks(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot).visible;
}

/** Test/debug helper: forget that it was shown, so it can appear again. Paired
 *  with the feature-tour reset, since replaying the tour should be able to end
 *  the same way it did the first time. */
export async function resetTourThanks(): Promise<void> {
  commit({ visible: false, done: false, ready: true });
  await set(KEY, '0');
}
