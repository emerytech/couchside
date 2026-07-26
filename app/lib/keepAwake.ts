/**
 * "Keep the screen awake on the Pad" preference: an on/off flag plus an
 * inactivity timeout.
 *
 * The Pad holds the phone awake while it's focused so a controller session
 * doesn't dim out mid-game. Some users only tap in for one button and would
 * rather save the battery, so this gates that behavior. Same external-store
 * shape as haptics.ts: a `<Switch>` reads/writes it and re-renders live via
 * useKeepAwakeEnabled(); the Pad reads it with getKeepAwakeEnabled().
 *
 * WHY A TIMEOUT EXISTS: the flag alone is all-or-nothing, and the expensive
 * case is not an active session — it is a phone left sitting on the Pad tab,
 * screen lit, for hours. So the timeout is an INACTIVITY timer, not a session
 * cap: it only counts down while no input is being sent, and any input resets
 * it. During real use it never fires, which is why a non-zero default is safe.
 * 0 means "never release", the historical behavior.
 */
import * as SecureStore from 'expo-secure-store';
import { useSyncExternalStore } from 'react';
import { Platform } from 'react-native';

const KEY = 'couchside.keepAwake.v1';
const TIMEOUT_KEY = 'couchside.keepAwake.timeoutMin.v1';

// The decision logic lives in an import-free module so it can be unit-tested on
// bare Node (this file cannot: expo-secure-store + react-native). Re-exported
// here so callers still have one import site for the whole preference.
export {
  KEEP_AWAKE_TIMEOUTS,
  KEEP_AWAKE_TIMEOUT_DEFAULT,
  isKeepAwakeTimeout,
  shouldHoldWakeLock,
  type KeepAwakeTimeoutMin,
} from './keepAwakeRules';
import {
  KEEP_AWAKE_TIMEOUT_DEFAULT,
  isKeepAwakeTimeout,
  type KeepAwakeTimeoutMin,
} from './keepAwakeRules';

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
let timeoutMin: KeepAwakeTimeoutMin = KEEP_AWAKE_TIMEOUT_DEFAULT;
const listeners = new Set<() => void>();

function emitChange(): void {
  for (const l of listeners) l();
}

let loadStarted = false;
/** Load the persisted preferences once. Safe to call repeatedly. */
export async function loadKeepAwakePref(): Promise<void> {
  if (loadStarted) return;
  loadStarted = true;
  let dirty = false;
  const v = await storageGet(KEY);
  if (v === '0' && enabled) {
    enabled = false;
    dirty = true;
  }
  // An absent/garbage value keeps the default. Upgraders have no stored value,
  // so they land on KEEP_AWAKE_TIMEOUT_DEFAULT rather than the old "never".
  const t = await storageGet(TIMEOUT_KEY);
  if (t !== null) {
    const n = Number(t);
    if (Number.isFinite(n) && isKeepAwakeTimeout(n) && n !== timeoutMin) {
      timeoutMin = n;
      dirty = true;
    }
  }
  if (dirty) emitChange();
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

export function getKeepAwakeTimeoutMin(): KeepAwakeTimeoutMin {
  return timeoutMin;
}

export async function setKeepAwakeTimeoutMin(next: KeepAwakeTimeoutMin): Promise<void> {
  if (next === timeoutMin || !isKeepAwakeTimeout(next)) return;
  timeoutMin = next;
  emitChange();
  await storageSet(TIMEOUT_KEY, String(next));
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

/** React hook: live inactivity timeout in minutes (0 = never release). */
export function useKeepAwakeTimeoutMin(): KeepAwakeTimeoutMin {
  return useSyncExternalStore(subscribe, getKeepAwakeTimeoutMin, getKeepAwakeTimeoutMin);
}
