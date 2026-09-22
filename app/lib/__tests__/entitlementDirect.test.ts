/**
 * Direct-edition license gate — source guard for lib/entitlement.ts.
 *
 * entitlement.ts does `import { Platform } from 'react-native'`, so bare Node
 * (this repo's only test runner) cannot execute it — the same reason
 * restoreSync.ts and lanIp.ts are their own import-free modules. The crypto that
 * makes a key unforgeable is fully exercised in license.test.ts. What THIS test
 * pins, by reading the source, is the security-critical WIRING that node can't
 * run here and that a future refactor could silently break:
 *
 *   1. A direct (off-store) build must return from revalidateWithStore BEFORE any
 *      store fail-open. The fail-open unlocks a build whose store is unreachable;
 *      an off-store APK's store is unreachable BY DEFINITION, so reaching the
 *      fail-open would unlock the sideloaded APK for anyone who has the file —
 *      exactly the leak the license key exists to prevent.
 *   2. A stored license must be RE-VERIFIED (signature checked) on every read,
 *      never trusted as a stored flag — else editing storage would forge it.
 *   3. The license check runs before the trial clock, so a keyed build is
 *      unlocked, not merely "trial".
 *
 * This mirrors no-global-buffer.test.ts: guard by reading the source when the
 * runtime can't run it.
 */
import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const src = readFileSync(join(import.meta.dirname, '..', 'entitlement.ts'), 'utf8');

test('IS_DIRECT_BUILD is a per-build flag from EXPO_PUBLIC_DIRECT', () => {
  assert.match(src, /export const IS_DIRECT_BUILD\s*=\s*process\.env\.EXPO_PUBLIC_DIRECT === '1'/);
});

test('revalidateWithStore returns for a direct build BEFORE any store fail-open', () => {
  const fn = src.slice(src.indexOf('export async function revalidateWithStore'));
  const body = fn.slice(0, fn.indexOf('\nexport ', 1) === -1 ? fn.length : fn.indexOf('\nexport ', 1));
  const directGuard = body.indexOf('if (IS_DIRECT_BUILD) return local;');
  assert.ok(directGuard >= 0, 'direct-build early return is missing from revalidateWithStore');
  const firstFailOpen = body.indexOf('unlockedByFallback: true');
  assert.ok(firstFailOpen >= 0, 'expected a fail-open branch to exist to guard against');
  assert.ok(
    directGuard < firstFailOpen,
    'the direct-build return must come BEFORE the store fail-open, or a sideloaded APK unlocks for anyone',
  );
});

test('a stored license is re-verified every read, not trusted as a flag', () => {
  // The read path calls verifyLicenseKey on the stored key rather than checking
  // a boolean, so a hand-edited storage blob cannot unlock.
  assert.match(src, /verifyLicenseKey\(raw\)/);
  const fn = src.slice(src.indexOf('async function verifiedLicenseName'));
  const body = fn.slice(0, fn.indexOf('\n}'));
  assert.match(body, /storageGet\(LICENSE_KEY\)/);
  assert.match(body, /verifyLicenseKey/);
});

test('getEntitlement resolves a valid license before the trial clock', () => {
  const fn = src.slice(src.indexOf('export async function getEntitlement'));
  const licenseCheck = fn.indexOf('verifiedLicenseName()');
  const trialClock = fn.indexOf('firstLaunchMs()');
  assert.ok(licenseCheck >= 0, 'getEntitlement must consult the license');
  assert.ok(trialClock >= 0, 'getEntitlement must still have the trial clock');
  assert.ok(licenseCheck < trialClock, 'the license must be checked before falling through to the trial clock');
});

test('redeemLicenseKey writes nothing when the key is refused', () => {
  const fn = src.slice(src.indexOf('export async function redeemLicenseKey'));
  const body = fn.slice(0, fn.indexOf('\n}'));
  const refuse = body.indexOf('if (!r.ok) return');
  const write = body.indexOf('storageSet(LICENSE_KEY');
  assert.ok(refuse >= 0 && write >= 0);
  assert.ok(refuse < write, 'a refused key must return before any storage write');
});
