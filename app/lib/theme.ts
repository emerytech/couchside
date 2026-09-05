import { useMemo, useSyncExternalStore } from 'react';
import { Platform, TextStyle, useColorScheme } from 'react-native';
import * as SecureStore from 'expo-secure-store';

/**
 * Theming: light + dark palettes, a user-selectable accent, and the hooks that
 * resolve them live. Components read colors through `useTheme()` (or
 * `useThemedStyles()` for StyleSheet-based styles) so they react to the system
 * scheme, the user's Light/Dark/System override, and the chosen accent.
 *
 * BACKWARD COMPAT: `export const theme` (the dark palette) is kept so the many
 * components not yet converted to `useTheme()` still compile and render exactly
 * as before (dark). Convert files incrementally; nothing breaks mid-sweep.
 */

// ---------------------------------------------------------------------------
// Palettes
// ---------------------------------------------------------------------------

export type Palette = {
  bg: string;
  card: string;
  cardBorder: string;
  inset: string;
  text: string;
  textDim: string;
  textFaint: string;
  green: string;
  amber: string;
  red: string;
  redDeep: string;
  /**
   * Text drawn ON `redDeep` — error banners, offline strips, the failed-action
   * boxes. It exists because those call sites used to hardcode `'#fecaca'`,
   * which IS light's `redDeep`: in light mode four error messages rendered at
   * 1.00:1 against their own background, i.e. a pink rectangle with nothing
   * visible in it. Always use this token on a redDeep surface; never a literal.
   */
  onRedDeep: string;
  blue: string;
  slate: string;
  tabBar: string;
  tabBarBorder: string;
  /** The resolved accent hue (drives the active/link color; mirrors `blue`). */
  accent: string;
  /**
   * Text/icon drawn ON an accent-coloured surface (primary buttons, the Done
   * pill). Sites used to hardcode the navy `'#0b1220'`, which is unreadable on
   * a light pack's blue button and simply wrong on any pack whose bg isn't
   * navy. Always this token on an accent surface; never a literal.
   */
  onAccent: string;
  /** Text/icon drawn ON a `green` button (Play, Next, Confirm). Sites hardcoded
   *  `'#04140c'`; on a light pack's darker green that is unreadable. */
  onGreen: string;
  /** Text/icon drawn ON a `red` button (Retry, Cancel countdown). Sites hardcoded
   *  `'#450a0a'`; same story as onGreen. */
  onRed: string;
};

/** Dark ops-console palette. Legible at 2am. The historical default. */
const dark: Palette = {
  bg: '#0b1220',
  card: '#141c2e',
  cardBorder: '#1e2942',
  inset: '#0e1526',
  text: '#e5ecf8',
  // See the note on light.textFaint below: the faint tier was measured at
  // 2.99:1 on `card` and every one of its ~109 uses is 10-12px, so none of them
  // qualified for WCAG's 3:1 large-text allowance. Raising faint alone squeezed
  // the faint/dim gap to 1.24 (two greys that read as one tier), so dim moves
  // with it. Measured: dim 6.94:1 on card, faint 4.64:1 on card, gap 1.50.
  textDim: '#9ca6b9',
  textFaint: '#7986a0',
  green: '#34d399',
  amber: '#fbbf24',
  red: '#f87171',
  redDeep: '#7f1d1d',
  onRedDeep: '#fecaca', // 6.93:1 on redDeep
  blue: '#60a5fa',
  slate: '#64748b',
  tabBar: '#0e1526',
  tabBarBorder: '#1e2942',
  accent: '#60a5fa',
  onAccent: '#0b1220',
  onGreen: '#04140c',
  onRed: '#450a0a',
};

/** Light palette. Same navy/green identity, tuned for contrast on a light bg. */
const light: Palette = {
  bg: '#f6f8fc',
  card: '#ffffff',
  cardBorder: '#dbe3f0',
  inset: '#eef2f9',
  text: '#0b1220',
  textDim: '#4a5670',
  // WAS #8b97ad: 2.95:1 on card and 2.77:1 on bg — below WCAG AA (4.5:1) and
  // below even the 3:1 large-text floor, which nothing here could claim anyway
  // since every textFaint site renders at 10-12px. This is the app's SMALLEST
  // text carrying the LOWEST contrast: the pairing hint, the box IP, and every
  // card title. Solved against `bg`, the harder of the two surfaces for a light
  // theme. Measured: 4.92:1 on card, 4.62:1 on bg, still 1.50 clear of dim.
  textFaint: '#63718c',
  green: '#059669',
  amber: '#b45309',
  red: '#dc2626',
  redDeep: '#fecaca',
  onRedDeep: '#7f1d1d', // 6.93:1 on redDeep — the same pair, swapped
  blue: '#2563eb',
  slate: '#64748b',
  tabBar: '#ffffff',
  tabBarBorder: '#dbe3f0',
  accent: '#2563eb',
  onAccent: '#ffffff',
  onGreen: '#ffffff',
  onRed: '#ffffff',
};

