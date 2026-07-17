import React from 'react';
import { StyleSheet, View } from 'react-native';

/**
 * Tiny bar sparkline for the Console/Fleet vitals cards. Plain Views — no SVG
 * dependency — one slim bar per sample, height scaled into [min,max]. Null
 * samples render as gaps (the agent records "couldn't read" as null; drawing 0
 * would be a lie). Renders nothing until there are 2+ real samples, so cards
 * look unchanged against old agents (no history field) and on first poll.
 */
export function Sparkline({
  values,
  color,
  height = 22,
  min,
  max,
}: {
  values: (number | null)[] | undefined;
  color: string;
  height?: number;
  /** Fixed scale bounds; omitted = auto-scale to the data's own range. */
  min?: number;
  max?: number;
}) {
  const real = (values ?? []).filter((v): v is number => v != null);
  if (!values || real.length < 2) return null;

  const lo = min ?? Math.min(...real);
  const hi = max ?? Math.max(...real);
  const span = hi - lo;

  return (
    <View style={[styles.row, { height }]} pointerEvents="none">
      {values.map((v, i) => {
        if (v == null) return <View key={i} style={styles.bar} />;
        // Flat data still shows presence: clamp into [0.12, 1] of the height.
        const frac = span > 0 ? (v - lo) / span : 0.5;
        const h = Math.max(3, Math.round(height * (0.12 + 0.88 * Math.min(1, Math.max(0, frac)))));
        return <View key={i} style={[styles.bar, { height: h, backgroundColor: color, opacity: 0.55 }]} />;
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 2,
    marginTop: 8,
  },
  bar: {
    flex: 1,
    borderRadius: 1,
    // Null-sample gap: keep layout width, draw nothing.
    backgroundColor: 'transparent',
  },
});
