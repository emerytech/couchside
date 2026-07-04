/**
 * Virtual gamepad + trackpad + keyboard. Emulates an Xbox 360 pad, a relative
 * mouse, and a keyboard on the box over the agent's /ws/gamepad WebSocket
 * (protocol v2). Connected only while this tab is focused and the app is
 * foregrounded; everything is released on the way out.
 *
 * The Pad tab is the one screen that allows landscape (see useLockOrientation);
 * in landscape the gamepad controls spread out like a real controller.
 */
import { hapticSelection } from '@/lib/haptics';
import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake';
import { useNavigation } from 'expo-router';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Animated,
  AppState,
  Keyboard,
  PanResponder,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  useWindowDimensions,
  View,
  ViewStyle,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Gated } from '@/components/Gated';
import { TabScreen } from '@/components/TabScreen';
import { useLockOrientation } from '@/hooks/useLockOrientation';
import { ButtonKey, GamepadClient, GamepadStatus, StickKey, TriggerKey } from '@/lib/gamepad';
import { PadMode } from '@/lib/settings';
import { useSettings } from '@/lib/SettingsContext';
import { mono, theme } from '@/lib/theme';

const KEEP_AWAKE_TAG = 'rescue-remote-pad';

// All Pad haptics (swipe steps, taps, buttons, sticks, mode switch) route
// through the app-wide gated emitter so the Settings toggle governs them.
function haptic() {
  hapticSelection();
}

/** Stable no-op for momentary buttons whose action fires (and self-releases) on press. */
const NOOP = () => {};

// ---------- Buttons ----------

type PadButtonProps = {
  label: string;
  onDown: () => void;
  onUp: () => void;
  style?: ViewStyle | ViewStyle[];
  color?: string;
  fontSize?: number;
};

function PadButton({ label, onDown, onUp, style, color, fontSize }: PadButtonProps) {
  return (
    <Pressable
      onPressIn={() => {
        haptic();
        onDown();
      }}
      onPressOut={onUp}
      style={({ pressed }) => [styles.btn, style, pressed && styles.btnPressed]}>
      <Text
        style={[
          styles.btnText,
          color != null && { color },
          fontSize != null && { fontSize },
        ]}>
        {label}
      </Text>
    </Pressable>
  );
}

// ---------- Analog stick ----------

const STICK_SIZE = 132;
const NUB_SIZE = 56;
const STICK_RADIUS = (STICK_SIZE - NUB_SIZE) / 2;

type StickProps = {
  onMove: (x: number, y: number) => void;
  onRelease: () => void;
};

function Stick({ onMove, onRelease }: StickProps) {
  const pan = useRef(new Animated.ValueXY({ x: 0, y: 0 })).current;
  const cb = useRef({ onMove, onRelease });
  cb.current = { onMove, onRelease };

  const responder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderGrant: () => {
        haptic();
      },
      onPanResponderMove: (_evt, g) => {
        let dx = g.dx;
        let dy = g.dy;
        const len = Math.hypot(dx, dy);
        if (len > STICK_RADIUS) {
          dx = (dx / len) * STICK_RADIUS;
          dy = (dy / len) * STICK_RADIUS;
        }
        pan.setValue({ x: dx, y: dy });
        // +y down in screen coords matches the protocol directly.
        cb.current.onMove(dx / STICK_RADIUS, dy / STICK_RADIUS);
      },
      onPanResponderRelease: () => {
        Animated.spring(pan, {
          toValue: { x: 0, y: 0 },
          useNativeDriver: false,
          friction: 6,
        }).start();
        cb.current.onRelease();
      },
      onPanResponderTerminate: () => {
        Animated.spring(pan, {
          toValue: { x: 0, y: 0 },
          useNativeDriver: false,
          friction: 6,
        }).start();
        cb.current.onRelease();
      },
    }),
  ).current;

  return (
    <View style={styles.stickPad} {...responder.panHandlers}>
      <View style={styles.stickCross} pointerEvents="none" />
      <Animated.View
        pointerEvents="none"
        style={[styles.stickNub, { transform: pan.getTranslateTransform() }]}
      />
    </View>
  );
}

// ---------- Swipe surface (Apple TV remote style) ----------

/** Pixels of travel per emitted d-pad step. */
const SWIPE_STEP = 56;
/** Movement under this is still a tap. */
const TAP_SLOP = 12;
/** Touches longer than this aren't taps. */
const TAP_MS = 450;

type DpadKey = 'du' | 'dd' | 'dl' | 'dr';

type SwipeSurfaceProps = {
  onStep: (k: DpadKey) => void;
  onSelect: () => void;
};

/**
 * Trackpad-like surface: dragging emits one d-pad step per SWIPE_STEP px along
 * the dominant axis (a long swipe = several steps, like scrolling a menu);
 * a quick tap is A/select.
 */
