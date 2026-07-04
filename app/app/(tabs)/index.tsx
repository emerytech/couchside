import React from 'react';
import {
  Alert,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';

import { Gated } from '@/components/Gated';
import { TabScreen } from '@/components/TabScreen';
import { useLockOrientation } from '@/hooks/useLockOrientation';
import { usePoll } from '@/hooks/usePoll';
import { api, ConnSettings, humanizeUptime, Status, Tv, TvOp, Unit } from '@/lib/api';
import { hapticError, hapticLight, hapticSuccess } from '@/lib/haptics';
import { normalizeMac } from '@/lib/settings';
import { useSettings } from '@/lib/SettingsContext';
import { mono, numeric, pctColor, tempColor, theme } from '@/lib/theme';
import { sendWol, wolAvailable } from '@/lib/wol';

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

const TV_BACKEND_LABEL: Record<Tv['backend'], string> = {
  panel: 'RS-232',
  cec: 'CEC',
  soft: 'AUDIO',
};

/**
 * TV controls. Probe-and-appear: only rendered when the box reported a TV
 * backend (see ConsoleScreen). Danger-free single-tap: each button fires its
 * POST immediately (no confirm), like a real remote. Power is an optimistic
 * toggle: the agent has no power-state query, so we track it locally and start
 * "on" (the box is reachable, so the display is almost certainly awake). The
 * "soft" backend drives the box's own audio and has no power op, so the power
 * button is hidden when the backend's ops omit it.
 */
function TvStrip({ settings, tv }: { settings: ConnSettings; tv: Tv }) {
  const [tvOn, setTvOn] = React.useState(true);
  const [busy, setBusy] = React.useState(false);
  const [failed, setFailed] = React.useState(false);
  const hasPower = tv.ops ? tv.ops.includes('power_on') : true;

  const send = React.useCallback(
    async (op: TvOp) => {
      hapticLight();
      setBusy(true);
      setFailed(false);
      try {
        const r = await api.tvSend(settings, op);
        if (!r.ok) {
          setFailed(true);
          hapticError();
        }
      } catch {
        setFailed(true);
        hapticError();
      } finally {
        setBusy(false);
      }
    },
    [settings],
  );

  const onPower = React.useCallback(() => {
    const next = !tvOn;
    setTvOn(next);
    void send(next ? 'power_on' : 'power_off');
  }, [tvOn, send]);

  return (
    <View style={styles.card}>
      <View style={styles.tvHead}>
        <Text style={styles.cardTitle}>{tv.backend === 'soft' ? 'AUDIO' : 'TV'}</Text>
        <Text style={styles.tvBackend}>{TV_BACKEND_LABEL[tv.backend]}</Text>
        {failed && <Text style={styles.tvFailed}>no ack</Text>}
      </View>
      <View style={styles.tvRow}>
        {hasPower && (
          <Pressable
            disabled={busy}
            onPress={onPower}
            style={({ pressed }) => [
              styles.tvBtn,
              !tvOn && styles.tvBtnOff,
              pressed && styles.pressed,
            ]}>
            <Text style={[styles.tvGlyph, !tvOn && styles.tvGlyphOff]}>⏻</Text>
          </Pressable>
        )}
        <Pressable
          disabled={busy}
          onPress={() => send('volume_down')}
          style={({ pressed }) => [styles.tvBtn, pressed && styles.pressed]}>
          <Text style={styles.tvLabel}>VOL −</Text>
        </Pressable>
        <Pressable
          disabled={busy}
          onPress={() => send('mute')}
          style={({ pressed }) => [styles.tvBtn, pressed && styles.pressed]}>
          <Text style={styles.tvLabel}>MUTE</Text>
        </Pressable>
        <Pressable
          disabled={busy}
          onPress={() => send('volume_up')}
          style={({ pressed }) => [styles.tvBtn, pressed && styles.pressed]}>
          <Text style={styles.tvLabel}>VOL +</Text>
        </Pressable>
      </View>
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

/** Confirm dialog; on web, Alert buttons are no-ops so fall back to window.confirm. */
function confirmSuspend(message: string, onConfirm: () => void) {
  if (Platform.OS === 'web') {
    // eslint-disable-next-line no-alert
    if (typeof window !== 'undefined' && window.confirm(message)) onConfirm();
    return;
  }
  Alert.alert('Suspend box', message, [
    { text: 'Cancel', style: 'cancel' },
    { text: 'Suspend', style: 'default', onPress: onConfirm },
  ]);
}

/**
 * Box power control: suspend the box while it is reachable, then wake it with a
 * Wake-on-LAN magic packet after it goes offline. Suspend is offered only on a
 * wired box, because WoL cannot wake it back up over WiFi; on WiFi the button
 * is disabled with that reason. The Wake button lives in the unreachable banner
 * (that is when you need it), so this card only owns the suspend half.
 */
function BoxPowerCard({
  settings,
  net,
}: {
  settings: ReturnType<typeof useSettings>['settings'];
  net?: Status['net'];
}) {
  const wired = net?.wired;
  const wolArmed = net?.wol_armed;
  const canSuspend = wired !== false; // allow when wired or unknown, block on WiFi

  const onSuspend = React.useCallback(() => {
    hapticLight();
    confirmSuspend(
      'Put the box to sleep? It will drop offline; wake it with the Wake button that appears here.',
      () => {
        void (async () => {
          try {
            await api.runAction(settings, 'suspend');
          } catch {
            // The box usually drops the connection mid-suspend, so a transport
            // error here is expected; the unreachable banner takes over.
          }
        })();
      },
    );
  }, [settings]);

  return (
    <View style={styles.card}>
      <Text style={styles.cardTitle}>BOX POWER</Text>
      <Pressable
        disabled={!canSuspend}
        onPress={onSuspend}
        style={({ pressed }) => [
          styles.powerBtn,
          !canSuspend && styles.powerBtnDisabled,
          pressed && styles.pressed,
        ]}>
        <Text style={[styles.powerLabel, !canSuspend && styles.powerLabelDim]}>SUSPEND</Text>
      </Pressable>
      <Text style={styles.powerNote}>
        {!canSuspend
          ? 'Suspend needs wired Ethernet: Wake-on-LAN cannot wake the box over WiFi.'
          : !settings.mac
            ? 'Sleeps the box. The MAC needed to wake it is learned on the next status refresh.'
            : wolArmed === false
              ? 'Sleeps the box. Wake-on-LAN looks disabled in the OS, so enable it to wake remotely.'
              : 'Sleeps the box. Wake it with the button in the offline banner.'}
      </Text>
    </View>
  );
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
  const { settings, ready, update } = useSettings();

  // No host yet (fresh install): don't poll, and show the pairing hint
  // instead of the unreachable banner.
  const configured = settings.host.trim().length > 0;

  const status = usePoll<Status>(() => api.status(settings), 5000, ready && configured);
  const units = usePoll<{ units: Unit[] }>(() => api.units(settings), 10000, ready && configured);

  const s = status.data;
  const reachable = configured && status.error == null && s != null;
  const memPct = s ? Math.round((s.mem.used_mb / s.mem.total_mb) * 100) : 0;

  // TV-control probe-and-appear: fetch GET /api/tv once each time a box becomes
  // reachable (re-probed on box switch via the host:port key). The route 404s
  // on boxes without a TV backend, so `tv` stays null and no strip shows.
  const [tv, setTv] = React.useState<Tv | null>(null);
  const tvProbedFor = React.useRef<string | null>(null);
  React.useEffect(() => {
    if (!reachable) {
      tvProbedFor.current = null; // reprobe on the next reconnect
      return;
    }
    const key = `${settings.host}:${settings.port}`;
    if (tvProbedFor.current === key) return;
    tvProbedFor.current = key;
    let cancelled = false;
    api
      .tv(settings)
      .then((t) => {
        if (!cancelled) setTv(t.available ? t : null);
      })
      .catch(() => {
        if (!cancelled) setTv(null);
      });
    return () => {
      cancelled = true;
    };
  }, [reachable, settings]);

  // Learn the box MAC from status so Wake-on-LAN works after it goes offline.
  React.useEffect(() => {
    const mac = normalizeMac(s?.net?.mac);
    if (mac && mac !== settings.mac) void update({ mac });
  }, [s?.net?.mac, settings.mac, update]);

  // Probe once per reachable connect whether this box exposes the suspend
  // action (agent >= 2.6 with the sudoers rule); the power card gates on it.
  const [hasSuspend, setHasSuspend] = React.useState(false);
  const suspendProbedFor = React.useRef<string | null>(null);
  React.useEffect(() => {
    if (!reachable) {
      suspendProbedFor.current = null;
      return;
    }
    const key = `${settings.host}:${settings.port}`;
    if (suspendProbedFor.current === key) return;
    suspendProbedFor.current = key;
    let cancelled = false;
    api
      .actions(settings)
      .then((r) => {
        if (!cancelled) setHasSuspend(r.actions.some((a) => a.id === 'suspend'));
      })
      .catch(() => {
        if (!cancelled) setHasSuspend(false);
      });
    return () => {
      cancelled = true;
    };
  }, [reachable, settings]);

  // Wake-on-LAN: broadcast a magic packet to the offline box, then re-probe.
  const [waking, setWaking] = React.useState(false);
  const onWake = React.useCallback(() => {
    const mac = settings.mac;
    if (!mac) return;
    hapticLight();
    setWaking(true);
    void (async () => {
      try {
        const ok = await sendWol(mac, { ip: settings.lastIp });
        if (ok) {
          hapticSuccess();
          status.refresh();
        } else {
          hapticError();
          Alert.alert('Wake failed', 'No magic packet could be sent on this network.');
        }
      } catch (e: unknown) {
        hapticError();
        Alert.alert('Wake failed', e instanceof Error ? e.message : String(e));
      } finally {
        setWaking(false);
      }
    })();
  }, [settings.mac, settings.lastIp, status]);

  return (
    <ScrollView
      style={styles.screen}
      contentContainerStyle={{
        paddingTop: 12,
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
          {s?.hostname ?? (configured ? settings.host : 'Couchside')}
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
            Open the Setup tab to pair with the Couchside agent on your media center or Steam
            machine.
          </Text>
        </View>
      )}

      {/* Unreachable banner: the whole point of this app */}
      {configured && status.error != null && (
        <View style={styles.banner}>
          <Text style={styles.bannerTitle}>BOX UNREACHABLE</Text>
          <Text style={styles.bannerDetail}>{status.error.message}</Text>
          <Text style={styles.bannerDetail}>
            last seen: {fmtLastSeen(status.lastSuccess)}
          </Text>
          <View style={styles.bannerBtnRow}>
            <Pressable
              style={({ pressed }) => [styles.retryBtn, pressed && styles.pressed]}
              onPress={() => {
                status.refresh();
                units.refresh();
              }}>
              <Text style={styles.retryText}>RETRY</Text>
            </Pressable>
            {settings.mac && wolAvailable && (
              <Pressable
                disabled={waking}
                style={({ pressed }) => [styles.wakeBtn, pressed && styles.pressed]}
                onPress={onWake}>
                <Text style={styles.wakeText}>{waking ? 'WAKING…' : 'WAKE BOX'}</Text>
              </Pressable>
            )}
          </View>
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

      {/* Box power: suspend (wired boxes) + Wake-on-LAN. Only when the agent
          exposes the suspend action. */}
      {reachable && hasSuspend && s && (
        <BoxPowerCard settings={settings} net={s.net} />
      )}

      {/* TV controls: only when the box reported a TV backend. Keyed by box
          identity so TvStrip remounts on a box switch (its optimistic power
          state must not carry over to a different box). */}
      {reachable && tv?.available && (
        <TvStrip key={`${settings.host}:${settings.port}`} settings={settings} tv={tv} />
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
  bannerBtnRow: { flexDirection: 'row', gap: 10, marginTop: 12 },
  wakeBtn: {
    backgroundColor: theme.green,
    paddingVertical: 12,
    paddingHorizontal: 28,
    borderRadius: 8,
  },
  wakeText: { color: '#052e16', fontWeight: '800', fontSize: 15, letterSpacing: 1 },
  powerBtn: {
    height: 46,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: theme.cardBorder,
    backgroundColor: theme.inset,
    alignItems: 'center',
    justifyContent: 'center',
  },
  powerBtnDisabled: { opacity: 0.5 },
  powerLabel: {
    color: theme.amber,
    fontSize: 15,
    fontWeight: '800',
    letterSpacing: 1.5,
    ...numeric,
  },
  powerLabelDim: { color: theme.textFaint },
  powerNote: { color: theme.textDim, fontSize: 12, lineHeight: 17, marginTop: 8 },
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
  tvHead: { flexDirection: 'row', alignItems: 'center', marginBottom: 8 },
  tvBackend: {
    color: theme.textFaint,
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 1,
    marginLeft: 'auto',
    ...numeric,
  },
  tvFailed: {
    color: theme.red,
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 1,
    marginLeft: 8,
  },
  tvRow: { flexDirection: 'row', gap: 8 },
  tvBtn: {
    flex: 1,
    height: 46,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: theme.cardBorder,
    backgroundColor: theme.inset,
    alignItems: 'center',
    justifyContent: 'center',
  },
  tvBtnOff: { borderColor: theme.slate, backgroundColor: theme.bg },
  tvGlyph: { color: theme.green, fontSize: 20, fontWeight: '700' },
  tvGlyphOff: { color: theme.slate },
  tvLabel: { color: theme.text, fontSize: 13, fontWeight: '700', ...numeric },
});
