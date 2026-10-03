/**
 * Play — "what to play next". Ranks the box's INSTALLED Steam games from its
 * LOCAL play history (agent >= 2.9.63, GET /api/recommend) and offers a pick to
 * launch on the box. A pick launches through the existing Steam path
 * (`api.launch(settings, 'steam:'+appid)` -> steam://rungameid). Nothing leaves
 * the LAN. Lives where the old Fleet tab sat; gated on the box's `gaming` cap so
 * it only appears for a box with Steam (the tab layout hides it otherwise).
 *
 * Same access level as every other tab (wrapped in <Gated>): the recommender is
 * not a separate paywall, just part of the app.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Platform, Linking, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import { router } from 'expo-router';

import { NowPlayingCard } from '@/components/GamingCard';
import { useConfirm } from '@/components/ConfirmDialog';

import { Gated } from '@/components/Gated';
import { TabScreen } from '@/components/TabScreen';
import { SteamProfileCard } from '@/components/SteamProfileCard';
import { WishlistAlertsBanner } from '@/components/WishlistAlertsBanner';
import { SteamDealsRow } from '@/components/SteamDealsRow';
import { SteamWishlistRow } from '@/components/SteamWishlistRow';
import { useLockOrientation } from '@/hooks/useLockOrientation';
import { PlayDataProvider, usePlayPoll, usePlaySession } from '@/hooks/usePlayPoll';
import { PlayArtwork } from '@/components/PlayArtwork';
import { api, hostKey, type Recommendation, type RecoPick, type SteamWishlistAlerts } from '@/lib/api';
import { buildWidgetPayload } from '@/lib/widget/widgetPayload';
import { updateCouchsideWidget } from '@/lib/widget/update';
import { hapticLight, hapticMedium } from '@/lib/haptics';
import { useBoxes, useSettings } from '@/lib/SettingsContext';
import { mono, useTheme, useThemedStyles, type Palette } from '@/lib/theme';

const num = (s: string) => { const n = parseInt(s, 10); return Number.isFinite(n) ? n : 0; };

/** Open the Steam app on THIS phone. Tries the custom scheme (opens the app when
 *  installed), then the s.team universal link (the app, or the Steam site in a
 *  browser if the app isn't there). openURL (not canOpenURL) so no native
 *  LSApplicationQueriesSchemes entry is needed — works in any build. */
async function openSteamApp() {
  hapticLight();
  for (const url of ['steam://open/main', 'steam://', 'https://s.team/']) {
    try { await Linking.openURL(url); return; } catch { /* try the next */ }
  }
}

export default function PlayTab() {
  useLockOrientation('portrait');
  const { settings } = useSettings();
  const scope = JSON.stringify([settings.host, settings.port, settings.token, settings.secure, settings.pinModulus]);
  return (
    <TabScreen>
      <Gated>
        <PlayDataProvider key={scope}><PlayScreen /></PlayDataProvider>
      </Gated>
    </TabScreen>
  );
}

