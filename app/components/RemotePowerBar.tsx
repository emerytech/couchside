import Ionicons from '@expo/vector-icons/Ionicons';
import React from 'react';
import { Alert, Modal, PanResponder, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
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

const STEP_PX = 14; // horizontal drag distance per one volume step
const STEP_MIN_MS = 55; // floor between fired steps, so a fast drag can't flood

/**
 * Relative "jog" volume slider revealed by holding the mute button. Dragging the
 * thumb fires volume up/down steps in the drag direction — there is no absolute
 * level because SteamOS Game Mode (box audio) and this Newline panel both refuse
 * a reliable absolute set, so relative stepping is the one path that works on box
 * media-keys, RS-232, and CEC alike. The thumb tracks the finger and springs
 * back to center on release (it is a jog, not a position slider).
 */
function VolumeSlider({ onStep, onDone }: { onStep: (dir: 1 | -1) => void; onDone: () => void }) {
  const [w, setW] = React.useState(0);
  const [frac, setFrac] = React.useState(0.5);
  const acc = React.useRef(0); // px accumulated since the last fired step
  const lastX = React.useRef<number | null>(null);
  const lastFire = React.useRef(0);

  const fire = React.useCallback(
    (x: number) => {
      if (lastX.current == null) {
        lastX.current = x;
        return;
      }
      acc.current += x - lastX.current;
      lastX.current = x;
      const now = Date.now();
      if (now - lastFire.current < STEP_MIN_MS) return; // rate cap for the box
      // Emit every whole step the accumulator holds (not just one), so a fast
      // drag or a drag-then-stop applies the full change instead of stranding
      // steps until the next move event. Cap the burst so one huge jump can't
      // flood the box; the sub-step remainder carries in `acc`.
      const steps = Math.trunc(acc.current / STEP_PX);
      if (steps === 0) return;
      const dir: 1 | -1 = steps > 0 ? 1 : -1;
      const n = Math.min(Math.abs(steps), 4);
      for (let i = 0; i < n; i++) onStep(dir);
      acc.current -= dir * STEP_PX * n;
      lastFire.current = now;
    },
    [onStep],
  );

  const end = React.useCallback(() => {
    lastX.current = null;
    acc.current = 0;
    setFrac(0.5);
    onDone();
  }, [onDone]);

  const pan = React.useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: () => true,
        onPanResponderGrant: (e) => {
          lastX.current = e.nativeEvent.locationX;
          acc.current = 0;
          if (w > 0) setFrac(Math.max(0, Math.min(1, e.nativeEvent.locationX / w)));
        },
        onPanResponderMove: (e) => {
          const x = e.nativeEvent.locationX;
          if (w > 0) setFrac(Math.max(0, Math.min(1, x / w)));
          fire(x);
        },
        onPanResponderRelease: end,
        onPanResponderTerminate: end,
      }),
    [w, fire, end],
  );

  return (
    <View style={styles.sliderRow}>
      <Ionicons name="volume-low" size={18} color={theme.textDim} />
      <View
        style={styles.sliderTrack}
        onLayout={(e) => setW(e.nativeEvent.layout.width)}
        {...pan.panHandlers}>
        <View pointerEvents="none" style={[styles.sliderThumb, { left: `${frac * 100}%` }]} />
      </View>
      <Ionicons name="volume-high" size={18} color={theme.textDim} />
    </View>
  );
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
  const [sliderOpen, setSliderOpen] = React.useState(false);
  // Collapse the hold-to-reveal volume slider whenever the dropdown closes.
  React.useEffect(() => {
    if (!open) setSliderOpen(false);
  }, [open]);

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

  // Fire-and-forget volume step for the drag slider. Deliberately bypasses the
  // `busy` flag (toggling it per step would flicker every other button) and the
  // per-op mute refresh; the slider refreshes mute once, on release (onDone).
  const stepErrAt = React.useRef(0);
  const stepVolume = React.useCallback(
    (dir: 1 | -1) => {
      void api
        .tvSend(settings, dir > 0 ? 'volume_up' : 'volume_down', settings.volumeTarget ?? 'box')
        .catch(() => {
          // Fire-and-forget, but don't fail totally silently: buzz at most once
          // every ~1.5s so a drag against an offline box gives some feedback.
          const now = Date.now();
          if (now - stepErrAt.current > 1500) {
            stepErrAt.current = now;
            hapticError();
          }
        });
    },
    [settings],
  );

  // Jump the panel's input back to the box's OPS slot (RS-232 panel only).
  const onSwitchToBox = React.useCallback(async () => {
    hapticLight();
    setBusy(true);
    try {
      await api.tvSource(settings);
      hapticSuccess();
    } catch {
      hapticError();
    } finally {
      setBusy(false);
    }
  }, [settings]);

  // Blank/unblank the panel without cutting power, so the box keeps running
  // (RS-232 panel only — on an OPS display, real power-off would kill the box).
  const onBlankScreen = React.useCallback(async () => {
    hapticLight();
    setBusy(true);
    try {
      await api.tvScreenToggle(settings);
      hapticSuccess();
    } catch {
      hapticError();
    } finally {
      setBusy(false);
    }
  }, [settings]);

  // Switch the display to a specific input (RS-232 panel source picker).
  const onSelectSource = React.useCallback(
    async (id: string) => {
      hapticLight();
      setBusy(true);
      try {
        await api.tvSelectSource(settings, id);
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
  // RS-232-only capabilities (panel backend). Gated so CEC/soft boxes never
  // show these buttons — they keep the standard power/volume UI.
  const sources = (reachable && tv?.sources) || [];
  const canSourceBox = reachable && tv?.source_box === true;
  const canBlankScreen = reachable && tv?.screen_toggle === true;
  const canSuspend = reachable && hasSuspend;
  const canWake = !reachable && !!settings.mac && wolAvailable;

  // Nothing to control on this box right now.
  if (
    !canSuspend &&
    !canWake &&
    !hasVolume &&
    !hasTvPower &&
    !canSourceBox &&
    !canBlankScreen &&
    sources.length === 0
  )
    return null;

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

              {sources.length > 0 ? (
                <View style={styles.sourceSection}>
                  <Text style={styles.sourceHdr}>SOURCE</Text>
                  <View style={styles.sourceGrid}>
                    {sources.map((s) => (
                      <Pressable
                        key={s.id}
                        disabled={busy}
                        onPress={() => onSelectSource(s.id)}
                        style={({ pressed }) => [styles.sourcePill, pressed && styles.pressed]}>
                        <Text style={styles.sourcePillText}>{s.label}</Text>
                      </Pressable>
                    ))}
                  </View>
                </View>
              ) : (
                canSourceBox && (
                  <Pressable
                    disabled={busy}
                    onPress={onSwitchToBox}
                    style={({ pressed }) => [styles.sourceBtn, pressed && styles.pressed]}>
                    <Ionicons name="tv" size={18} color={theme.green} />
                    <Text style={[styles.sourceBtnText, { color: theme.green }]}>Switch to Box</Text>
                  </Pressable>
                )
              )}

              {canBlankScreen && (
                <Pressable
                  disabled={busy}
                  onPress={onBlankScreen}
                  style={({ pressed }) => [styles.sourceBtn, pressed && styles.pressed]}>
                  <Ionicons name="eye-off-outline" size={18} color={theme.amber} />
                  <Text style={[styles.sourceBtnText, { color: theme.amber }]}>Blank Screen</Text>
                </Pressable>
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
                  {sliderOpen && <VolumeSlider onStep={stepVolume} onDone={refreshTv} />}
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
                      onLongPress={() => {
                        hapticLight();
                        setSliderOpen((v) => !v);
                      }}
                      delayLongPress={250}
                      style={({ pressed }) => [
                        styles.volBtn,
                        muted && styles.volBtnMuted,
                        sliderOpen && styles.volBtnActive,
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
  volBtnActive: { borderWidth: 1, borderColor: theme.green },
  sourceBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    height: 48,
    borderRadius: 10,
    backgroundColor: theme.inset,
  },
  sourceBtnText: { fontSize: 14, fontWeight: '800', fontFamily: mono, letterSpacing: 0.5 },
  sourceSection: { gap: 6 },
  sourceHdr: {
    color: theme.textFaint,
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 1.2,
    fontFamily: mono,
    marginLeft: 2,
  },
  sourceGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  sourcePill: {
    paddingVertical: 9,
    paddingHorizontal: 12,
    borderRadius: 8,
    backgroundColor: theme.inset,
    borderWidth: 1,
    borderColor: theme.cardBorder,
  },
  sourcePillText: { color: theme.text, fontSize: 12, fontWeight: '700', fontFamily: mono },
  sliderRow: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 2 },
  sliderTrack: {
    flex: 1,
    height: 40,
    borderRadius: 20,
    backgroundColor: theme.inset,
    justifyContent: 'center',
  },
  sliderThumb: {
    position: 'absolute',
    width: 26,
    height: 26,
    marginLeft: -13,
    top: 7,
    borderRadius: 13,
    backgroundColor: theme.text,
  },
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
