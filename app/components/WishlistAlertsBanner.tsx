/**
 * "3 wishlist games dropped · 1 at all-time low" — a banner on the Play tab when
 * the box (agent >= 2.9.127) reports wishlist games that got cheaper since you last
 * looked. Tap to acknowledge (moves the baseline so it won't nag next open); the
 * wishlist row below shows the details. On the FIRST look (primed:false) it silently
 * seeds the baseline and shows nothing — no noisy "everything dropped." Probe-and-
 * appear: renders nothing on an older agent or without a Steam key.
 */
import { Ionicons } from '@expo/vector-icons';
import React, { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { api, hostKey, type SteamWishlistAlerts } from '@/lib/api';
import { hapticLight } from '@/lib/haptics';
import { useSettings } from '@/lib/SettingsContext';
import { mono, useTheme, useThemedStyles, type Palette } from '@/lib/theme';

export function WishlistAlertsBanner() {
  const t = useTheme();
  const styles = useThemedStyles(makeStyles);
  const { settings, ready } = useSettings();
  const configured = !!settings.host && !!settings.token;
  const [data, setData] = useState<SteamWishlistAlerts | null | undefined>(undefined);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    if (!ready || !configured) return;
    let alive = true;
    setDismissed(false);
    void (async () => {
      const d = await api.steamWishlistAlerts(settings).catch(() => null);
      if (!alive) return;
      // First look: seed the baseline silently, show nothing this time.
      if (d && d.configured && d.connected && d.primed === false) {
        void api.steamWishlistAlertsAck(settings).catch(() => {});
        setData(null);
        return;
      }
      setData(d);
    })();
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, configured, hostKey(settings)]);

  const d = data;
  if (dismissed || !d || !d.configured || !d.connected || !(d.count && d.count > 0)) return null;

  const onTap = () => {
    hapticLight();
    // Mark the current prices as seen so this doesn't nag on the next open; the
    // wishlist row just below already shows which games and their prices.
    void api.steamWishlistAlertsAck(settings).catch(() => {});
    setDismissed(true);
  };

  const low = d.count_low ?? 0;
  const label = `${d.count} wishlist ${d.count === 1 ? 'game' : 'games'} dropped`
    + (low > 0 ? `  ·  ${low} at all-time low` : '');

  return (
    <Pressable
      onPress={onTap}
      accessibilityRole="button"
      accessibilityLabel={label}
      style={({ pressed }) => [styles.banner, pressed && styles.pressed]}>
      <Ionicons name="pricetags" size={18} color={t.amber} />
      <Text style={styles.text} numberOfLines={2}>{label}</Text>
      <Ionicons name="chevron-forward" size={16} color={t.textDim} />
    </Pressable>
  );
}

const makeStyles = (t: Palette) =>
  StyleSheet.create({
    banner: {
      flexDirection: 'row', alignItems: 'center', gap: 10,
      backgroundColor: t.card, borderColor: t.amber, borderWidth: 1,
      borderRadius: 12, paddingVertical: 12, paddingHorizontal: 14, marginBottom: 16,
    },
    text: { flex: 1, color: t.text, fontSize: 13, fontWeight: '700', fontFamily: mono, letterSpacing: 0.3 },
    pressed: { opacity: 0.7 },
  });
