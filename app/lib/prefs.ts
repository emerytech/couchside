/**
 * App-wide scalar preferences, persisted as a single JSON blob.
 *
 * This complements the single-boolean external stores (haptics.ts, keepAwake.ts):
 * rather than a separate module per small enum/number setting, the handful added
 * here live together. Same external-store shape so a `<Switch>` or segmented
 * control can read/write a field and re-render live via usePref(); non-React
 * code reads getPref(). Unknown/missing/invalid fields fall back to DEFAULTS on
 * load, so older stored blobs and new keys both work.
 */
import * as SecureStore from 'expo-secure-store';
import { useSyncExternalStore } from 'react';
import { Platform } from 'react-native';

import { PadMode } from './settings';

export type Prefs = {
  /** Ask before suspending the box (the Suspend button in the header). */
  confirmSuspend: boolean;
  /** Input mode a newly paired box starts on. */
  defaultPadMode: PadMode;
  /** How often the console/header polls the box for vitals (ms). */
  statusIntervalMs: number;
  /** Journal lines fetched per unit on the Logs tab. */
  journalLines: number;
  /** Swipe-surface sensitivity multiplier (higher = smaller step, more steps). */
  swipeSensitivity: number;
  /** Trackpad pointer-speed multiplier. */
  trackpadSensitivity: number;
  /** Invert two-finger scroll direction (macOS-style "natural" scrolling). */
  naturalScroll: boolean;
};

export const DEFAULTS: Prefs = {
  confirmSuspend: true,
  defaultPadMode: 'swipe',
  statusIntervalMs: 5000,
  journalLines: 100,
  swipeSensitivity: 1,
  trackpadSensitivity: 1,
  naturalScroll: false,
};

/** The choices each select-style pref offers (kept next to the store it feeds). */
export const STATUS_INTERVAL_OPTIONS = [2000, 5000, 15000, 30000] as const;
export const JOURNAL_LINE_OPTIONS = [50, 100, 250, 500] as const;
export const SENSITIVITY_OPTIONS = [0.6, 1, 1.6] as const;

const KEY = 'couchside.prefs.v1';

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
      // storage unavailable (private mode): prefs live in memory this session
    }
    return;
  }
  await SecureStore.setItemAsync(key, value);
}

// ---------- external store ----------

let prefs: Prefs = { ...DEFAULTS };
const listeners = new Set<() => void>();

function emitChange(): void {
  for (const l of listeners) l();
}

/** Coerce a parsed blob into a valid Prefs, filling anything missing/invalid. */
function normalize(raw: unknown): Prefs {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const num = (v: unknown, allowed: readonly number[], fallback: number): number =>
    typeof v === 'number' && allowed.includes(v) ? v : fallback;
  const padMode: PadMode =
    o.defaultPadMode === 'gamepad' ||
    o.defaultPadMode === 'trackpad' ||
    o.defaultPadMode === 'remote'
      ? o.defaultPadMode
      : 'swipe';
  return {
    confirmSuspend:
      typeof o.confirmSuspend === 'boolean' ? o.confirmSuspend : DEFAULTS.confirmSuspend,
    defaultPadMode: padMode,
    statusIntervalMs: num(o.statusIntervalMs, STATUS_INTERVAL_OPTIONS, DEFAULTS.statusIntervalMs),
    journalLines: num(o.journalLines, JOURNAL_LINE_OPTIONS, DEFAULTS.journalLines),
    swipeSensitivity: num(o.swipeSensitivity, SENSITIVITY_OPTIONS, DEFAULTS.swipeSensitivity),
    trackpadSensitivity: num(o.trackpadSensitivity, SENSITIVITY_OPTIONS, DEFAULTS.trackpadSensitivity),
    naturalScroll:
      typeof o.naturalScroll === 'boolean' ? o.naturalScroll : DEFAULTS.naturalScroll,
  };
}

let loadStarted = false;
/** Load the persisted prefs once. Safe to call repeatedly. */
export async function loadPrefs(): Promise<void> {
  if (loadStarted) return;
  loadStarted = true;
  const raw = await storageGet(KEY);
  if (raw == null) return;
  try {
    const next = normalize(JSON.parse(raw));
    prefs = next;
    emitChange();
  } catch {
    // malformed blob: keep defaults
  }
}
// Kick the load off at import so values are ready by first interaction.
void loadPrefs();

export function getPref<K extends keyof Prefs>(key: K): Prefs[K] {
  return prefs[key];
}

export async function setPref<K extends keyof Prefs>(key: K, value: Prefs[K]): Promise<void> {
  if (prefs[key] === value) return;
  prefs = { ...prefs, [key]: value };
  emitChange();
  await storageSet(KEY, JSON.stringify(prefs));
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

/** React hook: live value of a single preference (for a Switch/segmented control). */
export function usePref<K extends keyof Prefs>(key: K): Prefs[K] {
  return useSyncExternalStore(
    subscribe,
    () => prefs[key],
    () => prefs[key],
  );
}