function PlayScreen() {
  const { demo, setDemo, refreshAll } = usePlaySession();
  const [extras, setExtras] = useState(false);
  const [extrasY, setExtrasY] = useState<number | null>(null);
  const t = useTheme();
  const styles = useThemedStyles(makeStyles);
  const { settings, ready } = useSettings();
  const { activeBox } = useBoxes();
  const confirm = useConfirm();
  const configured = !!settings.host && !!settings.token;

  const poll = usePlayPoll<Recommendation | null>('recommend',
    () => api.recommend(settings), 60000, ready && configured, hostKey(settings));

  const d = poll.data;
  const picks: RecoPick[] = d && d.available && d.primary ? [d.primary, ...(d.alternates ?? [])] : [];
  const [sel, setSel] = useState(0);
  const hero = picks[sel] ?? picks[0];
  const [launching, setLaunching] = useState<string | null>(null);

  const alerts = usePlayPoll<SteamWishlistAlerts | null>('alerts',
    () => api.steamWishlistAlerts(settings), 300000, ready && configured, hostKey(settings));
  const [refreshing, setRefreshing] = useState(false);
  const onRefresh = async () => {
    if (refreshing) return;
    hapticLight(); setRefreshing(true);
    try { await refreshAll(); } finally { setRefreshing(false); }
  };
  useEffect(() => {
    if (demo || !ready || !configured || !alerts.data) return;
    if (alerts.data.primed === false) void api.steamWishlistAlertsAck(settings).catch(() => {});
    if (Platform.OS === 'android' && d) {
      void updateCouchsideWidget(buildWidgetPayload(d, alerts.data, Date.now())).catch(() => {});
    }
  }, [demo, ready, configured, d, alerts.data, settings]);

  // Greeting: prefer the box's most-recent Steam persona (agent >= 2.9.118), else
  // the box's name. Absent persona just falls back — probe-and-appear.
  const boxName = activeBox?.name ?? 'your box';
  const eyebrow = demo ? 'Sample gaming box · no device commands' : d?.persona ? `Ready when you are, ${d.persona}` : `On ${boxName}`;

  // Confirm first — a stray tap on a game card shouldn't yank a game onto the TV.
  const launch = async (p: RecoPick) => {
    if (launching || demo) return;
    hapticLight();
    const ok = await confirm({
      title: 'Launch on the box?',
      message: `Start "${p.name}" on ${activeBox?.name ?? 'the box'}?`,
      confirmText: 'Launch',
    });
    if (!ok) return;
    hapticMedium();
    setLaunching(p.appid);
    void api.launch(settings, `steam:${p.appid}`).finally(() => setLaunching(null));
  };

  const cover = (p: RecoPick) => api.steamCoverSource(settings, num(p.appid));

  return (
    <ScrollView showsVerticalScrollIndicator={false}
      onScroll={e => { if (extrasY !== null && e.nativeEvent.contentOffset.y + e.nativeEvent.layoutMeasurement.height + 240 >= extrasY) setExtras(true); }} scrollEventThrottle={150}
      contentContainerStyle={styles.scroll}
      refreshControl={
        <RefreshControl refreshing={refreshing} onRefresh={onRefresh}
          tintColor={t.green} colors={[t.green]} />
      }>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: 12 }}>
        <Pressable accessibilityRole="button" onPress={() => setDemo(!demo)} style={{ paddingVertical: 8 }}><Text style={{ color: t.green }}>{demo ? 'Exit demo · use my box' : 'Try Play demo'}</Text></Pressable>
        <Pressable accessibilityRole="button" disabled={refreshing} onPress={onRefresh} style={{ paddingVertical: 8 }}><Text style={{ color: t.textDim }}>{refreshing ? 'Refreshing…' : 'Refresh'}</Text></Pressable>
      </View>
      <NowPlayingCard />
      <Text style={styles.eyebrow}>{eyebrow}</Text>
      <Text style={styles.h1}>What to play next</Text>

      {!hero && <View style={[styles.hero, { minHeight: 170, padding: 20, justifyContent: 'center', gap: 10 }]}>
        {(poll.loading && (configured || demo)) ? <><ActivityIndicator color={t.green} /><Text style={{ color: t.textDim, textAlign: 'center' }}>Finding your next game…</Text></> : <>
          <Text style={styles.emptyH}>{poll.error ? 'Couldn’t load your picks' : 'No recommendations yet'}</Text>
          <Text style={styles.emptyP}>{poll.error ? 'Check your box connection, then tap Refresh. Other sections can still load.' : 'Pair your gaming box and play a few games, or try the demo above.'}</Text>
        </>}
      </View>}
      {hero && <>
      {/* HERO */}
      <Pressable disabled={demo || !!launching} onPress={() => launch(hero)} style={({ pressed }) => [styles.hero, pressed && styles.heroPress]}
        accessibilityRole="button" accessibilityLabel={`Play ${hero.name} on the box`}>
        <PlayArtwork source={cover(hero)} title={hero.name} style={styles.heroCover} />
        <View style={styles.heroVeil} />
        <View style={styles.heroTop}>
          <View style={styles.badge}><Text style={styles.badgeTxt}>{hero.tag}</Text></View>
          <View style={styles.match}><Text style={styles.matchTxt}>{Math.round(hero.score)}</Text></View>
        </View>
        <View style={styles.heroTxt}>
          <Text style={styles.heroName} numberOfLines={2}>{hero.name}</Text>
          <Text style={styles.heroReason} numberOfLines={3}>{hero.reason}</Text>
          <View style={styles.playRow}>
            <View style={styles.playBtn}>
              {launching === hero.appid
                ? <ActivityIndicator size="small" color={t.onAccent} />
                : <Text style={styles.playTxt}>{demo ? 'Demo preview' : '▶  Play on the box'}</Text>}
            </View>
          </View>
        </View>
      </Pressable>

      <Pressable accessibilityRole="button" accessibilityLabel="Show another pick" onPress={() => { hapticLight(); setSel(n => (n + 1) % picks.length); }} style={{ alignSelf: 'flex-end', paddingVertical: 12 }}><Text style={{ color: t.green }}>Another pick →</Text></Pressable>
      {/* alternates */}
      {picks.length > 1 && (
        <>
          <Text style={styles.sectionK}>More for tonight</Text>
          <ScrollView horizontal showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.rail}>
            {picks.map((p, i) => {
              const on = i === sel;
              return (
                <Pressable key={p.appid + i} onPress={() => { hapticLight(); setSel(i); }}
                  accessibilityRole="button" accessibilityLabel={`Show ${p.name}`}
                  style={({ pressed }) => [styles.alt, pressed && styles.pressed]}>
                  <View style={[styles.altArtWrap, on && { borderColor: t.green }]}>
                    <PlayArtwork source={cover(p)} title={p.name} style={styles.altArt} />
                    {on && <View style={styles.altOn}><Text style={styles.altOnTxt}>NOW SHOWING</Text></View>}
                  </View>
                  <Text style={styles.altName} numberOfLines={1}>{p.name}</Text>
                  <Text style={styles.altWhy} numberOfLines={2}>
                    <Text style={{ color: t.green }}>{p.tag}</Text>
                    {p.hours > 0 ? ` · ${p.hours}h` : ' · new'}
                  </Text>
                </Pressable>
              );
            })}
          </ScrollView>
        </>
      )}

      </>}
      <View style={{ marginTop: 18 }}><SteamProfileCard /></View>
      <WishlistAlertsBanner data={alerts.data} />
      {/* Discover — keyless in-app Steam store search. App-side + opt-in; the
          screen states searches go to Steam from the phone. Shown where the box
          has Steam (probe-and-appear like the rows below). */}
      {activeBox?.caps?.steam !== false && (
        <Pressable
          onPress={() => { hapticLight(); router.push('/discover'); }}
          accessibilityRole="button" accessibilityLabel="Search the Steam store"
          style={({ pressed }) => [styles.discover, pressed && styles.pressed]}>
          <Text style={styles.discoverTxt}>Search the Steam store</Text>
          <Text style={styles.discoverArrow}>›</Text>
        </Pressable>
      )}

      <View onLayout={e => setExtrasY(e.nativeEvent.layout.y)}>
        {extras ? <><SteamWishlistRow /><SteamDealsRow /></> : <Pressable accessibilityRole="button" onPress={() => setExtras(true)} style={{ padding: 18 }}><Text style={{ color: t.green }}>Load wishlist & deals ↓</Text></Pressable>}
      </View>
      <Text style={styles.foot}>
        Recommendations from your on-box play history · nothing leaves your network
      </Text>
      <Pressable onPress={openSteamApp}
        accessibilityRole="button" accessibilityLabel="Open the Steam app on this phone"
        style={({ pressed }) => [styles.steamBtn, pressed && styles.pressed]}>
        <Text style={styles.steamBtnTxt}>Open the Steam app  ↗</Text>
      </Pressable>
    </ScrollView>
  );
}

