import { router } from 'expo-router';
import React from 'react';
import { AppState, AppStateStatus, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { Gated } from '@/components/Gated';
import { Sparkline } from '@/components/Sparkline';
import { TabScreen } from '@/components/TabScreen';
import { useFocusEffect } from 'expo-router';
import { useLockOrientation } from '@/hooks/useLockOrientation';
import { api, Status } from '@/lib/api';
import { usePref } from '@/lib/prefs';
import { Box } from '@/lib/settings';
import { useBoxes } from '@/lib/SettingsContext';
import { mono, numeric, pctColor, tempColor, useTheme, useThemedStyles } from '@/lib/theme';
import type { Palette } from '@/lib/theme';

/** One box's latest fleet snapshot. */
type FleetEntry = {
  status: Status | null;
  /** Message of the last failed poll, or null while reachable. */
  error: string | null;
  /** Unix ms of the last successful poll (for the DOWN tile's last-seen). */
  lastSuccess: number | null;
};

type FleetMap = Record<string, FleetEntry>;

/**
 * Poll /api/status for EVERY box while the Fleet tab is focused. The
 * single-target usePoll can't fan out, so this follows useBoxOnlineStatus's
 * shape instead (SettingsContext): one in-flight request per box, paused on
 * background/blur, entries pruned when a box is removed.
 */
function useFleetStatus(boxes: Box[], intervalMs: number): FleetMap {
  const [map, setMap] = React.useState<FleetMap>({});

  const boxesRef = React.useRef<Box[]>(boxes);
  boxesRef.current = boxes;
  const inFlight = React.useRef<Set<string>>(new Set());
  const mounted = React.useRef(true);

  // Prune entries for boxes that no longer exist.
  const idsKey = boxes.map((b) => b.id).join(',');
  React.useEffect(() => {
    setMap((prev) => {
      const ids = new Set(boxesRef.current.map((b) => b.id));
      let changed = false;
      const next: FleetMap = {};
      for (const [id, v] of Object.entries(prev)) {
        if (ids.has(id)) next[id] = v;
        else changed = true;
      }
      return changed ? next : prev;
    });
  }, [idsKey]);

  React.useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useFocusEffect(
    React.useCallback(() => {
      let appActive = AppState.currentState === 'active' || AppState.currentState == null;
      let interval: ReturnType<typeof setInterval> | null = null;

      const tick = () => {
        if (!appActive) return;
        for (const box of boxesRef.current) {
          if (inFlight.current.has(box.id)) continue;
          inFlight.current.add(box.id);
          const conn = { host: box.host, port: box.port, token: box.token, lastIp: box.lastIp };
          void api
            .status(conn)
            .then((s) => {
              if (!mounted.current) return;
              setMap((prev) => ({
                ...prev,
                [box.id]: { status: s, error: null, lastSuccess: Date.now() },
              }));
            })
            .catch((e: unknown) => {
              if (!mounted.current) return;
              const msg = e instanceof Error ? e.message : String(e);
              setMap((prev) => ({
                ...prev,
                [box.id]: {
                  status: prev[box.id]?.status ?? null,
                  error: msg,
                  lastSuccess: prev[box.id]?.lastSuccess ?? null,
                },
              }));
            })
            .finally(() => {
              inFlight.current.delete(box.id);
            });
        }
      };

      const start = () => {
        if (interval != null) return;
        tick();
        interval = setInterval(tick, intervalMs);
      };
      const stop = () => {
        if (interval != null) {
          clearInterval(interval);
          interval = null;
        }
      };

      const sub = AppState.addEventListener('change', (s: AppStateStatus) => {
        const nowActive = s === 'active';
        if (nowActive === appActive) return;
        appActive = nowActive;
        if (appActive) start();
        else stop();
      });
      if (appActive) start();

      return () => {
        stop();
        sub.remove();
      };
    }, [intervalMs]),
  );

  return map;
}

function fmtLastSeen(ts: number | null): string {
  if (!ts) return 'never';
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  return `${Math.floor(m / 60)}h ${m % 60}m ago`;
}

function Tile({ box, entry, active, onPress }: {
  box: Box;
  entry: FleetEntry | undefined;
  active: boolean;
  onPress: () => void;
}) {
  const t = useTheme();
  const styles = useThemedStyles(makeStyles);
  const s = entry?.status ?? null;
  const up = entry != null && entry.error == null && s != null;
  const memPct = s ? Math.round((s.mem.used_mb / s.mem.total_mb) * 100) : 0;

  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [
        styles.tile,
        active && styles.tileActive,
        !up && entry != null && styles.tileDown,
        pressed && styles.pressed,
      ]}>
      <View style={styles.tileHeader}>
        <View style={[styles.dot, { backgroundColor: up ? t.green : t.red }]} />
        <Text style={styles.tileName} numberOfLines={1}>
          {s?.hostname ?? box.name}
        </Text>
        {active && <Text style={styles.activeTag}>active</Text>}
      </View>
      <Text style={styles.tileHost} numberOfLines={1}>
        {box.host}:{box.port}
      </Text>

      {up && s ? (
        <>
          <View style={styles.metricsRow}>
            <View style={styles.metric}>
              <Text style={styles.metricLabel}>TEMP</Text>
              <Text style={[styles.metricValue, { color: tempColor(s.cpu_temp_c, t) }]}>
                {s.cpu_temp_c != null ? `${Math.round(s.cpu_temp_c)}°` : '—'}
              </Text>
            </View>
            <View style={styles.metric}>
              <Text style={styles.metricLabel}>LOAD</Text>
              <Text style={[styles.metricValue, { color: t.text }]}>
                {s.load[0].toFixed(2)}
              </Text>
            </View>
            <View style={styles.metric}>
              <Text style={styles.metricLabel}>MEM</Text>
              <Text style={[styles.metricValue, { color: pctColor(memPct, t) }]}>{memPct}%</Text>
            </View>
          </View>
          {/* Load trend, indented to align with the metrics row. */}
          <View style={styles.sparkWrap}>
            <Sparkline values={s.history?.load} color={t.blue} height={16} />
          </View>
        </>
      ) : (
        <Text style={styles.downText}>
          {entry == null ? 'probing…' : `DOWN · last seen ${fmtLastSeen(entry.lastSuccess)}`}
        </Text>
      )}
    </Pressable>
  );
}

