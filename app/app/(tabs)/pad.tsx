/**
 * Virtual gamepad. Emulates an Xbox 360 pad on the box over the agent's
 * /ws/gamepad WebSocket (protocol v1). Connected only while this tab is
 * focused and the app is foregrounded; everything is released on the way out.
 */
import * as Haptics from 'expo-haptics';
import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake';
import { useNavigation } from 'expo-router';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Animated,
  AppState,
  PanResponder,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
  ViewStyle,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Gated } from '@/components/Gated';
import { TabScreen } from '@/components/TabScreen';
import { ButtonKey, GamepadClient, GamepadStatus, StickKey, TriggerKey } from '@/lib/gamepad';
import { PadMode } from '@/lib/settings';
import { useSettings } from '@/lib/SettingsContext';
import { mono, theme } from '@/lib/theme';

const KEEP_AWAKE_TAG = 'rescue-remote-pad';

function haptic() {
  if (Platform.OS !== 'web') {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
  }
}

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
      return 'disconnected — tap to retry';
  }
}

// ---------- Screen ----------

export default function PadTab() {
  return (
    <TabScreen>
      <Gated>
        <PadScreen />
      </Gated>
    </TabScreen>
  );
}

function PadScreen() {
  const insets = useSafeAreaInsets();
  const navigation = useNavigation();
  const { settings, ready, update } = useSettings();
  const mode: PadMode = settings.padMode ?? 'swipe';
  const [status, setStatus] = useState<GamepadStatus>('closed');
  const [dev, setDev] = useState<string | null>(null);

  const clientRef = useRef<GamepadClient | null>(null);
  if (clientRef.current == null) {
    clientRef.current = new GamepadClient();
  }
  const client = clientRef.current;

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
      client.connect(settings);
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
  }, [client, ready, settings, navigation]);

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

  return (
    <View
      style={[
        styles.screen,
        { paddingTop: 10, paddingBottom: Math.max(insets.bottom, 10) },
      ]}>
      {/* Header: status pill + input-mode toggle (both modes) */}
      <View style={styles.headerRow}>
        <Pressable onPress={retry} style={styles.pill} hitSlop={8}>
          <View style={[styles.pillDot, { backgroundColor: STATUS_COLOR[status] }]} />
          <Text style={styles.pillText} numberOfLines={1}>
            {statusLabel(status, dev)}
          </Text>
        </Pressable>
        <View style={styles.modeToggle}>
          <Pressable
            onPress={() => setMode('gamepad')}
            style={[styles.modeSeg, mode === 'gamepad' && styles.modeSegActive]}>
            <Text style={[styles.modeSegText, mode === 'gamepad' && styles.modeSegTextActive]}>
              PAD
            </Text>
          </Pressable>
          <Pressable
            onPress={() => setMode('swipe')}
            style={[styles.modeSeg, mode === 'swipe' && styles.modeSegActive]}>
            <Text style={[styles.modeSegText, mode === 'swipe' && styles.modeSegTextActive]}>
              SWIPE
            </Text>
          </Pressable>
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
            <PadButton label="MENU" {...btn('start')} style={styles.swipeBtn} fontSize={12} />
          </View>
        </>
      ) : (
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
    paddingHorizontal: 14,
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
  swipeHint: {
    color: theme.textFaint,
    fontFamily: mono,
    fontSize: 11,
  },
  swipeBtnRow: {
    flexDirection: 'row',
    justifyContent: 'center',
    gap: 16,
    marginTop: 14,
  },
  swipeBtn: {
    width: 96,
    height: 64,
    borderRadius: 999,
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
    gap: 14,
    marginTop: 12,
  },
  menuBtn: {
    width: 84,
    height: 40,
    borderRadius: 999,
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
});
