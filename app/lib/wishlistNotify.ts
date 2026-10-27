/**
 * Pure decision + copy for the background wishlist price-drop notification.
 *
 * NO react-native / expo import (the `SteamWishlistAlerts` import is type-only,
 * erased at runtime), so this is unit-tested off-device
 * (app/__tests__/wishlist-notify.ts). The background task
 * (lib/wishlistAlertTask.ts) is a thin native shell around these two functions.
 *
 * decideWishlistNotify mirrors WishlistAlertsBanner's on-open logic EXACTLY so
 * the two paths agree on what a "drop worth surfacing" is:
 *   - primed === false  -> 'seed'   (first look: move the baseline, notify nothing)
 *   - a real drop        -> 'notify' (fire ONE local notification, then ack)
 *   - anything else      -> 'skip'   (not configured/connected, or nothing dropped)
 */
import type { SteamWishlistAlerts } from './api';

export type WishlistNotifyAction = 'skip' | 'seed' | 'notify';

/** What the background run should do with the box's reply. Degrades to 'skip'
 *  on null/unconfigured/disconnected — never a false notification. */
export function decideWishlistNotify(
  d: SteamWishlistAlerts | null | undefined,
): WishlistNotifyAction {
  if (!d || !d.configured || !d.connected) return 'skip';
  // First look ever: seed the baseline silently (same as the on-open banner).
  // Never a "everything you own just dropped" burst on the first background run.
  if (d.primed === false) return 'seed';
  if (d.count && d.count > 0) return 'notify';
  return 'skip';
}

/** The one-line notification body. Matches the on-open banner's wording so the
 *  two never contradict each other. Counts are game counts (not prices). */
export function wishlistNotifyBody(count: number, countLow: number): string {
  const games = `${count} wishlist ${count === 1 ? 'game' : 'games'} dropped`;
  return countLow > 0 ? `${games} · ${countLow} at an all-time low` : games;
}
