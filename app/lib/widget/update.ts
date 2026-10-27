/**
 * No-op writer for iOS/web — the home-screen widget is Android-only in v1. Metro
 * resolves update.android.ts on Android; everywhere else gets this, so the Play
 * tab can call updateCouchsideWidget() unconditionally without pulling
 * react-native-android-widget into the iOS/web bundle.
 */
import type { WidgetPayload } from './widgetPayload';

export async function updateCouchsideWidget(_payload: WidgetPayload): Promise<void> {
  // Android-only feature; nothing to do on other platforms.
}
