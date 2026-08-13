/**
 * A slider used by the LED editors, built on react-native-gesture-handler so it
 * arbitrates cleanly against the gestures around it:
 *  - `activeOffsetX` claims a HORIZONTAL drag, so it wins over iOS's navigation
 *    swipe (the `◀ App` back gesture) and the tab/stack swipe — the "slider
 *    fights navigation" bug.
 *  - `failOffsetY` yields a VERTICAL drag to the Console ScrollView, so a scroll
 *    that happens to start on the track still scrolls the page.
 * A tap sets the value too (so the web harness can press it, CLAUDE.md §6).
 *
 * Tracking is by ABSOLUTE touch X (gesture `absoluteX`) minus the track's
 * measured window-left — not a child-relative coordinate, which jumps as the
 * finger crosses the fill/thumb/hue segments.
 */
import React, { useMemo, useRef } from 'react';
import { StyleSheet, View, type LayoutChangeEvent } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';

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

  const viewRef = useRef<View>(null);
  const geom = useRef({ x: 0, w: 1 });
  const live = useRef(props);
  live.current = props;

  const measure = () =>
    viewRef.current?.measureInWindow((x, _y, w) => { geom.current = { x, w: w || 1 }; });

  const emit = (absX: number, commit: boolean) => {
    const p = live.current;
    if (p.disabled) return;
    const frac = clamp(absX - geom.current.x, 0, geom.current.w) / geom.current.w;
    const v = p.min + frac * (p.max - p.min);
    p.onChange(v);
    if (commit) p.onCommit(v);
  };

  const gesture = useMemo(() => {
    const pan = Gesture.Pan()
      .runOnJS(true)
      .activeOffsetX([-8, 8])
      .failOffsetY([-16, 16])
      .onBegin(() => measure())
      .onUpdate((e) => emit(e.absoluteX, false))
      .onEnd((e) => emit(e.absoluteX, true));
    const tap = Gesture.Tap()
      .runOnJS(true)
      .onEnd((e) => { measure(); emit(e.absoluteX, true); });
    // Pan preferred (a drag); tap only if the pan never activated (a plain tap).
    return Gesture.Exclusive(pan, tap);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const pct = clamp((value - min) / (max - min), 0, 1);
  return (
    <GestureDetector gesture={gesture}>
      <View
        ref={viewRef}
        onLayout={(_e: LayoutChangeEvent) => measure()}
        accessibilityRole="adjustable"
        accessibilityLabel={accessibilityLabel}
        accessibilityValue={{ min, max, now: Math.round(value) }}
        style={[styles.track, disabled && styles.disabled]}>
        {renderTrack(pct)}
        <View pointerEvents="none" style={[styles.thumb, { left: `${pct * 100}%`, borderColor: thumbColor }]} />
      </View>
    </GestureDetector>
  );
}

const makeStyles = (t: Palette) =>
  StyleSheet.create({
    track: { height: 34, borderRadius: 10, justifyContent: 'center', overflow: 'visible' },
    disabled: { opacity: 0.5 },
    thumb: {
      position: 'absolute', top: 3, width: 28, height: 28, borderRadius: 14,
      marginLeft: -14, backgroundColor: t.text, borderWidth: 3,
      shadowColor: '#000', shadowOpacity: 0.35, shadowRadius: 3,
      shadowOffset: { width: 0, height: 1 }, elevation: 3,
    },
  });
