/**
 * Spotlight tour, shown once after the first box is paired.
 *
 * Dims the screen, cuts a hole over one tab, and says what is behind it. The
 * geometry lives in lib/tour.ts and is tested there — a hole over the wrong tab
 * points confidently at the wrong thing, which is worse than no tour at all.
 *
 * NO MASKING LIBRARY: React Native has no cross-platform cutout, so the dim is
 * four Views around the target. No dependency, no SVG, and it behaves the same
 * on both platforms.
 *
 * THE SPOTLIT TAB STAYS TAPPABLE. The dim panels swallow touches so a stray tap
 * cannot fire something behind the overlay, but the hole itself is left alone —
 * a tour that says "your games live here" and then blocks the tab is a lecture,
 * not a tour.
 */
import Ionicons from '@expo/vector-icons/Ionicons';
import React from 'react';
import { Pressable, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { hapticLight } from '@/lib/haptics';
import { currentStep, dimRects, spotlightRect, stepLabel, type TourState } from '@/lib/tour';
import { mono, useTheme, useThemedStyles, type Palette } from '@/lib/theme';

/** Tab-bar height without the safe-area inset; matches the router's default. */
const TAB_BAR_H = 49;

export function FeatureTour({
  state,
  tabOrder,
  onNext,
  onSkip,
}: {
  state: TourState;
  /** Route names in the order the tab bar renders them — the tour asks this
   *  rather than assuming, because caps and remote-only mode change both the
   *  count and the positions. */
  tabOrder: string[];
  onNext: () => void;
  onSkip: () => void;
}) {
  const t = useTheme();
  const styles = useThemedStyles(makeStyles);
  const { width, height } = useWindowDimensions();
  const insets = useSafeAreaInsets();

  const step = currentStep(state);
  if (!step) return null;

  const idx = tabOrder.indexOf(step.tab);
  // A tab this build does not show (remote-only hides the box tabs) has nothing
  // to point at — skip rather than spotlight a guess.
  if (idx < 0) return null;

  // The bar is the tab row PLUS the home-indicator inset, but the spotlight
  // should cover only the tab row — see spotlightRect.
  const hole = spotlightRect(width, height, TAB_BAR_H, tabOrder.length, idx, insets.bottom);
  const panels = dimRects(width, height, hole);
  const cardBottom = height - hole.y + 14;

  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="box-none">
      {panels.map((r, i) => (
        <Pressable
          key={i}
          // Swallow taps on the dimmed area, but do not advance: an accidental
          // tap while reading should not skip the step.
          onPress={() => {}}
          style={[styles.dim, { left: r.x, top: r.y, width: r.width, height: r.height }]}
        />
      ))}

      {/* Ring around the live tab. pointerEvents none so the tab underneath
          stays tappable — see the header note. */}
      <View
        pointerEvents="none"
        style={[
          styles.ring,
          {
            // Clamped so the FIRST and LAST tab's ring stays fully on screen —
            // at x=0 a negative inset clipped it against the bezel.
            left: Math.max(3, hole.x + 4),
            top: hole.y + 2,
            width: Math.min(hole.width - 8, width - Math.max(3, hole.x + 4) - 3),
            height: Math.max(0, hole.height - 4),
          },
        ]}
      />

      <View style={[styles.card, { bottom: cardBottom }]} pointerEvents="box-none">
        <Text style={styles.count}>{stepLabel(state)}</Text>
        <Text style={styles.title}>{step.title}</Text>
        <Text style={styles.body}>{step.body}</Text>
        {/* Skip sits BESIDE Next, not as small print in a corner: a tour with
            twelve steps needs an obvious way out, or it is a hostage situation. */}
        <View style={styles.actions}>
          <Pressable
            onPress={() => {
              hapticLight();
              onSkip();
            }}
            accessibilityRole="button"
            accessibilityLabel="Skip the tour"
            style={({ pressed }) => [styles.skipBtn, pressed && styles.pressed]}>
            <Text style={styles.skipText}>SKIP TOUR</Text>
          </Pressable>
          <Pressable
            onPress={() => {
              hapticLight();
              onNext();
            }}
            accessibilityRole="button"
            style={({ pressed }) => [styles.next, pressed && styles.pressed]}>
            <Text style={styles.nextText}>GOT IT</Text>
            <Ionicons name="arrow-forward" size={14} color="#04140c" />
          </Pressable>
        </View>
      </View>
    </View>
  );
}

const makeStyles = (t: Palette) =>
  StyleSheet.create({
    // 55%, not 85%. The tour describes the screen behind it — dimming it into
    // an unreadable slab defeats the point of pointing at it.
    dim: { position: 'absolute', backgroundColor: '#0000008c' },
    ring: {
      position: 'absolute',
      borderRadius: 12,
      borderWidth: 2,
      borderColor: t.green,
    },
    card: {
      position: 'absolute',
      left: 16,
      right: 16,
      backgroundColor: t.card,
      borderRadius: 16,
      borderWidth: 1,
      borderColor: t.cardBorder,
      padding: 16,
      gap: 8,
    },
    count: { color: t.textDim, fontSize: 11, letterSpacing: 1, fontFamily: mono },
    actions: { flexDirection: 'row', gap: 10, marginTop: 4 },
    skipBtn: {
      flex: 1,
      alignItems: 'center',
      justifyContent: 'center',
      borderRadius: 11,
      paddingVertical: 12,
      backgroundColor: t.inset,
      borderWidth: 1,
      borderColor: t.cardBorder,
    },
    skipText: { color: t.textDim, fontSize: 13, fontWeight: '800', letterSpacing: 1, fontFamily: mono },
    title: { color: t.text, fontSize: 17, fontWeight: '800' },
    body: { color: t.textDim, fontSize: 13, lineHeight: 19 },
    next: {
      flex: 1,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 7,
      backgroundColor: t.green,
      borderRadius: 11,
      paddingVertical: 12,
    },
    nextText: { color: '#04140c', fontSize: 13, fontWeight: '900', letterSpacing: 1, fontFamily: mono },
    pressed: { opacity: 0.7 },
  });
