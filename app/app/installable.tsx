/**
 * "Install a game you own but haven't downloaded" — the FULL library page.
 *
 * The Launch tab shows a one-line "Not installed" row; tapping it lands here. This
 * is a dedicated route rather than an inline grid because the library is large
 * (1000+ on a real account) — an inline flex-wrap in the Launch ScrollView renders
 * every tile un-virtualized and chokes / cuts off (the reported bug). A FlatList
 * virtualises, so all of them scroll smoothly.
 *
 * NAMES + TYPE come from Valve's KEYLESS store (lib/steamStore), resolved LAZILY as
 * tiles scroll into view — the store rate-limits (~200/5min), so pre-resolving 1000
 * names is impossible; visible-only + a 30-day cache fills the library as you browse.
 * ART comes from the box (LAN, immediate). type=game hides the tools/DLC the library
 * cache overcounts, applied as each tile resolves. Installing hands install:<appid>
 * to the agent, which pops Steam's approve prompt on the box (verified behavior).
 */
import Ionicons from '@expo/vector-icons/Ionicons';
import { Stack, router } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator, Alert, FlatList, Image, Platform, Pressable,
  StyleSheet, Text, TextInput, useWindowDimensions, View, type ViewToken,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useLockOrientation } from '@/hooks/useLockOrientation';
import { api } from '@/lib/api';
import { hapticLight } from '@/lib/haptics';
import { useSettings } from '@/lib/SettingsContext';
import { fetchAppDetails } from '@/lib/steamStore';
import { isInstallableGameType, type AppDetails } from '@/lib/steamStoreParse';
import { useTheme, useThemedStyles, type Palette } from '@/lib/theme';

type Resolved = AppDetails | null | undefined; // undefined = not resolved yet

/** steam://install pops an approve prompt on the box (verified) — say so. */
function confirmInstall(label: string, onConfirm: () => void) {
  const q = `Install "${label}"? A prompt appears on your box's screen to approve it — use a controller, or your phone's Pad.`;
  if (Platform.OS === 'web') {
    // eslint-disable-next-line no-alert
    if (typeof window !== 'undefined' && window.confirm(q)) onConfirm();
    return;
  }
  Alert.alert('Install game', q, [
    { text: 'Cancel', style: 'cancel' },
    { text: 'Install', onPress: onConfirm },
  ]);
}

function Cell({
  appid, name, requested, onRequested, colW,
}: {
  appid: number;
  name?: string;
  requested: boolean;
  onRequested: (appid: number) => void;
  colW: number;
}) {
  const styles = useThemedStyles(makeStyles);
  const { settings } = useSettings();
  const source = api.steamCoverSource(settings, appid);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => setFailed(false), [source.uri]);

  const install = () => {
    hapticLight();
    confirmInstall(name || `App ${appid}`, async () => {
      setBusy(true);
      try {
        const res = await api.launch(settings, `install:${appid}`);
        if (res?.ok) onRequested(appid);
        if (Platform.OS !== 'web') {
          Alert.alert(
            res?.ok ? 'Approve it on your box' : "Couldn't start install",
            res?.ok
              ? `A prompt for "${name || `App ${appid}`}" is on your box's screen — approve it (a controller, or your phone's Pad) to start the download.`
              : `The box refused the install.`,
          );
        }
      } finally {
        setBusy(false);
      }
    });
  };

  return (
    <Pressable
      style={[styles.cell, { width: colW }]}
      onPress={install}
      disabled={busy || requested}
      accessibilityRole="button"
      accessibilityLabel={requested ? `${name}, waiting for approval on your box` : `Install ${name || appid}`}>
      <View style={[styles.coverWrap, { width: colW - 12, height: (colW - 12) * 1.5 }]}>
        {!failed ? (
          <Image source={source} style={StyleSheet.absoluteFill} resizeMode="cover" onError={() => setFailed(true)} />
        ) : (
          <View style={[StyleSheet.absoluteFill, styles.coverFallback]}>
            <Ionicons name="cloud-download-outline" size={22} color="#8aa" />
          </View>
        )}
        <View style={styles.badge}>
          {busy ? (
            <ActivityIndicator size="small" />
          ) : (
            <Ionicons name={requested ? 'hourglass-outline' : 'cloud-download-outline'} size={14} color="#fff" />
          )}
        </View>
      </View>
      <Text style={styles.cellLabel} numberOfLines={2}>{name || '…'}</Text>
      {requested ? <Text style={styles.cellHint} numberOfLines={1}>Approve on box…</Text> : null}
    </Pressable>
  );
}

const COLUMNS = 3;

