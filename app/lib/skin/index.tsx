/**
 * Skin registry + the hook screens use.
 *
 * DEV SELECTION: the whole point of the seam is comparing directions without a
 * rebuild. The web export reads `?skin=<key>` (sticky -- it writes through to
 * localStorage) so the harness can flip looks by navigating, with no 90s
 * re-export between shots. Native has no switcher UI; it takes DEFAULT_SKIN.
 */
import { Platform } from 'react-native';

import { getThemeSkin, loadThemePrefs, setThemeSkin, useThemeSkin } from '@/lib/theme';
import { classicSkin } from './classic';
import { reactorSkin } from './reactor';
import { studioSkin } from './studio';
import { slateSkin } from './slate';
import { paperSkin } from './paper';
import { panelSkin } from './panel';
import type { SkinKit } from './kit';

export * from './kit';
export * from './motion';

export type SkinKey = 'classic' | 'reactor' | 'studio' | 'slate' | 'paper' | 'panel';

/**
 * The two surviving directions. 'vitals' (motion-only, life-support) and 'hud'
 * (corner brackets, scanlines) were built and compared alongside these and are
 * recoverable from git history if the look is ever revisited.
 */
export const SKINS: Record<SkinKey, SkinKit> = {
  classic: classicSkin,
  reactor: reactorSkin,
  studio: studioSkin,
  slate: slateSkin,
  paper: paperSkin,
  panel: panelSkin,
};

export const SKIN_KEYS = Object.keys(SKINS) as SkinKey[];

/**
 * What ships. 'classic' is kept as a comparison control: it is today's exact
 * pre-redesign look, so `?skin=classic` in the web harness is a live A/B
 * against the shipped 2.9.11 dashboard rather than a screenshot from memory.
 */
const DEFAULT_SKIN: SkinKey = 'reactor';

export function isSkinKey(v: unknown): v is SkinKey {
  return typeof v === 'string' && (SKIN_KEYS as string[]).includes(v);
}

// SINGLE SOURCE OF TRUTH: the persisted theme pref (couchside.theme.v1 → skin),
// so the Theme Builder, the Console and any future surface all agree. The web
// harness keeps its `?skin=<key>` override by simply WRITING that pref — applied
// after the async pref load settles so it wins over a stored blob. The real app
// has no query string, so the user's saved pick drives.
if (Platform.OS === 'web' && typeof window !== 'undefined') {
  try {
    const q = new URLSearchParams(window.location.search).get('skin');
    if (isSkinKey(q)) void loadThemePrefs().then(() => setThemeSkin(q));
  } catch {
    // URL/storage unavailable: fall through to the persisted pref / default
  }
}

/** The resolved skin key: the persisted pref when it is a known key, else the
 *  shipped default (a pref written by an older/newer build that names a skin this
 *  build doesn't have degrades to the default rather than crashing). */
export function getSkin(): SkinKey {
  const pref = getThemeSkin();
  return isSkinKey(pref) ? pref : DEFAULT_SKIN;
}

/** Persist the user's skin choice — the Theme Builder calls this. */
export function setSkin(key: SkinKey): void {
  void setThemeSkin(key);
}

export function useSkinKey(): SkinKey {
  const pref = useThemeSkin();
  return isSkinKey(pref) ? pref : DEFAULT_SKIN;
}

/** The active skin's components. */
export function useSkinKit(): SkinKit {
  return SKINS[useSkinKey()];
}
