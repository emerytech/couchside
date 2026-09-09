/**
 * SplashIntro — a brief app-opening animation, shown once per cold launch.
 *
 * The couch is the brand and the green "live" dot is the app's icon mark: the
 * couch settles, the status dot lands on it and pulses (the same #33d499 pulse
 * the Console shows when a box is alive), then the whole overlay fades to the
 * app. ~1.9s, premium and quiet, then it unmounts and never shows again this
 * launch (module flag).
 *
 * This is the "best of both" of the two launch-animation candidates: Candidate
 * B's identity (couch + pulsing green icon-dot, faithful to
 * assets/images/android-icon-foreground.png), rendered by Candidate A's engine
 * (Reanimated + RN Views, already a dependency) — so no lottie-react-native
 * native module, no new asset, and it works in the web harness.
 *
 * It sits on TOP of the whole tree from the first frame, background = the live
 * theme bg, so it covers the app until it fades — no flash of an un-animated
 * screen. The static native splash (expo-splash-screen, #0b1220) hands straight
 * off to this on the default dark look. Observe-only chrome: pointerEvents none,
 * a11y-hidden — it is never the touch responder.
 */
import { useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import Animated, {
  Easing,
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withRepeat,
  withSequence,
  withSpring,
  withTiming,
} from 'react-native-reanimated';

import { mono, useTheme } from '@/lib/theme';

// Once per app launch. A module flag (not a pref): the intro is per-process, so
// a remount of the root layout within the same launch must not replay it.
let hasPlayed = false;

/** The brand's "live" green — the app icon's foreground mark and the Console's
 *  alive-dot. Constant, not a theme token: it is the identity, on every pack. */
const LIVE = '#33d499';
/** Total time the overlay owns the screen before it is gone (ms). */
const LIFETIME_MS = 1950;

export function SplashIntro() {
  const t = useTheme();
  const [done, setDone] = useState(hasPlayed);

  const overlay = useSharedValue(1); // whole-overlay opacity, 1 -> 0 at the end
  const backY = useSharedValue(16); // couch back settles up
  const backO = useSharedValue(0);
  const seatO = useSharedValue(0); // seat cushions
  const seatS = useSharedValue(0.8);
  const armO = useSharedValue(0); // armrests, last
  const dotS = useSharedValue(0.2); // status dot lands + pops
  const dotO = useSharedValue(0);
  const ring = useSharedValue(0); // 0->1 pulse ring, repeated
  const wordO = useSharedValue(0); // quiet wordmark

  useEffect(() => {
    if (hasPlayed) return;
    hasPlayed = true;

    // Couch settles, staggered back -> seat -> arms.
    backO.value = withTiming(1, { duration: 380, easing: Easing.out(Easing.cubic) });
    backY.value = withTiming(0, { duration: 440, easing: Easing.out(Easing.cubic) });
    seatO.value = withDelay(120, withTiming(1, { duration: 300 }));
    seatS.value = withDelay(120, withTiming(1, { duration: 340, easing: Easing.out(Easing.cubic) }));
    armO.value = withDelay(210, withTiming(1, { duration: 280 }));

    // The live dot lands and pops.
    dotO.value = withDelay(380, withTiming(1, { duration: 160 }));
    dotS.value = withDelay(
      380,
      withSequence(
        withTiming(1.18, { duration: 220, easing: Easing.out(Easing.cubic) }),
        withSpring(1, { damping: 8, stiffness: 180 }),
      ),
    );
    // ...then breathes two pulse rings.
    ring.value = withDelay(
      640,
      withRepeat(withTiming(1, { duration: 900, easing: Easing.out(Easing.quad) }), 2, false),
    );

    wordO.value = withDelay(760, withTiming(1, { duration: 300 }));

    // Hold, then fade the whole overlay out and unmount.
    overlay.value = withDelay(
      LIFETIME_MS - 380,
      withTiming(0, { duration: 380, easing: Easing.in(Easing.cubic) }, (finished) => {
        if (finished) runOnJS(setDone)(true);
      }),
    );
    const kill = setTimeout(() => setDone(true), LIFETIME_MS + 250);
    return () => clearTimeout(kill);
  }, [armO, backO, backY, dotO, dotS, overlay, ring, seatO, seatS, wordO]);

  const overlayStyle = useAnimatedStyle(() => ({ opacity: overlay.value }));
  const backStyle = useAnimatedStyle(() => ({ opacity: backO.value, transform: [{ translateY: backY.value }] }));
  const seatStyle = useAnimatedStyle(() => ({ opacity: seatO.value, transform: [{ scaleX: seatS.value }] }));
  const armStyle = useAnimatedStyle(() => ({ opacity: armO.value }));
  const dotStyle = useAnimatedStyle(() => ({ opacity: dotO.value, transform: [{ scale: dotS.value }] }));
  const ringStyle = useAnimatedStyle(() => ({
    opacity: 0.5 * (1 - ring.value),
    transform: [{ scale: 1 + ring.value * 1.9 }],
  }));
  const wordStyle = useAnimatedStyle(() => ({ opacity: wordO.value }));

  if (done) return null;

  const couchInk = t.text;

  return (
    <Animated.View
      style={[styles.fill, { backgroundColor: t.bg }, overlayStyle]}
      pointerEvents="none"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants">
      <View style={styles.center}>
        <View style={styles.stage}>
          {/* The live dot with its pulse, floating just above the couch back. */}
          <View style={styles.dotWrap}>
            <Animated.View style={[styles.ring, ringStyle]} />
            <Animated.View style={[styles.dot, dotStyle]} />
          </View>
          {/* The couch: a back panel, two seat cushions, two arms. */}
          <View style={styles.couch}>
            <Animated.View style={[styles.arm, { backgroundColor: couchInk }, armStyle]} />
            <Animated.View style={[styles.body, backStyle]}>
              <Animated.View style={[styles.back, { backgroundColor: couchInk }]} />
              <View style={styles.seatRow}>
                <Animated.View style={[styles.cushion, { backgroundColor: couchInk }, seatStyle]} />
                <Animated.View style={[styles.cushion, { backgroundColor: couchInk }, seatStyle]} />
              </View>
            </Animated.View>
            <Animated.View style={[styles.arm, { backgroundColor: couchInk }, armStyle]} />
          </View>
        </View>
        <Animated.Text style={[styles.word, { color: t.textDim }, wordStyle]}>couchside</Animated.Text>
      </View>
    </Animated.View>
  );
}

const CUSHION = 30;
const styles = StyleSheet.create({
  fill: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, zIndex: 9999, elevation: 9999 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  stage: { alignItems: 'center' },
  dotWrap: { width: 26, height: 26, alignItems: 'center', justifyContent: 'center', marginBottom: 10 },
  dot: { width: 22, height: 22, borderRadius: 11, backgroundColor: LIVE },
  ring: { position: 'absolute', width: 22, height: 22, borderRadius: 11, borderWidth: 2, borderColor: LIVE },
  couch: { flexDirection: 'row', alignItems: 'flex-end' },
  body: { alignItems: 'center' },
  back: { width: CUSHION * 2 + 6, height: 16, borderTopLeftRadius: 7, borderTopRightRadius: 7, marginBottom: 3 },
  seatRow: { flexDirection: 'row', gap: 4 },
  cushion: { width: CUSHION, height: 16, borderRadius: 5 },
  arm: { width: 12, height: 30, borderRadius: 5 },
  word: {
    marginTop: 22,
    fontFamily: mono,
    fontSize: 15,
    fontWeight: '600',
    letterSpacing: 4,
    opacity: 0.9,
  },
});
