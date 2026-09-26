/**
 * User-selectable home-screen icon — the native half. See lib/appIcon.ts for
 * the why and the pure parsing.
 *
 * Two native pieces, deliberately split:
 *  - `expo-alternate-app-icons` is used ONLY as a prebuild plugin: it generates
 *    the `<activity-alias>` entries and adaptive-icon resources for the icons a
 *    build declares. Its runtime switch is NOT used (it decides the "current"
 *    icon from the launching Activity, so a second switch in one process is a
 *    silent no-op — found in review 2026-09-26).
 *  - `modules/app-icon-switch` (ours, Android) does the switching against
 *    PackageManager truth: enable the target first, then disable every other
 *    launcher component, refuse names this build did not declare.
 *
 * The choices a build offers come from `expo.extra.appIcons` (declared per
 * build in app.config.js; the store app declares none). The enabled launcher
 * component IS the persistence — nothing is written to settings here. On web,
 * iOS, or a build that declares nothing, `appIconChoices()` is [] and the
 * Setup row does not render; no native call is made at all in that case.
 */
import Constants from 'expo-constants';

import { parseAppIconChoices, type AppIconChoice } from './appIcon';
import * as Switch from '../modules/app-icon-switch';

let cached: AppIconChoice[] | null = null;

/** The icons THIS build offers (>= 2 incl. the default), or [] = no row. */
export function appIconChoices(): AppIconChoice[] {
  if (cached) return cached;
  const declared = Switch.available
    ? parseAppIconChoices((Constants.expoConfig?.extra as { appIcons?: unknown } | undefined)?.appIcons)
    : [];
  cached = declared;
  return declared;
}

/**
 * Alias currently ENABLED in PackageManager (null = the build's default icon).
 * Returns null without touching native code when this build offers no choice.
 */
export function currentAppIcon(): string | null {
  if (appIconChoices().length < 2) return null;
  return Switch.getEnabledAlias();
}

/**
 * Switch the launcher icon. Only aliases this build declared are ever passed
 * through (the caller validates with aliasFromValue; this re-checks), so a
 * stale or foreign value can never reach PackageManager. Resolves to the alias
 * PackageManager now has enabled (read back, not echoed).
 */
export async function setAppIcon(alias: string | null): Promise<string | null> {
  if (alias !== null && !appIconChoices().some((c) => c.alias === alias)) {
    throw new Error(`unknown app icon "${alias}"`);
  }
  await Switch.setEnabledAlias(alias);
  return Switch.getEnabledAlias();
}
