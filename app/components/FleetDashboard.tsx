import { router } from 'expo-router';
import Ionicons from '@expo/vector-icons/Ionicons';
import React, { useState } from 'react';
import { AppState, AppStateStatus, Pressable, StyleSheet, Text, View } from 'react-native';

import { EditableSection } from '@/components/EditableSection';
import { useFocusEffect } from 'expo-router';
import { api, Status } from '@/lib/api';
import { connFromBox } from '@/lib/boxConn';
import { effectiveOrder, moveSection } from '@/lib/cardLayout';
import { useFleetLayout, setFleetLayout } from '@/lib/fleetLayout';
import { hapticSelection } from '@/lib/haptics';
import { fmtLastSeen, noteBoxSeen } from '@/lib/lastSeen';
import { usePref } from '@/lib/prefs';
import { Box } from '@/lib/settings';
import { useSkinKit, VitalsContext, vitality } from '@/lib/skin';
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
 * Poll /api/status for EVERY box while this dashboard is focused. The
 * single-target usePoll can't fan out, so this follows useBoxOnlineStatus's
 * shape instead (SettingsContext): one in-flight request per box, paused on
 * background/blur, entries pruned when a box is removed.
 *
 * `enabled` lets the host (Setup's Boxes sub-tab) stop the fan-out when the
 * dashboard is not on screen, so switching to another Setup sub-tab does not
 * keep polling the whole fleet.
 */
function useFleetStatus(boxes: Box[], intervalMs: number, enabled: boolean): FleetMap {
  const [map, setMap] = React.useState<FleetMap>({});

  const { updateBox } = useBoxes();
  const updateBoxRef = React.useRef(updateBox);
  updateBoxRef.current = updateBox;

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
      if (!enabled) return;
      let appActive = AppState.currentState === 'active' || AppState.currentState == null;
      let interval: ReturnType<typeof setInterval> | null = null;

      const tick = () => {
        if (!appActive) return;
        for (const box of boxesRef.current) {
          if (inFlight.current.has(box.id)) continue;
          inFlight.current.add(box.id);
          const conn = connFromBox(box); // carries secure/tlsPort/pinModulus (KI-096)
          void api
            .status(conn)
            .then((s) => {
              if (!mounted.current) return;
              const now = Date.now();
              noteBoxSeen(box.id, now, (ts) => void updateBoxRef.current(box.id, { lastSeen: ts }));
              setMap((prev) => ({
                ...prev,
                [box.id]: { status: s, error: null, lastSuccess: now },
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
    }, [intervalMs, enabled]),
  );

  return map;
}

function Tile({ box, entry, active, index, onPress }: {
  box: Box;
  entry: FleetEntry | undefined;
  active: boolean;
  index: number;
  onPress: () => void;
}) {
  const t = useTheme();
  const styles = useThemedStyles(makeStyles);
  const { Card, Dot, Spark } = useSkinKit();
  const s = entry?.status ?? null;
  const up = entry != null && entry.error == null && s != null;
  const memPct = s ? Math.round((s.mem.used_mb / s.mem.total_mb) * 100) : 0;

  const vitals = React.useMemo(
    () => ({ v: up ? vitality(s?.load?.[0], s?.cpu_temp_c) : 0, alive: up }),
    [up, s?.load, s?.cpu_temp_c],
  );

  return (
    <VitalsContext.Provider value={vitals}>
      <Card
        onPress={onPress}
        selected={active}
        index={index}
        tone={!up && entry != null ? 'down' : 'default'}>
        <View style={styles.tileHeader}>
          <Dot color={up ? t.green : t.red} size={9} live={up} />
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
            <View style={styles.sparkWrap}>
              <Spark values={s.history?.load} color={t.blue} height={16} />
            </View>
          </>
        ) : (
          <Text style={styles.downText}>
            {entry == null
              ? 'probing…'
              : `DOWN · last seen ${fmtLastSeen(entry.lastSuccess ?? box.lastSeen ?? null)}`}
          </Text>
        )}
      </Card>
    </VitalsContext.Provider>
  );
}

/**
 * The at-a-glance multi-box view: live TEMP/LOAD/MEM tiles, tap to switch active
 * box, hold-to-edit reorder + hide. Formerly the standalone Fleet tab; now a
 * section embedded at the top of Setup's Boxes sub-tab (the management list of
 * pair/edit/remove lives below it). Renders nothing when there is fewer than one
 * box; the caller decides whether to mount it (Boxes sub-tab shows it at 2+).
 *
 * No ScrollView of its own — the host screen scrolls. The Done control renders
 * inline (not an absolute bottom bar) so it works inside Setup's own layout.
 */
export function FleetDashboard() {
  const t = useTheme();
  const styles = useThemedStyles(makeStyles);
  const { boxes, activeBoxId, switchBox } = useBoxes();
  const statusInterval = usePref('statusIntervalMs');
  const [editing, setEditing] = useState(false);
  const fleet = useFleetStatus(boxes, statusInterval, boxes.length > 0);

  const layout = useFleetLayout();
  const canonical = boxes.map((b) => b.id);
  const order = effectiveOrder(layout.order, canonical);
  const hidden = new Set(layout.hidden);
  const boxById = new Map(boxes.map((b) => [b.id, b]));
  const visible = order.filter((id) => boxById.has(id) && !hidden.has(id));
  const moveTile = (id: string, dir: -1 | 1) =>
    setFleetLayout({ order: moveSection(order, visible, id, dir), hidden: layout.hidden });
  const toggleHide = (id: string) => {
    const h = new Set(layout.hidden);
    if (h.has(id)) h.delete(id); else h.add(id);
    setFleetLayout({ order, hidden: [...h] });
  };
  const [present, setPresent] = useState<Record<string, boolean>>({});
  const setPres = (id: string, p: boolean) =>
    setPresent((prev) => (prev[id] === p ? prev : { ...prev, [id]: p }));

  if (boxes.length === 0) return null;

  return (
    <View style={styles.wrap}>
      <View style={styles.headerRow}>
        <Text style={styles.sectionLabel}>FLEET · LIVE</Text>
        {!editing && (
          <Pressable
            onPress={() => { hapticSelection(); setEditing(true); }}
            accessibilityRole="button"
            accessibilityLabel="Reorder or hide boxes"
            hitSlop={8}
            style={({ pressed }) => [styles.customizeBtn, pressed && styles.pressed]}>
            <Ionicons name="options-outline" size={18} color={t.textDim} />
          </Pressable>
        )}
      </View>
      {order.map((id, i) => {
        const box = boxById.get(id);
        if (box == null) return null;
        return (
          <EditableSection
            key={id}
            editing={editing}
            hidden={hidden.has(id)}
            isFirst={visible[0] === id}
            isLast={visible[visible.length - 1] === id}
            onEnterEdit={() => setEditing(true)}
            onPresent={(p) => setPres(id, p)}
            onUp={() => moveTile(id, -1)}
            onDown={() => moveTile(id, 1)}
            onToggleHide={() => toggleHide(id)}
            inertWhileEditing>
            <Tile
              box={box}
              entry={fleet[box.id]}
              active={box.id === activeBoxId}
              index={i}
              onPress={() => {
                if (editing) return;
                switchBox(box.id);
                // Land on the switched box's Console.
                router.replace('/(tabs)');
              }}
            />
          </EditableSection>
        );
      })}
      {editing && (
        <View style={styles.editRow}>
          <Text style={styles.editHint}>Reorder or hide boxes</Text>
          <Pressable
            onPress={() => setEditing(false)}
            accessibilityRole="button"
            accessibilityLabel="Done editing fleet"
            style={({ pressed }) => [styles.doneBtn, pressed && styles.pressed]}>
            <Text style={styles.doneText}>Done</Text>
          </Pressable>
        </View>
      )}
    </View>
  );
}

const makeStyles = (t: Palette) => StyleSheet.create({
  wrap: { marginBottom: 18 },
  headerRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 10 },
  sectionLabel: {
    color: t.textFaint,
    fontFamily: mono,
    fontSize: 11,
    letterSpacing: 1.5,
  },
  customizeBtn: { marginLeft: 'auto', padding: 6, borderRadius: 8 },
  editRow: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingTop: 10,
  },
  editHint: { color: t.textDim, fontSize: 13 },
  doneBtn: {
    backgroundColor: t.blue, borderRadius: 999,
    paddingVertical: 8, paddingHorizontal: 22,
  },
  doneText: { color: t.onAccent, fontWeight: '700', fontSize: 14 },
  pressed: { opacity: 0.7 },
  tileHeader: { flexDirection: 'row', alignItems: 'center', gap: 8 },
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
