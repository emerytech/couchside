/**
 * RESERVE skin -- "the premium doorway", promoted from the app/reserve.tsx
 * prototype ("What to play next") into a whole-app visual direction.
 *
 * The feel is OPEN and FLUID rather than dense/terminal: generous radii and
 * padding, a single soft ambient green wash breathing behind the dashboard,
 * mono uppercase eyebrows over large bold sans titles, and cards that read as
 * lifted premium surfaces (soft shadow + hairline) rather than outlined panels.
 *
 * WHAT IT KEEPS FROM THE SEAM CONTRACT (kit.ts):
 *  * SEMANTIC COLOUR IS THE CALLER'S. BigMetric/Bar/Spark/Dot are handed an
 *    already-resolved tempColor/pctColor/batteryColor (battery is inverted
 *    upstream). This skin only DECORATES with it -- a glow, a tint, a dot -- and
 *    never substitutes green/amber/red for its own accent. A HEALTHY metric is
 *    drawn in ink so amber and red are the only coloured numbers and cannot be
 *    missed (same discipline as studio).
 *  * MOTION IS ONE SHARED CLOCK, reduced-motion-hard-stopped. Only two things
 *    move: the ambient wash and a live status Dot's halo, both off the single
 *    breath value published by `Screen` (motion.ts rules). No per-card timers,
 *    no per-frame JS, no setInterval.
 *
 * Static bloom is the one `boxShadow` string RN 0.86 gives us; the breathing
 * wash is an absolutely-positioned Animated.View whose opacity is driven by the
 * shared breath in a worklet.
 */
import React, { useContext } from 'react';
import { Platform, Pressable, StyleSheet, Text, View, type TextStyle } from 'react-native';
import Animated, { useAnimatedStyle, useSharedValue, type SharedValue } from 'react-native-reanimated';

import { mono, numeric, useResolvedScheme, useTheme, useThemedStyles, type Palette } from '@/lib/theme';
import { useVitals } from './kit';
import type { BarProps, CardProps, DotProps, MetricProps, SkinKit, SparkProps } from './kit';
import { BREATH_REST, breathPeriod, useBreath } from './motion';

/** The platform's system face (matches studio). RN maps 'System' to the UI font on iOS. */
export const sans = Platform.select({
  ios: 'System',
  android: 'sans-serif',
  default: 'system-ui, -apple-system, "SF Pro Text", "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
});

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

/** Re-alpha a #rrggbb (or #rgb / rgb()/rgba()) palette colour; anything else passes through. */
function rgba(color: string, a: number): string {
  const al = Math.round(clamp(a, 0, 1) * 1000) / 1000;
  const c = color.trim();
  if (c.startsWith('#')) {
    let h = c.slice(1);
    if (h.length === 3 || h.length === 4) h = h.split('').map((ch) => ch + ch).join('');
    if (h.length === 6 || h.length === 8) {
      const r = parseInt(h.slice(0, 2), 16);
      const g = parseInt(h.slice(2, 4), 16);
      const b = parseInt(h.slice(4, 6), 16);
      if (!Number.isNaN(r) && !Number.isNaN(g) && !Number.isNaN(b)) return `rgba(${r}, ${g}, ${b}, ${al})`;
    }
    return c;
  }
  const m = /^rgba?\(([^)]*)\)$/i.exec(c);
  if (m) {
    const parts = (m[1] ?? '').split(',').map((s) => s.trim());
    if (parts.length >= 3) return `rgba(${parts[0]}, ${parts[1]}, ${parts[2]}, ${al})`;
  }
  return c;
}

const RADIUS = { card: 22, control: 14, pill: 999 };

// ---------------------------------------------------------------------------
// The one shared breath clock (published by Screen, read by the wash + Dot)
// ---------------------------------------------------------------------------

const BreathCtx = React.createContext<SharedValue<number> | null>(null);

