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
  'alien-biosphere': {
    portrait: require('../assets/gameThemes/alien-biosphere-portrait.webp'),
    landscape: require('../assets/gameThemes/alien-biosphere-landscape.webp'),
  },
  'arcane-observatory': {
    portrait: require('../assets/gameThemes/arcane-observatory-portrait.webp'),
    landscape: require('../assets/gameThemes/arcane-observatory-landscape.webp'),
  },
  'autumn-canyon': {
    portrait: require('../assets/gameThemes/autumn-canyon-portrait.webp'),
    landscape: require('../assets/gameThemes/autumn-canyon-landscape.webp'),
  },
  'bamboo-mist': {
    portrait: require('../assets/gameThemes/bamboo-mist-portrait.webp'),
    landscape: require('../assets/gameThemes/bamboo-mist-landscape.webp'),
  },
  'bioluminescent-marsh': {
    portrait: require('../assets/gameThemes/bioluminescent-marsh-portrait.webp'),
    landscape: require('../assets/gameThemes/bioluminescent-marsh-landscape.webp'),
  },
  'biotech-vault': {
    portrait: require('../assets/gameThemes/biotech-vault-portrait.webp'),
    landscape: require('../assets/gameThemes/biotech-vault-landscape.webp'),
  },
  'coral-reef': {
    portrait: require('../assets/gameThemes/coral-reef-portrait.webp'),
    landscape: require('../assets/gameThemes/coral-reef-landscape.webp'),
  },
  'crystal-caverns': {
    portrait: require('../assets/gameThemes/crystal-caverns-portrait.webp'),
    landscape: require('../assets/gameThemes/crystal-caverns-landscape.webp'),
  },
  'dieselpunk-foundry': {
    portrait: require('../assets/gameThemes/dieselpunk-foundry-portrait.webp'),
    landscape: require('../assets/gameThemes/dieselpunk-foundry-landscape.webp'),
  },
  'ember-forge': {
    portrait: require('../assets/gameThemes/ember-forge-portrait.webp'),
    landscape: require('../assets/gameThemes/ember-forge-landscape.webp'),
  },
  'faerie-meadow': {
    portrait: require('../assets/gameThemes/faerie-meadow-portrait.webp'),
    landscape: require('../assets/gameThemes/faerie-meadow-landscape.webp'),
  },
  'floating-sky-ruins': {
    portrait: require('../assets/gameThemes/floating-sky-ruins-portrait.webp'),
    landscape: require('../assets/gameThemes/floating-sky-ruins-landscape.webp'),
  },
  'moonlit-witchwood': {
    portrait: require('../assets/gameThemes/moonlit-witchwood-portrait.webp'),
    landscape: require('../assets/gameThemes/moonlit-witchwood-landscape.webp'),
  },
  'orbital-megacity': {
    portrait: require('../assets/gameThemes/orbital-megacity-portrait.webp'),
    landscape: require('../assets/gameThemes/orbital-megacity-landscape.webp'),
  },
  'quantum-lattice': {
    portrait: require('../assets/gameThemes/quantum-lattice-portrait.webp'),
    landscape: require('../assets/gameThemes/quantum-lattice-landscape.webp'),
  },
  'retro-space-colony': {
    portrait: require('../assets/gameThemes/retro-space-colony-portrait.webp'),
    landscape: require('../assets/gameThemes/retro-space-colony-landscape.webp'),
  },
  'thunderhead-prairie': {
    portrait: require('../assets/gameThemes/thunderhead-prairie-portrait.webp'),
    landscape: require('../assets/gameThemes/thunderhead-prairie-landscape.webp'),
  },
  'volcanic-island': {
    portrait: require('../assets/gameThemes/volcanic-island-portrait.webp'),
    landscape: require('../assets/gameThemes/volcanic-island-landscape.webp'),
  },
};

/** The image pair for a backdrop key, or null when no art is registered. */
export function backdropAssets(key: string | null | undefined): BackdropAssets | null {
  if (!key) return null;
  return REGISTRY[key] ?? null;
}