function SwipeSurface({ onStep, onSelect }: SwipeSurfaceProps) {
  const cb = useRef({ onStep, onSelect });
  cb.current = { onStep, onSelect };
  const track = useRef({ consumedX: 0, consumedY: 0, moved: false, t0: 0 });

  const responder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderGrant: () => {
        track.current = { consumedX: 0, consumedY: 0, moved: false, t0: Date.now() };
      },
      onPanResponderMove: (_evt, g) => {
        const t = track.current;
        if (!t.moved && Math.hypot(g.dx, g.dy) > TAP_SLOP) t.moved = true;
        // Emit steps until the un-consumed travel is under one step on both axes.
        for (;;) {
          const availX = g.dx - t.consumedX;
          const availY = g.dy - t.consumedY;
          const ax = Math.abs(availX);
          const ay = Math.abs(availY);
          if (ax < SWIPE_STEP && ay < SWIPE_STEP) break;
          if (ax >= ay) {
            t.consumedX += Math.sign(availX) * SWIPE_STEP;
            cb.current.onStep(availX > 0 ? 'dr' : 'dl');
          } else {
            t.consumedY += Math.sign(availY) * SWIPE_STEP;
            cb.current.onStep(availY > 0 ? 'dd' : 'du');
          }
        }
      },
      onPanResponderRelease: () => {
        const t = track.current;
        if (!t.moved && Date.now() - t.t0 < TAP_MS) cb.current.onSelect();
      },
    }),
  ).current;

  return (
    <View style={styles.swipeSurface} {...responder.panHandlers}>
      <Text style={styles.swipeHint}>swipe to move · tap to select</Text>
    </View>
  );
}

// ---------- Trackpad surface (relative mouse, protocol v2) ----------

/** Movement under this (px) still counts as a tap/click. */
const TP_TAP_SLOP = 8;
/** Touches longer than this aren't taps. */
const TP_TAP_MS = 350;
/**
 * Light acceleration: pointer delta = raw * (BASE + GAIN * speed). Slow drags
 * track 1:1-ish for precision; fast flicks cover more screen.
 */
const TP_BASE = 1.1;
const TP_GAIN = 0.05;
/** Screen px of two-finger drag per wheel notch. */
const TP_SCROLL_STEP = 18;
/** Pointer travel (px) per haptic "texture" tick while dragging. */
const TP_HAPTIC_PX = 56;

type TrackpadProps = {
  onMove: (dx: number, dy: number) => void;
  onLeftClick: () => void;
  onRightClick: () => void;
  onScroll: (notches: number) => void;
};

/**
 * Relative-mouse surface:
 *  - 1-finger drag  -> sendMouseMove (with a light acceleration curve)
 *  - 1-finger tap   -> left click
 *  - 2-finger tap   -> right click
 *  - 2-finger drag  -> vertical scroll (wheel)
 */
function Trackpad({ onMove, onLeftClick, onRightClick, onScroll }: TrackpadProps) {
  const cb = useRef({ onMove, onLeftClick, onRightClick, onScroll });
  cb.current = { onMove, onLeftClick, onRightClick, onScroll };

  const st = useRef({
    lastX: 0,
    lastY: 0,
    lastT: 0,
    moved: false,
    t0: 0,
    maxTouches: 1,
    scrollAccum: 0,
    scrollLastY: 0,
  });

  const responder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderGrant: (evt) => {
        const touches = evt.nativeEvent.touches.length || 1;
        st.current = {
          lastX: 0,
          lastY: 0,
          lastT: Date.now(),
          moved: false,
          t0: Date.now(),
          maxTouches: touches,
          scrollAccum: 0,
          scrollLastY: 0,
        };
      },
      onPanResponderMove: (evt, g) => {
        const s = st.current;
        const touches = evt.nativeEvent.touches.length;
        if (touches > s.maxTouches) s.maxTouches = touches;
        if (!s.moved && Math.hypot(g.dx, g.dy) > TP_TAP_SLOP) s.moved = true;

        if (s.maxTouches >= 2) {
          // Two-finger drag -> vertical scroll. g.dy is cumulative from grant.
          const delta = g.dy - s.scrollLastY;
          s.scrollAccum += delta;
          while (Math.abs(s.scrollAccum) >= TP_SCROLL_STEP) {
            const dir = s.scrollAccum > 0 ? 1 : -1;
            s.scrollAccum -= dir * TP_SCROLL_STEP;
            // Drag down (dy>0) scrolls content up -> wheel down (negative).
            cb.current.onScroll(-dir);
          }
          s.scrollLastY = g.dy;
          return;
        }

        // One-finger drag -> relative pointer move with light acceleration.
        const now = Date.now();
        const rawDx = g.dx - s.lastX;
        const rawDy = g.dy - s.lastY;
        const dt = Math.max(1, now - s.lastT);
        const speed = Math.hypot(rawDx, rawDy) / dt; // px/ms
        const gain = TP_BASE + TP_GAIN * speed * 16; // scale speed to ~per-frame
        s.lastX = g.dx;
        s.lastY = g.dy;
        s.lastT = now;
        cb.current.onMove(rawDx * gain, rawDy * gain);
      },
      onPanResponderRelease: () => {
        const s = st.current;
        const wasTap = !s.moved && Date.now() - s.t0 < TP_TAP_MS;
        if (wasTap) {
          if (s.maxTouches >= 2) cb.current.onRightClick();
          else cb.current.onLeftClick();
        }
      },
    }),
  ).current;

  return (
    <View style={styles.trackpadSurface} {...responder.panHandlers}>
      <Text style={styles.swipeHint}>
        drag to move · tap = click · two-finger tap = right-click · two-finger drag = scroll
      </Text>
    </View>
  );
}

