/**
 * "Did you know" tips — the light-touch answer to "I never knew it could do
 * that" (App Store review, 2026-08-30).
 *
 * The full feature tour is sixteen modals on day one, and most people skip it —
 * so the features it describes stay undiscovered. A tip is the opposite shape:
 * ONE short line, delivered on the tab it belongs to, only while the thing it
 * describes is actually on screen, at most once a day, and each one once, ever.
 * It is the mechanism that lets the tour shrink: the long tail of tour steps
 * becomes hints that arrive when they are relevant.
 *
 * RULES (all enforced here or in components/TipToast.tsx — they are what keep
 * this from becoming the busyness it exists to reduce):
 *   - once per app session, and at most one per calendar day (persisted);
 *   - each tip shown ONCE EVER, then forgotten (persisted seen-set);
 *   - only on its own tab, and only when its anchor MEASURES on screen — never
 *     describe a control the user cannot see (the tour's rule, kept);
 *   - never over the tour, the tour's thank-you, or when the pref is off;
 *   - gated by the EXISTING `featureTour` pref ("onboarding hints") — no new
 *     switch to find.
 *
 * Same module-level external-store shape as hooks/useTourThanks.ts: written by
 * the toast, readable by anything, and a reset is observed live.
 */
import * as SecureStore from 'expo-secure-store';
import { useSyncExternalStore } from 'react';
import { Platform } from 'react-native';

import type { TourTab } from './tour';

export type Tip = {
  id: string;
  /** Tab the tip belongs to; shown only while that tab is on screen. 'any' =
   *  wherever the user happens to be. */
  tab: TourTab | 'any';
  /** Element the tip is about ("Show me" scrolls to it). When set, the tip is
   *  skipped until the anchor measures — see hooks/useTourAnchor.ts. */
  anchor?: string;
  /** Small caps line above the text. Defaults to "DID YOU KNOW". */
  eyebrow?: string;
  text: string;
};

/**
 * The catalog. ORDER IS PRIORITY within a tab — the first unseen, visible tip
 * wins. Keep each line a single fact that reads naturally after "Did you know".
 * The thank-you sits last and belongs to no tab, so it arrives after the useful
 * ones, wherever the person is.
 */
export const TIPS: Tip[] = [
  {
    id: 'console.more',
    tab: 'index',
    anchor: 'console.more',
    text: 'Lights, display, audio and tools live under MORE — one tap opens them, and it stays how you leave it.',
  },
  {
    id: 'console.customize',
    tab: 'index',
    anchor: 'console.customize',
    text: 'Tap the sliders in the header — or hold any card — to reorder or hide cards. Make the Console yours.',
  },
  {
    id: 'pad.combos',
    tab: 'pad',
    anchor: 'pad.keybar',
    text: 'Hold the keyboard button for Combos — one-tap copy, paste, and Kodi / media shortcuts.',
  },
  {
    id: 'pad.sendkeys',
    tab: 'pad',
    anchor: 'pad.modes',
    text: 'A game grabbing player one from your phone? Setup › Prefs › "Send keys instead of a controller" keeps the real pad in charge.',
  },
  {
    id: 'launch.playlog',
    tab: 'launch',
    anchor: 'launch.playlog',
    text: 'Bookmark a game to add it to your Playlog — a play-next queue you can reorder from the couch.',
  },
  {
    id: 'launch.shuffle',
    tab: 'launch',
    anchor: 'launch.shuffle',
    text: 'Can’t decide? Filter to "never played" and hit shuffle — something new is one tap away.',
  },
  {
    id: 'actions.restart',
    tab: 'actions',
    anchor: 'actions.high',
    text: 'TV black but the box is plainly on? Restart Session rebuilds the desktop without a reboot.',
  },
  {
    id: 'setup.search',
    tab: 'setup',
    anchor: 'setup.tabs',
    text: 'Prefs has a search box — type what you’re after instead of scrolling the switches.',
  },
  {
    id: 'setup.updates',
    tab: 'setup',
    anchor: 'setup.tabs',
    text: 'Check for updates now and then — Setup › Account for the app, and the Console shows when your box has one. Couchside keeps evolving, and each update brings the latest improvements and features.',
  },
  {
    id: 'thanks',
    tab: 'any',
    eyebrow: 'A NOTE FROM THE MAKER',
    text: 'Thank you for using Couchside. Your feedback shapes it — if you’d like, let me know anything good or bad you experience, or what you’d like to see in the app. — Taylor',
  },
];

