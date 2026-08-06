/**
 * Streak: a quiet badge every day, a celebration only at milestones.
 *
 * WHY NOT A DAILY POPUP. A congratulation every launch is wallpaper by day four,
 * and this app's promise is that it works when the TV is black — training people
 * to dismiss something on sight is the last thing it should do. So the number is
 * always THERE (a pill, no interruption) and only 3/7/14/30/60/100/365 get a
 * card, once each.
 *
 * NOT A MODAL, deliberately: it renders inline above the console content and
 * never blocks a control. Someone opening the app to fix a black TV can ignore
 * it completely and still hit the button underneath.
 *
 * The badge borrows the pill treatment from the app the owner liked — accent
 * text on a tinted, fully-rounded chip sitting inline with the value it
 * describes.
 */
import Ionicons from '@expo/vector-icons/Ionicons';
import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { hapticLight } from '@/lib/haptics';
import { streakLabel } from '@/lib/streak';
import { mono, useTheme, useThemedStyles, type Palette } from '@/lib/theme';

/** The always-on, non-interrupting form. Renders nothing below 2 days: "1 day
 *  in a row" is not a streak, it is a launch. */
export function StreakBadge({ days }: { days: number }) {
  const styles = useThemedStyles(makeStyles);
  const t = useTheme();
  if (days < 2) return null;
  return (
    <View style={styles.pill}>
      <Ionicons name="flame" size={11} color={t.amber} />
      <Text style={styles.pillText}>{streakLabel(days)}</Text>
    </View>
  );
}

/** The milestone celebration. Dismiss is the only action — there is nothing to
 *  buy, unlock or share here. */
export function StreakCelebration({
  milestone,
  best,
  onDismiss,
}: {
  milestone: number;
  best: number;
  onDismiss: () => void;
}) {
  const t = useTheme();
  const styles = useThemedStyles(makeStyles);
  const isBest = milestone >= best;
  return (
    <View style={styles.card}>
      <View style={styles.row}>
        <View style={styles.flame}>
          <Ionicons name="flame" size={18} color={t.amber} />
        </View>
        <View style={styles.body}>
          <Text style={styles.title}>{milestone} days in a row</Text>
          <Text style={styles.sub}>
            {isBest ? 'Your longest run yet.' : `Your best is ${best} days.`}
          </Text>
        </View>
        <Pressable
          onPress={() => {
            hapticLight();
            onDismiss();
          }}
          hitSlop={10}
          accessibilityRole="button"
          accessibilityLabel="Dismiss streak celebration"
          style={({ pressed }) => [styles.close, pressed && styles.pressed]}>
          <Ionicons name="close" size={16} color={t.textDim} />
        </Pressable>
      </View>
    </View>
  );
}

const makeStyles = (t: Palette) =>
  StyleSheet.create({
    pill: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 4,
      paddingHorizontal: 8,
      paddingVertical: 3,
      borderRadius: 999,
      backgroundColor: t.amber + '22',
    },
    pillText: { color: t.amber, fontSize: 11, fontWeight: '700', fontFamily: mono },
    card: {
      backgroundColor: t.card,
      borderColor: t.amber + '55',
      borderWidth: 1,
      borderRadius: 14,
      padding: 12,
      marginBottom: 12,
    },
    row: { flexDirection: 'row', alignItems: 'center', gap: 10 },
    flame: {
      width: 34,
      height: 34,
      borderRadius: 17,
      backgroundColor: t.amber + '1e',
      alignItems: 'center',
      justifyContent: 'center',
    },
    body: { flex: 1 },
    title: { color: t.text, fontSize: 15, fontWeight: '800', fontFamily: mono },
    sub: { color: t.textDim, fontSize: 12, marginTop: 2 },
    close: { padding: 4 },
    pressed: { opacity: 0.6 },
  });
