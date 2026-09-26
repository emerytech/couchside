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
 * APPLIED WHEN THE USER LEAVES THE APP (device finding, Razr 2026-09-26): Android
 * FINISHES any running activity whose component is disabled — DONT_KILL_APP keeps
 * the process, not the activity. Switching while on screen therefore threw the
 * user out to the home screen the moment they tapped a card. So a tap only
 * REQUESTS an icon (the picker shows it selected at once); the switch runs when
 * the app goes to the background — Home, the app switcher, another app — when
 * closing the activity costs nothing, and the new icon is on the home screen by
 * the time they look. Picking the current icon again cancels the request.
 *
 * The choices a build offers come from `expo.extra.appIcons` (declared per
 * build in app.config.js; the store app declares none). The enabled launcher
 * component IS the persistence — nothing is written to settings here. On web,
 * iOS, or a build that declares nothing, `appIconChoices()` is [] and the
 * Setup row does not render; no native call is made at all in that case.
 */
import Constants from 'expo-constants';
import { AppState, type AppStateStatus } from 'react-native';

import { parseAppIconChoices, type AppIconChoice } from './appIcon';
import * as Switch from '../modules/app-icon-switch';

let cached: AppIconChoice[] | null = null;
/** Alias requested but not applied yet (null = the default icon); undefined = none pending. */
let pending: string | null | undefined;
let listening = false;
const subscribers = new Set<() => void>();

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

/** Alias requested and waiting for the app to leave the foreground, or undefined. */
export function pendingAppIcon(): string | null | undefined {
  return pending;
}

/** Re-render hook for the picker: called when a request is made, cancelled or applied. */
export function subscribeAppIcon(fn: () => void): () => void {
  subscribers.add(fn);
  return () => subscribers.delete(fn);
}

function notify(): void {
  for (const fn of subscribers) {
    try {
      fn();
    } catch {
      // a subscriber must never stop the others
    }
  }
}

async function applyPending(): Promise<void> {
  const want = pending;
  if (want === undefined) return;
  pending = undefined;
  try {
    if (want !== Switch.getEnabledAlias()) await Switch.setEnabledAlias(want);
  } catch {
    // Refused or failed: nothing changed (the module enables before it disables).
  }
  notify();
}

function onAppState(s: AppStateStatus): void {
  if (s === 'background') void applyPending();
}

/**
 * Request an icon. Only aliases this build declared are accepted (the caller
 * validates with aliasFromValue; this re-checks), so a stale or foreign value
 * can never reach PackageManager. The switch itself happens when the app next
 * goes to the background; requesting the icon already in use cancels.
 */
export function requestAppIcon(alias: string | null): void {
  if (alias !== null && !appIconChoices().some((c) => c.alias === alias)) {
    throw new Error(`unknown app icon "${alias}"`);
  }
  if (!listening) {
    AppState.addEventListener('change', onAppState);
    listening = true;
  }
  pending = alias === Switch.getEnabledAlias() ? undefined : alias;
  notify();
}
