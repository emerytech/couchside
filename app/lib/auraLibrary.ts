/**
 * Game Aura LIBRARY — a curated, frozen table of per-game LED palettes for the
 * addressable strip, plus the pure spreader that turns one into an N-LED frame.
 *
 * OURS, not sampled. Each palette is hand-picked from a game's own brand colours;
 * nothing here is derived from any third-party lighting tool or from cover art.
 * The data is a FROZEN literal baked at build time (never read from a file at
 * runtime), so the app ships one deterministic table.
 *
 * Phase 2 REUSES Phase 1's endpoint: auraToFrame() spreads a palette across the
 * strip's N LEDs and the caller POSTs that frame to /api/leds/aura (api.paint-
 * StripAura), where the agent re-validates every channel and looks the strip up
 * in its live set. Unlike the "paint from artwork" control, this needs NO image
 * decode, so it works on native (iOS/Android) as well as web.
 *
 * v1 paints the palette as a STATIC gradient. `effect` is stored for a FUTURE
 * agent-rendered animated version — it is NOT animated here (that needs agent
 * work); the UI may show it only as a hint.
 *
 * auraToFrame() is PURE and platform-free (no react-native / expo import) so it
 * runs in the install-free test glob:
 *   from app/, `node --experimental-strip-types --test lib/__tests__/auraLibrary.test.ts`
 */
import type { Rgb } from './api';

export type { Rgb };

/** A palette stop as [r,g,b] — matches the library's stored form exactly, so the
 *  baked literal below is the source verbatim (no transcription drift). */
export type RGB = readonly [number, number, number];

export type Aura = {
  /** Stable kebab-case id (unique across the table). */
  readonly id: string;
  /** Display name shown in the picker. */
  readonly label: string;
  /** Steam appid this aura is for, as a string ('' = ambient / not a game).
   *  Matched against the running game's appid for auto-suggest. */
  readonly appid: string;
  /** Ordered colour stops spread across the strip (1+ entries). */
  readonly palette: readonly RGB[];
  /** The animation this aura is meant to run — STORED ONLY; v1 paints static. */
  readonly effect: string;
};

/** Deep-freeze so the shipped table cannot be mutated at runtime (belt and
 *  braces over the readonly types). */
function deepFreeze<T>(o: T): T {
  if (o && typeof o === 'object') {
    for (const v of Object.values(o as Record<string, unknown>)) deepFreeze(v);
    Object.freeze(o);
  }
  return o;
}

/**
 * The 35 curated auras, order preserved. Do not invent or reorder entries — this
 * is the shipped library. Baked verbatim from the palette source.
 */
