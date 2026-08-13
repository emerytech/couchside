/**
 * A PanResponder slider used by the LED editors. A DRAG feels native; a single
 * TAP on the track also sets the value (the responder grant fires with the tap
 * position), so the web harness can press it too (CLAUDE.md §6). `onChange` fires
 * live for a preview; `onCommit` fires on release/tap — that's when the write
 * goes to the box. The DRAG gesture is on-device-only proof.
 */
import React, { useRef } from 'react';
import { PanResponder, StyleSheet, View } from 'react-native';

import { clamp } from '@/lib/ledColor';
import { useTheme, useThemedStyles, type Palette } from '@/lib/theme';

export function TrackSlider(props: {
  value: number;
  min: number;
  max: number;
  onChange: (v: number) => void;
  onCommit: (v: number) => void;
  renderTrack: (pct: number) => React.ReactNode;
  thumbColor: string;
  disabled?: boolean;
  accessibilityLabel: string;
}) {
  const t = useTheme();
  const styles = useThemedStyles(makeStyles);
  const { value, min, max, renderTrack, thumbColor, disabled, accessibilityLabel } = props;
  const wRef = useRef(0);
  // Latest props in a ref so the once-created responder never reads stale values.
  const live = useRef(props);
  live.current = props;

  const emit = (locationX: number, commit: boolean) => {
    const p = live.current;
    const w = wRef.current || 1;
    const frac = clamp(locationX, 0, w) / w;
    const v = p.min + frac * (p.max - p.min);
    p.onChange(v);
    if (commit) p.onCommit(v);
  };

  const pan = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => !live.current.disabled,
      onMoveShouldSetPanResponder: () => !live.current.disabled,
      onPanResponderGrant: (e) => emit(e.nativeEvent.locationX, false),
      onPanResponderMove: (e) => emit(e.nativeEvent.locationX, false),
      onPanResponderRelease: (e) => emit(e.nativeEvent.locationX, true),
    }),
  ).current;

  const pct = clamp((value - min) / (max - min), 0, 1);
  return (
    <View
      onLayout={(e) => { wRef.current = e.nativeEvent.layout.width; }}
      {...pan.panHandlers}
      accessibilityRole="adjustable"
      accessibilityLabel={accessibilityLabel}
      accessibilityValue={{ min, max, now: Math.round(value) }}
      style={[styles.track, disabled && styles.disabled]}>
      {renderTrack(pct)}
      <View style={[styles.thumb, { left: `${pct * 100}%`, borderColor: thumbColor }]} />
    </View>
  );
}

const makeStyles = (t: Palette) =>
  StyleSheet.create({
    // Intentionally tall for a comfortable touch/drag target.
    track: { height: 34, borderRadius: 10, justifyContent: 'center', overflow: 'visible' },
    disabled: { opacity: 0.5 },
    thumb: {
      position: 'absolute', top: 3, width: 28, height: 28, borderRadius: 14,
      marginLeft: -14, backgroundColor: t.text, borderWidth: 3,
      shadowColor: '#000', shadowOpacity: 0.35, shadowRadius: 3,
      shadowOffset: { width: 0, height: 1 }, elevation: 3,
    },
  });
