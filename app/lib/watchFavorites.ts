/** Favorite service IDs stay on this phone; no viewing history leaves it. */
import { normalizeFavorites } from './watchFavoriteOrder';
import * as SecureStore from 'expo-secure-store';
import { useSyncExternalStore } from 'react';
import { Platform } from 'react-native';

const KEY = 'couchside.watch.favorites.v1';

let cache: string[] = [];
let loaded = false;
let loading = false;
const listeners = new Set<() => void>();
let writes = Promise.resolve();

function emit() {
  listeners.forEach((l) => l());
}

async function readStore(): Promise<string | null> {
  // SecureStore is unavailable on web, where the harness runs; fall back to
  // localStorage so favorites can actually be exercised there rather than
  // silently doing nothing.
  if (Platform.OS === 'web') {
    try {
      return typeof localStorage === 'undefined' ? null : localStorage.getItem(KEY);
    } catch {
      return null;
    }
  }
  try {
    return await SecureStore.getItemAsync(KEY);
  } catch {
    return null;
  }
}

async function writeStore(value: string): Promise<void> {
  if (Platform.OS === 'web') {
    try {
      if (typeof localStorage !== 'undefined') localStorage.setItem(KEY, value);
    } catch {
      /* storage full or blocked: favorites are a convenience, never an error */
    }
    return;
  }
  try {
    await SecureStore.setItemAsync(KEY, value);
  } catch {
    /* same */
  }
}

/** Drop anything that isn't a well-formed entry rather than half-trusting a
 *  parsed blob — same rule normalizeCaps follows. */
export async function loadFavorites(): Promise<void> {
  if (loaded || loading) return;
  loading = true;
  const raw = await readStore();
  loaded = true;
  loading = false;
  if (!raw) return;
  try {
    cache = normalizeFavorites(JSON.parse(raw));
    emit();
  } catch {
    cache = [];
  }
}

/** Called after hydration by the UI, so a slow initial read cannot erase a tap. */
export function toggleWatchFavorite(service: string): void {
  if (!loaded || !normalizeFavorites([service]).length) return;
  cache = cache.includes(service) ? cache.filter(id => id !== service)
    : normalizeFavorites([...cache, service]);
  emit();
  const value = JSON.stringify(cache);
  writes = writes.then(() => writeStore(value));
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  void loadFavorites();
  return () => listeners.delete(listener);
}

function getSnapshot(): string[] {
  return cache;
}

export function useWatchFavorites(): string[] {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
