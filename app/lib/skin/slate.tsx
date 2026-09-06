/**
 * SLATE skin -- the "internal tool" direction.
 *
 * Linear / Vercel / Datadog restraint applied to the ops console. Structure is
 * carried by HAIRLINES and TYPE WEIGHT, never by chrome: cards are near-flat
 * inset panels separated by a whisper border plus the gap between them, and the
 * only strong mark is a 2px vertical accent RAIL down the left edge of a toned or
 * selected card. Numerals are the hero and they are MONOSPACE tabular (reads as
 * instrumentation, the cleanest break from studio's sans metrics). One
 * embellishment: a tiny data-derived TREND CHIP at the end of the sparkline.
 *
 *  * TYPE: sans for text, mono for every numeral (via `numeric`). Signature is
 *    11px UPPERCASE micro-caps at +0.6 tracking for titles.
 *  * SURFACE: flat hairline panel, denser than studio (radius 10, pad 14). Tone
 *    is a 2px left rail + a whisper tint, never a full coloured border.
 *  * COLOUR: healthy metric in ink, only amber/red numerals coloured (studio's
 *    rule). The rail, the bar and the spark are the only other colour.
 *  * MOTION: none. Confidence from precision, not movement.
 */
import React from 'react';
import { Platform, Pressable, StyleSheet, Text, View, type TextStyle } from 'react-native';

import { mono, numeric, useResolvedScheme, useTheme, useThemedStyles, type Palette } from '@/lib/theme';
import type { BarProps, CardProps, DotProps, MetricProps, SkinKit, SparkProps } from './kit';

export const sans = Platform.select({
  ios: 'System',
  android: 'sans-serif',
  default: 'system-ui, -apple-system, "SF Pro Text", "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
});

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

