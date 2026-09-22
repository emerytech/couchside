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
 * design. The gate ships in the app's source-available code (PolyForm
 * Noncommercial; see app/LICENSE), and self-compiled builds without a reachable
 * store are treated as purchased.
 */
import { Platform } from 'react-native';
import * as SecureStore from 'expo-secure-store';

import { getProduct, restore } from './purchase';
import { verifyLicenseKey } from './license';

export type EntitlementState = 'trial' | 'expired' | 'purchased';
export type Entitlement = {
  state: EntitlementState;
  trialDaysLeft: number;
  /**
   * True only when we can prove the unlock was purchased before the early-
   * adopter cutoff. Conservative: unknown purchase date => false.
   */
  isEarlyAdopter: boolean;
  /**
   * True when 'purchased' was granted by the fail-open below (unreachable store
   * / unfetchable product) rather than by an actual purchase. The gate honours
   * it, but the Setup > Account purchase UI must NOT: hiding the only Buy
   * button behind a transient store hiccup is what got build 26/27 rejected
   * under 2.1(b) ("we cannot locate the In-App Purchases").
   */
  unlockedByFallback: boolean;
};

export const TRIAL_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Purchases completed before this instant earn the Early Adopter badge. */
export const EARLY_ADOPTER_CUTOFF_MS = Date.UTC(2026, 8, 1, 0, 0, 0); // 2026-09-01T00:00:00Z

const FIRST_LAUNCH_KEY = 'couchpilot.entitlement.first-launch.v1';
const PURCHASED_KEY = 'couchpilot.entitlement.unlocked.v1';
/** Cached original purchase date (ms) when the store reported one. */
const PURCHASE_DATE_KEY = 'couchpilot.entitlement.purchase-date.v1';
/** The raw redeemed license key (direct edition). Re-verified on every read. */
const LICENSE_KEY = 'couchpilot.entitlement.license.v1';

/**
 * Beta builds unlock everything so testers never hit the trial or the paywall
 * (and Android open testers are never charged for a real purchase). This is set
 * ONLY on the beta EAS profile via EXPO_PUBLIC_BETA_UNLOCK=1; the production
 * profile leaves it unset, so official store builds still gate. EXPO_PUBLIC_*
 * is inlined at build time, so this is a per-build constant, not a runtime
 * toggle. The badge stays off in beta (no false permanent Early Adopter).
 */
/** True on beta builds (drives both the unlock and the in-app BETA badge). */
export const IS_BETA_BUILD = process.env.EXPO_PUBLIC_BETA_UNLOCK === '1';
const BETA_UNLOCK = IS_BETA_BUILD;
const BETA_ENTITLEMENT: Entitlement = {
  state: 'purchased',
  trialDaysLeft: 0,
  isEarlyAdopter: false,
  unlockedByFallback: false,
};

/**
 * True on the DIRECT (off-store) edition, set ONLY on the `direct` EAS profile
 * via EXPO_PUBLIC_DIRECT=1. This build is sold and handed out directly (no Play
 * / App Store), so:
 *   - it unlocks ONLY via a signed license key (redeemLicenseKey below), and
 *   - it must NOT fail-open to 'purchased' when the store is unreachable the way
 *     a self-compiled build does (revalidateWithStore) — an off-store APK has no
 *     store by definition, so that fail-open would unlock it for anyone who got
 *     the file. That is the whole point of shipping it locked.
 * Inlined at build time like every EXPO_PUBLIC_* constant, so it is a per-build
 * flag, not a runtime toggle. The store builds leave it unset and are unchanged.
 */
export const IS_DIRECT_BUILD = process.env.EXPO_PUBLIC_DIRECT === '1';

/** Friendly, non-leaky reasons a pasted key was refused. */
const LICENSE_ERROR_TEXT: Record<string, string> = {
  format: "That doesn't look like a Couchside license key.",
  signature: "This key isn't valid. Check you pasted it exactly as sent.",
  payload: 'This key is malformed. Ask for a fresh one.',
};

export type RedeemResult = { ok: true; name: string } | { ok: false; error: string };

/**
 * Re-verify the stored license key against the baked-in public key. Done on
 * every entitlement read (it is a cheap offline signature check), so a corrupted
 * or hand-edited stored blob unlocks nothing — only a genuinely signed key does.
 * Returns the licensee name, or null when there is no valid stored key.
 */
async function verifiedLicenseName(): Promise<string | null> {
  let raw: string | null;
  try {
    raw = await storageGet(LICENSE_KEY);
  } catch {
    return null; // unreadable storage: no license, stay gated (degrade closed)
  }
  if (!raw) return null;
  const r = verifyLicenseKey(raw);
  return r.ok ? r.payload.name : null;
}

/** The licensee's name if a valid key is stored, else null (for the UI badge). */
export async function getLicenseeName(): Promise<string | null> {
  return verifiedLicenseName();
}

