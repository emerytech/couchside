/**
 * The two things the user marks on their own library: BOOKMARKS ("come back to
 * this") and saved FILTER PRESETS. Phase 1 and 4 of
 * docs/memory/project_library-triage.md.
 *
 * Module-level external store — the same shape as lib/prefs.ts, lib/haptics.ts
 * and hooks/useFeatureTour.ts. It has to be: the filter sheet writes a preset
 * while the Launch grid reads the bookmark set, and those are different
 * components. Per-hook useState was exactly the bug that made the feature-tour
 * switch look dead.
 *
 * ON DEVICE ONLY. Nothing here leaves the phone, and neither list is sent to
 * the box — the box has no idea which of your games you starred, and does not
 * need one.
 *
 * DEGRADES TO EMPTY, NEVER TO A GUESS. A storage read that fails or a blob that
 * cannot be parsed yields no marks rather than a partial set: showing someone
 * three of their eleven bookmarks is worse than showing none, because only one
 * of those looks like a bug.
 */
import * as SecureStore from 'expo-secure-store';
import { useCallback, useSyncExternalStore } from 'react';
import { Platform } from 'react-native';

import {
  normalizePresets,
  removePreset,
  toggleBookmark,
  upsertPreset,
  type FilterPreset,
  type FilterState,
} from '@/lib/libraryFilter';

const BOOKMARKS_KEY = 'couchside.bookmarks.v1';
const PRESETS_KEY = 'couchside.filterPresets.v1';

async function get(k: string): Promise<string | null> {
  if (Platform.OS === 'web') {
    try {
      return typeof window !== 'undefined' && window.localStorage ? window.localStorage.getItem(k) : null;
    } catch {
      return null;
    }
  }
  return SecureStore.getItemAsync(k);
}

async function set(k: string, v: string): Promise<void> {
  if (Platform.OS === 'web') {
    try {
      if (typeof window !== 'undefined' && window.localStorage) window.localStorage.setItem(k, v);
    } catch {
      // storage unavailable: the marks live for this session only
    }
    return;
  }
  await SecureStore.setItemAsync(k, v);
}

type Snapshot = {
  /** Bookmark keys — see bookmarkKey() in lib/libraryFilter.ts. */
  bookmarks: ReadonlySet<string>;
  presets: readonly FilterPreset[];
  /** False until storage has been read. */
  ready: boolean;
};

let snap: Snapshot = { bookmarks: new Set(), presets: [], ready: false };
const listeners = new Set<() => void>();

function commit(next: Snapshot): void {
  // New object every time: useSyncExternalStore compares by identity.
  snap = next;
  for (const l of listeners) l();
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

const getSnapshot = () => snap;

let loadStarted = false;
/** Read both lists once. Safe to call repeatedly. */
export async function loadLibraryMarks(): Promise<void> {
  if (loadStarted) return;
  loadStarted = true;
  let bookmarks: string[] = [];
  let presets: FilterPreset[] = [];
  try {
    const raw = await get(BOOKMARKS_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    if (Array.isArray(parsed)) bookmarks = parsed.filter((k): k is string => typeof k === 'string');
  } catch {
    bookmarks = [];
  }
  try {
    const raw = await get(PRESETS_KEY);
    presets = normalizePresets(raw ? JSON.parse(raw) : []);
  } catch {
    presets = [];
  }
  commit({ bookmarks: new Set(bookmarks), presets, ready: true });
}
void loadLibraryMarks();

/** Star or un-star one game. `key` comes from bookmarkKey(). */
export function toggleBookmarked(key: string): void {
  const next = toggleBookmark([...snap.bookmarks], key);
  commit({ ...snap, bookmarks: new Set(next), ready: true });
  void set(BOOKMARKS_KEY, JSON.stringify(next));
}

export function savePreset(name: string, filter: FilterState): void {
  const next = upsertPreset(snap.presets, name, filter);
  commit({ ...snap, presets: next, ready: true });
  void set(PRESETS_KEY, JSON.stringify(next));
}

export function deletePreset(name: string): void {
  const next = removePreset(snap.presets, name);
  commit({ ...snap, presets: next, ready: true });
  void set(PRESETS_KEY, JSON.stringify(next));
}

export function useLibraryMarks() {
  const s = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  return {
    bookmarks: s.bookmarks,
    presets: s.presets,
    ready: s.ready,
    isBookmarked: useCallback((key: string | null) => (key ? s.bookmarks.has(key) : false), [s.bookmarks]),
  };
}
