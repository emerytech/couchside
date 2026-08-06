import { isUserCancellation } from './purchaseErrors';
export { isUserCancellation, userFacingPurchaseError } from './purchaseErrors';
/**
 * Thin, no-throw wrapper around expo-iap (direct StoreKit / Google Play
 * Billing, no third-party purchase service, receipts stay on-device).
 *
 * Resilience contract: every exported function is safe to call on web, in the
 * iOS simulator, or in a self-compiled build without the native module. When
 * the store cannot be reached the functions report 'unavailable' instead of
 * throwing; callers (lib/entitlement.ts) treat that as "nothing to sell here,
 * do not gate".
 */
import { Platform } from 'react-native';
import { shouldReconcileWithStore } from './restoreSync';

/** The single non-consumable unlock product (App Store + Play Store). */
export const UNLOCK_PRODUCT_ID = 'couchpilot_unlock';

export type ProductInfo = { id: string; title: string; displayPrice: string };

export type BuyResult =
  | { ok: true }
  | { ok: false; reason: 'cancelled' | 'unavailable' | 'pending' | 'error'; message?: string };

export type RestoreResult =
  | { state: 'purchased'; purchaseDateMs?: number }
  | { state: 'none' }
  | { state: 'unavailable' }
  | { state: 'error'; message?: string };

// Minimal structural view of the expo-iap surface we use (v4, Open IAP API:
// initConnection / fetchProducts / requestPurchase / getAvailablePurchases /
// finishTransaction + event listeners). Kept local so the module can be
// require()'d lazily and the app never depends on it at import time.
type IapPurchase = {
  productId: string;
  purchaseState: 'pending' | 'purchased' | 'unknown';
  // Transaction identity, when the platform provides one. Used ONLY to dedupe
  // re-deliveries of the same transaction (see the listener); never required.
  id?: string;
  transactionId?: string;
  // Original transaction time (ms since epoch). Open IAP surfaces this as
  // `transactionDate`; some platforms also carry a StoreKit
  // `originalPurchaseDate`. Both optional: never depend on either existing.
  transactionDate?: number;
  originalPurchaseDate?: number;
  // Android only: false until we acknowledge the purchase. An owned purchase
  // left unacknowledged for 3 days is auto-refunded by Google. Undefined on iOS.
  isAcknowledgedAndroid?: boolean | null;
  // Android acknowledge/finish needs the purchase token.
  purchaseToken?: string | null;
};
type IapProduct = { id: string; title: string; displayPrice: string };
type IapModule = {
  initConnection: () => Promise<boolean>;
  fetchProducts: (req: { skus: string[]; type: 'in-app' }) => Promise<IapProduct[] | null>;
  requestPurchase: (req: {
    request: { apple?: { sku: string }; google?: { skus: string[] } };
    type: 'in-app';
  }) => Promise<unknown>;
  getAvailablePurchases: () => Promise<IapPurchase[] | null>;
  finishTransaction: (args: { purchase: IapPurchase; isConsumable?: boolean }) => Promise<unknown>;
  purchaseUpdatedListener: (cb: (purchase: IapPurchase) => void) => { remove: () => void };
  purchaseErrorListener: (cb: (error: { code?: string; message?: string }) => void) => {
    remove: () => void;
  };
  /**
   * iOS: force StoreKit to reconcile with the App Store, then refresh the local
   * purchase list. Optional because it is absent on older expo-iap and is a
   * no-op we tolerate missing (see restoreFromUserAction).
   */
  restorePurchases?: () => Promise<void>;
};

let mod: IapModule | null | undefined;

/** Lazily require expo-iap; null on web or when the native module is absent. */
function iap(): IapModule | null {
  if (mod !== undefined) return mod;
  if (Platform.OS === 'web') {
    mod = null;
    return mod;
  }
  try {
    // Lazy require so a missing/broken native module (simulator, stripped
    // self-compiled build) can never crash the app at import time.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    mod = require('expo-iap') as IapModule;
  } catch {
    mod = null;
  }
  return mod;
}

let connectPromise: Promise<boolean> | null = null;
let listenersAttached = false;
// Transactions already granted this session, keyed by the best identity the
// platform gives us. Module level: the listener survives provider remounts,
// and StoreKit re-delivery of an unfinished transaction must never re-grant
// (the 2026-07-30 CPU storm — see the listener). Bounded: one entry per real
// transaction, and a session sees a handful at most.
const grantedTxIds = new Set<string>();
let finishFailureLogged = false;

/**
 * Registered by EntitlementProvider; fired whenever the store reports a
 * completed unlock purchase (including ones that finish out-of-band, e.g. a
 * purchase interrupted by an app kill and delivered on next launch).
 */
let onPurchased: ((purchaseDateMs?: number) => void) | null = null;
export function setOnPurchased(cb: ((purchaseDateMs?: number) => void) | null): void {
  onPurchased = cb;
}

