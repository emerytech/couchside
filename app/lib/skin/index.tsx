/**
 * Skin registry + the hook screens use.
 *
 * DEV SELECTION: the whole point of the seam is comparing directions without a
 * rebuild. The web export reads `?skin=<key>` (sticky -- it writes through to
 * localStorage) so the harness can flip looks by navigating, with no 90s
 * re-export between shots. Native has no switcher UI; it takes DEFAULT_SKIN.
 */
import React, { useSyncExternalStore } from 'react';
import { Platform } from 'react-native';

import { classicSkin } from './classic';
import { reactorSkin } from './reactor';
import type { SkinKit } from './kit';

export * from './kit';
export * from './motion';

export type SkinKey = 'classic' | 'reactor';

/**
 * The two surviving directions. 'vitals' (motion-only, life-support) and 'hud'
 * (corner brackets, scanlines) were built and compared alongside these and are
 * recoverable from git history if the look is ever revisited.
 */
export const SKINS: Record<SkinKey, SkinKit> = {
  classic: classicSkin,
  reactor: reactorSkin,
};

export const SKIN_KEYS = Object.keys(SKINS) as SkinKey[];

/**
 * What ships. 'classic' is kept as a comparison control: it is today's exact
 * pre-redesign look, so `?skin=classic` in the web harness is a live A/B
 * against the shipped 2.9.11 dashboard rather than a screenshot from memory.
 */
const DEFAULT_SKIN: SkinKey = 'reactor';

const STORAGE_KEY = 'couchside.skin.dev';

function isSkinKey(v: unknown): v is SkinKey {
  return typeof v === 'string' && (SKIN_KEYS as string[]).includes(v);
}

/** Resolve the dev override once at module load (web only). */
function initialSkin(): SkinKey {
  if (Platform.OS !== 'web' || typeof window === 'undefined') return DEFAULT_SKIN;
  try {
    const q = new URLSearchParams(window.location.search).get('skin');
    if (isSkinKey(q)) {
      window.localStorage?.setItem(STORAGE_KEY, q);
      return q;
    }
    const stored = window.localStorage?.getItem(STORAGE_KEY);
    if (isSkinKey(stored)) return stored;
  } catch {
    // storage/URL unavailable: fall through to the default
  }
  return DEFAULT_SKIN;
}

let current: SkinKey = initialSkin();
const listeners = new Set<() => void>();

export function getSkin(): SkinKey {
  return current;
}

export function setSkin(key: SkinKey): void {
  if (current === key) return;
  current = key;
  if (Platform.OS === 'web' && typeof window !== 'undefined') {
    try {
      window.localStorage?.setItem(STORAGE_KEY, key);
    } catch {
      // in-memory only this session
    }
  }
  for (const l of listeners) l();
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

export function useSkinKey(): SkinKey {
  return useSyncExternalStore(
    subscribe,
    () => current,
    () => current,
  );
}

/** The active skin's components. */
export function useSkinKit(): SkinKit {
  const key = useSkinKey();
  return SKINS[key];
}
