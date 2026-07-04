import Ionicons from '@expo/vector-icons/Ionicons';
import React from 'react';
import { Alert, Platform, Pressable, StyleSheet, View } from 'react-native';

import { usePoll } from '@/hooks/usePoll';
import { api, Status, Tv, TvOp } from '@/lib/api';
import { hapticError, hapticLight, hapticSuccess } from '@/lib/haptics';
import { normalizeMac } from '@/lib/settings';
import { useSettings } from '@/lib/SettingsContext';
import { theme } from '@/lib/theme';
import { sendWol, wolAvailable } from '@/lib/wol';

type IoniconName = React.ComponentProps<typeof Ionicons>['name'];

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

function IconBtn({
  name,
  color,
  onPress,
  disabled,
}: {
  name: IoniconName;
  color: string;
  onPress: () => void;
  disabled?: boolean;
}) {
  return (
    <Pressable
      disabled={disabled}
      onPress={onPress}
      hitSlop={6}
      style={({ pressed }) => [styles.iconBtn, disabled && styles.disabled, pressed && styles.pressed]}>
      <Ionicons name={name} size={20} color={color} />
    </Pressable>
  );
}

/**
 * Compact power + volume controls for the header row (right of the box picker,
 * on every tab). Box power adapts to reachability: a moon (suspend) while the
 * box is reachable, a power icon (Wake-on-LAN) once it has gone offline, dimmed
 * on a WiFi box that WoL cannot wake. Volume/mute appear when the agent reports
 * a TV or audio backend. Self-contained (its own status poll and probes), and
 * it renders nothing when there is nothing to control.
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

  // TV/audio backend probe (volume), once per connect.
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

  const onSuspend = React.useCallback(() => {
    hapticLight();
    confirmSuspend(
      'Put the box to sleep? It will drop offline; wake it with the power button here.',
      () => {
        void (async () => {
          try {
            await api.runAction(settings, 'suspend');
          } catch {
            // The box usually drops the connection mid-suspend; expected.
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
  const canSuspend = reachable && hasSuspend;
  const canWake = !reachable && !!settings.mac && wolAvailable;

  // Nothing to control on this box right now: render nothing.
  if (!canSuspend && !canWake && !hasVolume) return null;

  return (
    <View style={styles.group}>
      {canWake && (
        <IconBtn name="power" color={theme.green} onPress={onWake} disabled={waking} />
      )}
      {canSuspend && (
        <IconBtn
          name="moon"
          color={wired === false ? theme.slate : theme.amber}
          onPress={onSuspend}
          disabled={wired === false}
        />
      )}
      {hasVolume && (
        <>
          <IconBtn name="volume-low" color={theme.text} onPress={() => sendTv('volume_down')} disabled={busy} />
          <IconBtn name="volume-mute" color={theme.text} onPress={() => sendTv('mute')} disabled={busy} />
          <IconBtn name="volume-high" color={theme.text} onPress={() => sendTv('volume_up')} disabled={busy} />
        </>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  group: { flexDirection: 'row', alignItems: 'center', gap: 2 },
  iconBtn: {
    width: 36,
    height: 36,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  disabled: { opacity: 0.4 },
  pressed: { opacity: 0.6 },
});
