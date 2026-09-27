/**
 * Reserve — the PROTOTYPE "what to play next" experience. A full-screen doorway
 * into the redesigned, more open/fluid Couchside look, opened from the traditional
 * app (a prototype-gated entry point) and closed again with the back chevron. The
 * traditional app is untouched; this is where the new direction is tried on device.
 *
 * It is wired to the REAL engine: GET /api/recommend ranks INSTALLED Steam games
 * from the box's local play history (agent >= 2.9.63). A pick launches through the
 * existing Steam path — api.launch(settings, `steam:${appid}`) -> steam://rungameid.
 *
 * Gated to prototype builds by the caller (IS_PROTOTYPE_BUILD); this file assumes
 * it is only ever routed to from one. No agent change. Portrait-locked.
 */
import { Stack, router } from 'expo-router';
import React, { useState } from 'react';
import {
  ActivityIndicator, Image, Pressable, ScrollView, StyleSheet, Text, View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { usePoll } from '@/hooks/usePoll';
import { useLockOrientation } from '@/hooks/useLockOrientation';
import { api, hostKey, type Recommendation, type RecoPick } from '@/lib/api';
import { hapticLight, hapticMedium } from '@/lib/haptics';
import { useSettings } from '@/lib/SettingsContext';
import { mono, useTheme, useThemedStyles, type Palette } from '@/lib/theme';

const num = (s: string) => { const n = parseInt(s, 10); return Number.isFinite(n) ? n : 0; };

export default function Reserve() {
  useLockOrientation('portrait');
  const t = useTheme();
  const styles = useThemedStyles(makeStyles);
  const insets = useSafeAreaInsets();
  const { settings, ready } = useSettings();
  const configured = !!settings.host && !!settings.token;

  const poll = usePoll<Recommendation | null>(
    () => api.recommend(settings), 60000, ready && configured, hostKey(settings));

  const d = poll.data;
  const picks: RecoPick[] = d && d.available && d.primary ? [d.primary, ...(d.alternates ?? [])] : [];
  const [sel, setSel] = useState(0);
  const hero = picks[sel] ?? picks[0];
  const [launching, setLaunching] = useState<string | null>(null);

  const launch = async (p: RecoPick) => {
    if (launching) return;
    hapticMedium();
    setLaunching(p.appid);
    try { await api.launch(settings, `steam:${p.appid}`); }
    finally { setLaunching(null); }
  };

  const cover = (p: RecoPick) => api.steamCoverSource(settings, num(p.appid));

  return (
    <View style={[styles.root, { paddingTop: insets.top }]}>
      <Stack.Screen options={{ headerShown: false, animation: 'slide_from_bottom' }} />

      {/* ambient wash */}
      <View pointerEvents="none" style={styles.wash} />

      {/* top bar */}
      <View style={styles.topbar}>
        <Pressable onPress={() => { hapticLight(); router.back(); }} hitSlop={12}
          accessibilityRole="button" accessibilityLabel="Close"
          style={({ pressed }) => [styles.close, pressed && styles.pressed]}>
          <Text style={styles.closeIco}>‹</Text>
        </Pressable>
        <Text style={styles.wordmark}>COUCHSIDE</Text>
        <View style={styles.protoBadge}><Text style={styles.protoTxt}>PROTOTYPE</Text></View>
      </View>

      {!hero ? (
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
      ) : (
        <ScrollView showsVerticalScrollIndicator={false}
          contentContainerStyle={{ paddingBottom: insets.bottom + 28 }}>
          <Text style={styles.eyebrow}>Tonight, on steam-machine</Text>
          <Text style={styles.h1}>What to play next</Text>

          {/* HERO */}
          <Pressable onPress={() => launch(hero)} style={({ pressed }) => [styles.hero, pressed && styles.heroPress]}>
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
      )}
    </View>
  );
}

const makeStyles = (t: Palette) =>
  StyleSheet.create({
    root: { flex: 1, backgroundColor: t.bg },
    wash: {
      position: 'absolute', top: 0, left: 0, right: 0, height: 320,
      backgroundColor: t.green, opacity: 0.06,
    },
    pressed: { opacity: 0.6 },

    topbar: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, height: 52 },
    close: { width: 40, height: 40, borderRadius: 12, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: t.cardBorder, backgroundColor: t.card },
    closeIco: { color: t.text, fontSize: 28, lineHeight: 30, marginTop: -3 },
    wordmark: { color: t.textDim, fontFamily: mono, fontSize: 12, letterSpacing: 4, fontWeight: '700' },
    protoBadge: { paddingHorizontal: 9, paddingVertical: 5, borderRadius: 999, backgroundColor: 'rgba(251,191,36,0.14)', borderWidth: 1, borderColor: 'rgba(251,191,36,0.4)' },
    protoTxt: { color: t.amber, fontFamily: mono, fontSize: 9, letterSpacing: 1.5, fontWeight: '700' },

    empty: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 40, gap: 12 },
    emptyH: { color: t.text, fontSize: 20, fontWeight: '800', textAlign: 'center' },
    emptyP: { color: t.textDim, fontSize: 14, lineHeight: 21, textAlign: 'center', maxWidth: 320 },

    eyebrow: { color: t.green, fontFamily: mono, fontSize: 11, letterSpacing: 2, textTransform: 'uppercase', paddingHorizontal: 22, marginTop: 8 },
    h1: { color: t.text, fontSize: 30, fontWeight: '800', letterSpacing: -0.5, paddingHorizontal: 22, marginTop: 4 },

    hero: { marginHorizontal: 16, marginTop: 18, borderRadius: 26, overflow: 'hidden', borderWidth: 1, borderColor: t.cardBorder,
      shadowColor: '#000', shadowOpacity: 0.5, shadowRadius: 24, shadowOffset: { width: 0, height: 16 } },
    heroPress: { opacity: 0.94 },
    heroCover: { width: '100%', aspectRatio: 16 / 10, backgroundColor: t.card },
    heroVeil: { position: 'absolute', left: 0, right: 0, bottom: 0, height: '72%', backgroundColor: t.bg, opacity: 0.0 },
    heroTop: { position: 'absolute', top: 14, left: 14, right: 14, flexDirection: 'row', justifyContent: 'space-between' },
    badge: { backgroundColor: t.green, paddingHorizontal: 11, paddingVertical: 6, borderRadius: 999 },
    badgeTxt: { color: t.onGreen, fontFamily: mono, fontSize: 10.5, letterSpacing: 1, fontWeight: '700', textTransform: 'uppercase' },
    match: { backgroundColor: 'rgba(7,13,24,0.55)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.14)', paddingHorizontal: 10, paddingVertical: 6, borderRadius: 999 },
    matchTxt: { color: t.text, fontFamily: mono, fontSize: 12, fontWeight: '700' },
    heroTxt: { position: 'absolute', left: 0, right: 0, bottom: 0, padding: 18, backgroundColor: 'rgba(7,13,24,0.82)' },
    heroName: { color: t.text, fontSize: 26, fontWeight: '800', letterSpacing: -0.6 },
    heroReason: { color: t.textDim, fontSize: 14, lineHeight: 20, marginTop: 8 },
    playRow: { marginTop: 16 },
    playBtn: { backgroundColor: t.green, borderRadius: 14, paddingVertical: 14, alignItems: 'center' },
    playTxt: { color: t.onGreen, fontSize: 15, fontWeight: '700' },

    sectionK: { color: t.textFaint, fontFamily: mono, fontSize: 11, letterSpacing: 2, textTransform: 'uppercase', paddingHorizontal: 22, marginTop: 26, marginBottom: 12 },
    rail: { paddingHorizontal: 16, gap: 12 },
    alt: { width: 138 },
    altArtWrap: { borderRadius: 16, overflow: 'hidden', borderWidth: 1.5, borderColor: t.cardBorder, backgroundColor: t.card },
    altArt: { width: '100%', aspectRatio: 3 / 4 },
    altOn: { position: 'absolute', top: 8, left: 8, backgroundColor: t.green, paddingHorizontal: 7, paddingVertical: 3, borderRadius: 999 },
    altOnTxt: { color: t.onGreen, fontFamily: mono, fontSize: 8, letterSpacing: 0.8, fontWeight: '700' },
    altName: { color: t.text, fontSize: 14, fontWeight: '700', marginTop: 10 },
    altWhy: { color: t.textFaint, fontFamily: mono, fontSize: 10.5, marginTop: 4, lineHeight: 15 },

    foot: { color: t.textFaint, fontFamily: mono, fontSize: 10, textAlign: 'center', paddingHorizontal: 24, marginTop: 28, lineHeight: 15 },
  });
