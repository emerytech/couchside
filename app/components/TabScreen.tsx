/**
 * Shared per-tab frame: the persistent BoxSwitcher header (device picker) on
 * top, tab content below. The header owns the top safe-area inset, so tab
 * bodies no longer add insets.top themselves. Beta builds also get a small
 * corner BETA badge so testers always know they are on the unlocked beta.
 */
import React, { useContext, useEffect, useMemo, useRef, useState } from 'react';
import { router, useSegments } from 'expo-router';
import { TabSwipeContext } from './TabSwipeContext';
import { swipeDestination, blockTabSwipe, resetTabSwipe, isTabSwipeBlocked } from '@/lib/tabSwipe';
import { hapticSelection } from '@/lib/haptics';
import { useIsFocused } from 'expo-router';
import { MotionActivityContext, useReducedMotion } from '@/lib/skin/motion';
import { Animated, AppState, PanResponder, TextInput, StyleSheet, Text, View } from 'react-native';

import { BoxSwitcher } from '@/components/BoxSwitcher';
import { TrialNudge } from '@/components/TrialNudge';
import { IS_BETA_BUILD } from '@/lib/entitlement';
import { useImmersive } from '@/lib/immersive';
import { mono, useThemedStyles } from '@/lib/theme';
import type { Palette } from '@/lib/theme';

export function TabScreen({ children }: { children: React.ReactNode }) {
  const styles = useThemedStyles(makeStyles);
  const focused = useIsFocused();
  const reducedMotion = useReducedMotion();
  const opacity = useRef(new Animated.Value(1)).current;
  const wasFocused = useRef(false);
  useEffect(() => {
    const entering = focused && !wasFocused.current;
    wasFocused.current = focused;
    opacity.stopAnimation();
    // A preference change settles the current screen without remounting it.
    // Blur/cancellation also settles it, so a quick return cannot reveal a
    // scene stranded at opacity zero.
    opacity.setValue(1);
    if (entering && !reducedMotion) {
      opacity.setValue(0);
      Animated.timing(opacity, { toValue: 1, duration: 140, useNativeDriver: true }).start();
    }
    return () => { opacity.stopAnimation(); opacity.setValue(1); };
  }, [focused, reducedMotion, opacity]);
  const [foreground, setForeground] = useState(AppState.currentState === 'active');
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => setForeground(state === 'active'));
    return () => subscription.remove();
  }, []);
  // Landscape gamepad owns the whole screen: no device picker, no trial nudge,
  // no BETA badge. See lib/immersive.ts for why this is derived state rather
  // than an imperative setOptions call with cleanup to forget.
  const immersive = useImmersive();
  const swipe = useContext(TabSwipeContext);
  const segments = useSegments();
  const leaf = segments[segments.length - 1];
  const current = leaf === '(tabs)' ? 'index' : leaf;
  const live = useRef({ swipe, current, focused, immersive });
  live.current = { swipe, current, focused, immersive };
  const pan = useMemo(() => PanResponder.create({
    onStartShouldSetPanResponderCapture: () => { resetTabSwipe(); return false; },
    onMoveShouldSetPanResponderCapture: (_event, gesture) => {
      const p = live.current;
      if (Math.abs(gesture.dy) > 24 || gesture.numberActiveTouches !== 1) blockTabSwipe();
      return p.swipe.enabled && p.focused && !p.immersive && !isTabSwipeBlocked() &&
        !TextInput.State.currentlyFocusedInput() &&
        swipeDestination(p.swipe.order, p.current, gesture.dx, gesture.dy, gesture.numberActiveTouches) != null;
    },
    onPanResponderMove: (_event, gesture) => {
      if (Math.abs(gesture.dy) > 24 || gesture.numberActiveTouches !== 1) blockTabSwipe();
    },
    onPanResponderRelease: (_event, gesture) => {
      const p = live.current;
      if (!p.swipe.enabled || !p.focused || isTabSwipeBlocked()) return;
      const destination = swipeDestination(p.swipe.order, p.current, gesture.dx, gesture.dy);
      if (destination) {
        hapticSelection();
        router.navigate((destination === 'index' ? '/(tabs)' : `/(tabs)/${destination}`) as Parameters<typeof router.navigate>[0]);
      }
    },
    onPanResponderTerminationRequest: () => true,
  }), []);

  return (
    <MotionActivityContext.Provider value={focused && foreground}>
    <View style={styles.root}>
      {!immersive && <BoxSwitcher />}
      {/* Near the end of the trial only, and never on Setup (which already
          carries the permanent unlock row). Self-hides otherwise. */}
      {!immersive && <TrialNudge />}
      <Animated.View style={[styles.body, { opacity }]} {...pan.panHandlers}>{children}</Animated.View>
      {IS_BETA_BUILD && !immersive && (
        <View pointerEvents="none" style={styles.betaBadge}>
          <Text style={styles.betaText}>BETA</Text>
        </View>
      )}
    </View>
    </MotionActivityContext.Provider>
  );
}

const makeStyles = (t: Palette) => StyleSheet.create({
  root: { flex: 1, backgroundColor: t.bg },
  body: { flex: 1 },
  // Pinned above the tab bar, non-interactive so it never eats a touch.
  betaBadge: {
    position: 'absolute',
    bottom: 10,
    right: 10,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6,
    backgroundColor: 'rgba(0,0,0,0.55)',
    borderWidth: 1,
    borderColor: t.amber,
    opacity: 0.9,
  },
  betaText: {
    color: t.amber,
    fontSize: 10,
    fontWeight: '800',
    fontFamily: mono,
    letterSpacing: 1.5,
  },
});
