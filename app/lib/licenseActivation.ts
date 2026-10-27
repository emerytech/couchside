/** Native-link staging only. No persistence, logging, clipboard reads, or redemption. */
export type LicenseActivation = { id: number; key: string };
let pending: LicenseActivation | null = null;
let serial = 0;
const listeners = new Set<() => void>();
export const getLicenseActivation = () => pending;
export function subscribeLicenseActivation(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
function publish(value: LicenseActivation | null) {
  pending = value;
  for (const listener of listeners) listener();
}
export function clearLicenseActivation(id: number) {
  // A slow redemption must not erase a newer inbound license.
  if (pending?.id === id) publish({ id, key: '' });
}
export function resetLicenseActivation() { publish(null); }

/** Strip license-bearing links BEFORE Expo Router creates route params/history. */
export function redirectLicenseLink(path: string, direct: boolean): string {
  try {
    const url = new URL(path, 'couchside:///');
    if (!url.searchParams.has('license')) return path;
    // Never pass a rejected license-bearing URL into navigation/error reports.
    const safe = '/setup?tab=account';
    if (!direct) return '/setup';
    const keys = url.searchParams.getAll('license');
    if (path.length > 9000 || url.protocol !== 'couchside:' || url.hostname ||
        url.pathname !== '/setup' || url.username || url.password || url.hash ||
        keys.length !== 1 || keys[0].length > 8192 ||
        !/^CS1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{86}$/.test(keys[0])) {
      resetLicenseActivation();
      return safe;
    }
    const request = { id: ++serial, key: keys[0] };
    publish(request);
    return `${safe}&activation=${request.id}`;
  } catch {
    // A malformed external URL must not crash startup or expose its contents.
    return '/setup';
  }
}
