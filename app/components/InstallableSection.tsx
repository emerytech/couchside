/**
 * "Install from your library" — the Launch-tab section for games you OWN but have
 * not downloaded (Phase 2 of the ROADMAP "Install a game you own..." entry).
 *
 * The BOX enumerates the owned-but-uninstalled library from its own disk with no
 * Steam key (agent /api/steam/installable, gated by caps.steaminstall). It returns
 * APPIDS ONLY — it has no reliable offline name for an uninstalled game — so:
 *   - ART comes from the box (api.steamCoverSource; the capsule carries the title).
 *   - NAME + TYPE come app-side from Valve's keyless store endpoint (lib/steamStore),
 *     which shares the compat-lookups opt-in because it hits the same host and an
 *     appid list is a signal about what you own. Off => a one-line prompt, not a
 *     silent empty section.
 *   - type=game filters out the tools/DLC/demos the art cache overcounts.
 * Installing hands `install:<appid>` to the agent, which re-checks it against the
 * same owned set and fires steam://install — Steam's own owned-only flow.
 *
 * Probe-and-appear: renders nothing when the box can't do it (cap false, or a 404
 * from an older agent), so an old box or a Windows box is simply unaffected.
 */
import Ionicons from '@expo/vector-icons/Ionicons';
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Alert, Image, Platform, Pressable, StyleSheet, Text, View } from 'react-native';

import { api, type BoxCaps } from '@/lib/api';
import { hapticLight } from '@/lib/haptics';
import { usePref } from '@/lib/prefs';
import { useSettings } from '@/lib/SettingsContext';
import { fetchAppDetailsMany } from '@/lib/steamStore';
import { isInstallableGameType, type AppDetails } from '@/lib/steamStoreParse';
import { useThemedStyles, type Palette } from '@/lib/theme';

// steam://install does NOT silently download — VERIFIED on hardware 2026-08-08: it pops
// Steam's install PROMPT on the box's screen, and the download only starts once someone
// APPROVES it there. So the copy says "approve on your box", never "downloading now", and a
// tapped tile stays in a "waiting for approval" state until the box reports the download
// (at which point the section drops it — it has moved to the Downloads list above).

/** Cross-platform confirm (Alert buttons are no-ops on web). */
function confirmInstall(label: string, onConfirm: () => void) {
  const q = `Install "${label}"? A prompt appears on your box's screen to approve it — use a controller, or your phone's Pad.`;
  if (Platform.OS === 'web') {
    // eslint-disable-next-line no-alert
    if (typeof window !== 'undefined' && window.confirm(q)) onConfirm();
    return;
  }
  Alert.alert('Install game', q, [
    { text: 'Cancel', style: 'cancel' },
    { text: 'Install', onPress: onConfirm },
  ]);
}

function Tile({ appid, name }: { appid: number; name: string }) {
  const styles = useThemedStyles(makeStyles);
  const { settings } = useSettings();
  const source = api.steamCoverSource(settings, appid);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  // Set once the box has accepted the install request. The prompt is now on the box's
  // screen; the tile shows "Approve on box" until the download appears (then the section
  // filters this tile out). It does NOT mean "installed".
  const [requested, setRequested] = useState(false);
  useEffect(() => setFailed(false), [source.uri]);

  const install = () => {
    hapticLight();
    confirmInstall(name, async () => {
      setBusy(true);
      try {
        const res = await api.launch(settings, `install:${appid}`);
        if (res?.ok) setRequested(true);
        if (Platform.OS !== 'web') {
          Alert.alert(
            res?.ok ? 'Approve it on your box' : "Couldn't start install",
            res?.ok
              ? `A prompt for "${name}" is on your box's screen — approve it (a controller, or your phone's Pad) to start the download. It shows in Downloads once it begins.`
              : `The box refused the install for "${name}".`,
          );
        }
      } finally {
        setBusy(false);
      }
    });
  };

  return (
    <Pressable
      style={styles.tile}
      onPress={install}
      disabled={busy || requested}
      accessibilityRole="button"
      accessibilityLabel={requested ? `${name}, waiting for approval on your box` : `Install ${name}`}>
      {!failed ? (
        <Image source={source} style={styles.cover} resizeMode="cover" onError={() => setFailed(true)} />
      ) : (
        <View style={[styles.cover, styles.coverFallback]}>
          <Ionicons name="cloud-download-outline" size={22} color="#8aa" />
        </View>
      )}
      <Text style={styles.tileLabel} numberOfLines={2}>{name}</Text>
      {requested ? <Text style={styles.tileHint} numberOfLines={1}>Approve on box…</Text> : null}
      <View style={styles.badge}>
        {busy ? (
          <ActivityIndicator size="small" />
        ) : (
          <Ionicons name={requested ? 'hourglass-outline' : 'cloud-download-outline'} size={14} color="#fff" />
        )}
      </View>
    </Pressable>
  );
}

