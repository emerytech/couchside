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
import { reorderWithinSubset } from '@/lib/playlogReorder';

const BOOKMARKS_KEY = 'couchside.bookmarks.v1';
const PRESETS_KEY = 'couchside.filterPresets.v1';
// Now-playing rows the user has cleared ("I'm done with this for now"). Each
// entry is `${bookmarkKey}@${last_played}`, so it hides that game only until the
// box reports a NEWER last_played — play it again and it re-surfaces on its own.
// A dismissal is never a permanent block, which is why it degrades to "shown".
const NP_HIDDEN_KEY = 'couchside.nowPlayingHidden.v1';
// Keep at most this many dismissals — one per game normally, plus a few dead
// keys from games that were replayed and re-cleared. Far above any real usage.
const NP_HIDDEN_MAX = 300;

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
  /** Cleared Now-playing rows, keyed `${bookmarkKey}@${last_played}`. */
  hiddenNowPlaying: ReadonlySet<string>;
  /** False until storage has been read. */
  ready: boolean;
};

let snap: Snapshot = {
  bookmarks: new Set(), presets: [], hiddenNowPlaying: new Set(), ready: false,
};
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
  let hiddenNowPlaying: string[] = [];
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
  try {
    const raw = await get(NP_HIDDEN_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    if (Array.isArray(parsed)) hiddenNowPlaying = parsed.filter((k): k is string => typeof k === 'string');
  } catch {
    hiddenNowPlaying = [];
  }
  commit({
    bookmarks: new Set(bookmarks), presets,
    hiddenNowPlaying: new Set(hiddenNowPlaying), ready: true,
  });
}
void loadLibraryMarks();

/** Star or un-star one game. `key` comes from bookmarkKey(). */
export function toggleBookmarked(key: string): void {
  const next = toggleBookmark([...snap.bookmarks], key);
  commit({ ...snap, bookmarks: new Set(next), ready: true });
  void set(BOOKMARKS_KEY, JSON.stringify(next));
}

/** Persist a new ORDER for the existing bookmarks — the Playlog queue order. The
 *  bookmark set is stored as an ordered array (a JS Set iterates in insertion
 *  order), so a "reorder" just rewrites that array. `orderedKeys` may name only
 *  the games currently ON SCREEN (installed and owned-but-uninstalled arrive on
 *  different polls); reorderWithinSubset permutes only those slots and leaves
 *  every off-screen bookmark exactly where it was, so a reorder can NEVER add,
 *  drop, or relocate an unshown game — only move a shown one. */
export function reorderBookmarks(orderedKeys: string[]): void {
  const next = reorderWithinSubset([...snap.bookmarks], orderedKeys);
  commit({ ...snap, bookmarks: new Set(next), ready: true });
  void set(BOOKMARKS_KEY, JSON.stringify(next));
}

/** Clear a Now-playing row. `compositeKey` is `${bookmarkKey}@${last_played}` so
 *  the game re-appears on its own once the box reports a newer play. Bounded: a
 *  replay makes the previous entry dead weight, so only the most recent
 *  NP_HIDDEN_MAX are kept — the tail can never grow without limit. */
export function dismissNowPlaying(compositeKey: string): void {
  if (snap.hiddenNowPlaying.has(compositeKey)) return;
  let next = [...snap.hiddenNowPlaying, compositeKey];
  if (next.length > NP_HIDDEN_MAX) next = next.slice(next.length - NP_HIDDEN_MAX);
  commit({ ...snap, hiddenNowPlaying: new Set(next), ready: true });
  void set(NP_HIDDEN_KEY, JSON.stringify(next));
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
    hiddenNowPlaying: s.hiddenNowPlaying,
    ready: s.ready,
    isBookmarked: useCallback((key: string | null) => (key ? s.bookmarks.has(key) : false), [s.bookmarks]),
  };
}
