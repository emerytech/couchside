/**
 * PAPER skin -- the editorial / light-first direction.
 *
 * A printed spec-sheet rendered as an app: a serif display heading, small-caps
 * * sans labels, ink metrics, fine
 * rules and generous whitespace instead of chrome. The one skin designed
 * LIGHT-first -- there is no glow anywhere, so nothing can go muddy on white;
 * dark mode re-derives the same vocabulary as light hairlines on navy.
 *
 *  * TYPE: serif for headlines + body headlines (track/game names), sans for all
 *    chrome and data. Metric stays sans+tabular so live figures never bounce.
 *  * SURFACE: flat, rule-not-lift. Hairline-bordered card, 8px corners, no
 *    shadow. Semantic emphasis is a 3px left EDGE-RULE, not a fill.
 *  * COLOUR: two places only -- an alarming metric, and the semantic left edge-rule.
 *    Healthy readings are ink (studio's rule).
 *  * MOTION: none. Print does not flicker.
 */
import React from 'react';
import { Platform, Pressable, StyleSheet, Text, View, type TextStyle } from 'react-native';

import { useResolvedScheme, useTheme, useThemedStyles, type Palette } from '@/lib/theme';
import type { BarProps, CardProps, DotProps, MetricProps, SkinKit, SparkProps } from './kit';

export const sans = Platform.select({
  ios: 'System',
  android: 'sans-serif',
  default: 'system-ui, -apple-system, "SF Pro Text", "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
});
/** Serif for headlines only -- spent where text never has to column-align. */
export const serif = Platform.select({
  ios: 'Georgia',
  android: 'serif',
  default: 'Georgia, "Iowan Old Style", "Times New Roman", serif',
});

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

function alpha(hex: string, a: number): string {
  const h = hex.replace('#', '');
  if (h.length !== 6) return hex;
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${clamp(a, 0, 1)})`;
}

const RADIUS = { card: 8, control: 6, pill: 999 };

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
  const edge = toneOf(t, tone, accentColor, selected);

  const frame = [
    styles.card,
    light ? styles.cardLight : styles.cardDark,
    tone === 'alert' && { backgroundColor: alpha(t.red, light ? 0.05 : 0.08), borderColor: alpha(t.red, 0.3) },
    selected && tone !== 'alert' && { borderColor: alpha(t.accent, light ? 0.4 : 0.35) },
    tone === 'down' && styles.cardDown,
    style,
  ];
  const body = (
    <>
      {edge != null && <View style={[styles.edge, { backgroundColor: edge }]} pointerEvents="none" />}
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
  return (
    <View style={styles.sectionWrap}>
      <Text style={styles.sectionTitle}>{children}</Text>
      <View style={styles.sectionRule} />
    </View>
  );
}

function splitUnit(value: string): [string, string | null] {
  const m = /^([-\d.,]+)\s?(°C|°F|%|W|GB|MB|ms|fps)$/.exec(value);
  return m ? [m[1], m[2]] : [value, null];
}

function BigMetric({ value, color }: MetricProps) {
  const t = useTheme();
  const styles = useThemedStyles(makeStyles);
  const alarming = color === t.amber || color === t.red;
  const [num, unit] = splitUnit(value);
  // No decoration line above the number: the section title already carries an
  // editorial hairline rule, so a second short tick here just read as a stray
  // line. Paper's metric is the ink numeral itself — an alarming value colours it.
  return (
    <View style={styles.metricWrap}>
      <Text style={[styles.bigMetric, { color: alarming ? color : t.text }]} numberOfLines={1}>
        {num}
        {unit != null && <Text style={styles.metricUnit}>{unit}</Text>}
      </Text>
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
        const h = Math.max(2, Math.round(height * (0.12 + 0.88 * clamp(frac, 0, 1))));
        return (
          <View
            key={i}
            style={[styles.sparkBar, { height: h, backgroundColor: i === last ? color : alpha(color, 0.28) }]}
          />
        );
      })}
      <View style={styles.sparkBaseline} />
    </View>
  );
}

function Dot({ color, size = 10, live = true }: DotProps) {
  const ring = size * 1.7;
  return (
    <View style={[dotStyles.wrap, { width: ring, height: ring }]} pointerEvents="none">
      <View
        style={{
          position: 'absolute',
          width: ring,
          height: ring,
          borderRadius: ring / 2,
          borderWidth: StyleSheet.hairlineWidth,
          borderColor: alpha(color, live ? 0.5 : 0.25),
        }}
      />
      <View style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: live ? color : alpha(color, 0.5) }} />
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
      padding: 18,
      marginBottom: 14,
      position: 'relative',
    },
    cardDark: { backgroundColor: t.card, borderColor: alpha(t.text, 0.09) },
    cardLight: { backgroundColor: t.card, borderColor: alpha(t.text, 0.12) },
    cardDown: { opacity: 0.65 },
    pressed: { opacity: 0.85 },
    edge: { position: 'absolute', left: 0, top: 0, bottom: 0, width: 3, borderTopLeftRadius: RADIUS.card, borderBottomLeftRadius: RADIUS.card },
    cardTitle: {
      color: t.textDim,
      fontFamily: sans,
      fontSize: 11,
      fontWeight: '600',
      letterSpacing: 1.3,
      textTransform: 'uppercase',
      marginBottom: 12,
    },
    sectionWrap: { marginBottom: 8 },
    sectionTitle: {
      color: t.textDim,
      fontFamily: sans,
      fontSize: 11,
      fontWeight: '600',
      letterSpacing: 1.3,
      textTransform: 'uppercase',
    },
    sectionRule: { marginTop: 6, height: StyleSheet.hairlineWidth, backgroundColor: alpha(t.text, 0.14) },
    metricWrap: { alignSelf: 'flex-start' },
    bigMetric: {
      fontSize: 34,
      fontWeight: '800',
      letterSpacing: -1,
      fontFamily: sans,
      fontVariant: ['tabular-nums'],
      lineHeight: 40,
    },
    metricUnit: { fontSize: 18, fontWeight: '600', color: t.textDim, fontFamily: sans },
    barTrack: { height: 6, borderRadius: 1, backgroundColor: alpha(t.text, 0.08), overflow: 'hidden', marginTop: 10 },
    barFill: { height: '100%', borderRadius: 1 },
    sparkRow: { flexDirection: 'row', alignItems: 'flex-end', gap: 2, marginTop: 10, position: 'relative' },
    sparkBar: { flex: 1, borderRadius: 0.5, backgroundColor: 'transparent' },
    sparkBaseline: { position: 'absolute', left: 0, right: 0, bottom: 0, height: StyleSheet.hairlineWidth, backgroundColor: alpha(t.text, 0.15) },
  });

const text: NonNullable<SkinKit['text']> = {
  heading: { fontFamily: serif, fontSize: 27, fontWeight: '700', letterSpacing: -0.5 } as TextStyle,
  title: { fontFamily: sans, fontSize: 11, fontWeight: '600', letterSpacing: 1.3, textTransform: 'uppercase' } as TextStyle,
  label: { fontFamily: sans, fontSize: 11, fontWeight: '600', letterSpacing: 0.8, textTransform: 'uppercase' } as TextStyle,
  body: { fontFamily: serif, fontSize: 17, fontWeight: '600', letterSpacing: -0.1 } as TextStyle,
  muted: { fontFamily: sans, fontSize: 13, fontWeight: '400', letterSpacing: 0 } as TextStyle,
};

export const paperSkin: SkinKit = {
  label: 'Paper',
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
