import React, { useCallback, useEffect, useState } from 'react';
import { FlatList, Pressable, StyleSheet, Switch, Text, View } from 'react-native';

import { usePoll } from '@/hooks/usePoll';
import { api, Journal, Unit, UnitScope } from '@/lib/api';
import { usePref } from '@/lib/prefs';
import { useSettings } from '@/lib/SettingsContext';
import { mono, theme } from '@/lib/theme';

type PickerUnit = { unit: string; scope: UnitScope; short: string };

// Shown until /api/units answers (or if it never does).
const FALLBACK_UNITS: PickerUnit[] = [
  { unit: 'sddm.service', scope: 'system', short: 'sddm' },
  { unit: 'couchside.service', scope: 'system', short: 'couchside' },
];

function toPicker(units: Unit[]): PickerUnit[] {
  return units.map((u) => ({
    unit: u.name,
    scope: u.scope,
    short: u.name.replace(/\.service$/, ''),
  }));
}

/**
 * The journal viewer, hosted inside the Settings screen's Logs tab (it used to
 * be a top-level tab). Owns its own vertical layout — the parent must give it
 * flex room, not wrap it in a ScrollView.
 */
export function LogsPanel() {
  const { settings, ready } = useSettings();

  const [selected, setSelected] = useState(0);
  const [auto, setAuto] = useState(false);
  const journalLines = usePref('journalLines');

  // The picker mirrors the agent's journal watchlist (/api/units). The huge
  // interval parks the timer; usePoll still fetches on mount and every focus.
  const units = usePoll<{ units: Unit[] }>(() => api.units(settings), 3600_000, ready);
  const picker =
    units.data && units.data.units.length > 0 ? toPicker(units.data.units) : FALLBACK_UNITS;

  const target = picker[Math.min(selected, picker.length - 1)];

  const journal = usePoll<Journal>(
    () => api.journal(settings, target.unit, target.scope, journalLines),
    // Auto-refresh every 5s; otherwise park the interval (manual refresh only;
    // usePoll still fires immediately on focus / refresh()).
    auto ? 5000 : 3600_000,
    ready,
  );

  // Re-fetch immediately when the selected unit changes (index or, once the
  // real watchlist arrives, the unit that index resolves to).
  const { refresh } = journal;
  useEffect(() => {
    refresh();
  }, [target.unit, target.scope, refresh]);

  const renderLine = useCallback(
    ({ item }: { item: string }) => <Text style={styles.line}>{item}</Text>,
    [],
  );

  // Inverted list: newest journal line (last in the array) renders at the bottom.
  const lines = journal.data ? [...journal.data.lines].reverse() : [];

  return (
    <View style={styles.root}>
      {/* Segmented unit picker */}
      <View style={styles.segments}>
        {picker.map((w, i) => (
          <Pressable
            key={`${w.scope}:${w.unit}`}
            onPress={() => setSelected(i)}
            style={[styles.segment, target === w && styles.segmentActive]}>
            <Text style={[styles.segmentText, target === w && styles.segmentTextActive]}>
              {w.short}
            </Text>
          </Pressable>
        ))}
      </View>

      {/* Toolbar */}
      <View style={styles.toolbar}>
        <Text style={styles.unitLabel} numberOfLines={1}>
          {target.unit} <Text style={styles.scopeLabel}>({target.scope})</Text>
        </Text>
        <View style={styles.toolbarRight}>
          <Text style={styles.autoLabel}>auto 5s</Text>
          <Switch
            value={auto}
            onValueChange={setAuto}
            trackColor={{ false: theme.inset, true: theme.green }}
            thumbColor={theme.text}
          />
          <Pressable
            onPress={journal.refresh}
            style={({ pressed }) => [styles.refreshBtn, pressed && styles.pressed]}>
            <Text style={styles.refreshText}>REFRESH</Text>
          </Pressable>
        </View>
      </View>

      {/* Log view */}
      <View style={styles.logBox}>
        {journal.error != null && (
          <View style={styles.errStrip}>
            <Text style={styles.errText}>{journal.error.message}</Text>
          </View>
        )}
        {journal.loading && !journal.data ? (
          <Text style={styles.dim}>loading…</Text>
        ) : lines.length === 0 && journal.error == null ? (
          <Text style={styles.dim}>(no journal lines)</Text>
        ) : (
          <FlatList
            data={lines}
            inverted
            renderItem={renderLine}
            keyExtractor={(_, i) => String(i)}
            style={styles.logList}
            contentContainerStyle={{ paddingVertical: 8 }}
          />
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, paddingHorizontal: 14, paddingTop: 14 },
  segments: {
    flexDirection: 'row',
    backgroundColor: theme.inset,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: theme.cardBorder,
    padding: 3,
    marginBottom: 10,
  },
  segment: {
    flex: 1,
    paddingVertical: 10,
    borderRadius: 8,
    alignItems: 'center',
  },
  segmentActive: { backgroundColor: theme.card, borderWidth: 1, borderColor: theme.blue },
  segmentText: { color: theme.textDim, fontSize: 12, fontFamily: mono },
  segmentTextActive: { color: theme.blue, fontWeight: '700' },
  toolbar: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 8,
    gap: 8,
  },
  unitLabel: { color: theme.text, fontSize: 12, fontFamily: mono, flex: 1 },
  scopeLabel: { color: theme.textFaint },
  toolbarRight: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  autoLabel: { color: theme.textDim, fontSize: 12 },
  refreshBtn: {
    backgroundColor: theme.card,
    borderColor: theme.cardBorder,
    borderWidth: 1,
    borderRadius: 8,
    paddingVertical: 10,
    paddingHorizontal: 14,
  },
  refreshText: { color: theme.blue, fontSize: 12, fontWeight: '700', letterSpacing: 1 },
  pressed: { opacity: 0.7 },
  logBox: {
    flex: 1,
    backgroundColor: theme.inset,
    borderColor: theme.cardBorder,
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: 10,
    marginBottom: 12,
    overflow: 'hidden',
  },
  logList: { flex: 1 },
  line: {
    color: theme.textDim,
    fontSize: 11,
    fontFamily: mono,
    lineHeight: 16,
  },
  errStrip: {
    backgroundColor: theme.redDeep,
    borderColor: theme.red,
    borderWidth: 1,
    borderRadius: 8,
    padding: 8,
    marginTop: 8,
  },
  errText: { color: '#fecaca', fontSize: 12, fontFamily: mono },
  dim: { color: theme.textFaint, fontSize: 12, fontFamily: mono, paddingVertical: 12 },
});
