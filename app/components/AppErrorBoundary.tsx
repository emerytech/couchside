/**
 * App-wide crash screen (Expo Router's `ErrorBoundary` export from the root
 * layout). Replaces expo-router's raw default ("Something went wrong" + a stack
 * trace) with a branded, recoverable screen.
 *
 * WHY (client crash, 2026-09-17). A Windows box could report `caps.gamepad: true`
 * with no working ViGEmBus driver; the app opened the pad, the connect failed,
 * and a render loop threw "Maximum update depth exceeded" straight into
 * expo-router's default boundary — a dead, alarming screen that PERSISTED across
 * restarts (the same box reloaded and re-crashed). The root cause is fixed in the
 * agent (gamepad cap now reflects a real bus connect), but the app must also fail
 * SOFT: a crash should land on a screen the user can read and retry from, not a
 * raw stack trace they can never leave.
 *
 * AND GET THE DETAILS OUT (2026-09-26). Four lines of `error.message` were all a
 * user could report — no stack, no version, nothing to copy. "Copy details" puts
 * message + stack + app version/build + device on the clipboard (expo-clipboard,
 * already in the app — no new native dependency), and the stack is one tap away
 * under "Show details" rather than dumped on the screen. The error is also
 * recorded in the local error log (Setup › Account), so it survives "Try again".
 * Nothing is sent anywhere; the clipboard is the user's.
 *
 * Deliberately self-contained: this renders precisely when the tree crashed, so
 * it must NOT depend on the app's providers (theme, settings, gestures) — any of
 * which may be what threw. Colors come from `useColorScheme` (a stable RN API),
 * not the app theme context. lib/crashLog is a module-level store, not a
 * provider, and every call into it is guarded.
 */
import * as Clipboard from 'expo-clipboard';
import { useEffect, useRef, useState } from 'react';
import { Platform, Pressable, ScrollView, StyleSheet, Text, View, useColorScheme } from 'react-native';

import { errorReport, recordScreenError } from '@/lib/crashLog';

type Props = { error: Error; retry: () => Promise<void> };

type CopyState = 'idle' | 'copied' | 'failed';

export function ErrorBoundary({ error, retry }: Props) {
  const dark = useColorScheme() !== 'light';
  const c = dark ? DARK : LIGHT;
  const [showStack, setShowStack] = useState(false);
  const [copy, setCopy] = useState<CopyState>('idle');
  const resetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Into the local log once per error (recordScreenError dedupes by object).
  useEffect(() => {
    recordScreenError(error);
  }, [error]);
  useEffect(
    () => () => {
      if (resetTimer.current) clearTimeout(resetTimer.current);
    },
    [],
  );

  const onCopy = async () => {
    let ok = false;
    try {
      // Resolves true on native; on web, false when the browser refused.
      ok = await Clipboard.setStringAsync(errorReport(error));
    } catch {
      ok = false;
    }
    setCopy(ok ? 'copied' : 'failed');
    if (resetTimer.current) clearTimeout(resetTimer.current);
    resetTimer.current = setTimeout(() => setCopy('idle'), 2500);
  };

  const stack = typeof error?.stack === 'string' ? error.stack : '';

  return (
    <View style={[styles.screen, { backgroundColor: c.bg }]}>
      <View style={styles.inner}>
        <Text style={[styles.emoji, { color: c.text }]}>🛋️</Text>
        <Text style={[styles.title, { color: c.text }]}>Couchside hit a snag</Text>
        <Text style={[styles.body, { color: c.dim }]}>
          Something on this screen stopped responding. Your box and your pairing are fine —
          this is just the app. Tap Try again, and if it keeps happening, make sure the
          Couchside service on your box is up to date.
        </Text>
        {!!error?.message && (
          <View style={[styles.detail, { backgroundColor: c.card, borderColor: c.border }]}>
            <Text style={[styles.detailText, { color: c.dim }]} numberOfLines={4}>
              {error.message}
            </Text>
            {showStack && !!stack && (
              <ScrollView style={styles.stackScroll} nestedScrollEnabled>
                <Text style={[styles.stackText, { color: c.dim }]} selectable>
                  {stack}
                </Text>
              </ScrollView>
            )}
          </View>
        )}
        <Pressable
          onPress={() => {
            void retry();
          }}
          style={({ pressed }) => [
            styles.btn,
            { backgroundColor: c.accent, opacity: pressed ? 0.85 : 1 },
          ]}>
          <Text style={[styles.btnText, { color: c.onAccent }]}>Try again</Text>
        </Pressable>
        <View style={styles.secondaryRow}>
          <Pressable
            onPress={() => {
              void onCopy();
            }}
            hitSlop={8}
            accessibilityRole="button"
            style={({ pressed }) => [styles.secondary, { opacity: pressed ? 0.6 : 1 }]}>
            <Text style={[styles.secondaryText, { color: copy === 'failed' ? c.warn : c.accent }]}>
              {copy === 'copied' ? 'Copied ✓' : copy === 'failed' ? 'Couldn’t copy' : 'Copy details'}
            </Text>
          </Pressable>
          {!!stack && (
            <Pressable
              onPress={() => setShowStack((v) => !v)}
              hitSlop={8}
              accessibilityRole="button"
              style={({ pressed }) => [styles.secondary, { opacity: pressed ? 0.6 : 1 }]}>
              <Text style={[styles.secondaryText, { color: c.dim }]}>
                {showStack ? 'Hide details' : 'Show details'}
              </Text>
            </Pressable>
          )}
        </View>
        <Text style={[styles.foot, { color: c.dim }]}>
          Copied details stay on your phone until you paste them — Couchside never sends them.
        </Text>
      </View>
    </View>
  );
}

const LIGHT = {
  bg: '#f6f7f9',
  text: '#11151a',
  dim: '#5b6470',
  card: '#ffffff',
  border: '#e2e6ea',
  accent: '#3b82f6',
  onAccent: '#ffffff',
  warn: '#b45309',
};
const DARK = {
  bg: '#0d1117',
  text: '#f0f3f6',
  dim: '#9aa4b0',
  card: '#161b22',
  border: '#262c34',
  accent: '#4b8ef7',
  onAccent: '#ffffff',
  warn: '#fbbf24',
};

const MONO = Platform.select({ ios: 'Menlo', android: 'monospace', default: 'monospace' });

const styles = StyleSheet.create({
  screen: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 28 },
  inner: { width: '100%', maxWidth: 420, alignItems: 'center' },
  emoji: { fontSize: 44, marginBottom: 12 },
  title: { fontSize: 22, fontWeight: '800', marginBottom: 10, textAlign: 'center' },
  body: { fontSize: 15, lineHeight: 21, textAlign: 'center', marginBottom: 18 },
  detail: {
    alignSelf: 'stretch',
    borderWidth: 1,
    borderRadius: 10,
    padding: 12,
    marginBottom: 20,
  },
  detailText: { fontSize: 12, fontFamily: MONO, lineHeight: 17 },
  stackScroll: { maxHeight: 180, marginTop: 8 },
  stackText: { fontSize: 10, fontFamily: MONO, lineHeight: 14 },
  btn: { paddingVertical: 12, paddingHorizontal: 28, borderRadius: 999 },
  btnText: { fontSize: 16, fontWeight: '800' },
  secondaryRow: { flexDirection: 'row', gap: 22, marginTop: 16 },
  secondary: { paddingVertical: 4 },
  secondaryText: { fontSize: 14, fontWeight: '700' },
  foot: { fontSize: 11, lineHeight: 15, textAlign: 'center', marginTop: 14 },
});
