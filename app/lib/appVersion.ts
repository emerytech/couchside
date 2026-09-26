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

export const APP_VERSION: string =
  Application.nativeApplicationVersion ?? Constants.expoConfig?.version ?? '—';

export const APP_BUILD: string =
  Application.nativeBuildVersion ??
  (Platform.OS === 'ios'
    ? Constants.expoConfig?.ios?.buildNumber ?? ''
    : Constants.expoConfig?.android?.versionCode != null
      ? String(Constants.expoConfig.android.versionCode)
      : '');

/** "2.9.61 (vc 109)" / "2.9.61 (build 219)" — the About row's format. */
export const APP_LABEL: string = `${APP_VERSION}${
  APP_BUILD ? ` (${Platform.OS === 'ios' ? 'build' : 'vc'} ${APP_BUILD})` : ''
}`;

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