/** The screen breath, or a private resting value for anything rendered outside a
 *  Screen (Fleet tiles, the Console header). The fallback is created
 *  unconditionally so hooks stay stable, but is never animated. */
function useBreathValue(): SharedValue<number> {
  const ctx = useContext(BreathCtx);
  const fallback = useSharedValue(BREATH_REST);
  return ctx ?? fallback;
}

// ---------------------------------------------------------------------------
// Screen: the ambient wash
// ---------------------------------------------------------------------------

function Screen({ children }: { children: React.ReactNode }) {
  const t = useTheme();
  const light = useResolvedScheme() === 'light';
  const { v, alive } = useVitals();
  // Rate rises gently with exertion; a box that is not answering does not breathe.
  const breath = useBreath(breathPeriod(v), alive);

  const washStyle = useAnimatedStyle(() => {
    // A slow swell between two low alphas -- ambience, never movement you track.
    const base = light ? 0.05 : 0.09;
    return { opacity: base + (light ? 0.02 : 0.05) * breath.value };
  });

  return (
    <BreathCtx.Provider value={breath}>
      <View style={styles.screen}>
        <Animated.View
          pointerEvents="none"
          style={[styles.wash, { backgroundColor: t.green }, washStyle]}
        />
        {children}
      </View>
    </BreathCtx.Provider>
  );
}

// ---------------------------------------------------------------------------
// Card: a lifted premium surface
// ---------------------------------------------------------------------------

