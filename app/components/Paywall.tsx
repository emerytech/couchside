import React, { useCallback, useEffect, useState } from 'react';
import { Image, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { recordPurchaseDate } from '@/lib/entitlement';
import { useEntitlement } from '@/lib/EntitlementContext';
import { buy, getProduct, restore } from '@/lib/purchase';
import { mono, theme } from '@/lib/theme';

const FALLBACK_PRICE = '$4.99';

/**
 * Full-screen gate shown on Console/Actions/Pad/Logs once the 7-day trial is
 * over and the unlock hasn't been purchased. Setup stays reachable via the
 * tab bar.
 */
export default function Paywall() {
  const insets = useSafeAreaInsets();
  const { recordPurchase } = useEntitlement();

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
      setError("Purchase pending — you'll be unlocked once payment completes.");
    } else if (result.reason === 'unavailable') {
      setError('Store unavailable — please try again later.');
    } else if (result.reason === 'error') {
      setError(result.message || 'Purchase failed — please try again.');
    }
    // 'cancelled': no error text, the user changed their mind
    setBusy(null);
  }, [recordPurchase]);

  const onRestore = useCallback(async () => {
    setBusy('restore');
    setError(null);
    const result = await restore();
    if (result.state === 'purchased') {
      if (result.purchaseDateMs != null) await recordPurchaseDate(result.purchaseDateMs);
      await recordPurchase();
    } else if (result.state === 'none') {
      setError('No previous purchase found for this account.');
    } else if (result.state === 'unavailable') {
      setError('Store unavailable — please try again later.');
    } else {
      setError(result.message || 'Restore failed — please try again.');
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
        <Text style={styles.appName}>CouchPilot</Text>
        <Text style={styles.title}>7-day trial ended</Text>
        <Text style={styles.blurb}>
          Unlock CouchPilot forever with a one-time purchase. No subscription, no account, no
          tracking.
        </Text>

        <Pressable
          onPress={onBuy}
          disabled={busy != null}
          style={({ pressed }) => [
            styles.buyBtn,
            (pressed || busy != null) && styles.pressed,
          ]}>
          <Text style={styles.buyBtnText}>
            {busy === 'buy' ? 'PURCHASING…' : `UNLOCK — ${price ?? FALLBACK_PRICE}`}
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
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: theme.bg,
    paddingHorizontal: 28,
    justifyContent: 'space-between',
  },
  body: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  markWrap: {
    borderRadius: 22,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: theme.cardBorder,
    marginBottom: 18,
  },
  mark: { width: 88, height: 88 },
  appName: {
    color: theme.text,
    fontSize: 24,
    fontWeight: '800',
    fontFamily: mono,
    marginBottom: 6,
  },
  title: { color: theme.amber, fontSize: 15, fontWeight: '700', marginBottom: 12 },
  blurb: {
    color: theme.textDim,
    fontSize: 13,
    lineHeight: 19,
    textAlign: 'center',
    marginBottom: 28,
  },
  buyBtn: {
    alignSelf: 'stretch',
    backgroundColor: theme.blue,
    borderRadius: 10,
    paddingVertical: 15,
    alignItems: 'center',
    marginBottom: 12,
  },
  buyBtnText: { color: '#0b1220', fontSize: 14, fontWeight: '800', letterSpacing: 1 },
  restoreBtn: {
    alignSelf: 'stretch',
    backgroundColor: theme.inset,
    borderColor: theme.cardBorder,
    borderWidth: 1,
    borderRadius: 10,
    paddingVertical: 13,
    alignItems: 'center',
  },
  restoreBtnText: { color: theme.textDim, fontSize: 13, fontWeight: '700', letterSpacing: 1 },
  error: {
    color: theme.red,
    fontSize: 12,
    fontFamily: mono,
    textAlign: 'center',
    marginTop: 14,
  },
  pressed: { opacity: 0.7 },
});
