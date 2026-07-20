/**
 * REACTOR skin -- "neon core". The loud direction.
 *
 * The premise: the box is a reactor and its glow tells you how hard it is
 * working. Light and heat carry the whole design, so every element that has
 * been handed a semantic colour wears a halo in THAT colour whose intensity
 * scales with how bad the reading is. Cool green barely smoulders; red blooms.
 *
 * HOW THE LIGHT IS BUILT (there is no gradient/blur/SVG dependency here):
 *  * Static bloom is the `boxShadow` string style (RN 0.86). It cannot be
 *    animated -- it is a string -- so anything that must breathe is a second,
 *    absolutely-positioned sibling View sitting BEHIND the element, carrying the
 *    glow colour at low alpha, whose opacity/scale is driven by
 *    `useAnimatedStyle` off the shared breath value. All the maths happens in
 *    the worklet; nothing is recomputed in JS per frame.
 *  * "Gradient" edges are faked: three hairline Views stacked down the card's
 *    top edge at decreasing alpha, which reads as a top-lit bevel.
 *
 * LIGHT MODE IS NOT DARK MODE WITH A DIFFERENT BACKGROUND. A halo on #f6f8fc is
 * invisible at low alpha and muddy at high alpha, and the chromatic-bleed ghost
 * on the big metric reads as a rendering bug on white. So the whole "glow"
 * vocabulary is re-expressed in light mode as saturation, border weight and a
 * tinted backing -- see `light` branches throughout. Every colour is derived
 * from the palette via `rgba()`; there is not one neon hex in this file.
 *
 * SEMANTIC COLOUR IS THE CALLER'S. tempColor/pctColor/batteryColor arrive
 * pre-resolved (battery is inverted -- low is bad). The glow takes its hue from
 * whatever was passed and never substitutes the accent for a semantic red.
 * `severityOf` reads that colour back against the palette purely to decide how
 * ANGRY the light should be, never to change what colour it is.
 *
 * MOTION BUDGET: this runs on a phone while the box streams a game. One breath
 * clock for the whole screen (created in `Screen`, shared by context), one hum
 * layer, and per-element animations that are pure UI-thread `useAnimatedStyle`.
 * No setInterval, no per-frame JS, no unbounded View counts.
 */
import React, { useContext, useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import Animated, {
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withRepeat,
  withTiming,
  type SharedValue,
} from 'react-native-reanimated';

import {
  mono,
  numeric,
  useResolvedScheme,
  useTheme,
  useThemedStyles,
  type Palette,
} from '@/lib/theme';
import { useVitals } from './kit';
import type { BarProps, CardProps, DotProps, MetricProps, SkinKit, SparkProps } from './kit';
import { BREATH_REST, breathPeriod, useBreath, useReducedMotion } from './motion';

// ---------------------------------------------------------------------------
// Colour helpers -- everything neon in here is derived from the live palette
// ---------------------------------------------------------------------------

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

/**
 * Re-alpha an already-resolved palette colour. Accepts #rgb/#rgba/#rrggbb/
 * #rrggbbaa and rgb()/rgba(); anything else is passed through untouched so a
 * caller handing us something exotic degrades to "no transparency" rather than
 * to an invalid style.
 */
function rgba(color: string, alpha: number): string {
  const a = Math.round(clamp(alpha, 0, 1) * 1000) / 1000;
  const c = color.trim();

  if (c.startsWith('#')) {
    let h = c.slice(1);
    if (h.length === 3 || h.length === 4) {
      h = h
        .split('')
        .map((ch) => ch + ch)
        .join('');
    }
    if (h.length === 6 || h.length === 8) {
      const r = parseInt(h.slice(0, 2), 16);
      const g = parseInt(h.slice(2, 4), 16);
      const b = parseInt(h.slice(4, 6), 16);
      if (!Number.isNaN(r) && !Number.isNaN(g) && !Number.isNaN(b)) {
        return `rgba(${r}, ${g}, ${b}, ${a})`;
      }
    }
    return c;
  }

  const m = /^rgba?\(([^)]*)\)$/i.exec(c);
  if (m) {
    const parts = (m[1] ?? '').split(',').map((s) => s.trim());
    if (parts.length >= 3) return `rgba(${parts[0]}, ${parts[1]}, ${parts[2]}, ${a})`;
  }
  return c;
}

