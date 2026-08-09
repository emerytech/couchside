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

import { type Compat, deckLabel, protonLabel } from '@/lib/compat';
import { fetchCompat } from '@/lib/compatFetch';
import { useLockOrientation } from '@/hooks/useLockOrientation';
import { api } from '@/lib/api';
import { hapticLight } from '@/lib/haptics';
import { useSettings } from '@/lib/SettingsContext';
import { openInSteamStore } from '@/lib/steamLinks';
import { fetchAppDetails } from '@/lib/steamStore';
import { fetchSteamReview } from '@/lib/steamReviews';
import { isInstallableGameType, type AppDetails, type SteamReview } from '@/lib/steamStoreParse';
import { useTheme, useThemedStyles, type Palette } from '@/lib/theme';

type Sort = 'az' | 'za' | 'newest' | 'metacritic' | 'reviews';
const SORTS: { key: Sort; label: string }[] = [
  { key: 'az', label: 'Name A–Z' },
  { key: 'za', label: 'Name Z–A' },
  { key: 'newest', label: 'Newest first' },
  { key: 'metacritic', label: 'Metacritic' },
  { key: 'reviews', label: 'Most reviewed' },
];

/** Metacritic filter tiers. 0 = any. */
const RATINGS: { key: number; label: string }[] = [
  { key: 0, label: 'Any' },
  { key: 75, label: 'Metacritic 75+' },
  { key: 90, label: 'Metacritic 90+' },
];

/** "Runs well on this box": Deck verified/playable, or a good ProtonDB tier. */
function runsWell(c: Compat | undefined): boolean {
  if (!c) return false;
  if (c.deck === 'verified' || c.deck === 'playable') return true;
  return c.proton === 'platinum' || c.proton === 'gold' || c.proton === 'silver';
}

/** A Steam review is "good" for the filter at score >= 6 (Positive and up:
 *  6=Positive, 7=Very Positive, 8=Overwhelmingly, plus 9). */
function reviewIsPositive(r: SteamReview | null | undefined): boolean {
  return !!r && r.score >= 6;
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

/** Metacritic's own colour convention: green >=75, yellow 50–74, red <50. */
function mcColor(score: number): string {
  return score >= 75 ? '#4c8b2b' : score >= 50 ? '#a89226' : '#a02a1c';
}

/** A grid tile: cover + name + (when known) a Metacritic badge. Tapping opens the
 *  game detail sheet — install and Open-in-Steam live there, not on the tile. */
function Cell({
  appid, d, requested, colW, onOpen,
}: {
  appid: number; d?: AppDetails; requested: boolean;
  colW: number; onOpen: (appid: number) => void;
}) {
  const styles = useThemedStyles(makeStyles);
  const { settings } = useSettings();
  const source = api.steamCoverSource(settings, appid);
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [source.uri]);
  const name = d?.name;
  const mc = d?.metacritic;

  return (
    <Pressable
      style={[styles.cell, { width: colW }]}
      onPress={() => { hapticLight(); onOpen(appid); }}
      accessibilityRole="button"
      accessibilityLabel={`${name || appid}${mc !== undefined ? `, Metacritic ${mc}` : ''}${requested ? ', waiting for approval on your box' : ''}`}>
      <View style={[styles.coverWrap, { width: colW - 12, height: (colW - 12) * 1.5 }]}>
        {!failed ? (
          <Image source={source} style={StyleSheet.absoluteFill} resizeMode="cover" onError={() => setFailed(true)} />
        ) : (
          <View style={[StyleSheet.absoluteFill, styles.coverFallback]}>
            <Ionicons name="cloud-download-outline" size={22} color="#8aa" />
          </View>
        )}
        {mc !== undefined ? (
          <View style={[styles.mcBadge, { backgroundColor: mcColor(mc) }]}>
            <Text style={styles.mcText}>{mc}</Text>
          </View>
        ) : null}
        <View style={styles.badge}>
          <Ionicons name={requested ? 'hourglass-outline' : 'cloud-download-outline'} size={14} color="#fff" />
        </View>
      </View>
      <Text style={styles.cellLabel} numberOfLines={2}>{name || '…'}</Text>
      {requested ? <Text style={styles.cellHint} numberOfLines={1}>Approve on box…</Text> : null}
    </Pressable>
  );
}