export const palettes: Record<'dark' | 'light', Palette> = { dark, light };

/**
 * BACKWARD COMPAT: static dark palette. Deprecated — use `useTheme()`. Kept so
 * unconverted components stay pixel-identical to today until they're converted.
 */
export const theme = dark;

// ---------------------------------------------------------------------------
// Accents
// ---------------------------------------------------------------------------

export type AccentKey = 'blue' | 'green' | 'violet' | 'amber' | 'rose' | 'teal';

/** The selectable accent hues, one value per scheme (tuned for contrast). */
export const ACCENTS: Record<AccentKey, { label: string; dark: string; light: string }> = {
  // 'blue' is the DEFAULT slot: it resolves to the active pack's own accent
  // (Steam's #66c0f4, Dracula's purple…) rather than a fixed hue, so every pack
  // looks like itself out of the box and the other five still override.
  blue: { label: 'Default', dark: '#60a5fa', light: '#2563eb' },
  green: { label: 'Green', dark: '#34d399', light: '#059669' },
  violet: { label: 'Violet', dark: '#a78bfa', light: '#7c3aed' },
  amber: { label: 'Amber', dark: '#fbbf24', light: '#d97706' },
  rose: { label: 'Rose', dark: '#fb7185', light: '#e11d48' },
  teal: { label: 'Teal', dark: '#2dd4bf', light: '#0d9488' },
};

export const ACCENT_KEYS = Object.keys(ACCENTS) as AccentKey[];

// ---------------------------------------------------------------------------
// Theme packs — whole looks, not just an accent (owner ask, 2026-09-02).
//
// A pack is a dark palette plus, where the look has a canonical one, a light
// palette. Light/Dark/System keeps working: for a pack with both variants the
// switch chooses between them; a dark-only pack (OLED, Steam, Nord, Dracula)
// stays dark whatever the switch says — you chose black, you get black. The
// accent picker layers on top of any pack; its "Default" slot is the pack's own
// accent. Midnight is today's look exactly, so existing installs change nothing.
//
// Every value below is a full Palette (spread from Midnight so a pack can never
// forget a token — tsc enforces the shape). Contrast was kept at or above the
// Midnight baseline for text tiers; the faint tier is the one to watch.
// ---------------------------------------------------------------------------

export type ThemePackKey =
  | 'midnight' | 'oled' | 'steam' | 'nord' | 'dracula' | 'solarized' | 'contrast';

export type ThemePack = {
  label: string;
  /** One line for the picker card. */
  blurb: string;
  dark: Palette;
  light?: Palette;
};

const oledDark: Palette = {
  ...dark,
  bg: '#000000', card: '#0c0c0e', cardBorder: '#1f1f24', inset: '#080809',
  text: '#f2f4f8', textDim: '#a0a6b3', textFaint: '#7d8494',
  tabBar: '#000000', tabBarBorder: '#1f1f24',
  onAccent: '#000000',
};

/** Valve's own palette: the Steam client's navy/slate with its light-blue links. */
const steamDark: Palette = {
  ...dark,
  bg: '#171a21', card: '#1b2838', cardBorder: '#2a475e', inset: '#16202d',
  text: '#c6d4df', textDim: '#9aa6b1', textFaint: '#8290a0',
  green: '#a4d007', amber: '#e5b800', red: '#e0563c',
  redDeep: '#5c1a12', onRedDeep: '#f4c7bf',
  blue: '#66c0f4', slate: '#4b6479',
  tabBar: '#171a21', tabBarBorder: '#2a475e',
  accent: '#66c0f4', onAccent: '#0f1a26',
};

const nordDark: Palette = {
  ...dark,
  bg: '#2e3440', card: '#3b4252', cardBorder: '#4c566a', inset: '#353b49',
  text: '#eceff4', textDim: '#d8dee9', textFaint: '#a3b1c6',
  green: '#a3be8c', amber: '#ebcb8b', red: '#bf616a',
  redDeep: '#4b2a30', onRedDeep: '#f1c6ca',
  blue: '#88c0d0', slate: '#4c566a',
  tabBar: '#2e3440', tabBarBorder: '#4c566a',
  accent: '#88c0d0', onAccent: '#2e3440',
};

