import React, { useEffect } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { Gated } from '@/components/Gated';
import { GamingCard } from '@/components/GamingCard';
import { NowPlayingCard } from '@/components/NowPlayingCard';
import { ScreenPreview } from '@/components/ScreenPreview';
import { StreamHostCard } from '@/components/StreamHostCard';
import { TabScreen } from '@/components/TabScreen';
import { useLockOrientation } from '@/hooks/useLockOrientation';
import { usePoll } from '@/hooks/usePoll';
import { api, hostKey, humanizeUptime, Status, Unit } from '@/lib/api';
import { usePref } from '@/lib/prefs';
import { useSkinKit, VitalsContext, vitality } from '@/lib/skin';
import { noteBoxReachable } from '@/lib/review';
import { useSettings } from '@/lib/SettingsContext';
import { batteryColor, mono, numeric, pctColor, tempColor, useTheme, useThemedStyles } from '@/lib/theme';
import type { Palette } from '@/lib/theme';

function unitColor(active: string, t: Palette): string {
  if (active === 'active') return t.green;
  if (active === 'failed') return t.red;
  return t.amber;
}

function UnitChip({ unit }: { unit: Unit }) {
  const t = useTheme();
  const styles = useThemedStyles(makeStyles);
  const color = unitColor(unit.active, t);
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
  useLockOrientation('portrait');
  return (
    <TabScreen>
      <Gated>
        <ConsoleScreen />
      </Gated>
    </TabScreen>
  );
}

