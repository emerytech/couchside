/**
 * When may Restore Purchases reconcile with the App Store first? ZERO imports,
 * so the rule is unit-testable on bare Node like lib/lanIp.ts and lib/tvNav.ts.
 *
 * WHY THIS RULE EXISTS. A tester redeemed an App Store promo code for the
 * unlock. Apple confirmed it and it showed in his purchase history — and Restore
 * Purchases reported nothing, leaving the app on "trial expired". A code
 * redeemed in the App Store app is redeemed OUT OF BAND, so the device's local
 * StoreKit entitlement cache does not know about it until it reconciles.
 * `getAvailablePurchases()` reads exactly that cache, so the app was honestly
 * reporting an empty cache over a real entitlement.
 *
 * WHY IT IS A RULE AND NOT JUST "ALWAYS SYNC". The reconcile can prompt for an
 * Apple ID password, and plain `restore()` runs on EVERY COLD START
 * (EntitlementContext -> revalidateWithStore). Syncing there would put a
 * password prompt on every launch — a worse bug than the one being fixed. So the
 * reconcile is gated on the call coming from an explicit user tap, and this
 * predicate is where that gate is written down and tested.
 */

/** What the caller knows at the moment it decides whether to reconcile. */
export type ReconcileFacts = {
  /** react-native Platform.OS. */
  platform: string;
  /** Did a human just tap Restore? Never true on a launch/background path. */
  userInitiated: boolean;
  /** Is expo-iap's restorePurchases actually present? Optional across versions. */
  hasApi: boolean;
};

/**
 * True only when all three hold. Every false case falls through to the plain
 * local read, which is exactly today's behaviour — so this can only ever find
 * MORE than before, never less.
 */
export function shouldReconcileWithStore(f: ReconcileFacts): boolean {
  if (!f.userInitiated) return false; // launch path: never prompt
  if (f.platform !== 'ios') return false; // StoreKit-only concept
  return f.hasApi === true;
}
