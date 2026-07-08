import React, { useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { subscribeUnlocked } from '@/lib/EntitlementContext';
import { mono, theme } from '@/lib/theme';

/** Matches the launch-tab toast lifetime. */
const UNLOCK_TOAST_MS = 1500;

/**
 * Global, non-blocking "Unlocked — thanks" toast.
 *
 * Mounted at the root layout (a sibling of the navigator), so it survives the
 * Paywall unmount that happens the instant an unlock flips the gate: Gated swaps
 * Paywall for the real tab content the moment entitlement becomes 'purchased'
 * (see components/Gated.tsx), so a toast rendered inside Paywall would die with
 * it. This one lives above the tabs and fires off EntitlementContext's one-shot
 * unlock signal, so it covers buy, restore, and out-of-band/deferred purchases
 * — announcing once, then auto-dismissing (~1.5s). No confirmation screen: the
 * native purchase sheet already confirmed the transaction.
 */
export function UnlockToast() {
  const insets = useSafeAreaInsets();
  const [shown, setShown] = useState(false);
  const [early, setEarly] = useState(false);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const unsub = subscribeUnlocked((info) => {
      setEarly(info.isEarlyAdopter);
      setShown(true);
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => setShown(false), UNLOCK_TOAST_MS);
    });
    return () => {
      unsub();
      if (timer) clearTimeout(timer);
    };
  }, []);

  if (!shown) return null;

  return (
    <View style={[styles.toast, { top: insets.top + 12 }]} pointerEvents="none">
      <Text style={styles.toastText}>Unlocked — thanks</Text>
      {early && <Text style={styles.earlyText}>★ Early Adopter unlocked</Text>}
    </View>
  );
}

// Box matches the launch-tab toast (lib theme, dark ops-console look); anchored
// at the top since, unlike the in-tab toast, this floats above the tab bar too.
const styles = StyleSheet.create({
  toast: {
    position: 'absolute',
    left: 24,
    right: 24,
    backgroundColor: theme.inset,
    borderColor: theme.cardBorder,
    borderWidth: 1,
    borderRadius: 12,
    paddingVertical: 12,
    paddingHorizontal: 16,
    alignItems: 'center',
    gap: 4,
    shadowColor: '#000',
    shadowOpacity: 0.4,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: 8 },
    elevation: 12,
    zIndex: 1000,
  },
  toastText: { color: theme.text, fontSize: 14, fontWeight: '600', fontFamily: mono },
  earlyText: { color: theme.amber, fontSize: 12, fontWeight: '700', fontFamily: mono },
});
