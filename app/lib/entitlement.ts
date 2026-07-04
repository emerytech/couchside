/**
 * Single source of truth for the 7-day trial + one-time unlock.
 *
 * State machine:
 *   'purchased': couchpilot_unlock owned (cached locally, re-validated
 *                 against the store on app start).
 *   'trial'    : within TRIAL_DAYS of first launch.
 *   'expired'  : trial over, not purchased. The tabs gate on this
 *                 (see components/Gated.tsx).
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
export type Entitlement = {
  state: EntitlementState;
  trialDaysLeft: number;
  /**
   * True only when we can prove the unlock was purchased before the early-
   * adopter cutoff. Conservative: unknown purchase date => false.
   */
  isEarlyAdopter: boolean;
};

export const TRIAL_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Purchases completed before this instant earn the Early Adopter badge. */
export const EARLY_ADOPTER_CUTOFF_MS = Date.UTC(2026, 8, 1, 0, 0, 0); // 2026-09-01T00:00:00Z

const FIRST_LAUNCH_KEY = 'couchpilot.entitlement.first-launch.v1';
const PURCHASED_KEY = 'couchpilot.entitlement.unlocked.v1';
/** Cached original purchase date (ms) when the store reported one. */
const PURCHASE_DATE_KEY = 'couchpilot.entitlement.purchase-date.v1';

/** True iff a known purchase timestamp falls before the early-adopter cutoff. */
function earlyAdopterFromDate(purchaseDateMs: number | null): boolean {
  return purchaseDateMs != null && purchaseDateMs < EARLY_ADOPTER_CUTOFF_MS;
}

/** Read the cached purchase date, or null when absent/invalid. */
async function purchaseDateMs(): Promise<number | null> {
  try {
    const raw = await storageGet(PURCHASE_DATE_KEY);
    const ts = raw == null ? NaN : Number(raw);
    return Number.isFinite(ts) && ts > 0 ? ts : null;
  } catch {
    return null;
  }
}

/** Cache the store-reported purchase date (best effort). */
export async function recordPurchaseDate(ms: number): Promise<void> {
  if (!Number.isFinite(ms) || ms <= 0) return;
  try {
    await storageSet(PURCHASE_DATE_KEY, String(Math.round(ms)));
  } catch {
    // best effort: the badge just won't show without a persisted date
  }
}

/**
 * Persistence wrapper: expo-secure-store on native, localStorage on web,
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
    // best effort: an unwritable clock just restarts the trial next launch
  }
  return now;
}

/** Record a completed unlock purchase (called after buy()/restore() succeed). */
export async function markPurchased(): Promise<void> {
  await storageSet(PURCHASED_KEY, '1');
}

/**
 * Local entitlement: purchase cache + trial clock only. Fast and offline:
 * this is what the UI reads. Store re-validation is layered on top via
 * revalidateWithStore().
 */
export async function getEntitlement(): Promise<Entitlement> {
  try {
    if ((await storageGet(PURCHASED_KEY)) === '1') {
      return {
        state: 'purchased',
        trialDaysLeft: 0,
        isEarlyAdopter: earlyAdopterFromDate(await purchaseDateMs()),
      };
    }
  } catch {
    // unreadable cache: fall back to the trial clock
  }
  const elapsedMs = Date.now() - (await firstLaunchMs());
  const daysLeft = Math.max(0, Math.ceil((TRIAL_DAYS * DAY_MS - elapsedMs) / DAY_MS));
  return daysLeft > 0
    ? { state: 'trial', trialDaysLeft: daysLeft, isEarlyAdopter: false }
    : { state: 'expired', trialDaysLeft: 0, isEarlyAdopter: false };
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
  if (local.state === 'purchased') {
    // Already unlocked locally. Opportunistically confirm the purchase date so
    // the Early Adopter badge can appear even if we cached the purchase before
    // ever recording a date. Never revoke the purchase on a flaky response.
    if (!local.isEarlyAdopter) {
      const result = await restore();
      if (result.state === 'purchased' && result.purchaseDateMs != null) {
        await recordPurchaseDate(result.purchaseDateMs);
        return {
          ...local,
          isEarlyAdopter: earlyAdopterFromDate(result.purchaseDateMs),
        };
      }
    }
    return local;
  }
  const result = await restore();
  if (result.state === 'purchased') {
    await markPurchased();
    if (result.purchaseDateMs != null) await recordPurchaseDate(result.purchaseDateMs);
    return {
      state: 'purchased',
      trialDaysLeft: 0,
      isEarlyAdopter: earlyAdopterFromDate(result.purchaseDateMs ?? null),
    };
  }
  if (result.state === 'unavailable') {
    return { state: 'purchased', trialDaysLeft: local.trialDaysLeft, isEarlyAdopter: false };
  }
  if (result.state === 'none' && (await getProduct()) == null) {
    // The store connected but couchpilot_unlock is not fetchable: this is a
    // dev / simulator / self-compiled binary (different bundle id or no store
    // listing) that cannot possibly sell the unlock: treat like
    // 'unavailable' so such builds are never locked out. NOT cached, so an
    // official store build (which can always fetch the product) still gates.
    return { state: 'purchased', trialDaysLeft: local.trialDaysLeft, isEarlyAdopter: false };
  }
  return local;
}
