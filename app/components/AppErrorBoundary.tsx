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
 * Deliberately self-contained: this renders precisely when the tree crashed, so
 * it must NOT depend on the app's providers (theme, settings, gestures) — any of
 * which may be what threw. Colors come from `useColorScheme` (a stable RN API),
 * not the app theme context.
 */
import { useColorScheme } from 'react-native';
import { Pressable, StyleSheet, Text, View } from 'react-native';

type Props = { error: Error; retry: () => Promise<void> };

export function ErrorBoundary({ error, retry }: Props) {
  const dark = useColorScheme() !== 'light';
  const c = dark ? DARK : LIGHT;
  return (
    <View style={[styles.screen, { backgroundColor: c.bg }]}>
      <View style={styles.inner}>
        <Text style={[styles.emoji]}>🛋️</Text>
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
};
const DARK = {
  bg: '#0d1117',
  text: '#f0f3f6',
  dim: '#9aa4b0',
  card: '#161b22',
  border: '#262c34',
  accent: '#4b8ef7',
  onAccent: '#ffffff',
};

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
  detailText: { fontSize: 12, fontFamily: 'Menlo', lineHeight: 17 },
  btn: { paddingVertical: 12, paddingHorizontal: 28, borderRadius: 999 },
  btnText: { fontSize: 16, fontWeight: '800' },
});