/** Re-alpha a #rrggbb palette colour (the only shape the palettes use). */
function alpha(hex: string, a: number): string {
  const h = hex.replace('#', '');
  if (h.length !== 6) return hex;
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${clamp(a, 0, 1)})`;
}

const RADIUS = { card: 10, control: 8, pill: 999 };

function toneOf(t: Palette, tone: string, accentColor?: string, selected?: boolean): string | null {
  if (accentColor != null) return accentColor;
  if (tone === 'live') return t.green;
  if (tone === 'alert') return t.red;
  if (tone === 'down') return t.redDeep;
  if (selected) return t.accent;
  return null;
}

function Screen({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}

function Card({ title, tone = 'default', accentColor, onPress, selected, style, children }: CardProps) {
  const t = useTheme();
  const light = useResolvedScheme() === 'light';
  const styles = useThemedStyles(makeStyles);
  const rail = toneOf(t, tone, accentColor, selected);

  const frame = [
    styles.card,
    light ? styles.cardLight : styles.cardDark,
    rail != null && {
      borderLeftWidth: 2,
      borderLeftColor: rail,
      backgroundColor: alpha(rail, light ? 0.05 : 0.05),
    },
    tone === 'down' && styles.cardDown,
    style,
  ];
  const body = (
    <>
      {title != null && <Text style={styles.cardTitle}>{title}</Text>}
      {children}
    </>
  );
  if (onPress == null) return <View style={frame}>{body}</View>;
  return (
    <Pressable onPress={onPress} style={({ pressed }) => [...frame, pressed && styles.pressed]}>
      {body}
    </Pressable>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  const styles = useThemedStyles(makeStyles);
  return <Text style={styles.sectionTitle}>{children}</Text>;
}

/** "50.0°C" -> ["50.0", "°C"]; anything that is not number+short unit stays whole. */
function splitUnit(value: string): [string, string | null] {
  const m = /^([-\d.,]+)\s?(°C|°F|%|W|GB|MB|ms|fps)$/.exec(value);
  return m ? [m[1], m[2]] : [value, null];
}

function BigMetric({ value, color }: MetricProps) {
  const t = useTheme();
  const styles = useThemedStyles(makeStyles);
  const alarming = color === t.amber || color === t.red;
  const [num, unit] = splitUnit(value);
  return (
    <Text style={[styles.bigMetric, { color: alarming ? color : t.text }]} numberOfLines={1}>
      {num}
      {unit != null && <Text style={styles.metricUnit}>{unit}</Text>}
    </Text>
  );
}

function Bar({ pct, color }: BarProps) {
  const styles = useThemedStyles(makeStyles);
  const p = clamp(pct, 0, 100);
  return (
    <View style={styles.barTrack}>
      {[25, 50, 75].map((x) => (
        <View key={x} style={[styles.barTick, { left: `${x}%` }]} pointerEvents="none" />
      ))}
      <View style={[styles.barFill, { width: `${p}%`, backgroundColor: color }]} />
    </View>
  );
}

/** Same contract as components/Sparkline: null samples are gaps, nothing under two real samples. */
function Spark({ values, color, height = 20, min, max }: SparkProps) {
  const light = useResolvedScheme() === 'light';
  const styles = useThemedStyles(makeStyles);
  const real = (values ?? []).filter((n): n is number => n != null);
  if (!values || real.length < 2) return null;
  const lo = min ?? Math.min(...real);
  const hi = max ?? Math.max(...real);
  const span = hi - lo;
  const last = values.length - 1;

  // Trend from data: first vs last real sample, with a deadband so noise reads flat.
  const first = real[0];
  const latest = real[real.length - 1];
  const delta = span > 0 ? (latest - first) / span : 0;
  const glyph = delta > 0.08 ? '▲' : delta < -0.08 ? '▼' : '→';

  return (
    <View style={styles.sparkWrap} pointerEvents="none">
      <View style={[styles.sparkRow, { height }]}>
        {values.map((v, i) => {
          if (v == null) return <View key={i} style={styles.sparkBar} />;
          const frac = span > 0 ? (v - lo) / span : 0.5;
          const h = Math.max(2, Math.round(height * (0.15 + 0.85 * clamp(frac, 0, 1))));
          return (
            <View
              key={i}
              style={[styles.sparkBar, { height: h, backgroundColor: color, opacity: i === last ? 1 : light ? 0.38 : 0.32 }]}
            />
          );
        })}
      </View>
      <View style={[styles.chip, { backgroundColor: alpha(color, 0.14) }]}>
        <Text style={[styles.chipGlyph, { color }]}>{glyph}</Text>
      </View>
    </View>
  );
}

function Dot({ color, size = 8, live = true }: DotProps) {
  const light = useResolvedScheme() === 'light';
  const ring = size * 1.7;
  return (
    <View style={[dotStyles.wrap, { width: ring, height: ring }]} pointerEvents="none">
      <View
        style={{
          position: 'absolute',
          width: ring,
          height: ring,
          borderRadius: ring / 2,
          borderWidth: 1,
          borderColor: alpha(color, live ? (light ? 0.4 : 0.35) : light ? 0.55 : 0.5),
        }}
      />
      {live && <View style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: color }} />}
    </View>
  );
}

const dotStyles = StyleSheet.create({
  wrap: { alignItems: 'center', justifyContent: 'center' },
});

const makeStyles = (t: Palette) =>
  StyleSheet.create({
    card: {
      borderRadius: RADIUS.card,
      borderWidth: StyleSheet.hairlineWidth,
      padding: 14,
      marginBottom: 8,
    },
    cardDark: { backgroundColor: t.card, borderColor: alpha(t.text, 0.12) },
    cardLight: {
      backgroundColor: t.card,
      borderColor: t.cardBorder,
      boxShadow: `0 1px 2px ${alpha(t.text, 0.05)}`,
    },
    cardDown: { opacity: 0.6 },
    pressed: { opacity: 0.7 },
    cardTitle: {
      color: t.textDim,
      fontFamily: sans,
      fontSize: 11,
      fontWeight: '600',
      letterSpacing: 0.6,
      textTransform: 'uppercase',
      marginBottom: 10,
    },
    sectionTitle: {
      color: t.textDim,
      fontFamily: sans,
      fontSize: 11,
      fontWeight: '600',
      letterSpacing: 0.6,
      textTransform: 'uppercase',
      marginBottom: 8,
    },
    bigMetric: {
      fontSize: 27,
      fontWeight: '600',
      letterSpacing: -0.5,
      fontFamily: mono,
      fontVariant: ['tabular-nums'],
      lineHeight: 32,
    },
    metricUnit: { fontSize: 14, fontWeight: '600', color: t.textDim, ...numeric },
    barTrack: {
      height: 5,
      borderRadius: 2.5,
      backgroundColor: t.inset,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: alpha(t.text, 0.08),
      overflow: 'hidden',
      marginTop: 6,
      justifyContent: 'center',
    },
    barTick: { position: 'absolute', top: 0, bottom: 0, width: StyleSheet.hairlineWidth, backgroundColor: alpha(t.text, 0.1) },
    barFill: { position: 'absolute', left: 0, top: 0, bottom: 0, borderRadius: 2.5 },
    sparkWrap: { flexDirection: 'row', alignItems: 'flex-end', gap: 6, marginTop: 10 },
    sparkRow: { flex: 1, flexDirection: 'row', alignItems: 'flex-end', gap: 1 },
    sparkBar: { flex: 1, borderRadius: 1, backgroundColor: 'transparent' },
    chip: { borderRadius: 999, paddingHorizontal: 5, paddingVertical: 2, alignSelf: 'flex-end' },
    chipGlyph: { fontSize: 10, fontWeight: '700', fontFamily: sans },
  });

const text: NonNullable<SkinKit['text']> = {
  heading: { fontFamily: sans, fontSize: 22, fontWeight: '700', letterSpacing: -0.4 } as TextStyle,
  title: { fontFamily: sans, fontSize: 11, fontWeight: '600', letterSpacing: 0.6, textTransform: 'uppercase' } as TextStyle,
  label: { fontFamily: sans, fontSize: 12, fontWeight: '500', letterSpacing: 0.2, textTransform: 'none' } as TextStyle,
  body: { fontFamily: sans, fontSize: 15, fontWeight: '600', letterSpacing: -0.1 } as TextStyle,
  muted: { fontFamily: sans, fontSize: 13, fontWeight: '400', letterSpacing: 0 } as TextStyle,
};

export const slateSkin: SkinKit = {
  label: 'Slate',
  Screen,
  Card,
  SectionTitle,
  BigMetric,
  Bar,
  Spark,
  Dot,
  text,
  radius: RADIUS,
  quiet: true,
};