const draculaDark: Palette = {
  ...dark,
  bg: '#282a36', card: '#343746', cardBorder: '#44475a', inset: '#2c2f3d',
  text: '#f8f8f2', textDim: '#bfc3d9', textFaint: '#8b93b8',
  green: '#50fa7b', amber: '#f1fa8c', red: '#ff5555',
  redDeep: '#4a1f2a', onRedDeep: '#ffb3b3',
  blue: '#8be9fd', slate: '#6272a4',
  tabBar: '#282a36', tabBarBorder: '#44475a',
  accent: '#bd93f9', onAccent: '#282a36',
};

const solarizedDark: Palette = {
  ...dark,
  bg: '#002b36', card: '#073642', cardBorder: '#1c4a58', inset: '#00232c',
  text: '#eee8d5', textDim: '#a7b5b8', textFaint: '#8a9a9c',
  green: '#859900', amber: '#b58900', red: '#dc322f',
  redDeep: '#4a1512', onRedDeep: '#f5c2c0',
  blue: '#268bd2', slate: '#586e75',
  tabBar: '#002b36', tabBarBorder: '#1c4a58',
  accent: '#268bd2', onAccent: '#fdf6e3',
};
const solarizedLight: Palette = {
  ...light,
  bg: '#fdf6e3', card: '#eee8d5', cardBorder: '#d6cfb8', inset: '#f5efdc',
  text: '#073642', textDim: '#586e75', textFaint: '#657b83',
  green: '#6f8000', amber: '#b58900', red: '#dc322f',
  redDeep: '#f8d0ce', onRedDeep: '#7a1a17',
  blue: '#268bd2', slate: '#93a1a1',
  tabBar: '#eee8d5', tabBarBorder: '#d6cfb8',
  accent: '#268bd2', onAccent: '#fdf6e3',
};

const contrastDark: Palette = {
  ...dark,
  bg: '#000000', card: '#000000', cardBorder: '#ffffff', inset: '#111111',
  text: '#ffffff', textDim: '#ffffff', textFaint: '#d0d0d0',
  green: '#00ff88', amber: '#ffd60a', red: '#ff4d4d',
  redDeep: '#330000', onRedDeep: '#ffffff',
  blue: '#4dc3ff', slate: '#bbbbbb',
  tabBar: '#000000', tabBarBorder: '#ffffff',
  accent: '#4dc3ff', onAccent: '#000000',
};
const contrastLight: Palette = {
  ...light,
  bg: '#ffffff', card: '#ffffff', cardBorder: '#000000', inset: '#f0f0f0',
  text: '#000000', textDim: '#000000', textFaint: '#333333',
  green: '#006b3c', amber: '#8a5a00', red: '#b00020',
  redDeep: '#ffd6d6', onRedDeep: '#5a0010',
  blue: '#0044cc', slate: '#444444',
  tabBar: '#ffffff', tabBarBorder: '#000000',
  accent: '#0044cc', onAccent: '#ffffff',
};

export const THEME_PACKS: Record<ThemePackKey, ThemePack> = {
  midnight: { label: 'Midnight', blurb: 'The original. Navy, legible at 2am.', dark, light },
  oled: { label: 'OLED Black', blurb: 'True black for OLED screens. Dark only.', dark: oledDark },
  steam: { label: 'Steam', blurb: "Valve's navy and light blue. Dark only.", dark: steamDark },
  nord: { label: 'Nord', blurb: 'Arctic, bluish greys. Dark only.', dark: nordDark },
  dracula: { label: 'Dracula', blurb: 'Purple accent on deep grey. Dark only.', dark: draculaDark },
  solarized: { label: 'Solarized', blurb: 'Precision colours; has a light side too.', dark: solarizedDark, light: solarizedLight },
  contrast: { label: 'High Contrast', blurb: 'Maximum legibility, both schemes.', dark: contrastDark, light: contrastLight },
};

export const THEME_PACK_KEYS = Object.keys(THEME_PACKS) as ThemePackKey[];

/** The pack's palette for a scheme; a dark-only pack stays dark in light mode. */
export function packPalette(pack: ThemePackKey, scheme: 'light' | 'dark'): Palette {
  const p = THEME_PACKS[pack] ?? THEME_PACKS.midnight;
  return scheme === 'light' && p.light ? p.light : p.dark;
}

// ---------------------------------------------------------------------------
// Type + numeric fragments (unchanged)
// ---------------------------------------------------------------------------

