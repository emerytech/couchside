/**
 * "Install games from your library" CARD — the prominent entry point on the Launch
 * tab to the owned-but-uninstalled library. A full card near the top (not a thin
 * row buried in the list) so people find it while browsing games. Tapping it pushes
 * app/installable.tsx (the virtualised, searchable full-library page).
 *
 * Probe-and-appear: cap-gated on caps.steaminstall, and hidden entirely when the
 * box has none to offer (0) or an older agent 404s /api/steam/installable — so an
 * old box or a Windows box is simply unaffected.
 */
import Ionicons from '@expo/vector-icons/Ionicons';
import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { api, type BoxCaps } from '@/lib/api';
import { hapticLight } from '@/lib/haptics';
import { useSettings } from '@/lib/SettingsContext';
import { useTheme, useThemedStyles, type Palette } from '@/lib/theme';

export function InstallableSection({ caps }: { caps?: BoxCaps }) {
  const t = useTheme();
  const styles = useThemedStyles(makeStyles);
  const { settings } = useSettings();
  const [count, setCount] = useState<number | null>(null);

  // Cap false = box can't; don't probe. Undefined/true = probe (404 on an older
  // agent hides the card: count stays null).
  const canProbe = caps?.steaminstall !== false;

  useEffect(() => {
    if (!canProbe) return;
    let live = true;
    void (async () => {
      const res = await api.installable(settings);
      if (!live) return;
      if (!res) { setCount(null); return; }
      // New agents (>= 2.9.76) type each entry from appinfo.vdf — count actual
      // GAMES, not the raw librarycache list (which overcounts ~2.5x with
      // DLC/tools; a real library read "1101" when it has 441 games). Old
      // agents send untyped entries: keep the raw count, as before.
      const typed = res.games.filter((g) => g.type !== undefined);
      setCount(typed.length > 0
        ? typed.filter((g) => g.type === 'game').length
        : res.count);
    })();
    return () => { live = false; };
  }, [settings, canProbe]);

  if (!canProbe || count === null || count === 0) return null;

  return (
    <Pressable
      style={({ pressed }) => [styles.card, pressed && styles.cardPressed]}
      onPress={() => {
        hapticLight();
        router.push('/installable');
      }}
      accessibilityRole="button"
      accessibilityLabel={`Install games from your library, ${count} you own but haven't downloaded`}>
      <View style={styles.iconWrap}>
        <Ionicons name="cloud-download-outline" size={22} color={t.blue} />
      </View>
      <View style={styles.textWrap}>
        <Text style={styles.title} numberOfLines={1}>Install games from your library</Text>
        <Text style={styles.subtitle} numberOfLines={1}>
          {count} you own but haven&rsquo;t downloaded
        </Text>
      </View>
      <Ionicons name="chevron-forward" size={18} color={t.textFaint} />
    </Pressable>
  );
}

const makeStyles = (t: Palette) =>
  StyleSheet.create({
    card: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 12,
      paddingVertical: 12,
      paddingHorizontal: 14,
      marginVertical: 8,
      borderRadius: 14,
      backgroundColor: t.card,
      borderWidth: 1,
      borderColor: t.blue + '55', // a blue-tinted edge so it draws the eye
    },
    cardPressed: { opacity: 0.7 },
    iconWrap: {
      width: 40,
      height: 40,
      borderRadius: 20,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: t.blue + '22',
    },
    textWrap: { flex: 1 },
    title: { color: t.text, fontWeight: '700', fontSize: 15 },
    subtitle: { color: t.textFaint, fontSize: 12, marginTop: 2 },
  });
