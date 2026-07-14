import React, { useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { isGenuinelyPurchased } from '@/lib/entitlement';
import { useEntitlement } from '@/lib/EntitlementContext';
import { mono, theme } from '@/lib/theme';
import { lastDayToastShown, markLastDayToastShown } from '@/lib/trialNudge';

const TOAST_MS = 3200;

/**
 * One-shot "Trial ends today" toast, on the final day of the trial.
 *
 * The banner (TrialNudge) is easy to scroll past; this is the last, unmissable
 * word before the paywall lands — and it is deliberately the ONLY interrupting
 * thing in the whole trial. Fires once per install, then never again.
 *
 * Mounted at the root layout, like UnlockToast, so it is not tied to whichever
 * tab happens to be mounted.
 */
export function TrialEndsToast() {
  const insets = useSafeAreaInsets();
  const { entitlement, ready } = useEntitlement();
  const [shown, setShown] = useState(false);

  // Exactly one day left. Not `state === 'trial'` (the store-unreachable
  // fail-open reports 'purchased' over a still-running clock), and not `<= 1`
  // (0 means the trial is already over and the paywall is up — too late to
  // warn).
  const lastDay =
    ready && !isGenuinelyPurchased(entitlement) && entitlement.trialDaysLeft === 1;

  useEffect(() => {
    if (!lastDay) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let cancelled = false;
    void (async () => {
      if (await lastDayToastShown()) return;
      await markLastDayToastShown();
      if (cancelled) return;
      setShown(true);
      timer = setTimeout(() => setShown(false), TOAST_MS);
    })();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [lastDay]);

  if (!shown) return null;

  return (
    <View pointerEvents="none" style={[styles.wrap, { bottom: insets.bottom + 76 }]}>
      <View style={styles.toast}>
        <Text style={styles.title}>Trial ends today</Text>
        <Text style={styles.sub}>Setup › Account to unlock — one-time, no subscription.</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { position: 'absolute', left: 0, right: 0, alignItems: 'center' },
  toast: {
    maxWidth: '90%',
    backgroundColor: theme.card,
    borderColor: theme.amber,
    borderWidth: 1,
    borderRadius: 12,
    paddingVertical: 10,
    paddingHorizontal: 16,
  },
  title: {
    color: theme.amber,
    fontFamily: mono,
    fontSize: 13,
    fontWeight: '800',
    textAlign: 'center',
  },
  sub: { color: theme.textDim, fontSize: 11, marginTop: 3, textAlign: 'center' },
});
