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
    portrait: require('../assets/gameThemes/vampire-survivors-portrait.webp'),
    landscape: require('../assets/gameThemes/vampire-survivors-landscape.webp'),
  },
  'bonk': {
    portrait: require('../assets/gameThemes/bonk-portrait.webp'),
    landscape: require('../assets/gameThemes/bonk-landscape.webp'),
  },
  'ancient-forest': {
    portrait: require('../assets/gameThemes/ancient-forest-portrait.webp'),
    landscape: require('../assets/gameThemes/ancient-forest-landscape.webp'),
  },
  'arctic-aurora': {
    portrait: require('../assets/gameThemes/arctic-aurora-portrait.webp'),
    landscape: require('../assets/gameThemes/arctic-aurora-landscape.webp'),
  },
  'candy-cataclysm': {
    portrait: require('../assets/gameThemes/candy-cataclysm-portrait.webp'),
    landscape: require('../assets/gameThemes/candy-cataclysm-landscape.webp'),
  },
  'clockwork-voltage': {
    portrait: require('../assets/gameThemes/clockwork-voltage-portrait.webp'),
    landscape: require('../assets/gameThemes/clockwork-voltage-landscape.webp'),
  },
  'cosmic-comet': {
    portrait: require('../assets/gameThemes/cosmic-comet-portrait.webp'),
    landscape: require('../assets/gameThemes/cosmic-comet-landscape.webp'),
  },
  'cyberpunk-rain': {
    portrait: require('../assets/gameThemes/cyberpunk-rain-portrait.webp'),
    landscape: require('../assets/gameThemes/cyberpunk-rain-landscape.webp'),
  },
  'deep-sea-disco': {
    portrait: require('../assets/gameThemes/deep-sea-disco-portrait.webp'),
    landscape: require('../assets/gameThemes/deep-sea-disco-landscape.webp'),
  },
  'desert-sandstorm': {
    portrait: require('../assets/gameThemes/desert-sandstorm-portrait.webp'),
    landscape: require('../assets/gameThemes/desert-sandstorm-landscape.webp'),
  },
  'frostfire-shrine': {
    portrait: require('../assets/gameThemes/frostfire-shrine-portrait.webp'),
    landscape: require('../assets/gameThemes/frostfire-shrine-landscape.webp'),
  },
  'infernal-doomsday': {
    portrait: require('../assets/gameThemes/infernal-doomsday-portrait.webp'),
    landscape: require('../assets/gameThemes/infernal-doomsday-landscape.webp'),
  },
  'ink-wash-tempest': {
    portrait: require('../assets/gameThemes/ink-wash-tempest-portrait.webp'),
    landscape: require('../assets/gameThemes/ink-wash-tempest-landscape.webp'),
  },
  'limewire': {
    portrait: require('../assets/gameThemes/limewire-portrait.webp'),
    landscape: require('../assets/gameThemes/limewire-landscape.webp'),
  },
  'rusty-scrapyard': {
    portrait: require('../assets/gameThemes/rusty-scrapyard-portrait.webp'),
    landscape: require('../assets/gameThemes/rusty-scrapyard-landscape.webp'),
  },
  'stained-glass-night': {
    portrait: require('../assets/gameThemes/stained-glass-night-portrait.webp'),
    landscape: require('../assets/gameThemes/stained-glass-night-landscape.webp'),
  },
  'toxic-slime-lab': {
    portrait: require('../assets/gameThemes/toxic-slime-lab-portrait.webp'),
    landscape: require('../assets/gameThemes/toxic-slime-lab-landscape.webp'),
  },
};

/** The image pair for a backdrop key, or null when no art is registered. */
export function backdropAssets(key: string | null | undefined): BackdropAssets | null {
  if (!key) return null;
  return REGISTRY[key] ?? null;
}