export default function FleetTab() {
  useLockOrientation('portrait');
  return (
    <TabScreen>
      <Gated>
        <FleetScreen />
      </Gated>
    </TabScreen>
  );
}

function FleetScreen() {
  const { boxes, activeBoxId, switchBox } = useBoxes();
  const statusInterval = usePref('statusIntervalMs');
  const fleet = useFleetStatus(boxes, statusInterval);
  const styles = useThemedStyles(makeStyles);

  return (
    <ScrollView
      style={styles.scroll}
      contentContainerStyle={{ paddingTop: 12, paddingBottom: 32, paddingHorizontal: 14 }}>
      <Text style={styles.sectionTitle}>YOUR FLEET</Text>
      {boxes.map((box) => (
        <Tile
          key={box.id}
          box={box}
          entry={fleet[box.id]}
          active={box.id === activeBoxId}
          onPress={() => {
            switchBox(box.id);
            // Land on the box's Console; a box whose gaming tabs are hidden
            // still always has Console.
            router.replace('/(tabs)');
          }}
        />
      ))}
    </ScrollView>
  );
}

const makeStyles = (t: Palette) => StyleSheet.create({
  scroll: { flex: 1 },
  sectionTitle: {
    color: t.textFaint,
    fontFamily: mono,
    fontSize: 11,
    letterSpacing: 1.5,
    marginBottom: 10,
  },
  tile: {
    backgroundColor: t.card,
    borderColor: t.cardBorder,
    borderWidth: 1,
    borderRadius: 12,
    padding: 14,
    marginBottom: 10,
  },
  tileActive: { borderColor: t.blue },
  tileDown: { borderColor: t.redDeep },
  pressed: { opacity: 0.7 },
  tileHeader: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  dot: { width: 9, height: 9, borderRadius: 5 },
  tileName: {
    color: t.text,
    fontFamily: mono,
    fontSize: 16,
    fontWeight: '700',
    flexShrink: 1,
  },
  activeTag: {
    color: t.blue,
    fontFamily: mono,
    fontSize: 11,
    marginLeft: 'auto',
  },
  tileHost: {
    color: t.textFaint,
    fontFamily: mono,
    fontSize: 11,
    marginTop: 2,
    marginLeft: 17,
  },
  metricsRow: { flexDirection: 'row', gap: 18, marginTop: 10, marginLeft: 17 },
  sparkWrap: { marginLeft: 17 },
  metric: {},
  metricLabel: {
    color: t.textFaint,
    fontFamily: mono,
    fontSize: 9,
    letterSpacing: 1,
  },
  metricValue: { ...numeric, fontSize: 18, fontWeight: '700', marginTop: 2 },
  downText: {
    color: t.red,
    fontFamily: mono,
    fontSize: 11,
    marginTop: 10,
    marginLeft: 17,
  },
});
