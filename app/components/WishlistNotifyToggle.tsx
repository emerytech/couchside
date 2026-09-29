/**
 * "Wishlist price-drop alerts" — opt-in toggle for the best-effort BACKGROUND
 * price watch (lib/wishlistAlertTask). OFF by default; turning it on asks for
 * notification permission and only sticks if granted (else the Switch snaps
 * back). The sub-copy states the LAN-only / OS-throttled ceiling plainly so it
 * never over-promises. Lives with the Steam/ITAD advanced integrations at the
 * bottom of Prefs, so it only shows where a Steam wishlist can exist.
 */
import { Ionicons } from '@expo/vector-icons';
import { useState } from 'react';
import { StyleSheet, Switch, Text, View } from 'react-native';

import { hapticSelection } from '@/lib/haptics';
import { usePref } from '@/lib/prefs';
import { mono, useTheme, useThemedStyles, type Palette } from '@/lib/theme';
import { disableWishlistNotify, enableWishlistNotify } from '@/lib/wishlistAlertTask';

export function WishlistNotifyToggle() {
  const t = useTheme();
  const styles = useThemedStyles(makeStyles);
  const on = usePref('wishlistNotify');
  const [busy, setBusy] = useState(false);

  const toggle = async (v: boolean) => {
    if (busy) return;
    setBusy(true);
    hapticSelection();
    try {
      if (v) await enableWishlistNotify();
      else await disableWishlistNotify();
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={styles.card}>
      <View style={styles.row}>
        <Ionicons name="notifications-outline" size={16} color={t.amber} />
        <Text style={styles.title}>Wishlist price-drop alerts</Text>
        <View style={styles.spacer} />
        <Switch
          testID="wishlistNotifyToggle"
          value={on}
          onValueChange={(v) => void toggle(v)}
          disabled={busy}
          trackColor={{ false: t.inset, true: t.blue }}
          thumbColor="#f8fafc"
          ios_backgroundColor={t.inset}
        />
      </View>
      <Text style={styles.sub}>
        A local notification when a wishlisted game drops, even with the app
        closed. Best-effort: your phone has to be home on the box&rsquo;s network,
        and the system decides when to check — so it can be late, and opening the
        app is still the sure way to see drops. Nothing leaves your phone or box.
      </Text>
    </View>
  );
}

const makeStyles = (t: Palette) =>
  StyleSheet.create({
    card: {
      paddingVertical: 10,
      paddingHorizontal: 12,
      marginBottom: 14,
      borderRadius: 12,
      backgroundColor: t.card,
      borderColor: t.cardBorder,
      borderWidth: 1,
      gap: 6,
    },
    row: { flexDirection: 'row', alignItems: 'center', gap: 8 },
    spacer: { flex: 1 },
    title: { color: t.text, fontSize: 13, fontWeight: '700', fontFamily: mono, letterSpacing: 0.3 },
    sub: { color: t.textFaint, fontSize: 11, lineHeight: 15 },
  });
