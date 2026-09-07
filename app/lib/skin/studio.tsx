/**
 * STUDIO skin -- the quiet direction.
 *
 * Product-grade rather than terminal-grade. The identity (navy, green, the
 * ops-console density) stays; what changes is the trim that made the shipped
 * look read as a template:
 *
 *  * TYPE: the system face everywhere, monospace ONLY for numerals (via
 *    `numeric`). Titles are sentence case at 13/600 -- no letter-spacing, no
 *    small caps. One type scale: 30 metric / 16 body / 13 title / 12 caption.
 *  * SURFACE, NOT BORDER: cards are a lifted surface with a barely-there
 *    hairline; nothing glows. Light mode gets a real shadow instead.
 *  * ONE RADIUS SCALE: 16 card / 10 control / 999 pill.
 *  * SEMANTIC COLOUR IS SPENT WHERE IT CARRIES INFORMATION. The caller's
 *    tempColor/pctColor/batteryColor still drives the bar, the spark and a
 *    status dot -- but a HEALTHY reading is set in body ink, so amber and red
 *    are the only coloured numbers on the screen and they are impossible to
 *    miss. (Battery is inverted upstream; the skin never re-derives meaning.)
 *  * NO MOTION BUDGET SPENT ON AMBIENCE. No breath, no sweep, no entrance.
 *    Reduced-motion users get exactly what everyone else gets.
 */
import React from 'react';
import { Platform, Pressable, StyleSheet, Text, View, type TextStyle } from 'react-native';

import { numeric, useResolvedScheme, useTheme, useThemedStyles, type Palette } from '@/lib/theme';
import type { BarProps, CardProps, DotProps, MetricProps, SkinKit, SparkProps } from './kit';

/** The platform's system face. RN maps 'System' to the UI font on iOS; web gets a CSS stack. */
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

const RADIUS = { card: 16, control: 10, pill: 999 };

function Screen({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}

function Card({ title, tone = 'default', accentColor, onPress, selected, style, children }: CardProps) {
  const t = useTheme();
  const light = useResolvedScheme() === 'light';
  const styles = useThemedStyles(makeStyles);

  const toneColor =
    accentColor ??
    (tone === 'live' ? t.green : tone === 'alert' ? t.red : tone === 'down' ? t.red : selected ? t.accent : null);

  const frame = [
    styles.card,
    light ? styles.cardLight : styles.cardDark,
    toneColor != null && {
      borderColor: alpha(toneColor, light ? 0.45 : 0.4),
      backgroundColor: light ? alpha(toneColor, 0.06) : alpha(toneColor, 0.09),
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
  const semantic = color === t.green || color === t.amber || color === t.red;
  const alarming = color === t.amber || color === t.red;
  const [num, unit] = splitUnit(value);
  return (
    <View style={styles.metricRow}>
      <Text style={[styles.bigMetric, { color: alarming ? color : t.text }]} numberOfLines={1}>
        {num}
        {unit != null && <Text style={styles.metricUnit}>{unit}</Text>}
      </Text>
      {semantic && <View style={[styles.metricDot, { backgroundColor: color }]} />}
    </View>
  );
}

function Bar({ pct, color }: BarProps) {
  const styles = useThemedStyles(makeStyles);
  const p = clamp(pct, 0, 100);
  return (
    <View style={styles.barTrack}>
      <View style={[styles.barFill, { width: `${p}%`, backgroundColor: color }]} />
    </View>
  );
}

/** Same contract as components/Sparkline: null samples are gaps, nothing under two real samples. */
function Spark({ values, color, height = 24, min, max }: SparkProps) {
  const styles = useThemedStyles(makeStyles);
  const real = (values ?? []).filter((n): n is number => n != null);
  if (!values || real.length < 2) return null;
  const lo = min ?? Math.min(...real);
  const hi = max ?? Math.max(...real);
  const span = hi - lo;
  const last = values.length - 1;
  return (
    <View style={[styles.sparkRow, { height }]} pointerEvents="none">
      {values.map((v, i) => {
        if (v == null) return <View key={i} style={styles.sparkBar} />;
        const frac = span > 0 ? (v - lo) / span : 0.5;
        const h = Math.max(3, Math.round(height * (0.12 + 0.88 * clamp(frac, 0, 1))));
        return (
          <View
            key={i}
            style={[styles.sparkBar, { height: h, backgroundColor: color, opacity: i === last ? 1 : 0.35 }]}
          />
        );
      })}
    </View>
  );
}

function Dot({ color, size = 10, live = true }: DotProps) {
  const ring = size * 1.8;
  return (
    <View style={[dotStyles.wrap, { width: ring, height: ring }]} pointerEvents="none">
      <View
        style={{
          position: 'absolute',
          width: ring,
          height: ring,
          borderRadius: ring / 2,
          backgroundColor: alpha(color, live ? 0.22 : 0.1),
        }}
      />
      <View style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: color, opacity: live ? 1 : 0.6 }} />
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
      borderWidth: 1,
      padding: 16,
      marginBottom: 12,
    },
    cardDark: { backgroundColor: t.card, borderColor: alpha(t.text, 0.06) },
    cardLight: {
      backgroundColor: t.card,
      borderColor: t.cardBorder,
      boxShadow: `0 1px 2px ${alpha(t.text, 0.06)}`,
    },
    cardDown: { opacity: 0.7 },
    pressed: { opacity: 0.85 },
    cardTitle: {
      color: t.textDim,
      fontFamily: sans,
      fontSize: 13,
      fontWeight: '600',
      marginBottom: 10,
    },
    sectionTitle: {
      color: t.textDim,
      fontFamily: sans,
      fontSize: 13,
      fontWeight: '600',
      marginBottom: 8,
    },
    metricRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
    bigMetric: {
      fontSize: 30,
      fontWeight: '700',
      letterSpacing: -0.6,
      fontFamily: sans,
      fontVariant: ['tabular-nums'],
      lineHeight: 36,
    },
    metricUnit: { fontSize: 17, fontWeight: '600', color: t.textDim, letterSpacing: 0 },
    metricDot: { width: 8, height: 8, borderRadius: 4, marginTop: 2 },
    barTrack: { height: 6, borderRadius: 3, backgroundColor: alpha(t.text, 0.08), overflow: 'hidden' },
    barFill: { height: '100%', borderRadius: 3 },
    sparkRow: { flexDirection: 'row', alignItems: 'flex-end', gap: 2, marginTop: 10 },
    sparkBar: { flex: 1, borderRadius: 1.5, backgroundColor: 'transparent' },
  });

const text: NonNullable<SkinKit['text']> = {
  heading: { fontFamily: sans, fontSize: 26, fontWeight: '700', letterSpacing: -0.6 } as TextStyle,
  title: { fontFamily: sans, fontSize: 13, fontWeight: '600', letterSpacing: 0, textTransform: 'none' } as TextStyle,
  label: { fontFamily: sans, fontSize: 12, fontWeight: '500', letterSpacing: 0, textTransform: 'none' } as TextStyle,
  body: { fontFamily: sans, fontSize: 16, fontWeight: '600', letterSpacing: 0 } as TextStyle,
  muted: { fontFamily: sans, fontSize: 13, fontWeight: '400', letterSpacing: 0 } as TextStyle,
};

export { numeric as studioNumeric };

export const studioSkin: SkinKit = {
  label: 'Studio',
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
