/**
 * The TV's own installed apps, in a grid, launched in one tap — remote-only
 * mode. Roku (ECP /query/apps) and LG webOS (SSAP listLaunchPoints) enumerate
 * their real installed apps WITH icons the TV serves itself. Google TV cannot
 * (its Remote v2 protocol has no app list), so this grid is only shown for the
 * brands supportsApps() allows — never a fabricated catalog dressed as "your
 * apps".
 *
 * Icons load straight from the TV over the LAN (<Image source={{uri}}>); nothing
 * touches a CDN, matching the box cover-art rule. Launch ids come from the TV's
 * own list, so a tap can never become an arbitrary launch string.
 */
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Image, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { hapticLight } from '@/lib/haptics';
import { DirectTv } from '@/lib/tvdirect/model';
import { type AtvRuntime, launchApp, listApps, type TvApp } from '@/lib/tvdirect/send';
import { mono, useTheme, useThemedStyles, type Palette } from '@/lib/theme';

type LoadState =
  | { kind: 'loading' }
  | { kind: 'ready'; apps: TvApp[] }
  | { kind: 'error' };

export function TvAppsGrid({ tv, runtime }: { tv: DirectTv; runtime: AtvRuntime }) {
  const t = useTheme();
  const styles = useThemedStyles(makeStyles);
  const [state, setState] = useState<LoadState>({ kind: 'loading' });
  const [launching, setLaunching] = useState<string | null>(null);

  const load = useCallback(async () => {
    setState({ kind: 'loading' });
    const apps = await listApps(tv, runtime);
    // listApps never throws; an empty list from a reachable TV is legitimate,
    // but a total failure (unreachable) also returns [] — so an empty result is
    // shown as "couldn't load", with a retry, rather than "you have no apps".
    setState(apps.length ? { kind: 'ready', apps } : { kind: 'error' });
  }, [tv, runtime]);

  useEffect(() => {
    void load();
  }, [load]);

  const open = useCallback(
    async (app: TvApp) => {
      hapticLight();
      setLaunching(app.id);
      await launchApp(tv, app.id, runtime);
      // Fire-and-forget UX: clear the spinner shortly regardless. A failed
      // launch on a reachable TV is rare and the next tap retries.
      setTimeout(() => setLaunching((cur) => (cur === app.id ? null : cur)), 600);
    },
    [tv, runtime],
  );

  if (state.kind === 'loading') {
    return (
      <View style={styles.center}>
        <ActivityIndicator color={t.blue} />
        <Text style={styles.dim}>Loading your TV’s apps…</Text>
      </View>
    );
  }
  if (state.kind === 'error') {
    return (
      <View style={styles.center}>
        <Text style={styles.dim}>Couldn’t load the app list. Make sure the TV is on.</Text>
        <Pressable onPress={() => void load()} style={({ pressed }) => [styles.retry, pressed && styles.pressed]}>
          <Text style={styles.retryText}>RETRY</Text>
        </Pressable>
      </View>
    );
  }

  return (
    <ScrollView contentContainerStyle={styles.grid} showsVerticalScrollIndicator={false}>
      {state.apps.map((app) => (
        <Pressable
          key={app.id}
          onPress={() => void open(app)}
          style={({ pressed }) => [styles.tile, pressed && styles.pressed]}>
          <View style={styles.iconWrap}>
            {app.iconUrl ? (
              <Image source={{ uri: app.iconUrl }} style={styles.icon} resizeMode="cover" />
            ) : (
              <View style={[styles.icon, styles.iconFallback]}>
                <Text style={styles.iconLetter}>{app.name.slice(0, 1).toUpperCase()}</Text>
              </View>
            )}
            {launching === app.id ? (
              <View style={styles.iconBusy}>
                <ActivityIndicator color="#fff" size="small" />
              </View>
            ) : null}
          </View>
          <Text style={styles.tileName} numberOfLines={2}>
            {app.name}
          </Text>
        </Pressable>
      ))}
    </ScrollView>
  );
}

const makeStyles = (t: Palette) => StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12, padding: 24 },
  dim: { color: t.textDim, fontSize: 13, textAlign: 'center', lineHeight: 18 },
  retry: {
    borderRadius: 10,
    paddingVertical: 9,
    paddingHorizontal: 18,
    backgroundColor: t.inset,
    borderWidth: 1,
    borderColor: t.cardBorder,
  },
  retryText: { color: t.blue, fontSize: 12, fontWeight: '800', letterSpacing: 1, fontFamily: mono },
  pressed: { opacity: 0.6 },
  grid: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between', paddingVertical: 8, gap: 4 },
  tile: { width: '31%', alignItems: 'center', marginBottom: 14, gap: 6 },
  iconWrap: { width: '100%', aspectRatio: 1, borderRadius: 14, overflow: 'hidden', backgroundColor: t.inset },
  icon: { width: '100%', height: '100%' },
  iconFallback: { alignItems: 'center', justifyContent: 'center', backgroundColor: t.card },
  iconLetter: { color: t.textDim, fontSize: 28, fontWeight: '800' },
  iconBusy: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, alignItems: 'center', justifyContent: 'center', backgroundColor: '#0008' },
  tileName: { color: t.text, fontSize: 11, textAlign: 'center', lineHeight: 14 },
});
