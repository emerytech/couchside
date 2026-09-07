/**
 * EFFECTS — a cross-skin visual layer the user toggles from the Theme Builder.
 *
 * Effects are DELIBERATELY independent of the skin: any of the six skins can wear
 * any combination of effects, so they live in ONE overlay (`EffectsOverlays`) the
 * Console mounts above its content, never inside a skin's components. That keeps
 * each skin's identity intact (studio/paper stay still by default) while letting a
 * user opt into motion or texture on top.
 *
 * Four independent toggles:
 *  - motion   : a slow ambient sheen drifting across the screen (reduced-motion → parked).
 *  - texture  : static grain + scanlines + a dark vignette (a matte / CRT mood).
 *  - reactive : an accent edge-glow whose intensity tracks the box's exertion
 *               (VitalsContext.v), and which speeds up the ambient motion. A hot
 *               box visibly runs hotter — but the colour is the ACCENT, never a
 *               semantic status hue, so it can't be misread as an alarm.
 *  - alarm    : when a vital crosses into amber/red the screen edge pulses in THAT
 *               semantic colour (red faster/brighter than amber). Semantic-only;
 *               the Console computes the level from the same thresholds the cards use.
 *
 * All colour comes from the live palette; the one tinted asset (edge.png, a radial
 * alpha) is reused for the dark vignette, the accent glow and the alarm pulse via
 * `tintColor`. Nothing here fakes a status colour or blocks touches.
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

import { useEffects as usePersistedEffects, setEffects, useResolvedScheme, useTheme } from '@/lib/theme';
import { useReducedMotion, useVitals } from '@/lib/skin';

// Re-export so callers reach the whole effects API from one module.
export { useEffects } from '@/lib/theme';

const EDGE = require('../assets/effects/edge.png');
const SCANLINE = require('../assets/effects/scanline.png');
const GRAIN = require('../assets/effects/grain.png');

export const EFFECT_KEYS = ['motion', 'texture', 'reactive', 'alarm'] as const;
export type EffectKey = (typeof EFFECT_KEYS)[number];

export const EFFECTS: Record<EffectKey, { label: string; description: string }> = {
  motion: { label: 'Ambient motion', description: 'A slow drifting sheen. Off for reduced motion.' },
  texture: { label: 'Texture', description: 'Fine grain, scanlines and a soft vignette.' },
  reactive: { label: 'Reactive', description: 'Glows warmer the harder the box is working.' },
  alarm: { label: 'Alarm pulse', description: 'The screen edge pulses when a vital runs hot.' },
};

function isEffectKey(v: unknown): v is EffectKey {
  return typeof v === 'string' && (EFFECT_KEYS as readonly string[]).includes(v);
}

/** The active effects as a boolean map (unknown persisted keys ignored). */
export function useActiveEffects(): Record<EffectKey, boolean> {
  const raw = usePersistedEffects();
  const set = new Set(raw.filter(isEffectKey));
  return {
    motion: set.has('motion'),
    texture: set.has('texture'),
    reactive: set.has('reactive'),
    alarm: set.has('alarm'),
  };
}

/** Read the current on/off set without subscribing (for a toggle handler). */
function currentSet(list: string[]): Set<EffectKey> {
  return new Set(list.filter(isEffectKey));
}

/** Flip one effect on/off and persist. Pass the current persisted list. */
export function toggleEffect(list: string[], key: EffectKey): void {
  const set = currentSet(list);
  if (set.has(key)) set.delete(key);
  else set.add(key);
  void setEffects([...set]);
}

// A plain absolute-fill object (not the registered `absoluteFill`), so it is
// assignable to BOTH ViewStyle and ImageStyle arrays below without a cast.
const fill = { position: 'absolute' as const, left: 0, right: 0, top: 0, bottom: 0 };

