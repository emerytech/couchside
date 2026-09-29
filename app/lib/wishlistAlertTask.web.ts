/**
 * Web stub for the background wishlist notifier. The real module
 * (wishlistAlertTask.ts) pulls in expo-background-task / expo-notifications,
 * which have no useful web runtime; Metro resolves THIS file on web so the dev
 * harness (and any web build) stays clean. The toggle still flips the pref here
 * so its UI is exercisable in the harness; nothing actually schedules on web.
 */
import { setPref } from './prefs';

export const WISHLIST_ALERT_TASK = 'couchside-wishlist-alerts';
export const WISHLIST_NOTIFY_KIND = 'wishlist-drop';

export async function enableWishlistNotify(): Promise<boolean> {
  await setPref('wishlistNotify', true);
  return true;
}

export async function disableWishlistNotify(): Promise<void> {
  await setPref('wishlistNotify', false);
}

export async function ensureWishlistTaskRegistered(): Promise<void> {
  // no-op on web
}
