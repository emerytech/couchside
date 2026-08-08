/**
 * The ONE module that turns a game-theme backdrop key into a bundled image.
 *
 * Kept apart from lib/gameTheme.ts on purpose: `require('...png')` is a Metro
 * bundler call, so a file that makes them cannot be imported by the bare-Node
 * test runner that proves the theme's contrast guarantee. Everything else deals
 * in string KEYS; only this file touches assets.
 *
 * Adding a game's art is a two-line change here — drop the PNGs under
 * `assets/gameThemes/` and register the require()s — with NO change anywhere
 * else. A key with no entry (the art has not been made yet) resolves to null,
 * and the backdrop renderer falls back to a derived dark-plus-glow wash, so the
 * theme is useful before its art exists.
 *
 * `require` returns an opaque asset handle (a number on native, a resolved URL
 * on web); typed `unknown` because RN's <Image source> accepts it directly.
 */
export type BackdropAssets = { portrait: unknown; landscape: unknown };

const REGISTRY: Record<string, BackdropAssets> = {
  'vampire-survivors': {
    portrait: require('../assets/gameThemes/vampire-survivors-portrait.png'),
    landscape: require('../assets/gameThemes/vampire-survivors-landscape.png'),
  },
  'neon-arcade': {
    portrait: require('../assets/gameThemes/neon-arcade-portrait.png'),
    landscape: require('../assets/gameThemes/neon-arcade-landscape.png'),
  },
};

/** The image pair for a backdrop key, or null when no art is registered. */
export function backdropAssets(key: string | null | undefined): BackdropAssets | null {
  if (!key) return null;
  return REGISTRY[key] ?? null;
}
