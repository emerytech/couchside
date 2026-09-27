/**
 * PrototypeHome — the PROTOTYPE's front door: the "what to play next" experience
 * promoted from a doorway (app/reserve.tsx) into the app's HOME tab. Rendered in
 * place of the ops Console ONLY in the prototype build (index.tsx gates it on
 * IS_PROTOTYPE_BUILD); production still lands on ConsoleScreen.
 *
 * It is wired to the REAL engine — GET /api/recommend ranks INSTALLED Steam games
 * from the box's LOCAL play history (agent >= 2.9.63) — and a pick launches through
 * the existing Steam path (api.launch -> steam://rungameid). No agent change; no
 * cover-art fetch and no new native dep — each game's colour is derived
 * deterministically from its appid (a stand-in until the agent can hand back a real
 * art colour), so the look is dependency-free and offline.
 *
 * CRASH DISCIPLINE (learned the hard way this cycle): every /api/status field read
 * here is optional-chained — a partial payload from a box mid-restart must never
 * throw. See the Console's status gate for the same rule.
 */
import { LinearGradient } from 'expo-linear-gradient';
import { router } from 'expo-router';
import React, { useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { usePoll } from '@/hooks/usePoll';
import {
  api, hostKey, type ConnSettings, type Recommendation, type RecoPick, type Status,
} from '@/lib/api';
import { hapticLight, hapticMedium } from '@/lib/haptics';
import { useBoxOnlineStatus, useBoxes, useSettings } from '@/lib/SettingsContext';
import { mono, useTheme, useThemedStyles, type Palette } from '@/lib/theme';

const num = (s: string): number => { const n = parseInt(s, 10); return Number.isFinite(n) ? n : 0; };
const clamp = (n: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, n));

/** Time-of-day greeting. In-app only (workflow scripts can't call Date, the app can). */
function greeting(): string {
  const h = new Date().getHours();
  if (h < 5) return 'Up late';
  if (h < 12) return 'Good morning';
  if (h < 17) return 'Good afternoon';
  if (h < 22) return 'Good evening';
  return 'Winding down';
}

/** A stable hue 0..360 from an appid, so each game keeps ONE colour across renders. */
function hueOf(appid: string): number {
  let h = 0;
  for (let i = 0; i < appid.length; i += 1) h = (h * 31 + appid.charCodeAt(i)) % 360;
  return h;
}
/** A per-game gradient — bright top-left → dark bottom-right, derived from the appid so
 *  each game keeps ONE look. Rich but dark enough that white text sits on it directly.
 *  (A stand-in for a real art-derived colour until the agent can hand one back.) */
const gameGradient = (appid: string): readonly [string, string, string] => {
  const h = hueOf(appid);
  return [`hsl(${h}, 64%, 44%)`, `hsl(${h}, 56%, 30%)`, `hsl(${h}, 52%, 19%)`];
};
const GRAD_START = { x: 0, y: 0 } as const;
const GRAD_END = { x: 1, y: 1 } as const;

/** How the days-since number reads as a phrase. */
function lastPlayed(days: number | null): string | null {
  if (days == null) return null;
  if (days <= 0) return 'last played today';
  if (days === 1) return 'last played yesterday';
  if (days < 7) return `last played ${days} days ago`;
  if (days < 14) return 'last played last week';
  if (days < 60) return `dropped ${Math.round(days / 7)} wks ago`;
  return `${Math.round(days / 30)} mo since you played`;
}

/** The short caption under an alternate tile: bucket + the most telling stat. */
function altCaption(p: RecoPick): string {
  const bits: string[] = [];
  if (p.hours > 0) bits.push(`${p.hours}h`);
  const lp = lastPlayed(p.days_since);
  if (lp) bits.push(lp.replace('last played ', ''));
  else if (p.hours === 0) bits.push('never played');
  return bits.join(' · ');
}