/**
 * How angry the light should be, 0..1, read back off the resolved semantic
 * colour. This deliberately does NOT change the hue -- it only decides how much
 * light comes out of it, so a red stays red and simply burns brighter.
 */
function severityOf(color: string, t: Palette): number {
  const c = color.toLowerCase();
  if (c === t.red.toLowerCase()) return 1;
  if (c === t.redDeep.toLowerCase()) return 0.85;
  if (c === t.amber.toLowerCase()) return 0.6;
  if (c === t.green.toLowerCase()) return 0.3;
  if (c === t.accent.toLowerCase() || c === t.blue.toLowerCase()) return 0.35;
  if (c === t.slate.toLowerCase()) return 0.12;
  if (c === t.textFaint.toLowerCase() || c === t.textDim.toLowerCase()) return 0.1;
  if (c === t.cardBorder.toLowerCase()) return 0.08;
  return 0.4; // unknown but presumably meaningful: mid heat
}

/** A static bloom, as the one string style RN gives us. */
function bloom(color: string, radius: number, alpha: number): string {
  return `0 0 ${Math.round(radius)}px ${rgba(color, alpha)}`;
}

// ---------------------------------------------------------------------------
// The shared breath clock
// ---------------------------------------------------------------------------

/**
 * ONE clock per screen. `Screen` creates it from the machine's vitality and
 * publishes it here; every card, bar and dot reads the same shared value, so N
 * cards never mean N timers.
 */
const BreathCtx = React.createContext<SharedValue<number> | null>(null);

/**
 * The screen's breath, or a private resting value when a component is rendered
 * outside a `Screen` (the Fleet tiles and the Console header are composed
 * independently, and a card must never crash for want of a provider). The
 * fallback shared value is always created -- hooks stay unconditional -- but it
 * is never animated, so it costs nothing.
 */
function useBreathValue(): SharedValue<number> {
  const ctx = useContext(BreathCtx);
  const fallback = useSharedValue(BREATH_REST);
  return ctx ?? fallback;
}

// ---------------------------------------------------------------------------
// Screen: the reactor hum
// ---------------------------------------------------------------------------

/** Period of the background sheen. Slow enough to read as ambience, not motion. */
const HUM_MS = 14000;

function Screen({ children }: { children: React.ReactNode }) {
  const t = useTheme();
  const light = useResolvedScheme() === 'light';
  const reduced = useReducedMotion();
  const { v, alive } = useVitals();

  // The one breath clock. Rate rises with exertion; a box that is not answering
  // does not breathe at all.
  const breath = useBreath(breathPeriod(v), alive);

  const [size, setSize] = useState({ w: 0, h: 0 });
  const hum = useSharedValue(0);

  useEffect(() => {
    if (reduced) {
      // Reduced motion gets the ambience parked mid-sweep, never the movement.
      hum.value = 0.5;
      return;
    }
    hum.value = 0;
    hum.value = withRepeat(
      withTiming(1, { duration: HUM_MS, easing: Easing.linear }),
      -1,
      false,
    );
  }, [reduced, hum]);

  const humStyle = useAnimatedStyle(() => {
    const span = size.w * 2.4;
    return {
      transform: [{ rotate: '18deg' }, { translateX: -size.w * 0.9 + hum.value * span }],
    };
  }, [size.w]);

  const sheen = useMemo(
    () => ({
      position: 'absolute' as const,
      top: -size.h * 0.5,
      left: 0,
      width: Math.max(1, size.w * 0.5),
      height: Math.max(1, size.h * 2),
      backgroundColor: rgba(t.accent, light ? 0.05 : 0.045),
    }),
    [size.w, size.h, t.accent, light],
  );

  return (
    <BreathCtx.Provider value={breath}>
      <View
        style={styles.screen}
        onLayout={(e) => {
          const { width, height } = e.nativeEvent.layout;
          setSize((p) => (p.w === width && p.h === height ? p : { w: width, h: height }));
        }}>
        {size.w > 0 && (
          <View pointerEvents="none" style={styles.humClip}>
            <Animated.View style={[sheen, humStyle]} />
          </View>
        )}
        {children}
      </View>
    </BreathCtx.Provider>
  );
}

