/**
 * "Install a game you own but haven't downloaded" — the FULL library page, with
 * sort + filters.
 *
 * A dedicated route (not an inline grid) because the library is large (1000+); a
 * FlatList virtualises it. NAMES, TYPE, RELEASE YEAR and GENRES come from Valve's
 * KEYLESS store (lib/steamStore); the "runs well here" filter adds Deck/ProtonDB
 * compat (lib/compat), fetched ONLY while that filter is on.
 *
 * THE SCALE TENSION: the store rate-limits (~200/5min), so sort/filter can't have
 * the whole library instantly. A gentle BACKGROUND INDEX resolves store details for
 * every appid (cached 30 days, so it's a one-time cost), and the grid shows the
 * resolved-and-filtered games sorted, with a progress line while it fills. type=game
 * hides the tools/DLC the library cache overcounts. Installing pops Steam's approve
 * prompt on the box (verified behavior) — the copy says so.
 */
import Ionicons from '@expo/vector-icons/Ionicons';
import { Stack, router } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator, Alert, FlatList, Image, Modal, Platform, Pressable,
  ScrollView, StyleSheet, Text, TextInput, useWindowDimensions, View, type ViewToken,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { type Compat } from '@/lib/compat';
import { fetchCompat } from '@/lib/compatFetch';
import { useLockOrientation } from '@/hooks/useLockOrientation';
import { api } from '@/lib/api';
import { hapticLight } from '@/lib/haptics';
import { useSettings } from '@/lib/SettingsContext';
import { fetchAppDetails } from '@/lib/steamStore';
import { isInstallableGameType, type AppDetails } from '@/lib/steamStoreParse';
import { useTheme, useThemedStyles, type Palette } from '@/lib/theme';

type Sort = 'az' | 'za' | 'newest';
const SORTS: { key: Sort; label: string }[] = [
  { key: 'az', label: 'Name A–Z' },
  { key: 'za', label: 'Name Z–A' },
  { key: 'newest', label: 'Newest first' },
];

