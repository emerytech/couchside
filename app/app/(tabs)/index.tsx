import React from 'react';
import {
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Gated } from '@/components/Gated';
import { usePoll } from '@/hooks/usePoll';
import { api, humanizeUptime, Status, Unit } from '@/lib/api';
import { useSettings } from '@/lib/SettingsContext';
import { mono, numeric, pctColor, tempColor, theme } from '@/lib/theme';

function Bar({ pct, color }: { pct: number; color: string }) {
  return (
    <View style={styles.barTrack}>
      <View
        style={[
          styles.barFill,
          { width: `${Math.min(100, Math.max(0, pct))}%`, backgroundColor: color },
        ]}
      />
    </View>
  );
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <View style={styles.card}>
      <Text style={styles.cardTitle}>{title}</Text>
      {children}
    </View>
  );
}

function unitColor(active: string): string {
  if (active === 'active') return theme.green;
  if (active === 'failed') return theme.red;
  return theme.amber;
}

function UnitChip({ unit }: { unit: Unit }) {
  const color = unitColor(unit.active);
  return (
    <View style={[styles.chip, { borderColor: color }]}>
      <View style={[styles.chipDot, { backgroundColor: color }]} />
      <Text style={styles.chipName} numberOfLines={1}>
        {unit.name.replace(/\.service$/, '')}
      </Text>
      <Text style={[styles.chipState, { color }]}>
        {unit.active}
        {unit.sub ? `/${unit.sub}` : ''}
      </Text>
    </View>
  );
}

function fmtLastSeen(ts: number | null): string {
  if (!ts) return 'never';
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  return `${Math.floor(m / 60)}h ${m % 60}m ago`;
}

export default function ConsoleTab() {
  return (
    <Gated>
      <ConsoleScreen />
    </Gated>
  );
}