// ---------------------------------------------------------------------------
// Card
// ---------------------------------------------------------------------------

function Card({
  title,
  index = 0,
  tone = 'default',
  accentColor,
  onPress,
  selected,
  style,
  children,
}: CardProps) {
  const t = useTheme();
  const light = useResolvedScheme() === 'light';
  const reduced = useReducedMotion();
  const themed = useThemedStyles(makeStyles);
  const { v, alive } = useVitals();
  const breath = useBreathValue();

  // Tone meanings are inherited verbatim from classic: live = green + rounder,
  // down = deep red, selected = accent, alert = the unreachable banner.
  const toneColor =
    accentColor ??
    (tone === 'live'
      ? t.green
      : tone === 'alert'
        ? t.red
        : tone === 'down'
          ? t.redDeep
          : selected
            ? t.accent
            : null);

  const edgeColor = toneColor ?? t.cardBorder;
  const glowColor = toneColor ?? t.accent;
  const sev = severityOf(glowColor, t);
  const radius = tone === 'live' ? 14 : 12;

  // A plain card is barely lit; a toned/selected one commits. Exertion adds a
  // little on top so a hot box is visibly hotter everywhere at once.
  const peak = clamp(
    (tone === 'default' && !selected ? 0.3 : 1) * (0.35 + 0.65 * sev) * (0.75 + 0.35 * v),
    0,
    1,
  );
  // A box that is not answering must not have a healthy pulse.
  const dead = tone === 'down' || !alive;

  const haloStyle = useAnimatedStyle(() => {
    const b = dead ? BREATH_REST : breath.value;
    return { opacity: peak * (dead ? 0.45 : 0.6 + 0.4 * b) };
  }, [peak, dead]);

  const edgeStyle = useAnimatedStyle(() => {
    const b = dead ? BREATH_REST : breath.value;
    return { opacity: dead ? 0.55 : 0.6 + 0.4 * b };
  }, [dead]);

  // Entrance. Cards probe-and-appear, so this fires exactly once per mount and
  // is never re-triggered by a re-render (or by `index` shuffling underneath).
  const enter = useSharedValue(0);
  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    if (reduced) {
      enter.value = 1;
      return;
    }
    enter.value = withDelay(
      Math.min(Math.max(0, index), 6) * 55,
      withTiming(1, { duration: 260, easing: Easing.out(Easing.quad) }),
    );
  }, [enter, index, reduced]);

  const enterStyle = useAnimatedStyle(() => ({
    opacity: enter.value,
    transform: [{ translateY: (1 - enter.value) * 8 }],
  }));

  const frameStyle = [
    themed.card,
    {
      borderRadius: radius,
      borderColor: light && toneColor != null ? toneColor : edgeColor,
      // LIGHT MODE: "glow" becomes weight + a tinted lift, not a halo.
      borderWidth: light && toneColor != null ? 1.5 : 1,
      ...(light
        ? {
            backgroundColor: toneColor != null ? rgba(toneColor, 0.05) : t.card,
            boxShadow: bloom(toneColor ?? t.slate, 6, 0.12 + 0.18 * sev),
          }
        : null),
    },
  ];

  const body = (
    <>
      {/* Faked top-lit bevel: three hairlines at decreasing alpha. */}
      <Animated.View
        pointerEvents="none"
        style={[
          themed.edge,
          { top: 0, left: radius, right: radius, backgroundColor: rgba(glowColor, 0.65) },
          edgeStyle,
        ]}
      />
      <View
        pointerEvents="none"
        style={[
          themed.edge,
          { top: 1.5, left: radius + 4, right: radius + 4, backgroundColor: rgba(glowColor, 0.3) },
        ]}
      />
      <View
        pointerEvents="none"
        style={[
          themed.edge,
          { top: 3, left: radius + 10, right: radius + 10, backgroundColor: rgba(glowColor, 0.14) },
        ]}
      />
      {title != null && <Text style={themed.cardTitle}>{title}</Text>}
      {children}
    </>
  );

  return (
    <Animated.View style={[themed.wrap, style, enterStyle]}>
      {/* DARK MODE ONLY: the animated halo. It sits behind the opaque card, so
          only the ring that spills past the edge is ever seen. */}
      {!light && (
        <Animated.View
          pointerEvents="none"
          style={[
            themed.halo,
            {
              borderRadius: radius + 8,
              backgroundColor: rgba(glowColor, 0.2),
              boxShadow: bloom(glowColor, 16 + 20 * sev, 0.45),
            },
            haloStyle,
          ]}
        />
      )}
      {onPress == null ? (
        <View style={frameStyle}>{body}</View>
      ) : (
        <Pressable
          onPress={onPress}
          style={({ pressed }) => [...frameStyle, pressed && themed.pressed]}>
          {body}
        </Pressable>
      )}
    </Animated.View>
  );
}