export default function InstallablePage() {
  const t = useTheme();
  const styles = useThemedStyles(makeStyles);
  const insets = useSafeAreaInsets();
  const { settings } = useSettings();
  useLockOrientation('portrait'); // like every screen but the Pad — no landscape layout here

  const [appids, setAppids] = useState<number[] | null>(null);
  const [details, setDetails] = useState<Record<number, Resolved>>({});
  const [query, setQuery] = useState('');
  const { width: winW } = useWindowDimensions();

  // Fetch the appid list once.
  useEffect(() => {
    let live = true;
    void (async () => {
      const res = await api.installable(settings);
      if (live) setAppids(res ? res.games.map((g) => g.appid) : []);
    })();
    return () => { live = false; };
  }, [settings]);

  // Resolve names/types LAZILY for whatever is on screen (cached; the store
  // rate-limits, so we never bulk-fetch the whole library).
  const resolving = useRef(new Set<number>());
  const detailsRef = useRef(details);
  detailsRef.current = details;
  // Stable (useCallback []): it reads the latest details via a ref, so it never
  // changes identity — FlatList forbids a changing onViewableItemsChanged.
  const resolveVisible = useCallback((ids: number[]) => {
    for (const id of ids) {
      if (detailsRef.current[id] !== undefined || resolving.current.has(id)) continue;
      resolving.current.add(id);
      void fetchAppDetails(id)
        .then((d) => setDetails((prev) => ({ ...prev, [id]: d })))
        .catch(() => setDetails((prev) => ({ ...prev, [id]: null })))
        .finally(() => resolving.current.delete(id));
    }
  }, []);
  const onViewableItemsChanged = useRef(({ viewableItems }: { viewableItems: ViewToken[] }) => {
    resolveVisible(viewableItems.map((v) => v.item as number));
  }).current;

  // What to show: while a tile is unresolved it stays (so it renders + resolves);
  // once resolved, only games remain. A search filters by resolved name (an
  // unresolved tile can't match a name, so it drops out while searching).
  const q = query.trim().toLowerCase();
  const data = useMemo(() => {
    if (!appids) return [];
    return appids.filter((id) => {
      const d = details[id];
      if (q) return isInstallableGameType(d) && d!.name.toLowerCase().includes(q);
      return d === undefined || isInstallableGameType(d);
    });
  }, [appids, details, q]);

  const [requested, setRequested] = useState<Set<number>>(new Set());
  const onRequested = useCallback((appid: number) => {
    setRequested((prev) => new Set(prev).add(appid));
  }, []);

  const colW = Math.floor((winW - 12) / COLUMNS); // listWrap has paddingHorizontal: 6

  return (
    <View style={[styles.screen, { paddingTop: insets.top }]}>
      <Stack.Screen options={{ headerShown: false }} />
      {/* Header */}
      <View style={styles.header}>
        <Pressable onPress={() => router.back()} hitSlop={12} accessibilityRole="button" accessibilityLabel="Back">
          <Ionicons name="chevron-back" size={26} color={t.text} />
        </Pressable>
        <Text style={styles.title}>Not installed</Text>
        <Text style={styles.count}>{appids ? `${appids.length}` : ''}</Text>
      </View>
      {/* Search */}
      <View style={styles.searchWrap}>
        <Ionicons name="search" size={16} color={t.textFaint} />
        <TextInput
          style={styles.search}
          placeholder="Search your library"
          placeholderTextColor={t.textFaint}
          value={query}
          onChangeText={setQuery}
          autoCapitalize="none"
          autoCorrect={false}
          returnKeyType="search"
        />
        {query ? (
          <Pressable onPress={() => setQuery('')} hitSlop={10}>
            <Ionicons name="close-circle" size={16} color={t.textFaint} />
          </Pressable>
        ) : null}
      </View>

      {appids === null ? (
        <View style={styles.centre}><ActivityIndicator /></View>
      ) : (
        <View style={styles.listWrap}>
          <FlatList
            data={data}
            keyExtractor={(id) => String(id)}
            numColumns={COLUMNS}
            renderItem={({ item }) => (
              <Cell
                appid={item}
                name={details[item]?.name}
                requested={requested.has(item)}
                onRequested={onRequested}
                colW={colW}
              />
            )}
            onViewableItemsChanged={onViewableItemsChanged}
            viewabilityConfig={{ itemVisiblePercentThreshold: 10 }}
            initialNumToRender={18}
            windowSize={5}
            removeClippedSubviews
            contentContainerStyle={{ paddingBottom: insets.bottom + 24 }}
            keyboardShouldPersistTaps="handled"
            ListEmptyComponent={
              <Text style={styles.empty}>
                {q ? 'No games match.' : 'Finding games in your library…'}
              </Text>
            }
          />
        </View>
      )}
    </View>
  );
}

const makeStyles = (t: Palette) =>
  StyleSheet.create({
    screen: { flex: 1, backgroundColor: t.bg },
    header: {
      flexDirection: 'row', alignItems: 'center', gap: 10,
      paddingHorizontal: 12, paddingVertical: 10,
    },
    title: { color: t.text, fontSize: 20, fontWeight: '800' },
    count: { color: t.textFaint, fontSize: 13, marginLeft: 'auto', fontFamily: 'monospace' },
    searchWrap: {
      flexDirection: 'row', alignItems: 'center', gap: 8,
      marginHorizontal: 12, marginBottom: 8, paddingHorizontal: 12, height: 40,
      backgroundColor: t.card, borderRadius: 10, borderWidth: 1, borderColor: t.cardBorder,
    },
    search: { flex: 1, color: t.text, fontSize: 15, paddingVertical: 0 },
    listWrap: { flex: 1, paddingHorizontal: 6 },
    centre: { flex: 1, alignItems: 'center', justifyContent: 'center' },
    cell: { padding: 6, alignItems: 'center' },
    coverWrap: {
      borderRadius: 8, overflow: 'hidden', backgroundColor: t.card,
      borderWidth: 1, borderColor: t.cardBorder,
    },
    coverFallback: { alignItems: 'center', justifyContent: 'center' },
    badge: {
      position: 'absolute', top: 6, right: 6, width: 24, height: 24, borderRadius: 12,
      backgroundColor: 'rgba(0,0,0,0.6)', alignItems: 'center', justifyContent: 'center',
    },
    cellLabel: { color: t.text, fontSize: 11, textAlign: 'center', marginTop: 4 },
    cellHint: { color: t.amber, fontSize: 10, textAlign: 'center', marginTop: 2 },
    empty: { color: t.textFaint, textAlign: 'center', marginTop: 40, fontSize: 13 },
  });
