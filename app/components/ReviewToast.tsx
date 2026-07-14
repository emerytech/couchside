import React, { useCallback, useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { hapticLight } from '@/lib/haptics';
import { openWriteReview, subscribeReviewInvite } from '@/lib/review';
import { mono, theme } from '@/lib/theme';

const TOAST_MS = 8000;

/**
 * The fallback review invite: a dismissible toast that links OUT to the App
 * Store's write-review page.
 *
 * This exists because the native review sheet is not always available (the OS
 * declines, TestFlight, web, a build without the module). ReviewPrompt decides
 * — native sheet first, this toast only if the sheet cannot run — and both
 * share one asked-flag, so this never doubles up on the OS prompt.
 *
 * It links out rather than calling requestReview() because Apple does not allow
 * the native sheet to be summoned by a tap. Tapping "Rate" opens the store; the
 * user writes the review there.
 *
 * Longer-lived than the other toasts (8s): this one asks for something, so it
 * has to be readable and reachable, not just glanceable.
 */
export function ReviewToast() {
  const insets = useSafeAreaInsets();
  const [shown, setShown] = useState(false);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const unsub = subscribeReviewInvite(() => {
      setShown(true);
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => setShown(false), TOAST_MS);
    });
    return () => {
      unsub();
      if (timer) clearTimeout(timer);
    };
  }, []);

  const onRate = useCallback(() => {
    hapticLight();
    setShown(false);
    void openWriteReview();
  }, []);

  const onDismiss = useCallback(() => {
    hapticLight();
    setShown(false);
  }, []);

  if (!shown) return null;

  return (
    <View style={[styles.wrap, { bottom: insets.bottom + 76 }]}>
      <View style={styles.toast}>
        <Text style={styles.title}>Enjoying Couchside?</Text>
        <Text style={styles.sub}>A quick review helps other people find it.</Text>
        <View style={styles.actions}>
          <Pressable
            onPress={onDismiss}
            style={({ pressed }) => [styles.btn, pressed && styles.pressed]}>
            <Text style={styles.btnText}>NOT NOW</Text>
          </Pressable>
          <Pressable
            onPress={onRate}
            style={({ pressed }) => [styles.btn, styles.btnPrimary, pressed && styles.pressed]}>
            <Text style={styles.btnPrimaryText}>RATE</Text>
          </Pressable>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { position: 'absolute', left: 0, right: 0, alignItems: 'center' },
  toast: {
    maxWidth: '92%',
    backgroundColor: theme.card,
    borderColor: theme.blue,
    borderWidth: 1,
    borderRadius: 12,
    paddingVertical: 12,
    paddingHorizontal: 16,
  },
  title: {
    color: theme.text,
    fontFamily: mono,
    fontSize: 13,
    fontWeight: '800',
    textAlign: 'center',
  },
  sub: { color: theme.textDim, fontSize: 11, marginTop: 3, textAlign: 'center' },
  actions: { flexDirection: 'row', gap: 10, marginTop: 12 },
  btn: {
    flex: 1,
    paddingVertical: 9,
    borderRadius: 8,
    alignItems: 'center',
    backgroundColor: theme.inset,
    borderWidth: 1,
    borderColor: theme.cardBorder,
  },
  btnText: { color: theme.textDim, fontSize: 12, fontWeight: '800', letterSpacing: 1 },
  btnPrimary: { backgroundColor: theme.blue, borderColor: theme.blue },
  btnPrimaryText: { color: '#0b1220', fontSize: 12, fontWeight: '800', letterSpacing: 1 },
  pressed: { opacity: 0.7 },
});
