/**
 * "Playlog" CARD — the Launch-tab entry point to the backlog page (app/playlog.tsx),
 * the ordered queue of games you want to play next. Mirrors InstallableSection: a
 * prominent card, not a buried row.
 *
 * The queue IS the bookmark set (see docs/memory/project_game-backlog.md), which
 * lives on the phone (hooks/useLibraryMarks) — so this needs no box call and shows
 * whenever you have at least one game bookmarked. Nothing queued -> hidden (you add
 * by bookmarking a game from its tile).
 */
import Ionicons from '@expo/vector-icons/Ionicons';
import { router } from 'expo-router';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { TourAnchor } from '@/components/TourAnchor';
import { useLibraryMarks } from '@/hooks/useLibraryMarks';
import { hapticLight } from '@/lib/haptics';
import { useTheme, useThemedStyles, type Palette } from '@/lib/theme';

export function PlaylogCard() {
  const t = useTheme();
  const styles = useThemedStyles(makeStyles);
  const { bookmarks } = useLibraryMarks();
  const count = bookmarks.size;

  if (count === 0) return null;

  return (
    <TourAnchor id="launch.playlog">
    <Pressable
      style={({ pressed }) => [styles.card, pressed && styles.cardPressed]}
      onPress={() => {
        hapticLight();
        router.push('/playlog');
      }}
      accessibilityRole="button"
      accessibilityLabel={`Open your playlog, ${count} game${count === 1 ? '' : 's'} queued`}>
      <View style={styles.iconWrap}>
        <Ionicons name="bookmark" size={20} color={t.green} />
      </View>
      <View style={styles.textWrap}>
        <Text style={styles.title} numberOfLines={1}>Playlog</Text>
        <Text style={styles.subtitle} numberOfLines={1}>
          {count} game{count === 1 ? '' : 's'} queued to play
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
      borderColor: t.green + '55', // green-tinted edge (bookmark accent)
    },
    cardPressed: { opacity: 0.7 },
    iconWrap: {
      width: 40,
      height: 40,
      borderRadius: 20,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: t.green + '22',
    },
    textWrap: { flex: 1 },
    title: { color: t.text, fontWeight: '700', fontSize: 15 },
    subtitle: { color: t.textFaint, fontSize: 12, marginTop: 2 },
  });
