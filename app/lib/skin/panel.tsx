/**
 * PANEL skin -- the machined-hardware faceplate direction.
 *
 * Braun / Teenage-Engineering: near-monochrome modules with a bevel and a hard
 * ledge, engraved recessed wells for the instruments, and silkscreen UPPERCASE
 * mono legends. The single signal colour is reserved for the CALLER's semantic
 * value -- the chrome itself never uses the accent. "As little design as
 * possible": completely still, no motion.
 *
 *  * TYPE: mono for every machine legend + readout, sans for the few human
 *    strings (track/game/peer names). Uppercase mono legends are the signature.
 *  * SURFACE: boxy (radius 6/4/4), raised modules (bevel + ledge) hosting
 *    recessed wells (inset groove) for the meter, spark and readout.
 *  * COLOUR: chrome is 100% monochrome; caller colour lands only in lit VU
 *    segments, the newest spark column, the readout bar, the dot core and a
 *    toned card's channel-stripe. Healthy = ink.
 *  * MOTION: none. `live`/`tone` drive static state (LED brightness, sunken).
 *
 * NOTE: elevation/recess use CSS `boxShadow` (incl. inset) -- rendered in the
 * web harness; native inset support is RN-version dependent and unverified on
 * device (degrades to a flat module, which is still legible).
 */
import React from 'react';
import { Platform, Pressable, StyleSheet, Text, View, type TextStyle } from 'react-native';

import { mono, useResolvedScheme, useTheme, useThemedStyles, type Palette } from '@/lib/theme';
import type { BarProps, CardProps, DotProps, MetricProps, SkinKit, SparkProps } from './kit';

