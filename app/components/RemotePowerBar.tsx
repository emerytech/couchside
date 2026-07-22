import Ionicons from '@expo/vector-icons/Ionicons';
import React from 'react';
import { Alert, Modal, PanResponder, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { CouchModeSheet } from '@/components/CouchModeSheet';
import { ScreensaverSheet } from '@/components/ScreensaverSheet';
import { SleepTimerSheet } from '@/components/SleepTimerSheet';
import { usePoll } from '@/hooks/usePoll';
import { api, capsEqual, Displays, hostKey, PowerSchedule, Screensaver, Status, Tv, TvOp, VolumeTarget } from '@/lib/api';
import { hapticError, hapticLight, hapticSuccess } from '@/lib/haptics';
import { getPref, usePref } from '@/lib/prefs';
import { normalizeMac, isValidLanIp } from '@/lib/settings';
import { useBoxes, useSettings } from '@/lib/SettingsContext';
import { mono, useTheme, useThemedStyles } from '@/lib/theme';
import type { Palette } from '@/lib/theme';
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

const STEP_PX = 14; // jog mode: horizontal drag distance per one volume step
const STEP_MIN_MS = 55; // jog mode: floor between fired steps

/**
 * Volume slider revealed by holding the mute button. Two behaviors:
 *
 * Absolute (level != null — box volume, which the agent can read and set):
 * a real 0-100 slider. The thumb sits at the current level, drag it anywhere
 * and on release the agent converges the box volume to that percentage (media
 * key steps, so Game Mode shows its OSD). It stays where you put it.
 *
 * Jog (level == null — TV/CEC volume, no trustworthy readback): dragging fires
 * relative volume steps in the drag direction and the thumb springs back to
 * center on release.
 */
function VolumeSlider({
  level,
  onSet,
  onStep,
  onDone,
}: {
  level: number | null;
  onSet: (pct: number) => void;
  onStep: (dir: 1 | -1) => void;
  onDone: () => void;
}) {
  const t = useTheme();
  const styles = useThemedStyles(makeStyles);
  const absolute = level != null;
  const [w, setW] = React.useState(0);
  const [frac, setFrac] = React.useState(absolute ? level / 100 : 0.5);
  const dragging = React.useRef(false);
  const fracRef = React.useRef(frac);
  fracRef.current = frac;
  // Jog-mode accumulators.
  const acc = React.useRef(0);
  const lastX = React.useRef<number | null>(null);
  const lastFire = React.useRef(0);

  // Follow the polled level while the finger is up (absolute mode only), so an
  // out-of-band change (volume rocker on the box) moves the thumb too. Skipped
  // for a short window after a release: an ambient poll tick can read the
  // agent mid-convergence and would briefly snap the thumb to a stale level.
  const settleUntil = React.useRef(0);
  React.useEffect(() => {
    if (absolute && !dragging.current && Date.now() >= settleUntil.current) {
      setFrac(level / 100);
    }
  }, [absolute, level]);

  const fireJog = React.useCallback(
    (x: number) => {
      if (lastX.current == null) {
        lastX.current = x;
        return;
      }
      acc.current += x - lastX.current;
      lastX.current = x;
      const now = Date.now();
      if (now - lastFire.current < STEP_MIN_MS) return;
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
    dragging.current = false;
    if (absolute) {
      // No onDone() here: an immediate /api/tv refresh would race the agent's
      // still-converging volume loop and snap the thumb back to a stale level.
      // onSet's caller refreshes after the POST resolves (the agent replies
      // with the final level), which is the correct sync point.
      settleUntil.current = Date.now() + 2500;
      onSet(Math.round(fracRef.current * 100));
    } else {
      lastX.current = null;
      acc.current = 0;
      setFrac(0.5);
      onDone();
    }
  }, [absolute, onSet, onDone]);

  const pan = React.useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: () => true,
        onPanResponderGrant: (e) => {
          dragging.current = true;
          const x = e.nativeEvent.locationX;
          if (absolute) {
            if (w > 0) setFrac(Math.max(0, Math.min(1, x / w)));
          } else {
            lastX.current = x;
            acc.current = 0;
            if (w > 0) setFrac(Math.max(0, Math.min(1, x / w)));
          }
        },
        onPanResponderMove: (e) => {
          const x = e.nativeEvent.locationX;
          if (w > 0) setFrac(Math.max(0, Math.min(1, x / w)));
          if (!absolute) fireJog(x);
        },
        onPanResponderRelease: end,
        onPanResponderTerminate: end,
      }),
    [w, absolute, fireJog, end],
  );

  return (
    <View style={styles.sliderRow}>
      <Ionicons name="volume-low" size={18} color={t.textDim} />
      <View
        style={styles.sliderTrack}
        onLayout={(e) => setW(e.nativeEvent.layout.width)}
        {...pan.panHandlers}>
        {absolute && (
          <View pointerEvents="none" style={[styles.sliderFill, { width: `${frac * 100}%` }]} />
        )}
        <View pointerEvents="none" style={[styles.sliderThumb, { left: `${frac * 100}%` }]} />
      </View>
      {absolute ? (
        <Text style={styles.sliderPct}>{Math.round(frac * 100)}</Text>
      ) : (
        <Ionicons name="volume-high" size={18} color={t.textDim} />
      )}
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
  const t = useTheme();
  const styles = useThemedStyles(makeStyles);
  const insets = useSafeAreaInsets();
  const { settings, ready, update } = useSettings();
  // Other boxes in the fleet are potential Wake-on-LAN relays: iOS blocks UDP
  // for apps, so an awake box must broadcast the magic packet for a sleeping one.
  const { boxes, activeBoxId } = useBoxes();
  const configured = settings.host.trim().length > 0;
  const [open, setOpen] = React.useState(false);
  const [sliderOpen, setSliderOpen] = React.useState(false);
  // Collapse the hold-to-reveal volume slider whenever the dropdown closes.
  React.useEffect(() => {
    if (!open) setSliderOpen(false);
  }, [open]);

  const statusInterval = usePref('statusIntervalMs');
  // hostKey as resetKey: usePoll guarantees `status.data` always belongs to
  // the CURRENT box (cleared on switch, in-flight results for the old box
  // discarded). The learners below persist onto the active box, and this bar
  // is mounted once per tab screen — without that guarantee a stale instance
  // once mis-attributed one box's data to another and the competing writes
  // ping-ponged forever ("Maximum update depth exceeded").
  const boxKey = hostKey(settings);
  const status = usePoll<Status>(
    () => api.status(settings), statusInterval, ready && configured, boxKey);
  const s = status.data;
  const reachable = configured && status.error == null && s != null;

  // Learn the box MAC from status so Wake-on-LAN works after it goes offline.
  React.useEffect(() => {
    const mac = normalizeMac(s?.net?.mac);
    if (mac && mac !== settings.mac) void update({ mac });
  }, [s?.net?.mac, settings.mac, update]);

  // Learn + REFRESH the box's LAN IP from status (agent >= 2.9.22). lastIp is
  // otherwise written only at pairing, so a box added by hostname never got one
  // and a box whose DHCP lease drifted kept a stale one — leaving raceGet's
  // cached-IP fallback unable to engage when mDNS (.local) breaks, e.g. right
  // after an agent restart. Refreshing every poll keeps the fallback live.
  React.useEffect(() => {
    const ip = s?.ip;
    if (ip && isValidLanIp(ip) && ip !== settings.lastIp) void update({ lastIp: ip });
  }, [s?.ip, settings.lastIp, update]);

  // Learn + persist the box's capability summary from status (agent >= 2.8.2),
  // so the tab bar can hide gaming tabs on a server box immediately on next
  // launch. Value-equality gate (caps is a fresh object every poll) so it
  // writes storage once per real change, not once per poll.
  React.useEffect(() => {
    if (s?.caps && !capsEqual(s.caps, settings.caps)) {
      void update({ caps: s.caps });
    }
  }, [s?.caps, settings.caps, update]);

  // TV/audio backend + mute state. Polled (not probed once per connect) so the
  // mute indicator self-heals when the box is muted out of band (controller,
  // keyboard, a stale seed), and a TV backend appearing/disappearing shows up
  // without a reconnect. api.tv 404s when there is no backend, which surfaces
  // as tvPoll.error, so tv stays null there.
  const tvPoll = usePoll<Tv>(() => api.tv(settings), 5000, reachable, boxKey);
  const refreshTv = tvPoll.refresh;
  const tv = reachable && tvPoll.error == null && tvPoll.data?.available ? tvPoll.data : null;
  const muted = tv?.muted ?? null;

  // Sleep timer + wake schedule (agent >= 2.8.1). Probe-and-appear: null on an
  // older agent, so the sleep-timer entry stays hidden.
  const schedulePoll = usePoll<PowerSchedule | null>(
    () => api.powerSchedule(settings),
    15000,
    reachable,
    boxKey,
  );
  const schedule = reachable ? schedulePoll.data ?? null : null;
  const [sleepOpen, setSleepOpen] = React.useState(false);

  // Aerial screensaver (agent >= 2.8.4, gamescope boxes). Probe-and-appear:
  // null hides the row; caps.screensaver === false skips the request entirely.
  const saverPoll = usePoll<Screensaver | null>(
    () => api.screensaver(settings),
    15000,
    reachable,
    boxKey,
  );
  const saver = reachable ? saverPoll.data ?? null : null;
  const [saverOpen, setSaverOpen] = React.useState(false);

  // Couch Mode displays (agent >= 2.9, SteamOS/Bazzite desktop w/ TV). Probe-
  // and-appear: null hides the header button; caps.couchmode === false skips it.
  const displaysPoll = usePoll<Displays | null>(
    () => api.displays(settings),
    15000,
    reachable,
    boxKey,
  );
  const displays = reachable ? displaysPoll.data ?? null : null;
  const [couchOpen, setCouchOpen] = React.useState(false);
  // Optimistic session: the couch-mode POST response already says which
  // session the box is entering, and the box goes briefly unreachable during
  // the switch (Game Mode can drop .local resolution), so waiting on the poll
  // left the button stale. Show the known target now; the next successful
  // displays poll is the source of truth again.
  const [sessionOverride, setSessionOverride] =
    React.useState<'gamescope' | 'desktop' | null>(null);
  const polledSession = displaysPoll.data?.session;
  React.useEffect(() => {
    if (polledSession != null) setSessionOverride(null);
  }, [polledSession]);

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
  // Absolute set for the slider (box target only — the box level is the one
  // the agent can actually read back; panel readback is untrustworthy).
  const setVolume = React.useCallback(
    (pct: number) => {
      void api
        .tvSetVolume(settings, pct, 'box')
        .then(() => refreshTv())
        .catch(() => hapticError());
    },
    [settings, refreshTv],
  );

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
      let ok = false;
      let phoneErr: string | null = null;

      // 1) Relay through any OTHER box that's awake (agent >= 2.9.13). This is
      //    the only path that works on iOS, where the OS blocks UDP for apps
      //    entirely so the phone's own magic packet never leaves the device.
      //    Asleep / older / unreachable boxes just fail and we try the next.
      for (const b of boxes) {
        if (b.id === activeBoxId) continue;
        try {
          const r = await api.wolRelay(
            { host: b.host, port: b.port, token: b.token, lastIp: b.lastIp },
            mac,
          );
          if (r?.ok) {
            ok = true;
            break;
          }
        } catch {
          // that box can't relay — try the next one
        }
      }

      // 2) Fall back to broadcasting from the phone (works on Android).
      if (!ok && wolAvailable) {
        try {
          ok = await sendWol(mac, { ip: settings.lastIp });
        } catch (e: unknown) {
          phoneErr = e instanceof Error ? e.message : String(e);
        }
      }

      if (ok) {
        hapticSuccess();
        status.refresh();
      } else {
        hapticError();
        Alert.alert(
          'Wake failed',
          phoneErr ??
            'No magic packet could be sent. Keep another box awake to wake this one — ' +
              'iOS blocks phones from broadcasting wake packets directly.',
        );
      }
      setWaking(false);
    })();
  }, [settings.mac, settings.lastIp, status, boxes, activeBoxId]);

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
  // Wake works either from the phone's own broadcast (Android) or by relaying
  // through another box in the fleet — the only route on iOS, which blocks UDP.
  const canWake = !reachable && !!settings.mac && (wolAvailable || boxes.length > 1);
  const hasSaver = reachable && saver?.available === true;
  const hasCouch = reachable && displays?.available === true;

  // Nothing to control on this box right now. (Couch Mode counts: it renders
  // its own header button, so the bar must not bail when it's the only thing.)
  if (
    !canSuspend &&
    !canWake &&
    !hasVolume &&
    !hasTvPower &&
    !canSourceBox &&
    !canBlankScreen &&
    !hasSaver &&
    !hasCouch &&
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

  const inGameMode = (sessionOverride ?? displays?.session) === 'gamescope';

  return (
    <>
      {/* Couch Mode: fling this desktop box to the TV in Game Mode (or come
          back). Fills the header's empty middle; only shows on capable boxes. */}
      {hasCouch && (
        <Pressable
          onPress={() => {
            hapticLight();
            setCouchOpen(true);
          }}
          hitSlop={8}
          style={({ pressed }) => [
            styles.couchBtn,
            inGameMode && styles.couchBtnActive,
            pressed && styles.pressed,
          ]}>
          <Ionicons
            name={inGameMode ? 'game-controller' : 'tv-outline'}
            size={16}
            color={inGameMode ? t.green : t.text}
          />
          <Text style={[styles.couchLabel, inGameMode && { color: t.green }]}>
            {inGameMode ? 'On TV' : 'Couch'}
          </Text>
        </Pressable>
      )}

      <Pressable
        onPress={() => {
          hapticLight();
          setOpen(true);
        }}
        hitSlop={8}
        style={({ pressed }) => [styles.trigger, pressed && styles.pressed]}>
        <Ionicons name={triggerIcon} size={20} color={t.text} />
        <Ionicons name="chevron-down" size={14} color={t.textDim} />
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
                  <Ionicons name="power" size={22} color={t.green} />
                  <Text style={[styles.bigLabel, { color: t.green }]}>
                    {waking ? 'Waking…' : 'Wake box'}
                  </Text>
                </Pressable>
              )}

              {canSuspend && (
                <View style={styles.suspendGroup}>
                  <Pressable
                    onPress={() => {
                      setOpen(false);
                      onSuspend();
                    }}
                    style={({ pressed }) => [styles.bigBtn, pressed && styles.pressed]}>
                    <Ionicons name="moon" size={22} color={t.amber} />
                    <Text style={[styles.bigLabel, { color: t.amber }]}>Suspend</Text>
                  </Pressable>
                  {/* Suspending and WAKING are separate capabilities, and only
                      the second one needs Ethernet. This button used to be
                      DISABLED on WiFi and labelled "Suspend (needs Ethernet)",
                      which took the feature away from the machine it matters
                      most on: a Steam Deck is WiFi-only undocked, and its whole
                      signature move is power-button suspend/resume -- no
                      Wake-on-LAN involved. Suspending works fine over WiFi. Say
                      how you'll wake it instead of blocking it. */}
                  {wired === false ? (
                    <Text style={styles.warnText}>
                      Wake-on-LAN needs Ethernet, so the Wake button won&apos;t reach this
                      box. Press its power button to wake it — it resumes where you left
                      off.
                    </Text>
                  ) : wolArmed === false ? (
                    <Text style={styles.warnText}>
                      Wake-on-LAN is not armed on this box. It will sleep, but the
                      Wake button may not bring it back.
                    </Text>
                  ) : null}
                </View>
              )}

              {/* Aerial screensaver (agent >= 2.8.4, gamescope boxes) */}
              {hasSaver && (
                <Pressable
                  onPress={() => {
                    setOpen(false);
                    setSaverOpen(true);
                  }}
                  style={({ pressed }) => [styles.bigBtn, pressed && styles.pressed]}>
                  <Ionicons name="film-outline" size={22} color={t.text} />
                  <Text style={styles.bigLabel}>
                    {saver?.running ? 'Screensaver · playing' : 'Screensaver'}
                  </Text>
                </Pressable>
              )}

              {/* Sleep timer / wake schedule (agent >= 2.8.1) */}
              {schedule != null && (
                <Pressable
                  onPress={() => {
                    setOpen(false);
                    setSleepOpen(true);
                  }}
                  style={({ pressed }) => [styles.bigBtn, pressed && styles.pressed]}>
                  <Ionicons name="timer-outline" size={22} color={t.text} />
                  <Text style={styles.bigLabel}>
                    {schedule.sleep
                      ? `${schedule.sleep.action === 'poweroff' ? 'Power off' : 'Suspend'} in ${Math.max(
                          0,
                          Math.round(schedule.sleep.remaining_s / 60),
                        )}m`
                      : 'Sleep timer'}
                  </Text>
                </Pressable>
              )}

              {hasTvPower && (
                <View style={styles.tvPowerRow}>
                  <Pressable
                    disabled={busy}
                    onPress={() => sendPower('power_on')}
                    style={({ pressed }) => [styles.tvBtn, pressed && styles.pressed]}>
                    <Ionicons name="power" size={18} color={t.green} />
                    <Text style={[styles.tvBtnText, { color: t.green }]}>TV On</Text>
                  </Pressable>
                  <Pressable
                    disabled={busy}
                    onPress={() => sendPower('power_off')}
                    style={({ pressed }) => [styles.tvBtn, pressed && styles.pressed]}>
                    <Ionicons name="power-outline" size={18} color={t.textDim} />
                    <Text style={[styles.tvBtnText, { color: t.textDim }]}>TV Off</Text>
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
                    <Ionicons name="tv" size={18} color={t.green} />
                    <Text style={[styles.sourceBtnText, { color: t.green }]}>Switch to Box</Text>
                  </Pressable>
                )
              )}

              {canBlankScreen && (
                <Pressable
                  disabled={busy}
                  onPress={onBlankScreen}
                  style={({ pressed }) => [styles.sourceBtn, pressed && styles.pressed]}>
                  <Ionicons name="eye-off-outline" size={18} color={t.amber} />
                  <Text style={[styles.sourceBtnText, { color: t.amber }]}>Blank Screen</Text>
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
                  {sliderOpen && (
                    <VolumeSlider
                      level={
                        volumeTarget === 'box' ? (tv?.box_volume_level ?? null) : null
                      }
                      onSet={setVolume}
                      onStep={stepVolume}
                      onDone={refreshTv}
                    />
                  )}
                  <View style={styles.volRow}>
                    <Pressable
                      disabled={busy}
                      onPress={() => sendTv('volume_down')}
                      style={({ pressed }) => [styles.volBtn, pressed && styles.pressed]}>
                      <Ionicons name="volume-low" size={24} color={t.text} />
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
                        color={muted ? t.red : t.text}
                      />
                    </Pressable>
                    <Pressable
                      disabled={busy}
                      onPress={() => sendTv('volume_up')}
                      style={({ pressed }) => [styles.volBtn, pressed && styles.pressed]}>
                      <Ionicons name="volume-high" size={24} color={t.text} />
                    </Pressable>
                  </View>
                </>
              )}
            </Pressable>
          </View>
        </Pressable>
      </Modal>

      <SleepTimerSheet
        visible={sleepOpen}
        settings={settings}
        schedule={schedule}
        onChanged={schedulePoll.refresh}
        onClose={() => setSleepOpen(false)}
      />
      <ScreensaverSheet
        visible={saverOpen}
        settings={settings}
        saver={saver}
        onChanged={saverPoll.refresh}
        onClose={() => setSaverOpen(false)}
      />
      <CouchModeSheet
        visible={couchOpen}
        settings={settings}
        displays={displays}
        onChanged={(session) => {
          setSessionOverride(session);
          displaysPoll.refresh();
        }}
        onClose={() => setCouchOpen(false)}
      />
    </>
  );
}