export const mono = Platform.select({
  ios: 'Menlo',
  android: 'monospace',
  default: 'monospace',
});

/** Style fragment for numeric readouts: monospaced digits that don't jitter. */
export const numeric: TextStyle = {
  fontFamily: mono,
  fontVariant: ['tabular-nums'],
};

// Semantic status colors. Take a palette so converted callers get theme-correct
// green/amber/red; default to dark for the not-yet-converted callers (BC).
export function tempColor(c: number | null, t: Palette = dark): string {
  if (c == null) return t.textFaint;
  if (c < 70) return t.green;
  if (c < 85) return t.amber;
  return t.red;
}

export function pctColor(pct: number, t: Palette = dark): string {
  if (pct < 70) return t.green;
  if (pct < 90) return t.amber;
  return t.red;
}

/** Battery charge -> colour. INVERTED relative to pctColor: a disk at 95% is in
 *  trouble, a battery at 95% is fine. Reusing pctColor here would paint a full
 *  battery red. */
export function batteryColor(pct: number, t: Palette = dark): string {
  if (pct <= 15) return t.red;
  if (pct <= 30) return t.amber;
  return t.green;
}

// ---------------------------------------------------------------------------
// Persisted theme preferences (self-contained external store; mirrors the
// prefs.ts / haptics.ts pattern so a segmented control reads/writes live).
// ---------------------------------------------------------------------------

export type ThemeMode = 'system' | 'light' | 'dark';

type ThemePrefs = { mode: ThemeMode; accent: AccentKey; pack: ThemePackKey };

// Default preserves today's look exactly: forced dark, blue accent. Change
// `mode` to 'system' here once the light palette is verified across every
// screen and you want new installs to follow the OS by default.
const THEME_DEFAULTS: ThemePrefs = { mode: 'dark', accent: 'blue', pack: 'midnight' };

const THEME_KEY = 'couchside.theme.v1';

async function storageGet(key: string): Promise<string | null> {
  if (Platform.OS === 'web') {
    try {
      return typeof window !== 'undefined' && window.localStorage
        ? window.localStorage.getItem(key)
        : null;
    } catch {
      return null;
    }
  }
  return SecureStore.getItemAsync(key);
}

async function storageSet(key: string, value: string): Promise<void> {
  if (Platform.OS === 'web') {
    try {
      if (typeof window !== 'undefined' && window.localStorage) {
        window.localStorage.setItem(key, value);
      }
    } catch {
      // storage unavailable (private mode): lives in memory this session
    }
    return;
  }
  await SecureStore.setItemAsync(key, value);
}

let prefs: ThemePrefs = { ...THEME_DEFAULTS };
const listeners = new Set<() => void>();

function emitChange(): void {
  for (const l of listeners) l();
}

function normalize(raw: unknown): ThemePrefs {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const mode: ThemeMode =
    o.mode === 'system' || o.mode === 'light' || o.mode === 'dark'
      ? o.mode
      : THEME_DEFAULTS.mode;
  const accent: AccentKey =
    typeof o.accent === 'string' && (ACCENT_KEYS as string[]).includes(o.accent)
      ? (o.accent as AccentKey)
      : THEME_DEFAULTS.accent;
  const pack: ThemePackKey =
    typeof o.pack === 'string' && (THEME_PACK_KEYS as string[]).includes(o.pack)
      ? (o.pack as ThemePackKey)
      : THEME_DEFAULTS.pack;
  return { mode, accent, pack };
}

let loadStarted = false;
/** Load persisted theme prefs once. Safe to call repeatedly. */
export async function loadThemePrefs(): Promise<void> {
  if (loadStarted) return;
  loadStarted = true;
  const raw = await storageGet(THEME_KEY);
  if (raw == null) return;
  try {
    prefs = normalize(JSON.parse(raw));
    emitChange();
  } catch {
    // malformed blob: keep defaults
  }
}
// Kick the load off at import so values are ready by first paint.
void loadThemePrefs();

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

export function getThemeMode(): ThemeMode {
  return prefs.mode;
}

export async function setThemeMode(mode: ThemeMode): Promise<void> {
  if (prefs.mode === mode) return;
  prefs = { ...prefs, mode };
  emitChange();
  // Native chrome (status bar) is synced in the root _layout via expo-status-bar
  // driven by useResolvedScheme() — see the sweep. Palette override is JS-side.
  await storageSet(THEME_KEY, JSON.stringify(prefs));
}

