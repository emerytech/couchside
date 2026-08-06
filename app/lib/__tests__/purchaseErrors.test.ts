/**
 * Cancelling a purchase must be silent, and no native exception text may ever
 * reach a user.
 *
 * REPORTED BY A TESTER: backing out of the purchase sheet showed a raw Swift
 * stack trace, at the exact moment they were deciding whether to pay. The
 * cancellation WAS handled — but only on the path that carries a tidy `code`,
 * and this build delivers it as a promise rejection carrying only prose.
 */
import { test } from 'node:test';
import assert from 'node:assert';

import { isUserCancellation, userFacingPurchaseError } from '../purchaseErrors.ts';

// The exact text from the report, verbatim.
const REPORTED = new Error(
  "Calling the 'requestPurchase' function has failed (at ExpoModulesCore/" +
    'ConcurrentFunctionDefinition.swift:88)\n→ Caused by: IapException: User ' +
    'cancelled the purchase flow (at ExpoIap/ExpoIapHelper.swift:18)',
);

test('THE REPORTED CASE is recognised as a cancellation', () => {
  assert.equal(isUserCancellation(REPORTED), true);
});

test('cancellation is caught by code OR by message, both spellings', () => {
  assert.equal(isUserCancellation({ code: 'user-cancelled' }), true);
  assert.equal(isUserCancellation({ code: 'E_USER_CANCELED' }), true);
  assert.equal(isUserCancellation({ message: 'User canceled the purchase flow' }), true);
  assert.equal(isUserCancellation(new Error('The operation was cancelled.')), true);
});

test('a REAL failure is not mistaken for a cancellation (control)', () => {
  // If this ever returns true, genuine failures go silent and the user is left
  // staring at a button that did nothing.
  assert.equal(isUserCancellation(new Error('Network connection lost')), false);
  assert.equal(isUserCancellation({ code: 'E_ALREADY_OWNED' }), false);
  assert.equal(isUserCancellation(null), false);
  assert.equal(isUserCancellation(undefined), false);
});

test('native exception text never reaches the user', () => {
  assert.equal(userFacingPurchaseError(REPORTED.message), 'Purchase failed, try again.');
  assert.equal(
    userFacingPurchaseError('IapException: something at Foo/Bar.swift:12'),
    'Purchase failed, try again.',
  );
  assert.equal(
    userFacingPurchaseError('FunctionCallException: nope'),
    'Purchase failed, try again.',
  );
});

test('a genuinely human message is passed through unchanged (control)', () => {
  // Proves the sanitiser is not just blanking everything.
  assert.equal(
    userFacingPurchaseError('A purchase is already in progress.'),
    'A purchase is already in progress.',
  );
  assert.equal(userFacingPurchaseError(undefined), null);
  assert.equal(userFacingPurchaseError(''), null);
});

// ---- restore, not just buy ----

test('backing out of a RESTORE is a cancellation, not "no purchase found"', () => {
  // Reported from the simulator: tapping Restore Purchases and backing out of
  // the Apple ID sheet showed red "No purchase found on this Apple ID". The app
  // never got to check — asserting it did is how a PAYING customer concludes
  // the app is broken. Restore now has its own 'cancelled' state.
  assert.equal(isUserCancellation(new Error('The operation was cancelled.')), true);
  assert.equal(isUserCancellation({ code: 'E_USER_CANCELLED' }), true);
});

test('a restore that genuinely fails is still an error (control)', () => {
  // The fix must not swallow real failures into silence.
  assert.equal(isUserCancellation(new Error('Cannot connect to iTunes Store')), false);
});
