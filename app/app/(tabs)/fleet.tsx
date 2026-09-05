import { router } from 'expo-router';
import Ionicons from '@expo/vector-icons/Ionicons';
import React, { useState } from 'react';
import { AppState, AppStateStatus, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { EditableSection } from '@/components/EditableSection';
import { Gated } from '@/components/Gated';
import { TabScreen } from '@/components/TabScreen';
import { useFocusEffect } from 'expo-router';
import { useLockOrientation } from '@/hooks/useLockOrientation';
import { api, Status } from '@/lib/api';
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
 * Poll /api/status for EVERY box while the Fleet tab is focused. The
 * single-target usePoll can't fan out, so this follows useBoxOnlineStatus's
 * shape instead (SettingsContext): one in-flight request per box, paused on
 * background/blur, entries pruned when a box is removed.
 */
function useFleetStatus(boxes: Box[], intervalMs: number): FleetMap {
  const [map, setMap] = React.useState<FleetMap>({});

  // Persist each box's last-reachable time (throttled) so a DOWN tile shows a
  // real "last seen" after an app restart instead of "never". A ref keeps the
  // focus effect's deps as [intervalMs] rather than re-subscribing on identity.
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
    }, [intervalMs]),
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

  // Each tile carries its OWN vitals: one box idling next to one under load
  // should visibly differ. A box that is down is not alive, whatever it last
  // reported.
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
            {/* Load trend, indented to align with the metrics row. */}
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
  const t = useTheme();
  const { boxes, activeBoxId, switchBox } = useBoxes();
  const statusInterval = usePref('statusIntervalMs');
  const fleet = useFleetStatus(boxes, statusInterval);
  const styles = useThemedStyles(makeStyles);
  const { Screen, SectionTitle } = useSkinKit();

  // Hold-to-edit reorder + hide, same store/pattern as the Console tab, but the
  // ids are BOX ids: order is which box sits where, hidden is boxes tucked out of
  // the fleet list (still paired, still switchable from Setup). effectiveOrder
  // reconciles against the live boxes each render, so pairing appends and
  // unpairing drops cleanly.
  const layout = useFleetLayout();
  const [editing, setEditing] = useState(false);
  const [present, setPresent] = useState<Record<string, boolean>>({});
  const canonical = boxes.map((b) => b.id);
  const order = effectiveOrder(layout.order, canonical);
  const hidden = new Set(layout.hidden);
  const boxById = new Map(boxes.map((b) => [b.id, b]));
  const setPres = (id: string, p: boolean) =>
    setPresent((prev) => (prev[id] === p ? prev : { ...prev, [id]: p }));
  // Every tile renders content, so "visible" is the ordered ids that aren't
  // hidden — that is what the up/down arrows step through.
  const visible = order.filter((id) => boxById.has(id) && !hidden.has(id));
  const moveTile = (id: string, dir: -1 | 1) =>
    setFleetLayout({ order: moveSection(order, visible, id, dir), hidden: layout.hidden });
  const toggleHide = (id: string) => {
    const h = new Set(layout.hidden);
    if (h.has(id)) h.delete(id); else h.add(id);
    setFleetLayout({ order, hidden: [...h] });
  };

  return (
    <View style={styles.screen}>
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={{ paddingTop: 12, paddingBottom: 32, paddingHorizontal: 14 }}>
        <Screen>
          <View style={styles.headerRow}>
            <SectionTitle>YOUR FLEET</SectionTitle>
            {/* CUSTOMIZE: a visible way into the same hold-to-edit mode, and the
                only way back in when every box is hidden. Gone while editing —
                the Done bar owns the exit. */}
            {!editing && boxes.length > 0 && (
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
                    // A tap while editing belongs to the reorder/hide strip
                    // (inertWhileEditing already blocks it); guard anyway.
                    if (editing) return;
                    switchBox(box.id);
                    // Land on the box's Console; a box whose gaming tabs are
                    // hidden still always has Console.
                    router.replace('/(tabs)');
                  }}
                />
              </EditableSection>
            );
          })}
        </Screen>
      </ScrollView>
      {/* Edit-layout bar: hold any tile (or tap Customize) to enter; reorder/hide
          then Done. Matches the Console tab. */}
      {editing && (
        <View style={styles.editBar}>
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
  screen: { flex: 1, backgroundColor: t.bg },
  scroll: { flex: 1 },
  // The title row now also holds the Customize entry point, so the bare
  // SectionTitle's own margin is dropped in favour of the row's.
  headerRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 10 },
  customizeBtn: { marginLeft: 'auto', padding: 6, borderRadius: 8 },
  editBar: {
    position: 'absolute', left: 0, right: 0, bottom: 0,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 16, paddingTop: 12, paddingBottom: 28,
    backgroundColor: t.card, borderTopColor: t.cardBorder, borderTopWidth: 1,
  },
  editHint: { color: t.textDim, fontSize: 13 },
  doneBtn: {
    backgroundColor: t.blue, borderRadius: 999,
    paddingVertical: 8, paddingHorizontal: 22,
  },
  doneText: { color: t.onAccent, fontWeight: '700', fontSize: 14 },
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
