/**
 * Persist the last widget snapshot so the headless widget task (which runs in a
 * fresh JS context with no app state) can render it. ANDROID-only in practice —
 * only the writer and the task handler touch it. SecureStore is the app's
 * existing persistence layer and works in the headless task; every access is
 * wrapped so a read/write failure degrades to the empty snapshot rather than
 * throwing inside the widget process.
 */
import * as SecureStore from 'expo-secure-store';

import { EMPTY_WIDGET_PAYLOAD, type WidgetPayload } from './widgetPayload';

const KEY = 'couchside.widget.payload.v1';

export async function saveWidgetPayload(payload: WidgetPayload): Promise<void> {
  try {
    await SecureStore.setItemAsync(KEY, JSON.stringify(payload));
  } catch {
    // best-effort: a failed write just means the widget keeps its last snapshot
  }
}

export async function loadWidgetPayload(): Promise<WidgetPayload> {
  try {
    const raw = await SecureStore.getItemAsync(KEY);
    if (!raw) return EMPTY_WIDGET_PAYLOAD;
    const parsed = JSON.parse(raw) as WidgetPayload;
    // Trust but verify the shape enough to render safely.
    return {
      tonight: parsed.tonight ?? null,
      deal: parsed.deal ?? null,
      updatedAt: typeof parsed.updatedAt === 'number' ? parsed.updatedAt : 0,
      empty: !!parsed.empty,
    };
  } catch {
    return EMPTY_WIDGET_PAYLOAD;
  }
}
