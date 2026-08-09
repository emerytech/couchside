/**
 * Playlog — a dedicated page to manage the game backlog: the ordered queue of
 * games you want to play next. (Spec: docs/memory/project_game-backlog.md.)
 *
 * The queue IS the bookmark set (bookmark a game = add it to the playlog), shown
 * in a user-defined order. It holds BOTH installed games and ones you own but
 * haven't downloaded:
 *   - installed  -> tap opens the shared GameSheet (which launches it),
 *   - not installed -> tap offers to install it (steam://install on the box).
 * Reorder with the up/down controls; the ✕ removes a game from the queue.
 *
 * No agent change — bookmarks live on the phone (hooks/useLibraryMarks); launch
 * and install both reuse api.launch. Portrait-locked like every non-Pad screen.
 */
import Ionicons from '@expo/vector-icons/Ionicons';
import { Stack, router } from 'expo-router';
import { useCallback, useMemo, useState } from 'react';
import {
  ActivityIndicator, Alert, FlatList, Image, Platform, Pressable, StyleSheet, Text, View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { GameSheet } from '@/components/GameSheet';
import { useLockOrientation } from '@/hooks/useLockOrientation';
import { reorderBookmarks, toggleBookmarked, useLibraryMarks } from '@/hooks/useLibraryMarks';
import { usePoll } from '@/hooks/usePoll';
import { api, hostKey, type ImageSource, type InstallableGame, type Launcher } from '@/lib/api';
import { hapticError, hapticLight, hapticMedium, hapticSuccess } from '@/lib/haptics';
import { bookmarkKey } from '@/lib/libraryFilter';
import { useSettings } from '@/lib/SettingsContext';
import { useTheme, useThemedStyles, type Palette } from '@/lib/theme';

type Row =
  | { key: string; kind: 'installed'; launcher: Launcher }
  | { key: string; kind: 'notInstalled'; appid: number; name: string };

export default function PlaylogScreen() {
  const t = useTheme();
  const styles = useThemedStyles(makeStyles);
  const insets = useSafeAreaInsets();
  useLockOrientation('portrait'); // like every screen but the Pad

  const { settings, ready } = useSettings();
  const configured = settings.host.trim().length > 0;
  const marks = useLibraryMarks();
  const enabled = ready && configured;
  const key = hostKey(settings);

  const list = usePoll<{ launchers: Launcher[] }>(
    () => api.launchers(settings), 30000, enabled, key);
  // Owned-but-uninstalled games, so a queued game you haven't downloaded still
  // shows (and can be installed). Probe-and-appear: null on old agents / Windows.
  const inst = usePoll<{ games: InstallableGame[]; count: number } | null>(
    () => api.installable(settings), 60000, enabled, key);

  const [sheetFor, setSheetFor] = useState<Launcher | null>(null);
  const [busy, setBusy] = useState(false);
  const [installBusy, setInstallBusy] = useState<number | null>(null);

  // Bookmarked games resolved against BOTH the installed library and the
  // owned-but-uninstalled list, in the saved queue order. A key that resolves to
  // neither (e.g. a game no longer owned) is dropped from the view; reorder
  // re-appends any such key so the stored set is never changed by a reorder.
  const rows = useMemo<Row[]>(() => {
    const installed = new Map<string, Launcher>();
    for (const l of list.data?.launchers ?? []) {
      const k = bookmarkKey(l);
      if (k) installed.set(k, l);
    }
    const notInstalled = new Map<string, { appid: number; name: string }>();
    for (const g of inst.data?.games ?? []) {
      const k = bookmarkKey({ appid: g.appid });
      if (k && !installed.has(k)) notInstalled.set(k, { appid: g.appid, name: g.name || `App ${g.appid}` });
    }
    const out: Row[] = [];
    for (const bk of marks.bookmarks) {
      const l = installed.get(bk);
      if (l) { out.push({ key: bk, kind: 'installed', launcher: l }); continue; }
      const g = notInstalled.get(bk);
      if (g) out.push({ key: bk, kind: 'notInstalled', appid: g.appid, name: g.name });
    }
    return out;
  }, [list.data, inst.data, marks.bookmarks]);

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
      if (r.ok) { hapticSuccess(); setSheetFor(null); } else hapticError();
    } catch {
      hapticError();
    } finally {
      setBusy(false);
    }
  }, [settings, sheetFor]);

  // Not-installed game tapped -> confirm, then fire steam://install on the box.
  const install = useCallback((appid: number, name: string) => {
    const go = async () => {
      hapticMedium();
      setInstallBusy(appid);
      try {
        const r = await api.launch(settings, `install:${appid}`);
        if (r?.ok) {
          hapticSuccess();
          if (Platform.OS !== 'web') {
            Alert.alert('Approve it on your box',
              `A prompt for "${name}" is on your box's screen — approve it (a controller, or your phone's Pad) to start the download.`);
          }
        } else {
          hapticError();
        }
      } catch {
        hapticError();
      } finally {
        setInstallBusy(null);
      }
    };
    const q = `Install "${name}"? A prompt appears on your box's screen to approve it — use a controller, or your phone's Pad.`;
    if (Platform.OS === 'web') {
      // eslint-disable-next-line no-alert
      if (typeof window !== 'undefined' && window.confirm(q)) void go();
      return;
    }
    Alert.alert('Install game', q, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Install', onPress: () => { void go(); } },
    ]);
  }, [settings]);

  const coverForAppid = (appid: number | null | undefined): ImageSource | undefined =>
    appid != null ? api.steamCoverSource(settings, appid) : undefined;

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
        Games you want to play next, in your order. Installed games launch; ones you
        haven&rsquo;t downloaded offer to install. Bookmark a game to add it; use the
        arrows to reorder.
      </Text>

      {rows.length === 0 ? (
        <View style={styles.empty}>
          <Ionicons name="bookmark-outline" size={30} color={t.textFaint} />
          <Text style={styles.emptyText}>
            {!configured
              ? 'Connect a box to see your library.'
              : !list.data
                ? 'Loading your library…'
                : 'No games queued yet. Bookmark a game — installed or from your Not-installed library — to add it here.'}
          </Text>
        </View>
      ) : (
        <FlatList
          data={rows}
          keyExtractor={(r) => r.key}
          contentContainerStyle={{ padding: 14, paddingBottom: insets.bottom + 24, gap: 10 }}
          renderItem={({ item, index }) => {
            const isInstalled = item.kind === 'installed';
            const label = isInstalled ? item.launcher.label : item.name;
            const appid = isInstalled ? item.launcher.appid ?? null : item.appid;
            const cover = coverForAppid(appid);
            const installing = !isInstalled && installBusy === item.appid;
            return (
              <View style={styles.row}>
                <Pressable
                  onPress={() => {
                    hapticLight();
                    if (isInstalled) setSheetFor(item.launcher);
                    else install(item.appid, item.name);
                  }}
                  style={({ pressed }) => [styles.rowMain, pressed && { opacity: 0.7 }]}
                  accessibilityRole="button"
                  accessibilityLabel={isInstalled ? `Open ${label}` : `Install ${label}`}>
                  <Text style={styles.rank}>{index + 1}</Text>
                  {cover ? (
                    <Image source={cover} style={styles.art} resizeMode="cover" />
                  ) : (
                    <View style={[styles.art, styles.artFallback]}>
                      <Ionicons name="game-controller-outline" size={18} color={t.textDim} />
                    </View>
                  )}
                  <View style={styles.rowText}>
                    <Text style={styles.label} numberOfLines={2}>{label}</Text>
                    {!isInstalled ? (
                      <View style={styles.notInstalledRow}>
                        {installing ? (
                          <ActivityIndicator size="small" color={t.blue} />
                        ) : (
                          <Ionicons name="cloud-download-outline" size={13} color={t.blue} />
                        )}
                        <Text style={styles.notInstalledText}>
                          {installing ? 'Requesting install…' : 'Not installed — tap to install'}
                        </Text>
                      </View>
                    ) : null}
                  </View>
                </Pressable>
                <View style={styles.controls}>
                  <Pressable
                    onPress={() => move(index, -1)}
                    disabled={index === 0}
                    hitSlop={6}
                    accessibilityRole="button"
                    accessibilityLabel={`Move ${label} up`}
                    style={({ pressed }) => [styles.ctrl, pressed && { opacity: 0.6 }]}>
                    <Ionicons name="chevron-up" size={18} color={index === 0 ? t.textFaint : t.text} />
                  </Pressable>
                  <Pressable
                    onPress={() => move(index, 1)}
                    disabled={index === rows.length - 1}
                    hitSlop={6}
                    accessibilityRole="button"
                    accessibilityLabel={`Move ${label} down`}
                    style={({ pressed }) => [styles.ctrl, pressed && { opacity: 0.6 }]}>
                    <Ionicons name="chevron-down" size={18} color={index === rows.length - 1 ? t.textFaint : t.text} />
                  </Pressable>
                  <Pressable
                    onPress={() => { hapticLight(); toggleBookmarked(item.key); }}
                    hitSlop={6}
                    accessibilityRole="button"
                    accessibilityLabel={`Remove ${label} from playlog`}
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
        coverSource={sheetFor ? coverForAppid(sheetFor.appid) : undefined}
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
    rowText: { flex: 1, gap: 3 },
    label: { color: t.text, fontSize: 14, fontWeight: '700' },
    notInstalledRow: { flexDirection: 'row', alignItems: 'center', gap: 5 },
    notInstalledText: { color: t.blue, fontSize: 11, fontWeight: '600' },
    controls: { flexDirection: 'row', alignItems: 'center', gap: 2 },
    ctrl: { padding: 8, alignItems: 'center', justifyContent: 'center' },
  });
