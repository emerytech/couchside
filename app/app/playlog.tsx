/**
 * Playlog — a dedicated page to manage the game backlog: the ordered queue of
 * games you want to play next. (Spec: docs/memory/project_game-backlog.md.)
 *
 * P1: the queue IS the bookmark set (bookmark a game = add it to the playlog),
 * shown in a user-defined order. Reorder with the up/down controls; tap a game to
 * open the same GameSheet the Launch grid uses (which launches it); remove takes it
 * off the queue (un-bookmarks). No agent change — bookmarks live on the phone
 * (hooks/useLibraryMarks), launching reuses api.launch.
 *
 * Reached from the Launch tab. Portrait-locked like every non-Pad screen.
 */
import Ionicons from '@expo/vector-icons/Ionicons';
import { Stack, router } from 'expo-router';
import { useCallback, useMemo, useState } from 'react';
import {
  ActivityIndicator, FlatList, Image, Pressable, StyleSheet, Text, View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { GameSheet } from '@/components/GameSheet';
import { useLockOrientation } from '@/hooks/useLockOrientation';
import { reorderBookmarks, toggleBookmarked, useLibraryMarks } from '@/hooks/useLibraryMarks';
import { usePoll } from '@/hooks/usePoll';
import { api, hostKey, type ImageSource, type Launcher } from '@/lib/api';
import { hapticError, hapticLight, hapticMedium, hapticSuccess } from '@/lib/haptics';
import { bookmarkKey } from '@/lib/libraryFilter';
import { useSettings } from '@/lib/SettingsContext';
import { useTheme, useThemedStyles, type Palette } from '@/lib/theme';

export default function PlaylogScreen() {
  const t = useTheme();
  const styles = useThemedStyles(makeStyles);
  const insets = useSafeAreaInsets();
  useLockOrientation('portrait'); // like every screen but the Pad

  const { settings, ready } = useSettings();
  const configured = settings.host.trim().length > 0;
  const marks = useLibraryMarks();

  const list = usePoll<{ launchers: Launcher[] }>(
    () => api.launchers(settings),
    30000,
    ready && configured,
    hostKey(settings),
  );

  const [sheetFor, setSheetFor] = useState<Launcher | null>(null);
  const [busy, setBusy] = useState(false);

  // Bookmarked games that ARE in the current library, in the saved queue order.
  // A bookmarked key with no matching launcher (e.g. an uninstalled game) is
  // dropped from the view; reorderBookmarks re-appends any such key so a reorder
  // never loses it from the stored set.
  const rows = useMemo(() => {
    const byKey = new Map<string, Launcher>();
    for (const l of list.data?.launchers ?? []) {
      const k = bookmarkKey(l);
      if (k) byKey.set(k, l);
    }
    const out: { key: string; launcher: Launcher }[] = [];
    for (const key of marks.bookmarks) {
      const launcher = byKey.get(key);
      if (launcher) out.push({ key, launcher });
    }
    return out;
  }, [list.data, marks.bookmarks]);

  const move = useCallback(
    (index: number, dir: -1 | 1) => {
      const j = index + dir;
      if (j < 0 || j >= rows.length) return;
      hapticLight();
      const keys = rows.map((r) => r.key);
      [keys[index], keys[j]] = [keys[j], keys[index]];
      reorderBookmarks(keys);
    },
    [rows],
  );

  const launch = useCallback(async () => {
    if (!sheetFor) return;
    hapticMedium();
    setBusy(true);
    try {
      const r = await api.launch(settings, sheetFor.id);
      if (r.ok) {
        hapticSuccess();
        setSheetFor(null);
      } else {
        hapticError();
      }
    } catch {
      hapticError();
    } finally {
      setBusy(false);
    }
  }, [settings, sheetFor]);

  const coverFor = (l: Launcher): ImageSource | undefined =>
    l.kind === 'steam' && l.appid != null ? api.steamCoverSource(settings, l.appid) : undefined;

  return (
    <View style={[styles.screen, { paddingTop: insets.top }]}>
      <Stack.Screen options={{ headerShown: false }} />
      <View style={styles.header}>
        <Pressable onPress={() => router.back()} hitSlop={12} accessibilityRole="button" accessibilityLabel="Back">
          <Ionicons name="chevron-back" size={26} color={t.text} />
        </Pressable>
        <Text style={styles.title}>Playlog</Text>
        <View style={{ width: 26 }} />
      </View>
      <Text style={styles.lede}>
        Games you want to play next, in your order. Bookmark a game to add it here;
        use the arrows to reorder. Tap one to play it.
      </Text>

      {rows.length === 0 ? (
        <View style={styles.empty}>
          <Ionicons name="bookmark-outline" size={30} color={t.textFaint} />
          <Text style={styles.emptyText}>
            {!configured
              ? 'Connect a box to see your library.'
              : !list.data
                ? 'Loading your library…'
                : 'No games queued yet. Bookmark a game (from its tile) to add it to your playlog.'}
          </Text>
        </View>
      ) : (
        <FlatList
          data={rows}
          keyExtractor={(r) => r.key}
          contentContainerStyle={{ padding: 14, paddingBottom: insets.bottom + 24, gap: 10 }}
          renderItem={({ item, index }) => {
            const cover = coverFor(item.launcher);
            return (
              <View style={styles.row}>
                <Pressable
                  onPress={() => { hapticLight(); setSheetFor(item.launcher); }}
                  style={({ pressed }) => [styles.rowMain, pressed && { opacity: 0.7 }]}
                  accessibilityRole="button"
                  accessibilityLabel={`Open ${item.launcher.label}`}>
                  <Text style={styles.rank}>{index + 1}</Text>
                  {cover ? (
                    <Image source={cover} style={styles.art} resizeMode="cover" />
                  ) : (
                    <View style={[styles.art, styles.artFallback]}>
                      <Ionicons name="game-controller-outline" size={18} color={t.textDim} />
                    </View>
                  )}
                  <Text style={styles.label} numberOfLines={2}>{item.launcher.label}</Text>
                </Pressable>
                <View style={styles.controls}>
                  <Pressable
                    onPress={() => move(index, -1)}
                    disabled={index === 0}
                    hitSlop={6}
                    accessibilityRole="button"
                    accessibilityLabel={`Move ${item.launcher.label} up`}
                    style={({ pressed }) => [styles.ctrl, pressed && { opacity: 0.6 }]}>
                    <Ionicons name="chevron-up" size={18} color={index === 0 ? t.textFaint : t.text} />
                  </Pressable>
                  <Pressable
                    onPress={() => move(index, 1)}
                    disabled={index === rows.length - 1}
                    hitSlop={6}
                    accessibilityRole="button"
                    accessibilityLabel={`Move ${item.launcher.label} down`}
                    style={({ pressed }) => [styles.ctrl, pressed && { opacity: 0.6 }]}>
                    <Ionicons name="chevron-down" size={18} color={index === rows.length - 1 ? t.textFaint : t.text} />
                  </Pressable>
                  <Pressable
                    onPress={() => { hapticLight(); toggleBookmarked(item.key); }}
                    hitSlop={6}
                    accessibilityRole="button"
                    accessibilityLabel={`Remove ${item.launcher.label} from playlog`}
                    style={({ pressed }) => [styles.ctrl, pressed && { opacity: 0.6 }]}>
                    <Ionicons name="close" size={18} color={t.textDim} />
                  </Pressable>
                </View>
              </View>
            );
          }}
        />
      )}

      <GameSheet
        launcher={sheetFor}
        coverSource={sheetFor ? coverFor(sheetFor) : undefined}
        busy={busy}
        onPlay={launch}
        onClose={() => setSheetFor(null)}
      />
    </View>
  );
}

const makeStyles = (t: Palette) =>
  StyleSheet.create({
    screen: { flex: 1, backgroundColor: t.bg },
    header: {
      flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
      paddingHorizontal: 12, paddingVertical: 10,
    },
    title: { color: t.text, fontSize: 20, fontWeight: '800' },
    lede: { color: t.textFaint, fontSize: 13, lineHeight: 18, paddingHorizontal: 14, marginBottom: 8 },
    empty: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32, gap: 12 },
    emptyText: { color: t.textFaint, fontSize: 13, lineHeight: 19, textAlign: 'center', maxWidth: 300 },
    row: {
      flexDirection: 'row', alignItems: 'center', gap: 10,
      backgroundColor: t.card, borderRadius: 12, borderWidth: 1, borderColor: t.cardBorder,
      paddingRight: 6,
    },
    rowMain: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 12, padding: 10 },
    rank: { color: t.textFaint, fontSize: 13, fontWeight: '800', width: 20, textAlign: 'center' },
    art: { width: 40, height: 60, borderRadius: 6, backgroundColor: t.inset },
    artFallback: { alignItems: 'center', justifyContent: 'center' },
    label: { color: t.text, fontSize: 14, fontWeight: '700', flex: 1 },
    controls: { flexDirection: 'row', alignItems: 'center', gap: 2 },
    ctrl: { padding: 8, alignItems: 'center', justifyContent: 'center' },
  });
