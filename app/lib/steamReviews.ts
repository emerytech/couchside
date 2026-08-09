/**
 * Fetching + caching the Steam REVIEW SENTIMENT ("Very Positive", 96%) per appid.
 * Parsing lives in ./steamStoreParse (parseReviewSummary), bare-Node tested; this
 * file is the network + cache half, mirroring lib/steamStore.ts exactly.
 *
 * SAME privacy posture and opt-in as the store/compat lookups (Prefs → game
 * lookups): it leaves the PHONE, never the box, sends one appid and nothing
 * identifying, and hits the same host (store.steampowered.com). It is a SEPARATE
 * request from appdetails, so callers fetch it LAZILY — only for games a surface
 * is actually going to show a review for (e.g. when the Not-installed page's
 * review filter/sort is on), never for the whole library up front.
 *
 * CACHED for 7 days: review sentiment drifts slowly and a week keeps the store's
 * ~200/5min rate limit quiet on a big library.
 */
import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';

import { parseReviewSummary, type SteamReview } from './steamStoreParse';

const KEY = 'couchside.steamreviews.v1';
const TTL_MS = 7 * 24 * 60 * 60 * 1000;
const CONCURRENCY = 3;

type Entry = { r: SteamReview | null; at: number };
type Store = Record<string, Entry>;

let mem: Store | null = null;
const inflight = new Map<number, Promise<SteamReview | null>>();

async function storageGet(k: string): Promise<string | null> {
  if (Platform.OS === 'web') {
    try {
      return typeof window !== 'undefined' && window.localStorage
        ? window.localStorage.getItem(k)
        : null;
    } catch {
      return null;
    }
  }
  return SecureStore.getItemAsync(k);
}

async function storageSet(k: string, v: string): Promise<void> {
  if (Platform.OS === 'web') {
    try {
      if (typeof window !== 'undefined' && window.localStorage) {
        window.localStorage.setItem(k, v);
      }
    } catch { /* memory-only this session */ }
    return;
  }
  await SecureStore.setItemAsync(k, v);
}

async function load(): Promise<Store> {
  if (mem) return mem;
  try {
    const raw = await storageGet(KEY);
    mem = raw ? (JSON.parse(raw) as Store) : {};
  } catch {
    mem = {};
  }
  return mem;
}

function persist(): void {
  if (mem) void storageSet(KEY, JSON.stringify(mem));
}

/** Forget every cached review. Paired with the lookups opt-out. */
export async function clearSteamReviewsCache(): Promise<void> {
  mem = {};
  await storageSet(KEY, JSON.stringify(mem));
}

async function getJson(url: string, timeoutMs: number): Promise<unknown | null> {
  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    const res = await fetch(url, { signal: ctl.signal });
    clearTimeout(timer);
    if (!res.ok) return null;
    return (await res.json()) as unknown;
  } catch {
    return null;
  }
}

/** Review sentiment for one appid, from cache when fresh. Null = no reviews /
 *  unknown (never throws). A resolved-but-null is cached as a tombstone; a
 *  TRANSPORT failure is NOT cached (so a rate-limit doesn't hide it for a week). */
export async function fetchSteamReview(
  appid: number,
  timeoutMs = 8000,
): Promise<SteamReview | null> {
  const store = await load();
  const hit = store[String(appid)];
  if (hit && Date.now() - hit.at < TTL_MS) return hit.r;

  const running = inflight.get(appid);
  if (running) return running;

  const job = (async (): Promise<SteamReview | null> => {
    const body = await getJson(
      `https://store.steampowered.com/appreviews/${appid}`
        + `?json=1&num_per_page=0&language=all&purchase_type=all`,
      timeoutMs,
    );
    if (body === null) return null; // transport failure — do NOT cache
    const r = parseReviewSummary(body);
    const s = await load();
    s[String(appid)] = { r, at: Date.now() };
    persist();
    return r;
  })().finally(() => inflight.delete(appid));

  inflight.set(appid, job);
  return job;
}

/** Resolve a batch, CONCURRENCY at a time, reporting each as it lands. Cached
 *  appids resolve with no request. Aborts cleanly when the caller navigates away. */
export async function fetchSteamReviewsMany(
  appids: number[],
  onEach: (appid: number, r: SteamReview | null) => void,
  signal?: { aborted: boolean },
): Promise<void> {
  let next = 0;
  const worker = async () => {
    for (;;) {
      if (signal?.aborted) return;
      const i = next++;
      if (i >= appids.length) return;
      const id = appids[i];
      try {
        onEach(id, await fetchSteamReview(id));
      } catch {
        onEach(id, null);
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, appids.length || 1) }, worker),
  );
}