// ---------------------------------------------------------------------------
// SectionTitle
// ---------------------------------------------------------------------------

function SectionTitle({ children }: { children: React.ReactNode }) {
  const t = useTheme();
  const light = useResolvedScheme() === 'light';
  const themed = useThemedStyles(makeStyles);
  return (
    <Text
      style={[
        themed.sectionTitle,
        {
          color: light ? t.accent : rgba(t.accent, 0.8),
          ...(light
            ? null
            : {
                textShadowColor: rgba(t.accent, 0.45),
                textShadowOffset: { width: 0, height: 0 },
                textShadowRadius: 8,
              }),
        },
      ]}>
      {children}
    </Text>
  );
}

// ---------------------------------------------------------------------------
// BigMetric: hot type
// ---------------------------------------------------------------------------

function BigMetric({ value, color }: MetricProps) {
  const t = useTheme();
  const light = useResolvedScheme() === 'light';
  const themed = useThemedStyles(makeStyles);
  const { v, alive } = useVitals();
  const breath = useBreathValue();

  const sev = severityOf(color, t);
  const peak = clamp((0.4 + 0.6 * sev) * (0.75 + 0.35 * v), 0, 1);

  const glowStyle = useAnimatedStyle(() => {
    const b = alive ? breath.value : BREATH_REST;
    return { opacity: peak * (alive ? 0.55 + 0.45 * b : 0.5) };
  }, [peak, alive]);

  return (
    <View style={themed.metricWrap}>
      {/* The bloom behind the digits. Dark: a real halo. Light: a tinted pill,
          which is how "hot" has to read on white without turning to mud. */}
      <Animated.View
        pointerEvents="none"
        style={[
          themed.metricGlow,
          {
            backgroundColor: rgba(color, light ? 0.12 : 0.16),
            ...(light ? null : { boxShadow: bloom(color, 14 + 18 * sev, 0.4) }),
          },
          glowStyle,
        ]}
      />
      {/* Chromatic bleed. DARK ONLY -- on a white background an offset ghost
          reads as a rendering bug, not as heat. */}
      {!light && (
        <Text
          pointerEvents="none"
          style={[themed.bigMetric, themed.metricGhost, { color: rgba(color, 0.35) }]}>
          {value}
        </Text>
      )}
      <Text
        style={[
          themed.bigMetric,
          {
            color,
            ...(light
              ? { fontWeight: '800' as const }
              : {
                  textShadowColor: rgba(color, 0.35 + 0.35 * sev),
                  textShadowOffset: { width: 0, height: 0 },
                  textShadowRadius: 10,
                }),
          },
        ]}>
        {value}
      </Text>
    </View>
  );
}

// ---------------------------------------------------------------------------
// Bar
// ---------------------------------------------------------------------------

/** Width of the travelling highlight, in px. */
const SWEEP_W = 46;

