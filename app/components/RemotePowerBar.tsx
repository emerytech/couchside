import React from 'react';
import { Alert, Platform, Pressable, StyleSheet, Text, View } from 'react-native';

import { usePoll } from '@/hooks/usePoll';
import { api, Status, Tv, TvOp } from '@/lib/api';
import { hapticError, hapticLight, hapticSuccess } from '@/lib/haptics';
import { normalizeMac } from '@/lib/settings';
import { useSettings } from '@/lib/SettingsContext';
import { numeric, theme } from '@/lib/theme';
import { sendWol, wolAvailable } from '@/lib/wol';

/** Confirm dialog; on web Alert buttons are no-ops, so use window.confirm there. */
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
 * The remote control strip that sits at the top of the Console and Pad screens.
 * It owns the box power button (suspend while the box is reachable, Wake-on-LAN
 * once it has gone offline) and, when the agent reports a TV/audio backend, the
 * TV power toggle and volume. Self-contained: it runs its own status poll and
 * probes, so a screen only has to drop it in. Renders nothing until there is
 * something to control, so it never shows an empty bar.
 */
export function RemotePowerBar() {
  const { settings, ready, update } = useSettings();
  const configured = settings.host.trim().length > 0;

  const status = usePoll<Status>(() => api.status(settings), 5000, ready && configured);
  const s = status.data;
  const reachable = configured && status.error == null && s != null;

  // Learn the box MAC from status so Wake-on-LAN works after it goes offline.
  React.useEffect(() => {
    const mac = normalizeMac(s?.net?.mac);
    if (mac && mac !== settings.mac) void update({ mac });
  }, [s?.net?.mac, settings.mac, update]);

  // TV/audio backend probe (volume, and TV power on panel/CEC), once per connect.
  const [tv, setTv] = React.useState<Tv | null>(null);
  const tvProbedFor = React.useRef<string | null>(null);
  React.useEffect(() => {
    if (!reachable) {
      tvProbedFor.current = null;
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

  // Suspend-action availability, once per connect (agent >= 2.6 with the rule).
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

  const [busy, setBusy] = React.useState(false);
  const [tvOn, setTvOn] = React.useState(true);
  const [waking, setWaking] = React.useState(false);

  const sendTv = React.useCallback(
    async (op: TvOp) => {
      hapticLight();
      setBusy(true);
      try {
        await api.tvSend(settings, op);
      } catch {
        hapticError();
      } finally {
        setBusy(false);
      }
    },
    [settings],
  );

  const onTvPower = React.useCallback(() => {
    const next = !tvOn;
    setTvOn(next);
    void sendTv(next ? 'power_on' : 'power_off');
  }, [tvOn, sendTv]);

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
            // error here is expected.
          }
        })();
      },
    );
  }, [settings]);

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

  if (!ready || !configured) return null;

  const wired = s?.net?.wired;
  const hasVolume = reachable && tv?.available === true;
  const hasTvPower = hasVolume && (tv?.ops ? tv.ops.includes('power_on') : true);
  const canSuspend = reachable && hasSuspend;
  const canWake = !reachable && !!settings.mac && wolAvailable;

  // Nothing to control on this box right now: render nothing, not an empty bar.
  if (!canSuspend && !canWake && !hasVolume) return null;

  return (
    <View style={styles.bar}>
      {canWake && (
        <Pressable
          disabled={waking}
          onPress={onWake}
          style={({ pressed }) => [styles.btn, styles.wakeBtn, pressed && styles.pressed]}>
          <Text style={styles.wakeText}>{waking ? '…' : 'WAKE'}</Text>
        </Pressable>
      )}
      {canSuspend && (
        <Pressable
          disabled={wired === false}
          onPress={onSuspend}
          style={({ pressed }) => [
            styles.btn,
            wired === false && styles.btnDisabled,
            pressed && styles.pressed,
          ]}>
          <Text style={[styles.powerText, wired === false && styles.dim]}>
            {wired === false ? 'WIFI' : 'SLEEP'}
          </Text>
        </Pressable>
      )}

      {hasVolume && <View style={styles.spacer} />}

      {hasTvPower && (
        <Pressable
          disabled={busy}
          onPress={onTvPower}
          style={({ pressed }) => [styles.btn, pressed && styles.pressed]}>
          <Text style={[styles.glyph, !tvOn && styles.dim]}>⏻</Text>
        </Pressable>
      )}
      {hasVolume && (
        <>
          <Pressable
            disabled={busy}
            onPress={() => sendTv('volume_down')}
            style={({ pressed }) => [styles.btn, pressed && styles.pressed]}>
            <Text style={styles.label}>VOL −</Text>
          </Pressable>
          <Pressable
            disabled={busy}
            onPress={() => sendTv('mute')}
            style={({ pressed }) => [styles.btn, pressed && styles.pressed]}>
            <Text style={styles.label}>MUTE</Text>
          </Pressable>
          <Pressable
            disabled={busy}
            onPress={() => sendTv('volume_up')}
            style={({ pressed }) => [styles.btn, pressed && styles.pressed]}>
            <Text style={styles.label}>VOL +</Text>
          </Pressable>
        </>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  bar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 8,
    backgroundColor: theme.card,
    borderBottomWidth: 1,
    borderBottomColor: theme.cardBorder,
  },
  spacer: { flex: 1 },
  btn: {
    minWidth: 44,
    height: 40,
    paddingHorizontal: 10,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: theme.cardBorder,
    backgroundColor: theme.inset,
    alignItems: 'center',
    justifyContent: 'center',
  },
  btnDisabled: { opacity: 0.45 },
  powerText: {
    color: theme.amber,
    fontSize: 13,
    fontWeight: '800',
    letterSpacing: 1,
    ...numeric,
  },
  glyph: { color: theme.green, fontSize: 18, fontWeight: '700' },
  label: { color: theme.text, fontSize: 13, fontWeight: '700', ...numeric },
  dim: { color: theme.slate },
  wakeBtn: { backgroundColor: theme.green, borderColor: theme.green },
  wakeText: {
    color: '#052e16',
    fontSize: 13,
    fontWeight: '800',
    letterSpacing: 1,
    ...numeric,
  },
  pressed: { opacity: 0.7 },
});