export const AURAS: readonly Aura[] = deepFreeze([
  { id: "home", label: "Home", appid: "", palette: [[255, 200, 140], [255, 150, 70]], effect: "breathe" },
  { id: "steam", label: "Steam", appid: "", palette: [[102, 192, 244], [59, 142, 206], [27, 40, 56]], effect: "solid" },
  { id: "party", label: "Party", appid: "", palette: [[255, 40, 40], [40, 120, 255], [60, 220, 80], [255, 210, 40]], effect: "rainbow" },
  { id: "counter-strike-2", label: "Counter-Strike 2", appid: "730", palette: [[110, 120, 130], [240, 120, 20], [210, 35, 30]], effect: "pulse" },
  { id: "dota-2", label: "Dota 2", appid: "570", palette: [[200, 25, 35], [90, 190, 110], [235, 185, 60]], effect: "scanner" },
  { id: "pubg-battlegrounds", label: "PUBG: Battlegrounds", appid: "578080", palette: [[245, 150, 30], [235, 235, 225], [95, 90, 70]], effect: "scanner" },
  { id: "grand-theft-auto-v", label: "Grand Theft Auto V", appid: "271590", palette: [[250, 190, 70], [55, 180, 190], [240, 70, 150]], effect: "wipe" },
  { id: "elden-ring", label: "Elden Ring", appid: "1245620", palette: [[240, 205, 95], [190, 140, 45], [80, 60, 25]], effect: "breathe" },
  { id: "cyberpunk-2077", label: "Cyberpunk 2077", appid: "1091500", palette: [[250, 225, 40], [40, 230, 230], [240, 40, 150]], effect: "pulse" },
  { id: "baldurs-gate-3", label: "Baldur's Gate 3", appid: "1086940", palette: [[230, 90, 20], [205, 165, 85], [120, 60, 155]], effect: "breathe" },
  { id: "the-witcher-3", label: "The Witcher 3", appid: "292030", palette: [[180, 185, 195], [150, 20, 25], [45, 38, 38]], effect: "pulse" },
  { id: "terraria", label: "Terraria", appid: "105600", palette: [[90, 180, 240], [95, 200, 85], [160, 95, 55]], effect: "twinkle" },
  { id: "rust", label: "Rust", appid: "252490", palette: [[175, 80, 40], [115, 110, 105], [60, 45, 35]], effect: "solid" },
  { id: "team-fortress-2", label: "Team Fortress 2", appid: "440", palette: [[200, 35, 35], [45, 95, 185]], effect: "wipe" },
  { id: "stardew-valley", label: "Stardew Valley", appid: "413150", palette: [[110, 190, 70], [120, 190, 235], [245, 205, 90]], effect: "breathe" },
  { id: "apex-legends", label: "Apex Legends", appid: "1172470", palette: [[215, 40, 40], [255, 120, 20], [70, 80, 90]], effect: "scanner" },
  { id: "rocket-league", label: "Rocket League", appid: "252950", palette: [[0, 160, 255], [255, 90, 0], [235, 235, 235]], effect: "comet" },
  { id: "hades", label: "Hades", appid: "1145360", palette: [[210, 25, 45], [240, 195, 60], [140, 30, 110]], effect: "pulse" },
  { id: "hollow-knight", label: "Hollow Knight", appid: "367520", palette: [[200, 230, 240], [20, 30, 70], [60, 150, 160]], effect: "breathe" },
  { id: "portal-2", label: "Portal 2", appid: "620", palette: [[0, 120, 255], [255, 95, 0]], effect: "wipe" },
  { id: "half-life-2", label: "Half-Life 2", appid: "220", palette: [[255, 130, 0], [60, 110, 150]], effect: "breathe" },
  { id: "red-dead-redemption-2", label: "Red Dead Redemption 2", appid: "1174180", palette: [[240, 120, 40], [170, 60, 40], [200, 160, 110]], effect: "breathe" },
  { id: "doom-eternal", label: "DOOM Eternal", appid: "782330", palette: [[200, 25, 15], [255, 90, 0], [120, 255, 45]], effect: "pulse" },
  { id: "fallout-4", label: "Fallout 4", appid: "377160", palette: [[60, 255, 90], [40, 80, 160], [250, 205, 50]], effect: "pulse" },
  { id: "skyrim", label: "The Elder Scrolls V: Skyrim", appid: "72850", palette: [[150, 210, 255], [100, 120, 140], [35, 45, 60]], effect: "breathe" },
  { id: "deep-rock-galactic", label: "Deep Rock Galactic", appid: "548430", palette: [[255, 160, 30], [230, 90, 15], [50, 40, 30]], effect: "breathe" },
  { id: "sea-of-thieves", label: "Sea of Thieves", appid: "1172620", palette: [[30, 180, 180], [235, 190, 70], [70, 150, 220]], effect: "wipe" },
  { id: "no-mans-sky", label: "No Man's Sky", appid: "275850", palette: [[130, 60, 200], [255, 120, 40], [40, 200, 190]], effect: "circle" },
  { id: "subnautica", label: "Subnautica", appid: "264710", palette: [[20, 90, 160], [40, 190, 190], [255, 120, 40]], effect: "breathe" },
  { id: "left-4-dead-2", label: "Left 4 Dead 2", appid: "550", palette: [[140, 200, 50], [160, 25, 25], [45, 50, 40]], effect: "pulse" },
  { id: "dark-souls-3", label: "Dark Souls III", appid: "374320", palette: [[255, 120, 40], [150, 145, 150], [45, 35, 35]], effect: "breathe" },
  { id: "god-of-war", label: "God of War", appid: "1593500", palette: [[150, 210, 255], [155, 20, 20], [230, 235, 245]], effect: "scanner" },
  { id: "celeste", label: "Celeste", appid: "504230", palette: [[240, 80, 110], [90, 160, 230], [130, 85, 165]], effect: "breathe" },
  { id: "cuphead", label: "Cuphead", appid: "268910", palette: [[200, 45, 30], [245, 225, 180], [115, 70, 40]], effect: "pulse" },
  { id: "among-us", label: "Among Us", appid: "945360", palette: [[200, 30, 40], [75, 220, 220], [235, 235, 235]], effect: "twinkle" },
] as Aura[]) as readonly Aura[];

/** Round to an int in 0..255 (what a colour channel must be on the wire). */
function chan(v: number): number {
  const r = Math.round(v);
  return r < 0 ? 0 : r > 255 ? 255 : r;
}

/**
 * Spread `palette`'s colour stops across `n` LED cells by LINEAR interpolation,
 * returning exactly `n` `{r,g,b}` (one per LED) ready to POST to /api/leds/aura.
 *
 * Cell i sits at position t = i/(n-1) in 0..1 (a single cell, n=1, sits at the
 * first stop). t maps into palette index space [0, S-1]; the two nearest stops
 * are interpolated and each channel is rounded + clamped to 0..255. Deterministic:
 * the same palette and n always yield the same frame.
 *
 * Degenerate requests (n <= 0, or an empty palette) return [] rather than throw,
 * so a bad call degrades to "no frame" at the call site instead of posting junk.
 */
export function auraToFrame(palette: readonly RGB[], n: number): Rgb[] {
  const N = Math.floor(n);
  const S = palette.length;
  if (!(N > 0) || S === 0) return [];
  const out: Rgb[] = [];
  for (let i = 0; i < N; i++) {
    // Single cell -> the first stop; otherwise spread 0..1 across the cells.
    const t = N === 1 ? 0 : i / (N - 1);
    const pos = t * (S - 1);
    const lo = Math.floor(pos);
    const hi = lo + 1 < S ? lo + 1 : S - 1;
    const f = pos - lo;
    const a = palette[lo];
    const b = palette[hi];
    out.push({
      r: chan(a[0] + (b[0] - a[0]) * f),
      g: chan(a[1] + (b[1] - a[1]) * f),
      b: chan(a[2] + (b[2] - a[2]) * f),
    });
  }
  return out;
}
