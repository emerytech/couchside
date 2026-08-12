/**
 * Fullscreen LANDSCAPE remote-desktop surface (P4b P0 UX) — the "Microsoft
 * Remote Desktop" layout the owner asked for: the remote screen fills the phone
 * and the whole surface is the input area, with two touch modes:
 *
 *   - MOUSE (trackpad): drag anywhere to move a LOCAL cursor; tap = left click at
 *     the cursor; two-finger drag = scroll. The local cursor is the lag fix — it
 *     tracks your finger instantly and every move sends an ABSOLUTE position to
 *     the box (portal), so the real cursor stays locked to the local one instead
 *     of lagging behind the video feedback.
 *   - TOUCH (direct): tap where you want to click (tap-to-point); drag moves the
 *     cursor to your finger.
 *
 * Absolute positioning needs the portal module (caps.screenstream / _h264). On a
 * box without it (still-frame poller) we fall back to a relative trackpad and hide
 * the local cursor (there is no absolute pointer to lock it to).
 */
import Ionicons from '@expo/vector-icons/Ionicons';
import { useMemo, useRef, useState } from 'react';
import {
  Animated, Image, PanResponder, Pressable, StyleSheet, Text, View,
  useWindowDimensions, type GestureResponderEvent,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { ScreenVideo } from '@/components/ScreenVideo';
import type { GamepadClient, GamepadStatus } from '@/lib/gamepad';
import { hapticLight, hapticMedium } from '@/lib/haptics';
import { useTheme, type Palette } from '@/lib/theme';

type Mode = 'mouse' | 'touch';

const TAP_MS = 250;
const TAP_SLOP = 8;
const SCROLL_STEP = 26;
const SEND_MS = 25; // coalesce absolute-move sends to ~40/s (box round-trip cap)
// A second touch starting within this of a tap release ARMS a drag: the first
// move then holds the left button, so you can drag a window title bar (or
// marquee-select). Matches the trackpad's double-tap-drag feel.
const DOUBLE_TAP_MS = 300;
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

export function DesktopFullscreen({
  client, streamURL, frame, status, failed, configured, absoluteInput,
  pointerChannel = 'portal', preferTouch = false, onExit, keyboard,
}: {
  client: GamepadClient;
  streamURL: string | null;
  frame: string | null;
  status: GamepadStatus;
  failed: boolean;
  configured: boolean;
  absoluteInput: boolean;
  /** Which absolute-pointer wire path to drive: 'portal' ({t:'ma'}/{t:'mbp'}) on
   *  the desktop, 'game' ({t:'gm'}, xdotool) in gamescope Game Mode. */
  pointerChannel?: 'portal' | 'game';
  /** Default the touch mode to direct tap-to-point (the Game Mode default). */
  preferTouch?: boolean;
  onExit: () => void;
  /** From useDesktopKeyboard (owned by the parent so one instance serves both
   *  orientations): toolbar Keys button calls toggle; bar renders here. */
  keyboard?: { bar: React.ReactNode; open: boolean; toggle: () => void };
}) {
  const t = useTheme();
  const { width, height } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const [mode, setMode] = useState<Mode>(preferTouch ? 'touch' : 'mouse');
  const [barOpen, setBarOpen] = useState(true);

  // 16:9 content rect, contain-fit + centered (letterbox on the wider phone).
  const rect = useMemo(() => {
    const ar = 16 / 9;
    let w = width;
    let h = width / ar;
    if (h > height) { h = height; w = height * ar; }
    return { w, h, x: (width - w) / 2, y: (height - h) / 2 };
  }, [width, height]);

  // Local predicted cursor (mouse mode): screen px, kept inside `rect`.
  const cur = useRef({ x: rect.x + rect.w / 2, y: rect.y + rect.h / 2 });
  const curXY = useRef(new Animated.ValueXY(cur.current)).current;

  // The local sprite moves at touch rate (instant), but the ABSOLUTE position
  // sent to the box is COALESCED to ~40/s: the box does a portal round-trip per
  // move, and flooding it at 60/s queues the real cursor behind. Always send the
  // LATEST position (drop intermediate), so the box cursor tracks in real time.
  const send = useRef<{ x: number; y: number } | null>(null);
  const sendAt = useRef(0);
  const sendTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flushSend = () => {
    sendTimer.current = null;
    const p = send.current;
    if (!p) return;
    send.current = null;
    sendAt.current = Date.now();
    if (pointerChannel === 'game') client.sendGameMove(p.x, p.y);
    else client.sendMouseAbs(p.x, p.y);
  };
  const queueSend = (nx: number, ny: number) => {
    send.current = { x: nx, y: ny };
    const dt = Date.now() - sendAt.current;
    if (dt >= SEND_MS) { flushSend(); return; }
    if (sendTimer.current == null) {
      sendTimer.current = setTimeout(flushSend, SEND_MS - dt);
    }
  };

  const moveCursorTo = (px: number, py: number) => {
    const x = clamp(px, rect.x, rect.x + rect.w);
    const y = clamp(py, rect.y, rect.y + rect.h);
    cur.current = { x, y };
    curXY.setValue({ x, y });                    // sprite: instant
    queueSend((x - rect.x) / rect.w, (y - rect.y) / rect.h); // box: coalesced
  };

  const g = useRef({
    t0: 0, lastDx: 0, lastDy: 0, moved: false, touches: 1,
    scrollAccum: 0, scrollLastY: 0, startX: 0, startY: 0,
    lastTapEndT: 0, armed: false, dragging: false,
  });

  // Left button down/up, held across a drag (portal abs vs uinput relative).
  // Game Mode has no separate button down/up (the {t:'gm'} verb is an atomic
  // move+click), so down/up are no-ops there and a click becomes a tap at the
  // current cursor. Portal + relative keep their real down/up (drag/marquee).
  const mouseDown = (btn: 'l' | 'r') => {
    if (pointerChannel === 'game') return;
    if (absoluteInput) client.sendMouseButtonPortal(btn, 1);
    else client.sendMouseButton(btn, 1);
  };
  const mouseUp = (btn: 'l' | 'r') => {
    if (pointerChannel === 'game') return;
    if (absoluteInput) client.sendMouseButtonPortal(btn, 0);
    else client.sendMouseButton(btn, 0);
  };
  const tapAtCursor = () => {
    client.tapGame((cur.current.x - rect.x) / rect.w, (cur.current.y - rect.y) / rect.h);
  };
  const leftClick = () => {
    if (pointerChannel === 'game') { tapAtCursor(); return; }
    mouseDown('l'); setTimeout(() => mouseUp('l'), 40);
  };
  const rightClick = () => {
    if (pointerChannel === 'game') return; // right-click isn't meaningful in Big Picture
    mouseDown('r'); setTimeout(() => mouseUp('r'), 40);
  };

  const pan = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: () => true,
        onPanResponderTerminationRequest: () => false,
        onPanResponderGrant: (e: GestureResponderEvent) => {
          const s = g.current;
          const now = Date.now();
          s.t0 = now;
          s.lastDx = 0; s.lastDy = 0; s.moved = false;
          s.touches = e.nativeEvent.touches.length || 1;
          s.scrollAccum = 0; s.scrollLastY = 0;
          s.startX = e.nativeEvent.locationX;
          s.startY = e.nativeEvent.locationY;
          // A single touch landing just after a tap ARMS a drag (button held on
          // first move — see below). A plain double-tap that never moves stays a
          // second click, so double-click still maximizes a window.
          s.armed = s.touches < 2 && now - s.lastTapEndT < DOUBLE_TAP_MS;
          s.dragging = false;
          // Touch mode: the cursor jumps to the finger immediately.
          if (mode === 'touch' && absoluteInput) {
            moveCursorTo(e.nativeEvent.locationX, e.nativeEvent.locationY);
          }
        },
        onPanResponderMove: (e, gs) => {
          const s = g.current;
          const touches = e.nativeEvent.touches.length;
          if (touches > s.touches) s.touches = touches;
          if (!s.moved && Math.hypot(gs.dx, gs.dy) > TAP_SLOP) s.moved = true;

          if (s.touches >= 2) {
            const dd = gs.dy - s.scrollLastY;
            s.scrollAccum += dd;
            s.scrollLastY = gs.dy;
            while (Math.abs(s.scrollAccum) >= SCROLL_STEP) {
              const dir = s.scrollAccum > 0 ? 1 : -1;
              s.scrollAccum -= dir * SCROLL_STEP;
              client.sendWheel(-dir); // drag down -> wheel down
            }
            return;
          }

          const ddx = gs.dx - s.lastDx;
          const ddy = gs.dy - s.lastDy;
          s.lastDx = gs.dx; s.lastDy = gs.dy;

          // Armed double-tap: the first real movement presses + HOLDS the left
          // button, so the drag that follows moves a window / marquee-selects.
          if (s.armed && !s.dragging && s.moved) {
            s.dragging = true;
            hapticLight();
            mouseDown('l');
          }

          if (mode === 'touch' && absoluteInput) {
            moveCursorTo(e.nativeEvent.locationX, e.nativeEvent.locationY);
          } else if (absoluteInput) {
            moveCursorTo(cur.current.x + ddx, cur.current.y + ddy);
          } else {
            client.sendMouseMove(ddx, ddy);
          }
        },
        onPanResponderRelease: () => {
          const s = g.current;
          const now = Date.now();
          if (s.dragging) {
            // End the held-button drag; not a tap, and don't chain another.
            s.dragging = false;
            s.armed = false;
            s.lastTapEndT = 0;
            mouseUp('l');
            s.touches = 1;
            return;
          }
          const dt = now - s.t0;
          if (!s.moved && dt < TAP_MS && s.touches < 2) {
            hapticLight();
            leftClick(); // both modes: a tap is a left click at the cursor
            s.lastTapEndT = now; // arm a possible double-tap-drag next
          } else {
            s.lastTapEndT = 0;
          }
          s.touches = 1;
        },
      }),
    // Rebuild when the mode / capability / geometry changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [mode, absoluteInput, rect.w, rect.h, rect.x, rect.y],
  );

  const styles = makeStyles(t);
  const showCursor = absoluteInput && (streamURL != null || frame != null);

  return (
    <View style={styles.root}>
      {/* VIDEO (fills the 16:9 content rect) */}
      <View
        style={{
          position: 'absolute', left: rect.x, top: rect.y, width: rect.w, height: rect.h,
        }}>
        {streamURL ? (
          <ScreenVideo streamURL={streamURL} style={StyleSheet.absoluteFill} />
        ) : frame ? (
          <Image source={{ uri: frame }} style={StyleSheet.absoluteFill} resizeMode="contain" />
        ) : (
          <View style={[StyleSheet.absoluteFill, styles.center]}>
            <Text style={styles.dim}>
              {!configured ? 'Connect a box first.'
                : pointerChannel === 'game' ? 'Waiting for the screen…'
                : 'Approve remote control on your box…'}
            </Text>
          </View>
        )}
      </View>

      {/* INPUT SURFACE (whole screen) */}
      <View style={StyleSheet.absoluteFill} {...pan.panHandlers} />

      {/* LOCAL CURSOR (mouse/touch, portal only). A small ring with a center dot:
          the DOT is the exact click point (curXY), so what you aim IS what clicks —
          no hotspot offset like an arrow whose tip differs from its body. */}
      {showCursor && (
        <Animated.View
          pointerEvents="none"
          style={[styles.cursor, { transform: curXY.getTranslateTransform() }]}>
          <View style={styles.cursorRing} />
          <View style={styles.cursorDot} />
        </Animated.View>
      )}

      {/* FLOATING TOOLBAR */}
      {barOpen ? (
        <View style={[styles.bar, { top: insets.top + 6, right: insets.right + 8 }]}>
          <TB icon="close" label="Exit" styles={styles} t={t}
            onPress={() => { hapticMedium(); onExit(); }} />
          <TB icon={mode === 'mouse' ? 'move' : 'finger-print'}
            label={mode === 'mouse' ? 'Mouse' : 'Touch'} styles={styles} t={t}
            active
            onPress={() => { hapticLight(); setMode((m) => (m === 'mouse' ? 'touch' : 'mouse')); }} />
          {pointerChannel === 'game' ? (
            // Game Mode: the D-pad + Select ride the keyboard path Steam Big
            // Picture reads (the uinput mouse is not grabbed there), alongside
            // tap-to-point.
            <>
              <TB icon="chevron-back" label="Left" styles={styles} t={t}
                onPress={() => { hapticLight(); client.sendKey('left'); }} />
              <TB icon="chevron-up" label="Up" styles={styles} t={t}
                onPress={() => { hapticLight(); client.sendKey('up'); }} />
              <TB icon="chevron-down" label="Down" styles={styles} t={t}
                onPress={() => { hapticLight(); client.sendKey('down'); }} />
              <TB icon="chevron-forward" label="Right" styles={styles} t={t}
                onPress={() => { hapticLight(); client.sendKey('right'); }} />
              <TB icon="checkmark-circle" label="Select" styles={styles} t={t}
                onPress={() => { hapticLight(); client.sendKey('enter'); }} />
            </>
          ) : (
            <>
              <TB icon="radio-button-on" label="Left" styles={styles} t={t}
                onPress={() => { hapticLight(); leftClick(); }} />
              <TB icon="ellipsis-horizontal" label="Right" styles={styles} t={t}
                onPress={() => { hapticLight(); rightClick(); }} />
              <TB icon="apps" label="Start" styles={styles} t={t}
                onPress={() => { hapticLight(); client.sendDesktopKey('meta'); }} />
            </>
          )}
          {keyboard && (
            <TB icon="keypad-outline" label="Keys" styles={styles} t={t}
              active={keyboard.open} onPress={keyboard.toggle} />
          )}
          <TB icon="arrow-undo" label="Esc" styles={styles} t={t}
            onPress={() => { hapticLight(); client.sendKey('esc'); }} />
          <TB icon="chevron-up" label="Hide" styles={styles} t={t}
            onPress={() => setBarOpen(false)} />
        </View>
      ) : (
        <Pressable
          onPress={() => setBarOpen(true)}
          style={[styles.handle, { top: insets.top + 6, right: insets.right + 8 }]}
          accessibilityLabel="Show controls">
          <Ionicons name="chevron-down" size={18} color={t.text} />
        </Pressable>
      )}

      {/* status pills */}
      {status !== 'connected' && (
        <View style={[styles.pill, { top: insets.top + 6, left: insets.left + 10 }]} pointerEvents="none">
          <Text style={styles.pillText}>
            {status === 'released' || status === 'waiting' ? 'no control — reopen' : status}
          </Text>
        </View>
      )}
      {failed && status === 'connected' && (
        <View style={[styles.pill, { top: insets.top + 6, left: insets.left + 10 }]} pointerEvents="none">
          <Text style={styles.pillText}>screen unavailable</Text>
        </View>
      )}

      {/* Phone-keyboard compose bar (absolute at the screen bottom) */}
      {keyboard?.bar}
    </View>
  );
}

