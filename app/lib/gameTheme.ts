/**
 * Per-game themes: the controller dresses for whatever is running on the box.
 *
 * The agent already reports the running game on `/api/gaming` (appid + label),
 * so this is a PURE APP-SIDE LOOKUP — no new endpoint, no new capability, and
 * nothing client-supplied ever reaches the box. The appid flows box -> phone
 * and indexes a frozen table below. An appid with no entry gets the normal
 * palette; there is no fetch, no remote theme delivery, and no way for a value
 * from the wire to become anything but a lookup miss.
 *
 * WHAT A GAME THEME MAY CHANGE, and why it is only this:
 *
 * Only the ACCENT FAMILY — the colour that drives active/highlight state — and
 * a per-button tint for the face buttons. Deliberately NOT text, card, border
 * or background tokens.
 *
 * That is not timidity, it is what keeps the contrast guarantee. The palette's
 * text tiers were measured and fixed to clear WCAG AA on the exact surfaces
 * they are drawn on (see lib/__tests__/themeContrast.test.ts, and the comment
 * on `textFaint` in theme.ts — the app's smallest text used to carry its lowest
 * contrast). A theme that could restyle `card` or `textFaint` would be able to
 * silently undo that work per-game, in a surface the user is looking at while
 * NOT looking at the phone. Accent-only means every game theme is contrast-safe
 * BY CONSTRUCTION rather than by review — and `__tests__/gameTheme.test.ts`
 * asserts both the restriction and the resulting ratios anyway.
 *
 * SCOPE: the immersive controller surfaces only (LandscapePad / MovePad). The
 * Console deliberately does not change colour when a game starts — a diagnostic
 * screen that restyles itself based on what is playing is harder to read, not
 * easier, and its contrast work is the most load-bearing in the app.
 */
import type { Palette } from '@/lib/theme';

/** What a game may restyle. Accent family + an optional backdrop — see header. */
export type GameTheme = {
  /** Display name, for the debug surface and future settings UI. */
  label: string;
  /** Drives `accent` + `blue`: rings, active buttons, the STEAM/⋯ glyphs. */
  accent: { dark: string; light: string };
  /** Optional per-face-button tints. Omitted keys keep the standard colours. */
  face?: Partial<Record<'a' | 'b' | 'x' | 'y', { dark: string; light: string }>>;
  /**
   * Optional styled backdrop behind the immersive controls (MOVE / landscape
   * pad). A KEY, not a require: the actual image assets live in
   * `lib/gameThemeAssets.ts`, the one module that touches bitmaps, so a game
   * theme registered here still can't drag an asset into a bare-Node test.
   *
   * When the key resolves to a bundled image (art dropped in), the backdrop is
   * that image under a legibility scrim. When it does NOT — the art hasn't been
   * made yet — a DERIVED backdrop is drawn from `glow` instead, so the feature
   * is useful before the art exists and upgrades to the real thing with no code
   * change. Either way a scrim guarantees the controls stay readable, so a
   * too-bright asset degrades to "washed", never "unusable".
   */
  backdrop?: {
    /** Asset key looked up in gameThemeAssets.ts. */
    key: string;
    /** The glow colour for the derived fallback (top-third wash). */
    glow: { dark: string; light: string };
  };
};

/**
 * The registry. A frozen, app-internal map — the same allowlist shape the agent
 * uses for launcher ids and actions. Adding a game means adding an entry here
 * and shipping a build; there is no dynamic source.
 *
 * Keys are Steam appids. Sources for each are recorded beside it, because an
 * appid guessed wrong themes the wrong game and that is invisible in review.
 */
export const GAME_THEMES: Readonly<Record<number, GameTheme>> = Object.freeze({
  // Vampire Survivors — appid 1794680, from its Steam store URL.
  // Gold on dark, the game's own HUD palette; red for B to match its damage
  // numbers. Values chosen against this app's dark card, not sampled art.
  1794680: {
    label: 'Vampire Survivors',
    accent: { dark: '#f0c25a', light: '#8a6410' },
    face: {
      a: { dark: '#7bd88f', light: '#1d7a37' },
      b: { dark: '#f07a6a', light: '#a02a1c' },
    },
    // Gothic bullet-heaven vibe. `key` resolves to a bundled PNG once the art
    // exists (gameThemeAssets.ts); until then the derived backdrop is a dark
    // base with a gold top-third glow — the same palette the art will use.
    backdrop: { key: 'vampire-survivors', glow: { dark: '#f0c25a', light: '#c99b2e' } },
  },
});

