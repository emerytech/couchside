/**
 * "Is the Couchside app itself up to date?" — a compact row in Setup > Account.
 *
 * This is the ONE deliberate outbound call the app makes: an anonymous GET of a
 * static file on couchside.tv (no box, no token, no user data — the request
 * reveals nothing beyond "someone opened the app", same as visiting the site).
 * It is distinct from the AGENT update check, which runs on the BOX precisely so
 * the app never touches the internet for BOX data; there is no box-side way to
 * know the phone's own store version, so this one small check is direct.
 *
 * Compares the running build against the latest LIVE store version in the
 * manifest and, if older, offers a store link. Fails silent (offline / manifest
 * missing) — a missing update check must never nag or error.
 *
 * TRAP (see [[expo-sdk57-api-traps]]): Constants.nativeBuildVersion typechecks
 * but does not exist. Use expo-application's nativeApplicationVersion (the
 * marketing string, e.g. "2.9.17") and nativeBuildVersion (iOS build / Android
 * versionCode).
 */
import Ionicons from '@expo/vector-icons/Ionicons';
import * as Application from 'expo-application';
import { useCallback, useEffect, useState } from 'react';
import { Linking, Platform, Pressable, StyleSheet, Text, View } from 'react-native';

import { decideAppUpdate, Manifest, Result } from '@/lib/appUpdate';
import { hapticLight } from '@/lib/haptics';
import { mono, useTheme, useThemedStyles } from '@/lib/theme';
import type { Palette } from '@/lib/theme';

const MANIFEST_URL = 'https://couchside.tv/app-version.json';

async function checkAppUpdate(): Promise<Result> {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 6000);
    const res = await fetch(MANIFEST_URL, { signal: ctrl.signal });
    clearTimeout(timer);
    if (!res.ok) return { state: 'unknown' };
    const m: Manifest = await res.json();
    return decideAppUpdate(
      m,
      Platform.OS,
      Application.nativeApplicationVersion, // "2.9.17"
      Application.nativeBuildVersion, // iOS build / Android versionCode
    );
  } catch {
    return { state: 'unknown' };
  }
}

export function AppUpdateRow() {
  const t = useTheme();
  const styles = useThemedStyles(makeStyles);
  const [result, setResult] = useState<Result>({ state: 'checking' });

  const check = useCallback(async () => {
    setResult({ state: 'checking' });
    setResult(await checkAppUpdate());
  }, []);

  useEffect(() => {
    void check();
  }, [check]);

  // Web build (the dev harness) has no store version; keep it quiet there.
  if (Platform.OS === 'web') return null;

  const open = (url: string) => {
    hapticLight();
    void Linking.openURL(url).catch(() => {});
  };

  return (
    <View style={styles.row}>
      <Text style={styles.status} numberOfLines={1}>
        {result.state === 'checking'
          ? 'Checking for an app update…'
          : result.state === 'update'
            ? `App update available${result.latest ? ` — ${result.latest}` : ''}`
            : result.state === 'current'
              ? 'Couchside app is up to date'
              : 'Couldn’t check for an app update'}
      </Text>
      {result.state === 'update' ? (
        <Pressable onPress={() => open(result.url)} hitSlop={8} style={styles.btn}>
          <Ionicons name="open-outline" size={13} color={t.blue} />
          <Text style={styles.btnText}>{Platform.OS === 'ios' ? 'App Store' : 'Play Store'}</Text>
        </Pressable>
      ) : (
        <Pressable onPress={() => void check()} hitSlop={8} style={styles.btn}>
          <Ionicons name="refresh" size={13} color={t.blue} />
          <Text style={styles.btnText}>Check</Text>
        </Pressable>
      )}
    </View>
  );
}

const makeStyles = (t: Palette) => StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 10,
    paddingVertical: 10,
    paddingHorizontal: 12,
    marginBottom: 14,
    borderRadius: 12,
    backgroundColor: t.card,
    borderColor: t.cardBorder,
    borderWidth: 1,
  },
  status: { color: t.textDim, fontSize: 13, flex: 1 },
  btn: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  btnText: { color: t.blue, fontSize: 13, fontWeight: '700', fontFamily: mono },
});
