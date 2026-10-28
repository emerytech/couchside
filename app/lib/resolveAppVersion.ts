/**
 * Pure version/build/label resolution for the running binary, split out of
 * appVersion.ts so it can be unit-tested WITHOUT importing expo-application /
 * expo-constants / react-native — none of which load under bare-node CI (the
 * same reason app-update.ts keeps its logic in a pure lib module).
 *
 * THE BUG this fixes (Account/About "Couchside v" rendered blank on Android
 * builds 47/48 despite correct installs): the old chain used `??`, which falls
 * back only on null/undefined — NOT on an empty string. expo-application's
 * native getters return "" (not null) on some builds, so
 * `nativeApplicationVersion ?? Constants.expoConfig?.version ?? '—'` passed the
 * empty string straight through and the version came out "". nonEmpty() coerces
 * "" and whitespace-only to undefined so the fallback chain actually runs, and
 * '—' is reached only when every source is genuinely absent.
 */

/** A usable string, or undefined for null/undefined/""/whitespace-only. The
 *  guard the `??` chain was missing. */
export function nonEmpty(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() !== '' ? v : undefined;
}

export interface AppVersionInputs {
  /** Application.nativeApplicationVersion (CFBundleShortVersionString / versionName). */
  nativeVersion?: string | null;
  /** Application.nativeBuildVersion (CFBundleVersion / versionCode). */
  nativeBuild?: string | null;
  /** Constants.expoConfig?.version — the app.json fallback. */
  expoVersion?: string | null;
  /** Constants.expoConfig?.ios?.buildNumber — iOS fallback build. */
  expoIosBuild?: string | null;
  /** Constants.expoConfig?.android?.versionCode — Android fallback build. */
  expoAndroidVersionCode?: number | null;
  /** Platform.OS === 'ios'. Selects the fallback build source and the label word. */
  isIos: boolean;
}

export interface AppVersionInfo {
  /** Marketing version, or '—' when nothing resolves. */
  version: string;
  /** Build/versionCode as a string, or '' when nothing resolves. */
  build: string;
  /** "2.9.61 (vc 109)" / "2.9.61 (build 219)" / bare "2.9.61" — the About row. */
  label: string;
}

export function resolveAppVersion(inp: AppVersionInputs): AppVersionInfo {
  const version = nonEmpty(inp.nativeVersion) ?? nonEmpty(inp.expoVersion) ?? '—';
  const expoBuild = inp.isIos
    ? nonEmpty(inp.expoIosBuild)
    : inp.expoAndroidVersionCode != null
      ? String(inp.expoAndroidVersionCode)
      : undefined;
  const build = nonEmpty(inp.nativeBuild) ?? expoBuild ?? '';
  const label = `${version}${build ? ` (${inp.isIos ? 'build' : 'vc'} ${build})` : ''}`;
  return { version, build, label };
}
