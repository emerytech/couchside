/**
 * Reusable card-layout store — a persisted user ORDER (id list) + HIDDEN set,
 * driving the hold-to-edit reorder/hide mode shared by the Console, Fleet and
 * Actions tabs.
 *
 * Console shipped this first as lib/consoleLayout.ts; this is that exact store,
 * turned into a factory so each tab gets its OWN persisted layout under its own
 * storage key without copying the boilerplate. An external store (same shape as
 * lib/haptics) so an arrow/eye tap re-renders live and the pref survives restart.
 *
 * The stored order is reconciled against the canonical id list at render time
 * (effectiveOrder): ids no longer known are dropped, new ids appended in their
 * canonical position — so a future card is never lost and a removed one never
 * errors. On Fleet the ids are BOX ids (they come and go as you pair/unpair), so
 * that reconciliation is load-bearing there, not just forward-compatibility.
 */
import * as SecureStore from 'expo-secure-store';
import { useSyncExternalStore } from 'react';
import { Platform } from 'react-native';

import type { CardLayout } from './cardOrder';

// Re-export the pure reconciliation helpers so callers keep importing them from
// '@/lib/cardLayout' (they live in the import-free cardOrder module so a
// `node --test` can load them without expo-secure-store — see cardOrder.ts).
export { effectiveOrder, moveSection } from './cardOrder';
export type { CardLayout } from './cardOrder';

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

export type CardLayoutStore = {
  /** Live layout pref (a hook — new object on each change, so it re-renders). */
  useLayout: () => CardLayout;
  /** Replace the layout and persist it. */
  setLayout: (next: CardLayout) => void;
  /** Load the persisted layout once (idempotent). Called at module init; kept
   *  public so a startup path can await it if it ever needs to. */
  load: () => Promise<void>;
};

/** One independent, self-loading layout store bound to `key`. */
export function makeCardLayoutStore(key: string): CardLayoutStore {
  let layout: CardLayout = { order: [], hidden: [] };
  const listeners = new Set<() => void>();
  let loadStarted = false;

  const emit = (): void => { for (const l of listeners) l(); };
  const subscribe = (cb: () => void): (() => void) => {
    listeners.add(cb);
    return () => { listeners.delete(cb); };
  };
  const getSnapshot = (): CardLayout => layout;

  async function load(): Promise<void> {
    if (loadStarted) return;
    loadStarted = true;
    const raw = await storageGet(key);
    if (!raw) return;
    try {
      const p = JSON.parse(raw) as Partial<CardLayout>;
      if (Array.isArray(p.order) && Array.isArray(p.hidden)
          && p.order.every((x) => typeof x === 'string')
          && p.hidden.every((x) => typeof x === 'string')) {
        layout = { order: p.order, hidden: p.hidden };
        emit();
      }
    } catch { /* corrupt pref: keep defaults */ }
  }
  void load();

  return {
    useLayout: () => useSyncExternalStore(subscribe, getSnapshot, getSnapshot),
    setLayout: (next: CardLayout) => {
      layout = { order: [...next.order], hidden: [...next.hidden] };
      emit();
      void storageSet(key, JSON.stringify(layout));
    },
    load,
  };
}