/**
 * Redeem a pasted license key. Verifies the Ed25519 signature offline; on
 * success persists the raw key (re-verified on every future launch) and the
 * caller refreshes the entitlement. Never partially applies: a refused key
 * writes nothing.
 */
export async function redeemLicenseKey(input: string): Promise<RedeemResult> {
  const r = verifyLicenseKey(input);
  if (!r.ok) return { ok: false, error: LICENSE_ERROR_TEXT[r.error] ?? 'This key could not be verified.' };
  try {
    await storageSet(LICENSE_KEY, r.raw);
  } catch {
    return { ok: false, error: "Couldn't save the key on this device. Try again." };
  }
  return { ok: true, name: r.payload.name };
}

/**
 * True only for a real, owned unlock — never for the store-unreachable
 * fail-open. The Setup > Account purchase UI keys off this (not off
 * `state === 'purchased'`) so the Buy/Restore buttons stay on screen when the
 * store is having a bad day. The feature gate deliberately does NOT use this:
 * a fail-open build stays unlocked.
 */
export function isGenuinelyPurchased(e: Entitlement): boolean {
  return e.state === 'purchased' && !e.unlockedByFallback;
}

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
export async function storageGet(key: string): Promise<string | null> {
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

export async function storageSet(key: string, value: string): Promise<void> {
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

/** Record a completed unlock purchase (called after buy()/restore() succeed).

    Read-before-write, for two reasons measured on the same device (iOS 27
    beta, 2026-07-30): a keychain write is ~two securityd round-trips
    (SecItemAdd -> duplicate -> SecItemUpdate), and on that beta the item can
    get into a state where reads miss it while adds collide — so a caller loop
    (the StoreKit re-delivery storm) turned this into ~100 keychain writes per
    second. The storm is fixed at its source in purchase.ts; this guard makes
    the write path idempotent regardless of caller behaviour. */
export async function markPurchased(): Promise<void> {
  try {
    if ((await storageGet(PURCHASED_KEY)) === '1') return;
  } catch {
    // unreadable cache: fall through and write
  }
  await storageSet(PURCHASED_KEY, '1');
}

/**
 * Local entitlement: purchase cache + trial clock only. Fast and offline:
 * this is what the UI reads. Store re-validation is layered on top via
 * revalidateWithStore().
 */
export async function getEntitlement(): Promise<Entitlement> {
  // Beta builds are unlocked outright, ahead of the trial clock and the cache.
  if (BETA_UNLOCK) return BETA_ENTITLEMENT;
  // A validly signed license key (direct edition) is a genuine unlock, checked
  // ahead of the store cache. Re-verified here every read, so it cannot be faked
  // by tampering with storage.
  if (await verifiedLicenseName()) {
    return { state: 'purchased', trialDaysLeft: 0, isEarlyAdopter: false, unlockedByFallback: false };
  }
  try {
    if ((await storageGet(PURCHASED_KEY)) === '1') {
      return {
        state: 'purchased',
        trialDaysLeft: 0,
        isEarlyAdopter: earlyAdopterFromDate(await purchaseDateMs()),
        unlockedByFallback: false,
      };
    }
  } catch {
    // unreadable cache: fall back to the trial clock
  }
  const elapsedMs = Date.now() - (await firstLaunchMs());
  const daysLeft = Math.max(0, Math.ceil((TRIAL_DAYS * DAY_MS - elapsedMs) / DAY_MS));
  return daysLeft > 0
    ? { state: 'trial', trialDaysLeft: daysLeft, isEarlyAdopter: false, unlockedByFallback: false }
    : { state: 'expired', trialDaysLeft: 0, isEarlyAdopter: false, unlockedByFallback: false };
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
  // Beta builds stay unlocked without ever touching the store (so Android open
  // testers are not prompted to buy, and nothing can downgrade them).
  if (BETA_UNLOCK) return BETA_ENTITLEMENT;
  // The direct edition has no store to validate against and must never fail-open
  // (see IS_DIRECT_BUILD). Its only unlock is the signed license key, already
  // resolved by getEntitlement into `local`; trust it verbatim and stop here.
  if (IS_DIRECT_BUILD) return local;
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
      unlockedByFallback: false,
    };
  }
  if (result.state === 'unavailable') {
    return {
      state: 'purchased',
      trialDaysLeft: local.trialDaysLeft,
      isEarlyAdopter: false,
      unlockedByFallback: true,
    };
  }
  if (result.state === 'none' && (await getProduct()) == null) {
    // The store connected but couchpilot_unlock is not fetchable: this is a
    // dev / simulator / self-compiled binary (different bundle id or no store
    // listing) that cannot possibly sell the unlock: treat like
    // 'unavailable' so such builds are never locked out. NOT cached, so an
    // official store build (which can always fetch the product) still gates.
    return {
      state: 'purchased',
      trialDaysLeft: local.trialDaysLeft,
      isEarlyAdopter: false,
      unlockedByFallback: true,
    };
  }
  return local;
}
