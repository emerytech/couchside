/**
 * Desktop control — a fullscreen remote-desktop surface (P1 of the remote-desktop
 * project; see docs/memory/project_remote-desktop.md). Reached from the Console
 * screen viewer's "Control" button.
 *
 * The live screen frame fills the view; a dedicated trackpad zone drives the
 * desktop pointer over the SAME /ws/gamepad input path the Pad uses (relative
 * mouse — proven + already low-latency).
 *
 * TWO modes, chosen by caps.screenstream (the opt-in xdg-desktop-portal module):
 *   - module ABSENT (default): the P1 still-frame poller (~1.4fps, "confirm-by-
 *     frame") + relative trackpad. Works on every box.
 *   - module PRESENT: the FLUID /ws/screen MJPEG stream + tap-to-point (tap the
 *     frame -> the portal's absolute pointer moves there and clicks). The relative
 *     trackpad still works for fine control. Degrades to the poller if the stream
 *     fails (e.g. box in Game Mode -> no portal desktop session).
 *
 * It owns its OWN GamepadClient for the duration of the screen: connect +
 * requestControl on mount, releaseAll + close on unmount. `noPad:true` — this
 * surface needs mouse/keyboard only, never a virtual gamepad, so there is no
 * d-pad axis to strand (the Pad's releaseAll-on-surface-change dance does not
 * apply here; the trackpad releases its own left button on pointer-up).
 *
 * LAPTOP layout (portrait — only the Pad may allow landscape, a guarded
 * invariant): the screen frame sits on top, a dedicated trackpad zone drives the
 * pointer below it, and a button bar is at the bottom. Watching the screen while
 * trackpadding beneath it beats trackpadding on a tiny letterboxed frame, and it
 * keeps the relative-mouse model honest (tap-a-spot-on-the-frame is P2/absolute).
 */
import Ionicons from '@expo/vector-icons/Ionicons';
import { Stack, router } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator, Image, Pressable, StyleSheet, Text, View,
  useWindowDimensions, type GestureResponderEvent,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { DesktopFullscreen } from '@/components/DesktopFullscreen';
import { useDesktopKeyboard } from '@/components/DesktopKeyboard';
import { ScreenVideo } from '@/components/ScreenVideo';
import { useLockOrientation } from '@/hooks/useLockOrientation';
import { useScreenFrame } from '@/hooks/useScreenFrame';
import { useScreenStream } from '@/hooks/useScreenStream';
import { useWebRtcStream } from '@/hooks/useWebRtcStream';
import { useTrackpad } from '@/hooks/useTrackpad';
import { GamepadClient, type GamepadStatus } from '@/lib/gamepad';
import { webrtcSupported } from '@/lib/webrtcstream';
import { hapticLight, hapticMedium } from '@/lib/haptics';
import { setImmersive } from '@/lib/immersive';
import { useSettings } from '@/lib/SettingsContext';
import { useTheme, useThemedStyles, type Palette } from '@/lib/theme';

const FRAME_MS = 700;
const DEVICE_LABEL = 'Couchside Desktop';

// The H.264/WebRTC tier is DISABLED: react-native-webrtc@124 is incompatible with
// React Native 0.86's new architecture — RTCView crashes on render and
// setRemoteDescription takes 10+ seconds before the peer connection aborts
// (diagnosed on-device 2026-08-10). Until a react-native-webrtc release supports
// RN 0.86, the app uses the MJPEG stream (caps.screenstream) + the still-frame
// poller. Flip to true to re-enable once the native dep catches up.
const WEBRTC_TIER_ENABLED = false;

