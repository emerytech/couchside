/**
 * Desktop control — a fullscreen remote-desktop surface (P1 of the remote-desktop
 * project; see docs/memory/project_remote-desktop.md). Reached from the Console
 * screen viewer's "Control" button.
 *
 * The live screen frame fills the view; a transparent trackpad overlay on top
 * drives the desktop pointer over the SAME /ws/gamepad input path the Pad uses
 * (relative mouse — proven + already low-latency). This is "confirm-by-frame"
 * control at ~1.4fps, not fluid video (that is the opt-in P4 streaming module).
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
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useLockOrientation } from '@/hooks/useLockOrientation';
import { useScreenFrame } from '@/hooks/useScreenFrame';
import { useTrackpad } from '@/hooks/useTrackpad';
import { GamepadClient, type GamepadStatus } from '@/lib/gamepad';
import { hapticLight, hapticMedium } from '@/lib/haptics';
import { setImmersive } from '@/lib/immersive';
import { useSettings } from '@/lib/SettingsContext';
import { useTheme, useThemedStyles, type Palette } from '@/lib/theme';

const FRAME_MS = 700;
const DEVICE_LABEL = 'Couchside Desktop';

export default function DesktopControlScreen() {
  useLockOrientation('portrait'); // laptop layout; only the Pad may allow landscape
  const t = useTheme();
  const styles = useThemedStyles(makeStyles);
  const insets = useSafeAreaInsets();
  const { settings, ready } = useSettings();
  const configured = settings.host.trim().length > 0;
  const { frame, failed } = useScreenFrame(settings, ready && configured, FRAME_MS);

  const clientRef = useRef<GamepadClient | null>(null);
  if (clientRef.current == null) clientRef.current = new GamepadClient();
  const client = clientRef.current;
  const [status, setStatus] = useState<GamepadStatus>('connecting');
  const connectedOnce = useRef(false);

  // Lifecycle: immersive + status subscription + teardown. Runs for the life of
  // the screen regardless of when (or whether) the box is reachable.
  useEffect(() => {
    setImmersive(true);
    client.onStatus((s) => setStatus(s));
    return () => {
      client.onStatus(null);
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

  const exit = useCallback(() => { hapticMedium(); router.back(); }, []);

  return (
    <View style={[styles.root, { paddingTop: insets.top }]}>
      <Stack.Screen options={{ headerShown: false }} />
      {/* SCREEN (top): the live desktop frame */}
      <View style={styles.stage}>
        {frame ? (
          <Image source={{ uri: frame }} style={StyleSheet.absoluteFill} resizeMode="contain" />
        ) : (
          <View style={[StyleSheet.absoluteFill, styles.center]}>
            <ActivityIndicator color={t.textDim} />
            <Text style={styles.dim}>
              {!configured ? 'Connect a box first.' : 'Waiting for the screen…'}
            </Text>
          </View>
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
        <Text style={styles.trackpadHint}>drag to move · tap to click · two-finger scroll</Text>
      </View>

      <View style={[styles.bar, { paddingBottom: insets.bottom + 8 }]}>
        <BarBtn t={t} styles={styles} icon="close" label="Exit" onPress={exit} />
        <BarBtn t={t} styles={styles} icon="radio-button-on" label="Left" onPress={leftClick} />
        <BarBtn t={t} styles={styles} icon="ellipsis-horizontal" label="Right" onPress={rightClick} />
        <BarBtn t={t} styles={styles} icon="apps" label="Start"
          onPress={() => { hapticLight(); client.sendDesktopKey('meta'); }} />
        <BarBtn t={t} styles={styles} icon="arrow-undo" label="Esc"
          onPress={() => { hapticLight(); client.sendKey('esc'); }} />
      </View>
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
