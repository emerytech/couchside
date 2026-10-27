/**
 * Pure selection + formatting for the Android home-screen widget.
 *
 * NO react-native / react-native-android-widget import here (the two data types
 * are type-only, erased at runtime), so this is unit-tested off-device
 * (app/__tests__/widget-payload.ts). The native pieces (render.tsx, the task
 * handler, the writer) are thin shells that consume the payload this produces.
 *
 * The widget shows the LAST snapshot the app wrote — no networking in the widget
 * process. So "what the widget says" is entirely this function's output, which
 * is why it is the part worth testing: the pixels are device-only, the bytes are
 * not.
 */
import type { Recommendation, SteamWishlistAlerts, SteamWishlistAlert } from '../api';

/** One line the widget can render. */
export type WidgetLine = { title: string; subtitle: string };
/** A wishlist deal line: game + its dropped price + percent off. */
export type WidgetDeal = { title: string; priceLine: string; pct: number; atLow: boolean };

/** The whole widget snapshot. Written to shared storage; the headless widget
 *  task reads it back and renders. Additive only — never rename/remove a field,
 *  an installed widget may be reading an older snapshot after an app update. */
export type WidgetPayload = {
  tonight: WidgetLine | null;
  deal: WidgetDeal | null;
  updatedAt: number;
  /** true when there is nothing to show yet (fresh install / no Steam data). */
  empty: boolean;
};

export const EMPTY_WIDGET_PAYLOAD: WidgetPayload = {
  tonight: null,
  deal: null,
  updatedAt: 0,
  empty: true,
};

/** "Tonight's pick" from the recommender's primary pick. null when the engine
 *  has nothing (no history / not configured) — the widget then hides the line. */
export function pickTonight(reco: Recommendation | null | undefined): WidgetLine | null {
  if (!reco || !reco.available || !reco.primary) return null;
  const p = reco.primary;
  const name = (p.name || '').trim();
  if (!name) return null;
  // Prefer the engine's own reason; fall back to hours played so the second line
  // is never empty.
  const reason = (p.reason || '').trim();
  const subtitle = reason || (p.hours > 0 ? `${p.hours}h played` : 'Ready to play');
  return { title: name, subtitle };
}

/** Format a minor-unit (cents) price. USD gets a `$`; anything else keeps its
 *  currency code so we never mislabel a foreign price as dollars. */
export function formatCents(cents: number, currency: string): string {
  const major = (cents / 100).toFixed(2);
  return currency === 'USD' ? `$${major}` : `${major} ${currency}`;
}

/** The single best wishlist drop to feature: biggest percent off, ties broken by
 *  the lower absolute price. null when nothing is on sale / not configured. */
export function pickBestDrop(alerts: SteamWishlistAlerts | null | undefined): WidgetDeal | null {
  if (!alerts || !alerts.configured || !alerts.connected) return null;
  const list = alerts.alerts ?? [];
  if (list.length === 0) return null;
  let best: SteamWishlistAlert | null = null;
  for (const a of list) {
    if (!best) { best = a; continue; }
    if (a.discount_percent > best.discount_percent) { best = a; continue; }
    if (a.discount_percent === best.discount_percent && a.final < best.final) best = a;
  }
  if (!best) return null;
  const name = (best.name || '').trim();
  if (!name) return null;
  return {
    title: name,
    priceLine: formatCents(best.final, best.currency || 'USD'),
    pct: best.discount_percent,
    atLow: best.at_low === true,
  };
}

/** Assemble the full snapshot. `now` is injected (not read inside) so the result
 *  is deterministic and testable. */
export function buildWidgetPayload(
  reco: Recommendation | null | undefined,
  alerts: SteamWishlistAlerts | null | undefined,
  now: number,
): WidgetPayload {
  const tonight = pickTonight(reco);
  const deal = pickBestDrop(alerts);
  return { tonight, deal, updatedAt: now, empty: !tonight && !deal };
}
