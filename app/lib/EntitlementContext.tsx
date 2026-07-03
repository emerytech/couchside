import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
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

  const refresh = useCallback(async () => {
    setEntitlement(await getEntitlement());
  }, []);

  const recordPurchase = useCallback(async () => {
    await markPurchased();
    setEntitlement(await getEntitlement());
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
