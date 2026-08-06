/**
 * Purchase error interpretation. ZERO imports, so it is testable in bare Node —
 * lib/purchase.ts pulls in expo-iap and cannot load in the test runner, which is
 * exactly why this bug shipped untested.
 *
 */
/**
 * Did the user simply back out of the purchase sheet?
 *
 * REPORTED BY A TESTER: cancelling showed them a raw Swift stack trace —
 *   FunctionCallException: Calling the 'requestPurchase' function has failed
 *   (at ExpoModulesCore/ConcurrentFunctionDefinition.swift:88)
 *   → Caused by: IapException: User cancelled the purchase flow
 * — at the exact moment they were deciding whether to pay. Backing out is a
 * normal choice, not a failure, and must produce no message at all.
 *
 * It reaches us TWO ways and only one was handled: `purchaseErrorListener` with
 * a tidy `code`, and — on this expo-iap version — a REJECTION of
 * requestPurchase() carrying only that prose. So the code check alone missed it.
 * Both spellings of "cancelled" appear across Apple/Google/expo-iap, hence the
 * loose match.
 */
export function isUserCancellation(e: unknown): boolean {
  const err = e as { code?: unknown; message?: unknown } | null;
  const code = typeof err?.code === 'string' ? err.code.toLowerCase() : '';
  if (code.includes('cancel')) return true;
  const msg = typeof err?.message === 'string' ? err.message : String(e ?? '');
  return /cancell?ed/i.test(msg);
}

/**
 * A message safe to show a human, or null to say nothing.
 *
 * Native exception text is not user-facing: a Swift file and line number tells
 * someone nothing they can act on and makes a working app look broken. Anything
 * that smells like an exception or stack frame is replaced.
 */
export function userFacingPurchaseError(raw: string | undefined): string | null {
  if (!raw) return null;
  const looksInternal =
    /Exception|\.swift:|\.kt:|\.java:|at [A-Za-z]+\/|→ Caused by/i.test(raw);
  if (looksInternal) return 'Purchase failed, try again.';
  return raw;
}