/** "Runs well on this box": Deck verified/playable, or a good ProtonDB tier. */
function runsWell(c: Compat | undefined): boolean {
  if (!c) return false;
  if (c.deck === 'verified' || c.deck === 'playable') return true;
  return c.proton === 'platinum' || c.proton === 'gold' || c.proton === 'silver';
}

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
  appid: number; name?: string; requested: boolean;
  onRequested: (appid: number) => void; colW: number;
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
              : 'The box refused the install.',
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
          {busy ? <ActivityIndicator size="small" />
            : <Ionicons name={requested ? 'hourglass-outline' : 'cloud-download-outline'} size={14} color="#fff" />}
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
  useLockOrientation('portrait'); // like every screen but the Pad

  const { width: winW } = useWindowDimensions();
  const [appids, setAppids] = useState<number[] | null>(null);
  const [details, setDetails] = useState<Record<number, AppDetails | null | undefined>>({});
  const [compat, setCompat] = useState<Record<number, Compat | undefined>>({});
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<Sort>('az');
  const [genres, setGenres] = useState<Set<string>>(new Set());
  const [onlyRunsWell, setOnlyRunsWell] = useState(false);
  const [sheet, setSheet] = useState(false);

  // Fetch the appid list once.
  useEffect(() => {
    let live = true;
    void (async () => {
      const res = await api.installable(settings);
      if (live) setAppids(res ? res.games.map((g) => g.appid) : []);
    })();
    return () => { live = false; };
  }, [settings]);

  // BACKGROUND INDEX: resolve store details for the whole library, gently
  // (concurrency-limited, cached). Sort/filter need the data; this fills it once.
  const detailsRef = useRef(details);
  detailsRef.current = details;
  useEffect(() => {
    if (!appids) return;
    const signal = { aborted: false };
    const queue = appids.filter((id) => detailsRef.current[id] === undefined);
    let next = 0;
    const worker = async () => {
      while (!signal.aborted && next < queue.length) {
        const id = queue[next++];
        const d = await fetchAppDetails(id);
        if (!signal.aborted) setDetails((p) => ({ ...p, [id]: d }));
      }
    };
    // 3 workers: polite to the store's ~200/5min cap; a 429 is not cached (retries).
    void Promise.all([worker(), worker(), worker()]);
    return () => { signal.aborted = true; };
  }, [appids]);

  // COMPAT INDEX: only while the "runs well here" filter is on, and only for the
  // games we're actually considering (resolved games). Cached hard (14 days).
  const compatRef = useRef(compat);
  compatRef.current = compat;
  const gameIds = useMemo(
    () => (appids ?? []).filter((id) => isInstallableGameType(details[id])),
    [appids, details],
  );
  useEffect(() => {
    if (!onlyRunsWell) return;
    const signal = { aborted: false };
    const queue = gameIds.filter((id) => compatRef.current[id] === undefined);
    let next = 0;
    const worker = async () => {
      while (!signal.aborted && next < queue.length) {
        const id = queue[next++];
        try {
          const c = await fetchCompat(id);
          if (!signal.aborted) setCompat((p) => ({ ...p, [id]: c }));
        } catch { /* unknown */ }
      }
    };
    void Promise.all([worker(), worker(), worker()]);
    return () => { signal.aborted = true; };
  }, [onlyRunsWell, gameIds]);

  // Lazy: prioritise resolving whatever is on screen (the background index catches
  // the rest). Keeps the first screenful filling fast.
  const resolveVisible = useCallback((ids: number[]) => {
    for (const id of ids) {
      if (detailsRef.current[id] !== undefined) continue;
      void fetchAppDetails(id).then((d) => setDetails((p) => ({ ...p, [id]: d })));
    }
  }, []);
  const onViewableItemsChanged = useRef(({ viewableItems }: { viewableItems: ViewToken[] }) => {
    resolveVisible(viewableItems.map((v) => v.item as number));
  }).current;

  // Genre options = the union of genres seen across resolved games (fills as the
  // index runs). Sorted, capped so the sheet stays usable.
  const genreOptions = useMemo(() => {
    const s = new Set<string>();
    for (const id of gameIds) for (const g of details[id]?.genres ?? []) s.add(g);
    return Array.from(s).sort().slice(0, 40);
  }, [gameIds, details]);

  const q = query.trim().toLowerCase();
  const data = useMemo(() => {
    const rows = gameIds.filter((id) => {
      const d = details[id]!;
      if (q && !d.name.toLowerCase().includes(q)) return false;
      if (genres.size && !(d.genres ?? []).some((g) => genres.has(g))) return false;
      if (onlyRunsWell) {
        const c = compat[id];
        if (c !== undefined && !runsWell(c)) return false; // resolved-and-not-good hidden; still-checking shown
      }
      return true;
    });
    rows.sort((a, b) => {
      const da = details[a]!, db = details[b]!;
      if (sort === 'newest') return (db.releaseYear ?? -1) - (da.releaseYear ?? -1)
        || da.name.localeCompare(db.name);
      const c = da.name.localeCompare(db.name);
      return sort === 'za' ? -c : c;
    });
    return rows;
  }, [gameIds, details, compat, q, genres, onlyRunsWell, sort]);

  const [requested, setRequested] = useState<Set<number>>(new Set());
  const onRequested = useCallback((appid: number) => setRequested((p) => new Set(p).add(appid)), []);

  const colW = Math.floor((winW - 12) / COLUMNS); // listWrap has paddingHorizontal: 6
  const resolvedCount = appids ? appids.filter((id) => details[id] !== undefined).length : 0;
  const indexing = appids ? resolvedCount < appids.length : false;
  const activeFilters = genres.size + (onlyRunsWell ? 1 : 0);
  const sortLabel = SORTS.find((s) => s.key === sort)!.label;

  return (
    <View style={[styles.screen, { paddingTop: insets.top }]}>
      <Stack.Screen options={{ headerShown: false }} />
      <View style={styles.header}>
        <Pressable onPress={() => router.back()} hitSlop={12} accessibilityRole="button" accessibilityLabel="Back">
          <Ionicons name="chevron-back" size={26} color={t.text} />
        </Pressable>
        <Text style={styles.title}>Not installed</Text>
        <Text style={styles.count}>{appids ? `${appids.length}` : ''}</Text>
      </View>

      <View style={styles.controls}>
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
        <Pressable
          style={[styles.filterBtn, activeFilters > 0 && styles.filterBtnOn]}
          onPress={() => { hapticLight(); setSheet(true); }}
          accessibilityRole="button"
          accessibilityLabel="Sort and filter">
          <Ionicons name="options-outline" size={18} color={activeFilters > 0 ? t.blue : t.text} />
          {activeFilters > 0 ? <Text style={styles.filterCount}>{activeFilters}</Text> : null}
        </Pressable>
      </View>
      <Text style={styles.sortLine} numberOfLines={1}>
        {sortLabel}{activeFilters > 0 ? ` · ${activeFilters} filter${activeFilters > 1 ? 's' : ''}` : ''}
        {indexing ? `  ·  indexing ${resolvedCount}/${appids!.length}…` : ''}
      </Text>

      {appids === null ? (
        <View style={styles.centre}><ActivityIndicator /></View>
      ) : (
        <View style={styles.listWrap}>
          <FlatList
            data={data}
            keyExtractor={(id) => String(id)}
            numColumns={COLUMNS}
            renderItem={({ item }) => (
              <Cell appid={item} name={details[item]?.name} requested={requested.has(item)}
                onRequested={onRequested} colW={colW} />
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
                {indexing ? 'Finding games in your library…'
                  : (q || activeFilters) ? 'No games match.' : 'No games found.'}
              </Text>
            }
          />
        </View>
      )}

      {/* Sort + filter sheet */}
      <Modal visible={sheet} transparent animationType="slide" onRequestClose={() => setSheet(false)}>
        <Pressable style={styles.sheetScrim} onPress={() => setSheet(false)} />
        <View style={[styles.sheet, { paddingBottom: insets.bottom + 16 }]}>
          <View style={styles.sheetHandle} />
          <ScrollView>
            <Text style={styles.sheetH}>Sort</Text>
            <View style={styles.chips}>
              {SORTS.map((s) => (
                <Pressable key={s.key} onPress={() => setSort(s.key)}
                  style={[styles.chip, sort === s.key && styles.chipOn]}>
                  <Text style={[styles.chipText, sort === s.key && styles.chipTextOn]}>{s.label}</Text>
                </Pressable>
              ))}
            </View>

            <Text style={styles.sheetH}>Runs well on this box</Text>
            <Pressable onPress={() => setOnlyRunsWell((v) => !v)}
              style={[styles.chip, styles.chipWide, onlyRunsWell && styles.chipOn]}>
              <Ionicons name={onlyRunsWell ? 'checkbox' : 'square-outline'} size={16}
                color={onlyRunsWell ? t.blue : t.textFaint} />
              <Text style={[styles.chipText, onlyRunsWell && styles.chipTextOn]}>
                Deck Verified / Playable or ProtonDB Gold+
              </Text>
            </Pressable>

            {genreOptions.length ? (
              <>
                <Text style={styles.sheetH}>Genre</Text>
                <View style={styles.chips}>
                  {genreOptions.map((g) => {
                    const on = genres.has(g);
                    return (
                      <Pressable key={g} onPress={() => setGenres((prev) => {
                        const n = new Set(prev); on ? n.delete(g) : n.add(g); return n;
                      })} style={[styles.chip, on && styles.chipOn]}>
                        <Text style={[styles.chipText, on && styles.chipTextOn]}>
                          {g.replace(/\b\w/g, (c) => c.toUpperCase())}
                        </Text>
                      </Pressable>
                    );
                  })}
                </View>
              </>
            ) : null}

            <View style={styles.sheetActions}>
              <Pressable onPress={() => { setGenres(new Set()); setOnlyRunsWell(false); setSort('az'); }}>
                <Text style={styles.clear}>Reset</Text>
              </Pressable>
              <Pressable style={styles.doneBtn} onPress={() => setSheet(false)}>
                <Text style={styles.doneText}>Show {data.length}</Text>
              </Pressable>
            </View>
          </ScrollView>
        </View>
      </Modal>
    </View>
  );
}

