/**
 * Thin, no-throw wrapper around expo-iap (direct StoreKit / Google Play
 * Billing — no third-party purchase service, receipts stay on-device).
 *
 * Resilience contract: every exported function is safe to call on web, in the
 * iOS simulator, or in a self-compiled build without the native module. When
 * the store cannot be reached the functions report 'unavailable' instead of
 * throwing; callers (lib/entitlement.ts) treat that as "nothing to sell here,
 * do not gate".
 */
import { Platform } from 'react-native';

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
  // Original transaction time (ms since epoch). Open IAP surfaces this as
  // `transactionDate`; some platforms also carry a StoreKit
  // `originalPurchaseDate`. Both optional — never depend on either existing.
  transactionDate?: number;
  originalPurchaseDate?: number;
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
        const ok = await m.initConnection();
        if (ok && !listenersAttached) {
          listenersAttached = true;
          m.purchaseUpdatedListener((purchase) => {
            if (purchase.productId !== UNLOCK_PRODUCT_ID) return;
            if (purchase.purchaseState === 'pending') {
              // Not paid yet (e.g. a slow payment method like cash/konbini on
              // Play): do NOT grant and do NOT finish — the store fires this
              // listener again with state 'purchased' once payment completes,
              // and that event grants the unlock (possibly on a later launch,
              // via onPurchased).
              settleBuy({ ok: false, reason: 'pending' });
              return;
            }
            // Non-consumable: acknowledge/finish so the store stops retrying.
            m.finishTransaction({ purchase, isConsumable: false }).catch(() => {});
            onPurchased?.(purchaseDateOf(purchase));
            settleBuy({ ok: true });
          });
          m.purchaseErrorListener((error) => {
            settleBuy(
              error?.code === 'user-cancelled'
                ? { ok: false, reason: 'cancelled' }
                : { ok: false, reason: 'error', message: error?.message },
            );
          });
        }
        return ok;
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
      settleBuy({ ok: false, reason: 'error', message: e instanceof Error ? e.message : String(e) });
    });
  });
}

/** Query the store for an existing unlock (Restore Purchases). Never throws. */
export async function restore(): Promise<RestoreResult> {
  const m = iap();
  if (!m || !(await connect())) return { state: 'unavailable' };
  try {
    const purchases = (await m.getAvailablePurchases()) ?? [];
    // getAvailablePurchases can also return pending (unpaid) transactions —
    // only a completed purchase counts as owned.
    const owned = purchases.find(
      (p) => p.productId === UNLOCK_PRODUCT_ID && p.purchaseState !== 'pending',
    );
    if (!owned) return { state: 'none' };
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