export function useThemeMode(): ThemeMode {
  return useSyncExternalStore(
    subscribe,
    () => prefs.mode,
    () => prefs.mode,
  );
}

export function getAccent(): AccentKey {
  return prefs.accent;
}

export async function setAccent(accent: AccentKey): Promise<void> {
  if (prefs.accent === accent) return;
  prefs = { ...prefs, accent };
  emitChange();
  await storageSet(THEME_KEY, JSON.stringify(prefs));
}

export function useAccent(): AccentKey {
  return useSyncExternalStore(
    subscribe,
    () => prefs.accent,
    () => prefs.accent,
  );
}

export function getThemePack(): ThemePackKey {
  return prefs.pack;
}

export async function setThemePack(pack: ThemePackKey): Promise<void> {
  if (prefs.pack === pack) return;
  prefs = { ...prefs, pack };
  emitChange();
  await storageSet(THEME_KEY, JSON.stringify(prefs));
}

export function useThemePack(): ThemePackKey {
  return useSyncExternalStore(
    subscribe,
    () => prefs.pack,
    () => prefs.pack,
  );
}

// ---------------------------------------------------------------------------
// Contrast helpers
// ---------------------------------------------------------------------------

/** WCAG relative luminance of a '#rrggbb' colour (0 = black, 1 = white).
 *  Anything unparsable reads as mid-grey, which makes textOn pick dark text —
 *  the conservative choice on a light surface and harmless on a dark one. */
export function relLum(hex: string): number {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})/i.exec(hex.trim());
  if (!m) return 0.5;
  const ch = (h: string) => {
    const c = parseInt(h, 16) / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * ch(m[1]) + 0.7152 * ch(m[2]) + 0.0722 * ch(m[3]);
}

/**
 * The text colour to paint ON a filled surface of colour `surface`, chosen for
 * contrast: dark text on light-ish fills, light text on dark fills. Black and
 * white reach equal contrast at luminance ≈ 0.18, so that is the split.
 *
 * `t.onAccent` / `t.onGreen` / `t.onRed` are already resolved this way by
 * useTheme(); reach for textOn() directly when the surface is chosen at render
 * time (a per-danger badge, a service brand colour, a user-picked swatch).
 */
export function textOn(surface: string, t: Palette): string {
  const dark = relLum(t.bg) < 0.5;           // is this a dark palette?
  const darkText = dark ? t.onAccent : t.text; // the palette's dark candidate
  const lightText = dark ? t.text : t.onAccent; // ...and its light candidate
  return relLum(surface) >= 0.18 ? darkText : lightText;
}

// ---------------------------------------------------------------------------
// The hooks components use
// ---------------------------------------------------------------------------

/** The active scheme after applying the user's override to the system scheme. */
export function useResolvedScheme(): 'light' | 'dark' {
  const system = useColorScheme();
  const mode = useThemeMode();
  if (mode === 'system') return system === 'light' ? 'light' : 'dark';
  return mode;
}

/** The live palette: scheme-correct base with the chosen accent applied. */
export function useTheme(): Palette {
  const scheme = useResolvedScheme();
  const accent = useAccent();
  const pack = useThemePack();
  return useMemo(() => {
    const base = packPalette(pack, scheme);
    // 'blue' is the "Default" slot = the pack's own accent; any other key
    // overrides it. The accent drives the primary active/link color (`blue`).
    const acc = accent === 'blue' ? base.accent : ACCENTS[accent][scheme];
    const resolved: Palette = { ...base, accent: acc, blue: acc };
    // On-surface text is DERIVED from the surface it sits on, not fixed per
    // palette: a light accent (amber, Steam's sky blue) wants dark text, a deep
    // one (Solarized blue) wants light — and the accent picker can swap the
    // surface under the text at runtime. The static tokens above are the two
    // candidates textOn() chooses between.
    return {
      ...resolved,
      onAccent: textOn(acc, resolved),
      onGreen: textOn(resolved.green, resolved),
      onRed: textOn(resolved.red, resolved),
    };
  }, [scheme, accent, pack]);
}

/**
 * Memoized themed StyleSheet. Convert a module-scope
 *   `const styles = StyleSheet.create({ card: { backgroundColor: theme.card } })`
 * into
 *   `const makeStyles = (t: Palette) => StyleSheet.create({ card: { backgroundColor: t.card } });`
 *   `const styles = useThemedStyles(makeStyles);` (inside the component)
 * so the styles rebuild when the theme changes.
 */
export function useThemedStyles<T>(factory: (t: Palette) => T): T {
  const t = useTheme();
  return useMemo(() => factory(t), [t]);
}
