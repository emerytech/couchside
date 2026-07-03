import React from 'react';

import Paywall from '@/components/Paywall';
import { useEntitlement } from '@/lib/EntitlementContext';

/**
 * Wraps a gated tab screen (Console, Actions, Pad, Logs): once the 7-day
 * trial has expired and the unlock hasn't been purchased, the tab content is
 * replaced by the full-screen Paywall. The Setup tab never uses this wrapper
 * so users can always restore a purchase.
 *
 * Hook order is stable: the same hooks run on every render, and the gated
 * screen simply doesn't mount while locked.
 */
export function Gated({ children }: { children: React.ReactNode }) {
  const { entitlement, ready: entitlementReady } = useEntitlement();

  // Persisted state loads in milliseconds; render nothing rather than
  // flashing either the paywall or locked content.
  if (!entitlementReady) return null;

  if (entitlement.state === 'expired') return <Paywall />;
  return <>{children}</>;
}
