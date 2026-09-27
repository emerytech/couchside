/**
 * JS binding for the local ExitReason module (Android 11+). See the Kotlin file.
 * Absent on iOS and web, and returns null on older Android or on any failure —
 * callers treat null as "the OS did not say".
 */
import { requireOptionalNativeModule } from 'expo-modules-core';

import type { ExitInfo } from '../../lib/crashLogCore';

type Native = { getLastExitReason(): Record<string, unknown> | null };

const native = requireOptionalNativeModule<Native>('ExitReason');

/** Newest exit record for this app's previous process, or null. Never throws. */
export function lastExitReason(): ExitInfo | null {
  if (!native) return null;
  try {
    const r = native.getLastExitReason();
    if (!r || typeof r.reason !== 'number' || typeof r.timestamp !== 'number') return null;
    return {
      reason: r.reason,
      timestamp: r.timestamp,
      status: typeof r.status === 'number' ? r.status : undefined,
      description: typeof r.description === 'string' ? r.description : undefined,
    };
  } catch {
    return null;
  }
}
