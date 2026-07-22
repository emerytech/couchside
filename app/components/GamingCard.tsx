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
import { Alert, Image, Pressable, StyleSheet, Text, View } from 'react-native';
import { hapticLight } from '@/lib/haptics';

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

/** "1h 24m" / "6m" — a glanceable session length, not a stopwatch. */
function humanizeRun(secs: number): string {
  const m = Math.floor(secs / 60);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
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
  const [stopping, setStopping] = useState(false);
  const poll = usePoll<Gaming | null>(
    () => api.gaming(settings), fast ? 5000 : 20000, ready && configured, hostKey(settings));
  const g = poll.data;
  useEffect(() => {
    setFast(g?.game != null);
  }, [g?.game]);

  // Probe-and-appear: hidden until the box reports a gaming payload.
  if (!g) return null;

  const gpu = g.gpu;
  // SHARED-MEMORY GPUs (every handheld APU) carve out a token amount of "VRAM"
  // and do the real work in GTT, which is system RAM. MEASURED on a Legion Go S:
  // 512 MB VRAM sitting at 89% next to 15.3 GB of GTT barely touched. Showing
  // the VRAM bar alone told the owner his GPU had 0.5 GB and was nearly full.
  //
  // When GTT dwarfs VRAM the two pools are the same physical memory, so adding
  // them describes something real: total graphics footprint. On a discrete card
  // they are genuinely separate and VRAM is the honest number, so the sum is
  // NOT applied there.
  const shared = gpu?.gtt_total_mb != null && gpu.gtt_total_mb > (gpu.vram_total_mb ?? 0);
  const memUsed = shared
    ? (gpu?.vram_used_mb ?? 0) + (gpu?.gtt_used_mb ?? 0)
    : gpu?.vram_used_mb;
  const memTotal = shared
    ? (gpu?.vram_total_mb ?? 0) + (gpu?.gtt_total_mb ?? 0)
    : gpu?.vram_total_mb;
  const vramPct =
    memUsed != null && memTotal
      ? Math.round((memUsed / memTotal) * 100)
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

      {/* Close the game from the couch. You could always START one from the
          phone and never stop one, which is the half that matters when the TV
          is showing a game you cannot get out of.
          Confirmed first: this is not undoable, and an accidental tap could
          lose unsaved progress. */}
      {g.game && (
        <View style={styles.block}>
          <View style={styles.lineRow}>
            <Text style={styles.lineLabel}>RUNNING</Text>
            {g.game.running_s != null && (
              <Text style={styles.dim}>{humanizeRun(g.game.running_s)}</Text>
            )}
          </View>
          <Pressable
            onPress={() => {
              hapticLight();
              Alert.alert(
                'Close this game?',
                `${g.game?.label ?? 'The running game'} will be asked to quit. Unsaved progress may be lost.`,
                [
                  { text: 'Cancel', style: 'cancel' },
                  {
                    text: 'Close game',
                    style: 'destructive',
                    onPress: () => {
                      setStopping(true);
                      void api.stopGame(settings).finally(() => {
                        setStopping(false);
                        // Refresh either way: on success the card should empty,
                        // and on failure the truth is whatever the box says.
                        poll.refresh();
                      });
                    },
                  },
                ],
              );
            }}
            disabled={stopping}
            style={({ pressed }) => [styles.stopBtn, pressed && { opacity: 0.7 }]}>
            <Ionicons name="stop-circle-outline" size={15} color={t.red} />
            <Text style={styles.stopText}>{stopping ? 'CLOSING…' : 'CLOSE GAME'}</Text>
          </Pressable>
        </View>
      )}

      {gpu && (
        <View style={styles.block}>
          <View style={styles.lineRow}>
            <Text style={styles.lineLabel}>GPU</Text>
            {gpu.busy_pct != null && (
              <Text style={styles.dim}>{gpu.busy_pct}% busy</Text>
            )}
            {gpu.temp_c != null && (
              <Text style={[styles.lineVal, { color: tempColor(gpu.temp_c, t) }]}>
                {gpu.temp_c.toFixed(1)}°C
              </Text>
            )}
          </View>
          {vramPct != null && memTotal != null && (
            <>
              <View style={styles.barLabelRow}>
                <Text style={styles.dim}>
                  {(memUsed! / 1024).toFixed(1)} / {(memTotal / 1024).toFixed(1)} GB
                  {shared ? ' shared' : ''}
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
    // Destructive, so it reads as one: red text on a red hairline rather than a
  // filled button. It sits inside a card of read-only vitals and must not look
  // like just another row.
  stopBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    marginTop: 6,
    paddingVertical: 8,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: t.red,
  },
  stopText: { color: t.red, fontSize: 12, fontWeight: '700', letterSpacing: 1, fontFamily: mono },
  barFill: { height: '100%', borderRadius: 3 },
  });
