/** Couchside Theme v1: portable settings only; no code, URLs, paths or remote assets. */
export const THEME_LAYOUTS = ['couchside', 'orbit', 'shelf', 'wave', 'channels', 'crossbar', 'horizon'] as const;
export const THEME_WALLPAPERS = { original: 'Layout default', midnight: 'Midnight', ocean: 'Ocean', forest: 'Forest', sunset: 'Sunset' } as const;
export type ThemeDocument = {
  format: 'couchside-theme'; version: 1; name: string; author: string;
  layout: typeof THEME_LAYOUTS[number]; accent: 'teal' | 'blue' | 'violet' | 'amber';
  wallpaper: keyof typeof THEME_WALLPAPERS; motion: boolean; stats: boolean;
};
export const newTheme = (): ThemeDocument => ({ format: 'couchside-theme', version: 1, name: 'My theme', author: '', layout: 'horizon', accent: 'blue', wallpaper: 'original', motion: true, stats: true });
export function parseThemeDocument(value: unknown): ThemeDocument {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('Expected a theme document.');
  const v = value as Record<string, unknown>;
  const keys = ['format', 'version', 'name', 'author', 'layout', 'accent', 'wallpaper', 'motion', 'stats'];
  if (Object.keys(v).length !== keys.length || keys.some(k => !(k in v)) || Object.keys(v).some(k => !keys.includes(k))) throw Error('Unknown or missing theme fields.');
  if (v.format !== 'couchside-theme' || v.version !== 1) throw Error('Unsupported theme format.');
  if (typeof v.name !== 'string' || !v.name.trim() || v.name.length > 60 || typeof v.author !== 'string' || v.author.length > 80 || /[\x00-\x1f\x7f]/.test(v.name + v.author)) throw Error('Enter a short theme name and author.');
  if (!THEME_LAYOUTS.includes(v.layout as ThemeDocument['layout']) || !['teal', 'blue', 'violet', 'amber'].includes(String(v.accent)) || !Object.hasOwn(THEME_WALLPAPERS, String(v.wallpaper)) || typeof v.motion !== 'boolean' || typeof v.stats !== 'boolean') throw Error('Invalid theme settings.');
  return { ...v, name: v.name.trim(), author: v.author.trim() } as ThemeDocument;
}