const makeStyles = (t: Palette) =>
  StyleSheet.create({
    scroll: { paddingHorizontal: 16, paddingTop: 8, paddingBottom: 32 },
    empty: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 32, gap: 12 },
    emptyH: { color: t.text, fontSize: 18, fontWeight: '700', fontFamily: mono, textAlign: 'center' },
    emptyP: { color: t.textDim, fontSize: 14, lineHeight: 20, textAlign: 'center' },

    eyebrow: { color: t.green, fontFamily: mono, fontSize: 12, letterSpacing: 1.5, marginBottom: 2 },
    h1: { color: t.text, fontSize: 26, fontWeight: '800', marginBottom: 16 },

    hero: {
      borderRadius: 18, overflow: 'hidden', backgroundColor: t.card,
      borderWidth: 1, borderColor: t.cardBorder, minHeight: 240, justifyContent: 'flex-end',
    },
    heroPress: { opacity: 0.9 },
    heroCover: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 },
    heroVeil: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(0,0,0,0.45)' },
    heroTop: {
      position: 'absolute', top: 12, left: 12, right: 12,
      flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    },
    badge: { backgroundColor: 'rgba(0,0,0,0.55)', borderRadius: 8, paddingHorizontal: 10, paddingVertical: 4 },
    badgeTxt: { color: t.green, fontFamily: mono, fontSize: 11, letterSpacing: 1 },
    match: {
      backgroundColor: t.green, borderRadius: 999, minWidth: 34, height: 34,
      alignItems: 'center', justifyContent: 'center', paddingHorizontal: 6,
    },
    matchTxt: { color: t.onAccent, fontWeight: '800', fontSize: 13 },
    heroTxt: { padding: 16, gap: 8 },
    heroName: { color: '#fff', fontSize: 24, fontWeight: '800' },
    heroReason: { color: 'rgba(255,255,255,0.85)', fontSize: 14, lineHeight: 20 },
    playRow: { flexDirection: 'row', marginTop: 6 },
    playBtn: {
      backgroundColor: t.green, borderRadius: 999,
      paddingVertical: 12, paddingHorizontal: 22, minWidth: 170, alignItems: 'center',
    },
    playTxt: { color: t.onAccent, fontWeight: '800', fontSize: 15 },

    sectionK: { color: t.textFaint, fontFamily: mono, fontSize: 11, letterSpacing: 1.5, marginTop: 22, marginBottom: 12 },
    rail: { gap: 12, paddingRight: 8 },
    alt: { width: 128 },
    altArtWrap: { borderRadius: 12, overflow: 'hidden', borderWidth: 2, borderColor: t.cardBorder, aspectRatio: 0.75 },
    altArt: { width: '100%', height: '100%' },
    altOn: { position: 'absolute', bottom: 0, left: 0, right: 0, backgroundColor: 'rgba(0,0,0,0.6)', paddingVertical: 3 },
    altOnTxt: { color: t.green, fontFamily: mono, fontSize: 9, letterSpacing: 1, textAlign: 'center' },
    altName: { color: t.text, fontSize: 13, fontWeight: '700', marginTop: 6 },
    altWhy: { color: t.textDim, fontSize: 11, marginTop: 2 },
    pressed: { opacity: 0.6 },

    foot: { color: t.textFaint, fontSize: 11, lineHeight: 16, marginTop: 24, textAlign: 'center' },
    steamBtn: {
      alignSelf: 'center', marginTop: 16,
      borderColor: t.cardBorder, borderWidth: 1, borderRadius: 999,
      paddingVertical: 10, paddingHorizontal: 20,
    },
    steamBtnTxt: { color: t.textDim, fontSize: 13, fontWeight: '600' },
    discover: {
      flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
      backgroundColor: t.card, borderColor: t.cardBorder, borderWidth: 1, borderRadius: 12,
      paddingVertical: 12, paddingHorizontal: 14, marginTop: 8, marginBottom: 8,
    },
    discoverTxt: { color: t.text, fontSize: 14, fontWeight: '600' },
    discoverArrow: { color: t.textDim, fontSize: 18, fontWeight: '700' },
  });
