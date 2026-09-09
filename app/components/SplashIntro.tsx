/**
 * SplashIntro — a brief app-opening animation, shown once per cold launch.
 *
 * Plays the "Couchside Premium Launch" Lottie (assets/launch.json): the couch
 * settles and the brand's green live-dot (#33d499, the app icon's foreground
 * mark) lands and pulses. Under it, the wordmark — "Couchside" over a smaller
 * "remote" — fades in with a green glow. Then the overlay fades to the app. ~2s.
 *
 * The Lottie is the chosen art (Candidate B); this component is the integration
 * — the once-per-launch mount, the theme-bg cover so there is no flash of an
 * un-animated screen, and the fade hand-off to the app when the Lottie finishes.
 * It sits on TOP of the whole tree from the first frame with pointerEvents none
 * and a11y-hidden: observe-only chrome, never the touch responder. The static
 * native splash (expo-splash-screen, #0b1220) hands straight off to this.
 */
import LottieView from 'lottie-react-native';
import { useCallback, useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import Animated, {
  Easing,
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';

import { mono, useTheme } from '@/lib/theme';

// The Lottie composition. 1024x1024, transparent, ~2s (op120 @ 60fps).
const LAUNCH = require('../assets/launch.json');

// The brand's "live" green — the app icon's mark; also the wordmark's glow.
const LIVE = '#33d499';

// Once per app launch. A module flag (not a pref): the intro is per-process, so
// a remount of the root layout within the same launch must not replay it.
let hasPlayed = false;

// Fallback teardown if onAnimationFinish never fires (e.g. some web renderers):
// a hair past the Lottie's own 2.0s so it only ever acts as a safety net.
const KILL_MS = 2600;

export function SplashIntro() {
  const t = useTheme();
  const [done, setDone] = useState(hasPlayed);
  const overlay = useSharedValue(1); // whole-overlay opacity, 1 -> 0 at the end

  const fadeOut = useCallback(() => {
    overlay.value = withTiming(
      0,
      { duration: 340, easing: Easing.in(Easing.cubic) },
      (finished) => {
        if (finished) runOnJS(setDone)(true);
      },
    );
  }, [overlay]);

  useEffect(() => {
    if (hasPlayed) return;
    hasPlayed = true;
    const kill = setTimeout(fadeOut, KILL_MS);
    return () => clearTimeout(kill);
  }, [fadeOut]);

  const overlayStyle = useAnimatedStyle(() => ({ opacity: overlay.value }));

  if (done) return null;

  return (
    <Animated.View
      style={[styles.fill, { backgroundColor: t.bg }, overlayStyle]}
      pointerEvents="none"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants">
      <View style={styles.center}>
        <View style={styles.stage}>
          <LottieView
            source={LAUNCH}
            autoPlay
            loop={false}
            resizeMode="contain"
            onAnimationFinish={fadeOut}
            style={styles.lottie}
          />
          {/* Wordmark, absolutely placed just under the couch (which sits mid-
              canvas), so the Lottie's empty lower canvas doesn't push it away.
              Green glow via textShadow. */}
          <View style={styles.wordmark}>
            <Text style={[styles.brand, { color: t.text }]}>Couchside</Text>
            <Text style={styles.remote}>remote</Text>
          </View>
        </View>
      </View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  fill: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, zIndex: 9999, elevation: 9999 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  stage: { width: 320, height: 320 },
  lottie: { width: 320, height: 320 },
  // Anchored inside the Lottie box: the couch sits around mid-canvas, so ~62%
  // down lands the wordmark just beneath it.
  wordmark: { position: 'absolute', top: '65%', left: 0, right: 0, alignItems: 'center' },
  brand: {
    fontFamily: mono,
    fontSize: 27,
    fontWeight: '700',
    letterSpacing: 0.5,
    textShadowColor: 'rgba(51,212,153,0.95)',
    textShadowOffset: { width: 0, height: 0 },
    textShadowRadius: 22,
  },
  remote: {
    fontFamily: mono,
    fontSize: 12,
    fontWeight: '600',
    letterSpacing: 7,
    marginTop: 6,
    color: '#4fe3ab',
    textShadowColor: 'rgba(51,212,153,0.95)',
    textShadowOffset: { width: 0, height: 0 },
    textShadowRadius: 14,
  },
});
