/**
 * The Android home-screen widget's JSX (react-native-android-widget). ANDROID
 * ONLY — imported solely by the widget task handler and the Android writer
 * (update.android.ts), so this module never loads on iOS/web. It renders a
 * WidgetPayload; all the selection logic is in the RN-free widgetPayload.ts.
 *
 * The widget shows the last snapshot the app wrote — no networking here. Tapping
 * anywhere opens the app on the Play tab via the `couchside://play` deep link.
 * Fixed dark palette (the widget can't read the app's live theme); Couchside is
 * dark-first, so one theme is honest rather than a half-working light variant.
 */
import React from 'react';
import { FlexWidget, TextWidget } from 'react-native-android-widget';

import type { WidgetPayload } from './widgetPayload';

export const COUCHSIDE_WIDGET_NAME = 'CouchsideWidget';
/** Tapping the widget lands on the Play tab (falls back to just opening the app
 *  if the route can't be resolved). */
const OPEN_PLAY = { clickAction: 'OPEN_URI', clickActionData: { uri: 'couchside://play' } } as const;

const C = {
  bg: '#0b1220' as const,
  eyebrow: '#7c8aa5' as const,
  text: '#e8edf5' as const,
  dim: '#9aa7bd' as const,
  amber: '#f5b301' as const,
  green: '#7ee787' as const,
};

export function renderWidgetFromPayload(payload: WidgetPayload): React.JSX.Element {
  return (
    <FlexWidget
      {...OPEN_PLAY}
      style={{
        height: 'match_parent',
        width: 'match_parent',
        backgroundColor: C.bg,
        borderRadius: 20,
        padding: 14,
        flexDirection: 'column',
        justifyContent: 'center',
      }}
    >
      <TextWidget
        text="COUCHSIDE"
        style={{ color: C.eyebrow, fontSize: 10, fontWeight: '700', letterSpacing: 2 }}
      />

      {payload.tonight ? (
        <FlexWidget style={{ width: 'match_parent', flexDirection: 'column', marginTop: 6 }}>
          <TextWidget
            text={`Tonight · ${payload.tonight.title}`}
            maxLines={1}
            truncate="END"
            style={{ color: C.text, fontSize: 16, fontWeight: '700' }}
          />
          <TextWidget
            text={payload.tonight.subtitle}
            maxLines={1}
            truncate="END"
            style={{ color: C.dim, fontSize: 12, marginTop: 2 }}
          />
        </FlexWidget>
      ) : (
        <TextWidget
          text="Open Couchside to see what to play"
          maxLines={2}
          style={{ color: C.dim, fontSize: 13, marginTop: 6 }}
        />
      )}

      {payload.deal ? (
        <TextWidget
          text={`🏷 ${payload.deal.title}  −${payload.deal.pct}%  ${payload.deal.priceLine}${payload.deal.atLow ? '  · low' : ''}`}
          maxLines={1}
          truncate="END"
          style={{ color: C.amber, fontSize: 12, fontWeight: '600', marginTop: 8 }}
        />
      ) : null}
    </FlexWidget>
  );
}
