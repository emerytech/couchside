/**
 * Pure-logic checks for the BACKGROUND wishlist price-drop notifier's decision
 * and copy. The native task (lib/wishlistAlertTask.ts) is a thin shell around
 * these two functions, so the RISK — deciding WHEN to fire, and never firing a
 * false one — is testable off-device here.
 *
 *   node --experimental-strip-types app/__tests__/wishlist-notify.ts
 *
 * We import only the RN-free module; the `SteamWishlistAlerts` type it uses is
 * erased at runtime, so nothing pulls in react-native/expo.
 */
import { decideWishlistNotify, wishlistNotifyBody } from '../lib/wishlistNotify.ts';

let bad = 0;
function eq(name: string, got: unknown, want: unknown) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}` + (ok ? '' : ` (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`));
  if (!ok) bad++;
}

console.log('decideWishlistNotify — both states observed (§11.2)');
// NOTIFY: configured + connected + primed + a real drop.
eq('drop -> notify', decideWishlistNotify({ configured: true, connected: true, primed: true, count: 2, count_low: 1 }), 'notify');
eq('drop, primed omitted (true by absence of false) -> notify', decideWishlistNotify({ configured: true, connected: true, count: 1 }), 'notify');
// SEED: the first look ever (primed:false) — move the baseline, notify nothing,
// even though counts are present. The control that proves we don't burst on run 1.
eq('first look primed:false -> seed (NOT notify) even with a count', decideWishlistNotify({ configured: true, connected: true, primed: false, count: 5, count_low: 3 }), 'seed');
// SKIP: every degrade path. None of these may ever become a notification.
eq('null -> skip', decideWishlistNotify(null), 'skip');
eq('undefined -> skip', decideWishlistNotify(undefined), 'skip');
eq('not configured -> skip', decideWishlistNotify({ configured: false }), 'skip');
eq('configured but not connected (off-LAN) -> skip', decideWishlistNotify({ configured: true, connected: false, count: 9 }), 'skip');
eq('connected, primed, but zero drops -> skip', decideWishlistNotify({ configured: true, connected: true, primed: true, count: 0 }), 'skip');
eq('connected, primed, count missing -> skip', decideWishlistNotify({ configured: true, connected: true, primed: true }), 'skip');

console.log('wishlistNotifyBody — copy matches the on-open banner wording');
eq('plural + some at low', wishlistNotifyBody(3, 1), '3 wishlist games dropped · 1 at an all-time low');
eq('singular game', wishlistNotifyBody(1, 0), '1 wishlist game dropped');
eq('plural, none at low (no trailing clause)', wishlistNotifyBody(4, 0), '4 wishlist games dropped');

console.log(bad ? `\n${bad} FAILED` : '\nall good');
process.exit(bad ? 1 : 0);
