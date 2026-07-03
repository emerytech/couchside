import React from 'react';

import Paywall from '@/components/Paywall';
import { isDemo } from '@/lib/demo';
import { useEntitlement } from '@/lib/EntitlementContext';
import { useSettings } from '@/lib/SettingsContext';

/**
 * Wraps a gated tab screen (Console, Actions, Pad, Logs): once the 7-day
 * trial has expired and the unlock hasn't been purchased, the tab content is
 * replaced by the full-screen Paywall. Demo mode (host "demo") is never
 * gated, and the Setup tab never uses this wrapper so users can always flip
 * to demo or restore a purchase.
 *
 * Hook order is stable: the same hooks run on every render, and the gated
 * screen simply doesn't mount while locked.
 */
export function Gated({ children }: { children: React.ReactNode }) {
  const { settings, ready: settingsReady } = useSettings();
  const { entitlement, ready: entitlementReady } = useEntitlement();

  // Persisted state loads in milliseconds; render nothing rather than
  // flashing either the paywall or locked content.
  if (!settingsReady || !entitlementReady) return null;

  if (entitlement.state === 'expired' && !isDemo(settings)) return <Paywall />;
  return <>{children}</>;
}
