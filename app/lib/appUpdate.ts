/**
 * Pure logic for the mobile-app update check. NO react-native / expo import, so
 * it is testable off-device (app/__tests__/app-update.ts). The component
 * (AppUpdateRow) feeds it the platform + the expo-application values.
 */

export type Manifest = {
  ios?: { version?: string; url?: string };
  android?: { versionCode?: number; version?: string; url?: string };
};

export type Result =
  | { state: 'checking' }
  | { state: 'current' }
  | { state: 'update'; latest: string; url: string }
  | { state: 'unknown' };

/** semver-ish compare: 1 if a>b, -1 if a<b, 0 equal. Missing parts read as 0.
 *  Component-wise and numeric, so 2.9.9 < 2.9.21 (a string compare gets this
 *  backwards). */
export function cmpVersion(a: string, b: string): number {
  const pa = a.split('.').map((n) => parseInt(n, 10) || 0);
  const pb = b.split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d !== 0) return d > 0 ? 1 : -1;
  }
  return 0;
}

/**
 * The whole decision. iOS compares the marketing version; Android compares
 * versionCode (a monotonic int) because a marketing version can repeat across
 * builds but versionCode never goes backward. Anything missing (offline, older
 * manifest, unknown platform) degrades to 'unknown' — never a false 'update'
 * and never a thrown error.
 */
export function decideAppUpdate(
  m: Manifest | null,
  platform: string,
  curVersion: string | null,
  curBuild: string | null,
): Result {
  if (!m) return { state: 'unknown' };
  if (platform === 'ios') {
    const latest = m.ios?.version;
    const url = m.ios?.url;
    if (!latest || !curVersion || !url) return { state: 'unknown' };
    return cmpVersion(latest, curVersion) > 0
      ? { state: 'update', latest, url }
      : { state: 'current' };
  }
  if (platform === 'android') {
    const latestVc = m.android?.versionCode;
    const curVc = parseInt(curBuild ?? '', 10);
    const url = m.android?.url;
    const shown = m.android?.version ?? '';
    if (!latestVc || !Number.isFinite(curVc) || !url) return { state: 'unknown' };
    return latestVc > curVc ? { state: 'update', latest: shown, url } : { state: 'current' };
  }
  return { state: 'unknown' };
}
