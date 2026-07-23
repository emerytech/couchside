/**
 * "Is the Couchside app itself up to date?" — a compact, MANUAL check in
 * Setup > Account (never auto-runs; the user taps it, for full control).
 *
 * WHAT IT REACHES OUT TO — and nothing else:
 *   - iOS: Apple's own App Store lookup (itunes.apple.com/lookup) for this
 *     bundle's current published version. It talks to the App Store DIRECTLY.
 *   - Android: couchside.tv/app-version.json, a static file mirroring the Play
 *     listing's version — because Google Play has no public version API.
 * Either way it sends NOTHING about you, your box, or your usage — it only asks
 * "what version is live?" and compares. Distinct from the AGENT update check,
 * which runs on the box so the app never touches the internet for box data.
 *
 * Fails silent (offline / unreachable) — a missing check must never nag or
 * error. TRAP (see [[expo-sdk57-api-traps]]): Constants.nativeBuildVersion
 * typechecks but does not exist; use expo-application.
 */
import Ionicons from '@expo/vector-icons/Ionicons';
import * as Application from 'expo-application';
import { useCallback, useState } from 'react';
import { Linking, Platform, Pressable, StyleSheet, Text, View } from 'react-native';

import { decideAppUpdate, Manifest, parseItunesLookup, Result } from '@/lib/appUpdate';
import { hapticLight } from '@/lib/haptics';
import { mono, useTheme, useThemedStyles } from '@/lib/theme';
import type { Palette } from '@/lib/theme';

const ANDROID_MANIFEST_URL = 'https://couchside.tv/app-version.json';
const IOS_BUNDLE = Application.applicationId ?? 'com.ets3d.rescueremote';
const IOS_LOOKUP_URL = `https://itunes.apple.com/lookup?bundleId=${IOS_BUNDLE}`;

async function fetchJson(url: string): Promise<unknown | null> {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 6000);
    const res = await fetch(url, { signal: ctrl.signal });
    clearTimeout(timer);
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

/** Normalize each store's response into the shape decideAppUpdate consumes, so
 *  the tested pure comparison is identical for both platforms. */
async function loadManifest(): Promise<Manifest | null> {
  if (Platform.OS === 'ios') {
    const ios = parseItunesLookup(await fetchJson(IOS_LOOKUP_URL));
    return ios ? { ios } : null;
  }
  if (Platform.OS === 'android') {
    return (await fetchJson(ANDROID_MANIFEST_URL)) as Manifest | null;
  }
  return null;
}

async function checkAppUpdate(): Promise<Result> {
  return decideAppUpdate(
    await loadManifest(),
    Platform.OS,
    Application.nativeApplicationVersion, // "2.9.21"
    Application.nativeBuildVersion, // iOS build / Android versionCode
  );
}

export function AppUpdateRow() {
  const t = useTheme();
  const styles = useThemedStyles(makeStyles);
  // MANUAL only — no auto-check on mount. Starts idle; the user taps Check.
  const [result, setResult] = useState<Result>({ state: 'idle' });

  const check = useCallback(async () => {
    setResult({ state: 'checking' });
    setResult(await checkAppUpdate());
  }, []);

  // Web build (the dev harness) has no store version; keep it quiet there.
  if (Platform.OS === 'web') return null;

  const open = (url: string) => {
    hapticLight();
    void Linking.openURL(url).catch(() => {});
  };

  const store = Platform.OS === 'ios' ? 'App Store' : 'Play Store';

  return (
    <View style={styles.card}>
      <View style={styles.row}>
        <Text style={styles.status} numberOfLines={1}>
          {result.state === 'idle'
            ? 'App version'
            : result.state === 'checking'
              ? 'Checking for an app update…'
              : result.state === 'update'
                ? `App update available${result.latest ? ` — ${result.latest}` : ''}`
                : result.state === 'current'
                  ? 'Couchside app is up to date'
                  : 'Couldn’t check right now'}
        </Text>
        {result.state === 'update' ? (
          <Pressable onPress={() => open(result.url)} hitSlop={8} style={styles.btn}>
            <Ionicons name="open-outline" size={13} color={t.blue} />
            <Text style={styles.btnText}>{store}</Text>
          </Pressable>
        ) : (
          <Pressable onPress={() => void check()} hitSlop={8} style={styles.btn}>
            <Ionicons name="refresh" size={13} color={t.blue} />
            <Text style={styles.btnText}>
              {result.state === 'checking' ? '…' : 'Check'}
            </Text>
          </Pressable>
        )}
      </View>
      {/* Transparency, always shown and platform-accurate: exactly what this
          reaches out to, and that nothing about the user is sent. */}
      <Text style={styles.note}>
        {Platform.OS === 'ios'
          ? 'Manual only. Tapping Check asks the App Store for Couchside’s latest version — nothing about you or your box is sent.'
          : 'Manual only. Tapping Check asks couchside.tv for the current Play Store version (Google has no public version API) — nothing about you or your box is sent.'}
      </Text>
    </View>
  );
}

const makeStyles = (t: Palette) => StyleSheet.create({
  card: {
    paddingVertical: 10,
    paddingHorizontal: 12,
    marginBottom: 14,
    borderRadius: 12,
    backgroundColor: t.card,
    borderColor: t.cardBorder,
    borderWidth: 1,
    gap: 6,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 10,
  },
  status: { color: t.textDim, fontSize: 13, flex: 1 },
  note: { color: t.textFaint, fontSize: 11, lineHeight: 15 },
  btn: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  btnText: { color: t.blue, fontSize: 13, fontWeight: '700', fontFamily: mono },
});
