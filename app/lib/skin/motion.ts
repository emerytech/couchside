/**
 * Shared motion primitives for the Console/Fleet skins.
 *
 * THE RULES THIS FILE ENFORCES (see the redesign plan):
 *  * "Breathing" runs off a LOCAL animation clock, never off poll arrival.
 *    Polls land every ~5s with jitter; driving motion from them stutters.
 *  * One clock per screen, shared by every card. N cards must not mean N timers
 *    -- this runs on a phone while the box is streaming.
 *  * Reduced motion is a hard stop, not a slowdown. When the OS asks for less
 *    motion the shared values sit at their mid-point and nothing is scheduled.
 */
import { useEffect, useState } from 'react';
import { AccessibilityInfo, Platform } from 'react-native';
import {
  Easing,
  useDerivedValue,
  useSharedValue,
  withRepeat,
  withTiming,
  type SharedValue,
} from 'react-native-reanimated';

// ---------------------------------------------------------------------------
// Reduced motion
// ---------------------------------------------------------------------------

/**
 * DEV: `?motion=off` forces the reduced-motion path in the web harness.
 *
 * WHY THIS EXISTS: the screenshot harness renders in a browser tab that is
 * never visible (document.visibilityState === 'hidden'), so the browser never
 * fires requestAnimationFrame -- MEASURED at 0 fps, not assumed. Every
 * rAF-driven animation therefore freezes at whatever frame it was on, and a
 * card that ENTERS from opacity 0 photographs as a blank or half-faded box.
 * That is an artifact of the harness, not of the app.
 *
 * Forcing the reduced-motion path makes skins render their settled final
 * state immediately, which is what a still screenshot should show anyway --
 * and it exercises the accessibility path we have to support regardless.
 */
function motionForcedOff(): boolean {
  if (Platform.OS !== 'web' || typeof window === 'undefined') return false;
  try {
    return new URLSearchParams(window.location.search).get('motion') === 'off';
  } catch {
    return false;
  }
}

/**
 * The OS "reduce motion" setting, live. On web RN-Web maps this to the
 * prefers-reduced-motion media query.
 */
export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(motionForcedOff);

  useEffect(() => {
    // The dev override wins outright: don't let the OS query switch it back on.
    if (motionForcedOff()) return;
    let alive = true;
    void AccessibilityInfo.isReduceMotionEnabled().then((v) => {
      if (alive) setReduced(!!v);
    });
    const sub = AccessibilityInfo.addEventListener('reduceMotionChanged', (v) => {
      setReduced(!!v);
    });
    return () => {
      alive = false;
      sub.remove();
    };
  }, []);

  return reduced;
}

// ---------------------------------------------------------------------------
// The breath clock
// ---------------------------------------------------------------------------

/** Mid-point of the breath curve: what a stopped clock rests at. */
export const BREATH_REST = 0.5;

/**
 * A shared value oscillating 0 -> 1 -> 0 forever with the given period.
 *
 * `periodMs` may change at runtime (load-driven breathing speeds up under
 * load); the animation is restarted on change rather than interpolated, which
 * is imperceptible at these periods and keeps the worklet trivial.
 *
 * Returns a value pinned at BREATH_REST when reduced motion is on -- callers
 * do not need to branch, their interpolations just land mid-range.
 */
export function useBreath(periodMs: number, enabled = true): SharedValue<number> {
  const v = useSharedValue(BREATH_REST);
  const reduced = useReducedMotion();
  const on = enabled && !reduced;

  useEffect(() => {
    if (!on) {
      // Cancel any in-flight repeat by overwriting with a static value.
      v.value = withTiming(BREATH_REST, { duration: 200 });
      return;
    }
    v.value = BREATH_REST;
    v.value = withRepeat(
      withTiming(1, {
        duration: Math.max(200, periodMs) / 2,
        easing: Easing.inOut(Easing.sin),
      }),
      -1,
      true,
    );
  }, [on, periodMs, v]);

  return v;
}

/**
 * Map a 0..1 breath onto an arbitrary range without every caller writing the
 * same worklet. `useDerivedValue` keeps the maths on the UI thread.
 */
export function useBreathRange(
  breath: SharedValue<number>,
  from: number,
  to: number,
): SharedValue<number> {
  return useDerivedValue(() => from + (to - from) * breath.value, [from, to]);
}

// ---------------------------------------------------------------------------
// Vitality: how hard the machine is working, 0..1
// ---------------------------------------------------------------------------

/**
 * Collapse load + temperature into a single 0..1 "exertion" figure that skins
 * use to drive breath RATE (a busy box breathes faster) and glow intensity.
 *
 * Deliberately NOT a semantic colour input: colour meaning stays with
 * tempColor/pctColor. This only ever drives motion.
 */
export function vitality(load1: number | undefined, tempC: number | null | undefined): number {
  // Load is per-core-ish and unbounded; 0..2 covers the interesting range.
  const l = load1 == null ? 0 : Math.min(1, Math.max(0, load1 / 2));
  // 40C idle -> 90C hot.
  const t = tempC == null ? 0 : Math.min(1, Math.max(0, (tempC - 40) / 50));
  return Math.min(1, Math.max(0, 0.6 * l + 0.4 * t));
}

/** Resting breath period, in ms, for a given 0..1 vitality. Idle is slow. */
export function breathPeriod(v: number): number {
  const IDLE = 5200;
  const BUSY = 1700;
  return Math.round(IDLE + (BUSY - IDLE) * Math.min(1, Math.max(0, v)));
}
