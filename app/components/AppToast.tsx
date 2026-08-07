/**
 * The app-wide transient message, mounted once at the root.
 *
 * Exists because the message most worth showing — "your download finished" — is
 * one you want while you are NOT on the Launch tab, and that tab's local toast
 * could only speak while it was mounted.
 *
 * Sits ABOVE the tab bar rather than over the middle of the screen: it is
 * information, not a decision, and it must never land on top of the control
 * someone is reaching for.
 */
import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useToast } from '@/lib/toast';
import { mono, useThemedStyles, type Palette } from '@/lib/theme';

export function AppToast() {
  const styles = useThemedStyles(makeStyles);
  const insets = useSafeAreaInsets();
  const msg = useToast();
  if (!msg) return null;

  return (
    // pointerEvents none throughout: a toast that swallows a tap is worse than
    // one you missed.
    <View style={[styles.wrap, { bottom: insets.bottom + 64 }]} pointerEvents="none">
      <View style={styles.toast}>
        <Text style={styles.text} numberOfLines={2}>
          {msg}
        </Text>
      </View>
    </View>
  );
}

const makeStyles = (t: Palette) =>
  StyleSheet.create({
    wrap: { position: 'absolute', left: 0, right: 0, alignItems: 'center', paddingHorizontal: 20 },
    toast: {
      maxWidth: 460,
      borderRadius: 12,
      paddingVertical: 10,
      paddingHorizontal: 14,
      backgroundColor: t.card,
      borderWidth: 1,
      borderColor: t.cardBorder,
    },
    text: { color: t.text, fontSize: 13, fontFamily: mono, textAlign: 'center' },
  });