function Bar({ pct, color, height = 10 }: BarProps) {
  const t = useTheme();
  const light = useResolvedScheme() === 'light';
  const themed = useThemedStyles(makeStyles);
  const reduced = useReducedMotion();
  const { v, alive } = useVitals();

  const p = clamp(pct, 0, 100);
  const sev = severityOf(color, t);
  const [w, setW] = useState(0);
  const fillW = (w * p) / 100;

  // The sweep only runs on a live box, and only when there is enough filled
  // track for it to be a highlight rather than a flicker.
  const on = alive && !reduced && fillW > SWEEP_W * 0.6;
  const sweep = useSharedValue(0);

  useEffect(() => {
    if (!on) {
      sweep.value = 0;
      return;
    }
    sweep.value = 0;
    sweep.value = withRepeat(
      withTiming(1, { duration: Math.round(2400 - 900 * clamp(v, 0, 1)), easing: Easing.linear }),
      -1,
      false,
    );
  }, [on, v, sweep]);

  const sweepStyle = useAnimatedStyle(() => {
    const travel = fillW + SWEEP_W;
    return {
      opacity: on ? 1 : 0,
      transform: [{ translateX: -SWEEP_W + sweep.value * travel }],
    };
  }, [fillW, on]);

  return (
    <View
      style={themed.barWrap}
      onLayout={(e) => {
        const next = e.nativeEvent.layout.width;
        setW((prev) => (prev === next ? prev : next));
      }}>
      {/* Dark: the filled portion throws light past the track edge. */}
      {!light && fillW > 0 && (
        <View
          pointerEvents="none"
          style={{
            position: 'absolute',
            left: -2,
            top: -3,
            width: fillW + 4,
            height: height + 6,
            borderRadius: (height + 6) / 2,
            backgroundColor: rgba(color, 0.16),
            boxShadow: bloom(color, 8 + 14 * sev, 0.5),
          }}
        />
      )}
      <View
        style={[
          themed.barTrack,
          {
            height,
            borderRadius: height / 2,
            // Light: saturation instead of bloom -- a tinted track edge.
            ...(light ? { borderWidth: 1, borderColor: rgba(color, 0.28) } : null),
          },
        ]}>
        <View
          style={{
            width: `${p}%`,
            height: '100%',
            backgroundColor: color,
            borderRadius: height / 2,
            overflow: 'hidden',
          }}>
          <Animated.View
            pointerEvents="none"
            style={[
              {
                position: 'absolute',
                top: 0,
                bottom: 0,
                width: SWEEP_W,
                backgroundColor: rgba(t.text, light ? 0.22 : 0.3),
              },
              sweepStyle,
            ]}
          />
        </View>
      </View>
    </View>
  );
}

// ---------------------------------------------------------------------------
// Spark
// ---------------------------------------------------------------------------

/**
 * Same contract as components/Sparkline (null samples are gaps, nothing renders
 * under two real samples) but lit: older samples fade back, the newest and the
 * tallest carry the bloom. Reimplemented rather than wrapped because the shared
 * component takes no decoration props and a glow on its container would light
 * the whole row uniformly, which loses the "most recent is hottest" read.
 */
function Spark({ values, color, height = 22, min, max }: SparkProps) {
  const light = useResolvedScheme() === 'light';
  const t = useTheme();
  const themed = useThemedStyles(makeStyles);

  const real = (values ?? []).filter((n): n is number => n != null);
  if (!values || real.length < 2) return null;

  const lo = min ?? Math.min(...real);
  const hi = max ?? Math.max(...real);
  const span = hi - lo;
  const sev = severityOf(color, t);

  // Which bars get the expensive treatment: the last real sample and the peak.
  let lastReal = -1;
  let tallest = -1;
  let tallestV = -Infinity;
  values.forEach((n, i) => {
    if (n == null) return;
    lastReal = i;
    if (n > tallestV) {
      tallestV = n;
      tallest = i;
    }
  });

  const n = values.length;

  return (
    <View style={[themed.sparkRow, { height }]} pointerEvents="none">
      {values.map((val, i) => {
        if (val == null) return <View key={i} style={themed.sparkBar} />;
        const frac = span > 0 ? (val - lo) / span : 0.5;
        const h = Math.max(3, Math.round(height * (0.12 + 0.88 * clamp(frac, 0, 1))));
        // Recency ramp: the tail of the history is the bright end.
        const recency = n > 1 ? i / (n - 1) : 1;
        const hot = i === lastReal || i === tallest;
        return (
          <View
            key={i}
            style={[
              themed.sparkBar,
              {
                height: h,
                backgroundColor: color,
                opacity: hot ? 1 : 0.3 + 0.45 * recency,
                ...(hot && !light ? { boxShadow: bloom(color, 5 + 7 * sev, 0.75) } : null),
              },
            ]}
          />
        );
      })}
    </View>
  );
}

// ---------------------------------------------------------------------------
// Dot: the reactor core
// ---------------------------------------------------------------------------

