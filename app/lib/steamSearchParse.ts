/**
 * Parse Steam's keyless storefront search (store.steampowered.com/api/storesearch).
 * Pure + tested in bare Node against a VERBATIM captured response
 * (__tests__/fixtures/storesearch-halflife.json), so the real API shape is
 * exercised rather than a stub (the ITAD lesson, CLAUDE.md §11.4). Fetching lives
 * in ./steamSearch; this is only the shape.
 *
 * Games only (type === 'app') for v1. Prices are minor units (cents) and are
 * OPTIONAL — free / unreleased / non-app entries carry no price. `discount_percent`
 * is used when present, else derived from initial vs final.
 */
export type StoreSearchItem = {
  appid: string;
  name: string;
  /** cents, or null when the store returned no price (free / unreleased). */
  priceFinal: number | null;
  priceInitial: number | null;
  /** 0 when not on sale or no price. */
  discountPct: number;
  tinyImage: string | null;
};

export function parseStoreSearch(json: unknown): StoreSearchItem[] {
  const d = json as { items?: unknown[] } | null;
  const items = Array.isArray(d?.items) ? (d as { items: unknown[] }).items : [];
  const out: StoreSearchItem[] = [];
  for (const raw of items) {
    const it = (raw ?? {}) as Record<string, unknown>;
    if (it.type !== 'app') continue; // games only for v1
    const id = it.id;
    const name = typeof it.name === 'string' ? it.name.trim() : '';
    if (typeof id !== 'number' || !Number.isFinite(id) || !name) continue;
    const price = (it.price ?? null) as
      | { initial?: number; final?: number; discount_percent?: number }
      | null;
    const initial = price && typeof price.initial === 'number' ? price.initial : null;
    const final = price && typeof price.final === 'number' ? price.final : null;
    let pct =
      price && typeof price.discount_percent === 'number' ? price.discount_percent : 0;
    if (pct <= 0 && initial != null && final != null && initial > final) {
      pct = Math.round(((initial - final) / initial) * 100);
    }
    out.push({
      appid: String(id),
      name,
      priceFinal: final,
      priceInitial: initial,
      discountPct: pct > 0 ? pct : 0,
      tinyImage: typeof it.tiny_image === 'string' ? it.tiny_image : null,
    });
  }
  return out;
}

/** Display price for a search item: "$9.99", "Free", or "" when unknown. */
export function searchPriceLabel(item: StoreSearchItem): string {
  if (item.priceFinal == null) return '';
  if (item.priceFinal === 0) return 'Free';
  return `$${(item.priceFinal / 100).toFixed(2)}`;
}
