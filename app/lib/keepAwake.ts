/**
 * "Keep the screen awake on the Pad" preference, as a single persisted flag.
 *
 * The Pad holds the phone awake while it's focused so a controller session
 * doesn't dim out mid-game. Some users only tap in for one button and would
 * rather save the battery, so this gates that behavior. Same external-store
 * shape as haptics.ts: a `<Switch>` reads/writes it and re-renders live via
 * useKeepAwakeEnabled(); the Pad reads it with getKeepAwakeEnabled().
 */
import * as SecureStore from 'expo-secure-store';
import { useSyncExternalStore } from 'react';
import { Platform } from 'react-native';

const KEY = 'couchside.keepAwake.v1';

// ---------- persistence (SecureStore native / localStorage web) ----------

async function storageGet(key: string): Promise<string | null> {
  if (Platform.OS === 'web') {
    try {
      return typeof window !== 'undefined' && window.localStorage
        ? window.localStorage.getItem(key)
        : null;
    } catch {
      return null;
    }
  }
  return SecureStore.getItemAsync(key);
}

async function storageSet(key: string, value: string): Promise<void> {
  if (Platform.OS === 'web') {
    try {
      if (typeof window !== 'undefined' && window.localStorage) {
        window.localStorage.setItem(key, value);
      }
    } catch {
      // storage unavailable (private mode): pref lives in memory this session
    }
    return;
  }
  await SecureStore.setItemAsync(key, value);
}

// ---------- external store ----------

let enabled = true; // default ON: keep the screen awake on the Pad
const listeners = new Set<() => void>();

function emitChange(): void {
  for (const l of listeners) l();
}

let loadStarted = false;
/** Load the persisted preference once. Safe to call repeatedly. */
export async function loadKeepAwakePref(): Promise<void> {
  if (loadStarted) return;
  loadStarted = true;
  const v = await storageGet(KEY);
  if (v === '0' && enabled) {
    enabled = false;
    emitChange();
  }
}
// Kick the load off at import so the pref is ready by the time the Pad mounts.
void loadKeepAwakePref();

export function getKeepAwakeEnabled(): boolean {
  return enabled;
}

export async function setKeepAwakeEnabled(next: boolean): Promise<void> {
  if (next === enabled) return;
  enabled = next;
  emitChange();
  await storageSet(KEY, next ? '1' : '0');
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

/** React hook: live boolean of the keep-awake preference (for the Settings switch). */
export function useKeepAwakeEnabled(): boolean {
  return useSyncExternalStore(subscribe, getKeepAwakeEnabled, getKeepAwakeEnabled);
}