/** The game detail sheet: cover, name, ratings (Metacritic + Steam review),
 *  genres + controller support, and the two actions — Install on box, Open in
 *  Steam. Fetches the game's Steam review lazily when opened. */
function GameSheet({
  appid, d, compat, requested, insetBottom, onClose, onRequested,
}: {
  appid: number; d?: AppDetails; compat?: Compat; requested: boolean;
  insetBottom: number; onClose: () => void; onRequested: (appid: number) => void;
}) {
  const t = useTheme();
  const styles = useThemedStyles(makeStyles);
  const { settings } = useSettings();
  const source = api.steamCoverSource(settings, appid);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [review, setReview] = useState<SteamReview | null | undefined>(undefined);
  const name = d?.name || `App ${appid}`;

  useEffect(() => {
    let live = true;
    setReview(undefined);
    void fetchSteamReview(appid).then((r) => { if (live) setReview(r); });
    return () => { live = false; };
  }, [appid]);

  const install = () => {
    hapticLight();
    confirmInstall(name, async () => {
      setBusy(true);
      try {
        const res = await api.launch(settings, `install:${appid}`);
        if (res?.ok) onRequested(appid);
        if (Platform.OS !== 'web') {
          Alert.alert(
            res?.ok ? 'Approve it on your box' : "Couldn't start install",
            res?.ok
              ? `A prompt for "${name}" is on your box's screen — approve it (a controller, or your phone's Pad) to start the download.`
              : 'The box refused the install.',
          );
        }
        if (res?.ok) onClose();
      } finally {
        setBusy(false);
      }
    });
  };

  const mc = d?.metacritic;
  const controller = d?.controllerSupport;
  const runsWellHere = compat && runsWell(compat);

  return (
    <Modal visible transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={styles.sheetScrim} onPress={onClose} />
      <View style={[styles.gameSheet, { paddingBottom: insetBottom + 16 }]}>
        <View style={styles.sheetHandle} />
        <View style={styles.gsHead}>
          <View style={styles.gsCover}>
            {!failed ? (
              <Image source={source} style={StyleSheet.absoluteFill} resizeMode="cover" onError={() => setFailed(true)} />
            ) : <View style={[StyleSheet.absoluteFill, styles.coverFallback]} />}
          </View>
          <View style={{ flex: 1 }}>
            <Text style={styles.gsName} numberOfLines={3}>{name}</Text>
            {d?.releaseYear ? <Text style={styles.gsSub}>{d.releaseYear}</Text> : null}
          </View>
        </View>

        {/* Ratings row */}
        <View style={styles.gsRatings}>
          {mc !== undefined ? (
            <View style={[styles.gsChip, { borderColor: mcColor(mc) }]}>
              <Text style={[styles.gsChipStrong, { color: mcColor(mc) }]}>{mc}</Text>
              <Text style={styles.gsChipText}>Metacritic</Text>
            </View>
          ) : null}
          {review === undefined ? (
            <View style={styles.gsChip}><ActivityIndicator size="small" color={t.textFaint} /></View>
          ) : review ? (
            <View style={styles.gsChip}>
              <Text style={[styles.gsChipStrong, { color: review.score >= 6 ? t.green : t.red }]}>
                {review.positivePct}%
              </Text>
              <Text style={styles.gsChipText} numberOfLines={1}>{review.desc}</Text>
            </View>
          ) : null}
          {runsWellHere ? (
            <View style={[styles.gsChip, { borderColor: t.green }]}>
              <Ionicons name="game-controller-outline" size={14} color={t.green} />
              <Text style={styles.gsChipText}>Runs well here</Text>
            </View>
          ) : null}
          {controller ? (
            <View style={styles.gsChip}>
              <Ionicons name="game-controller-outline" size={14} color={t.textDim} />
              <Text style={styles.gsChipText}>{controller === 'full' ? 'Full controller' : 'Partial controller'}</Text>
            </View>
          ) : null}
        </View>

        {d?.genres?.length ? (
          <Text style={styles.gsGenres} numberOfLines={2}>
            {d.genres.map((g) => g.replace(/\b\w/g, (c) => c.toUpperCase())).join(' · ')}
          </Text>
        ) : null}
        {compat ? (
          <Text style={styles.gsSub} numberOfLines={1}>
            Deck: {deckLabel(compat.deck)} · ProtonDB: {protonLabel(compat.proton)}
          </Text>
        ) : null}

        <View style={styles.gsActions}>
          <Pressable
            onPress={install}
            disabled={busy || requested}
            style={({ pressed }) => [styles.gsPrimary, { opacity: busy || requested ? 0.6 : pressed ? 0.85 : 1 }]}
            accessibilityRole="button">
            {busy ? <ActivityIndicator size="small" color="#fff" />
              : <Ionicons name="cloud-download-outline" size={18} color="#fff" />}
            <Text style={styles.gsPrimaryText}>{requested ? 'Waiting for approval…' : 'Install on box'}</Text>
          </Pressable>
          <Pressable
            onPress={() => { hapticLight(); void openInSteamStore(appid); }}
            style={({ pressed }) => [styles.gsGhost, { borderColor: t.cardBorder, opacity: pressed ? 0.8 : 1 }]}
            accessibilityRole="button"
            accessibilityLabel="Open in Steam">
            <Ionicons name="logo-steam" size={18} color={t.text} />
            <Text style={styles.gsGhostText}>Open in Steam</Text>
          </Pressable>
        </View>
      </View>
    </Modal>
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
  // OFFLINE names+types from the agent (>= 2.9.76, parsed from the box's own
  // appinfo.vdf). Kept SEPARATE from the store `details` map on purpose: the
  // store index still runs to enrich genres/release-year (agent meta has
  // neither), and `details[id] ?? agentMeta[id]` means store data wins when it
  // arrives while the agent name survives a store failure. Before this seed, a
  // big library filled at the store's ~200/5min rate — an 1101-app library
  // showed 88 games after days of use.
  const [agentMeta, setAgentMeta] = useState<Record<number, AppDetails>>({});
  const [compat, setCompat] = useState<Record<number, Compat | undefined>>({});
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<Sort>('az');
  const [genres, setGenres] = useState<Set<string>>(new Set());
  const [onlyRunsWell, setOnlyRunsWell] = useState(false);
  const [minRating, setMinRating] = useState(0);          // Metacritic tier
  const [controllerOnly, setControllerOnly] = useState(false);
  const [onlyPositive, setOnlyPositive] = useState(false); // Steam review >= Positive
  const [reviews, setReviews] = useState<Record<number, SteamReview | null | undefined>>({});
  const [sheet, setSheet] = useState(false);              // the FILTER sheet
  const [sheetAppid, setSheetAppid] = useState<number | null>(null); // the game detail sheet

  // Fetch the appid list once. Entries carry name/type on new agents.
  useEffect(() => {
    let live = true;
    void (async () => {
      const res = await api.installable(settings);
      if (!live) return;
      setAppids(res ? res.games.map((g) => g.appid) : []);
      if (res) {
        const seed: Record<number, AppDetails> = {};
        for (const g of res.games) {
          if (g.name) seed[g.appid] = { name: g.name, type: g.type ?? '' };
        }
        setAgentMeta(seed);
      }
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
    () => (appids ?? []).filter((id) => isInstallableGameType(details[id] ?? agentMeta[id])),
    [appids, details, agentMeta],
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

  // REVIEW INDEX: only while the Steam-review filter is on (the sentiment is a
  // SEPARATE request from appdetails). Same lazy, 3-worker, cached-hard shape as
  // the compat index — bounded so it doesn't hammer the store's rate limit.
  const reviewsRef = useRef(reviews);
  reviewsRef.current = reviews;
  useEffect(() => {
    if (!onlyPositive) return;
    const signal = { aborted: false };
    const queue = gameIds.filter((id) => reviewsRef.current[id] === undefined);
    let next = 0;
    const worker = async () => {
      while (!signal.aborted && next < queue.length) {
        const id = queue[next++];
        try {
          const r = await fetchSteamReview(id);
          if (!signal.aborted) setReviews((p) => ({ ...p, [id]: r }));
        } catch { /* unknown */ }
      }
    };
    void Promise.all([worker(), worker(), worker()]);
    return () => { signal.aborted = true; };
  }, [onlyPositive, gameIds]);

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
    // Store details win (they carry genres/year); the agent's offline name+type
    // stand in until then — and permanently, if the store never answers.
    const eff = (id: number) => (details[id] ?? agentMeta[id])!;
    const rows = gameIds.filter((id) => {
      const d = eff(id);
      if (q && !d.name.toLowerCase().includes(q)) return false;
      if (genres.size && !(d.genres ?? []).some((g) => genres.has(g))) return false;
      // Rating / controller come from the same details payload — a game not yet
      // resolved (no details) is kept (shown) rather than hidden while indexing.
      if (minRating > 0 && details[id] && (details[id]!.metacritic ?? -1) < minRating) return false;
      if (controllerOnly && details[id] && details[id]!.controllerSupport !== 'full') return false;
      if (onlyRunsWell) {
        const c = compat[id];
        if (c !== undefined && !runsWell(c)) return false; // resolved-and-not-good hidden; still-checking shown
      }
      if (onlyPositive) {
        const r = reviews[id];
        if (r !== undefined && !reviewIsPositive(r)) return false; // resolved-and-not-positive hidden
      }
      return true;
    });
    rows.sort((a, b) => {
      const da = eff(a), db = eff(b);
      if (sort === 'newest') return (db.releaseYear ?? -1) - (da.releaseYear ?? -1)
        || da.name.localeCompare(db.name);
      if (sort === 'metacritic') return (details[b]?.metacritic ?? -1) - (details[a]?.metacritic ?? -1)
        || da.name.localeCompare(db.name);
      if (sort === 'reviews') return (details[b]?.recommendations ?? -1) - (details[a]?.recommendations ?? -1)
        || da.name.localeCompare(db.name);
      const c = da.name.localeCompare(db.name);
      return sort === 'za' ? -c : c;
    });
    return rows;
  }, [gameIds, details, agentMeta, compat, reviews, q, genres, onlyRunsWell, minRating, controllerOnly, onlyPositive, sort]);

  const [requested, setRequested] = useState<Set<number>>(new Set());
  const onRequested = useCallback((appid: number) => setRequested((p) => new Set(p).add(appid)), []);

  const colW = Math.floor((winW - 12) / COLUMNS); // listWrap has paddingHorizontal: 6
  const resolvedCount = appids ? appids.filter((id) => details[id] !== undefined).length : 0;
  const indexing = appids ? resolvedCount < appids.length : false;
  const seeded = Object.keys(agentMeta).length > 0;
  const activeFilters = genres.size + (onlyRunsWell ? 1 : 0)
    + (minRating > 0 ? 1 : 0) + (controllerOnly ? 1 : 0) + (onlyPositive ? 1 : 0);
  const sortLabel = SORTS.find((s) => s.key === sort)!.label;
  const sheetGame = sheetAppid != null
    ? (details[sheetAppid] ?? agentMeta[sheetAppid]) : undefined;

  return (
    <View style={[styles.screen, { paddingTop: insets.top }]}>
      <Stack.Screen options={{ headerShown: false }} />
      <View style={styles.header}>
        <Pressable onPress={() => router.back()} hitSlop={12} accessibilityRole="button" accessibilityLabel="Back">
          <Ionicons name="chevron-back" size={26} color={t.text} />
        </Pressable>
        <Text style={styles.title}>Not installed</Text>
        {/* Seeded (agent >= 2.9.76): the true GAME count, immediately — the raw
            appid list overcounts ~2.5x with DLC/tools. Unseeded: the raw count,
            as before, while the store index discovers which entries are games. */}
        <Text style={styles.count}>{appids ? `${seeded ? gameIds.length : appids.length}` : ''}</Text>
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
        {/* Seeded: the LIST is already complete (agent names); the store index only
            enriches genres/release-year for the filters. Unseeded: it IS the list. */}
        {indexing ? (seeded
          ? `  ·  loading genres ${resolvedCount}/${appids!.length}…`
          : `  ·  indexing ${resolvedCount}/${appids!.length}…`) : ''}
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
              <Cell appid={item} d={details[item] ?? agentMeta[item] ?? undefined}
                requested={requested.has(item)} colW={colW} onOpen={setSheetAppid} />
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
                {!seeded && indexing ? 'Finding games in your library…'
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

            <Text style={styles.sheetH}>Rating</Text>
            <View style={styles.chips}>
              {RATINGS.map((r) => (
                <Pressable key={r.key} onPress={() => setMinRating(r.key)}
                  style={[styles.chip, minRating === r.key && styles.chipOn]}>
                  <Text style={[styles.chipText, minRating === r.key && styles.chipTextOn]}>{r.label}</Text>
                </Pressable>
              ))}
            </View>

            <Text style={styles.sheetH}>Steam review</Text>
            <Pressable onPress={() => setOnlyPositive((v) => !v)}
              style={[styles.chip, styles.chipWide, onlyPositive && styles.chipOn]}>
              <Ionicons name={onlyPositive ? 'checkbox' : 'square-outline'} size={16}
                color={onlyPositive ? t.blue : t.textFaint} />
              <Text style={[styles.chipText, onlyPositive && styles.chipTextOn]}>
                Positive or better
              </Text>
            </Pressable>

            <Text style={styles.sheetH}>Controller</Text>
            <Pressable onPress={() => setControllerOnly((v) => !v)}
              style={[styles.chip, styles.chipWide, controllerOnly && styles.chipOn]}>
              <Ionicons name={controllerOnly ? 'checkbox' : 'square-outline'} size={16}
                color={controllerOnly ? t.blue : t.textFaint} />
              <Text style={[styles.chipText, controllerOnly && styles.chipTextOn]}>
                Full controller support
              </Text>
            </Pressable>

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
              <Pressable onPress={() => {
                setGenres(new Set()); setOnlyRunsWell(false); setSort('az');
                setMinRating(0); setControllerOnly(false); setOnlyPositive(false);
              }}>
                <Text style={styles.clear}>Reset</Text>
              </Pressable>
              <Pressable style={styles.doneBtn} onPress={() => setSheet(false)}>
                <Text style={styles.doneText}>Show {data.length}</Text>
              </Pressable>
            </View>
          </ScrollView>
        </View>
      </Modal>

      {/* Game detail sheet — ratings + Install + Open in Steam. */}
      {sheetAppid != null ? (
        <GameSheet
          appid={sheetAppid}
          d={sheetGame ?? undefined}
          compat={compat[sheetAppid]}
          requested={requested.has(sheetAppid)}
          insetBottom={insets.bottom}
          onClose={() => setSheetAppid(null)}
          onRequested={onRequested}
        />
      ) : null}
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
    mcBadge: {
      position: 'absolute', top: 6, left: 6, minWidth: 22, height: 22, borderRadius: 5,
      paddingHorizontal: 4, alignItems: 'center', justifyContent: 'center',
    },
    mcText: { color: '#fff', fontSize: 12, fontWeight: '800' },
    // game detail sheet
    gameSheet: {
      backgroundColor: t.bg, borderTopLeftRadius: 18, borderTopRightRadius: 18,
      paddingHorizontal: 16, paddingTop: 8, borderTopWidth: 1, borderColor: t.cardBorder,
    },
    gsHead: { flexDirection: 'row', gap: 12, alignItems: 'flex-start' },
    gsCover: { width: 72, height: 108, borderRadius: 8, overflow: 'hidden', backgroundColor: t.card },
    gsName: { color: t.text, fontSize: 18, fontWeight: '800' },
    gsSub: { color: t.textFaint, fontSize: 12, marginTop: 4 },
    gsRatings: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 14 },
    gsChip: {
      flexDirection: 'row', alignItems: 'center', gap: 6, paddingVertical: 6, paddingHorizontal: 10,
      borderRadius: 10, backgroundColor: t.card, borderWidth: 1, borderColor: t.cardBorder,
    },
    gsChipStrong: { fontSize: 14, fontWeight: '800' },
    gsChipText: { color: t.textDim, fontSize: 12, fontWeight: '600' },
    gsGenres: { color: t.textFaint, fontSize: 12, marginTop: 12, lineHeight: 17 },
    gsActions: { flexDirection: 'row', gap: 10, marginTop: 18 },
    gsPrimary: {
      flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
      backgroundColor: t.blue, paddingVertical: 13, borderRadius: 12,
    },
    gsPrimaryText: { color: '#fff', fontWeight: '700', fontSize: 14 },
    gsGhost: {
      flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
      paddingVertical: 13, paddingHorizontal: 16, borderRadius: 12, borderWidth: 1, backgroundColor: t.card,
    },
    gsGhostText: { color: t.text, fontWeight: '700', fontSize: 14 },
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
