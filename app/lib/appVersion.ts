/**
 * The running binary's version, build and package id — one definition, shared by
 * the Setup About row, the crash screen, and the error log's report header.
 *
 * Read the NATIVE values — CFBundleShortVersionString / CFBundleVersion on iOS,
 * versionName / versionCode on Android — because `expoConfig` is baked from
 * app.json when the JS bundle is built and can lag the actual binary: a
 * TestFlight build 46 install reported "build 45", which sent us chasing a
 * phantom install problem. expoConfig is only a fallback (e.g. Expo Go, where
 * the native values are the host app's, and web, where they are null).
 *
 * These come from expo-application. `Constants.nativeBuildVersion` does NOT
 * exist in SDK 57 — expo-constants only carries a deprecation note pointing
 * here — and reading it off Constants silently yields undefined (it typechecks
 * only because those manifest types have a `Record<string, any>` index
 * signature), which would quietly reinstate the very bug this fixes.
 *
 * (Moved here from app/(tabs)/setup.tsx, comment and all, when the error log
 * needed the same values; a crash report is only useful with the exact build.)
 */
import * as Application from 'expo-application';
import Constants from 'expo-constants';
import { Platform } from 'react-native';
import { resolveAppVersion } from './resolveAppVersion';

// Resolution (incl. the empty-string guard that stops a blank About row) lives
// in the pure, bare-node-testable resolveAppVersion — see that file's header.
// expo-application's native getters return "" (not null) on some builds, which
// the old `??` chain let through; nonEmpty() inside the resolver coerces it so
// the app.json fallback actually runs.
const _version = resolveAppVersion({
  nativeVersion: Application.nativeApplicationVersion,
  nativeBuild: Application.nativeBuildVersion,
  expoVersion: Constants.expoConfig?.version ?? null,
  expoIosBuild: Constants.expoConfig?.ios?.buildNumber ?? null,
  expoAndroidVersionCode: Constants.expoConfig?.android?.versionCode ?? null,
  isIos: Platform.OS === 'ios',
});

export const APP_VERSION: string = _version.version;

export const APP_BUILD: string = _version.build;

/** "2.9.61 (vc 109)" / "2.9.61 (build 219)" — the About row's format. */
export const APP_LABEL: string = _version.label;

/**
 * Android applicationId / iOS bundle id; '' on web. This is what tells the store
 * app (com.ets3d.rescueremote) from the direct edition (….direct — see
 * app.config.js on build/direct-apk), and it is the package a user filters
 * `adb logcat` output by.
 */
export const APP_ID: string = Application.applicationId ?? '';

/** The Android package ids this app ships under, for help text when the
 *  runtime value is unavailable (web). Store first. */
export const ANDROID_PACKAGES = ['com.ets3d.rescueremote', 'com.ets3d.rescueremote.direct'] as const;
