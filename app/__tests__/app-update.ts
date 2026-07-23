/**
 * Pure-logic checks for the mobile-app update decision.
 *
 *   node --experimental-strip-types app/__tests__/app-update.ts
 *
 * decideAppUpdate can't run on-device in CI, but the RISK is entirely in the
 * version comparison and the iOS-vs-Android branching — pure logic. iOS
 * compares the marketing string; Android compares versionCode (a monotonic int)
 * because a marketing version can repeat across builds. Everything missing
 * degrades to 'unknown', never a false 'update'.
 *
 * We import only the pure exports; the component itself pulls in react-native and
 * expo-application, so this file must NOT touch those.
 */
import { cmpVersion, decideAppUpdate } from '../lib/appUpdate.ts';

let bad = 0;
function eq(name: string, got: unknown, want: unknown) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}` + (ok ? '' : ` (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`));
  if (!ok) bad++;
}

const IOS = { version: '2.9.21', url: 'ios-url' };
const AND = { versionCode: 55, version: '2.9.21', url: 'and-url' };
const M = { ios: IOS, android: AND };

console.log('cmpVersion');
eq('newer > older', cmpVersion('2.9.21', '2.9.17'), 1);
eq('older < newer', cmpVersion('2.9.9', '2.9.21'), -1);
eq('equal', cmpVersion('2.9.21', '2.9.21'), 0);
// CONTROL: numeric, not lexical — "2.9.9" must be LESS than "2.9.21" even though
// "9" > "2" as strings. This is the classic version-compare bug.
eq('component-wise, not string: 2.9.9 < 2.9.21', cmpVersion('2.9.9', '2.9.21'), -1);
eq('shorter vs longer (2.9 vs 2.9.1)', cmpVersion('2.9', '2.9.1'), -1);

console.log('decideAppUpdate — iOS');
eq('update when store is newer', decideAppUpdate(M, 'ios', '2.9.17', '75'),
   { state: 'update', latest: '2.9.21', url: 'ios-url' });
eq('current when equal', decideAppUpdate(M, 'ios', '2.9.21', '75'), { state: 'current' });
// BOTH states observed — a decision hardwired to "update" would pass the line
// above and nag a fully-updated user forever.
eq('current when app is AHEAD of the manifest (stale manifest)',
   decideAppUpdate(M, 'ios', '2.9.30', '80'), { state: 'current' });

console.log('decideAppUpdate — Android (versionCode)');
eq('update when store vc is higher', decideAppUpdate(M, 'android', '2.9.10', '53'),
   { state: 'update', latest: '2.9.21', url: 'and-url' });
eq('current when vc equal', decideAppUpdate(M, 'android', '2.9.21', '55'), { state: 'current' });
eq('current when vc ahead', decideAppUpdate(M, 'android', '2.9.21', '56'), { state: 'current' });
// versionCode, not marketing: a build whose marketing string LOOKS older but
// whose vc is newer is up to date.
eq('trusts versionCode over the marketing string',
   decideAppUpdate({ ...M, android: { ...AND, version: '2.9.0' } }, 'android', '2.9.99', '99'),
   { state: 'current' });

console.log('decideAppUpdate — degrade closed');
eq('null manifest -> unknown', decideAppUpdate(null, 'ios', '2.9.17', '75'), { state: 'unknown' });
eq('missing current version -> unknown (never a false update)',
   decideAppUpdate(M, 'ios', null, null), { state: 'unknown' });
eq('non-numeric build on android -> unknown',
   decideAppUpdate(M, 'android', '2.9.10', 'not-a-number'), { state: 'unknown' });
eq('unknown platform -> unknown', decideAppUpdate(M, 'web', '2.9.17', '1'), { state: 'unknown' });
eq('manifest missing the url -> unknown (no dead store link)',
   decideAppUpdate({ ios: { version: '2.9.21' } }, 'ios', '2.9.17', '75'), { state: 'unknown' });

console.log(bad ? `\n${bad} FAILED` : '\nall good');
process.exit(bad ? 1 : 0);
