/**
 * Keyless Steam store SEARCH from the phone. SAME posture as lib/steamStore /
 * lib/compatFetch (read those first): this leaves the PHONE, never the box; the
 * box's LAN-only promise is unchanged. It is gated by the caller on the SAME
 * opt-in the other store lookups use (Prefs > game lookups / `compatLookups`),
 * because it hits the same host (store.steampowered.com).
 *
 * What is sent: the SEARCH TERM the user typed + a country code, to Steam. What
 * is NOT sent: anything identifying — no account, no Steam key, no device id, no
 * library. A search term is more revealing than an appid, which is exactly why
 * this rides the explicit opt-in and is user-initiated (you type and submit),
 * never a background probe. Parsing lives in ./steamSearchParse (tested).
 */
import { parseStoreSearch, type StoreSearchItem } from './steamSearchParse';

const ENDPOINT = 'https://store.steampowered.com/api/storesearch/';

/** Run one search. Returns [] on empty input, a non-OK response, or any network
 *  error — Discover degrades to "no results", never throws into the UI. */
export async function searchSteamStore(
  term: string,
  cc = 'US',
  signal?: AbortSignal,
): Promise<StoreSearchItem[]> {
  const q = term.trim();
  if (!q) return [];
  const url = `${ENDPOINT}?term=${encodeURIComponent(q)}&cc=${encodeURIComponent(cc)}&l=en`;
  try {
    const res = await fetch(url, { signal, headers: { Accept: 'application/json' } });
    if (!res.ok) return [];
    return parseStoreSearch(await res.json());
  } catch {
    return [];
  }
}

export type { StoreSearchItem };
