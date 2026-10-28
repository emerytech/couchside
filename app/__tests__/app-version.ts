/**
 * Pure-logic checks for the About-row version/build resolution.
 *
 *   node --experimental-strip-types app/__tests__/app-version.ts
 *
 * THE BUG: the About row rendered "Couchside v" with a blank version on Android
 * builds 47/48 despite correct installs. expo-application's native getters
 * return "" (not null) on some builds, and the old `??` chain only falls back on
 * null/undefined — so the empty string passed through. These checks pin the fix:
 * nonEmpty() coerces ""/whitespace to undefined so the app.json fallback runs,
 * and '—' is reached only when every source is genuinely absent.
 *
 * We import only the pure module; appVersion.ts itself pulls in expo-application
 * and react-native, so this file must NOT touch those (same rule as app-update.ts).
 */
import { nonEmpty, resolveAppVersion } from '../lib/resolveAppVersion.ts';

let bad = 0;
function eq(name: string, got: unknown, want: unknown) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}` + (ok ? '' : ` (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`));
  if (!ok) bad++;
}

console.log('nonEmpty');
eq('non-empty string kept', nonEmpty('2.9.79'), '2.9.79');
eq('empty string -> undefined (the bug)', nonEmpty(''), undefined);
eq('whitespace-only -> undefined', nonEmpty('   '), undefined);
eq('null -> undefined', nonEmpty(null), undefined);
eq('undefined -> undefined', nonEmpty(undefined), undefined);
// CONTROL: a non-string (e.g. a number that slipped through a cast) is not a
// usable label and must not be returned verbatim.
eq('number -> undefined', nonEmpty(127 as unknown), undefined);

console.log('resolveAppVersion — version fallback');
// THE BUG, reproduced: empty native version must fall back to app.json, not blank.
eq('empty native version -> expo fallback',
   resolveAppVersion({ nativeVersion: '', expoVersion: '2.9.79', isIos: false }).version,
   '2.9.79');
// CONTROL: the SAME fallback for a genuinely-null native value, proving the
// empty-string case now behaves like the null case the chain already handled.
eq('null native version -> expo fallback (control)',
   resolveAppVersion({ nativeVersion: null, expoVersion: '2.9.79', isIos: false }).version,
   '2.9.79');
// CONTROL opposite state: a real native version is used verbatim, NOT overridden.
eq('present native version wins over expo',
   resolveAppVersion({ nativeVersion: '2.9.80', expoVersion: '2.9.79', isIos: false }).version,
   '2.9.80');
eq('everything absent -> em dash',
   resolveAppVersion({ nativeVersion: '', expoVersion: '', isIos: false }).version,
   '—');

console.log('resolveAppVersion — build fallback + label');
// Android: empty native build must fall back to the app.json versionCode.
eq('Android: empty native build -> expo versionCode',
   resolveAppVersion({ nativeVersion: '2.9.79', nativeBuild: '', expoAndroidVersionCode: 127, isIos: false }),
   { version: '2.9.79', build: '127', label: '2.9.79 (vc 127)' });
// iOS: native build present -> used, and the label says "build", not "vc".
eq('iOS: native build used, label says build',
   resolveAppVersion({ nativeVersion: '2.9.79', nativeBuild: '272', isIos: true }),
   { version: '2.9.79', build: '272', label: '2.9.79 (build 272)' });
// No build anywhere -> bare version label, no empty parens.
eq('no build -> bare version label',
   resolveAppVersion({ nativeVersion: '2.9.79', nativeBuild: '', isIos: true }),
   { version: '2.9.79', build: '', label: '2.9.79' });
// CONTROL: versionCode 0 is a real (if unusual) value and must not be dropped by
// a falsy check — it is not null, so it is used.
eq('Android: versionCode 0 is kept (not treated as absent)',
   resolveAppVersion({ nativeVersion: '2.9.79', nativeBuild: '', expoAndroidVersionCode: 0, isIos: false }),
   { version: '2.9.79', build: '0', label: '2.9.79 (vc 0)' });

console.log(bad ? `\nFAILED: ${bad} check(s)` : '\nall app-version checks passed');
if (bad) process.exit(1);