const makeStyles = (t: Palette) =>
  StyleSheet.create({
    screen: { flex: 1, backgroundColor: t.bg },
    header: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 12, paddingVertical: 10 },
    title: { color: t.text, fontSize: 20, fontWeight: '800' },
    count: { color: t.textFaint, fontSize: 13, marginLeft: 'auto', fontFamily: 'monospace' },
    controls: { flexDirection: 'row', alignItems: 'center', gap: 8, marginHorizontal: 12 },
    searchWrap: {
      flex: 1, flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 12, height: 40,
      backgroundColor: t.card, borderRadius: 10, borderWidth: 1, borderColor: t.cardBorder,
    },
    search: { flex: 1, color: t.text, fontSize: 15, paddingVertical: 0 },
    filterBtn: {
      flexDirection: 'row', alignItems: 'center', gap: 4, height: 40, paddingHorizontal: 12,
      backgroundColor: t.card, borderRadius: 10, borderWidth: 1, borderColor: t.cardBorder,
    },
    filterBtnOn: { borderColor: t.blue },
    filterCount: { color: t.blue, fontSize: 12, fontWeight: '700' },
    sortLine: { color: t.textFaint, fontSize: 11, paddingHorizontal: 14, paddingTop: 6, paddingBottom: 2 },
    listWrap: { flex: 1, paddingHorizontal: 6 },
    centre: { flex: 1, alignItems: 'center', justifyContent: 'center' },
    cell: { padding: 6, alignItems: 'center' },
    coverWrap: { borderRadius: 8, overflow: 'hidden', backgroundColor: t.card, borderWidth: 1, borderColor: t.cardBorder },
    coverFallback: { alignItems: 'center', justifyContent: 'center' },
    badge: {
      position: 'absolute', top: 6, right: 6, width: 24, height: 24, borderRadius: 12,
      backgroundColor: 'rgba(0,0,0,0.6)', alignItems: 'center', justifyContent: 'center',
    },
    cellLabel: { color: t.text, fontSize: 11, textAlign: 'center', marginTop: 4 },
    cellHint: { color: t.amber, fontSize: 10, textAlign: 'center', marginTop: 2 },
    empty: { color: t.textFaint, textAlign: 'center', marginTop: 40, fontSize: 13 },
    // sheet
    sheetScrim: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)' },
    sheet: {
      backgroundColor: t.bg, borderTopLeftRadius: 18, borderTopRightRadius: 18,
      paddingHorizontal: 16, paddingTop: 8, maxHeight: '70%',
      borderTopWidth: 1, borderColor: t.cardBorder,
    },
    sheetHandle: { alignSelf: 'center', width: 40, height: 4, borderRadius: 2, backgroundColor: t.cardBorder, marginBottom: 10 },
    sheetH: { color: t.text, fontWeight: '700', fontSize: 14, marginTop: 14, marginBottom: 8 },
    chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
    chip: {
      flexDirection: 'row', alignItems: 'center', gap: 6, paddingVertical: 8, paddingHorizontal: 12,
      borderRadius: 999, backgroundColor: t.card, borderWidth: 1, borderColor: t.cardBorder,
    },
    chipWide: { alignSelf: 'flex-start' },
    chipOn: { borderColor: t.blue, backgroundColor: t.blue + '22' },
    chipText: { color: t.text, fontSize: 13 },
    chipTextOn: { color: t.blue, fontWeight: '600' },
    sheetActions: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 20 },
    clear: { color: t.textFaint, fontSize: 14 },
    doneBtn: { backgroundColor: t.blue, paddingVertical: 10, paddingHorizontal: 20, borderRadius: 10 },
    doneText: { color: '#fff', fontWeight: '700', fontSize: 14 },
  });
