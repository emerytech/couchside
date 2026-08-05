/**
 * Persistence + external store for directly-driven TVs (remote-only mode).
 *
 * Same shape as lib/prefs.ts — a module-scope value, a listener set, and a
 * useSyncExternalStore hook — rather than a React context, because the remote
 * screen, the Setup card and the tab layout all need it and none of them owns
 * the others. Storage is SecureStore on native / localStorage on web, matching
 * lib/settings.ts (a TV host is not a secret, but using one storage wrapper
 * means one set of failure modes).
 *
 * All validation lives in ./model.ts, which is import-free and tested; this
 * file is only plumbing.
 */
import * as Network from 'expo-network';
import * as SecureStore from 'expo-secure-store';
import { useSyncExternalStore } from 'react';
import { Platform } from 'react-native';

import {
  DirectBrand,
  DirectTv,
  DirectTvState,
  EMPTY_TV_STATE,
  activeTv,
  nextTvId,
  normalizeTvState,
} from './model.ts';
import { sweepCandidates, sweepForRokus, type FoundTv } from './scan.ts';

export type { FoundTv } from './scan.ts';

/**
 * Sweep the phone's /24 for TVs the app can drive directly. Resolves [] (never
 * throws) when the phone has no usable LAN address — cellular, VPN'd, or the
 * web harness — and the card renders that as "couldn't scan", not as a crash.
 * expo-network is read HERE rather than in scan.ts so the sweep logic itself
 * stays import-free for the bare-Node tests.
 */
export async function scanForTvs(
  onFound?: (tv: FoundTv) => void,
  signal?: { aborted: boolean },
): Promise<FoundTv[]> {
  let ip: string | undefined;
  try {
    ip = (await Network.getIpAddressAsync()) ?? undefined;
  } catch {
    ip = undefined;
  }
  return sweepForRokus(sweepCandidates(ip), { onFound, signal });
}

const KEY = 'couchside.tvs.v1';

async function storageGet(key: string): Promise<string | null> {
  if (Platform.OS === 'web') {
    try {
      return typeof window !== 'undefined' && window.localStorage
        ? window.localStorage.getItem(key)
        : null;
    } catch {
      return null;
    }
  }
  return SecureStore.getItemAsync(key);
}

async function storageSet(key: string, value: string): Promise<void> {
  if (Platform.OS === 'web') {
    try {
      if (typeof window !== 'undefined' && window.localStorage) {
        window.localStorage.setItem(key, value);
      }
    } catch {
      // storage unavailable (private mode): TVs live in memory this session
    }
    return;
  }
  await SecureStore.setItemAsync(key, value);
}

let state: DirectTvState = EMPTY_TV_STATE;
let ready = false;
const listeners = new Set<() => void>();

function emit(): void {
  for (const l of listeners) l();
}

async function persist(): Promise<void> {
  await storageSet(KEY, JSON.stringify(state));
}

let loadStarted = false;
/** Load persisted TVs once. Safe to call repeatedly; never throws. */
export async function loadTvs(): Promise<void> {
  if (loadStarted) return;
  loadStarted = true;
  const raw = await storageGet(KEY);
  if (raw != null) {
    try {
      state = normalizeTvState(JSON.parse(raw));
    } catch {
      // malformed blob: stay empty rather than guessing
    }
  }
  ready = true;
  emit();
}
// Kicked off at import, like prefs, so the first render has real data.
void loadTvs();

export function getTvState(): DirectTvState {
  return state;
}

/** Add a TV and make it active. Returns the stored record, or null if the host
 *  was refused (see model.isValidTvHost — LAN IP literals only). */
export async function addTv(input: {
  name: string;
  brand: DirectBrand;
  host: string;
}): Promise<DirectTv | null> {
  const existing = state.tvs.find((t) => t.brand === input.brand && t.host === input.host);
  if (existing) {
    // Re-adding a known TV selects it rather than duplicating it.
    state = { ...state, activeTvId: existing.id };
    emit();
    await persist();
    return existing;
  }
  const candidate = {
    id: nextTvId(state.tvs),
    name: input.name,
    brand: input.brand,
    host: input.host,
  };
  // Validate through the same normalizer the persisted blob goes through, so an
  // entry can never enter the store by a path the load path would reject.
  const next = normalizeTvState({ tvs: [...state.tvs, candidate], activeTvId: candidate.id });
  const stored = next.tvs.find((t) => t.id === candidate.id) ?? null;
  if (!stored) return null;
  state = next;
  emit();
  await persist();
  return stored;
}

export async function removeTv(id: string): Promise<void> {
  const tvs = state.tvs.filter((t) => t.id !== id);
  state = normalizeTvState({ tvs, activeTvId: state.activeTvId });
  emit();
  await persist();
}

export async function selectTv(id: string): Promise<void> {
  if (!state.tvs.some((t) => t.id === id)) return;
  state = { ...state, activeTvId: id };
  emit();
  await persist();
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

/** Live TV list + active id + whether the load has finished. */
export function useTvs(): DirectTvState & { ready: boolean; active: DirectTv | null } {
  const s = useSyncExternalStore(
    subscribe,
    () => state,
    () => state,
  );
  const r = useSyncExternalStore(
    subscribe,
    () => ready,
    () => ready,
  );
  return { ...s, ready: r, active: activeTv(s) };
}