export function InstallableSection({
  caps, downloadingAppids,
}: {
  caps?: BoxCaps;
  /** Appids the box is currently downloading (from the Launch tab's download watcher).
   *  Once an approved install starts, its game moves to the Downloads list above, so it
   *  is dropped from this grid rather than shown in both places. */
  downloadingAppids?: Set<number>;
}) {
  const styles = useThemedStyles(makeStyles);
  const { settings } = useSettings();
  const lookupsOn = usePref('compatLookups');
  const [appids, setAppids] = useState<number[] | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [details, setDetails] = useState<Record<number, AppDetails | null>>({});
  const [resolving, setResolving] = useState(false);

  // Cap false = box can't; don't even probe. Undefined/true = probe the endpoint,
  // which 404s on an older agent and hides the section (setAppids stays null).
  const canProbe = caps?.steaminstall !== false;

  useEffect(() => {
    if (!canProbe) return;
    let live = true;
    void (async () => {
      const res = await api.installable(settings);
      if (live) setAppids(res && res.games.length ? res.games.map((g) => g.appid) : null);
    })();
    return () => {
      live = false;
    };
  }, [settings, canProbe]);

  // Resolve names/types only once expanded AND lookups are on — never reach the
  // store on the user's behalf without the opt-in.
  const abortRef = useRef<{ aborted: boolean }>({ aborted: false });
  useEffect(() => {
    abortRef.current.aborted = true; // cancel any prior run
    if (!expanded || !lookupsOn || !appids) return;
    const signal = { aborted: false };
    abortRef.current = signal;
    setResolving(true);
    void fetchAppDetailsMany(
      appids,
      (appid, d) => {
        if (!signal.aborted) setDetails((prev) => ({ ...prev, [appid]: d }));
      },
      signal,
    ).finally(() => {
      if (!signal.aborted) setResolving(false);
    });
    return () => {
      signal.aborted = true;
    };
  }, [expanded, lookupsOn, appids]);

  if (!canProbe || !appids) return null;

  const games = appids
    .filter((id) => !downloadingAppids?.has(id)) // already downloading -> in Downloads above
    .filter((id) => isInstallableGameType(details[id]))
    .map((id) => ({ id, name: details[id]!.name }))
    .sort((a, b) => a.name.localeCompare(b.name));

  return (
    <View style={styles.wrap}>
      <Pressable
        style={styles.header}
        onPress={() => {
          hapticLight();
          setExpanded((v) => !v);
        }}
        accessibilityRole="button"
        accessibilityState={{ expanded }}>
        <Ionicons name="cloud-download-outline" size={16} style={styles.headerIcon} />
        <Text style={styles.headerTitle}>Not installed</Text>
        <Text style={styles.headerCount}>{appids.length} in your library</Text>
        <Ionicons name={expanded ? 'chevron-up' : 'chevron-down'} size={16} style={styles.headerChevron} />
      </Pressable>

      {expanded ? (
        !lookupsOn ? (
          <Text style={styles.note}>
            Turn on game lookups in Prefs to see titles and install games from your library.
          </Text>
        ) : (
          <>
            <View style={styles.grid}>
              {games.map((g) => (
                <Tile key={g.id} appid={g.id} name={g.name} />
              ))}
            </View>
            {resolving ? (
              <View style={styles.resolvingRow}>
                <ActivityIndicator size="small" />
                <Text style={styles.note}>
                  Finding games in your library… {games.length} so far.
                </Text>
              </View>
            ) : games.length === 0 ? (
              <Text style={styles.note}>No installable games found in your library.</Text>
            ) : null}
          </>
        )
      ) : null}
    </View>
  );
}

const makeStyles = (t: Palette) =>
  StyleSheet.create({
    wrap: { marginTop: 8, marginBottom: 4 },
    header: { flexDirection: 'row', alignItems: 'center', paddingVertical: 10, gap: 8 },
    headerIcon: { color: t.textFaint },
    headerTitle: { color: t.text, fontWeight: '700', fontSize: 14 },
    headerCount: { color: t.textFaint, fontSize: 12, marginLeft: 'auto' },
    headerChevron: { color: t.textFaint, marginLeft: 8 },
    note: { color: t.textFaint, fontSize: 12, paddingVertical: 8, lineHeight: 18 },
    grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 10, paddingTop: 4 },
    tile: { width: 92, alignItems: 'center' },
    cover: { width: 92, height: 138, borderRadius: 8, backgroundColor: t.card },
    coverFallback: { alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: t.cardBorder },
    tileLabel: { color: t.text, fontSize: 11, textAlign: 'center', marginTop: 4, width: 92 },
    tileHint: { color: t.amber, fontSize: 10, textAlign: 'center', marginTop: 2, width: 92 },
    badge: {
      position: 'absolute', top: 6, right: 6, width: 24, height: 24, borderRadius: 12,
      backgroundColor: 'rgba(0,0,0,0.6)', alignItems: 'center', justifyContent: 'center',
    },
    resolvingRow: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingTop: 6 },
  });
