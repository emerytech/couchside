/**
 * App-wide haptics, gated by a single persisted preference.
 *
 * Every tactile cue in the app routes through these emitters, so the Settings
 * toggle enables/disables all of them at once. Haptics are a no-op on web and
 * when the user has turned them off. The preference is an external store so a
 * `<Switch>` can read/write it and re-render live via useHapticsEnabled().
 */
import * as Haptics from 'expo-haptics';
import * as SecureStore from 'expo-secure-store';
import { useSyncExternalStore } from 'react';
import { Platform } from 'react-native';

const KEY = 'couchside.haptics.v1';

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
      // storage unavailable (private mode) — pref lives in memory this session
    }
    return;
  }
  await SecureStore.setItemAsync(key, value);
}

// ---------- external store ----------

let enabled = true; // default ON
const listeners = new Set<() => void>();

function emitChange(): void {
  for (const l of listeners) l();
}

let loadStarted = false;
/** Load the persisted preference once. Safe to call repeatedly. */
export async function loadHapticsPref(): Promise<void> {
  if (loadStarted) return;
  loadStarted = true;
  const v = await storageGet(KEY);
  if (v === '0' && enabled) {
    enabled = false;
    emitChange();
  }
}
// Kick the load off at import so the pref is ready by first interaction.
void loadHapticsPref();

export function getHapticsEnabled(): boolean {
  return enabled;
}

export async function setHapticsEnabled(next: boolean): Promise<void> {
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

/** React hook: live boolean of the haptics preference (for the Settings switch). */
export function useHapticsEnabled(): boolean {
  return useSyncExternalStore(subscribe, getHapticsEnabled, getHapticsEnabled);
}

// ---------- emitters (all gated by the pref + platform) ----------

function active(): boolean {
  return enabled && Platform.OS !== 'web';
}

/** Light selection tick — taps, d-pad steps, nav, toggles. */
export function hapticSelection(): void {
  if (active()) Haptics.selectionAsync().catch(() => {});
}

/** Light impact — button presses, stick grab. */
export function hapticLight(): void {
  if (active()) Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
}

/** Medium impact — launches, mode switches, meaningful taps. */
export function hapticMedium(): void {
  if (active()) Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {});
}

/** Heavy impact — high-danger action confirmations. */
export function hapticHeavy(): void {
  if (active()) Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy).catch(() => {});
}

/** Success notification — an action/purchase/pairing succeeded. */
export function hapticSuccess(): void {
  if (active()) Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
}

/** Warning notification. */
export function hapticWarning(): void {
  if (active()) Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning).catch(() => {});
}

/** Error notification — a request/action failed. */
export function hapticError(): void {
  if (active()) Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error).catch(() => {});
}
