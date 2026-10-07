import { blockTabSwipe } from '@/lib/tabSwipe';
/**
 * The owner's live Steam profile + whole-library snapshot, shown at the top of the
 * Play tab when a Steam Web API key is connected (agent >= 2.9.120). Avatar, name,
 * online state / what they're playing (even on another device), Steam level, and a
 * library stat line (games, hours, most-played, backlog) + a recently-played rail.
 *
 * Probe-and-appear: renders nothing unless the profile endpoint reports
 * configured + connected, so it's invisible for anyone who hasn't opted in or on an
 * older agent. Reads only the user's own public Steam data.
 */
import React, { useState } from 'react';
import { Pressable, Image, ScrollView, StyleSheet, Text, View } from 'react-native';

import { usePlayPoll, usePlaySession } from '@/hooks/usePlayPoll';
import { PlayArtwork } from './PlayArtwork';
import { api, hostKey, type SteamAchievements, type SteamLibrary, type SteamProfile } from '@/lib/api';
import { useSettings } from '@/lib/SettingsContext';
import { mono, useTheme, useThemedStyles, type Palette } from '@/lib/theme';

const num = (s: string) => { const n = parseInt(s, 10); return Number.isFinite(n) ? n : 0; };
const fmtHours = (h?: number | null) => {
  if (h == null) return '—';
  if (h >= 100) return `${Math.round(h)}h`;
  return `${h.toFixed(1)}h`;
};

export function SteamProfileCard() {
  const [expanded, setExpanded] = useState(false);
  const { demo } = usePlaySession();
  const t = useTheme();
  const styles = useThemedStyles(makeStyles);
  const { settings, ready } = useSettings();
  const configured = !!settings.host && !!settings.token;

  const profile = usePlayPoll<SteamProfile | null>('profile',
    () => api.steamProfile(settings), 60000, ready && configured, hostKey(settings));
  const library = usePlayPoll<SteamLibrary | null>('library',
    () => api.steamLibrary(settings), 600000, ready && configured && expanded, hostKey(settings));
  // Achievement progress for the game being played right now, if any.
  const gameid = profile.data?.gameid;
  const ach = usePlayPoll<SteamAchievements | null>('achievements',
    () => (gameid ? api.steamAchievements(settings, gameid) : Promise.resolve(null)),
    60000, ready && configured && !!gameid && expanded, `${hostKey(settings)}:ach:${gameid ?? ''}`);

  const p = profile.data;
  // Probe-and-appear: only when a key is set AND Steam answered.
  if (!p || !p.configured || !p.connected) return null;

  const lib = library.data && library.data.configured && library.data.connected ? library.data : null;
  const a = ach.data && ach.data.connected && ach.data.has_achievements ? ach.data : null;
  const cover = (appid: string) => api.steamCoverSource(settings, num(appid));
  const stateLine = p.playing ? `Playing ${p.playing}` : (p.state ?? 'Online');
  const online = !!p.playing || (p.state_code != null && p.state_code !== 0);

  return (
    <View style={styles.card}>
      <View style={styles.headRow}>
        {p.avatar && !demo ? (
          <Image source={{ uri: p.avatar }} style={styles.avatar} />
        ) : (
          <View style={[styles.avatar, styles.avatarFallback]} />
        )}
        <View style={{ flex: 1 }}>
          <View style={styles.nameRow}>
            <Text style={styles.persona} numberOfLines={1}>{p.persona ?? 'Steam'}</Text>
            {p.level != null && (
              <View style={styles.levelPill}><Text style={styles.levelTxt}>{p.level}</Text></View>
            )}
          </View>
          <View style={styles.stateRow}>
            <View style={[styles.dot, { backgroundColor: p.playing ? t.green : online ? t.blue : t.slate }]} />
            <Text style={[styles.state, p.playing && { color: t.green }]} numberOfLines={1}>{stateLine}</Text>
          </View>
        </View>
      </View>

      <Pressable onPress={() => setExpanded(v => !v)} accessibilityRole="button" accessibilityLabel={expanded ? "Hide Steam stats" : "Show Steam stats"} accessibilityState={{ expanded }} style={{ paddingTop: 10, paddingBottom: 4 }}><Text style={{ color: t.green, fontWeight: '600' }}>{expanded ? "Hide stats ↑" : "Stats & achievements ↓"}</Text></Pressable>
      {expanded && a && (
        <View style={styles.achRow}>
          <View style={styles.achBar}>
            <View style={[styles.achFill, { width: `${Math.max(2, Math.min(100, a.percent ?? 0))}%` }]} />
          </View>
          <Text style={styles.achTxt} numberOfLines={1}>
            {a.unlocked}/{a.total} achievements
            {a.rarest ? <Text style={styles.achRare}>  ·  rarest {a.rarest.name} ({a.rarest.global_pct}%)</Text> : null}
          </Text>
        </View>
      )}

      {expanded && lib && (
        <>
          <View style={styles.statsRow}>
            <Stat styles={styles} label="GAMES" value={String(lib.count ?? 0)} />
            <Stat styles={styles} label="HOURS" value={fmtHours(lib.total_hours)} />
            <Stat styles={styles} label="BACKLOG" value={String(lib.backlog ?? 0)} />
            <Stat styles={styles} label="2 WEEKS" value={fmtHours(lib.hours_2weeks)} />
          </View>
          {(lib.played_7d != null || lib.played_30d != null) && (
            <Text style={styles.trendLine}>
              Played <Text style={styles.trendVal}>{fmtHours(lib.played_7d)}</Text> this week
              {'  ·  '}
              <Text style={styles.trendVal}>{fmtHours(lib.played_30d)}</Text> this month
            </Text>
          )}
          {lib.top && (
            <Text style={styles.topLine} numberOfLines={1}>
              Most played: <Text style={styles.topName}>{lib.top.name}</Text> · {fmtHours(lib.top.hours)}
            </Text>
          )}
          {lib.recent && lib.recent.length > 0 && (
            <>
              <Text style={styles.railLabel}>JUMP BACK IN</Text>
              <ScrollView onTouchStart={blockTabSwipe} horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.rail}>
                {lib.recent.map((g) => (
                  <View key={g.appid} style={styles.recentItem}>
                    <PlayArtwork source={cover(g.appid)} title={g.name} style={styles.recentArt} />
                    <Text style={styles.recentName} numberOfLines={1}>{g.name}</Text>
                    <Text style={styles.recentHours}>{fmtHours(g.hours)} · 2 wks</Text>
                  </View>
                ))}
              </ScrollView>
            </>
          )}
        </>
      )}
    </View>
  );
}

