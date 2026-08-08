/**
 * The controller's live palette: the app's resolved theme with the running
 * game's accent + face tints layered on (see lib/gameTheme.ts).
 *
 * A drop-in for `useTheme()` — it returns a `ThemedPalette`, a superset of
 * `Palette` — so every ring, active border and glyph in the pad that reads
 * `t.blue`/`t.accent` takes the game accent for free, and the face buttons read
 * `t.faceTint`. Reverts the instant the game quits (the store goes null) with no
 * work at the call sites.
 *
 * ONLY the immersive controller surfaces use this. Everything else keeps
 * `useTheme()`, so a game theme never reaches the Console or any screen whose
 * contrast is load-bearing.
 *
 * This lives in hooks/ rather than in gameTheme.ts on purpose: it imports the
 * theme hooks, whose module pulls in react-native + expo-secure-store, and
 * gameTheme.ts has to stay importable by the bare-Node test runner so the
 * contrast guarantee can be asserted.
 */
import { useMemo, useSyncExternalStore } from 'react';

import {
  applyGameTheme,
  getRunningAppid,
  subscribeRunningAppid,
  themeForAppid,
  type ThemedPalette,
} from '@/lib/gameTheme';
import { useResolvedScheme, useTheme } from '@/lib/theme';

/**
 * The running game's appid, as a hook. The React glue lives here, NOT in
 * gameTheme.ts, so that module stays runtime-import-free and loadable by the
 * install-free CI test runner (see the note on subscribeRunningAppid).
 */
export function useRunningAppid(): number | null {
  return useSyncExternalStore(subscribeRunningAppid, getRunningAppid, getRunningAppid);
}

export function useControllerTheme(): ThemedPalette {
  const base = useTheme();
  const scheme = useResolvedScheme();
  const appid = useRunningAppid();
  return useMemo(
    () => applyGameTheme(base, themeForAppid(appid), scheme),
    [base, appid, scheme],
  );
}
