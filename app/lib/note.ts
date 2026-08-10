/**
 * The Playlog/game note — one on-device text scratchpad for jotting a clue, a
 * code, or where you left off while a game runs. Owner ask 2026-08-10: "text
 * typing notes would be a big part of the experience."
 *
 * Module-level external store, same shape as lib/prefs.ts and
 * hooks/useLibraryMarks.ts: the Pad's NOTE surface writes while a Setup toggle
 * and (later) other surfaces read, and those are different components — per-hook
 * useState was exactly the bug that made the feature-tour switch look dead.
 *
 * ON DEVICE ONLY. A single GLOBAL note (owner call), never sent to the box — the
 * box has no idea you keep notes and does not need one. Persisted, so a clue you
 * jotted is still there next session; toggling note mode off never erases it.
 *
 * Capped at NOTE_MAX characters: SecureStore (the native backing) is size-limited,
 * so the store truncates rather than silently failing to persist a long note. The
 * TextInput also enforces the same maxLength, so the cap is visible, not a trap.
 */
import * as SecureStore from 'expo-secure-store';
import { useSyncExternalStore } from 'react';
import { Platform } from 'react-native';

const KEY = 'couchside.note.v1';
/** Generous for a jotted clue; bounded because SecureStore is size-limited on iOS. */
export const NOTE_MAX = 4000;

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
      if (typeof window !== 'undefined' && window.localStorage) window.localStorage.setItem(key, value);
    } catch {
      // storage unavailable (private mode): the note lives for this session only
    }
    return;
  }
  await SecureStore.setItemAsync(key, value);
}

let note = '';
let loadStarted = false;
const listeners = new Set<() => void>();

function emit(): void {
  for (const l of listeners) l();
}

/** Read the stored note once. Safe to call repeatedly. Degrades to empty. */
export async function loadNote(): Promise<void> {
  if (loadStarted) return;
  loadStarted = true;
  const raw = await storageGet(KEY);
  if (typeof raw === 'string' && raw.length > 0) {
    note = raw.slice(0, NOTE_MAX);
    emit();
  }
}
void loadNote();

export function getNoteText(): string {
  return note;
}

/** Set the note (autosave). Truncated to NOTE_MAX so a long paste can't silently
 *  fail to persist on native. No-op if unchanged. */
export async function setNoteText(next: string): Promise<void> {
  const v = (next ?? '').slice(0, NOTE_MAX);
  if (v === note) return;
  note = v;
  emit();
  await storageSet(KEY, v);
}

/** Erase the note — a deliberate act, separate from toggling note mode off. */
export async function clearNote(): Promise<void> {
  return setNoteText('');
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

/** React hook: live note text. */
export function useNoteText(): string {
  return useSyncExternalStore(subscribe, () => note, () => note);
}