/** The ambient sheen: one slow light band drifting across the screen. */
function Sheen({ accent, light, rate }: { accent: string; light: boolean; rate: number }) {
  const reduced = useReducedMotion();
  const [w, setW] = React.useState(0);
  const t = useSharedValue(0);
  React.useEffect(() => {
    if (reduced || w === 0) {
      t.value = 0.5; // parked mid-sweep
      return;
    }
    t.value = 0;
    t.value = withRepeat(withTiming(1, { duration: rate, easing: Easing.linear }), -1, false);
  }, [reduced, w, rate, t]);
  const style = useAnimatedStyle(() => {
    const span = w * 2.2;
    return { transform: [{ rotate: '18deg' }, { translateX: -w * 0.8 + t.value * span }] };
  }, [w]);
  return (
    <View style={fill} pointerEvents="none" onLayout={(e) => setW(e.nativeEvent.layout.width)}>
      {w > 0 && (
        <Animated.View
          style={[
            {
              position: 'absolute',
              top: -w,
              bottom: -w,
              width: Math.max(1, w * 0.4),
              backgroundColor: accent,
              opacity: light ? 0.05 : 0.06,
            },
            style,
          ]}
        />
      )}
    </View>
  );
}

/** A pulsing edge tint (edge.png tinted). Used for the alarm pulse. */
function EdgePulse({ color, period, peak }: { color: string; period: number; peak: number }) {
  const reduced = useReducedMotion();
  const p = useSharedValue(reduced ? 0.6 : 0);
  React.useEffect(() => {
    if (reduced) {
      p.value = 0.6;
      return;
    }
    p.value = 0;
    p.value = withRepeat(withTiming(1, { duration: period, easing: Easing.inOut(Easing.quad) }), -1, true);
  }, [reduced, period, p]);
  const style = useAnimatedStyle(() => ({ opacity: 0.25 * peak + 0.75 * peak * p.value }), [peak]);
  return (
    <Animated.View style={[fill, style]} pointerEvents="none">
      <Image source={EDGE} resizeMode="stretch" style={[fill, { tintColor: color }]} />
    </Animated.View>
  );
}

/**
 * The whole effects layer. Mount ONCE in the Console root, above the ScrollView,
 * so it sits over the content of whatever skin is active without touching it.
 * `alarm`: 0 none, 1 amber, 2 red — computed by the Console from the same
 * thresholds the metric cards use.
 */
export function EffectsOverlays({ alarm = 0 }: { alarm?: 0 | 1 | 2 }) {
  const fx = useActiveEffects();
  const t = useTheme();
  const light = useResolvedScheme() === 'light';
  const { v, alive } = useVitals();

  if (!fx.motion && !fx.texture && !fx.reactive && !fx.alarm) return null;

  // Reactive scales ambient intensity + motion rate with exertion (0..1).
  const ex = fx.reactive ? Math.max(0, Math.min(1, v)) : 0;
  const motionRate = Math.round(16000 - (fx.reactive ? 9000 * ex : 0)); // faster when hot
  const alarmColor = alarm >= 2 ? t.red : t.amber;

  return (
    <View style={fill} pointerEvents="none">
      {fx.texture && (
        <>
          <Image source={GRAIN} resizeMode="repeat" style={[fill, { opacity: light ? 0.5 : 0.7 }]} />
          <Image source={SCANLINE} resizeMode="repeat" style={[fill, { opacity: light ? 0.3 : 0.45 }]} />
          <Image source={EDGE} resizeMode="stretch" style={[fill, { tintColor: '#000', opacity: light ? 0.1 : 0.22 }]} />
        </>
      )}
      {fx.motion && <Sheen accent={t.accent} light={light} rate={motionRate} />}
      {fx.reactive && (
        // Accent edge-glow whose strength tracks exertion. A dead box does not glow.
        <Image
          source={EDGE}
          resizeMode="stretch"
          style={[fill, { tintColor: t.accent, opacity: alive ? (light ? 0.06 : 0.1) + 0.22 * ex : 0 }]}
        />
      )}
      {fx.alarm && alarm > 0 && (
        <EdgePulse color={alarmColor} period={alarm >= 2 ? 900 : 1600} peak={alarm >= 2 ? 0.5 : 0.32} />
      )}
    </View>
  );
}