function TB({
  icon, label, onPress, active, styles, t,
}: {
  icon: keyof typeof Ionicons.glyphMap; label: string; onPress: () => void;
  active?: boolean; styles: ReturnType<typeof makeStyles>; t: Palette;
}) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      style={({ pressed }) => [styles.tb, active && styles.tbActive, pressed && { opacity: 0.6 }]}>
      <Ionicons name={icon} size={18} color={active ? t.accent : t.text} />
      <Text style={[styles.tbLabel, active && { color: t.accent }]}>{label}</Text>
    </Pressable>
  );
}

const makeStyles = (t: Palette) =>
  StyleSheet.create({
    root: { flex: 1, backgroundColor: '#000' },
    center: { alignItems: 'center', justifyContent: 'center' },
    dim: { color: t.textDim, fontSize: 13 },
    cursor: {
      position: 'absolute', left: -11, top: -11, width: 22, height: 22,
      alignItems: 'center', justifyContent: 'center',
    },
    cursorRing: {
      position: 'absolute', width: 18, height: 18, borderRadius: 9,
      borderWidth: 1.5, borderColor: 'rgba(255,255,255,0.95)',
      shadowColor: '#000', shadowOpacity: 0.85, shadowRadius: 2,
    },
    cursorDot: {
      width: 4, height: 4, borderRadius: 2, backgroundColor: '#fff',
      shadowColor: '#000', shadowOpacity: 0.9, shadowRadius: 1.5,
    },
    bar: {
      position: 'absolute', flexDirection: 'row', alignItems: 'center', gap: 2,
      backgroundColor: 'rgba(20,24,33,0.82)', borderColor: t.cardBorder, borderWidth: 1,
      borderRadius: 12, paddingHorizontal: 4, paddingVertical: 3,
    },
    tb: { alignItems: 'center', justifyContent: 'center', gap: 2, paddingHorizontal: 9, paddingVertical: 4, minWidth: 46 },
    tbActive: { backgroundColor: 'rgba(255,255,255,0.08)', borderRadius: 8 },
    tbLabel: { color: t.textDim, fontSize: 10, fontWeight: '600' },
    handle: {
      position: 'absolute', backgroundColor: 'rgba(20,24,33,0.82)',
      borderColor: t.cardBorder, borderWidth: 1, borderRadius: 10, padding: 6,
    },
    pill: {
      position: 'absolute', backgroundColor: t.redDeep, borderColor: t.red, borderWidth: 1,
      paddingHorizontal: 10, paddingVertical: 4, borderRadius: 8,
    },
    pillText: { color: t.onRedDeep, fontSize: 11, fontWeight: '700' },
  });
