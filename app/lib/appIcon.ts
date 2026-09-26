/**
 * User-selectable home-screen icon — the pure half (no React Native imports, so
 * the bare-Node test glob can load it). The native half is lib/appIconNative.ts.
 *
 * WHY. A direct-edition user prefers the Play Store icon over the gold "Pro" one
 * (2026-09-26). Android has no alternate-icon API; the mechanism is one
 * `<activity-alias>` per extra icon (generated at prebuild by
 * `expo-alternate-app-icons`), exactly one enabled, switched at runtime with
 * PackageManager. The DEFAULT icon is the plain MainActivity (whatever
 * `expo.icon` / `android.adaptiveIcon` say for that build); the aliases are the
 * alternates.
 *
 * WHICH icons a build offers is a BUILD-TIME fact, declared per build in
 * `expo.extra.appIcons` (the direct edition's app.config.js declares
 * [Pro = default, Standard = alias]). The store build declares nothing, so the
 * Setup row never renders there and the store APK changes only by linking the
 * native module. Parsing is defensive: anything malformed yields NO choices, and
 * no choices means no row — a bad config hides a preference, never crashes Setup.
 */

/** One selectable icon. `alias === null` is the build's default launcher icon. */
export type AppIconChoice = {
  /** Alias name as declared to the plugin (`.MainActivity<Alias>`), or null for the default icon. */
  alias: string | null;
  /** Short label for the segmented picker. */
  label: string;
};

/** Sentinel the segmented picker uses for the default (null alias) choice. */
export const DEFAULT_ICON_VALUE = '__default__';

// PascalCase, because the alias becomes the class-name suffix `.MainActivity<Alias>` and the
// prebuild plugin PascalCases whatever it is given — a lowercase declaration would name a
// component that does not exist. Requiring the canonical form here keeps the two in step.
const ALIAS_RE = /^[A-Z][A-Za-z0-9]{0,31}$/;

/**
 * Parse `expo.extra.appIcons` into an ordered, de-duplicated choice list.
 * Returns [] unless there are at least TWO valid choices including exactly one
 * default — fewer than two is not a choice, and a list with no default (or two)
 * cannot be represented by the reset-to-null API.
 */
export function parseAppIconChoices(raw: unknown): AppIconChoice[] {
  if (!Array.isArray(raw)) return [];
  const out: AppIconChoice[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (item == null || typeof item !== 'object') continue;
    const { alias, label } = item as { alias?: unknown; label?: unknown };
    if (typeof label !== 'string' || label.trim() === '' || label.length > 24) continue;
    let a: string | null;
    if (alias === null || alias === undefined) a = null;
    else if (typeof alias === 'string' && ALIAS_RE.test(alias)) a = alias;
    else continue;
    const key = a ?? DEFAULT_ICON_VALUE;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ alias: a, label: label.trim() });
  }
  const defaults = out.filter((c) => c.alias === null).length;
  if (out.length < 2 || defaults !== 1) return [];
  return out;
}

/** Picker value for a choice (SegPref needs a string; null is the default sentinel). */
export function iconValue(alias: string | null): string {
  return alias ?? DEFAULT_ICON_VALUE;
}

/** Inverse of iconValue: picker value back to an alias (null = default). */
export function aliasFromValue(value: string, choices: AppIconChoice[]): string | null | undefined {
  if (value === DEFAULT_ICON_VALUE) return null;
  return choices.some((c) => c.alias === value) ? value : undefined;
}
