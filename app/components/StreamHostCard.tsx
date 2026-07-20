/**
 * Stream-host card (Console tab). Shows "STREAMING TO <peer>" while a Steam
 * Remote Play session is being served BY this box. Detect-only (roadmap phase
 * 4a) — nothing here changes the box's session or display.
 *
 * Deliberately worded as the OPPOSITE of the Launch tab's "STREAM FROM PC"
 * (SteamLinkSection), which is the client direction, and deliberately placed on
 * the Console tab so the two never read as the same feature.
 *
 * Probe-and-appear twice over: null when the agent lacks the route (404) AND
 * null while no session is live — an idle box shows nothing at all.
 */
import Ionicons from '@expo/vector-icons/Ionicons';
import React from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { usePoll } from '@/hooks/usePoll';
import { api, hostKey, HostSession } from '@/lib/api';
import { useSkinKit } from '@/lib/skin';
import { useSettings } from '@/lib/SettingsContext';
import { mono, useTheme, useThemedStyles, type Palette } from '@/lib/theme';

/** "12m" / "1h 04m" since the session started. */
function fmtElapsed(sinceEpoch: number): string {
  const s = Math.max(0, Math.floor(Date.now() / 1000 - sinceEpoch));
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
}

export function StreamHostCard() {
  const t = useTheme();
  const styles = useThemedStyles(makeStyles);
  const { Card } = useSkinKit();
  const { settings, ready } = useSettings();
  const configured = !!settings.host && !!settings.token;

  const poll = usePoll<HostSession | null>(
    () => api.streamHost(settings), 10000, ready && configured, hostKey(settings));
  const h = poll.data;

  // Hidden unless a session is actually being served from this box.
  if (!h?.active) return null;

  return (
    // tone="live": this box is actively serving a session, and the skin's live
    // treatment (green frame) is what carried that meaning before.
    <Card tone="live" accentColor={t.green}>
      <View style={styles.header}>
        <View style={styles.dot} />
        <Text style={styles.title}>STREAMING TO</Text>
        {h.since != null && <Text style={styles.elapsed}>{fmtElapsed(h.since)}</Text>}
      </View>
      <View style={styles.row}>
        <Ionicons name="tv-outline" size={16} color={t.green} />
        <Text style={styles.peer} numberOfLines={1}>
          {h.client ?? 'a device on your network'}
        </Text>
      </View>
      <Text style={styles.hint}>
        This box is hosting a Steam Remote Play session.
      </Text>
    </Card>
  );
}

const makeStyles = (t: Palette) =>
  StyleSheet.create({
    card: {
      backgroundColor: t.card,
      borderColor: t.green,
      borderWidth: 1,
      borderRadius: 14,
      padding: 14,
      marginBottom: 12,
      gap: 8,
    },
    header: { flexDirection: 'row', alignItems: 'center', gap: 7 },
    dot: { width: 8, height: 8, borderRadius: 4, backgroundColor: t.green },
    title: {
      color: t.green,
      fontSize: 11,
      fontWeight: '700',
      letterSpacing: 1,
      fontFamily: mono,
      flex: 1,
    },
    elapsed: { color: t.textDim, fontSize: 12, fontFamily: mono },
    row: { flexDirection: 'row', alignItems: 'center', gap: 8 },
    peer: { color: t.text, fontSize: 15, fontWeight: '700', fontFamily: mono, flex: 1 },
    hint: { color: t.textFaint, fontSize: 12, lineHeight: 17 },
  });