const makeStyles = (t: Palette) => StyleSheet.create({
  couchBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: t.cardBorder,
    backgroundColor: t.card,
    marginRight: 8,
  },
  couchBtnActive: { borderColor: t.green, backgroundColor: 'rgba(52,211,153,0.10)' },
  couchLabel: { color: t.text, fontSize: 13, fontWeight: '700', fontFamily: mono },
  trigger: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 2,
    paddingVertical: 8,
    paddingHorizontal: 10,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: t.cardBorder,
    backgroundColor: t.card,
  },
  pressed: { opacity: 0.6 },
  disabled: { opacity: 0.45 },
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.35)' },
  dropWrap: { paddingHorizontal: 14, alignItems: 'flex-end' },
  card: {
    width: 260,
    maxWidth: '100%',
    backgroundColor: t.card,
    borderColor: t.cardBorder,
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
    backgroundColor: t.inset,
  },
  // color is REQUIRED here, not optional polish. A Text style with no color
  // falls back to the platform default (black), which is invisible on this
  // sheet — that shipped as the "black text even in dark mode" report. Call
  // sites that want a semantic colour still override inline.
  bigLabel: {
    color: t.text,
    fontSize: 15,
    fontWeight: '800',
    fontFamily: mono,
    letterSpacing: 0.5,
  },
  suspendGroup: { gap: 6 },
  warnText: {
    color: t.amber,
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
    backgroundColor: t.inset,
  },
  // Every call site currently passes a colour inline, so this was not visibly
  // broken — but the same black-on-black trap is one new usage away.
  tvBtnText: {
    color: t.text,
    fontSize: 14,
    fontWeight: '800',
    fontFamily: mono,
    letterSpacing: 0.5,
  },
  volRow: { flexDirection: 'row', gap: 8 },
  volBtn: {
    flex: 1,
    height: 56,
    borderRadius: 10,
    backgroundColor: t.inset,
    alignItems: 'center',
    justifyContent: 'center',
  },
  volBtnMuted: { backgroundColor: t.redDeep, borderWidth: 1, borderColor: t.red },
  volBtnActive: { borderWidth: 1, borderColor: t.green },
  sourceBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    height: 48,
    borderRadius: 10,
    backgroundColor: t.inset,
  },
  // Same reasoning as tvBtnText: covered today, one usage away from invisible.
  sourceBtnText: {
    color: t.text,
    fontSize: 14,
    fontWeight: '800',
    fontFamily: mono,
    letterSpacing: 0.5,
  },
  sourceSection: { gap: 6 },
  sourceHdr: {
    color: t.textFaint,
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
    backgroundColor: t.inset,
    borderWidth: 1,
    borderColor: t.cardBorder,
  },
  sourcePillText: { color: t.text, fontSize: 12, fontWeight: '700', fontFamily: mono },
  sliderRow: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 2 },
  sliderTrack: {
    flex: 1,
    height: 40,
    borderRadius: 20,
    backgroundColor: t.inset,
    justifyContent: 'center',
  },
  sliderThumb: {
    position: 'absolute',
    width: 26,
    height: 26,
    marginLeft: -13,
    top: 7,
    borderRadius: 13,
    backgroundColor: t.text,
  },
  sliderFill: {
    position: 'absolute',
    left: 0,
    top: 0,
    bottom: 0,
    borderRadius: 20,
    backgroundColor: 'rgba(96,165,250,0.25)',
  },
  sliderPct: {
    color: t.text,
    fontSize: 13,
    fontWeight: '700',
    fontFamily: mono,
    width: 30,
    textAlign: 'right',
  },
  segRow: {
    flexDirection: 'row',
    gap: 2,
    padding: 2,
    borderRadius: 10,
    backgroundColor: t.inset,
  },
  seg: { flex: 1, paddingVertical: 8, borderRadius: 8, alignItems: 'center' },
  segActive: { backgroundColor: t.card },
  segText: { color: t.textDim, fontSize: 13, fontWeight: '700', fontFamily: mono },
  segTextActive: { color: t.text },
});
