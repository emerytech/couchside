/**
 * JS binding for the local AppIconSwitch module (Android only). See the Kotlin
 * file for why this exists next to expo-alternate-app-icons. On any platform
 * where the native module is absent (iOS, web, a build without it), `available`
 * is false and both functions are inert.
 */
import { requireOptionalNativeModule } from 'expo-modules-core';

type Native = {
  getEnabledAlias(): string | null;
  setEnabledAlias(alias: string | null): Promise<string | null>;
};

const native = requireOptionalNativeModule<Native>('AppIconSwitch');

export const available: boolean = native != null;

/** Alias suffix of the enabled launcher component, or null for the default. Never throws. */
export function getEnabledAlias(): string | null {
  if (!native) return null;
  try {
    return native.getEnabledAlias() ?? null;
  } catch {
    return null;
  }
}

/** Enable exactly the launcher component for `alias` (null = default). Throws on an unknown alias. */
export async function setEnabledAlias(alias: string | null): Promise<string | null> {
  if (!native) throw new Error('AppIconSwitch native module not available');
  return (await native.setEnabledAlias(alias)) ?? null;
}
