/**
 * Android writer for the home-screen widget: save the snapshot, then push it to
 * any placed widget. Metro resolves this on Android; iOS/web get the no-op
 * update.ts sibling. The app calls `updateCouchsideWidget(payload)` from
 * platform-neutral code (e.g. the Play tab); it is a no-op wherever there is no
 * widget.
 */
import { requestWidgetUpdate } from 'react-native-android-widget';

import { COUCHSIDE_WIDGET_NAME, renderWidgetFromPayload } from './render';
import { saveWidgetPayload } from './store';
import type { WidgetPayload } from './widgetPayload';

export async function updateCouchsideWidget(payload: WidgetPayload): Promise<void> {
  // Persist first, so a headless re-render (add / resize / periodic) shows the
  // latest even if no widget is currently on the home screen to push to.
  await saveWidgetPayload(payload);
  try {
    await requestWidgetUpdate({
      widgetName: COUCHSIDE_WIDGET_NAME,
      renderWidget: () => renderWidgetFromPayload(payload),
      widgetNotFound: () => {
        // No widget placed — nothing to push; the saved snapshot is enough.
      },
    });
  } catch {
    // Unsupported / no widget host — the snapshot is saved regardless.
  }
}