export default function DesktopControlScreen() {
  // Portrait = the laptop layout; landscape = the fullscreen "Remote Desktop"
  // surface (the whole screen is the touch input). Rotate freely between them.
  useLockOrientation('allow-landscape');
  const { width, height } = useWindowDimensions();
  const landscape = width > height;
  const t = useTheme();
  const styles = useThemedStyles(makeStyles);
  const insets = useSafeAreaInsets();
  const { settings, ready } = useSettings();
  const configured = settings.host.trim().length > 0;
  // THREE tiers, best-first (all hooks run — hooks rules — only the active one
  // connects):
  //   1. WebRTC H.264 (fluid, 30–60fps): app built WITH react-native-webrtc AND
  //      the box advertising a WORKING H.264 path (caps.screenstream_h264). On a
  //      hard failure we demote to tier 2 for the rest of the session.
  //   2. MJPEG /ws/screen (fluid, ~15fps): caps.screenstream. Also what every
  //      in-the-wild app (no WebRTC) gets.
  //   3. P1 still-frame poller (~1.4fps): always available.
  // Tiers 1 & 2 both get tap-to-point (the portal's absolute pointer).
  const [webrtcGaveUp, setWebrtcGaveUp] = useState(false);
  const webrtcMode =
    WEBRTC_TIER_ENABLED && webrtcSupported
    && settings.caps?.screenstream_h264 === true && !webrtcGaveUp;
  const streamMode = !webrtcMode && settings.caps?.screenstream === true;
  const fluidMode = webrtcMode || streamMode;
  const live = ready && configured;
  const streamed = useScreenStream(settings, live && streamMode);
  const webrtc = useWebRtcStream(settings, live && webrtcMode);
  // Still-frame poller. Runs when there is no fluid tier — AND as a STOPGAP VIEW
  // while a selected fluid tier has not produced its first frame yet. That gap
  // is not rare: an app background can leave the box's previous gst still on the
  // shared portal capture when the reopened stream starts, so the new /ws/screen
  // is OPEN but silent (0 frames) — which used to spin "Approve…" forever with
  // no escape. The poller captures via spectacle/gamescopectl (NOT the portal),
  // so it shows the desktop even when the portal session is wedged, and it gates
  // OFF the instant the fluid tier delivers a frame (reopening retries fluid).
  const fluidHasFrame = (webrtcMode && webrtc.streamURL != null)
    || (streamMode && streamed.frame != null);
  const poll = useScreenFrame(settings, live && (!fluidMode || !fluidHasFrame), FRAME_MS);

  // Auto-fallback: a hard WebRTC failure (negotiation/timeout) demotes to MJPEG
  // for the rest of this screen. One-way — we do not re-try WebRTC (that re-pops
  // the box's consent); reopening the desktop starts fresh.
  useEffect(() => {
    if (webrtcMode && webrtc.failed) setWebrtcGaveUp(true);
  }, [webrtcMode, webrtc.failed]);

  const streamURL = webrtcMode ? webrtc.streamURL : null;
  // The <Image> frame (tiers 2/3). Prefer the fluid stream frame; fall back to
  // the poller frame during the first-frame gap / a wedged portal session. In
  // WebRTC mode a "failure" means we are demoting, not that the screen is
  // unavailable, so don't surface it as such.
  const frame = webrtcMode ? null
    : streamMode ? (streamed.frame ?? poll.frame)
    : poll.frame;
  // "failed" only when we have NO visual path left — the fluid stream failed AND
  // the poller fallback also failed. A silent/wedged stream with a working
  // poller is NOT a failure (the desktop is still on screen).
  const failed = webrtcMode ? false
    : streamMode ? (streamed.failed && poll.failed)
    : poll.failed;
  const hasVisual = streamURL != null || frame != null;

  const clientRef = useRef<GamepadClient | null>(null);
  if (clientRef.current == null) clientRef.current = new GamepadClient();
  const client = clientRef.current;
  const [status, setStatus] = useState<GamepadStatus>('connecting');
  const connectedOnce = useRef(false);

  // Phone keyboard -> box (existing {t:'kt'}/{t:'k'} uinput path). The box's
  // own {t:'osk'} event (Steam raised a text field) auto-raises it.
  const [oskSignal, setOskSignal] = useState(0);
  const kb = useDesktopKeyboard(client, { autoOpenSignal: oskSignal });

  // Lifecycle: immersive + status subscription + teardown. Runs for the life of
  // the screen regardless of when (or whether) the box is reachable.
  useEffect(() => {
    setImmersive(true);
    client.onStatus((s) => setStatus(s));
    client.onOsk(() => setOskSignal((n) => n + 1));
    return () => {
      client.onStatus(null);
      client.onOsk(null);
      // Release the MOUSE buttons explicitly before closing: releaseAll() covers
      // the pad (buttons/sticks) but NOT the pointer (see GamepadClient), and an
      // unmount mid double-tap-drag fires no onDragEnd — a left button left down
      // turns every later move into a drag ("the mouse does nothing"). Sent while
      // the socket is still open; no-ops if nothing is held.
      client.sendMouseButton('l', 0);
      client.sendMouseButton('r', 0);
      client.sendMouseButton('m', 0);
      client.close(); // close() also releaseAll()s the pad + tears the socket down
      setImmersive(false);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Connect ONCE settings have hydrated. Gating on ready && configured avoids
  // connecting with EMPTY_SETTINGS (which errors permanently with no retry) when
  // this route somehow mounts before the box store loads; the ref makes it fire
  // exactly once, never reconnecting on background settings churn.
  useEffect(() => {
    if (!ready || !configured || connectedOnce.current) return;
    connectedOnce.current = true;
    client.connect(settings, { handoffAsk: false, deviceName: DEVICE_LABEL, noPad: true });
    client.requestControl();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, configured]);

  const leftClick = useCallback(() => {
    hapticLight();
    client.sendMouseButton('l', 1);
    setTimeout(() => client.sendMouseButton('l', 0), 40);
  }, [client]);
  const rightClick = useCallback(() => {
    hapticLight();
    client.sendMouseButton('r', 1);
    setTimeout(() => client.sendMouseButton('r', 0), 40);
  }, [client]);

  const pad = useTrackpad({
    onMove: (dx, dy) => client.sendMouseMove(dx, dy),
    onLeftClick: leftClick,
    onRightClick: rightClick,
    onScroll: (notches) => client.sendWheel(notches),
    onDragStart: () => { hapticLight(); client.sendMouseButton('l', 1); },
    onDragEnd: () => client.sendMouseButton('l', 0),
  });

  // Tap-to-point (P2, fluid mode only): the tap's location within the frame maps
  // to a normalized 0..1 coordinate for the portal's absolute pointer. The stage
  // is 16:9 and the stream is 16:9, so there is no `contain` letterbox — the map
  // is just location / measured size. (A non-16:9 source would need letterbox math.)
  const stageSize = useRef({ w: 0, h: 0 });
  const onTapFrame = useCallback((e: GestureResponderEvent) => {
    const { w, h } = stageSize.current;
    if (w <= 0 || h <= 0) return;
    hapticLight();
    // q01 on the client clamps to 0..1, so an edge tap past the bounds is fine.
    client.tapAbs(e.nativeEvent.locationX / w, e.nativeEvent.locationY / h);
  }, [client]);

  const exit = useCallback(() => { hapticMedium(); router.back(); }, []);

  // LANDSCAPE: the fullscreen "Remote Desktop" surface — the whole screen is the
  // touch input (Mouse trackpad + local cursor, or direct Touch). Absolute input
  // (the local cursor lock) needs the portal, i.e. a fluid tier.
  if (landscape) {
    return (
      <>
        <Stack.Screen options={{ headerShown: false, gestureEnabled: false, fullScreenGestureEnabled: false }} />
        <DesktopFullscreen
          client={client}
          streamURL={streamURL}
          frame={frame}
          status={status}
          failed={failed}
          configured={configured}
          absoluteInput={fluidMode}
          onExit={exit}
          keyboard={kb}
        />
      </>
    );
  }

  return (
    <View style={[styles.root, { paddingTop: insets.top }]}>
      <Stack.Screen options={{ headerShown: false, gestureEnabled: false, fullScreenGestureEnabled: false }} />
      {/* SCREEN (top): the live desktop frame */}
      <View style={styles.stage}>
        {streamURL ? (
          // Tier 1: native H.264 video (hardware decode).
          <ScreenVideo streamURL={streamURL} style={StyleSheet.absoluteFill} />
        ) : frame ? (
          // Tier 2/3: MJPEG stream / still-frame poller, as a base64 <Image>.
          <Image source={{ uri: frame }} style={StyleSheet.absoluteFill} resizeMode="contain" />
        ) : (
          <View style={[StyleSheet.absoluteFill, styles.center]}>
            <ActivityIndicator color={t.textDim} />
            <Text style={styles.dim}>
              {!configured ? 'Connect a box first.'
                : fluidMode ? 'Approve remote control on your box…'
                : 'Waiting for the screen…'}
            </Text>
          </View>
        )}
        {/* Tap-to-point overlay (fluid tiers only): tapping the frame moves the
            real cursor there and clicks, via the portal's absolute pointer. */}
        {fluidMode && hasVisual && (
          <Pressable
            style={StyleSheet.absoluteFill}
            onLayout={(e) => {
              stageSize.current = { w: e.nativeEvent.layout.width, h: e.nativeEvent.layout.height };
            }}
            onPress={onTapFrame}
            accessibilityLabel="Tap the screen to click there" />
        )}
        {status !== 'connected' && (
          <View style={[styles.pill, { top: 6 }]} pointerEvents="none">
            <Text style={styles.pillText}>
              {status === 'released' || status === 'waiting' ? 'no control — reopen' : status}
            </Text>
          </View>
        )}
        {failed && status === 'connected' && (
          <View style={[styles.pill, { top: 6 }]} pointerEvents="none">
            <Text style={styles.pillText}>screen unavailable</Text>
          </View>
        )}
      </View>

      {/* TRACKPAD (middle): the touch surface that drives the pointer */}
      <View style={styles.trackpad} {...pad.panHandlers} accessibilityLabel="Desktop trackpad">
        <Ionicons name="move-outline" size={22} color={t.textFaint} />
        <Text style={styles.trackpadHint}>
          {fluidMode
            ? 'tap the screen to point · drag here to move · two-finger scroll'
            : 'drag to move · tap to click · two-finger scroll'}
        </Text>
      </View>

      <View style={[styles.bar, { paddingBottom: insets.bottom + 8 }]}>
        <BarBtn t={t} styles={styles} icon="close" label="Exit" onPress={exit} />
        <BarBtn t={t} styles={styles} icon="radio-button-on" label="Left" onPress={leftClick} />
        <BarBtn t={t} styles={styles} icon="ellipsis-horizontal" label="Right" onPress={rightClick} />
        <BarBtn t={t} styles={styles} icon="apps" label="Start"
          onPress={() => { hapticLight(); client.sendDesktopKey('meta'); }} />
        <BarBtn t={t} styles={styles} icon="keypad-outline" label="Keys" onPress={kb.toggle} />
        <BarBtn t={t} styles={styles} icon="arrow-undo" label="Esc"
          onPress={() => { hapticLight(); client.sendKey('esc'); }} />
      </View>
      {kb.bar}
    </View>
  );
}

function BarBtn({
  t, styles, icon, label, onPress,
}: {
  t: Palette; styles: ReturnType<typeof makeStyles>; icon: keyof typeof Ionicons.glyphMap;
  label: string; onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      style={({ pressed }) => [styles.barBtn, pressed && { opacity: 0.6 }]}>
      <Ionicons name={icon} size={20} color={t.text} />
      <Text style={styles.barLabel}>{label}</Text>
    </Pressable>
  );
}

const makeStyles = (t: Palette) =>
  StyleSheet.create({
    root: { flex: 1, backgroundColor: t.bg },
    stage: { width: '100%', aspectRatio: 16 / 9, backgroundColor: '#000', overflow: 'hidden' },
    center: { alignItems: 'center', justifyContent: 'center', gap: 10 },
    dim: { color: t.textDim, fontSize: 13 },
    trackpad: {
      flex: 1, margin: 12, borderRadius: 16,
      borderWidth: 1, borderColor: t.cardBorder, borderStyle: 'dashed',
      backgroundColor: t.card, alignItems: 'center', justifyContent: 'center', gap: 8,
    },
    trackpadHint: { color: t.textFaint, fontSize: 12 },
    pill: {
      position: 'absolute', right: 10,
      backgroundColor: t.redDeep, borderColor: t.red, borderWidth: 1,
      paddingHorizontal: 10, paddingVertical: 4, borderRadius: 8,
    },
    pillText: { color: t.onRedDeep, fontSize: 11, fontWeight: '700' },
    bar: {
      flexDirection: 'row', justifyContent: 'space-around', alignItems: 'center',
      paddingTop: 8, backgroundColor: t.card, borderTopColor: t.cardBorder, borderTopWidth: 1,
    },
    barBtn: { alignItems: 'center', justifyContent: 'center', gap: 3, paddingHorizontal: 10, paddingVertical: 4, minWidth: 56 },
    barLabel: { color: t.textDim, fontSize: 11, fontWeight: '600' },
  });