export function PrototypeHome() {
  const t = useTheme();
  const styles = useThemedStyles(makeStyles);
  const insets = useSafeAreaInsets();
  const { settings, ready } = useSettings();
  const { activeBox } = useBoxes();
  const configured = !!settings.host && !!settings.token;
  // Same lightweight /api/ping signal the top-bar chip uses, so the header dot never
  // disagrees with it (and it keeps flapping-detection off the heavy /api/status poll).
  const onlineMap = useBoxOnlineStatus(activeBox ? [activeBox] : [], { intervalMs: 8000 });
  const boxOnline = configured && !!activeBox && onlineMap[activeBox.id] === 'reachable';

  const reco = usePoll<Recommendation | null>(
    () => api.recommend(settings), 60000, ready && configured, hostKey(settings));
  const status = usePoll<Status>(
    () => api.status(settings), 5000, ready && configured, hostKey(settings));

  const d = reco.data;
  const picks: RecoPick[] = d && d.available && d.primary ? [d.primary, ...(d.alternates ?? [])] : [];
  const hero = picks[0];
  const alternates = picks.slice(1);
  const persona = d?.persona?.trim() || null;
  const [launching, setLaunching] = useState<string | null>(null);

  // Header facts — every field optional-chained; a partial status must not throw.
  const s = status.data;
  const host = activeBox?.name || s?.hostname || settings.host || 'your box';
  const tempC = s?.cpu_temp_c ?? null;
  // FLAKY-LINK UX: usePoll keeps the last-good data on a later error, so `picks` stay
  // put through a drop. When the box is not confirmed up right now but we still have
  // picks to show, say "reconnecting…" over the STALE picks instead of blanking to
  // OFFLINE — much calmer on a marginal link than the content vanishing every dip.
  const reconnecting = configured && !boxOnline && picks.length > 0;
  const dotColor = boxOnline ? t.green : reconnecting ? t.amber : t.red;
  const headline = useMemo(() => {
    if (boxOnline) {
      const bits = ['ONLINE'];
      if (tempC != null) bits.push(`${Math.round(tempC)}°`);
      return bits.join('  ·  ');
    }
    return reconnecting ? 'RECONNECTING…' : 'OFFLINE';
  }, [boxOnline, tempC, reconnecting]);

  const launch = async (p: RecoPick): Promise<void> => {
    if (launching) return;
    hapticMedium();
    setLaunching(p.appid);
    try { await api.launch(settings, `steam:${p.appid}`); }
    finally { setLaunching(null); }
  };

  return (
    <ScrollView
      style={styles.root}
      showsVerticalScrollIndicator={false}
      contentContainerStyle={{ paddingTop: insets.top + 8, paddingBottom: insets.bottom + 28 }}>
      {/* ambient wash */}
      <View pointerEvents="none" style={styles.wash} />

      {/* compact status header */}
      <View style={styles.header}>
        <View style={styles.headerLeft}>
          <View style={[styles.statusDot, { backgroundColor: dotColor }]}>
            <View style={[styles.statusHalo, { backgroundColor: dotColor }]} />
          </View>
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text style={styles.host} numberOfLines={1}>{host}</Text>
            <Text style={styles.headline} numberOfLines={1}>{headline}</Text>
          </View>
        </View>
        {/* Settings lives on the always-visible gear in the global top bar
            (BoxSwitcher), so the Home header no longer carries its own. */}
      </View>

      {/* greeting + hero title */}
      <Text style={styles.greeting}>
        {(persona ? `${greeting()}, ${persona}` : greeting()).toUpperCase()}
      </Text>
      <Text style={styles.h1}>What to play next</Text>

      {!hero ? (
        <View style={styles.empty}>
          {reco.loading && !d ? (
            <ActivityIndicator color={t.green} />
          ) : (
            <>
              <Text style={styles.emptyH}>Nothing to line up yet</Text>
              <Text style={styles.emptyP}>
                Play a few games on {host} and Couchside will learn what to queue next — straight
                from your on-box history, nothing leaves your network.
              </Text>
            </>
          )}
        </View>
      ) : (
        <>
          {/* HERO PICK */}
          <Pressable
            onPress={() => launch(hero)}
            style={({ pressed }) => [styles.hero, pressed && styles.heroPress]}>
            <LinearGradient
              colors={gameGradient(hero.appid)}
              start={GRAD_START}
              end={GRAD_END}
              style={StyleSheet.absoluteFill}
              pointerEvents="none"
            />
            <View style={styles.heroTopRow}>
              <View style={styles.pickPill}><Text style={styles.pickPillTxt}>TONIGHT'S PICK</Text></View>
              <View style={styles.matchPill}>
                <Text style={styles.matchTxt}>{clamp(Math.round(hero.score), 1, 99)}% match</Text>
              </View>
            </View>
            <Text style={styles.heroName} numberOfLines={2}>{hero.name}</Text>
            <Text style={styles.heroReason} numberOfLines={4}>{hero.reason}</Text>
            <View style={styles.tagRow}>
              <View style={[styles.tag, styles.tagStreak]}>
                <Text style={styles.tagStreakTxt}>{hero.bucket === 'streak' ? '▲ ' : ''}{hero.tag}</Text>
              </View>
              {hero.hours > 0 && (
                <View style={styles.tag}><Text style={styles.tagTxt}>{hero.hours}h played</Text></View>
              )}
              {lastPlayed(hero.days_since) && (
                <View style={styles.tag}><Text style={styles.tagTxt}>{lastPlayed(hero.days_since)}</Text></View>
              )}
            </View>
            <View style={styles.playBtn}>
              {launching === hero.appid
                ? <ActivityIndicator size="small" color={t.onGreen} />
                : <Text style={styles.playTxt}>▶  Play on the box</Text>}
            </View>
          </Pressable>

          {/* alternates */}
          {alternates.length > 0 && (
            <>
              <View style={styles.sectionRow}>
                <Text style={styles.sectionK}>Because you've got the evening</Text>
                <Pressable onPress={() => { hapticLight(); router.push('/reserve'); }} hitSlop={8}>
                  <Text style={styles.seeAnalysis}>See analysis →</Text>
                </Pressable>
              </View>
              <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.rail}>
                {alternates.map((p, i) => (
                  <Pressable
                    key={p.appid + i}
                    onPress={() => launch(p)}
                    style={({ pressed }) => [styles.alt, pressed && styles.pressed]}>
                    <View style={styles.altArt}>
                      <LinearGradient
                        colors={gameGradient(p.appid)}
                        start={GRAD_START}
                        end={GRAD_END}
                        style={StyleSheet.absoluteFill}
                        pointerEvents="none"
                      />
                      <Text style={styles.altName} numberOfLines={2}>{p.name}</Text>
                    </View>
                    <Text style={styles.altBucket} numberOfLines={1}>{p.tag}</Text>
                    <Text style={styles.altCaption} numberOfLines={2}>{altCaption(p)}</Text>
                  </Pressable>
                ))}
              </ScrollView>
            </>
          )}

          {/* your week — a light stat strip from what the ranking already knows */}
          <Text style={styles.sectionK}>Your week</Text>
          <View style={styles.weekRow}>
            <Stat styles={styles} value={String(picks.length)} label="ready to play" />
            <Stat styles={styles} value={hero.hours > 0 ? `${Math.round(hero.hours)}h` : '—'} label="on your top pick" />
            <Stat
              styles={styles}
              value={hero.days_since != null ? (hero.days_since <= 0 ? 'today' : `${hero.days_since}d`) : '—'}
              label="since last run"
            />
          </View>

          <Text style={styles.foot}>
            Recommendations from your on-box play history · nothing leaves your network
          </Text>
        </>
      )}
    </ScrollView>
  );
}