function Stat({ styles, label, value }: { styles: any; label: string; value: string }) {
  return (
    <View style={styles.stat}>
      <Text style={styles.statLabel}>{label}</Text>
      <Text style={styles.statValue}>{value}</Text>
    </View>
  );
}

const makeStyles = (t: Palette) =>
  StyleSheet.create({
    card: {
      backgroundColor: t.card, borderColor: t.cardBorder, borderWidth: 1,
      borderRadius: 14, padding: 14, marginBottom: 16,
    },
    headRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
    avatar: { width: 52, height: 52, borderRadius: 10, backgroundColor: t.bg },
    avatarFallback: { borderColor: t.cardBorder, borderWidth: 1 },
    nameRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
    persona: { color: t.text, fontSize: 18, fontWeight: '800', flexShrink: 1 },
    levelPill: {
      backgroundColor: t.bg, borderColor: t.cardBorder, borderWidth: 1,
      borderRadius: 999, paddingHorizontal: 8, paddingVertical: 1,
    },
    levelTxt: { color: t.textDim, fontFamily: mono, fontSize: 11, fontWeight: '700' },
    stateRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 3 },
    dot: { width: 8, height: 8, borderRadius: 4 },
    state: { color: t.textDim, fontSize: 13, flexShrink: 1 },
    statsRow: { flexDirection: 'row', marginTop: 14, gap: 8 },
    stat: { flex: 1 },
    statLabel: { color: t.textFaint, fontFamily: mono, fontSize: 9, letterSpacing: 1 },
    statValue: { color: t.text, fontSize: 18, fontWeight: '800', marginTop: 2 },
    achRow: { marginTop: 12, gap: 6 },
    achBar: { height: 5, borderRadius: 3, backgroundColor: t.bg, overflow: 'hidden' },
    achFill: { height: 5, borderRadius: 3, backgroundColor: t.green },
    achTxt: { color: t.textDim, fontSize: 12 },
    achRare: { color: t.green },
    topLine: { color: t.textDim, fontSize: 12, marginTop: 12 },
    topName: { color: t.text, fontWeight: '700' },
    trendLine: { color: t.textDim, fontSize: 12, marginTop: 10 },
    trendVal: { color: t.text, fontWeight: '700' },
    railLabel: { color: t.textFaint, fontFamily: mono, fontSize: 10, letterSpacing: 1.5, marginTop: 16, marginBottom: 10 },
    rail: { gap: 10, paddingRight: 6 },
    recentItem: { width: 110 },
    recentArt: { width: 110, height: 51, borderRadius: 8, backgroundColor: t.bg },
    recentName: { color: t.text, fontSize: 12, fontWeight: '600', marginTop: 5 },
    recentHours: { color: t.textFaint, fontSize: 10, marginTop: 1 },
  });
