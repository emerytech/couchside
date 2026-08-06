/**
 * Fetching + caching the per-appid compatibility ratings. Parsing lives in
 * ./compat.ts and is tested against captured payloads; this file is the part
 * that touches the network.
 *
 * THIS IS THE FIRST TIME THE APP TALKS TO THE PUBLIC INTERNET FOR LIBRARY DATA,
 * and that deserves to be said plainly rather than buried:
 *
 *  - It is OPT-IN and off by default (Prefs > "Look up game compatibility").
 *  - The BOX is never involved and gains no outbound path. Its LAN-only promise
 *    is unchanged; these calls leave the PHONE.
 *  - What is sent: an appid. What is not sent: anything identifying — no
 *    account, no Steam key, no device id, no list of what you played.
 *  - An appid list is still a signal about what you own, which is why this is a
 *    switch the user throws rather than a default someone discovers later.
 *
 * CACHED HARD, on purpose. A Deck rating changes when Valve re-tests a game;
 * a ProtonDB tier moves over weeks. Re-fetching on every scroll would be slow,
 * would burn a free community service's bandwidth for nothing, and is exactly
 * the behaviour that gets a client blocked. 14 days, on device, clearable.
 */
import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';

import { parseDeckStatus, parseProton, UNKNOWN_COMPAT, type Compat } from './compat';

const KEY = 'couchside.compat.v1';
/** Ratings move on the order of weeks; a fortnight is generous and quiet. */
const TTL_MS = 14 * 24 * 60 * 60 * 1000;
/** Politeness cap: a 300-game library must not become 600 simultaneous calls. */
const CONCURRENCY = 4;

type Entry = Compat & { at: number };
type Store = Record<string, Entry>;

let mem: Store | null = null;
const inflight = new Map<number, Promise<Compat>>();

async function storageGet(k: string): Promise<string | null> {
  if (Platform.OS === 'web') {
    try {
      return typeof window !== 'undefined' && window.localStorage ? window.localStorage.getItem(k) : null;
    } catch {
      return null;
    }
  }
  return SecureStore.getItemAsync(k);
}

async function storageSet(k: string, v: string): Promise<void> {
  if (Platform.OS === 'web') {
    try {
      if (typeof window !== 'undefined' && window.localStorage) window.localStorage.setItem(k, v);
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

/** Forget every cached rating. Paired with the opt-out, so turning the feature
 *  off can also remove what it collected rather than merely hiding it. */
export async function clearCompatCache(): Promise<void> {
  mem = {};
  await storageSet(KEY, JSON.stringify(mem));
}

async function getJson(url: string, timeoutMs: number): Promise<unknown | null> {
  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    const res = await fetch(url, { signal: ctl.signal });
    clearTimeout(timer);
    // 404 is the NORMAL answer for a game ProtonDB has never seen — not an
    // error, just "unknown". Anything non-OK degrades the same way.
    if (!res.ok) return null;
    return (await res.json()) as unknown;
  } catch {
    return null;
  }
}

/** One appid, from cache when fresh. Never throws; failure is "unknown". */
export async function fetchCompat(appid: number, timeoutMs = 8000): Promise<Compat> {
  const store = await load();
  const hit = store[String(appid)];
  if (hit && Date.now() - hit.at < TTL_MS) {
    return { deck: hit.deck, proton: hit.proton, protonReports: hit.protonReports };
  }
  const running = inflight.get(appid);
  if (running) return running;

  const job = (async (): Promise<Compat> => {
    const [deckBody, protonBody] = await Promise.all([
      getJson(
        `https://store.steampowered.com/saleaction/ajaxgetdeckappcompatibilityreport?nAppID=${appid}&l=english`,
        timeoutMs,
      ),
      getJson(`https://www.protondb.com/api/v1/reports/summaries/${appid}.json`, timeoutMs),
    ]);
    const proton = parseProton(protonBody);
    const out: Compat = {
      deck: parseDeckStatus(deckBody),
      proton: proton.tier,
      protonReports: proton.reports,
    };
    // Cache even an all-unknown result: re-asking every scroll for a game
    // nobody has rated is the same waste as re-asking for one that is rated.
    const s = await load();
    s[String(appid)] = { ...out, at: Date.now() };
    persist();
    return out;
  })().finally(() => inflight.delete(appid));

  inflight.set(appid, job);
  return job;
}

/**
 * Warm a whole library, `CONCURRENCY` at a time, reporting as it goes.
 *
 * Deliberately incremental: the grid must stay usable while this runs, and a
 * user who scrolls away should not have been blocked on a network call. Cached
 * appids resolve without a request.
 */
export async function fetchCompatMany(
  appids: number[],
  onEach: (appid: number, c: Compat) => void,
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
        onEach(id, await fetchCompat(id));
      } catch {
        onEach(id, UNKNOWN_COMPAT);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, appids.length || 1) }, worker));
}
