/**
 * Playlog — a dedicated page to manage the game backlog: the ordered queue of
 * games you want to play next. (Spec: docs/memory/project_game-backlog.md.)
 *
 * The queue IS the bookmark set (bookmark a game = add it to the playlog), shown
 * in a user-defined order. It holds BOTH installed games and ones you own but
 * haven't downloaded:
 *   - installed  -> tap opens the shared GameSheet (which launches it),
 *   - not installed -> tap offers to install it (steam://install on the box).
 * Reorder by dragging the grip (the up/down arrows do the same, and stay for
 * accessibility); the ✕ removes a game from the queue.
 *
 * NOW PLAYING (top) lists installed games the box reports as recently opened.
 * Each row can be cleared once you're done with it — a clear is remembered
 * against that game's last_played, so playing it again brings it straight back.
 *
 * DRAG PATH: hand-rolled on PanResponder (the house gesture primitive — pad,
 * trackpad, remote all use it; gesture-handler is not wired at the root). The
 * drop slot is computed by lib/playlogReorder (unit-tested) from a layout
 * snapshot frozen when the drag begins, and the queue only mutates on release —
 * so nothing shifts under the finger mid-drag.
 *
 * No agent change — bookmarks and clears live on the phone (hooks/useLibraryMarks);
 * launch and install both reuse api.launch. Portrait-locked like every non-Pad screen.
 */
