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
  blue: string;
  slate: string;
  tabBar: string;
  tabBarBorder: string;
  /** The resolved accent hue (drives the active/link color; mirrors `blue`). */
  accent: string;
};

/** Dark ops-console palette. Legible at 2am. The historical default. */
const dark: Palette = {
  bg: '#0b1220',
  card: '#141c2e',
  cardBorder: '#1e2942',
  inset: '#0e1526',
  text: '#e5ecf8',
  textDim: '#8b97ad',
  textFaint: '#5b6780',
  green: '#34d399',
  amber: '#fbbf24',
  red: '#f87171',
  redDeep: '#7f1d1d',
  blue: '#60a5fa',
  slate: '#64748b',
  tabBar: '#0e1526',
  tabBarBorder: '#1e2942',
  accent: '#60a5fa',
};

/** Light palette. Same navy/green identity, tuned for contrast on a light bg. */
const light: Palette = {
  bg: '#f6f8fc',
  card: '#ffffff',
  cardBorder: '#dbe3f0',
  inset: '#eef2f9',
  text: '#0b1220',
  textDim: '#4a5670',
  textFaint: '#8b97ad',
  green: '#059669',
  amber: '#b45309',
  red: '#dc2626',
  redDeep: '#fecaca',
  blue: '#2563eb',
  slate: '#64748b',
  tabBar: '#ffffff',
  tabBarBorder: '#dbe3f0',
  accent: '#2563eb',
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
  blue: { label: 'Blue', dark: '#60a5fa', light: '#2563eb' },
  green: { label: 'Green', dark: '#34d399', light: '#059669' },
  violet: { label: 'Violet', dark: '#a78bfa', light: '#7c3aed' },
  amber: { label: 'Amber', dark: '#fbbf24', light: '#d97706' },
  rose: { label: 'Rose', dark: '#fb7185', light: '#e11d48' },
  teal: { label: 'Teal', dark: '#2dd4bf', light: '#0d9488' },
};

export const ACCENT_KEYS = Object.keys(ACCENTS) as AccentKey[];

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

// ---------------------------------------------------------------------------
// Persisted theme preferences (self-contained external store; mirrors the
// prefs.ts / haptics.ts pattern so a segmented control reads/writes live).
// ---------------------------------------------------------------------------

export type ThemeMode = 'system' | 'light' | 'dark';

type ThemePrefs = { mode: ThemeMode; accent: AccentKey };

// Default preserves today's look exactly: forced dark, blue accent. Change
// `mode` to 'system' here once the light palette is verified across every
// screen and you want new installs to follow the OS by default.
const THEME_DEFAULTS: ThemePrefs = { mode: 'dark', accent: 'blue' };

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
  return { mode, accent };
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
  return useMemo(() => {
    const base = palettes[scheme];
    const acc = ACCENTS[accent][scheme];
    // The accent drives the primary active/link color (historically `blue`).
    return { ...base, accent: acc, blue: acc };
  }, [scheme, accent]);
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
