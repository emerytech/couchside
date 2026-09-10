import { Pressable, StyleSheet, Text, View } from 'react-native';

import { hapticHeavy, hapticLight } from '@/lib/haptics';
import { mono, useTheme, useThemedStyles, type Palette } from '@/lib/theme';
import type { Armed } from '@/hooks/useArmedAction';

type Props = {
  /** The armed action, or null when nothing is counting down. */
  armed: Armed | null;
  /** The box the action targets — its NAME, so the wrong-box mistake this window
   *  exists to catch is easy to spot (a raw host:port is not). */
  boxName: string;
  onCancel: () => void;
  onFireNow: () => void;
};

/**
 * The red countdown bar for an armed destructive action: a live "in Ns", the box
 * it targets, and two ways out — CANCEL (abort) and DO IT NOW (skip the wait and
 * fire immediately). CANCEL is the prominent, filled control because it is the
 * safe default; DO IT NOW is a ghost button, the deliberate escape hatch.
 *
 * accessibilityRole="alert" so a screen reader announces that a reboot is seconds
 * away rather than leaving a blind user to the silent timer.
 */
export function ArmedActionBar({ armed, boxName, onCancel, onFireNow }: Props) {
  const styles = useThemedStyles(makeStyles);
  useTheme(); // re-render on theme change (styles are theme-derived)
  if (!armed) return null;
  return (
    <View style={styles.panel} accessibilityRole="alert">
      <View style={styles.text}>
        <Text style={styles.title} numberOfLines={1}>
          {armed.label} in {armed.secs}s
        </Text>
        <Text style={styles.sub} numberOfLines={1}>
          on {boxName}
        </Text>
      </View>
      <Pressable
        onPress={() => {
          hapticLight();
          onCancel();
        }}
        hitSlop={8}
        accessibilityRole="button"
        accessibilityLabel={`Cancel ${armed.label}`}
        style={({ pressed }) => [styles.cancel, pressed && styles.pressed]}>
        <Text style={styles.cancelText}>CANCEL</Text>
      </Pressable>
      <Pressable
        onPress={() => {
          hapticHeavy();
          onFireNow();
        }}
        hitSlop={8}
        accessibilityRole="button"
        accessibilityLabel={`Run ${armed.label} now`}
        style={({ pressed }) => [styles.now, pressed && styles.pressed]}>
        <Text style={styles.nowText}>DO IT NOW</Text>
      </Pressable>
    </View>
  );
}

const makeStyles = (t: Palette) =>
  StyleSheet.create({
    panel: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 10,
      backgroundColor: t.redDeep,
      borderColor: t.red,
      borderWidth: 1,
      borderRadius: 12,
      padding: 12,
      marginBottom: 8,
    },
    text: { flex: 1 },
    title: { color: t.onRedDeep, fontSize: 15, fontWeight: '800' },
    sub: { color: t.onRedDeep, opacity: 0.8, fontSize: 12, marginTop: 2, fontFamily: mono },
    // Filled: the safe default gets the visual weight.
    cancel: {
      backgroundColor: t.red,
      paddingVertical: 10,
      paddingHorizontal: 16,
      borderRadius: 8,
    },
    cancelText: { color: t.onRed, fontWeight: '800', fontSize: 13, letterSpacing: 1 },
    // Ghost: the escape hatch is available but not the eye-catcher.
    now: {
      borderColor: t.onRedDeep,
      borderWidth: 1,
      paddingVertical: 10,
      paddingHorizontal: 14,
      borderRadius: 8,
    },
    nowText: { color: t.onRedDeep, fontWeight: '800', fontSize: 13, letterSpacing: 1 },
    pressed: { opacity: 0.7 },
  });