function Dot({ color, size = 14, live = true }: DotProps) {
  const t = useTheme();
  const light = useResolvedScheme() === 'light';
  const breath = useBreathValue();
  const sev = severityOf(color, t);

  const ringOuter = size * 1.75;
  const ringInner = size * 1.3;

  const ring1 = useAnimatedStyle(() => {
    const b = live ? breath.value : BREATH_REST;
    return { transform: [{ scale: 0.8 + 0.3 * b }], opacity: live ? 0.55 - 0.3 * b : 0.18 };
  }, [live]);

  const ring2 = useAnimatedStyle(() => {
    // Phase-inverted so the two rings read as a pulse leaving the core.
    const b = live ? 1 - breath.value : BREATH_REST;
    return { transform: [{ scale: 0.85 + 0.25 * b }], opacity: live ? 0.4 - 0.22 * b : 0.14 };
  }, [live]);

  return (
    <View style={[dotStyles.wrap, { width: size, height: size }]} pointerEvents="none">
      <Animated.View
        style={[
          dotStyles.ring,
          {
            width: ringOuter,
            height: ringOuter,
            borderRadius: ringOuter / 2,
            borderColor: rgba(color, light ? 0.5 : 0.7),
          },
          ring1,
        ]}
      />
      <Animated.View
        style={[
          dotStyles.ring,
          {
            width: ringInner,
            height: ringInner,
            borderRadius: ringInner / 2,
            borderColor: rgba(color, light ? 0.45 : 0.6),
          },
          ring2,
        ]}
      />
      {/* Containment shell: keeps the dot's visual footprint the same size the
          layout expects, with the bright core burning inside it. */}
      <View
        style={{
          width: size,
          height: size,
          borderRadius: size / 2,
          backgroundColor: rgba(color, light ? 0.3 : 0.28),
          alignItems: 'center',
          justifyContent: 'center',
        }}>
        <View
          style={{
            width: size * 0.58,
            height: size * 0.58,
            borderRadius: size,
            backgroundColor: color,
            ...(light ? null : { boxShadow: bloom(color, 5 + 9 * sev, 0.85) }),
          }}
        />
      </View>
    </View>
  );
}

const dotStyles = StyleSheet.create({
  wrap: { alignItems: 'center', justifyContent: 'center' },
  ring: { position: 'absolute', borderWidth: 1 },
});

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const styles = StyleSheet.create({
  screen: { flex: 1 },
  humClip: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, overflow: 'hidden' },
});

const makeStyles = (t: Palette) =>
  StyleSheet.create({
    wrap: { marginBottom: 10, position: 'relative' },
    halo: { position: 'absolute', top: -8, left: -8, right: -8, bottom: -8 },
    card: {
      backgroundColor: t.card,
      borderColor: t.cardBorder,
      borderWidth: 1,
      borderRadius: 12,
      padding: 14,
    },
    pressed: { opacity: 0.7 },
    edge: { position: 'absolute', height: StyleSheet.hairlineWidth },
    cardTitle: {
      color: t.textDim,
      fontFamily: mono,
      fontSize: 11,
      fontWeight: '700',
      letterSpacing: 1.4,
      marginBottom: 8,
    },
    sectionTitle: {
      fontFamily: mono,
      fontSize: 11,
      letterSpacing: 1.6,
      marginBottom: 10,
    },
    metricWrap: { alignSelf: 'flex-start', position: 'relative' },
    metricGlow: {
      position: 'absolute',
      top: -6,
      bottom: -6,
      left: -10,
      right: -10,
      borderRadius: 12,
    },
    metricGhost: {
      position: 'absolute',
      left: 0,
      top: 0,
      transform: [{ translateX: 1.5 }, { translateY: -1 }],
    },
    bigMetric: { fontSize: 28, fontWeight: '700', ...numeric },
    barWrap: { position: 'relative' },
    barTrack: { backgroundColor: t.inset, overflow: 'hidden' },
    sparkRow: { flexDirection: 'row', alignItems: 'flex-end', gap: 2, marginTop: 8 },
    sparkBar: { flex: 1, borderRadius: 1, backgroundColor: 'transparent' },
  });

export const reactorSkin: SkinKit = {
  label: 'Reactor',
  Screen,
  Card,
  SectionTitle,
  BigMetric,
  Bar,
  Spark,
  Dot,
};
