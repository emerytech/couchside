/**
 * SplashIntro — a brief app-opening animation, shown once per cold launch.
 *
 * The couch is the brand: a controller drops onto a couch, the wordmark fades
 * in, the whole overlay fades to the app. ~1s, then it unmounts and never shows
 * again this launch (module flag). It sits on TOP of the whole tree from the
 * first frame, its background = the live theme bg, so it covers the app until
 * it fades — no flash of an un-animated screen. The static native splash
 * (expo-splash-screen, #0b1220) hands straight off to this on the default dark
 * look; on a light/OLED pack the fade lands on that pack's bg.
 *
 * Pure Reanimated + RN Views + one Ionicon (no SVG/Lottie dependency). It is
 * observe-only chrome: it never becomes the touch responder for more than its
 * ~1s life, and it is inert to everything the app does.
 */
import Ionicons from '@expo/vector-icons/Ionicons';
import { useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import Animated, {
  Easing,
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withSequence,
  withSpring,
  withTiming,
} from 'react-native-reanimated';

import { mono, useTheme } from '@/lib/theme';

// Once per app launch. A module flag (not a pref): the intro is per-process, so
// a remount of the root layout within the same launch must not replay it.
let hasPlayed = false;

/** Total time the overlay owns the screen before it is gone (ms). */
const LIFETIME_MS = 1050;

export function SplashIntro() {
  const t = useTheme();
  // `done` starts true when we've already played this launch, so a remount
  // renders nothing at all.
  const [done, setDone] = useState(hasPlayed);

  const overlay = useSharedValue(1); // whole-overlay opacity, 1 -> 0 at the end
  const couchY = useSharedValue(14); // couch slides up into place
  const couchO = useSharedValue(0);
  const padScale = useSharedValue(0.35); // controller pops in
  const padO = useSharedValue(0);
  const padDrop = useSharedValue(-18); // ...dropping onto the couch
  const wordO = useSharedValue(0); // wordmark fades in

  useEffect(() => {
    if (hasPlayed) return;
    hasPlayed = true;

    // Couch settles first.
    couchO.value = withTiming(1, { duration: 260, easing: Easing.out(Easing.cubic) });
    couchY.value = withTiming(0, { duration: 300, easing: Easing.out(Easing.cubic) });

    // Controller drops + pops, a beat later.
    padO.value = withDelay(140, withTiming(1, { duration: 180 }));
    padDrop.value = withDelay(140, withSpring(0, { damping: 9, stiffness: 170 }));
    padScale.value = withDelay(
      140,
      withSequence(
        withTiming(1.12, { duration: 200, easing: Easing.out(Easing.cubic) }),
        withSpring(1, { damping: 8, stiffness: 180 }),
      ),
    );

    // Wordmark last.
    wordO.value = withDelay(420, withTiming(1, { duration: 260 }));

    // Hold, then fade the whole overlay out and unmount.
    overlay.value = withDelay(
      LIFETIME_MS - 340,
      withTiming(0, { duration: 340, easing: Easing.in(Easing.cubic) }, (finished) => {
        if (finished) runOnJS(setDone)(true);
      }),
    );
    // Safety: if the callback is ever dropped, still tear down.
    const kill = setTimeout(() => setDone(true), LIFETIME_MS + 200);
    return () => clearTimeout(kill);
  }, [couchO, couchY, overlay, padDrop, padO, padScale, wordO]);

  const overlayStyle = useAnimatedStyle(() => ({ opacity: overlay.value }));
  const couchStyle = useAnimatedStyle(() => ({
    opacity: couchO.value,
    transform: [{ translateY: couchY.value }],
  }));
  const padStyle = useAnimatedStyle(() => ({
    opacity: padO.value,
    transform: [{ translateY: padDrop.value }, { scale: padScale.value }],
  }));
  const wordStyle = useAnimatedStyle(() => ({ opacity: wordO.value }));

  if (done) return null;

  return (
    <Animated.View
      style={[styles.fill, { backgroundColor: t.bg }, overlayStyle]}
      pointerEvents="none"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants">
      <View style={styles.center}>
        <View style={styles.stage}>
          {/* Controller drops onto the couch. */}
          <Animated.View style={padStyle}>
            <Ionicons name="game-controller" size={64} color={t.accent} />
          </Animated.View>
          {/* Couch: a seat with two armrests, in faint theme ink. */}
          <Animated.View style={[styles.couch, couchStyle]}>
            <View style={[styles.arm, { backgroundColor: t.textFaint }]} />
            <View style={[styles.seat, { backgroundColor: t.textFaint }]} />
            <View style={[styles.arm, { backgroundColor: t.textFaint }]} />
          </Animated.View>
        </View>
        <Animated.Text style={[styles.word, { color: t.text }, wordStyle]}>couchside</Animated.Text>
      </View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  fill: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, zIndex: 9999, elevation: 9999 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  stage: { alignItems: 'center' },
  couch: { flexDirection: 'row', alignItems: 'flex-end', marginTop: 6, height: 20 },
  arm: { width: 10, height: 18, borderRadius: 4 },
  seat: { width: 54, height: 12, borderRadius: 4, marginHorizontal: 2, opacity: 0.9 },
  word: {
    marginTop: 18,
    fontFamily: mono,
    fontSize: 20,
    fontWeight: '700',
    letterSpacing: 3,
  },
});
