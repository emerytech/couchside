import React, { useCallback, useEffect, useState } from 'react';
import { Image, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { recordPurchaseDate } from '@/lib/entitlement';
import { useEntitlement } from '@/lib/EntitlementContext';
import {
  buy,
  userFacingPurchaseError,
  getProduct,
  restoreFromUserAction,
  openRedeemCode,
  REDEEM_STORE_NAME,
} from '@/lib/purchase';
import { mono, useThemedStyles } from '@/lib/theme';
import type { Palette } from '@/lib/theme';

const FALLBACK_PRICE = '$4.99';

/**
 * Full-screen gate shown on Console/Actions/Pad/Logs once the 7-day trial is
 * over and the unlock hasn't been purchased. Setup stays reachable via the
 * tab bar.
 */
export default function Paywall() {
  const insets = useSafeAreaInsets();
  const { recordPurchase } = useEntitlement();
  const styles = useThemedStyles(makeStyles);

  const [price, setPrice] = useState<string | null>(null);
  const [busy, setBusy] = useState<'buy' | 'restore' | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    getProduct().then((p) => {
      if (!cancelled && p?.displayPrice) setPrice(p.displayPrice);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const onBuy = useCallback(async () => {
    setBusy('buy');
    setError(null);
    const result = await buy();
    if (result.ok) {
      await recordPurchase(); // gate unmounts via context state
    } else if (result.reason === 'pending') {
      setError("Purchase pending. You'll be unlocked once payment completes.");
    } else if (result.reason === 'unavailable') {
      setError('Store unavailable. Please try again later.');
    } else if (result.reason === 'error') {
      setError(userFacingPurchaseError(result.message) ?? 'Purchase failed. Please try again.');
    }
    // 'cancelled': no error text, the user changed their mind
    setBusy(null);
  }, [recordPurchase]);

  const onRestore = useCallback(async () => {
    setBusy('restore');
    setError(null);
    const result = await restoreFromUserAction();
    if (result.state === 'purchased') {
      if (result.purchaseDateMs != null) await recordPurchaseDate(result.purchaseDateMs);
      await recordPurchase();
    } else if (result.state === 'cancelled') {
      // Backed out of the store's own sheet — nothing was checked, so nothing
      // is claimed and nothing is said.
    } else if (result.state === 'none') {
      // See the same message in setup.tsx: we cannot know the user has no
      // purchase, only that this device's store cache has none.
      setError(
        "No purchase found on this Apple ID. If you redeemed a code, tap Unlock — " +
          "you won't be charged again for something you already own.",
      );
    } else if (result.state === 'unavailable') {
      setError('Store unavailable. Please try again later.');
    } else {
      setError(result.message || 'Restore failed. Please try again.');
    }
    setBusy(null);
  }, [recordPurchase]);

  return (
    <View
      style={[
        styles.screen,
        { paddingTop: insets.top + 24, paddingBottom: insets.bottom + 24 },
      ]}>
      <View style={styles.body}>
        <View style={styles.markWrap}>
          <Image source={require('@/assets/images/icon.png')} style={styles.mark} />
        </View>
        <Text style={styles.appName}>Couchside</Text>
        <Text style={styles.title}>7-day trial ended</Text>
        <Text style={styles.blurb}>
          If Couchside has earned a spot in your setup, one purchase unlocks it permanently and
          supports the work. No subscription, no account, no tracking.
        </Text>

        <Pressable
          onPress={onBuy}
          disabled={busy != null}
          style={({ pressed }) => [
            styles.buyBtn,
            (pressed || busy != null) && styles.pressed,
          ]}>
          <Text style={styles.buyBtnText}>
            {busy === 'buy' ? 'PURCHASING…' : `UNLOCK ${price ?? FALLBACK_PRICE}`}
          </Text>
        </Pressable>

        <Pressable
          onPress={onRestore}
          disabled={busy != null}
          style={({ pressed }) => [
            styles.restoreBtn,
            (pressed || busy != null) && styles.pressed,
          ]}>
          <Text style={styles.restoreBtnText}>
            {busy === 'restore' ? 'RESTORING…' : 'RESTORE PURCHASES'}
          </Text>
        </Pressable>

        {error != null && <Text style={styles.error}>{error}</Text>}

        <Pressable
          onPress={() => void openRedeemCode()}
          disabled={busy != null}
          hitSlop={8}
          style={({ pressed }) => [styles.redeemHint, pressed && styles.pressed]}>
          <Text style={styles.redeemHintText}>
            Have a code? Redeem it in the {REDEEM_STORE_NAME}, then tap Restore.
          </Text>
        </Pressable>
      </View>
    </View>
  );
}

const makeStyles = (t: Palette) => StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: t.bg,
    paddingHorizontal: 28,
    justifyContent: 'space-between',
  },
  body: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  markWrap: {
    borderRadius: 22,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: t.cardBorder,
    marginBottom: 18,
  },
  mark: { width: 88, height: 88 },
  appName: {
    color: t.text,
    fontSize: 24,
    fontWeight: '800',
    fontFamily: mono,
    marginBottom: 6,
  },
  title: { color: t.amber, fontSize: 15, fontWeight: '700', marginBottom: 12 },
  blurb: {
    color: t.textDim,
    fontSize: 13,
    lineHeight: 19,
    textAlign: 'center',
    marginBottom: 28,
  },
  buyBtn: {
    alignSelf: 'stretch',
    backgroundColor: t.blue,
    borderRadius: 10,
    paddingVertical: 15,
    alignItems: 'center',
    marginBottom: 12,
  },
  buyBtnText: { color: t.onAccent, fontSize: 14, fontWeight: '800', letterSpacing: 1 },
  restoreBtn: {
    alignSelf: 'stretch',
    backgroundColor: t.inset,
    borderColor: t.cardBorder,
    borderWidth: 1,
    borderRadius: 10,
    paddingVertical: 13,
    alignItems: 'center',
  },
  restoreBtnText: { color: t.textDim, fontSize: 13, fontWeight: '700', letterSpacing: 1 },
  error: {
    color: t.red,
    fontSize: 12,
    fontFamily: mono,
    textAlign: 'center',
    marginTop: 14,
  },
  redeemHint: { marginTop: 20, paddingHorizontal: 8 },
  redeemHintText: {
    color: t.textDim,
    fontSize: 12,
    lineHeight: 17,
    textAlign: 'center',
    textDecorationLine: 'underline',
  },
  pressed: { opacity: 0.7 },
});
