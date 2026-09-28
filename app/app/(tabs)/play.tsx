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
import { ActivityIndicator, Image, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';

import { Gated } from '@/components/Gated';
import { TabScreen } from '@/components/TabScreen';
import { useLockOrientation } from '@/hooks/useLockOrientation';
import { usePoll } from '@/hooks/usePoll';
import { api, hostKey, type Recommendation, type RecoPick } from '@/lib/api';
import { hapticLight, hapticMedium } from '@/lib/haptics';
import { useBoxes, useSettings } from '@/lib/SettingsContext';
import { mono, useTheme, useThemedStyles, type Palette } from '@/lib/theme';

const num = (s: string) => { const n = parseInt(s, 10); return Number.isFinite(n) ? n : 0; };

export default function PlayTab() {
  useLockOrientation('portrait');
  return (
    <TabScreen>
      <Gated>
        <PlayScreen />
      </Gated>
    </TabScreen>
  );
}

function PlayScreen() {
  const t = useTheme();
  const styles = useThemedStyles(makeStyles);
  const { settings, ready } = useSettings();
  const { activeBox } = useBoxes();
  const configured = !!settings.host && !!settings.token;

  const poll = usePoll<Recommendation | null>(
    () => api.recommend(settings), 60000, ready && configured, hostKey(settings));

  const d = poll.data;
  const picks: RecoPick[] = d && d.available && d.primary ? [d.primary, ...(d.alternates ?? [])] : [];
  const [sel, setSel] = useState(0);
  const hero = picks[sel] ?? picks[0];
  const [launching, setLaunching] = useState<string | null>(null);

  // Pull-to-refresh: re-fetch the picks AND advance which one leads. The engine
  // is deterministic, so a bare refetch would show the same hero; rotating `sel`
  // means "none of these appeal — show me the next candidate" actually surfaces a
  // different game, wrapping through the pool.
  const [refreshing, setRefreshing] = useState(false);
  const onRefresh = useCallback(() => {
    hapticLight();
    setSel((s) => (picks.length ? (s + 1) % picks.length : 0));
    setRefreshing(true);
    poll.refresh();
  }, [picks.length, poll]);
  // End the spinner once the refetch settles.
  useEffect(() => {
    if (refreshing && !poll.loading) setRefreshing(false);
  }, [refreshing, poll.loading]);

  // Greeting: prefer the box's most-recent Steam persona (agent >= 2.9.118), else
  // the box's name. Absent persona just falls back — probe-and-appear.
  const boxName = activeBox?.name ?? 'your box';
  const eyebrow = d?.persona ? `Evening, ${d.persona}` : `Tonight on ${boxName}`;

  const launch = async (p: RecoPick) => {
    if (launching) return;
    hapticMedium();
    setLaunching(p.appid);
    try { await api.launch(settings, `steam:${p.appid}`); }
    finally { setLaunching(null); }
  };

  const cover = (p: RecoPick) => api.steamCoverSource(settings, num(p.appid));

  if (!hero) {
    return (
      <View style={styles.empty}>
        {poll.loading && !d ? (
          <ActivityIndicator color={t.green} />
        ) : (
          <>
            <Text style={styles.emptyH}>Nothing to recommend yet</Text>
            <Text style={styles.emptyP}>
              Play a few games on your box and Couchside will learn what to line up next —
              straight from your on-box history, nothing leaves your network.
            </Text>
          </>
        )}
      </View>
    );
  }

  return (
    <ScrollView showsVerticalScrollIndicator={false}
      contentContainerStyle={styles.scroll}
      refreshControl={
        <RefreshControl refreshing={refreshing} onRefresh={onRefresh}
          tintColor={t.green} colors={[t.green]} />
      }>
      <Text style={styles.eyebrow}>{eyebrow}</Text>
      <Text style={styles.h1}>What to play next</Text>

      {/* HERO */}
      <Pressable onPress={() => launch(hero)} style={({ pressed }) => [styles.hero, pressed && styles.heroPress]}
        accessibilityRole="button" accessibilityLabel={`Play ${hero.name} on the box`}>
        <Image source={cover(hero)} style={styles.heroCover} resizeMode="cover" />
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
                : <Text style={styles.playTxt}>▶  Play on the box</Text>}
            </View>
          </View>
        </View>
      </Pressable>

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
                    <Image source={cover(p)} style={styles.altArt} resizeMode="cover" />
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

      <Text style={styles.foot}>
        Recommendations from your on-box play history · nothing leaves your network
      </Text>
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
      borderWidth: 1, borderColor: t.cardBorder, minHeight: 300, justifyContent: 'flex-end',
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
  });