// ---------- Keyboard bar (off-screen TextInput -> protocol v2 keys) ----------

type KeyboardBarProps = {
  onText: (s: string) => void;
  onBackspace: () => void;
  onEnter: () => void;
};

/**
 * A visible "keyboard" button that focuses a hidden TextInput to raise the iOS
 * keyboard. Printable characters are streamed via onText; Backspace and Enter
 * are surfaced as their own callbacks. The input is kept effectively empty so
 * each keystroke is captured individually rather than accumulating a value.
 *
 * Dismissal is made bulletproof: an explicit "Done" button, a swipe-DOWN drag
 * handle, and a subscription to the OS 'keyboardDidHide' event that resyncs the
 * bar's open/closed state so the affordance can never get stuck showing "open"
 * while the real keyboard is down (or vice-versa). `open` is mirrored into a ref
 * so callbacks always see the live value without stale closures.
 */
function KeyboardBar({ onText, onBackspace, onEnter }: KeyboardBarProps) {
  const inputRef = useRef<TextInput>(null);
  const [open, setOpen] = useState(false);
  // Live mirror of `open` for use inside event callbacks/PanResponder, which
  // capture their closure once and would otherwise read a stale value.
  const openRef = useRef(false);
  const setOpenSynced = useCallback((v: boolean) => {
    openRef.current = v;
    setOpen(v);
  }, []);
  const [value, setValue] = useState('');

  // Belt-and-suspenders dismiss: hide the OS keyboard AND blur our input, so it
  // works no matter which one is actually holding focus.
  const dismiss = useCallback(() => {
    Keyboard.dismiss();
    inputRef.current?.blur();
    setOpenSynced(false);
    setValue('');
  }, [setOpenSynced]);

  const focus = useCallback(() => {
    haptic();
    setOpenSynced(true);
    // Focus SYNCHRONOUSLY inside the tap handler. Deferring with
    // requestAnimationFrame pushed focus() into a later tick, outside the touch
    // event, which iOS can treat as non-interactive and refuse to raise the
    // keyboard. The input is always mounted, so the ref is ready here.
    inputRef.current?.focus();
  }, [setOpenSynced]);

  // Source of truth: whenever the OS reports the keyboard went down, mark the
  // bar closed. This catches every dismissal path (Done, swipe, the system
  // keyboard's own hide, app backgrounding) so state can't drift.
  useEffect(() => {
    const sub = Keyboard.addListener('keyboardDidHide', () => {
      openRef.current = false;
      setOpen(false);
      setValue('');
    });
    return () => sub.remove();
  }, []);

  // Swipe-DOWN on the bar dismisses. A downward drag past a small threshold, or
  // a downward flick, closes the keyboard.
  const panResponder = useRef(
    PanResponder.create({
      onMoveShouldSetPanResponder: (_e, g) =>
        g.dy > 6 && g.dy > Math.abs(g.dx),
      onPanResponderRelease: (_e, g) => {
        if (openRef.current && (g.dy > 24 || g.vy > 0.4)) dismiss();
      },
    }),
  ).current;

  const onChangeText = useCallback(
    (next: string) => {
      // New printable characters are whatever got appended past the sentinel.
      if (next.length > 0) {
        onText(next);
      }
      // Reset so the field never grows; keeps each keystroke atomic.
      setValue('');
    },
    [onText],
  );

  const onKeyPress = useCallback(
    (e: { nativeEvent: { key: string } }) => {
      const key = e.nativeEvent.key;
      if (key === 'Backspace') {
        onBackspace();
      } else if (key === 'Enter') {
        onEnter();
      }
    },
    [onBackspace, onEnter],
  );

  return (
    <>
      <View style={styles.kbBarRow} {...(open ? panResponder.panHandlers : {})}>
        <Pressable
          onPress={open ? dismiss : focus}
          style={({ pressed }) => [
            styles.kbBar,
            styles.kbBarFlex,
            open && styles.kbBarOpen,
            pressed && styles.btnPressed,
          ]}>
          {open && <View style={styles.kbDragHandle} pointerEvents="none" />}
          <Text style={[styles.kbBarText, open && styles.kbBarTextOpen]}>
            {open ? '⌨  type to send · swipe down or tap Done' : '⌨  KEYBOARD'}
          </Text>
        </Pressable>
        {open && (
          <Pressable
            onPress={dismiss}
            hitSlop={8}
            style={({ pressed }) => [styles.kbDone, pressed && styles.btnPressed]}>
            <Text style={styles.kbDoneText}>DONE</Text>
          </Pressable>
        )}
      </View>
      <TextInput
        ref={inputRef}
        value={value}
        onChangeText={onChangeText}
        onKeyPress={onKeyPress}
        onSubmitEditing={onEnter}
        onBlur={() => {
          setOpenSynced(false);
          setValue('');
        }}
        style={styles.hiddenInput}
        autoCapitalize="none"
        autoCorrect={false}
        autoComplete="off"
        spellCheck={false}
        blurOnSubmit={false}
        keyboardAppearance="dark"
        caretHidden
      />
    </>
  );
}