/** Extract a usable original-purchase timestamp from an IAP purchase, if any. */
function purchaseDateOf(p: IapPurchase): number | undefined {
  const raw = p.originalPurchaseDate ?? p.transactionDate;
  return typeof raw === 'number' && Number.isFinite(raw) && raw > 0 ? raw : undefined;
}

// At most one buy() in flight; settled by the purchase listeners.
let pendingBuy: ((result: BuyResult) => void) | null = null;
function settleBuy(result: BuyResult): void {
  const settle = pendingBuy;
  pendingBuy = null;
  settle?.(result);
}

/** Connect to the store once; false means "unavailable", never throws. */
async function connect(): Promise<boolean> {
  const m = iap();
  if (!m) return false;
  if (!connectPromise) {
    connectPromise = (async () => {
      try {
        // Attach the purchase listeners BEFORE initConnection resolves. The
        // native module flushes any buffered purchase-updated events at the
        // instant the connection opens; a listener registered after the await
        // can miss an out-of-band purchase delivered on this launch (e.g. a
        // slow-payment purchase that completed while the app was dead).
        if (!listenersAttached) {
          listenersAttached = true;
          m.purchaseUpdatedListener((purchase) => {
            if (purchase.productId !== UNLOCK_PRODUCT_ID) return;
            if (purchase.purchaseState === 'pending') {
              // Not paid yet (e.g. a slow payment method like cash/konbini on
              // Play): do NOT grant and do NOT finish, the store fires this
              // listener again with state 'purchased' once payment completes,
              // and that event grants the unlock (possibly on a later launch,
              // via onPurchased).
              settleBuy({ ok: false, reason: 'pending' });
              return;
            }
            // Non-consumable: acknowledge/finish so the store stops retrying.
            //
            // THE STORM GUARD (2026-07-30, measured on the owner's iPhone,
            // iOS 27 beta). When finishTransaction FAILS, StoreKit re-delivers
            // the unfinished transaction to this listener immediately and
            // forever. Ungated, every re-delivery granted again: a keychain
            // write (~100/s measured), a fresh entitlement object, a full
            // context re-render — 87% CPU sustained until iOS killed the app
            // for CPU abuse, every ~30-120s, every launch. A pegged JS thread
            // also stops pumping trackpad frames, which is what "the mouse
            // dies until I restart the app" actually was.
            //
            // So: keep RETRYING the finish on every delivery (that is the only
            // path to making StoreKit stop), but grant AT MOST ONCE per
            // transaction identity — and log the finish failure instead of
            // swallowing it, because a silent `.catch(() => {})` is how this
            // ran undiagnosed on a shipped build.
            const txId =
              purchase.id ?? purchase.transactionId ??
              (purchase.transactionDate != null ? String(purchase.transactionDate) : null);
            m.finishTransaction({ purchase, isConsumable: false }).catch((e) => {
              if (!finishFailureLogged) {
                finishFailureLogged = true;
                console.warn(
                  '[iap] finishTransaction failed; StoreKit will re-deliver ' +
                    'this transaction until it succeeds:',
                  e instanceof Error ? e.message : e,
                );
              }
            });
            if (txId != null && grantedTxIds.has(txId)) {
              return; // re-delivery of a transaction we already granted
            }
            if (txId != null) grantedTxIds.add(txId);
            onPurchased?.(purchaseDateOf(purchase));
            settleBuy({ ok: true });
          });
          m.purchaseErrorListener((error) => {
            settleBuy(
              isUserCancellation(error)
                ? { ok: false, reason: 'cancelled' }
                : { ok: false, reason: 'error', message: error?.message },
            );
          });
        }
        return await m.initConnection();
      } catch {
        return false;
      }
    })();
  }
  const ok = await connectPromise;
  if (!ok) connectPromise = null; // allow a later retry
  return ok;
}

/** Localized product info for price display; null when the store is unreachable. */
export async function getProduct(): Promise<ProductInfo | null> {
  try {
    const m = iap();
    if (!m || !(await connect())) return null;
    const products = (await m.fetchProducts({ skus: [UNLOCK_PRODUCT_ID], type: 'in-app' })) ?? [];
    const p = products.find((x) => x.id === UNLOCK_PRODUCT_ID) ?? products[0];
    return p ? { id: p.id, title: p.title, displayPrice: p.displayPrice } : null;
  } catch {
    return null;
  }
}


/**
 * Start the one-time unlock purchase. Resolves when the store delivers the
 * purchase (via the update listener), the user cancels, or the request fails.
 */
export async function buy(): Promise<BuyResult> {
  const m = iap();
  if (!m || !(await connect())) return { ok: false, reason: 'unavailable' };
  if (pendingBuy) return { ok: false, reason: 'error', message: 'A purchase is already in progress.' };
  return new Promise<BuyResult>((resolve) => {
    pendingBuy = resolve;
    // Event-based API: the result arrives via purchaseUpdatedListener /
    // purchaseErrorListener, not this promise's value.
    m.requestPurchase({
      request: { apple: { sku: UNLOCK_PRODUCT_ID }, google: { skus: [UNLOCK_PRODUCT_ID] } },
      type: 'in-app',
    }).catch((e: unknown) => {
      // Cancellation arrives HERE on this expo-iap version, not only via
      // purchaseErrorListener — see isUserCancellation.
      settleBuy(
        isUserCancellation(e)
          ? { ok: false, reason: 'cancelled' }
          : { ok: false, reason: 'error', message: e instanceof Error ? e.message : String(e) },
      );
    });
  });
}

