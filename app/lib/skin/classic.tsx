/**
 * CLASSIC skin -- today's look, exactly.
 *
 * This is the experiment's control. Every value here was lifted verbatim from
 * the pre-refactor styles in app/(tabs)/index.tsx and app/(tabs)/fleet.tsx. It
 * must render pixel-identical to the shipped 2.9.11 build: if it doesn't, the
 * kit refactor changed something on its own and any judgement about the new
 * directions is measuring the wrong thing.
 *
 * Zero animation, by definition.
 */
import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { Sparkline } from '@/components/Sparkline';
import { mono, useThemedStyles, type Palette } from '@/lib/theme';
import type { BarProps, CardProps, DotProps, MetricProps, SkinKit, SparkProps } from './kit';

function Screen({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}

function Card({ title, tone = 'default', accentColor, onPress, selected, style, children }: CardProps) {
  const styles = useThemedStyles(makeStyles);
  const body = (
    <>
      {title != null && <Text style={styles.cardTitle}>{title}</Text>}
      {children}
    </>
  );
  const frame = [
    styles.card,
    tone === 'live' && styles.cardLive,
    tone === 'down' && styles.cardDown,
    selected && styles.cardSelected,
    accentColor != null && { borderColor: accentColor },
    style,
  ];

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

function BigMetric({ value, color }: MetricProps) {
  const styles = useThemedStyles(makeStyles);
  return <Text style={[styles.bigMetric, { color }]}>{value}</Text>;
}

function Bar({ pct, color, height = 10 }: BarProps) {
  const styles = useThemedStyles(makeStyles);
  return (
    <View style={[styles.barTrack, { height, borderRadius: height / 2 }]}>
      <View
        style={[
          styles.barFill,
          {
            width: `${Math.min(100, Math.max(0, pct))}%`,
            backgroundColor: color,
            borderRadius: height / 2,
          },
        ]}
      />
    </View>
  );
}

function Spark(props: SparkProps) {
  return <Sparkline {...props} />;
}

function Dot({ color, size = 14 }: DotProps) {
  return (
    <View style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: color }} />
  );
}

const makeStyles = (t: Palette) =>
  StyleSheet.create({
    card: {
      backgroundColor: t.card,
      borderColor: t.cardBorder,
      borderWidth: 1,
      borderRadius: 12,
      padding: 14,
      marginBottom: 10,
    },
    // StreamHostCard's live treatment: green border, slightly rounder.
    cardLive: { borderColor: t.green, borderRadius: 14 },
    cardDown: { borderColor: t.redDeep },
    cardSelected: { borderColor: t.blue },
    pressed: { opacity: 0.7 },
    cardTitle: {
      color: t.textFaint,
      fontSize: 11,
      fontWeight: '700',
      letterSpacing: 1.2,
      marginBottom: 8,
    },
    sectionTitle: {
      color: t.textFaint,
      fontFamily: mono,
      fontSize: 11,
      letterSpacing: 1.5,
      marginBottom: 10,
    },
    bigMetric: { fontSize: 28, fontWeight: '700', fontFamily: mono, fontVariant: ['tabular-nums'] },
    barTrack: { backgroundColor: t.inset, overflow: 'hidden' },
    barFill: { height: '100%' },
  });

export const classicSkin: SkinKit = {
  label: 'Classic',
  Screen,
  Card,
  SectionTitle,
  BigMetric,
  Bar,
  Spark,
  Dot,
};