// ---------- Status pill ----------

const STATUS_COLOR: Record<GamepadStatus, string> = {
  connected: theme.green,
  connecting: theme.amber,
  error: theme.red,
  closed: theme.red,
};

function statusLabel(status: GamepadStatus, dev: string | null): string {
  switch (status) {
    case 'connected':
      return dev ?? 'connected';
    case 'connecting':
      return 'connecting…';
    default:
      return 'disconnected, tap to retry';
  }
}

// ---------- Screen ----------

export default function PadTab() {
  // The one tab that allows landscape so the controller can spread out.
  useLockOrientation('allow-landscape');
  return (
    <TabScreen>
      <Gated>
        <PadScreen />
      </Gated>
    </TabScreen>
  );
}

const MODES: { key: PadMode; label: string }[] = [
  { key: 'gamepad', label: 'PAD' },
  { key: 'swipe', label: 'SWIPE' },
  { key: 'trackpad', label: 'TRACKPAD' },
];

function PadScreen() {
  const insets = useSafeAreaInsets();
  const navigation = useNavigation();
  const { width, height } = useWindowDimensions();
  const landscape = width > height;
  const { settings, ready, update } = useSettings();
  const mode: PadMode = settings.padMode ?? 'swipe';
  const [status, setStatus] = useState<GamepadStatus>('closed');
  const [dev, setDev] = useState<string | null>(null);

  const clientRef = useRef<GamepadClient | null>(null);
  if (clientRef.current == null) {
    clientRef.current = new GamepadClient();
  }
  const client = clientRef.current;

  // Latest settings for connect() calls. The lifecycle effect below keys on
  // the connection identity (host/port/token) only. A background patch to
  // the active box (the lastIp learner, a padMode toggle) must NOT tear down
  // a healthy socket mid-game via a `settings` object-identity change.
  const settingsRef = useRef(settings);
  settingsRef.current = settings;

  // Manage the connection off the screen's mount lifecycle (reliable on web
  // and native) rather than useFocusEffect, whose callback-body timing is
  // unreliable on web. This screen mounts lazily on first visit to the Pad tab
  // and then stays mounted; connect() is idempotent, and an idle WS emits
  // nothing until a control is touched, so holding it open is harmless. Blur
  // releases everything (so inputs never leak to the box while you're on
  // another tab); focus and AppState-active re-open.
  useEffect(() => {
    if (!ready) return undefined;

    client.onStatus((s, d) => {
      setStatus(s);
      setDev(d);
    });

    const connect = () => {
      client.connect(settingsRef.current);
      if (Platform.OS !== 'web') {
        activateKeepAwakeAsync(KEEP_AWAKE_TAG).catch(() => {});
      }
    };
    const disconnect = () => {
      client.close();
      if (Platform.OS !== 'web') {
        deactivateKeepAwake(KEEP_AWAKE_TAG).catch(() => {});
      }
    };

    const offFocus = navigation.addListener('focus', connect);
    const offBlur = navigation.addListener('blur', disconnect);
    const appSub = AppState.addEventListener('change', (state) => {
      if (state === 'active') connect();
      else disconnect();
    });

    // Baseline: connect on mount. Focus/blur listeners above refine this when
    // the platform delivers those events.
    connect();

    return () => {
      offFocus();
      offBlur();
      appSub.remove();
      disconnect();
      client.onStatus(null);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- connection
    // identity only; settingsRef carries the rest without re-running.
  }, [client, ready, settings.host, settings.port, settings.token, navigation]);

  // A freshly-learned lastIp should reach the client's stored conn so future
  // reconnects can use it. connect() with an unchanged host/port/token just
  // refreshes the stored conn: it never drops a live socket.
  useEffect(() => {
    if (!ready || !settings.lastIp) return;
    if (client.getStatus() === 'connected' || client.getStatus() === 'connecting') {
      client.connect(settingsRef.current);
    }
  }, [client, ready, settings.lastIp]);

  const retry = useCallback(() => {
    if (status !== 'connected') {
      haptic();
      client.connect(settings);
    }
  }, [client, settings, status]);

  const btn = useCallback(
    (k: ButtonKey) => ({
      onDown: () => client.sendButton(k, 1),
      onUp: () => client.sendButton(k, 0),
    }),
    [client],
  );

  // ⋯ Quick Access Menu. Steam opens the QAM on an Xbox pad via a Guide + A
  // chord (Guide alone is the Steam menu); the client presses both and
  // auto-releases, so one tap opens the ⋯ panel where Decky / plugins live.
  const qam = useCallback(() => client.qamChord(), [client]);

  const trig = useCallback(
    (k: TriggerKey) => ({
      onDown: () => client.sendTrigger(k, 255),
      onUp: () => client.sendTrigger(k, 0),
    }),
    [client],
  );

  const stickMove = useCallback(
    (k: StickKey) => (x: number, y: number) => client.sendStick(k, x, y),
    [client],
  );
  const stickRelease = useCallback(
    (k: StickKey) => () => client.sendStick(k, 0, 0),
    [client],
  );

  const setMode = useCallback(
    (m: PadMode) => {
      if (m !== mode) {
        haptic();
        update({ padMode: m }).catch(() => {});
      }
    },
    [mode, update],
  );

  // Swipe mode emits self-contained press+release pulses; releaseAll() on
  // blur/close still covers a pulse interrupted mid-flight.
  const dpadStep = useCallback(
    (k: DpadKey) => {
      haptic();
      client.sendButton(k, 1);
      setTimeout(() => client.sendButton(k, 0), 50);
    },
    [client],
  );
  const selectTap = useCallback(() => {
    haptic();
    client.sendButton('a', 1);
    setTimeout(() => client.sendButton('a', 0), 50);
  }, [client]);

  // Trackpad handlers (protocol v2 mouse).
  // Drags emit a subtle "texture" tick per TP_HAPTIC_PX of pointer travel,
  // like detents under the finger, so moving the mouse feels alive without
  // buzzing continuously. Scroll ticks once per wheel notch.
  const tpHapticAcc = useRef(0);
  const tpMove = useCallback(
    (dx: number, dy: number) => {
      client.sendMouseMove(dx, dy);
      tpHapticAcc.current += Math.hypot(dx, dy);
      if (tpHapticAcc.current >= TP_HAPTIC_PX) {
        tpHapticAcc.current = 0;
        haptic();
      }
    },
    [client],
  );
  const tpLeft = useCallback(() => {
    haptic();
    client.sendMouseButton('l', 1);
    setTimeout(() => client.sendMouseButton('l', 0), 40);
  }, [client]);
  const tpRight = useCallback(() => {
    haptic();
    client.sendMouseButton('r', 1);
    setTimeout(() => client.sendMouseButton('r', 0), 40);
  }, [client]);
  const tpScroll = useCallback(
    (notches: number) => {
      if (notches !== 0) haptic();
      client.sendWheel(notches);
    },
    [client],
  );

  // Keyboard handlers (protocol v2 keyboard).
  const kbText = useCallback((s: string) => client.sendText(s), [client]);
  const kbBackspace = useCallback(() => client.sendKey('backspace'), [client]);
  const kbEnter = useCallback(() => client.sendKey('enter'), [client]);

  const keyboardBar = (
    <KeyboardBar onText={kbText} onBackspace={kbBackspace} onEnter={kbEnter} />
  );

  return (
    <View
      style={[
        styles.screen,
        { paddingTop: 10, paddingBottom: Math.max(insets.bottom, 10) },
      ]}>
      {/* Header: status pill + input-mode toggle (all modes) */}
      <View style={styles.headerRow}>
        <Pressable onPress={retry} style={styles.pill} hitSlop={8}>
          <View style={[styles.pillDot, { backgroundColor: STATUS_COLOR[status] }]} />
          <Text style={styles.pillText} numberOfLines={1}>
            {statusLabel(status, dev)}
          </Text>
        </Pressable>
        <View style={styles.modeToggle}>
          {MODES.map((m) => (
            <Pressable
              key={m.key}
              onPress={() => setMode(m.key)}
              style={[styles.modeSeg, mode === m.key && styles.modeSegActive]}>
              <Text
                style={[styles.modeSegText, mode === m.key && styles.modeSegTextActive]}>
                {m.label}
              </Text>
            </Pressable>
          ))}
        </View>
      </View>

      {mode === 'swipe' ? (
        <>
          {/* Apple-TV-remote style: big swipe/tap surface + three big buttons */}
          <SwipeSurface onStep={dpadStep} onSelect={selectTap} />
          <View style={styles.swipeBtnRow}>
            <PadButton
              label="‹ BACK"
              {...btn('b')}
              style={styles.swipeBtn}
              color={theme.red}
              fontSize={12}
            />
            <PadButton
              label="STEAM"
              {...btn('guide')}
              style={[styles.swipeBtn, styles.guideBtn]}
              color={theme.blue}
              fontSize={12}
            />
            <PadButton
              label="⋯"
              onDown={qam}
              onUp={NOOP}
              style={[styles.swipeBtn, styles.guideBtn]}
              color={theme.blue}
              fontSize={26}
            />
            <PadButton label="MENU" {...btn('start')} style={styles.swipeBtn} fontSize={12} />
          </View>
          {keyboardBar}
        </>
      ) : mode === 'trackpad' ? (
        <>
          {/* Relative-mouse surface + a mouse-button row + keyboard */}
          <Trackpad
            onMove={tpMove}
            onLeftClick={tpLeft}
            onRightClick={tpRight}
            onScroll={tpScroll}
          />
          <View style={styles.swipeBtnRow}>
            <PadButton
              label="L-CLICK"
              onDown={() => client.sendMouseButton('l', 1)}
              onUp={() => client.sendMouseButton('l', 0)}
              style={styles.swipeBtn}
              fontSize={12}
            />
            <PadButton
              label="M-CLICK"
              onDown={() => client.sendMouseButton('m', 1)}
              onUp={() => client.sendMouseButton('m', 0)}
              style={styles.swipeBtn}
              fontSize={12}
            />
            <PadButton
              label="R-CLICK"
              onDown={() => client.sendMouseButton('r', 1)}
              onUp={() => client.sendMouseButton('r', 0)}
              style={styles.swipeBtn}
              fontSize={12}
            />
          </View>
          {keyboardBar}
        </>
      ) : landscape ? (
        // ---------- Landscape gamepad: real-controller spread ----------
        <View style={styles.landRoot}>
          {/* Bumpers/triggers along the top */}
          <View style={styles.landShoulderRow}>
            <View style={styles.landShoulderSide}>
              <PadButton label="LT" {...trig('lt')} style={styles.shoulderBtn} />
              <PadButton label="LB" {...btn('lb')} style={styles.shoulderBtn} />
            </View>
            <View style={styles.landShoulderSide}>
              <PadButton label="RB" {...btn('rb')} style={styles.shoulderBtn} />
              <PadButton label="RT" {...trig('rt')} style={styles.shoulderBtn} />
            </View>
          </View>

          <View style={styles.landMain}>
            {/* LEFT: stick above d-pad */}
            <View style={styles.landColumn}>
              <Stick onMove={stickMove('l')} onRelease={stickRelease('l')} />
              <View style={styles.dpad}>
                <View style={styles.dpadRow}>
                  <View style={styles.dpadSpacer} />
                  <PadButton label="▲" {...btn('du')} style={styles.dpadBtn} />
                  <View style={styles.dpadSpacer} />
                </View>
                <View style={styles.dpadRow}>
                  <PadButton label="◀" {...btn('dl')} style={styles.dpadBtn} />
                  <View style={styles.dpadCenter} />
                  <PadButton label="▶" {...btn('dr')} style={styles.dpadBtn} />
                </View>
                <View style={styles.dpadRow}>
                  <View style={styles.dpadSpacer} />
                  <PadButton label="▼" {...btn('dd')} style={styles.dpadBtn} />
                  <View style={styles.dpadSpacer} />
                </View>
              </View>
            </View>

            {/* CENTER: menu cluster + thumb-clicks */}
            <View style={styles.landCenter}>
              <View style={styles.menuRow}>
                <PadButton label="SELECT" {...btn('select')} style={styles.menuBtn} fontSize={11} />
                <PadButton
                  label="STEAM"
                  {...btn('guide')}
                  style={[styles.menuBtn, styles.guideBtn]}
                  color={theme.blue}
                  fontSize={11}
                />
                <PadButton
                  label="⋯"
                  onDown={qam}
                  onUp={NOOP}
                  style={[styles.menuBtn, styles.qamBtn, styles.guideBtn]}
                  color={theme.blue}
                  fontSize={20}
                />
                <PadButton label="START" {...btn('start')} style={styles.menuBtn} fontSize={11} />
              </View>
              <View style={styles.landThumbRow}>
                <PadButton label="L3" {...btn('l3')} style={styles.thumbBtn} fontSize={11} />
                <PadButton label="R3" {...btn('r3')} style={styles.thumbBtn} fontSize={11} />
              </View>
            </View>

            {/* RIGHT: ABXY above right stick */}
            <View style={styles.landColumn}>
              <View style={styles.abxy}>
                <View style={styles.abxyRow}>
                  <View style={styles.faceSpacer} />
                  <PadButton label="Y" {...btn('y')} style={styles.faceBtn} color={theme.amber} />
                  <View style={styles.faceSpacer} />
                </View>
                <View style={styles.abxyRow}>
                  <PadButton label="X" {...btn('x')} style={styles.faceBtn} color={theme.blue} />
                  <View style={styles.faceSpacer} />
                  <PadButton label="B" {...btn('b')} style={styles.faceBtn} color={theme.red} />
                </View>
                <View style={styles.abxyRow}>
                  <View style={styles.faceSpacer} />
                  <PadButton label="A" {...btn('a')} style={styles.faceBtn} color={theme.green} />
                  <View style={styles.faceSpacer} />
                </View>
              </View>
              <Stick onMove={stickMove('r')} onRelease={stickRelease('r')} />
            </View>
          </View>
        </View>
      ) : (
        // ---------- Portrait gamepad: original stacked layout ----------
        <>
          {/* Top row: triggers + bumpers */}
          <View style={styles.topRow}>
            <PadButton label="LT" {...trig('lt')} style={styles.shoulderBtn} />
            <PadButton label="LB" {...btn('lb')} style={styles.shoulderBtn} />
            <View style={styles.topSpacer} />
            <PadButton label="RB" {...btn('rb')} style={styles.shoulderBtn} />
            <PadButton label="RT" {...trig('rt')} style={styles.shoulderBtn} />
          </View>

          {/* Middle row: select / guide / start */}
          <View style={styles.menuRow}>
            <PadButton label="SELECT" {...btn('select')} style={styles.menuBtn} fontSize={11} />
            <PadButton
              label="STEAM"
              {...btn('guide')}
              style={[styles.menuBtn, styles.guideBtn]}
              color={theme.blue}
              fontSize={11}
            />
            <PadButton
              label="⋯"
              onDown={qam}
              onUp={NOOP}
              style={[styles.menuBtn, styles.qamBtn, styles.guideBtn]}
              color={theme.blue}
              fontSize={20}
            />
            <PadButton label="START" {...btn('start')} style={styles.menuBtn} fontSize={11} />
          </View>

          {/* Main clusters: d-pad left, ABXY right */}
          <View style={styles.clusterRow}>
            <View style={styles.dpad}>
              <View style={styles.dpadRow}>
                <View style={styles.dpadSpacer} />
                <PadButton label="▲" {...btn('du')} style={styles.dpadBtn} />
                <View style={styles.dpadSpacer} />
              </View>
              <View style={styles.dpadRow}>
                <PadButton label="◀" {...btn('dl')} style={styles.dpadBtn} />
                <View style={styles.dpadCenter} />
                <PadButton label="▶" {...btn('dr')} style={styles.dpadBtn} />
              </View>
              <View style={styles.dpadRow}>
                <View style={styles.dpadSpacer} />
                <PadButton label="▼" {...btn('dd')} style={styles.dpadBtn} />
                <View style={styles.dpadSpacer} />
              </View>
            </View>

            <View style={styles.abxy}>
              <View style={styles.abxyRow}>
                <View style={styles.faceSpacer} />
                <PadButton label="Y" {...btn('y')} style={styles.faceBtn} color={theme.amber} />
                <View style={styles.faceSpacer} />
              </View>
              <View style={styles.abxyRow}>
                <PadButton label="X" {...btn('x')} style={styles.faceBtn} color={theme.blue} />
                <View style={styles.faceSpacer} />
                <PadButton label="B" {...btn('b')} style={styles.faceBtn} color={theme.red} />
              </View>
              <View style={styles.abxyRow}>
                <View style={styles.faceSpacer} />
                <PadButton label="A" {...btn('a')} style={styles.faceBtn} color={theme.green} />
                <View style={styles.faceSpacer} />
              </View>
            </View>
          </View>

          {/* Bottom corners: analog sticks with thumb-click buttons beside them */}
          <View style={styles.stickRow}>
            <View style={styles.stickGroup}>
              <Stick onMove={stickMove('l')} onRelease={stickRelease('l')} />
              <PadButton label="L3" {...btn('l3')} style={styles.thumbBtn} fontSize={11} />
            </View>
            <View style={styles.stickGroup}>
              <PadButton label="R3" {...btn('r3')} style={styles.thumbBtn} fontSize={11} />
              <Stick onMove={stickMove('r')} onRelease={stickRelease('r')} />
            </View>
          </View>
        </>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: theme.bg,
    paddingHorizontal: 12,
    justifyContent: 'space-between',
  },

  btn: {
    backgroundColor: theme.card,
    borderColor: theme.cardBorder,
    borderWidth: 1,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  btnPressed: {
    backgroundColor: theme.inset,
    borderColor: theme.blue,
  },
  btnText: {
    color: theme.textDim,
    fontFamily: mono,
    fontSize: 14,
    fontWeight: '700',
    letterSpacing: 1,
  },

  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 10,
  },
  modeToggle: {
    flexDirection: 'row',
    backgroundColor: theme.inset,
    borderColor: theme.cardBorder,
    borderWidth: 1,
    borderRadius: 999,
    padding: 3,
    gap: 2,
  },
  modeSeg: {
    paddingVertical: 5,
    paddingHorizontal: 12,
    borderRadius: 999,
  },
  modeSegActive: {
    backgroundColor: theme.card,
  },
  modeSegText: {
    color: theme.textFaint,
    fontFamily: mono,
    fontSize: 10,
    fontWeight: '700',
    letterSpacing: 1,
  },
  modeSegTextActive: {
    color: theme.blue,
  },

  swipeSurface: {
    flex: 1,
    backgroundColor: theme.card,
    borderColor: theme.cardBorder,
    borderWidth: 1,
    borderRadius: 24,
    alignItems: 'center',
    justifyContent: 'flex-end',
    padding: 18,
  },
  trackpadSurface: {
    flex: 1,
    backgroundColor: theme.card,
    borderColor: theme.cardBorder,
    borderWidth: 1,
    borderRadius: 24,
    alignItems: 'center',
    justifyContent: 'flex-end',
    padding: 18,
  },
  swipeHint: {
    color: theme.textFaint,
    fontFamily: mono,
    fontSize: 11,
    textAlign: 'center',
  },
  swipeBtnRow: {
    flexDirection: 'row',
    justifyContent: 'center',
    gap: 12,
    marginTop: 14,
  },
  swipeBtn: {
    flex: 1,
    maxWidth: 140,
    height: 64,
    borderRadius: 999,
  },

  // Keyboard bar
  kbBarRow: {
    marginTop: 12,
    flexDirection: 'row',
    alignItems: 'stretch',
    gap: 8,
  },
  kbBar: {
    backgroundColor: theme.card,
    borderColor: theme.cardBorder,
    borderWidth: 1,
    borderRadius: 999,
    paddingVertical: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  kbBarFlex: {
    flex: 1,
  },
  kbBarOpen: {
    borderColor: theme.blue,
    backgroundColor: theme.inset,
  },
  kbDragHandle: {
    width: 36,
    height: 4,
    borderRadius: 2,
    backgroundColor: theme.blue,
    opacity: 0.5,
    marginBottom: 6,
  },
  kbDone: {
    backgroundColor: theme.blue,
    borderRadius: 999,
    paddingHorizontal: 20,
    alignItems: 'center',
    justifyContent: 'center',
  },
  kbDoneText: {
    color: '#0b1220',
    fontFamily: mono,
    fontSize: 13,
    fontWeight: '800',
    letterSpacing: 1,
  },
  kbBarText: {
    color: theme.textDim,
    fontFamily: mono,
    fontSize: 12,
    fontWeight: '700',
    letterSpacing: 1,
  },
  kbBarTextOpen: {
    color: theme.blue,
  },
  hiddenInput: {
    // Invisible but FOCUSABLE. iOS won't let a fully transparent (alpha 0) or
    // off-window view become first responder, so a hidden keyboard-capture
    // input must stay on-screen with a hair of opacity. Transparent text keeps
    // the captured keystrokes from ever being seen.
    position: 'absolute',
    bottom: 0,
    left: 0,
    width: 1,
    height: 1,
    opacity: 0.02,
    color: 'transparent',
  },

  topRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  topSpacer: {
    flex: 1,
  },
  shoulderBtn: {
    width: 60,
    height: 48,
  },
  pill: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    backgroundColor: theme.inset,
    borderColor: theme.cardBorder,
    borderWidth: 1,
    borderRadius: 999,
    paddingVertical: 6,
    paddingHorizontal: 10,
    minWidth: 0,
  },
  pillDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  pillText: {
    color: theme.textDim,
    fontFamily: mono,
    fontSize: 10,
    flexShrink: 1,
  },

  menuRow: {
    flexDirection: 'row',
    justifyContent: 'center',
    gap: 8,
    marginTop: 12,
  },
  menuBtn: {
    width: 80,
    height: 40,
    borderRadius: 999,
  },
  // Compact icon-only ⋯ (Quick Access) button; overrides menuBtn's width.
  qamBtn: {
    width: 48,
  },
  guideBtn: {
    borderColor: theme.blue,
  },

  clusterRow: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginVertical: 10,
  },
  dpad: {
    gap: 4,
  },
  dpadRow: {
    flexDirection: 'row',
    gap: 4,
  },
  dpadBtn: {
    width: 58,
    height: 58,
  },
  dpadCenter: {
    width: 58,
    height: 58,
    borderRadius: 12,
    backgroundColor: theme.inset,
    borderColor: theme.cardBorder,
    borderWidth: 1,
  },
  dpadSpacer: {
    width: 58,
    height: 58,
  },
  abxy: {
    gap: 4,
  },
  abxyRow: {
    flexDirection: 'row',
    gap: 4,
    justifyContent: 'center',
  },
  faceBtn: {
    width: 58,
    height: 58,
    borderRadius: 29,
  },
  faceSpacer: {
    width: 58,
    height: 58,
  },

  stickRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-end',
  },
  stickGroup: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 8,
  },
  thumbBtn: {
    width: 44,
    height: 44,
    borderRadius: 22,
    marginBottom: 8,
  },
  stickPad: {
    width: STICK_SIZE,
    height: STICK_SIZE,
    borderRadius: STICK_SIZE / 2,
    backgroundColor: theme.inset,
    borderColor: theme.cardBorder,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  stickCross: {
    position: 'absolute',
    width: 10,
    height: 10,
    borderRadius: 5,
    backgroundColor: theme.cardBorder,
  },
  stickNub: {
    width: NUB_SIZE,
    height: NUB_SIZE,
    borderRadius: NUB_SIZE / 2,
    backgroundColor: theme.card,
    borderColor: theme.blue,
    borderWidth: 1,
  },

  // ---------- Landscape gamepad layout ----------
  landRoot: {
    flex: 1,
  },
  landShoulderRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 8,
  },
  landShoulderSide: {
    flexDirection: 'row',
    gap: 8,
  },
  landMain: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  landColumn: {
    alignItems: 'center',
    justifyContent: 'center',
    gap: 14,
  },
  landCenter: {
    alignItems: 'center',
    justifyContent: 'center',
    gap: 16,
  },
  landThumbRow: {
    flexDirection: 'row',
    gap: 16,
  },
});
