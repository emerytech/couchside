/**
 * "On sale now" — current Steam specials, shown on the Play tab when the Steam
 * integration is connected (agent >= 2.9.121). Keyless on the box side (public
 * Storefront); each card shows the discount + price and opens the game's Steam
 * store page in the phone's browser/Steam app. Probe-and-appear: renders nothing
 * unless the box returns connected deals.
 */
import React from 'react';
import { Image, Linking, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { usePoll } from '@/hooks/usePoll';
import { api, hostKey, type SteamDeals } from '@/lib/api';
import { hapticLight } from '@/lib/haptics';
import { useSettings } from '@/lib/SettingsContext';
import { mono, useTheme, useThemedStyles, type Palette } from '@/lib/theme';

const CURRENCY: Record<string, string> = { USD: '$', EUR: '€', GBP: '£', CAD: '$', AUD: '$', BRL: 'R$', JPY: '¥' };

function price(cents: number, currency: string): string {
  const sym = CURRENCY[currency] ?? '';
  const amount = (cents / 100).toFixed(currency === 'JPY' ? 0 : 2);
  return sym ? `${sym}${amount}` : `${amount} ${currency}`.trim();
}

// Public Steam capsule for a game (the box may not have unowned games cached, so
// use the CDN directly — the same Steam CDN the profile avatar already loads from).
const capsule = (appid: string) =>
  `https://cdn.cloudflare.steamstatic.com/steam/apps/${appid}/header.jpg`;

export function SteamDealsRow() {
  const styles = useThemedStyles(makeStyles);
  const { settings, ready } = useSettings();
  const configured = !!settings.host && !!settings.token;

  const deals = usePoll<SteamDeals | null>(
    () => api.steamDeals(settings), 1800000, ready && configured, hostKey(settings));

  const d = deals.data;
  const items = d && d.configured && d.connected ? (d.items ?? []) : [];
  if (items.length === 0) return null;

  const open = (appid: string) => {
    hapticLight();
    void Linking.openURL(`https://store.steampowered.com/app/${appid}/`);
  };

  return (
    <View style={styles.wrap}>
      <Text style={styles.label}>ON SALE NOW</Text>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.rail}>
        {items.map((it) => (
          <Pressable key={it.appid} onPress={() => open(it.appid)}
            accessibilityRole="button" accessibilityLabel={`${it.name}, ${it.discount_percent}% off — open on Steam`}
            style={({ pressed }) => [styles.card, pressed && styles.pressed]}>
            <View style={styles.artWrap}>
              <Image source={{ uri: capsule(it.appid) }} style={styles.art} resizeMode="cover" />
              {it.discount_percent > 0 && (
                <View style={styles.badge}><Text style={styles.badgeTxt}>-{it.discount_percent}%</Text></View>
              )}
            </View>
            <Text style={styles.name} numberOfLines={1}>{it.name}</Text>
            <View style={styles.priceRow}>
              {it.original > it.final && (
                <Text style={styles.was}>{price(it.original, it.currency)}</Text>
              )}
              <Text style={styles.now}>{it.final > 0 ? price(it.final, it.currency) : 'Free'}</Text>
            </View>
          </Pressable>
        ))}
      </ScrollView>
    </View>
  );
}

const makeStyles = (t: Palette) =>
  StyleSheet.create({
    wrap: { marginTop: 24 },
    label: { color: t.textFaint, fontFamily: mono, fontSize: 11, letterSpacing: 1.5, marginBottom: 12 },
    rail: { gap: 12, paddingRight: 8 },
    card: { width: 150 },
    artWrap: { borderRadius: 10, overflow: 'hidden', backgroundColor: t.card, aspectRatio: 460 / 215 },
    art: { width: '100%', height: '100%' },
    badge: {
      position: 'absolute', top: 6, left: 6, backgroundColor: t.green,
      borderRadius: 6, paddingHorizontal: 6, paddingVertical: 2,
    },
    badgeTxt: { color: t.onAccent, fontWeight: '800', fontSize: 12 },
    name: { color: t.text, fontSize: 13, fontWeight: '600', marginTop: 6 },
    priceRow: { flexDirection: 'row', alignItems: 'baseline', gap: 6, marginTop: 2 },
    was: { color: t.textFaint, fontSize: 11, textDecorationLine: 'line-through' },
    now: { color: t.green, fontSize: 13, fontWeight: '700' },
    pressed: { opacity: 0.6 },
  });
