import { useSyncExternalStore } from 'react';
import { getLicenseActivation, subscribeLicenseActivation } from '@/lib/licenseActivation';
export function useLicenseActivation() {
  return useSyncExternalStore(subscribeLicenseActivation, getLicenseActivation, getLicenseActivation);
}