function Card({ title, tone = 'default', accentColor, onPress, selected, style, children }: CardProps) {
  const t = useTheme();
  const light = useResolvedScheme() === 'light';
  const styles = useThemedStyles(makeStyles);

  const toneColor =
    accentColor ??
    (tone === 'live'
      ? t.green
      : tone === 'alert'
        ? t.red
        : tone === 'down'
          ? t.red
          : selected
            ? t.accent
            : null);

  const frame = [
    styles.card,
    light ? styles.cardLight : styles.cardDark,
    toneColor != null && {
      borderColor: rgba(toneColor, light ? 0.4 : 0.42),
      backgroundColor: light ? rgba(toneColor, 0.05) : rgba(toneColor, 0.08),
      // A soft coloured bloom for a card that means something (a live stream, an alert).
      boxShadow: `0 10px 30px ${rgba(toneColor, light ? 0.12 : 0.16)}`,
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

/** "50.0°C" -> ["50.0", "°C"]; anything not number+short-unit stays whole. */
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
      <Text
        style={[
          styles.bigMetric,
          { color: alarming ? color : t.text },
          alarming && { textShadowColor: rgba(color, 0.45), textShadowRadius: 16, textShadowOffset: { width: 0, height: 0 } },
        ]}
        numberOfLines={1}>
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
      <View
        style={[styles.barFill, { width: `${p}%`, backgroundColor: color, boxShadow: `0 0 12px ${rgba(color, 0.5)}` }]}
      />
    </View>
  );
}

/** Same contract as components/Sparkline: null samples are gaps; nothing under two real samples. */
function Spark({ values, color, height = 26, min, max }: SparkProps) {
  const styles = useThemedStyles(makeStyles);
  const real = (values ?? []).filter((n): n is number => n != null);
  if (!values || real.length < 2) return null;
  const lo = min ?? Math.min(...real);
  const hi = max ?? Math.max(...real);
  const span = hi - lo;
  const last = values.length - 1;
  return (
    <View style={[styles.sparkRow, { height }]} pointerEvents="none">
      {values.map((val, i) => {
        if (val == null) return <View key={i} style={styles.sparkBar} />;
        const frac = span > 0 ? (val - lo) / span : 0.5;
        const h = Math.max(3, Math.round(height * (0.14 + 0.86 * clamp(frac, 0, 1))));
        return (
          <View
            key={i}
            style={[styles.sparkBar, { height: h, backgroundColor: color, opacity: i === last ? 1 : 0.3 }]}
          />
        );
      })}
    </View>
  );
}

function Dot({ color, size = 10, live = true }: DotProps) {
  const breath = useBreathValue();
  const ring = size * 2;
  const haloStyle = useAnimatedStyle(() => ({
    // A live dot's halo swells softly; a dead one sits still and dim.
    opacity: live ? 0.18 + 0.22 * breath.value : 0.1,
    transform: [{ scale: live ? 0.9 + 0.2 * breath.value : 0.9 }],
  }));
  return (
    <View style={[dotStyles.wrap, { width: ring, height: ring }]} pointerEvents="none">
      <Animated.View
        style={[
          { position: 'absolute', width: ring, height: ring, borderRadius: ring / 2, backgroundColor: color },
          haloStyle,
        ]}
      />
      <View
        style={{
          width: size,
          height: size,
          borderRadius: size / 2,
          backgroundColor: color,
          opacity: live ? 1 : 0.55,
          boxShadow: live ? `0 0 8px ${rgba(color, 0.7)}` : undefined,
        }}
      />
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
      padding: 18,
      marginBottom: 14,
    },
    cardDark: {
      backgroundColor: t.card,
      borderColor: rgba(t.text, 0.07),
      boxShadow: `0 12px 30px ${rgba('#000000', 0.35)}`,
    },
    cardLight: {
      backgroundColor: t.card,
      borderColor: t.cardBorder,
      boxShadow: `0 8px 24px ${rgba(t.text, 0.08)}`,
    },
    cardDown: { opacity: 0.68 },
    pressed: { opacity: 0.9, transform: [{ scale: 0.995 }] },
    cardTitle: {
      color: t.textFaint,
      fontFamily: mono,
      fontSize: 11,
      fontWeight: '700',
      letterSpacing: 2,
      textTransform: 'uppercase',
      marginBottom: 12,
    },
    sectionTitle: {
      color: t.textFaint,
      fontFamily: mono,
      fontSize: 11,
      fontWeight: '700',
      letterSpacing: 2,
      textTransform: 'uppercase',
      marginBottom: 10,
    },
    metricRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
    bigMetric: {
      fontSize: 34,
      fontWeight: '800',
      letterSpacing: -0.8,
      fontFamily: sans,
      fontVariant: ['tabular-nums'],
      lineHeight: 40,
    },
    metricUnit: { fontSize: 18, fontWeight: '700', color: t.textDim, letterSpacing: 0 },
    metricDot: { width: 8, height: 8, borderRadius: 4, marginTop: 4 },
    barTrack: { height: 8, borderRadius: 4, backgroundColor: rgba(t.text, 0.09), overflow: 'hidden' },
    barFill: { height: '100%', borderRadius: 4 },
    sparkRow: { flexDirection: 'row', alignItems: 'flex-end', gap: 2, marginTop: 12 },
    sparkBar: { flex: 1, borderRadius: 2, backgroundColor: 'transparent' },
  });

const styles = StyleSheet.create({
  screen: { position: 'relative' },
  wash: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    height: 360,
    borderBottomLeftRadius: 220,
    borderBottomRightRadius: 220,
  },
});

const text: NonNullable<SkinKit['text']> = {
  heading: { fontFamily: sans, fontSize: 30, fontWeight: '800', letterSpacing: -0.5 } as TextStyle,
  title: { fontFamily: mono, fontSize: 11, fontWeight: '700', letterSpacing: 2, textTransform: 'uppercase' } as TextStyle,
  label: { fontFamily: mono, fontSize: 10.5, fontWeight: '600', letterSpacing: 1.4, textTransform: 'uppercase' } as TextStyle,
  body: { fontFamily: sans, fontSize: 17, fontWeight: '700', letterSpacing: -0.2 } as TextStyle,
  muted: { fontFamily: sans, fontSize: 13, fontWeight: '400', letterSpacing: 0 } as TextStyle,
};

export { numeric as reserveNumeric };

export const reserveSkin: SkinKit = {
  label: 'Reserve',
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
