/**
 * Fetching + caching Steam store metadata (name + type) per appid. Parsing lives in
 * ./steamStoreParse and is tested in bare Node; this file is the part that touches
 * the network.
 *
 * SAME posture as lib/compatFetch (read that first): this leaves the PHONE, never
 * the box; it is gated by the caller on the SAME opt-in the compat lookups use
 * (Prefs > game lookups), because it hits the same host (store.steampowered.com)
 * and an appid list is a signal about what you own. What is sent is one appid; what
 * is not sent is anything identifying — no account, no Steam key, no device id.
 *
 * CACHED HARD: a game's name and type essentially never change, so this caches for
 * 30 days on device, clearable. Re-asking the store on every scroll would be slow
 * and would burn Valve's rate limit (~200 requests / 5 min) for nothing.
 */
import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';

import { parseAppDetails, type AppDetails } from './steamStoreParse';

const KEY = 'couchside.steamstore.v1';
/** Names/types are effectively static; a month is generous and quiet. */
const TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** Politeness cap against Valve's rate limit — a big library resolves in waves. */
const CONCURRENCY = 3;

type Entry = AppDetails & { at: number };
type Store = Record<string, Entry>;

let mem: Store | null = null;
const inflight = new Map<number, Promise<AppDetails | null>>();

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
    } catch {
      // storage unavailable: the cache lives in memory for this session
    }
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

/** Forget every cached name/type. Paired with the lookups opt-out. */
export async function clearSteamStoreCache(): Promise<void> {
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

/** Name + type for one appid, from cache when fresh. Null = unknown (never throws).
 *  A null is cached too, so an app the store won't describe is not re-asked every
 *  scroll — stored as a tombstone with an empty name that load() treats as a miss
 *  only after the TTL. */
export async function fetchAppDetails(
  appid: number,
  timeoutMs = 8000,
): Promise<AppDetails | null> {
  const store = await load();
  const hit = store[String(appid)];
  if (hit && Date.now() - hit.at < TTL_MS) {
    return hit.name ? { name: hit.name, type: hit.type } : null;
  }
  const running = inflight.get(appid);
  if (running) return running;

  const job = (async (): Promise<AppDetails | null> => {
    const body = await getJson(
      `https://store.steampowered.com/api/appdetails?appids=${appid}&filters=basic`,
      timeoutMs,
    );
    const out = parseAppDetails(appid, body);
    const s = await load();
    // Cache the miss as a tombstone (empty name) so it isn't re-fetched constantly.
    s[String(appid)] = { name: out?.name ?? '', type: out?.type ?? '', at: Date.now() };
    persist();
    return out;
  })().finally(() => inflight.delete(appid));

  inflight.set(appid, job);
  return job;
}

/**
 * Resolve a batch, `CONCURRENCY` at a time, reporting each as it lands so the grid
 * fills in progressively and stays usable while it runs. Cached appids resolve with
 * no request. Aborts cleanly when the caller navigates away.
 */
export async function fetchAppDetailsMany(
  appids: number[],
  onEach: (appid: number, d: AppDetails | null) => void,
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
        onEach(id, await fetchAppDetails(id));
      } catch {
        onEach(id, null);
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, appids.length || 1) }, worker),
  );
}