function ConsoleScreen() {
  const insets = useSafeAreaInsets();
  const { settings, ready } = useSettings();

  // No host yet (fresh install): don't poll, and show the pairing hint
  // instead of the unreachable banner.
  const configured = settings.host.trim().length > 0;

  const status = usePoll<Status>(() => api.status(settings), 5000, ready && configured);
  const units = usePoll<{ units: Unit[] }>(() => api.units(settings), 10000, ready && configured);

  const s = status.data;
  const reachable = configured && status.error == null && s != null;
  const memPct = s ? Math.round((s.mem.used_mb / s.mem.total_mb) * 100) : 0;

  return (
    <ScrollView
      style={styles.screen}
      contentContainerStyle={{
        paddingTop: insets.top + 12,
        paddingBottom: 32,
        paddingHorizontal: 14,
      }}>
      {/* Status header */}
      <View style={styles.header}>
        <View
          style={[
            styles.dot,
            { backgroundColor: reachable ? theme.green : theme.red },
          ]}
        />
        <Text style={styles.hostname}>
          {s?.hostname ?? (configured ? settings.host : 'CouchPilot')}
        </Text>
        <Text style={styles.headerSub}>
          {reachable ? `agent v${s?.agent_version}` : configured ? 'offline' : 'not set up'}
        </Text>
      </View>

      {/* Fresh install: nothing paired yet, so nothing is "unreachable". */}
      {!configured && (
        <View style={styles.emptyCard}>
          <Text style={styles.emptyTitle}>No box configured</Text>
          <Text style={styles.emptyText}>
            Open the Setup tab to pair with the CouchPilot agent on your media center or Steam
            machine — or try demo mode.
          </Text>
        </View>
      )}

      {/* Unreachable banner — the whole point of this app */}
      {configured && status.error != null && (
        <View style={styles.banner}>
          <Text style={styles.bannerTitle}>BOX UNREACHABLE</Text>
          <Text style={styles.bannerDetail}>{status.error.message}</Text>
          <Text style={styles.bannerDetail}>
            last seen: {fmtLastSeen(status.lastSuccess)}
          </Text>
          <Pressable
            style={({ pressed }) => [styles.retryBtn, pressed && styles.pressed]}
            onPress={() => {
              status.refresh();
              units.refresh();
            }}>
            <Text style={styles.retryText}>RETRY</Text>
          </Pressable>
        </View>
      )}

      {s && (
        <>
          <View style={styles.row}>
            <View style={styles.half}>
              <Card title="CPU TEMP">
                <Text style={[styles.bigMetric, { color: tempColor(s.cpu_temp_c) }]}>
                  {s.cpu_temp_c != null ? `${s.cpu_temp_c.toFixed(1)}°C` : '—'}
                </Text>
              </Card>
            </View>
            <View style={styles.half}>
              <Card title="UPTIME">
                <Text style={[styles.bigMetric, { color: theme.text }]}>
                  {humanizeUptime(s.uptime_s)}
                </Text>
              </Card>
            </View>
          </View>

          <Card title="LOAD 1m / 5m / 15m">
            <View style={styles.loadRow}>
              {s.load.map((l, i) => (
                <Text key={i} style={styles.loadVal}>
                  {l.toFixed(2)}
                </Text>
              ))}
            </View>
          </Card>

          <Card title="MEMORY">
            <View style={styles.barLabelRow}>
              <Text style={styles.barLabel}>
                {(s.mem.used_mb / 1024).toFixed(1)} / {(s.mem.total_mb / 1024).toFixed(1)} GB
              </Text>
              <Text style={[styles.barLabel, { color: pctColor(memPct) }]}>{memPct}%</Text>
            </View>
            <Bar pct={memPct} color={pctColor(memPct)} />
          </Card>

          <Card title="DISKS">
            {s.disks.map((d) => (
              <View key={d.mount} style={styles.diskRow}>
                <View style={styles.barLabelRow}>
                  <Text style={styles.diskMount}>{d.mount}</Text>
                  <Text style={styles.barLabel}>
                    {d.used_gb.toFixed(1)} / {d.total_gb.toFixed(1)} GB
                    {'   '}
                    <Text style={{ color: pctColor(d.pct) }}>{d.pct}%</Text>
                  </Text>
                </View>
                <Bar pct={d.pct} color={pctColor(d.pct)} />
              </View>
            ))}
          </Card>
        </>
      )}

      {/* Units */}
      {configured && (
      <Card title="UNITS">
        {units.error != null && !units.data ? (
          <Text style={styles.unitErr}>{units.error.message}</Text>
        ) : units.data ? (
          <View style={styles.chips}>
            {units.data.units.map((u) => (
              <UnitChip key={`${u.scope}:${u.name}`} unit={u} />
            ))}
          </View>
        ) : (
          <Text style={styles.unitErr}>loading…</Text>
        )}
      </Card>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: theme.bg },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 12,
    gap: 10,
  },
  dot: { width: 14, height: 14, borderRadius: 7 },
  hostname: { color: theme.text, fontSize: 26, fontWeight: '700', fontFamily: mono },
  headerSub: { color: theme.textDim, fontSize: 13, marginLeft: 'auto' },
  emptyCard: {
    backgroundColor: theme.card,
    borderColor: theme.cardBorder,
    borderWidth: 1,
    borderRadius: 12,
    padding: 16,
    marginBottom: 12,
  },
  emptyTitle: { color: theme.text, fontSize: 16, fontWeight: '700', marginBottom: 6 },
  emptyText: { color: theme.textDim, fontSize: 13, lineHeight: 19 },
  banner: {
    backgroundColor: theme.redDeep,
    borderColor: theme.red,
    borderWidth: 1,
    borderRadius: 12,
    padding: 16,
    marginBottom: 12,
    alignItems: 'center',
  },
  bannerTitle: {
    color: '#fff',
    fontSize: 20,
    fontWeight: '800',
    letterSpacing: 2,
    marginBottom: 6,
  },
  bannerDetail: { color: '#fecaca', fontSize: 13, ...numeric },
  retryBtn: {
    marginTop: 12,
    backgroundColor: theme.red,
    paddingVertical: 12,
    paddingHorizontal: 36,
    borderRadius: 8,
  },
  retryText: { color: '#450a0a', fontWeight: '800', fontSize: 15, letterSpacing: 1 },
  pressed: { opacity: 0.7 },
  row: { flexDirection: 'row', gap: 10 },
  half: { flex: 1 },
  card: {
    backgroundColor: theme.card,
    borderColor: theme.cardBorder,
    borderWidth: 1,
    borderRadius: 12,
    padding: 14,
    marginBottom: 10,
  },
  cardTitle: {
    color: theme.textFaint,
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 1.2,
    marginBottom: 8,
  },
  bigMetric: { fontSize: 28, fontWeight: '700', ...numeric },
  loadRow: { flexDirection: 'row', justifyContent: 'space-between' },
  loadVal: {
    color: theme.text,
    fontSize: 22,
    fontWeight: '600',
    flex: 1,
    textAlign: 'center',
    ...numeric,
  },
  barLabelRow: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 6 },
  barLabel: { color: theme.textDim, fontSize: 12, ...numeric },
  barTrack: {
    height: 10,
    borderRadius: 5,
    backgroundColor: theme.inset,
    overflow: 'hidden',
  },
  barFill: { height: '100%', borderRadius: 5 },
  diskRow: { marginBottom: 12 },
  diskMount: { color: theme.text, fontSize: 13, fontWeight: '600', fontFamily: mono },
  chips: { gap: 8 },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    borderWidth: 1,
    borderRadius: 8,
    paddingVertical: 10,
    paddingHorizontal: 12,
    backgroundColor: theme.inset,
  },
  chipDot: { width: 8, height: 8, borderRadius: 4 },
  chipName: { color: theme.text, fontSize: 13, fontFamily: mono, flexShrink: 1 },
  chipState: { fontSize: 12, marginLeft: 'auto', ...numeric },
  unitErr: { color: theme.textDim, fontSize: 13 },
});