function Stat({ styles, value, label }: { styles: ReturnType<typeof makeStyles>; value: string; label: string }) {
  return (
    <View style={styles.stat}>
      <Text style={styles.statValue}>{value}</Text>
      <Text style={styles.statLabel}>{label}</Text>
    </View>
  );
}

const makeStyles = (t: Palette) =>
  StyleSheet.create({
    root: { flex: 1, backgroundColor: t.bg },
    wash: {
      position: 'absolute', top: 0, left: 0, right: 0, height: 380,
      backgroundColor: t.green, opacity: 0.06,
      borderBottomLeftRadius: 240, borderBottomRightRadius: 240,
    },
    pressed: { opacity: 0.85 },

    header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 22, marginTop: 4 },
    headerLeft: { flexDirection: 'row', alignItems: 'center', gap: 12, flex: 1, minWidth: 0 },
    statusDot: { width: 12, height: 12, borderRadius: 6, alignItems: 'center', justifyContent: 'center' },
    statusHalo: { position: 'absolute', width: 22, height: 22, borderRadius: 11, opacity: 0.22 },
    host: { color: t.text, fontFamily: mono, fontSize: 18, fontWeight: '700', letterSpacing: -0.2 },
    headline: { color: t.textFaint, fontFamily: mono, fontSize: 11, fontWeight: '600', letterSpacing: 1.5, marginTop: 2 },
    headerBtn: { width: 44, height: 44, borderRadius: 14, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: t.cardBorder, backgroundColor: t.card },
    headerBtnIco: { color: t.textDim, fontSize: 20, lineHeight: 22 },

    greeting: { color: t.textFaint, fontFamily: mono, fontSize: 12, letterSpacing: 3, paddingHorizontal: 22, marginTop: 26 },
    h1: { color: t.text, fontSize: 34, fontWeight: '800', letterSpacing: -0.8, paddingHorizontal: 22, marginTop: 6 },

    empty: { alignItems: 'center', justifyContent: 'center', padding: 40, gap: 12, marginTop: 40 },
    emptyH: { color: t.text, fontSize: 20, fontWeight: '800', textAlign: 'center' },
    emptyP: { color: t.textDim, fontSize: 14, lineHeight: 21, textAlign: 'center', maxWidth: 340 },

    hero: {
      marginHorizontal: 16, marginTop: 20, borderRadius: 26, padding: 22, overflow: 'hidden',
      boxShadow: '0 16px 40px rgba(0,0,0,0.45)',
    },
    heroPress: { opacity: 0.96 },
    // a hairline top highlight — "lit from above" with no hard seam.
    cardEdge: { position: 'absolute', top: 0, left: 0, right: 0, height: 2, opacity: 0.6 },
    heroTopRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
    pickPill: { backgroundColor: t.green, paddingHorizontal: 13, paddingVertical: 7, borderRadius: 999 },
    pickPillTxt: { color: t.onGreen, fontFamily: mono, fontSize: 11, fontWeight: '800', letterSpacing: 1 },
    matchPill: { backgroundColor: 'rgba(7,13,24,0.5)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.16)', paddingHorizontal: 11, paddingVertical: 7, borderRadius: 999 },
    matchTxt: { color: '#fff', fontFamily: mono, fontSize: 12, fontWeight: '700' },
    heroName: { color: '#fff', fontSize: 38, fontWeight: '800', letterSpacing: -1, marginTop: 16, lineHeight: 42 },
    heroReason: { color: 'rgba(255,255,255,0.86)', fontSize: 16, lineHeight: 24, marginTop: 12 },
    tagRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginTop: 18 },
    tag: { backgroundColor: 'rgba(255,255,255,0.10)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.16)', paddingHorizontal: 13, paddingVertical: 8, borderRadius: 999 },
    tagTxt: { color: 'rgba(255,255,255,0.9)', fontFamily: mono, fontSize: 12.5, fontWeight: '600' },
    tagStreak: { backgroundColor: 'rgba(251,191,36,0.14)', borderColor: 'rgba(251,191,36,0.5)' },
    tagStreakTxt: { color: t.amber, fontFamily: mono, fontSize: 12.5, fontWeight: '700' },
    playBtn: { backgroundColor: t.green, borderRadius: 16, paddingVertical: 16, alignItems: 'center', marginTop: 22 },
    playTxt: { color: t.onGreen, fontSize: 16, fontWeight: '800' },

    sectionRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 22, marginTop: 30 },
    sectionK: { color: t.textFaint, fontFamily: mono, fontSize: 12, letterSpacing: 2.5, textTransform: 'uppercase', paddingHorizontal: 22, marginTop: 30 },
    seeAnalysis: { color: t.accent, fontSize: 15, fontWeight: '700' },
    rail: { paddingHorizontal: 16, paddingTop: 14, gap: 14 },
    alt: { width: 168 },
    altArt: { width: 168, height: 224, borderRadius: 20, padding: 14, justifyContent: 'flex-end', overflow: 'hidden' },
    altName: { color: '#fff', fontSize: 18, fontWeight: '800', letterSpacing: -0.4 },
    altBucket: { color: t.green, fontFamily: mono, fontSize: 11.5, fontWeight: '700', marginTop: 12 },
    altCaption: { color: t.textFaint, fontFamily: mono, fontSize: 11.5, marginTop: 3, lineHeight: 16 },

    weekRow: { flexDirection: 'row', gap: 12, paddingHorizontal: 16, marginTop: 14 },
    stat: { flex: 1, backgroundColor: t.card, borderWidth: 1, borderColor: t.cardBorder, borderRadius: 18, paddingVertical: 16, paddingHorizontal: 14 },
    statValue: { color: t.text, fontSize: 24, fontWeight: '800', letterSpacing: -0.6 },
    statLabel: { color: t.textFaint, fontFamily: mono, fontSize: 10.5, letterSpacing: 0.5, marginTop: 4, lineHeight: 14 },

    foot: { color: t.textFaint, fontFamily: mono, fontSize: 10.5, textAlign: 'center', paddingHorizontal: 24, marginTop: 30, lineHeight: 16 },
  });
