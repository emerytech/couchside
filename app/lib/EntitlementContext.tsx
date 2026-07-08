import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import {
  Entitlement,
  getEntitlement,
  markPurchased,
  recordPurchaseDate,
  revalidateWithStore,
  TRIAL_DAYS,
} from './entitlement';
import { setOnPurchased } from './purchase';

/** Payload handed to the global unlock toast when an unlock first completes. */
export type UnlockInfo = { isEarlyAdopter: boolean };

// A tiny module-scope event bus for the one-shot "unlock just completed" signal.
// It lives outside React state so a global toast (mounted above the tabs) can
// react without the purchase flow depending on it, and so a genuine unlock is
// announced AT MOST ONCE per app session no matter which path delivered it
// (buy, restore, or an out-of-band/deferred purchase on a later launch).
const unlockedListeners = new Set<(info: UnlockInfo) => void>();
let unlockAnnounced = false;
let pendingUnlock: UnlockInfo | null = null;

/**
 * Subscribe to the "unlock just completed" signal. Fires at most once per app
 * session, the moment entitlement first transitions to 'purchased'. If the
 * unlock fired before any listener mounted (e.g. a deferred purchase delivered
 * during launch, before the toast subscribed), the latched event is handed to
 * the first subscriber. Returns an unsubscribe fn.
 */
export function subscribeUnlocked(cb: (info: UnlockInfo) => void): () => void {
  unlockedListeners.add(cb);
  if (pendingUnlock) {
    const info = pendingUnlock;
    pendingUnlock = null;
    cb(info);
  }
  return () => {
    unlockedListeners.delete(cb);
  };
}

function emitUnlocked(info: UnlockInfo): void {
  if (unlockedListeners.size === 0) {
    pendingUnlock = info; // latch until the toast subscribes
    return;
  }
  for (const l of unlockedListeners) l(info);
}

type EntitlementContextValue = {
  entitlement: Entitlement;
  /** True once the locally persisted entitlement has been loaded. */
  ready: boolean;
  /** Re-read the local entitlement (e.g. after a restore). */
  refresh: () => Promise<void>;
  /** Persist a completed unlock purchase and refresh. */
  recordPurchase: () => Promise<void>;
};

const EntitlementContext = createContext<EntitlementContextValue>({
  entitlement: { state: 'trial', trialDaysLeft: TRIAL_DAYS, isEarlyAdopter: false },
  ready: false,
  refresh: async () => {},
  recordPurchase: async () => {},
});

export function EntitlementProvider({ children }: { children: React.ReactNode }) {
  const [entitlement, setEntitlement] = useState<Entitlement>({
    state: 'trial',
    trialDaysLeft: TRIAL_DAYS,
    isEarlyAdopter: false,
  });
  const [ready, setReady] = useState(false);

  // Live mirror of the current state so recordPurchase() can tell a genuine
  // unlock transition from a redundant call without adding a dependency.
  const stateRef = useRef(entitlement.state);
  useEffect(() => {
    stateRef.current = entitlement.state;
  }, [entitlement.state]);

  const refresh = useCallback(async () => {
    setEntitlement(await getEntitlement());
  }, []);

  const recordPurchase = useCallback(async () => {
    const wasPurchased = stateRef.current === 'purchased';
    await markPurchased();
    const next = await getEntitlement();
    setEntitlement(next);
    // Announce the global "Unlocked — thanks" toast exactly once, only on a real
    // transition into 'purchased'. Every genuine unlock path funnels through
    // recordPurchase (Paywall buy/restore, and the store listener's onPurchased
    // for out-of-band/deferred purchases), so this one hook covers them all. The
    // module-level latch dedupes buy()'s double call (the purchase listener AND
    // the Paywall both invoke recordPurchase) and won't re-fire on a later
    // restore in the same session.
    if (!unlockAnnounced && !wasPurchased && next.state === 'purchased') {
      unlockAnnounced = true;
      emitUnlocked({ isEarlyAdopter: next.isEarlyAdopter });
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      // 1. Fast local read (purchase cache + trial clock) so the UI settles
      //    immediately, even offline.
      const local = await getEntitlement();
      if (cancelled) return;
      setEntitlement(local);
      setReady(true);
      // 2. Cheap re-validation against the store's own purchase list; falls
      //    back to the local result when the store is flaky (see entitlement.ts).
      const validated = await revalidateWithStore(local);
      if (!cancelled) setEntitlement(validated);
    })();
    // Out-of-band purchases delivered by the store listener (e.g. a purchase
    // interrupted by an app kill and completed on next launch).
    setOnPurchased((purchaseDateMs) => {
      void (async () => {
        if (purchaseDateMs != null) await recordPurchaseDate(purchaseDateMs);
        await recordPurchase();
      })();
    });
    return () => {
      cancelled = true;
      setOnPurchased(null);
    };
  }, [recordPurchase]);

  const value = useMemo(
    () => ({ entitlement, ready, refresh, recordPurchase }),
    [entitlement, ready, refresh, recordPurchase],
  );

  return <EntitlementContext.Provider value={value}>{children}</EntitlementContext.Provider>;
}

export function useEntitlement(): EntitlementContextValue {
  return useContext(EntitlementContext);
}
