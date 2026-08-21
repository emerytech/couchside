/**
 * A transient volume overlay ("OSD"). It flashes at the bottom of the screen the
 * moment Couchside runs a volume op, so the user sees the change on the phone
 * without looking at the TV. Fed by the agent's /ws/volume push (lib/
 * volumeStream.ts) — relative only (up / down / mute), because a passthrough
 * audio sink / a TV that won't report its level means no absolute number is
 * readable. Mounted once, app-wide, over the tab content.
 */
import Ionicons from '@expo/vector-icons/Ionicons';
import React from 'react';
import { Animated, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { hostKey } from '@/lib/api';
import { useSettings } from '@/lib/SettingsContext';
import { mono, useThemedStyles, type Palette } from '@/lib/theme';
import { VolumeStreamClient, type VolumeDir } from '@/lib/volumeStream';

type Nudge = { dir: VolumeDir; n: number };

/** Manage the /ws/volume client for the active box; surface the latest nudge. */
function useVolumeNudge(): Nudge | null {
  const { settings, ready } = useSettings();
  const configured = settings.host.trim().length > 0;
  const key = hostKey(settings);
  const [nudge, setNudge] = React.useState<Nudge | null>(null);
  const clientRef = React.useRef<VolumeStreamClient | null>(null);
  const countRef = React.useRef(0);

  React.useEffect(() => {
    if (!ready || !configured) return;
    const client = new VolumeStreamClient();
    clientRef.current = client;
    client.onNudge((dir) => {
      countRef.current += 1;
      setNudge({ dir, n: countRef.current });
    });
    client.start(settings);
    return () => {
      client.onNudge(null);
      client.stop();
      clientRef.current = null;
    };
    // Re-open on box switch (key) or connection-detail change; settings is read
    // fresh inside. eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, configured, key]); // eslint-disable-line react-hooks/exhaustive-deps

  return nudge;
}

const HOLD_MS = 1400;
const ICON: Record<VolumeDir, React.ComponentProps<typeof Ionicons>['name']> = {
  up: 'volume-high',
  down: 'volume-low',
  mute: 'volume-mute',
};
const LABEL: Record<VolumeDir, string> = { up: 'VOLUME', down: 'VOLUME', mute: 'MUTED' };

export default function VolumeOsd() {
  const styles = useThemedStyles(makeStyles);
  const insets = useSafeAreaInsets();
  const nudge = useVolumeNudge();
  const opacity = React.useRef(new Animated.Value(0)).current;
  const lift = React.useRef(new Animated.Value(0)).current;
  const [shown, setShown] = React.useState<VolumeDir | null>(null);
  const hideTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  React.useEffect(() => {
    if (!nudge) return;
    setShown(nudge.dir);
    Animated.parallel([
      Animated.timing(opacity, { toValue: 1, duration: 120, useNativeDriver: true }),
      Animated.spring(lift, { toValue: 1, useNativeDriver: true, speed: 20, bounciness: 6 }),
    ]).start();
    if (hideTimer.current) clearTimeout(hideTimer.current);
    hideTimer.current = setTimeout(() => {
      Animated.timing(opacity, { toValue: 0, duration: 260, useNativeDriver: true }).start(
        ({ finished }) => {
          if (finished) {
            setShown(null);
            lift.setValue(0);
          }
        },
      );
    }, HOLD_MS);
    return () => {
      if (hideTimer.current) clearTimeout(hideTimer.current);
    };
    // fire on every nudge, including a repeat of the same direction
  }, [nudge, opacity, lift]);

  if (shown == null) return null;

  const translateY = lift.interpolate({ inputRange: [0, 1], outputRange: [14, 0] });

  return (
    <View pointerEvents="none" style={[styles.wrap, { bottom: insets.bottom + 92 }]}>
      <Animated.View style={[styles.pill, { opacity, transform: [{ translateY }] }]}>
        <Ionicons name={ICON[shown]} size={22} style={styles.icon} />
        <Text style={styles.label}>{LABEL[shown]}</Text>
        {shown !== 'mute' && (
          <Ionicons
            name={shown === 'up' ? 'chevron-up' : 'chevron-down'}
            size={18}
            style={styles.dir}
          />
        )}
      </Animated.View>
    </View>
  );
}

const makeStyles = (t: Palette) =>
  StyleSheet.create({
    wrap: {
      position: 'absolute',
      left: 0,
      right: 0,
      alignItems: 'center',
      zIndex: 50,
    },
    pill: {
      flexDirection: 'row',
      alignItems: 'center',
      backgroundColor: t.card,
      borderColor: t.cardBorder,
      borderWidth: 1,
      borderRadius: 999,
      paddingVertical: 10,
      paddingHorizontal: 18,
      gap: 9,
      shadowColor: '#000',
      shadowOpacity: 0.3,
      shadowRadius: 12,
      shadowOffset: { width: 0, height: 4 },
      elevation: 6,
    },
    icon: { color: t.blue },
    label: { color: t.text, fontSize: 13, fontWeight: '800', fontFamily: mono, letterSpacing: 2 },
    dir: { color: t.textDim },
  });