function ConsoleScreen() {
  const t = useTheme();
  const styles = useThemedStyles(makeStyles);
  const { Screen, Card, Bar, Dot, Spark, BigMetric } = useSkinKit();
  const { settings, ready } = useSettings();

  // No host yet (fresh install): don't poll, and show the pairing hint
  // instead of the unreachable banner.
  const configured = settings.host.trim().length > 0;

  const statusInterval = usePref('statusIntervalMs');
  const boxKey = hostKey(settings); // resetKey: clear stale data on box switch
  const status = usePoll<Status>(
    () => api.status(settings), statusInterval, ready && configured, boxKey);
  const units = usePoll<{ units: Unit[] }>(
    () => api.units(settings), 10000, ready && configured, boxKey);

  const s = status.data;
  const reachable = configured && status.error == null && s != null;
  const memPct = s ? Math.round((s.mem.used_mb / s.mem.total_mb) * 100) : 0;

  // The app did its job: a paired box answered. Counted at most once per launch
  // (noteBoxReachable guards); at EARNED_SESSIONS it earns a review ask.
  useEffect(() => {
    if (reachable) void noteBoxReachable();
  }, [reachable]);

  // How hard the box is working, 0..1. Skins use this to set the RATE of their
  // idle motion -- a busy box breathes faster. Never a colour input.
  const vitals = React.useMemo(
    () => ({ v: vitality(s?.load?.[0], s?.cpu_temp_c), alive: reachable }),
    [s?.load, s?.cpu_temp_c, reachable],
  );

  return (
    <VitalsContext.Provider value={vitals}>
    <View style={styles.screen}>
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={{
          paddingTop: 12,
          paddingBottom: 32,
          paddingHorizontal: 14,
        }}>
        <Screen>
        {/* Status header */}
        <View style={styles.header}>
          <Dot color={reachable ? t.green : t.red} size={14} live={reachable} />
          <Text style={styles.hostname}>
            {s?.hostname ?? (configured ? settings.host : 'Couchside')}
          </Text>
          <Text style={styles.headerSub}>
            {reachable ? `service v${s?.agent_version}` : configured ? 'offline' : 'not set up'}
          </Text>
        </View>

        {/* Fresh install: nothing paired yet, so nothing is "unreachable". */}
        {!configured && (
          <View style={styles.emptyCard}>
            <Text style={styles.emptyTitle}>No box configured</Text>
            <Text style={styles.emptyText}>
              Open the Setup tab to pair with the Couchside service on your media center,
              Steam machine, or PC — then add your TV for one remote that drives both.
            </Text>
          </View>
        )}

        {/* Unreachable banner: the whole point of this app. Wake lives in the
            top bar (RemotePowerBar), so this keeps just the retry. */}
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

        {/* Now Playing (MPRIS) — probe-and-appear; hidden when no media backend */}
        <NowPlayingCard />

        {/* Serving a Remote Play session (hidden unless one is live) */}
        <StreamHostCard />

        {/* Gaming card (probe-and-appear; hidden when the box has no Steam) */}
        <GamingCard />

        {s && (
          <>
            <View style={styles.row}>
              <View style={styles.half}>
                <Card title="CPU TEMP" index={0}>
                  <BigMetric
                    value={s.cpu_temp_c != null ? `${s.cpu_temp_c.toFixed(1)}°C` : '—'}
                    numeric={s.cpu_temp_c}
                    color={tempColor(s.cpu_temp_c, t)}
                  />
                  <Spark values={s.history?.temp} color={tempColor(s.cpu_temp_c, t)} />
                </Card>
              </View>
              <View style={styles.half}>
                <Card title="UPTIME" index={1}>
                  {/* Not numeric: "1d 2h 7m" must never be interpolated. */}
                  <BigMetric value={humanizeUptime(s.uptime_s)} numeric={null} color={t.text} />
                  {/* The address the phone actually reached the box on, straight
                      from the socket (agent >= 2.9.22). Worth showing because it
                      is what you need when mDNS breaks and the box has to be
                      re-added by IP — the exact moment the app is hardest to
                      use. Rides the poll that is already happening. */}
                  {s.ip ? <Text style={styles.ipLine}>{s.ip}</Text> : null}
                </Card>
              </View>
            </View>

            <Card title="LOAD 1m / 5m / 15m" index={2}>
              <View style={styles.loadRow}>
                {s.load.map((l, i) => (
                  <Text key={i} style={styles.loadVal}>
                    {l.toFixed(2)}
                  </Text>
                ))}
              </View>
              <Spark values={s.history?.load} color={t.blue} />
            </Card>

            <Card title="MEMORY" index={3}>
              <View style={styles.barLabelRow}>
                <Text style={styles.barLabel}>
                  {(s.mem.used_mb / 1024).toFixed(1)} / {(s.mem.total_mb / 1024).toFixed(1)} GB
                </Text>
                <Text style={[styles.barLabel, { color: pctColor(memPct, t) }]}>{memPct}%</Text>
              </View>
              <Bar pct={memPct} color={pctColor(memPct, t)} />
              {/* Fixed 0-100 scale: a memory sparkline that auto-scales would
                  make a 2% wiggle look like a cliff. */}
              <Spark values={s.history?.mem_pct} color={pctColor(memPct, t)} min={0} max={100} />
            </Card>

            <Card title="DISKS" index={4}>
              {s.disks.map((d) => (
                <View key={d.mount} style={styles.diskRow}>
                  <View style={styles.barLabelRow}>
                    <Text style={styles.diskMount}>{d.mount}</Text>
                    <Text style={styles.barLabel}>
                      {d.used_gb.toFixed(1)} / {d.total_gb.toFixed(1)} GB
                      {'   '}
                      <Text style={{ color: pctColor(d.pct, t) }}>{d.pct}%</Text>
                    </Text>
                  </View>
                  <Bar pct={d.pct} color={pctColor(d.pct, t)} />
                </View>
              ))}
            </Card>

            {/* Probe-and-appear: the agent OMITS `battery` on a mains desktop
                and on agents older than 2.9.40, so presence of the key is the
                whole gate -- no cap check, no placeholder, no "0%" on a machine
                that has no pack. */}
            {s.battery && (
              <Card title="BATTERY" index={5}>
                <View style={styles.barLabelRow}>
                  <Text style={styles.barLabel}>
                    {s.battery.on_ac ? 'On AC' : 'On battery'}
                    {s.battery.minutes != null
                      ? `   ${Math.floor(s.battery.minutes / 60)}h ${s.battery.minutes % 60}m left`
                      : ''}
                  </Text>
                  <Text style={[styles.barLabel, { color: batteryColor(s.battery.pct, t) }]}>
                    {s.battery.pct}%
                  </Text>
                </View>
                <Bar pct={s.battery.pct} color={batteryColor(s.battery.pct, t)} />
              </Card>
            )}
          </>
        )}

        {/* Live screen preview (probe-and-appear; hidden when no capture path) */}
        <ScreenPreview />

        {/* Units */}
        {configured && (
          <Card title="UNITS" index={5}>
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
            {/* The watchlist is box-side config, not app state — point at it so
                homelab users know they can watch their own services. */}
            <Text style={styles.unitHint}>
              watchlist: /etc/couchside/config.json on the box (units[]), then
              restart couchside.service
            </Text>
          </Card>
        )}
        </Screen>
      </ScrollView>
    </View>
    </VitalsContext.Provider>
  );
}

