/**
 * Gaming card (Console tab). Polls /api/gaming and shows a live "what's running
 * now" panel: discrete-GPU temp/VRAM, the running Steam game with cover art, the
 * active display output, connected controllers with battery, and the session
 * (Game Mode vs desktop). Probe-and-appear: renders nothing when the agent lacks
 * the route or has no Steam (404 -> null). EVERY payload field is independently
 * optional — a box with no discrete GPU (Intel i915) simply has no GPU block,
 * not a blank one. Poll is fast while a game runs, slow when idle.
 */
import Ionicons from '@expo/vector-icons/Ionicons';
import React, { useEffect, useState } from 'react';
import { Image, StyleSheet, Text, View } from 'react-native';

import { usePoll } from '@/hooks/usePoll';
import { api, Gaming, hostKey } from '@/lib/api';
import { useSkinKit } from '@/lib/skin';
import { useSettings } from '@/lib/SettingsContext';
import { mono, pctColor, tempColor, useTheme, useThemedStyles, type Palette } from '@/lib/theme';

/** Battery semantics are INVERTED vs temp/usage: low is bad. */
function batteryColor(pct: number, t: Palette): string {
  if (pct <= 15) return t.red;
  if (pct <= 30) return t.amber;
  return t.green;
}

function GameCover({ appid, label }: { appid: number; label?: string }) {
  const styles = useThemedStyles(makeStyles);
  const { settings } = useSettings();
  const source = api.steamCoverSource(settings, appid);
  const [failed, setFailed] = useState(false);
  // Clear the failed latch when the cover URL changes (box switch / new game) so
  // a now-available cover repaints instead of error-looping.
  useEffect(() => setFailed(false), [source.uri]);
  return (
    <View style={styles.gameRow}>
      {!failed ? (
        <Image
          source={source}
          style={styles.cover}
          resizeMode="cover"
          onError={() => setFailed(true)}
        />
      ) : (
        <View style={[styles.cover, styles.coverFallback]}>
          <Ionicons name="game-controller" size={20} color="#8aa" />
        </View>
      )}
      <Text style={styles.gameLabel} numberOfLines={2}>
        {label || `App ${appid}`}
      </Text>
    </View>
  );
}