/**
 * Restore, but FIRST force StoreKit to reconcile with the App Store.
 *
 * WHY THIS IS SEPARATE FROM restore(), and must stay separate: a tester redeemed
 * an App Store promo code for the unlock, Apple confirmed it and it showed in
 * his purchase history — and Restore Purchases still reported nothing. A code
 * redeemed in the App Store app is redeemed OUT OF BAND; the device's local
 * StoreKit entitlement cache does not know about it until it reconciles.
 * getAvailablePurchases() reads that cache, so the app was honestly reporting an
 * empty cache while the entitlement was real on Apple's side.
 *
 * We call expo-iap's `restorePurchases`, NOT `syncIOS` directly. Reading
 * expo-iap 4.3.6's implementation, restorePurchases branches:
 *   USING_ONSIDE_SDK -> nativeModule.restorePurchases()
 *   otherwise        -> syncIOS()
 * This build uses OpenIAP from CocoaPods, so the OnSide branch is the live one
 * and calling syncIOS() directly would take the wrong path. restorePurchases is
 * also already platform-guarded and already swallows its own errors.
 *
 * ONLY EVER CALL THIS FROM AN EXPLICIT USER TAP. The reconcile can prompt for an
 * Apple ID password, and plain restore() is reached on EVERY APP LAUNCH via
 * EntitlementContext -> revalidateWithStore. Wiring the sync into restore()
 * itself would put a password prompt on every cold start — which is why the
 * name of this function says user action out loud.
 *
 * Never throws, exactly like restore(): a failed sync falls through to the
 * unchanged local read, so this can only ever find MORE than before.
 */
export async function restoreFromUserAction(): Promise<RestoreResult> {
  const m = iap();
  // Held in a local so TypeScript keeps the narrowing; the gate below only
  // reports whether it is present, it cannot narrow the call site.
  const reconcile = m?.restorePurchases;
  // The gate itself lives in an import-free module so it is unit-testable on
  // bare Node; see lib/restoreSync.ts and its tests.
  const mayReconcile = shouldReconcileWithStore({
    platform: Platform.OS,
    userInitiated: true, // this entry point exists ONLY for the Restore button
    hasApi: typeof reconcile === 'function',
  });
  if (m && reconcile && mayReconcile) {
    // Requires a connection first; connect() is idempotent and restore() calls
    // it again below.
    if (await connect()) {
      try {
        await reconcile.call(m);
      } catch {
        // Deliberately swallowed. A sync that fails must leave restore() doing
        // exactly what it did before, never turn a working restore into an error.
      }
    }
  }
  return restore();
}

/** Query the store for an existing unlock (Restore Purchases). Never throws.
 *
 *  Reads the LOCAL StoreKit/Play purchase cache. For a user-initiated Restore
 *  use restoreFromUserAction(), which reconciles with Apple first — see there
 *  for why that split exists and why it must not be collapsed. */
export async function restore(): Promise<RestoreResult> {
  const m = iap();
  if (!m || !(await connect())) return { state: 'unavailable' };
  try {
    const purchases = (await m.getAvailablePurchases()) ?? [];
    // getAvailablePurchases can also return pending (unpaid) transactions,
    // only a completed purchase counts as owned.
    const owned = purchases.find(
      (p) => p.productId === UNLOCK_PRODUCT_ID && p.purchaseState !== 'pending',
    );
    if (!owned) return { state: 'none' };
    // Acknowledge an owned-but-unacknowledged Android purchase. The buy-time
    // ack (in the purchase-updated listener) can be missed — the event may
    // arrive while the app is dead, or the fire-and-forget finishTransaction
    // there can fail silently. Google auto-refunds any purchase left
    // unacknowledged for 3 days, so we re-finish here on every restore.
    // iOS leaves isAcknowledgedAndroid undefined, so this is a no-op there.
    if (owned.isAcknowledgedAndroid === false) {
      await m.finishTransaction({ purchase: owned, isConsumable: false }).catch(() => {});
    }
    // Prefer the original purchase date (StoreKit) then the transaction date;
    // both are optional, so a purchase may be owned with no known date.
    const raw = owned.originalPurchaseDate ?? owned.transactionDate;
    const purchaseDateMs =
      typeof raw === 'number' && Number.isFinite(raw) && raw > 0 ? raw : undefined;
    return { state: 'purchased', purchaseDateMs };
  } catch (e: unknown) {
    return { state: 'error', message: e instanceof Error ? e.message : String(e) };
  }
}