/**
 * MEGABONK is the other pilot game and is deliberately NOT in the table yet.
 *
 * Its appid has not been confirmed from a first-party source, and the movement
 * spec's open question — whether it needs manual aim, which decides if the
 * movement layout even fits it — is unanswered. Guessing an appid would theme
 * some other game entirely, and nothing in the UI would reveal the mistake.
 * Add it after one session on real hardware; `debugGameTheme()` below prints
 * the appid of whatever is actually running, which is how to get it.
 */

/** Is this appid themed? Pure, exported for tests and the debug surface. */
export function themeForAppid(appid: number | undefined | null): GameTheme | null {
  if (appid == null) return null;
  return GAME_THEMES[appid] ?? null;
}

/**
 * Apply a game theme to a resolved palette. Pure, so the composition rule is
 * testable without a renderer.
 *
 * Only the accent family moves. The face tints ride alongside as a separate
 * field rather than overwriting palette tokens, because `green`/`red` are used
 * for status semantics elsewhere (an online dot, an error strip) and a game
 * must not be able to restyle THOSE by choosing a button colour.
 */
export type Backdrop = {
  /** Asset key for gameThemeAssets.ts; null when the theme has no backdrop. */
  key: string | null;
  /** The derived-fallback glow colour, resolved for the scheme. */
  glow: string;
};

export type ThemedPalette = Palette & {
  /** Per-face-button overrides, empty when the running game has no theme. */
  faceTint: Partial<Record<'a' | 'b' | 'x' | 'y', string>>;
  /** The styled backdrop, or null. */
  backdrop: Backdrop | null;
  /** The theme in effect, for debug output. */
  gameLabel: string | null;
};

export function applyGameTheme(
  base: Palette,
  theme: GameTheme | null,
  scheme: 'light' | 'dark',
): ThemedPalette {
  if (!theme) return { ...base, faceTint: {}, backdrop: null, gameLabel: null };
  const accent = theme.accent[scheme];
  const faceTint: Partial<Record<'a' | 'b' | 'x' | 'y', string>> = {};
  for (const k of ['a', 'b', 'x', 'y'] as const) {
    const v = theme.face?.[k];
    if (v) faceTint[k] = v[scheme];
  }
  const backdrop: Backdrop | null = theme.backdrop
    ? { key: theme.backdrop.key, glow: theme.backdrop.glow[scheme] }
    : null;
  return { ...base, accent, blue: accent, faceTint, backdrop, gameLabel: theme.label };
}

// ---------- The running-game store ----------
//
// Written by whoever polls /api/gaming (the Pad screen today) and read by the
// controller surfaces. A module store rather than context for the same reason
// lib/immersive.ts is one: the reader and the writer are in different trees,
// and `useSyncExternalStore` cannot tear between them.

let runningAppid: number | null = null;
const listeners = new Set<() => void>();

/** Idempotent: setting the value it already holds notifies nobody, so this is
 *  safe to call from a render-derived effect on every poll tick. */
export function setRunningAppid(next: number | null): void {
  if (next === runningAppid) return;
  runningAppid = next;
  for (const l of listeners) l();
}

/**
 * Store subscription primitives. Plain JS on purpose — this module must import
 * NOTHING at runtime (only `import type`) so the bare-Node, install-free CI
 * test runner can load it and actually assert the contrast guarantee. The React
 * glue (`useRunningAppid`, `useSyncExternalStore`) lives in
 * hooks/useControllerTheme.ts. A `from 'react'` here is the exact node-forge
 * trap: green locally where node_modules exists, red in CI where it does not.
 */
export function subscribeRunningAppid(l: () => void): () => void {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

export const getRunningAppid = (): number | null => runningAppid;

/** Test seam. */
export function __resetRunningAppid(): void {
  runningAppid = null;
  for (const l of listeners) l();
}

// The live-palette hook lives in hooks/useControllerTheme.ts, NOT here: it
// needs useTheme()/useResolvedScheme(), whose module pulls in react-native and
// expo-secure-store, and this file must stay importable by the bare-Node test
// runner (lib/__tests__/gameTheme.test.ts imports GAME_THEMES + applyGameTheme
// directly). Keeping the pure lookup/composition here and the React glue there
// is what lets the contrast guarantee be asserted at all.

/**
 * One line for the dev console: what is running and whether it themes.
 * Deliberately not wired to any production log — this is for finding an
 * appid (Megabonk's, in particular) on a real box.
 */
export function debugGameTheme(): string {
  const t = themeForAppid(runningAppid);
  return `appid=${runningAppid ?? 'none'} theme=${t ? t.label : 'none (default palette)'}`;
}