import Ionicons from '@expo/vector-icons/Ionicons';
import { Stack, router } from 'expo-router';
import { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator, Alert, Animated, FlatList, Image, PanResponder,
  Platform, Pressable, StyleSheet, Text, View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { GameSheet } from '@/components/GameSheet';
import { useLockOrientation } from '@/hooks/useLockOrientation';
import {
  dismissNowPlaying, reorderBookmarks, toggleBookmarked, useLibraryMarks,
} from '@/hooks/useLibraryMarks';
import { usePoll } from '@/hooks/usePoll';
import { api, hostKey, type ImageSource, type InstallableGame, type Launcher } from '@/lib/api';
import { hapticError, hapticLight, hapticMedium, hapticSuccess } from '@/lib/haptics';
import { bookmarkKey, playtimeLabel } from '@/lib/libraryFilter';
import { arrayMove, computeDropIndex, rowCenters } from '@/lib/playlogReorder';
import { useSettings } from '@/lib/SettingsContext';
import { useTheme, useThemedStyles, type Palette } from '@/lib/theme';

type Row =
  | { key: string; kind: 'installed'; launcher: Launcher }
  | { key: string; kind: 'notInstalled'; appid: number; name: string };

/** Compact "when" for the Now-playing section. */
function lastAgo(sec: number, nowSec: number): string {
  const d = Math.floor((nowSec - sec) / 86400);
  if (d <= 0) return 'today';
  if (d === 1) return 'yesterday';
  if (d < 7) return `${d}d ago`;
  const w = Math.round(d / 7);
  return w === 1 ? 'a week ago' : `${w}w ago`;
}

/** Dismissal identity for a Now-playing row: the game's stable key stamped with
 *  the play it was cleared against, so a newer play un-hides it automatically. */
function npHiddenKey(l: Launcher): string {
  const k = bookmarkKey({ appid: l.appid, id: l.id }) ?? `id:${l.id}`;
  return `${k}@${l.last_played ?? 0}`;
}

/** Games count as "now playing" if opened within this window. */
const NOW_PLAYING_WINDOW_S = 21 * 86400;
const NOW_PLAYING_MAX = 6;

/** Row gap (matches the list contentContainerStyle) and the height assumed for a
 *  queue row FlatList has not measured yet — both feed rowCenters(). */
const ROW_GAP = 10;
const ROW_DEFAULT_H = 84;

/** The key of the row being dragged, handed to the (stable) cell wrapper so it
 *  can lift itself WITHOUT its component identity changing. Swapping the
 *  CellRendererComponent type mid-gesture remounts every cell and tears down the
 *  grip's active pan responder — the drag would then never track the finger. */
const DragKeyContext = createContext<string | null>(null);

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

  const nowSec = Math.floor(Date.now() / 1000);
  const hiddenNP = marks.hiddenNowPlaying;
  // "Now playing" = installed games opened recently, most-recent first, minus any
  // the user has cleared. Purely derived from the box's playtime data (agent >=
  // 2.9.71); empty (section hidden) on older agents that send no last_played —
  // never a guess.
  const nowPlaying = useMemo(
    () => (list.data?.launchers ?? [])
      .filter((l) => l.last_played != null && l.last_played > 0
        && nowSec - l.last_played <= NOW_PLAYING_WINDOW_S)
      .filter((l) => !hiddenNP.has(npHiddenKey(l)))
      .sort((a, b) => (b.last_played ?? 0) - (a.last_played ?? 0))
      .slice(0, NOW_PLAYING_MAX),
    // nowSec changes each render but the window is coarse (days); depend on data.
    [list.data, hiddenNP], // eslint-disable-line react-hooks/exhaustive-deps
  );

  // --- Drag-to-reorder (UP NEXT) ------------------------------------------
  // rowsRef lets a stable, per-row PanResponder read the CURRENT order at grant
  // time instead of closing over a stale `rows`. rowLayout is filled from the
  // cell wrapper's onLayout (content-space offsets). dragState freezes the layout
  // the instant a drag starts; the queue is only rewritten on release.
  const rowsRef = useRef<Row[]>(rows);
  rowsRef.current = rows;
  const rowLayout = useRef<Record<string, number>>({}); // key -> measured height
  const dragState = useRef<{ from: number; centers: number[]; order: string[] } | null>(null);
  const dragY = useRef(new Animated.Value(0)).current;
  const [dragKey, setDragKey] = useState<string | null>(null);
  const [dropTo, setDropTo] = useState<number | null>(null);
  const grips = useRef<Record<string, ReturnType<typeof PanResponder.create>>>({});

  const finishDrag = useCallback((dy: number | null) => {
    const st = dragState.current;
    dragState.current = null;
    setDragKey(null);
    setDropTo(null);
    dragY.setValue(0);
    if (!st || dy == null) return;
    const to = computeDropIndex(st.centers, st.from, st.centers[st.from] + dy);
    if (to !== st.from) {
      hapticSuccess();
      reorderBookmarks(arrayMove(st.order, st.from, to));
    } else {
      hapticLight();
    }
  }, [dragY]);

  // One responder per row key, created once and cached. It reads live state from
  // refs, so recreating it is unnecessary and stale closures are impossible.
  const gripFor = (rowKey: string) => {
    let pr = grips.current[rowKey];
    if (pr) return pr;
    pr = PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      // House rule (CONVENTIONS.md): a granted drag never yields — otherwise the
      // enclosing list could steal it mid-move and strand the reorder.
      onPanResponderTerminationRequest: () => false,
      onPanResponderGrant: () => {
        const order = rowsRef.current.map((r) => r.key);
        const from = order.indexOf(rowKey);
        if (from < 0) return;
        const centers = rowCenters(order, rowLayout.current, ROW_GAP, ROW_DEFAULT_H);
        dragState.current = { from, centers, order };
        dragY.setValue(0);
        setDragKey(rowKey);
        setDropTo(from);
        hapticMedium();
      },
      onPanResponderMove: (_e, g) => {
        const st = dragState.current;
        if (!st) return;
        dragY.setValue(g.dy);
        const to = computeDropIndex(st.centers, st.from, st.centers[st.from] + g.dy);
        setDropTo((prev) => (prev === to ? prev : to));
      },
      onPanResponderRelease: (_e, g) => finishDrag(g.dy),
      onPanResponderTerminate: () => finishDrag(null),
    });
    grips.current[rowKey] = pr;
    return pr;
  };

  // Custom cell wrapper: records each row's height for the drag maths, and lifts
  // the dragged cell above its neighbours. Its identity is STABLE (built once),
  // so the grip's pan responder is never remounted mid-gesture; it re-renders on
  // drag purely through DragKeyContext (a context consumer re-renders even inside
  // the list's internal PureComponent cell). It reads only refs — never stale.
  const cellRef = useRef<React.ComponentType<any> | null>(null);
  if (!cellRef.current) {
    const layout = rowLayout;
    const rowsR = rowsRef;
    cellRef.current = function PlaylogCell(props: any) {
      const activeKey = useContext(DragKeyContext);
      const k = rowsR.current[props.index]?.key;
      const lifted = k != null && k === activeKey;
      return (
        <View
          {...props}
          style={[props.style, lifted ? { zIndex: 30, elevation: 12 } : null]}
          onLayout={(e: { nativeEvent: { layout: { height: number } } }) => {
            if (k) layout.current[k] = e.nativeEvent.layout.height;
            props.onLayout?.(e);
          }}
        >
          {props.children}
        </View>
      );
    };
  }
  const CellComp = cellRef.current;

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

  const clearNowPlaying = useCallback((l: Launcher) => {
    hapticLight();
    dismissNowPlaying(npHiddenKey(l));
  }, []);

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
        haven&rsquo;t downloaded offer to install. Bookmark a game to add it; drag the
        grip (or use the arrows) to reorder.
      </Text>

      <DragKeyContext.Provider value={dragKey}>
      <FlatList
        data={rows}
        keyExtractor={(r) => r.key}
        scrollEnabled={dragKey == null}
        CellRendererComponent={CellComp as never}
        contentContainerStyle={{ padding: 14, paddingBottom: insets.bottom + 24, gap: ROW_GAP }}
        ListHeaderComponent={
          <View style={{ gap: 10 }}>
            {nowPlaying.length > 0 ? (
              <>
                <Text style={styles.sectionH}>NOW PLAYING</Text>
                {nowPlaying.map((l) => {
                  const cover = coverForAppid(l.appid);
                  const qk = bookmarkKey({ appid: l.appid, id: l.id });
                  const queued = marks.isBookmarked(qk);
                  return (
                    <Pressable
                      key={l.id}
                      onPress={() => { hapticLight(); setSheetFor(l); }}
                      style={({ pressed }) => [styles.npRow, pressed && { opacity: 0.7 }]}
                      accessibilityRole="button"
                      accessibilityLabel={`Open ${l.label}`}>
                      {cover ? (
                        <Image source={cover} style={styles.art} resizeMode="cover" />
                      ) : (
                        <View style={[styles.art, styles.artFallback]}>
                          <Ionicons name="game-controller-outline" size={18} color={t.textDim} />
                        </View>
                      )}
                      <View style={styles.rowText}>
                        <Text style={styles.label} numberOfLines={1}>{l.label}</Text>
                        <Text style={styles.npSub}>
                          Played {lastAgo(l.last_played ?? nowSec, nowSec)}
                          {l.playtime_min ? ` · ${playtimeLabel(l.playtime_min)}` : ''}
                        </Text>
                      </View>
                      <Pressable
                        onPress={() => {
                          if (!qk) return;
                          hapticLight();
                          toggleBookmarked(qk);
                        }}
                        disabled={!qk}
                        hitSlop={10}
                        accessibilityRole="button"
                        accessibilityLabel={queued ? `Remove ${l.label} from Up Next` : `Add ${l.label} to Up Next`}
                        style={({ pressed }) => [styles.npClear, pressed && { opacity: 0.6 }]}>
                        <Ionicons
                          name={queued ? 'bookmark' : 'bookmark-outline'}
                          size={17}
                          color={queued ? t.blue : t.textDim}
                        />
                      </Pressable>
                      <Pressable
                        onPress={() => clearNowPlaying(l)}
                        hitSlop={10}
                        accessibilityRole="button"
                        accessibilityLabel={`Clear ${l.label} from Now playing`}
                        style={({ pressed }) => [styles.npClear, pressed && { opacity: 0.6 }]}>
                        <Ionicons name="checkmark-done" size={18} color={t.textDim} />
                      </Pressable>
                      <Ionicons name="play" size={16} color={t.green} />
                    </Pressable>
                  );
                })}
              </>
            ) : null}
            <Text style={styles.sectionH}>UP NEXT</Text>
          </View>
        }
        ListEmptyComponent={
          <View style={styles.emptyInline}>
            <Text style={styles.emptyText}>
              {!configured
                ? 'Connect a box to see your library.'
                : !list.data
                  ? 'Loading your library…'
                  : 'No games queued yet. Bookmark a game — installed or from your Not-installed library — to add it here.'}
            </Text>
          </View>
        }
        renderItem={({ item, index }) => {
            const isInstalled = item.kind === 'installed';
            const label = isInstalled ? item.launcher.label : item.name;
            const appid = isInstalled ? item.launcher.appid ?? null : item.appid;
            const cover = coverForAppid(appid);
            const installing = !isInstalled && installBusy === item.appid;
            const dragging = item.key === dragKey;

            // Insertion indicator: while a drag is live, mark where the row will
            // land. dropTo is the target index in the array once the dragged row
            // is removed; map it to a boundary among the rows still in place.
            let showTop = false;
            let showBottom = false;
            const st = dragState.current;
            if (dragKey && dropTo != null && st && !dragging) {
              const rank = index < st.from ? index : index - 1;
              if (dropTo <= rows.length - 2) showTop = rank === dropTo;
              else showBottom = rank === rows.length - 2;
            }

            const rowBody = (
              <View style={styles.row}>
                <View
                  style={styles.grip}
                  {...gripFor(item.key).panHandlers}
                  accessible={false}
                  importantForAccessibility="no-hide-descendants">
                  <Ionicons name="reorder-three" size={22} color={t.textDim} />
                </View>
                <Pressable
                  onPress={() => {
                    hapticLight();
                    if (isInstalled) setSheetFor(item.launcher);
                    else install(item.appid, item.name);
                  }}
                  style={({ pressed }) => [styles.rowMain, pressed && { opacity: 0.7 }]}
                  accessibilityRole="button"
                  accessibilityLabel={isInstalled ? `Open ${label}` : `Install ${label}`}>
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

            return (
              <View>
                {showTop ? <View style={styles.dropLine} /> : null}
                {dragging ? (
                  <Animated.View
                    style={[styles.dragging, { transform: [{ translateY: dragY }] }]}>
                    {rowBody}
                  </Animated.View>
                ) : rowBody}
                {showBottom ? <View style={styles.dropLine} /> : null}
              </View>
            );
          }}
        />
      </DragKeyContext.Provider>

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
    emptyInline: { paddingVertical: 20, paddingHorizontal: 8, alignItems: 'center' },
    emptyText: { color: t.textFaint, fontSize: 13, lineHeight: 19, textAlign: 'center', maxWidth: 300 },
    sectionH: { color: t.textFaint, fontSize: 11, fontWeight: '800', letterSpacing: 1, marginTop: 2 },
    npRow: {
      flexDirection: 'row', alignItems: 'center', gap: 12, padding: 10,
      backgroundColor: t.card, borderRadius: 12, borderWidth: 1, borderColor: t.cardBorder,
    },
    npSub: { color: t.textDim, fontSize: 12, marginTop: 2 },
    npClear: { padding: 6, alignItems: 'center', justifyContent: 'center' },
    row: {
      flexDirection: 'row', alignItems: 'center', gap: 8,
      backgroundColor: t.card, borderRadius: 12, borderWidth: 1, borderColor: t.cardBorder,
      paddingRight: 6,
    },
    dragging: {
      shadowColor: '#000', shadowOpacity: 0.4, shadowRadius: 10,
      shadowOffset: { width: 0, height: 6 }, elevation: 12,
    },
    dropLine: {
      height: 2, borderRadius: 2, backgroundColor: t.blue,
      marginVertical: 3, marginHorizontal: 6,
    },
    grip: { paddingLeft: 8, paddingRight: 2, paddingVertical: 14, alignItems: 'center', justifyContent: 'center' },
    rowMain: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 10 },
    art: { width: 40, height: 60, borderRadius: 6, backgroundColor: t.inset },
    artFallback: { alignItems: 'center', justifyContent: 'center' },
    rowText: { flex: 1, gap: 3 },
    label: { color: t.text, fontSize: 14, fontWeight: '700' },
    notInstalledRow: { flexDirection: 'row', alignItems: 'center', gap: 5 },
    notInstalledText: { color: t.blue, fontSize: 11, fontWeight: '600' },
    controls: { flexDirection: 'row', alignItems: 'center', gap: 2 },
    ctrl: { padding: 8, alignItems: 'center', justifyContent: 'center' },
  });
