/**
 * Single source of truth for the 7-day trial + one-time unlock.
 *
 * State machine:
 *   'purchased' — couchpilot_unlock owned (cached locally, re-validated
 *                 against the store on app start).
 *   'trial'     — within TRIAL_DAYS of first launch.
 *   'expired'   — trial over, not purchased. The tabs gate on this (demo mode
 *                 is never gated — see components/Gated.tsx).
 *
 * No account, no server: the first-launch timestamp lives in the iOS
 * Keychain / Android Keystore via expo-secure-store (localStorage on the
 * dev-only web build). A determined user can evade this; that is accepted by
 * design. The gate ships in the open GPLv3 source and self-compiled builds
 * without a reachable store are treated as purchased.
 */
import { Platform } from 'react-native';
import * as SecureStore from 'expo-secure-store';

import { getProduct, restore } from './purchase';

export type EntitlementState = 'trial' | 'expired' | 'purchased';
export type Entitlement = { state: EntitlementState; trialDaysLeft: number };

export const TRIAL_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;

const FIRST_LAUNCH_KEY = 'couchpilot.entitlement.first-launch.v1';
const PURCHASED_KEY = 'couchpilot.entitlement.unlocked.v1';

/**
 * Persistence wrapper: expo-secure-store on native, localStorage on web —
 * same pattern as lib/settings.ts. Keychain entries survive OS cache clears
 * (and on iOS typically app reinstalls), which is as durable as a
 * client-only trial clock can reasonably be.
 */
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
      // storage unavailable (private mode); state lives in memory only
    }
    return;
  }
  await SecureStore.setItemAsync(key, value);
}

/** First-launch timestamp (ms); written on first read if absent/invalid. */
async function firstLaunchMs(): Promise<number> {
  const now = Date.now();
  try {
    const raw = await storageGet(FIRST_LAUNCH_KEY);
    const ts = raw == null ? NaN : Number(raw);
    if (Number.isFinite(ts) && ts > 0 && ts <= now) return ts;
  } catch {
    // unreadable storage: fall through and (re)start the clock
  }
  try {
    await storageSet(FIRST_LAUNCH_KEY, String(now));
  } catch {
    // best effort — an unwritable clock just restarts the trial next launch
  }
  return now;
}

/** Record a completed unlock purchase (called after buy()/restore() succeed). */
export async function markPurchased(): Promise<void> {
  await storageSet(PURCHASED_KEY, '1');
}

/**
 * Local entitlement: purchase cache + trial clock only. Fast and offline —
 * this is what the UI reads. Store re-validation is layered on top via
 * revalidateWithStore().
 */
export async function getEntitlement(): Promise<Entitlement> {
  try {
    if ((await storageGet(PURCHASED_KEY)) === '1') {
      return { state: 'purchased', trialDaysLeft: 0 };
    }
  } catch {
    // unreadable cache: fall back to the trial clock
  }
  const elapsedMs = Date.now() - (await firstLaunchMs());
  const daysLeft = Math.max(0, Math.ceil((TRIAL_DAYS * DAY_MS - elapsedMs) / DAY_MS));
  return daysLeft > 0
    ? { state: 'trial', trialDaysLeft: daysLeft }
    : { state: 'expired', trialDaysLeft: 0 };
}

/**
 * Re-validate the local entitlement against the store's own purchase list on
 * app start. Cheap and offline-tolerant:
 *   - store says owned  -> cache it, 'purchased'.
 *   - store unavailable (web, simulator, self-compiled build without the
 *     native module / Play services) -> treat as 'purchased' so dev and
 *     self-built binaries are never locked out; NOT cached, so a build where
 *     the store later becomes reachable gates normally.
 *   - store reachable but the unlock product can't be fetched (dev /
 *     simulator / self-compiled build under another bundle id) -> same as
 *     unavailable: this binary can't sell the unlock, so don't gate.
 *   - store call errors or reports nothing -> trust the local cache/clock
 *     (never revoke a cached purchase on a flaky store response).
 */
export async function revalidateWithStore(local: Entitlement): Promise<Entitlement> {
  if (local.state === 'purchased') return local;
  const result = await restore();
  if (result.state === 'purchased') {
    await markPurchased();
    return { state: 'purchased', trialDaysLeft: 0 };
  }
  if (result.state === 'unavailable') {
    return { state: 'purchased', trialDaysLeft: local.trialDaysLeft };
  }
  if (result.state === 'none' && (await getProduct()) == null) {
    // The store connected but couchpilot_unlock is not fetchable: this is a
    // dev / simulator / self-compiled binary (different bundle id or no store
    // listing) that cannot possibly sell the unlock — treat like
    // 'unavailable' so such builds are never locked out. NOT cached, so an
    // official store build (which can always fetch the product) still gates.
    return { state: 'purchased', trialDaysLeft: local.trialDaysLeft };
  }
  return local;
}
