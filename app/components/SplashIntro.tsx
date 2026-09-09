/**
 * SplashIntro — a brief app-opening animation, shown once per cold launch.
 *
 * Plays the "Couchside Premium Launch" Lottie (assets/launch.json): the couch
 * settles and the brand's green live-dot (#33d499, the app icon's foreground
 * mark) lands and pulses, then the overlay fades to the app. ~2s.
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
import { StyleSheet, View } from 'react-native';
import Animated, {
  Easing,
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';

import { useTheme } from '@/lib/theme';

// The Lottie composition. 1024x1024, transparent, ~2s (op120 @ 60fps).
const LAUNCH = require('../assets/launch.json');

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
        <LottieView
          source={LAUNCH}
          autoPlay
          loop={false}
          resizeMode="contain"
          onAnimationFinish={fadeOut}
          style={styles.lottie}
        />
      </View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  fill: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, zIndex: 9999, elevation: 9999 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  lottie: { width: 320, height: 320 },
});
