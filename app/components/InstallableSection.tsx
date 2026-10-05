/**
 * "Install games from your library" CARD — the prominent entry point on the Launch
 * tab to the owned-but-uninstalled library. A full card near the top (not a thin
 * row buried in the list) so people find it while browsing games. Tapping it pushes
 * app/installable.tsx (the virtualised, searchable full-library page).
 *
 * Probe-and-appear: the endpoint IS the gate. /api/steam/installable 404s on a
 * box that can't offer it (old agent, Windows) -> probeOrNull returns null -> the
 * card hides. It deliberately does NOT gate on the cached `steaminstall` cap: a
 * STALE cap (a box cached as false before it supported the feature, and never
 * re-probed) would hide the card even though the box now returns games — the
 * exact symptom seen on a 2.9.76 box with 441 games. The live endpoint can't go
 * stale, so it is the source of truth.
 */
import Ionicons from '@expo/vector-icons/Ionicons';
import { router } from 'expo-router';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { TourAnchor } from '@/components/TourAnchor';
import { usePoll } from '@/hooks/usePoll';
import { api, hostKey } from '@/lib/api';
import { hapticLight } from '@/lib/haptics';
import { useSettings } from '@/lib/SettingsContext';
import { useTheme, useThemedStyles, type Palette } from '@/lib/theme';

export function InstallableSection() {
  const t = useTheme();
  const styles = useThemedStyles(makeStyles);
  const { settings } = useSettings();
  const configured = settings.host.trim().length > 0;

  // usePoll, NOT a one-shot effect keyed on [settings]. api.installable 404s
  // (probeOrNull -> null) on a box that cannot offer the feature, so the card
  // stays hidden there. But a TRANSIENT failure (box asleep, timeout, 5xx)
  // THROWS; the old one-shot `await` let that rejection drop `count` to null and
  // then never re-ran until some unrelated settings write happened, so the card
  // stayed missing after the box woke. usePoll keeps the card hidden while
  // unknown (degrade closed) and retries every ~2s, so it appears on its own
  // when the box is reachable again. hostKey resetKey clears another box's count
  // on a switch.
  const poll = usePoll(
    () => api.installable(settings), 60_000, configured, hostKey(settings));
  const res = poll.data;
  // New agents (>= 2.9.76) type each entry from appinfo.vdf — count actual
  // GAMES, not the raw librarycache list (which overcounts ~2.5x with DLC/tools;
  // a real library read "1101" when it has 441 games). Old agents send untyped
  // entries: keep the raw count, as before.
  let count: number | null = null;
  if (res) {
    const typed = res.games.filter((g) => g.type !== undefined);
    count = typed.length > 0 ? typed.filter((g) => g.type === 'game').length : res.count;
  }

  if (count === null || count === 0) return null;

  return (
    <TourAnchor id="launch.installable">
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
    </TourAnchor>
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
