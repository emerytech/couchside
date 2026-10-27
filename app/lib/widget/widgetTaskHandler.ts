/**
 * The headless task react-native-android-widget calls when a widget is added,
 * updated, resized, clicked, or deleted. Runs in a fresh JS context (app may be
 * closed), so it reads the last snapshot from storage and renders it — no app
 * state, no networking. ANDROID-only: registered from index.android.js.
 *
 * The tap is handled natively (the widget's `OPEN_URI` click action), so
 * WIDGET_CLICK needs nothing here; a re-render on add/update/resize is all the
 * widget requires.
 */
import type { WidgetTaskHandlerProps } from 'react-native-android-widget';

import { renderWidgetFromPayload } from './render';
import { loadWidgetPayload } from './store';

export async function widgetTaskHandler(props: WidgetTaskHandlerProps): Promise<void> {
  switch (props.widgetAction) {
    case 'WIDGET_ADDED':
    case 'WIDGET_UPDATE':
    case 'WIDGET_RESIZED': {
      const payload = await loadWidgetPayload();
      props.renderWidget(renderWidgetFromPayload(payload));
      break;
    }
    // WIDGET_CLICK is served by the native OPEN_URI action; WIDGET_DELETED has
    // nothing to clean up (no per-widget background work).
    default:
      break;
  }
}
