/**
 * The Restore-Purchases reconcile gate — lib/restoreSync.ts.
 *
 * Run: from app/, `node --experimental-strip-types --test lib/__tests__/*.test.ts`
 * Picked up by the CI app-input glob.
 *
 * THE BUG (user report, 2026-07-28). A tester redeemed an App Store promo code
 * for the unlock. Apple confirmed it and it showed in his purchase history — and
 * Restore Purchases reported nothing, leaving the app on "trial expired". A code
 * redeemed in the App Store app is redeemed OUT OF BAND, so the device's local
 * StoreKit entitlement cache does not know about it until it reconciles.
 * getAvailablePurchases() reads exactly that cache.
 *
 * The fix is to reconcile before reading — but ONLY on an explicit tap, because
 * the reconcile can prompt for an Apple ID password and plain restore() runs on
 * every cold start. Both halves of that are what these tests pin: it must fire
 * for the tap, and it must NOT fire anywhere else.
 *
 * WHY THE GATE IS ITS OWN MODULE. lib/purchase.ts does `import { Platform } from
 * 'react-native'` at the top level, so it cannot be loaded by bare Node — the
 * only test runner this repo has (no jest). Same reason lanIp.ts and tvNav.ts are
 * import-free. Attempting to fake react-native through require's cache does not
 * work either: the static ESM import never goes through Module._load.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { shouldReconcileWithStore } from '../restoreSync.ts';

const TAP = { platform: 'ios', userInitiated: true, hasApi: true };

test('THE BUG: an iOS user tap reconciles — without this a promo code stays invisible', () => {
  assert.equal(shouldReconcileWithStore(TAP), true);
});

test('THE REGRESSION GUARD: a launch-path restore never reconciles', () => {
  // restore() is reached on EVERY cold start (EntitlementContext ->
  // revalidateWithStore). The reconcile can prompt for an Apple ID password, so
  // firing here would be a worse bug than the one being fixed.
  assert.equal(shouldReconcileWithStore({ ...TAP, userInitiated: false }), false);
});

test('Android never reconciles — restorePurchases is an iOS/StoreKit concept', () => {
  assert.equal(shouldReconcileWithStore({ ...TAP, platform: 'android' }), false);
});

test('web never reconciles — there is no native IAP module there at all', () => {
  assert.equal(shouldReconcileWithStore({ ...TAP, platform: 'web' }), false);
});

test('an expo-iap without restorePurchases is skipped, not called', () => {
  // The API is typed optional because older expo-iap lacks it. Calling a missing
  // function would throw inside a path documented as never throwing.
  assert.equal(shouldReconcileWithStore({ ...TAP, hasApi: false }), false);
});

test('CONTROL: not-user-initiated wins even with everything else true', () => {
  // If this ever returned true the suite above could stay green while every
  // cold start prompted for a password. The launch guard is the load-bearing
  // half of the fix, so it gets an input whose answer is known independently.
  for (const platform of ['ios', 'android', 'web']) {
    for (const hasApi of [true, false]) {
      assert.equal(
        shouldReconcileWithStore({ platform, hasApi, userInitiated: false }),
        false,
        `reconciled on a launch path (platform=${platform} hasApi=${hasApi})`,
      );
    }
  }
});

test('CONTROL: the iOS tap is the ONLY true in the whole input space', () => {
  // Proves the predicate is not just "return true" — observe both states, and
  // pin exactly one of the eight combinations as the firing one.
  let fired = 0;
  for (const platform of ['ios', 'android', 'web']) {
    for (const userInitiated of [true, false]) {
      for (const hasApi of [true, false]) {
        if (shouldReconcileWithStore({ platform, userInitiated, hasApi })) fired += 1;
      }
    }
  }
  assert.equal(fired, 1, 'the gate fires on more (or fewer) cases than the iOS Restore tap');
});
