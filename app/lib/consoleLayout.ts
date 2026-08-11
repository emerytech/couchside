/**
 * Console tab card layout — user order + hidden set, persisted.
 *
 * The Console tab renders a fixed set of movable "sections" (NOW PLAYING,
 * GAMING, the vitals block, SCREEN, DISPLAY/AUDIO, UNITS, file drop). This store
 * remembers the user's ORDER (an id list) and which ids they HID, set from the
 * tab's hold-to-edit mode. An external store (same shape as lib/haptics) so a
 * `<Switch>`/arrow tap re-renders live and the pref survives restarts.
 *
 * The stored order is reconciled against the canonical id list at render time
 * (see effectiveOrder): ids no longer known are dropped, new ids appended — so
 * a future card is never lost and a removed one never errors.
 */
import * as SecureStore from 'expo-secure-store';
import { useSyncExternalStore } from 'react';
import { Platform } from 'react-native';

const KEY = 'couchside.consoleLayout.v1';

export type ConsoleLayout = { order: string[]; hidden: string[] };

let layout: ConsoleLayout = { order: [], hidden: [] };
const listeners = new Set<() => void>();
let loadStarted = false;

async function storageGet(key: string): Promise<string | null> {
  if (Platform.OS === 'web') {
    try {
      return typeof window !== 'undefined' && window.localStorage
        ? window.localStorage.getItem(key) : null;
    } catch { return null; }
  }
  return SecureStore.getItemAsync(key);
}
async function storageSet(key: string, value: string): Promise<void> {
  if (Platform.OS === 'web') {
    try { if (typeof window !== 'undefined' && window.localStorage) window.localStorage.setItem(key, value); }
    catch { /* private mode: in-memory this session */ }
    return;
  }
  await SecureStore.setItemAsync(key, value);
}

function emit(): void { for (const l of listeners) l(); }
function persist(): void { void storageSet(KEY, JSON.stringify(layout)); }

export async function loadConsoleLayout(): Promise<void> {
  if (loadStarted) return;
  loadStarted = true;
  const raw = await storageGet(KEY);
  if (!raw) return;
  try {
    const p = JSON.parse(raw) as Partial<ConsoleLayout>;
    if (Array.isArray(p.order) && Array.isArray(p.hidden)
        && p.order.every((x) => typeof x === 'string')
        && p.hidden.every((x) => typeof x === 'string')) {
      layout = { order: p.order, hidden: p.hidden };
      emit();
    }
  } catch { /* corrupt pref: keep defaults */ }
}
void loadConsoleLayout();

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}
function getSnapshot(): ConsoleLayout { return layout; }

/** Live layout pref. New object on every change, so getSnapshot re-renders. */
export function useConsoleLayout(): ConsoleLayout {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

export function setConsoleLayout(next: ConsoleLayout): void {
  layout = { order: [...next.order], hidden: [...next.hidden] };
  emit();
  persist();
}

/**
 * The order to actually render: the stored order filtered to ids that still
 * exist, then any canonical id the user has never ordered appended in its
 * canonical position (so a new card shows near where it was added, not lost).
 */
export function effectiveOrder(stored: string[], canonical: string[]): string[] {
  const known = new Set(canonical);
  const out = stored.filter((id) => known.has(id));
  const seen = new Set(out);
  for (let i = 0; i < canonical.length; i += 1) {
    const id = canonical[i];
    if (seen.has(id)) continue;
    // insert at the canonical index, clamped to the current length
    out.splice(Math.min(i, out.length), 0, id);
    seen.add(id);
  }
  return out;
}

/** Move `id` one step up/down among the CURRENTLY-VISIBLE ids (skips absent). */
export function moveSection(
  order: string[], visible: string[], id: string, dir: -1 | 1,
): string[] {
  const vis = order.filter((x) => visible.includes(x));
  const vi = vis.indexOf(id);
  const target = vis[vi + dir];
  if (vi < 0 || target == null) return order; // at an end
  // swap id and target in the FULL order array
  const out = [...order];
  const a = out.indexOf(id);
  const b = out.indexOf(target);
  [out[a], out[b]] = [out[b], out[a]];
  return out;
}
