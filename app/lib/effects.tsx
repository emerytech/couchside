/**
 * EFFECTS — one restrained, FUNCTIONAL effect: an alarm pulse.
 *
 * The decorative directions (ambient motion, texture, reactive glow) were cut —
 * on device they read as gimmick, which is the opposite of what the skins are
 * for. What remains is the one effect that earns its place: when a vital crosses
 * into amber/red, the screen edge pulses in THAT semantic colour, so a problem
 * catches your eye even when you are not looking at the offending card. It is
 * a peripheral echo of a number that has already turned red on the card — never
 * a new colour, never faked, and off by default.
 *
 * Mounted once in the Console root, above the content of whatever skin is active,
 * so it is skin-agnostic and never touches a skin's components. Reduced-motion
 * holds it steady instead of pulsing. Nothing blocks touches.
 */
import React from 'react';
import { Image, StyleSheet, View } from 'react-native';
import Animated, {
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
} from 'react-native-reanimated';

import { useEffects as usePersistedEffects, setEffects, useTheme } from '@/lib/theme';
import { useReducedMotion } from '@/lib/skin';

// Re-export so callers reach the whole effects API from one module.
export { useEffects } from '@/lib/theme';

const EDGE = require('../assets/effects/edge.png');

export const EFFECT_KEYS = ['alarm'] as const;
export type EffectKey = (typeof EFFECT_KEYS)[number];

export const EFFECTS: Record<EffectKey, { label: string; description: string }> = {
  alarm: { label: 'Alarm pulse', description: 'The screen edge pulses when a vital runs hot.' },
};

function isEffectKey(v: unknown): v is EffectKey {
  return typeof v === 'string' && (EFFECT_KEYS as readonly string[]).includes(v);
}

/** The active effects as a boolean map (unknown persisted keys ignored). */
export function useActiveEffects(): Record<EffectKey, boolean> {
  const raw = usePersistedEffects();
  const set = new Set(raw.filter(isEffectKey));
  return { alarm: set.has('alarm') };
}

/** Flip one effect on/off and persist. Pass the current persisted list. */
export function toggleEffect(list: string[], key: EffectKey): void {
  const set = new Set(list.filter(isEffectKey));
  if (set.has(key)) set.delete(key);
  else set.add(key);
  void setEffects([...set]);
}

const fill = { position: 'absolute' as const, left: 0, right: 0, top: 0, bottom: 0 };

/** A gentle pulsing edge tint (edge.png tinted the vital's own colour). */
function EdgePulse({ color, period, peak }: { color: string; period: number; peak: number }) {
  const reduced = useReducedMotion();
  const p = useSharedValue(reduced ? 0.7 : 0);
  React.useEffect(() => {
    if (reduced) {
      p.value = 0.7; // steady, no pulse
      return;
    }
    p.value = 0;
    p.value = withRepeat(withTiming(1, { duration: period, easing: Easing.inOut(Easing.quad) }), -1, true);
  }, [reduced, period, p]);
  // Calm swing: never fully off, never harsh.
  const style = useAnimatedStyle(() => ({ opacity: peak * (0.45 + 0.55 * p.value) }), [peak]);
  return (
    <Animated.View style={[fill, style]} pointerEvents="none">
      <Image source={EDGE} resizeMode="stretch" style={[fill, { tintColor: color }]} />
    </Animated.View>
  );
}

/**
 * The effects layer. Mount ONCE in the Console root, above the ScrollView.
 * `alarm`: 0 none, 1 amber, 2 red — computed by the Console from the same
 * thresholds the metric cards use.
 */
export function EffectsOverlays({ alarm = 0 }: { alarm?: 0 | 1 | 2 }) {
  const fx = useActiveEffects();
  const t = useTheme();
  if (!fx.alarm || alarm <= 0) return null;
  const color = alarm >= 2 ? t.red : t.amber;
  // Red is more urgent than amber: a touch stronger and a touch faster.
  return (
    <View style={fill} pointerEvents="none">
      <EdgePulse color={color} period={alarm >= 2 ? 1400 : 2200} peak={alarm >= 2 ? 0.3 : 0.18} />
    </View>
  );
}
