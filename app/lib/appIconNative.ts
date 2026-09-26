/**
 * User-selectable home-screen icon — the native half. See lib/appIcon.ts for
 * the why and the pure parsing; this file is the only place that touches
 * `expo-alternate-app-icons` and `expo-constants`.
 *
 * The choices a build offers come from `expo.extra.appIcons` (declared per build
 * in app.config.js; the store app declares none). The CURRENT icon is whatever
 * launcher alias PackageManager has enabled — that IS the persistence, so
 * nothing is written to settings here. On web, or on a build that declares
 * nothing, `appIconChoices()` is [] and the Setup row does not render.
 */
import Constants from 'expo-constants';
import {
  getAppIconName,
  setAlternateAppIcon,
  supportsAlternateIcons,
} from 'expo-alternate-app-icons';

import { parseAppIconChoices, type AppIconChoice } from './appIcon';

let cached: AppIconChoice[] | null = null;

/** The icons THIS build offers (>= 2 incl. the default), or [] = no row. */
export function appIconChoices(): AppIconChoice[] {
  if (cached) return cached;
  const declared = supportsAlternateIcons
    ? parseAppIconChoices((Constants.expoConfig?.extra as { appIcons?: unknown } | undefined)?.appIcons)
    : [];
  cached = declared;
  return declared;
}

/** Alias currently enabled by the OS (null = the build's default icon). */
export function currentAppIcon(): string | null {
  if (!supportsAlternateIcons) return null;
  try {
    return getAppIconName() ?? null;
  } catch {
    return null;
  }
}

/**
 * Switch the launcher icon. The module enables the new alias BEFORE disabling
 * the old one, with DONT_KILL_APP, so the app is never left without a launcher
 * entry; some launchers still reset pinned shortcuts, which the Setup copy
 * warns about. Resolves to the alias now active (null = default). Only aliases
 * this build declared are ever passed through (the caller validates with
 * aliasFromValue), so a stale or foreign value can never reach PackageManager.
 */
export async function setAppIcon(alias: string | null): Promise<string | null> {
  if (!supportsAlternateIcons) return null;
  if (alias !== null && !appIconChoices().some((c) => c.alias === alias)) {
    throw new Error(`unknown app icon "${alias}"`);
  }
  // The package types the argument by a generated union; the runtime contract is a string or null.
  const result = await setAlternateAppIcon(alias as never);
  return result ?? null;
}