export function GamingCard() {
  const t = useTheme();
  const styles = useThemedStyles(makeStyles);
  const { Card, Bar } = useSkinKit();
  const { settings, ready } = useSettings();
  const configured = !!settings.host && !!settings.token;

  // Adaptive cadence: fast while a game is running, slow when idle. `fast` is
  // declared before the poll that reads it and flipped by the effect below.
  const [fast, setFast] = useState(false);
  const poll = usePoll<Gaming | null>(
    () => api.gaming(settings), fast ? 5000 : 20000, ready && configured, hostKey(settings));
  const g = poll.data;
  useEffect(() => {
    setFast(g?.game != null);
  }, [g?.game]);

  // Probe-and-appear: hidden until the box reports a gaming payload.
  if (!g) return null;

  const gpu = g.gpu;
  const vramPct =
    gpu?.vram_used_mb != null && gpu?.vram_total_mb
      ? Math.round((gpu.vram_used_mb / gpu.vram_total_mb) * 100)
      : null;
  const inGameMode = g.session === 'gamescope';

  return (
    <Card index={2}>
      <View style={styles.header}>
        <Text style={styles.cardTitle}>GAMING</Text>
        <View style={[styles.sessionPill, inGameMode && styles.sessionPillOn]}>
          <Ionicons
            name={inGameMode ? 'tv' : 'desktop-outline'}
            size={11}
            color={inGameMode ? t.bg : t.textDim}
          />
          <Text style={[styles.sessionText, inGameMode && { color: t.bg }]}>
            {inGameMode ? 'Game Mode' : 'Desktop'}
          </Text>
        </View>
      </View>

      {g.game && <GameCover appid={g.game.appid} label={g.game.label} />}

      {gpu && (
        <View style={styles.block}>
          <View style={styles.lineRow}>
            <Text style={styles.lineLabel}>GPU</Text>
            {gpu.temp_c != null && (
              <Text style={[styles.lineVal, { color: tempColor(gpu.temp_c, t) }]}>
                {gpu.temp_c.toFixed(1)}°C
              </Text>
            )}
          </View>
          {vramPct != null && gpu.vram_total_mb != null && (
            <>
              <View style={styles.barLabelRow}>
                <Text style={styles.dim}>
                  {(gpu.vram_used_mb! / 1024).toFixed(1)} / {(gpu.vram_total_mb / 1024).toFixed(1)} GB
                </Text>
                <Text style={[styles.dim, { color: pctColor(vramPct, t) }]}>{vramPct}%</Text>
              </View>
              <Bar pct={vramPct} color={pctColor(vramPct, t)} height={6} />
            </>
          )}
        </View>
      )}

      {g.output && (
        <View style={styles.lineRow}>
          <Text style={styles.lineLabel}>OUTPUT</Text>
          <Text style={styles.lineVal}>
            {g.output.name}
            <Text style={styles.dim}>{g.output.internal ? '  built-in' : '  external'}</Text>
          </Text>
        </View>
      )}

      {g.controllers?.map((c) => (
        <View key={c.uniq || c.name} style={styles.lineRow}>
          <Ionicons name="game-controller-outline" size={14} color={t.textDim} />
          <Text style={styles.ctrlName} numberOfLines={1}>
            {c.name || 'Controller'}
          </Text>
          {c.battery_pct != null ? (
            <Text style={[styles.lineVal, { color: batteryColor(c.battery_pct, t) }]}>
              {c.battery_pct}%
              {c.battery_status === 'Charging' ? ' ⚡' : ''}
            </Text>
          ) : (
            <Text style={styles.dim}>connected</Text>
          )}
        </View>
      ))}
    </Card>
  );
}

const makeStyles = (t: Palette) =>
  StyleSheet.create({
    card: {
      backgroundColor: t.card,
      borderColor: t.cardBorder,
      borderWidth: 1,
      borderRadius: 14,
      padding: 14,
      marginBottom: 12,
      gap: 10,
    },
    header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
    cardTitle: {
      color: t.textDim,
      fontSize: 11,
      fontWeight: '700',
      letterSpacing: 1,
      fontFamily: mono,
    },
    sessionPill: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 4,
      borderColor: t.cardBorder,
      borderWidth: 1,
      borderRadius: 999,
      paddingVertical: 3,
      paddingHorizontal: 9,
    },
    sessionPillOn: { backgroundColor: t.green, borderColor: t.green },
    sessionText: { color: t.textDim, fontSize: 11, fontWeight: '700', fontFamily: mono },

    gameRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
    cover: { width: 46, height: 69, borderRadius: 6, backgroundColor: t.inset },
    coverFallback: { alignItems: 'center', justifyContent: 'center' },
    gameLabel: { color: t.text, fontSize: 15, fontWeight: '700', fontFamily: mono, flex: 1 },

    block: { gap: 6 },
    lineRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
    lineLabel: {
      color: t.textDim,
      fontSize: 11,
      fontWeight: '700',
      letterSpacing: 0.8,
      fontFamily: mono,
      minWidth: 52,
    },
    lineVal: { color: t.text, fontSize: 14, fontFamily: mono, marginLeft: 'auto' },
    ctrlName: { color: t.text, fontSize: 14, fontFamily: mono, flex: 1 },
    dim: { color: t.textFaint, fontSize: 12, fontFamily: mono },

    barLabelRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
    barTrack: { height: 6, borderRadius: 3, backgroundColor: t.cardBorder, overflow: 'hidden' },
    barFill: { height: '100%', borderRadius: 3 },
  });
