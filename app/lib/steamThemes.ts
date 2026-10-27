import type { ThemeDocument } from './themeFormat';
/** Fixed renderer IDs and validated data; downloaded executable themes are unsupported. */
export type SteamThemeSettings = {
  version: 1; installed: boolean; enabled: boolean;
  theme: 'couchside' | 'orbit' | 'shelf' | 'wave' | 'channels' | 'crossbar' | 'horizon';
  accent: 'teal' | 'blue' | 'violet' | 'amber'; motion: boolean; studio?: ThemeDocument | null;
};
export type SteamTheme = { id: SteamThemeSettings['theme']; name: string; layout: string; description: string };
export type SteamThemesState = { settings: SteamThemeSettings; themes: SteamTheme[]; companion_ready: boolean; requires: string; studio_ready?: boolean };
export const STEAM_THEME_ACCENTS = { teal: '#26d4be', blue: '#73b5ff', violet: '#b5a0ff', amber: '#ffcf7b' } as const;

/** Applying a search result must never target an invisible previous selection. */
export function canApplySteamTheme(state: SteamThemesState | null, selected: SteamThemeSettings['theme'], search: string, busy: boolean) {
  if (busy || !state?.companion_ready) return false;
  const query = search.trim().toLowerCase();
  return state.themes.some(theme => theme.id === selected &&
    `${theme.name} ${theme.description} ${theme.layout}`.toLowerCase().includes(query));
}

/** A missing or removed explicit target must never fall back to another box. */
export function steamThemeBox<T extends { id: string }>(boxes: T[], active: T | null, requestedId?: string): T | null {
  return requestedId === undefined ? active : boxes.find(box => box.id === requestedId) ?? null;
}