// ---------- persistence (mirrors hooks/useTourThanks.ts) ----------

const KEY = 'couchside.tips.v1';
const DAY_MS = 86_400_000;

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
      // storage unavailable: a tip may repeat next launch, never worse
    }
    return;
  }
  await SecureStore.setItemAsync(k, v);
}

type Snapshot = {
  /** Ids shown, ever. */
  seen: ReadonlySet<string>;
  /** Day index (floor(now / 1 day)) of the last tip shown; 0 = never. */
  lastDay: number;
  /** False until storage has been read — never show before we know. */
  ready: boolean;
};

/** Starts "everything seen" so a slow keychain read can never flash a tip we
 *  have in fact already shown. */
let snap: Snapshot = { seen: new Set(TIPS.map((t) => t.id)), lastDay: 0, ready: false };
const listeners = new Set<() => void>();

function commit(next: Snapshot): void {
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

function persist(): void {
  void set(KEY, JSON.stringify({ seen: [...snap.seen], lastDay: snap.lastDay }));
}

let loadStarted = false;
export async function loadTips(): Promise<void> {
  if (loadStarted) return;
  loadStarted = true;
  let seen = new Set<string>();
  let lastDay = 0;
  try {
    const raw = await get(KEY);
    if (raw) {
      const p = JSON.parse(raw) as { seen?: unknown; lastDay?: unknown };
      if (Array.isArray(p.seen)) seen = new Set(p.seen.filter((x): x is string => typeof x === 'string'));
      if (typeof p.lastDay === 'number' && Number.isFinite(p.lastDay)) lastDay = p.lastDay;
    }
  } catch {
    // corrupt/unreadable: treat as nothing seen (a repeat beats a lost tip)
  }
  commit({ seen, lastDay, ready: true });
}
void loadTips();

/** One tip per process lifetime, regardless of tab changes. */
let shownThisSession = false;

export function todayIndex(now = Date.now()): number {
  return Math.floor(now / DAY_MS);
}

/**
 * May a tip be considered right now? Pure gate, no side effects. The caller
 * still has to find a tip whose anchor measures (async) — see pickCandidates.
 */
export function canShowTip(now = Date.now()): boolean {
  return snap.ready && !shownThisSession && snap.lastDay !== todayIndex(now);
}

/**
 * Unseen tips eligible on `tab`, in priority order: the tab's own tips first,
 * then the 'any' ones. The caller measures anchors and takes the first that is
 * actually visible.
 */
export function pickCandidates(tab: string | null | undefined): Tip[] {
  const own = TIPS.filter((t) => t.tab !== 'any' && t.tab === tab && !snap.seen.has(t.id));
  const any = TIPS.filter((t) => t.tab === 'any' && !snap.seen.has(t.id));
  return [...own, ...any];
}

/** Record that a tip was put on screen: seen forever, and today is spent. */
export function markTipShown(id: string, now = Date.now()): void {
  shownThisSession = true;
  const seen = new Set(snap.seen);
  seen.add(id);
  commit({ seen, lastDay: todayIndex(now), ready: true });
  persist();
}

export function useTipsState(): Snapshot {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/** Forget everything, so tips can play again. Called alongside resetFeatureTour
 *  when the onboarding pref is turned back on — the two are one idea to the
 *  person flipping the switch. */
export async function resetTips(): Promise<void> {
  shownThisSession = false;
  commit({ seen: new Set(), lastDay: 0, ready: true });
  await set(KEY, JSON.stringify({ seen: [], lastDay: 0 }));
}
