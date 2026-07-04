import Ionicons from '@expo/vector-icons/Ionicons';
import React from 'react';
import { Alert, Modal, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { usePoll } from '@/hooks/usePoll';
import { api, Status, Tv, TvOp, VolumeTarget } from '@/lib/api';
import { hapticError, hapticLight, hapticSuccess } from '@/lib/haptics';
import { getPref, usePref } from '@/lib/prefs';
import { normalizeMac } from '@/lib/settings';
import { useSettings } from '@/lib/SettingsContext';
import { mono, theme } from '@/lib/theme';
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

/**
 * Power + volume controls for the header row (right of the box picker). A
 * compact trigger opens a dropdown (like the box switcher) with big buttons:
 * box power that adapts to reachability (suspend while up, Wake-on-LAN once
 * offline, blocked on WiFi), and volume/mute when the agent reports a backend.
 * Self-contained (own status poll + probes); renders nothing when there is
 * nothing to control.
 */
export function RemotePowerBar() {
  const insets = useSafeAreaInsets();
  const { settings, ready, update } = useSettings();
  const configured = settings.host.trim().length > 0;
  const [open, setOpen] = React.useState(false);

  const statusInterval = usePref('statusIntervalMs');
  const status = usePoll<Status>(() => api.status(settings), statusInterval, ready && configured);
  const s = status.data;
  const reachable = configured && status.error == null && s != null;

  // Learn the box MAC from status so Wake-on-LAN works after it goes offline.
  React.useEffect(() => {
    const mac = normalizeMac(s?.net?.mac);
    if (mac && mac !== settings.mac) void update({ mac });
  }, [s?.net?.mac, settings.mac, update]);

  // TV/audio backend + mute state. Polled (not probed once per connect) so the
  // mute indicator self-heals when the box is muted out of band (controller,
  // keyboard, a stale seed), and a TV backend appearing/disappearing shows up
  // without a reconnect. api.tv 404s when there is no backend, which surfaces
  // as tvPoll.error, so tv stays null there.
  const tvPoll = usePoll<Tv>(() => api.tv(settings), 5000, reachable);
  const refreshTv = tvPoll.refresh;
  const tv = reachable && tvPoll.error == null && tvPoll.data?.available ? tvPoll.data : null;
  const muted = tv?.muted ?? null;

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
        await api.tvSend(settings, op, settings.volumeTarget ?? 'box');
        // Volume keys can clear the mute flag (dropping to 0 sets it), so
        // re-read state now rather than waiting out the poll tick.
        refreshTv();
      } catch {
        hapticError();
      } finally {
        setBusy(false);
      }
    },
    [settings, refreshTv],
  );

  // TV power goes to the panel/CEC backend regardless of the volume target
  // (the agent ignores target for power ops).
  const sendPower = React.useCallback(
    async (op: 'power_on' | 'power_off') => {
      hapticLight();
      setBusy(true);
      try {
        await api.tvSend(settings, op);
        // The TV gives no on-screen confirmation of a power command, so buzz.
        hapticSuccess();
      } catch {
        hapticError();
      } finally {
        setBusy(false);
      }
    },
    [settings],
  );

  // Mute returns the new state so the button can show it (gamescope has no
  // mute OSD on the panel, so this is the only feedback).
  const onMute = React.useCallback(async () => {
    hapticLight();
    setBusy(true);
    try {
      await api.tvSend(settings, 'mute', settings.volumeTarget ?? 'box');
      // Re-read the mute state immediately so the button reflects it in ~100ms
      // instead of on the next poll tick.
      refreshTv();
    } catch {
      hapticError();
    } finally {
      setBusy(false);
    }
  }, [settings, refreshTv]);

  const onSuspend = React.useCallback(() => {
    hapticLight();
    const runSuspend = () => {
      void (async () => {
        try {
          await api.runAction(settings, 'suspend');
        } catch {
          // The box usually drops the connection mid-suspend; expected.
        }
      })();
    };
    // Skippable confirmation: on for the cautious, off for one-tap nightly sleep.
    if (getPref('confirmSuspend')) {
      confirmSuspend(
        'Put the box to sleep? It will drop offline; wake it with the power button here.',
        runSuspend,
      );
    } else {
      runSuspend();
    }
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
  const wolArmed = s?.net?.wol_armed;
  const boxVol = tv?.box_volume ?? false;
  // Old agents (< 2.6.2) don't split volume; treat an available backend as TV volume.
  const tvVol = tv?.tv_volume ?? tv?.available === true;
  const hasVolume = reachable && (boxVol || tvVol);
  const canToggleVolume = boxVol && tvVol;
  const volumeTarget: VolumeTarget = settings.volumeTarget ?? 'box';
  const hasTvPower = reachable && tv?.tv_power === true;
  const canSuspend = reachable && hasSuspend;
  const canWake = !reachable && !!settings.mac && wolAvailable;

  // Nothing to control on this box right now.
  if (!canSuspend && !canWake && !hasVolume && !hasTvPower) return null;

  // Trigger icon hints at what's inside: volume first, then box power, then TV.
  const triggerIcon: IoniconName = hasVolume
    ? 'volume-high'
    : canWake
    ? 'power'
    : canSuspend
    ? 'moon'
    : 'tv-outline';

  return (
    <>
      <Pressable
        onPress={() => {
          hapticLight();
          setOpen(true);
        }}
        hitSlop={8}
        style={({ pressed }) => [styles.trigger, pressed && styles.pressed]}>
        <Ionicons name={triggerIcon} size={20} color={theme.text} />
        <Ionicons name="chevron-down" size={14} color={theme.textDim} />
      </Pressable>

      <Modal
        visible={open}
        transparent
        animationType="fade"
        onRequestClose={() => setOpen(false)}>
        <Pressable style={styles.backdrop} onPress={() => setOpen(false)}>
          <View style={[styles.dropWrap, { paddingTop: insets.top + 8 }]}>
            <Pressable style={styles.card} onPress={() => {}}>
              {canWake && (
                <Pressable
                  disabled={waking}
                  onPress={() => {
                    setOpen(false);
                    onWake();
                  }}
                  style={({ pressed }) => [styles.bigBtn, pressed && styles.pressed]}>
                  <Ionicons name="power" size={22} color={theme.green} />
                  <Text style={[styles.bigLabel, { color: theme.green }]}>
                    {waking ? 'Waking…' : 'Wake box'}
                  </Text>
                </Pressable>
              )}

              {canSuspend && (
                <View style={styles.suspendGroup}>
                  <Pressable
                    disabled={wired === false}
                    onPress={() => {
                      setOpen(false);
                      onSuspend();
                    }}
                    style={({ pressed }) => [
                      styles.bigBtn,
                      wired === false && styles.disabled,
                      pressed && styles.pressed,
                    ]}>
                    <Ionicons name="moon" size={22} color={theme.amber} />
                    <Text style={[styles.bigLabel, { color: theme.amber }]}>
                      {wired === false ? 'Suspend (needs Ethernet)' : 'Suspend'}
                    </Text>
                  </Pressable>
                  {wired !== false && wolArmed === false && (
                    <Text style={styles.warnText}>
                      Wake-on-LAN is not armed on this box. It will sleep, but the
                      Wake button may not bring it back.
                    </Text>
                  )}
                </View>
              )}

              {hasTvPower && (
                <View style={styles.tvPowerRow}>
                  <Pressable
                    disabled={busy}
                    onPress={() => sendPower('power_on')}
                    style={({ pressed }) => [styles.tvBtn, pressed && styles.pressed]}>
                    <Ionicons name="power" size={18} color={theme.green} />
                    <Text style={[styles.tvBtnText, { color: theme.green }]}>TV On</Text>
                  </Pressable>
                  <Pressable
                    disabled={busy}
                    onPress={() => sendPower('power_off')}
                    style={({ pressed }) => [styles.tvBtn, pressed && styles.pressed]}>
                    <Ionicons name="power-outline" size={18} color={theme.textDim} />
                    <Text style={[styles.tvBtnText, { color: theme.textDim }]}>TV Off</Text>
                  </Pressable>
                </View>
              )}

              {hasVolume && (
                <>
                  {canToggleVolume && (
                    <View style={styles.segRow}>
                      <Pressable
                        onPress={() => void update({ volumeTarget: 'box' })}
                        style={[styles.seg, volumeTarget === 'box' && styles.segActive]}>
                        <Text style={[styles.segText, volumeTarget === 'box' && styles.segTextActive]}>
                          Box
                        </Text>
                      </Pressable>
                      <Pressable
                        onPress={() => void update({ volumeTarget: 'tv' })}
                        style={[styles.seg, volumeTarget === 'tv' && styles.segActive]}>
                        <Text style={[styles.segText, volumeTarget === 'tv' && styles.segTextActive]}>
                          TV
                        </Text>
                      </Pressable>
                    </View>
                  )}
                  <View style={styles.volRow}>
                    <Pressable
                      disabled={busy}
                      onPress={() => sendTv('volume_down')}
                      style={({ pressed }) => [styles.volBtn, pressed && styles.pressed]}>
                      <Ionicons name="volume-low" size={24} color={theme.text} />
                    </Pressable>
                    <Pressable
                      disabled={busy}
                      onPress={onMute}
                      style={({ pressed }) => [
                        styles.volBtn,
                        muted && styles.volBtnMuted,
                        pressed && styles.pressed,
                      ]}>
                      <Ionicons
                        name={muted ? 'volume-mute' : 'volume-medium'}
                        size={24}
                        color={muted ? theme.red : theme.text}
                      />
                    </Pressable>
                    <Pressable
                      disabled={busy}
                      onPress={() => sendTv('volume_up')}
                      style={({ pressed }) => [styles.volBtn, pressed && styles.pressed]}>
                      <Ionicons name="volume-high" size={24} color={theme.text} />
                    </Pressable>
                  </View>
                </>
              )}
            </Pressable>
          </View>
        </Pressable>
      </Modal>
    </>
  );
}

const styles = StyleSheet.create({
  trigger: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 2,
    paddingVertical: 8,
    paddingHorizontal: 10,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: theme.cardBorder,
    backgroundColor: theme.card,
  },
  pressed: { opacity: 0.6 },
  disabled: { opacity: 0.45 },
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.35)' },
  dropWrap: { paddingHorizontal: 14, alignItems: 'flex-end' },
  card: {
    width: 260,
    maxWidth: '100%',
    backgroundColor: theme.card,
    borderColor: theme.cardBorder,
    borderWidth: 1,
    borderRadius: 14,
    padding: 8,
    gap: 8,
    shadowColor: '#000',
    shadowOpacity: 0.4,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: 8 },
    elevation: 8,
  },
  bigBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    height: 52,
    paddingHorizontal: 14,
    borderRadius: 10,
    backgroundColor: theme.inset,
  },
  bigLabel: { fontSize: 15, fontWeight: '800', fontFamily: mono, letterSpacing: 0.5 },
  suspendGroup: { gap: 6 },
  warnText: {
    color: theme.amber,
    fontSize: 11,
    fontFamily: mono,
    lineHeight: 15,
    paddingHorizontal: 4,
  },
  tvPowerRow: { flexDirection: 'row', gap: 8 },
  tvBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    height: 48,
    borderRadius: 10,
    backgroundColor: theme.inset,
  },
  tvBtnText: { fontSize: 14, fontWeight: '800', fontFamily: mono, letterSpacing: 0.5 },
  volRow: { flexDirection: 'row', gap: 8 },
  volBtn: {
    flex: 1,
    height: 56,
    borderRadius: 10,
    backgroundColor: theme.inset,
    alignItems: 'center',
    justifyContent: 'center',
  },
  volBtnMuted: { backgroundColor: theme.redDeep, borderWidth: 1, borderColor: theme.red },
  segRow: {
    flexDirection: 'row',
    gap: 2,
    padding: 2,
    borderRadius: 10,
    backgroundColor: theme.inset,
  },
  seg: { flex: 1, paddingVertical: 8, borderRadius: 8, alignItems: 'center' },
  segActive: { backgroundColor: theme.card },
  segText: { color: theme.textDim, fontSize: 13, fontWeight: '700', fontFamily: mono },
  segTextActive: { color: theme.text },
});
