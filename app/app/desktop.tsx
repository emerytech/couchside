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
import { Stack, router, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator, Animated, Image, Pressable, StyleSheet, Text, View,
  useWindowDimensions, type GestureResponderEvent,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { DesktopFullscreen } from '@/components/DesktopFullscreen';
import { useDesktopKeyboard } from '@/components/DesktopKeyboard';
import { H264DecoderView, type H264Msg, type H264Profile } from '@/components/H264DecoderView';
import { ScreenVideo } from '@/components/ScreenVideo';
import { useLockOrientation } from '@/hooks/useLockOrientation';
import { useScreenFrame } from '@/hooks/useScreenFrame';
import { useScreenStream } from '@/hooks/useScreenStream';
import { useWebRtcStream } from '@/hooks/useWebRtcStream';
import { useTrackpad } from '@/hooks/useTrackpad';
import { resolveEffectiveHost } from '@/lib/api';
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

// H.264 WebCodecs tier profile. 720p60 = smooth on the LAN with decode headroom
// (measured q=0 on device); the box downscales the desktop to 720p and the phone
// hardware-decodes. Bump to 1080p* for sharper text at more bandwidth.
const H264_PROFILE: H264Profile = '720p60';

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
  // GAME MODE (gamescope / Big Picture): the xdg-desktop-portal is absent, so
  // input rides the {t:'gm'} xdotool path and the view stays on the still-frame
  // poller. `session` is a snapshot passed by the Console card at navigation time
  // (a mid-control desktop<->game flip just needs a reopen). Consumed only as a
  // boolean flag — never interpolated into anything.
  const { session } = useLocalSearchParams<{ session?: string }>();
  const gameMode = session === 'gamescope';
  // FOUR tiers, best-first (all hooks run — hooks rules — only the active one
  // connects):
  //   1. H.264 WebCodecs (fluid, 30–60fps): the box advertises a VA encoder
  //      (caps.screenstream_h264) AND the WebView can decode. Renders the box's
  //      /ws/h264 Annex-B stream in a react-native-webview canvas. On a hard
  //      failure (no VideoDecoder / configure error / closed before a frame) we
  //      demote to tier 2 for the rest of the session.
  //   2. WebRTC H.264: PARKED (WEBRTC_TIER_ENABLED=false — react-native-webrtc is
  //      incompatible with RN 0.86). The WebCodecs tier replaces it.
  //   3. MJPEG /ws/screen (fluid, ~15fps): caps.screenstream. What every app with
  //      an older/unsupported WebView falls back to.
  //   4. P1 still-frame poller (~1.4fps): always available.
  // Tiers 1–3 all get tap-to-point (the portal's absolute pointer).
  const [webrtcGaveUp, setWebrtcGaveUp] = useState(false);
  const [h264GaveUp, setH264GaveUp] = useState(false);
  const [h264HasFrame, setH264HasFrame] = useState(false);
  const h264GotFrame = useRef(false);   // stable read for the close-before-frame demote
  // The fluid (portal) tiers are OFF in game mode — the portal doesn't exist
  // there, so gating them off keeps the view on the poller and avoids a dead
  // "Approve…" spinner.
  const h264Mode =
    !gameMode && settings.caps?.screenstream_h264 === true && !h264GaveUp;
  const webrtcMode =
    !gameMode && !h264Mode && WEBRTC_TIER_ENABLED && webrtcSupported
    && settings.caps?.screenstream_h264 === true && !webrtcGaveUp;
  const streamMode =
    !gameMode && !h264Mode && !webrtcMode && settings.caps?.screenstream === true;
  const fluidMode = h264Mode || webrtcMode || streamMode;
  // The absolute-pointer flag both the portal (fluid) and game-mode (xdotool)
  // paths share: tap-to-point + the local cursor render, and the trackpad drives
  // an ABSOLUTE cursor rather than a relative one. Which wire verb it uses is
  // chosen per-send by `gameMode` ({t:'gm'} vs {t:'ma'}).
  const absoluteInput = fluidMode || gameMode;
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
  const fluidHasFrame = (h264Mode && h264HasFrame)
    || (webrtcMode && webrtc.streamURL != null)
    || (streamMode && streamed.frame != null);
  const poll = useScreenFrame(settings, live && (!fluidMode || !fluidHasFrame), FRAME_MS);

  // Auto-fallback: a hard WebRTC failure (negotiation/timeout) demotes to MJPEG
  // for the rest of this screen. One-way — we do not re-try WebRTC (that re-pops
  // the box's consent); reopening the desktop starts fresh.
  useEffect(() => {
    if (webrtcMode && webrtc.failed) setWebrtcGaveUp(true);
  }, [webrtcMode, webrtc.failed]);

  // H.264 tier messages (from the decoder WebView's own JS). first-frame gates the
  // poller stopgap off; a device that can't decode (no VideoDecoder / configure
  // error) or a stream the box closes BEFORE any frame (no module / denied / over
  // cap) demotes to MJPEG for the rest of the screen — one-way, like WebRTC.
  const onH264Msg = useCallback((m: H264Msg) => {
    if (m.t === 'firstframe') {
      h264GotFrame.current = true;
      setH264HasFrame(true);
    } else if (m.t === 'env' && !m.hasVideoDecoder) {
      setH264GaveUp(true);
    } else if (m.t === 'cfgerror') {
      setH264GaveUp(true);
    } else if (m.t === 'wsclose' && !h264GotFrame.current) {
      setH264GaveUp(true);
    }
  }, []);

  const streamURL = webrtcMode ? webrtc.streamURL : null;
  // The H.264 decoder params, passed to whichever layout is mounted. Host is the
  // last-good resolved host (mirrors every other box call).
  const h264 = h264Mode
    ? { host: resolveEffectiveHost(settings), port: settings.port,
        token: settings.token, profile: H264_PROFILE, onMessage: onH264Msg }
    : null;
  // The <Image> frame (tiers 2/3, and the H.264 spin-up COVER). Prefer the fluid
  // stream frame; fall back to the poller frame during the first-frame gap / a
  // wedged portal session. For H.264 the poller frame covers the black canvas
  // ONLY until the decoder paints (then null -> the WebView shows). WebRTC/H.264
  // "failure" means demoting, not that the screen is unavailable.
  const frame = h264Mode ? (h264HasFrame ? null : poll.frame)
    : webrtcMode ? null
    : streamMode ? (streamed.frame ?? poll.frame)
    : poll.frame;
  // "failed" only when we have NO visual path left — the fluid stream failed AND
  // the poller fallback also failed. A silent/wedged stream with a working
  // poller is NOT a failure (the desktop is still on screen). H.264 renders its
  // own canvas + demotes on hard failure, so it never sets `failed`.
  const failed = h264Mode ? false
    : webrtcMode ? false
    : streamMode ? (streamed.failed && poll.failed)
    : poll.failed;
  const hasVisual = h264Mode || streamURL != null || frame != null;

  const clientRef = useRef<GamepadClient | null>(null);
  if (clientRef.current == null) clientRef.current = new GamepadClient();
  const client = clientRef.current;
  const [status, setStatus] = useState<GamepadStatus>('connecting');
  const connectedOnce = useRef(false);

  // Phone keyboard -> box (existing {t:'kt'}/{t:'k'} uinput path). The box's
  // own {t:'osk'} event (Steam raised a text field) auto-raises it.
  const [oskSignal, setOskSignal] = useState(0);
  const kb = useDesktopKeyboard(client, { autoOpenSignal: oskSignal, landscape });

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

  // ── Portrait local cursor (absolute mode: portal OR game) ──────────────────
  // The frame carries the box's own (tiny) cursor, but portrait otherwise draws
  // nothing — so next to landscape's ring+dot it read as "no cursor". Give
  // portrait the same local sprite: the trackpad drives a cursor inside the 16:9
  // stage and sends an ABSOLUTE position, so the sprite is visible AND the box
  // cursor locks to it. The wire verb is portal {t:'ma'} on desktop, xdotool
  // {t:'gm'} in game mode. Relative mode (no portal, no game) keeps the plain
  // trackpad — it never knows the box's absolute position, so a sprite would drift.
  const SEND_MS = 25; // coalesce abs-move sends to ~40/s (box round-trip cap)
  const stageSize = useRef({ w: 0, h: 0 });
  const cur = useRef({ x: 0, y: 0 });                 // stage px
  const curXY = useRef(new Animated.ValueXY({ x: 0, y: 0 })).current;
  const curReady = useRef(false);
  const sendAbs = useRef<{ x: number; y: number } | null>(null);
  const sendAbsAt = useRef(0);
  const sendAbsTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flushAbs = () => {
    sendAbsTimer.current = null;
    const p = sendAbs.current;
    if (!p) return;
    sendAbs.current = null;
    sendAbsAt.current = Date.now();
    if (gameMode) client.sendGameMove(p.x, p.y);
    else client.sendMouseAbs(p.x, p.y);
  };
  const queueAbs = (nx: number, ny: number) => {
    sendAbs.current = { x: nx, y: ny };
    const dt = Date.now() - sendAbsAt.current;
    if (dt >= SEND_MS) { flushAbs(); return; }
    if (sendAbsTimer.current == null) sendAbsTimer.current = setTimeout(flushAbs, SEND_MS - dt);
  };
  // Move the sprite to a stage-px point; `send` also pushes its normalized position.
  const cursorToPx = (px: number, py: number, send = true) => {
    const { w, h } = stageSize.current;
    if (w <= 0 || h <= 0) return;
    const x = Math.max(0, Math.min(w, px));
    const y = Math.max(0, Math.min(h, py));
    cur.current = { x, y };
    curXY.setValue({ x, y });
    if (send) queueAbs(x / w, y / h);
  };
  useEffect(() => () => {
    if (sendAbsTimer.current) clearTimeout(sendAbsTimer.current);
  }, []);

  // In fluid mode a click rides the PORTAL button (at the portal's absolute
  // position, where the sprite is); in game mode it is an atomic xdotool tap at
  // the sprite; relative mode uses the uinput button.
  const clickAt = useCallback((btn: 'l' | 'r') => {
    hapticLight();
    if (gameMode) {
      // Game mode has no separate button down/up — a click is a move+click at the
      // current cursor. Only left is meaningful for Big Picture menus.
      const { w, h } = stageSize.current;
      if (btn === 'l' && w > 0 && h > 0) {
        client.tapGame(cur.current.x / w, cur.current.y / h);
      }
    } else if (fluidMode) {
      client.sendMouseButtonPortal(btn, 1);
      setTimeout(() => client.sendMouseButtonPortal(btn, 0), 40);
    } else {
      client.sendMouseButton(btn, 1);
      setTimeout(() => client.sendMouseButton(btn, 0), 40);
    }
  }, [client, fluidMode, gameMode]);
  const leftClick = useCallback(() => clickAt('l'), [clickAt]);
  const rightClick = useCallback(() => clickAt('r'), [clickAt]);

  const pad = useTrackpad({
    onMove: (dx, dy) => {
      if (absoluteInput) cursorToPx(cur.current.x + dx, cur.current.y + dy);
      else client.sendMouseMove(dx, dy);
    },
    onLeftClick: leftClick,
    onRightClick: rightClick,
    onScroll: (notches) => client.sendWheel(notches),
    onDragStart: () => {
      hapticLight();
      // Game mode has no held-button drag (the {t:'gm'} verb is an atomic
      // move+click), so a drag there just moves the cursor — no button hold.
      if (gameMode) return;
      if (fluidMode) client.sendMouseButtonPortal('l', 1);
      else client.sendMouseButton('l', 1);
    },
    onDragEnd: () => {
      if (gameMode) return;
      if (fluidMode) client.sendMouseButtonPortal('l', 0);
      else client.sendMouseButton('l', 0);
    },
  });

  // Tap-to-point (P2, fluid mode only): the tap's location within the frame maps
  // to a normalized 0..1 coordinate for the portal's absolute pointer. The stage
  // is 16:9 and the stream is 16:9, so there is no `contain` letterbox — the map
  // is just location / measured size. The local sprite jumps to the tap too, so
  // it stays where the click lands.
  const onTapFrame = useCallback((e: GestureResponderEvent) => {
    const { w, h } = stageSize.current;
    if (w <= 0 || h <= 0) return;
    hapticLight();
    const px = e.nativeEvent.locationX;
    const py = e.nativeEvent.locationY;
    cursorToPx(px, py, false);          // sprite jumps; the tap does the send + click
    if (gameMode) client.tapGame(px / w, py / h);
    else client.tapAbs(px / w, py / h); // q01 clamps to 0..1 (an edge tap is fine)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, gameMode]);

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
          h264={h264}
          streamURL={streamURL}
          frame={frame}
          status={status}
          failed={failed}
          configured={configured}
          absoluteInput={absoluteInput}
          pointerChannel={gameMode ? 'game' : 'portal'}
          preferTouch={gameMode}
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
        {h264 ? (
          // Tier 1: H.264 WebCodecs decode in a WebView canvas. pointerEvents=none
          // so the tap-to-point overlay above always gets the touch (the WebView
          // never grabs it). The poller `frame` covers the black canvas until the
          // decoder paints its first frame.
          <>
            <View pointerEvents="none" style={StyleSheet.absoluteFill}>
              <H264DecoderView
                host={h264.host} port={h264.port} token={h264.token}
                profile={h264.profile} onMessage={h264.onMessage}
                style={StyleSheet.absoluteFill}
              />
            </View>
            {frame && (
              <Image source={{ uri: frame }} style={StyleSheet.absoluteFill} resizeMode="contain" />
            )}
          </>
        ) : streamURL ? (
          // Tier 2 (parked): native react-native-webrtc video.
          <ScreenVideo streamURL={streamURL} style={StyleSheet.absoluteFill} />
        ) : frame ? (
          // Tier 3/4: MJPEG stream / still-frame poller, as a base64 <Image>.
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
        {absoluteInput && hasVisual && (
          <Pressable
            style={StyleSheet.absoluteFill}
            onLayout={(e) => {
              const { width, height } = e.nativeEvent.layout;
              stageSize.current = { w: width, h: height };
              if (!curReady.current && width > 0 && height > 0) {
                curReady.current = true;
                cur.current = { x: width / 2, y: height / 2 };
                curXY.setValue({ x: width / 2, y: height / 2 });
              }
            }}
            onPress={onTapFrame}
            accessibilityLabel="Tap the screen to click there" />
        )}
        {/* Local cursor sprite (fluid mode): ring + center dot; the DOT is the
            exact click point — same as the landscape surface. */}
        {absoluteInput && hasVisual && (
          <Animated.View
            pointerEvents="none"
            style={[styles.cursor, { transform: curXY.getTranslateTransform() }]}>
            <View style={styles.cursorRing} />
            <View style={styles.cursorDot} />
          </Animated.View>
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
          {absoluteInput
            ? 'tap the screen to point · drag here to move · two-finger scroll'
            : 'drag to move · tap to click · two-finger scroll'}
        </Text>
      </View>

      <View style={[styles.bar, { paddingBottom: insets.bottom + 8 }]}>
        <BarBtn t={t} styles={styles} icon="close" label="Exit" onPress={exit} />
        {gameMode ? (
          // Game Mode: the D-pad + Select ride the KEYBOARD path Steam Big Picture
          // reads (arrows/enter). The uinput MOUSE is not grabbed in Game Mode, so
          // this is the proven fallback alongside tap-to-point. The phone keyboard
          // still auto-raises on a Steam text field via the {t:'osk'} subscription.
          <>
            <BarBtn t={t} styles={styles} icon="chevron-back" label="Left"
              onPress={() => { hapticLight(); client.sendKey('left'); }} />
            <BarBtn t={t} styles={styles} icon="chevron-up" label="Up"
              onPress={() => { hapticLight(); client.sendKey('up'); }} />
            <BarBtn t={t} styles={styles} icon="chevron-down" label="Down"
              onPress={() => { hapticLight(); client.sendKey('down'); }} />
            <BarBtn t={t} styles={styles} icon="chevron-forward" label="Right"
              onPress={() => { hapticLight(); client.sendKey('right'); }} />
            <BarBtn t={t} styles={styles} icon="checkmark-circle" label="Select"
              onPress={() => { hapticLight(); client.sendKey('enter'); }} />
          </>
        ) : (
          <>
            <BarBtn t={t} styles={styles} icon="radio-button-on" label="Left" onPress={leftClick} />
            <BarBtn t={t} styles={styles} icon="ellipsis-horizontal" label="Right" onPress={rightClick} />
            <BarBtn t={t} styles={styles} icon="apps" label="Start"
              onPress={() => { hapticLight(); client.sendDesktopKey('meta'); }} />
            <BarBtn t={t} styles={styles} icon="keypad-outline" label="Keys" onPress={kb.toggle} />
          </>
        )}
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
  });
