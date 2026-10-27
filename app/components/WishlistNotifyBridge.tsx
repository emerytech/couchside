/**
 * Invisible bridge, mounted native-only (see app/_layout.tsx):
 *   (1) on app start, re-assert the background wishlist-alert task if the user
 *       has it on (iOS drops tasks across some launches);
 *   (2) when a wishlist price-drop notification is tapped — cold-start or warm —
 *       open the Play tab.
 * The notification-response hook has no web runtime, hence native-only.
 */
import * as Notifications from 'expo-notifications';
import { router } from 'expo-router';
import { useEffect } from 'react';

import { ensureWishlistTaskRegistered, WISHLIST_NOTIFY_KIND } from '@/lib/wishlistAlertTask';

export function WishlistNotifyBridge() {
  useEffect(() => {
    void ensureWishlistTaskRegistered();
  }, []);

  // Yields the latest tapped-notification response (survives cold start).
  const last = Notifications.useLastNotificationResponse();
  useEffect(() => {
    const data = last?.notification.request.content.data as { kind?: string } | undefined;
    if (data?.kind === WISHLIST_NOTIFY_KIND) {
      router.navigate('/play');
    }
  }, [last]);

  return null;
}