const makeStyles = (t: Palette) => StyleSheet.create({
  screen: { flex: 1, backgroundColor: t.bg },
  scroll: { flex: 1 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 12,
    gap: 10,
  },
  dot: { width: 14, height: 14, borderRadius: 7 },
  hostname: { color: t.text, fontSize: 26, fontWeight: '700', fontFamily: mono },
  headerSub: { color: t.textDim, fontSize: 13, marginLeft: 'auto' },
  emptyCard: {
    backgroundColor: t.card,
    borderColor: t.cardBorder,
    borderWidth: 1,
    borderRadius: 12,
    padding: 16,
    marginBottom: 12,
  },
  emptyTitle: { color: t.text, fontSize: 16, fontWeight: '700', marginBottom: 6 },
  emptyText: { color: t.textDim, fontSize: 13, lineHeight: 19 },
  banner: {
    backgroundColor: t.redDeep,
    borderColor: t.red,
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
    backgroundColor: t.red,
    paddingVertical: 12,
    paddingHorizontal: 36,
    borderRadius: 8,
  },
  retryText: { color: '#450a0a', fontWeight: '800', fontSize: 15, letterSpacing: 1 },
  pressed: { opacity: 0.7 },
  row: { flexDirection: 'row', gap: 10 },
  half: { flex: 1 },
  card: {
    backgroundColor: t.card,
    borderColor: t.cardBorder,
    borderWidth: 1,
    borderRadius: 12,
    padding: 14,
    marginBottom: 10,
  },
  cardTitle: {
    color: t.textFaint,
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 1.2,
    marginBottom: 8,
  },
  bigMetric: { fontSize: 28, fontWeight: '700', ...numeric },
  loadRow: { flexDirection: 'row', justifyContent: 'space-between' },
  // Deliberately quiet: the IP is reference information you go looking for,
  // not a vital you watch. Sized so it never competes with the uptime metric
  // above it.
  ipLine: {
    color: t.textFaint,
    fontSize: 11,
    textAlign: 'center',
    marginTop: 2,
    ...numeric,
  },
  loadVal: {
    color: t.text,
    fontSize: 22,
    fontWeight: '600',
    flex: 1,
    textAlign: 'center',
    ...numeric,
  },
  barLabelRow: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 6 },
  barLabel: { color: t.textDim, fontSize: 12, ...numeric },
  barTrack: {
    height: 10,
    borderRadius: 5,
    backgroundColor: t.inset,
    overflow: 'hidden',
  },
  barFill: { height: '100%', borderRadius: 5 },
  diskRow: { marginBottom: 12 },
  diskMount: { color: t.text, fontSize: 13, fontWeight: '600', fontFamily: mono },
  chips: { gap: 8 },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    borderWidth: 1,
    borderRadius: 8,
    paddingVertical: 10,
    paddingHorizontal: 12,
    backgroundColor: t.inset,
  },
  chipDot: { width: 8, height: 8, borderRadius: 4 },
  chipName: { color: t.text, fontSize: 13, fontFamily: mono, flexShrink: 1 },
  chipState: { fontSize: 12, marginLeft: 'auto', ...numeric },
  unitErr: { color: t.textDim, fontSize: 13 },
  unitHint: { color: t.textFaint, fontFamily: mono, fontSize: 10, marginTop: 10 },
});