export const sans = Platform.select({
  ios: 'System',
  android: 'sans-serif',
  default: 'system-ui, -apple-system, "SF Pro Text", "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
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

const RADIUS = { card: 6, control: 4, pill: 4 };
const SEGMENTS = 20;

function toneOf(t: Palette, tone: string, accentColor?: string, selected?: boolean): string | null {
  if (accentColor != null) return accentColor;
  if (tone === 'live') return t.green;
  if (tone === 'alert') return t.red;
  if (tone === 'down') return t.red;
  if (selected) return t.accent;
  return null;
}

function Screen({ children }: { children: React.ReactNode }) {
  const styles = useThemedStyles(makeStyles);
  return (
    <View style={styles.chassis}>
      <View style={styles.grille1} pointerEvents="none" />
      <View style={styles.grille2} pointerEvents="none" />
      {children}
    </View>
  );
}

function Card({ title, tone = 'default', accentColor, onPress, selected, style, children }: CardProps) {
  const t = useTheme();
  const light = useResolvedScheme() === 'light';
  const styles = useThemedStyles(makeStyles);
  const stripe = toneOf(t, tone, accentColor, selected);

  const frame = [
    styles.card,
    light ? styles.cardLight : styles.cardDark,
    stripe != null && { borderColor: alpha(stripe, 0.5) },
    tone === 'alert' && { backgroundColor: alpha(t.red, light ? 0.05 : 0.06) },
    selected && tone !== 'alert' && { backgroundColor: alpha(t.accent, 0.05) },
    tone === 'down' && (light ? styles.cardDownLight : styles.cardDownDark),
    style,
  ];
  const body = (
    <>
      {stripe != null && (
        <View style={[styles.stripe, { backgroundColor: tone === 'down' ? alpha(stripe, 0.7) : stripe }]} pointerEvents="none" />
      )}
      {title != null && <SectionTitle>{title}</SectionTitle>}
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
    <View style={styles.sectionRow}>
      <View style={styles.sectionTick} />
      <Text style={styles.sectionTitle}>{children}</Text>
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
  const semantic = color === t.green || color === t.amber || color === t.red;
  const alarming = color === t.amber || color === t.red;
  const [num, unit] = splitUnit(value);
  return (
    <View style={styles.window}>
      {semantic && <View style={[styles.windowBar, { backgroundColor: color }]} />}
      <Text style={[styles.bigMetric, { color: alarming ? color : t.text, marginLeft: semantic ? 8 : 0 }]} numberOfLines={1}>
        {num}
        {unit != null && <Text style={styles.metricUnit}>{unit != null ? ` ${unit}` : ''}</Text>}
      </Text>
    </View>
  );
}

function Bar({ pct, color }: BarProps) {
  const t = useTheme();
  const styles = useThemedStyles(makeStyles);
  const lit = clamp(Math.round((clamp(pct, 0, 100) / 100) * SEGMENTS), 0, SEGMENTS);
  return (
    <View style={styles.well}>
      {Array.from({ length: SEGMENTS }, (_, i) => (
        <View key={i} style={[styles.segment, { backgroundColor: i < lit ? color : alpha(t.text, 0.08) }]} />
      ))}
    </View>
  );
}

function Spark({ values, color, height = 24, min, max }: SparkProps) {
  const t = useTheme();
  const styles = useThemedStyles(makeStyles);
  const real = (values ?? []).filter((n): n is number => n != null);
  if (!values || real.length < 2) return null;
  const lo = min ?? Math.min(...real);
  const hi = max ?? Math.max(...real);
  const span = hi - lo;
  const last = values.length - 1;
  return (
    <View style={[styles.sparkWell, { height: height + 6 }]} pointerEvents="none">
      {values.map((v, i) => {
        if (v == null) return <View key={i} style={styles.sparkBar} />;
        const frac = span > 0 ? (v - lo) / span : 0.5;
        const h = Math.max(3, Math.round(height * (0.12 + 0.88 * clamp(frac, 0, 1))));
        return (
          <View key={i} style={[styles.sparkBar, { height: h, backgroundColor: i === last ? color : t.textFaint }]} />
        );
      })}
      <View style={styles.sparkFloor} />
    </View>
  );
}

function Dot({ color, size = 10, live = true }: DotProps) {
  const styles = useThemedStyles(makeStyles);
  const bezel = size + 6;
  return (
    <View style={[styles.dotBezel, { width: bezel, height: bezel, borderRadius: bezel / 2 }]} pointerEvents="none">
      <View style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: color, opacity: live ? 1 : 0.45 }} />
    </View>
  );
}

const makeStyles = (t: Palette) => {
  const light = false; // placeholder; real light handled by scheme-specific styles below
  void light;
  return StyleSheet.create({
    chassis: { flex: 1, backgroundColor: t.bg },
    grille1: { position: 'absolute', top: 2, left: 0, right: 0, height: StyleSheet.hairlineWidth, backgroundColor: alpha(t.text, 0.06) },
    grille2: { position: 'absolute', top: 5, left: 0, right: 0, height: StyleSheet.hairlineWidth, backgroundColor: alpha(t.text, 0.03) },
    card: {
      borderRadius: RADIUS.card,
      borderWidth: 1,
      padding: 14,
      marginBottom: 10,
      position: 'relative',
    },
    cardDark: {
      backgroundColor: t.card,
      borderColor: alpha(t.text, 0.1),
      boxShadow: `inset 0 1px 0 ${alpha(t.text, 0.05)}, 0 2px 0 ${alpha(t.bg, 0.8)}, 0 6px 14px ${alpha(t.bg, 0.55)}`,
    },
    cardLight: {
      backgroundColor: t.card,
      borderColor: t.cardBorder,
      boxShadow: `0 1px 0 ${alpha(t.text, 0.06)}, 0 4px 10px ${alpha(t.text, 0.07)}`,
    },
    cardDownDark: { opacity: 0.6, boxShadow: `inset 0 1px 3px ${alpha(t.bg, 0.7)}` },
    cardDownLight: { opacity: 0.6, boxShadow: `inset 0 1px 3px ${alpha(t.text, 0.08)}` },
    pressed: { opacity: 0.85, transform: [{ translateY: 1 }] },
    stripe: { position: 'absolute', left: 0, top: 6, bottom: 6, width: 3, borderRadius: 1 },
    sectionRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 8 },
    sectionTick: { width: 8, height: 2, backgroundColor: alpha(t.text, 0.35) },
    sectionTitle: {
      color: t.textFaint,
      fontFamily: mono,
      fontSize: 10,
      fontWeight: '700',
      letterSpacing: 1.8,
      textTransform: 'uppercase',
    },
    window: {
      alignSelf: 'flex-start',
      flexDirection: 'row',
      alignItems: 'center',
      backgroundColor: alpha(t.text, 0.03),
      borderRadius: RADIUS.control,
      paddingVertical: 4,
      paddingHorizontal: 8,
      boxShadow: `inset 0 1px 2px ${alpha(t.bg, 0.7)}, inset 0 0 0 1px ${alpha(t.bg, 0.4)}`,
    },
    windowBar: { position: 'absolute', left: 0, top: 0, bottom: 0, width: 3, borderTopLeftRadius: RADIUS.control, borderBottomLeftRadius: RADIUS.control },
    bigMetric: {
      fontSize: 26,
      fontWeight: '700',
      letterSpacing: 0.5,
      fontFamily: mono,
      fontVariant: ['tabular-nums'],
      lineHeight: 30,
    },
    metricUnit: { fontSize: 12, fontWeight: '600', color: t.textFaint, fontFamily: mono, textTransform: 'uppercase' },
    well: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 2,
      height: 10,
      borderRadius: RADIUS.control,
      backgroundColor: t.inset,
      padding: 2,
      marginTop: 6,
      boxShadow: `inset 0 1px 2px ${alpha(t.bg, 0.7)}, inset 0 0 0 1px ${alpha(t.bg, 0.4)}`,
    },
    segment: { flex: 1, borderRadius: 1, alignSelf: 'stretch' },
    sparkWell: {
      flexDirection: 'row',
      alignItems: 'flex-end',
      gap: 1,
      borderRadius: RADIUS.control,
      backgroundColor: t.inset,
      padding: 3,
      marginTop: 8,
      position: 'relative',
      boxShadow: `inset 0 1px 2px ${alpha(t.bg, 0.7)}, inset 0 0 0 1px ${alpha(t.bg, 0.4)}`,
    },
    sparkBar: { flex: 1, borderRadius: 1, backgroundColor: 'transparent' },
    sparkFloor: { position: 'absolute', left: 3, right: 3, bottom: 3, height: StyleSheet.hairlineWidth, backgroundColor: alpha(t.text, 0.12) },
    dotBezel: {
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: t.inset,
      borderWidth: 1,
      borderColor: alpha(t.text, 0.15),
      boxShadow: `inset 0 1px 1px ${alpha(t.bg, 0.6)}`,
    },
  });
};

const text: NonNullable<SkinKit['text']> = {
  heading: { fontFamily: mono, fontSize: 22, fontWeight: '700', letterSpacing: 1, textTransform: 'uppercase' } as TextStyle,
  title: { fontFamily: mono, fontSize: 10, fontWeight: '700', letterSpacing: 1.8, textTransform: 'uppercase' } as TextStyle,
  label: { fontFamily: mono, fontSize: 10, fontWeight: '600', letterSpacing: 1.5, textTransform: 'uppercase' } as TextStyle,
  body: { fontFamily: sans, fontSize: 15, fontWeight: '600', letterSpacing: 0.2 } as TextStyle,
  muted: { fontFamily: sans, fontSize: 12, fontWeight: '500', letterSpacing: 0.2 } as TextStyle,
};

export const panelSkin: SkinKit = {
  label: 'Panel',
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
