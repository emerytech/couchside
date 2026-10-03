import { redirectLicenseLink } from '@/lib/licenseActivation';

// Expo applies this for both cold starts and links received by a running app.
export function redirectSystemPath({ path }: { path: string; initial: boolean }) {
  return redirectLicenseLink(path, process.env.EXPO_PUBLIC_DIRECT === '1');
}
