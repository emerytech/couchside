/**
 * Best-effort BACKGROUND wishlist price-drop notification (opt-in, OFF by default).
 *
 * What it is: while the app is closed, the OS occasionally wakes a headless JS
 * task; it asks the ACTIVE box (over the LAN, exactly as the on-open banner's
 * fetch does) whether any wishlisted game got cheaper since you last looked, and
 * if so fires ONE local notification. No cloud, no push server, no account.
 *
 * Honest ceiling (the toggle copy says this too):
 *   - LAN-ONLY. Off your home network, or with the box asleep, the fetch just
 *     fails and the run no-ops. So it effectively fires when you're home with the
 *     box up. The reliable path stays opening the app (the Phase 1a banner); this
 *     is a bonus, never a promise.
 *   - OS-THROTTLED. iOS/Android decide when (and whether) to run background work
 *     — "sometime after the interval, if conditions allow," often much later.
 *   - iOS background tasks do not run on the Simulator (real device only).
 *
 * defineTask MUST run at module scope, and this module MUST be imported at the
 * app root (app/_layout.tsx, side-effect import) so the task is registered in
 * BOTH the foreground app and the headless background JS context. All the
 * decision/copy logic lives in the RN-free lib/wishlistNotify.ts (unit-tested);
 * this file is only the native shell.
 */
import * as BackgroundTask from 'expo-background-task';
import * as Notifications from 'expo-notifications';
import * as TaskManager from 'expo-task-manager';
import { Platform } from 'react-native';

import { api } from './api';
import type { ConnSettings } from './api';
import { getPref, loadPrefs, setPref } from './prefs';
import { loadBoxes } from './settings';
import { decideWishlistNotify, wishlistNotifyBody } from './wishlistNotify';

export const WISHLIST_ALERT_TASK = 'couchside-wishlist-alerts';
/** Tag on the notification so the tap handler knows to open the Play tab. */
export const WISHLIST_NOTIFY_KIND = 'wishlist-drop';
const CHANNEL_ID = 'wishlist-drops';
// A FLOOR/hint, not a schedule: the OS runs it when it feels like it (>= 15 min
// on Android; iOS at its own discretion). Twice a day is plenty for a price
// watch and keeps us off the "too chatty, get deprioritised" list.
const MINIMUM_INTERVAL_MIN = 720;

const isNative = Platform.OS !== 'web';

// Show a wishlist notification even if one somehow fires while the app is
// foregrounded. Set once, at module load, on native only.
if (isNative) {
  Notifications.setNotificationHandler({
    handleNotification: async () => ({
      shouldPlaySound: false,
      shouldSetBadge: false,
      shouldShowBanner: true,
      shouldShowList: true,
    }),
  });
}

/** Project the active box into the connection fields the API layer needs, with
 *  NO React context — safe from the headless task. Mirrors SettingsContext's
 *  `settings` projection (the only other copy of this mapping). */
async function activeConn(): Promise<ConnSettings | null> {
  const { boxes, activeBoxId } = await loadBoxes();
  const box = boxes.find((b) => b.id === activeBoxId) ?? boxes[0];
  if (!box || !box.host || !box.token) return null;
  return {
    host: box.host,
    port: box.port,
    token: box.token,
    lastIp: box.lastIp,
    secure: box.secure,
    tlsPort: box.tlsPort,
    pinModulus: box.pinModulus,
  };
}

// --- the headless task. Defined once, at module load (native only). ---
if (isNative) {
  TaskManager.defineTask(WISHLIST_ALERT_TASK, async () => {
    try {
      await loadPrefs();
      if (!getPref('wishlistNotify')) return BackgroundTask.BackgroundTaskResult.Success;

      const settings = await activeConn();
      if (!settings) return BackgroundTask.BackgroundTaskResult.Success;

      const d = await api.steamWishlistAlerts(settings).catch(() => null);
      const action = decideWishlistNotify(d);
      if (action === 'skip') return BackgroundTask.BackgroundTaskResult.Success;

      if (action === 'notify') {
        const count = d!.count ?? 0;
        const low = d!.count_low ?? 0;
        await Notifications.scheduleNotificationAsync({
          content: {
            title: 'Wishlist price drop',
            body: wishlistNotifyBody(count, low),
            data: { kind: WISHLIST_NOTIFY_KIND },
          },
          // Immediate. On Android route it to our channel (ChannelAwareTrigger);
          // on iOS the channel is irrelevant, so a null trigger delivers now.
          trigger: Platform.OS === 'android' ? { channelId: CHANNEL_ID } : null,
        });
      }
      // Move the baseline either way (seed, or after notifying) so the SAME drop
      // is reported once — and so the on-open banner won't double-nag next open.
      await api.steamWishlistAlertsAck(settings).catch(() => {});
      return BackgroundTask.BackgroundTaskResult.Success;
    } catch {
      return BackgroundTask.BackgroundTaskResult.Failed;
    }
  });
}

async function ensureAndroidChannel(): Promise<void> {
  if (Platform.OS !== 'android') return;
  await Notifications.setNotificationChannelAsync(CHANNEL_ID, {
    name: 'Wishlist price drops',
    importance: Notifications.AndroidImportance.DEFAULT,
  });
}

/** Turn the feature ON: ask for notification permission, and ONLY if granted
 *  persist the pref + register the OS task. Returns whether it is now enabled
 *  (false = permission denied; the caller reflects that so the Switch snaps
 *  back). */
export async function enableWishlistNotify(): Promise<boolean> {
  const perm = await Notifications.requestPermissionsAsync();
  if (!perm.granted) {
    await setPref('wishlistNotify', false);
    return false;
  }
  await ensureAndroidChannel();
  await setPref('wishlistNotify', true);
  try {
    await BackgroundTask.registerTaskAsync(WISHLIST_ALERT_TASK, {
      minimumInterval: MINIMUM_INTERVAL_MIN,
    });
  } catch {
    // Registration can fail on a simulator / unsupported device. The pref stays
    // ON so the on-open banner still works and a real device registers on next
    // launch (ensureWishlistTaskRegistered).
  }
  return true;
}

/** Turn the feature OFF: clear the pref and unregister the OS task. */
export async function disableWishlistNotify(): Promise<void> {
  await setPref('wishlistNotify', false);
  try {
    await BackgroundTask.unregisterTaskAsync(WISHLIST_ALERT_TASK);
  } catch {
    // Not registered / unsupported — nothing to undo.
  }
}

/** Re-assert registration on app start when the pref is on (iOS can drop tasks
 *  across launches). Safe no-op when off, on web, or unsupported. */
export async function ensureWishlistTaskRegistered(): Promise<void> {
  if (!isNative) return;
  try {
    await loadPrefs();
    if (!getPref('wishlistNotify')) return;
    await ensureAndroidChannel();
    const already = await TaskManager.isTaskRegisteredAsync(WISHLIST_ALERT_TASK).catch(
      () => false,
    );
    if (!already) {
      await BackgroundTask.registerTaskAsync(WISHLIST_ALERT_TASK, {
        minimumInterval: MINIMUM_INTERVAL_MIN,
      });
    }
  } catch {
    // best-effort
  }
}
