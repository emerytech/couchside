import React, { useCallback, useMemo, useState } from 'react';
import {
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import { Gated } from '@/components/Gated';
import { TabScreen } from '@/components/TabScreen';
import { useLockOrientation } from '@/hooks/useLockOrientation';
import { usePoll } from '@/hooks/usePoll';
import { api, hostKey, PlayerState } from '@/lib/api';
import { hapticError, hapticLight, hapticSuccess } from '@/lib/haptics';
import { useSettings } from '@/lib/SettingsContext';
import { useTheme, useThemedStyles, type Palette } from '@/lib/theme';

/**
 * DISPLAY ONLY. This is not an allowlist and must never become one — the box's
 * tile owns the service table, and what the grid renders comes from
 * /api/player. This map exists solely so "disneyplus" reads as "Disney+".
 * An id with no entry falls back to a title-cased version of itself, so a box
 * running a newer agent that adds a service still renders it properly rather
 * than hiding it or showing nothing.
 */
const LABELS: Record<string, string> = {
  netflix: 'Netflix',
  youtube: 'YouTube',
  max: 'Max',
  hulu: 'Hulu',
  disneyplus: 'Disney+',
  primevideo: 'Prime Video',
  appletv: 'Apple TV+',
  paramount: 'Paramount+',
  peacock: 'Peacock',
  crunchyroll: 'Crunchyroll',
  twitch: 'Twitch',
  plutotv: 'Pluto TV',
  plex: 'Plex',
  spotify: 'Spotify',
};

function label(id: string): string {
  return LABELS[id] ?? id.charAt(0).toUpperCase() + id.slice(1);
}

/**
 * Split a pasted/shared link into (service, path) using the BOX's own host
 * table from /api/player. Returns null when the host is not one the box knows.
 *
 * This is a convenience, NOT a security boundary: the box re-validates both the
 * service id and the path against that service's own pattern and refuses with a
 * 404, having written nothing. This function existing does not make the app
 * trusted — it makes the app helpful about links the box would accept anyway.
 */
export function splitLink(
  url: string,
  serviceUrls: Record<string, string> | undefined,
): { service: string; path: string } | null {
  if (!serviceUrls) return null;
  let parsed: URL;
  try {
    parsed = new URL(url.trim());
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:') return null;
  for (const [service, home] of Object.entries(serviceUrls)) {
    let homeHost: string;
    try {
      homeHost = new URL(home).host;
    } catch {
      continue;
    }
    if (homeHost !== parsed.host) continue;
    // Query and fragment are dropped: no service the box ships has a pattern
    // that includes them, so keeping them would only produce a link the box
    // refuses, which reads to the user as "the app is broken".
    const path = parsed.pathname === '/' ? '' : parsed.pathname;
    return { service, path };
  }
  return null;
}

export default function WatchTab() {
  useLockOrientation('portrait');
  return (
    <TabScreen>
      <Gated>
        <WatchScreen />
      </Gated>
    </TabScreen>
  );
}

function WatchScreen() {
  const t = useTheme();
  const styles = useThemedStyles(makeStyles);
  const { settings, ready } = useSettings();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [link, setLink] = useState('');

  const configured = settings.host.trim().length > 0;

  // Polled, not cached from the last op: Steam relaunches the registered tile
  // by itself after a return to Game Mode (measured 2026-07-27), so `running`
  // can become true with nothing in this app having asked for it. Treat the
  // box's answer as the truth, always.
  const player = usePoll<PlayerState | null>(
    () => api.player(settings),
    5000,
    ready && configured,
    hostKey(settings),
  );

  const state = player.data;
  const services = state?.services ?? [];

  const open = useCallback(
    async (service: string, path = '') => {
      hapticLight();
      setBusy(service);
      setError(null);
      try {
        await api.playerOp(settings, 'open', path ? { service, path } : { service });
        hapticSuccess();
        setLink('');
        player.refresh();
      } catch (e) {
        hapticError();
        // The box refuses unknown services and bad paths with a 404 and does
        // not echo the value back, so say what the user can act on.
        setError(
          `The box wouldn’t open that. ${e instanceof Error ? e.message : ''}`.trim(),
        );
      } finally {
        setBusy(null);
      }
    },
    [settings, player],
  );

  const stop = useCallback(async () => {
    hapticLight();
    setBusy('__stop__');
    setError(null);
    try {
      await api.playerOp(settings, 'close');
      hapticSuccess();
      player.refresh();
    } catch (e) {
      hapticError();
      setError(e instanceof Error ? e.message : 'Could not stop the player.');
    } finally {
      setBusy(null);
    }
  }, [settings, player]);

  const parsedLink = useMemo(
    () => (link.trim() ? splitLink(link, state?.service_urls) : null),
    [link, state?.service_urls],
  );

  const sendLink = useCallback(() => {
    if (!parsedLink) return;
    open(parsedLink.service, parsedLink.path);
  }, [parsedLink, open]);

  if (!configured) {
    return (
      <View style={styles.empty}>
        <Text style={styles.emptyTitle}>No box paired yet</Text>
        <Text style={styles.emptyBody}>Pair a box in Setup to use the player.</Text>
      </View>
    );
  }

  if (player.loading && !state) {
    return (
      <View style={styles.empty}>
        <Text style={styles.emptyBody}>Checking the box…</Text>
      </View>
    );
  }

  // 404 from the box (no tile, or no Widevine-capable browser) surfaces as null.
  if (!state) {
    return (
      <View style={styles.empty}>
        <Text style={styles.emptyTitle}>Player not installed</Text>
        <Text style={styles.emptyBody}>
          This box doesn’t have the Couchside Player, or has no browser that can
          play protected video.
        </Text>
      </View>
    );
  }

  return (
    <ScrollView
      style={styles.root}
      contentContainerStyle={styles.content}
      keyboardShouldPersistTaps="handled"
    >
      {state.running ? (
        <View style={styles.nowCard} testID="watch-now-playing">
          <View style={{ flex: 1 }}>
            <Text style={styles.nowLabel}>ON THE TV</Text>
            <Text style={styles.nowService}>{label(state.service)}</Text>
            {state.path ? (
              <Text style={styles.nowPath} numberOfLines={1}>
                {state.path}
              </Text>
            ) : null}
          </View>
          <Pressable
            onPress={stop}
            disabled={busy !== null}
            testID="watch-stop"
            style={({ pressed }) => [styles.stopBtn, pressed && styles.pressed]}
          >
            <Text style={styles.stopText}>
              {busy === '__stop__' ? 'Stopping…' : 'Stop'}
            </Text>
          </Pressable>
        </View>
      ) : (
        <Text style={styles.idle}>Nothing playing. Pick a service.</Text>
      )}

      {error ? <Text style={styles.error}>{error}</Text> : null}

      <Text style={styles.section}>SEND A LINK</Text>
      <View style={styles.linkRow}>
        <TextInput
          value={link}
          onChangeText={setLink}
          placeholder="Paste a link from a service"
          placeholderTextColor={t.textFaint}
          autoCapitalize="none"
          autoCorrect={false}
          inputMode="url"
          style={styles.input}
          testID="watch-link-input"
        />
        <Pressable
          onPress={sendLink}
          disabled={!parsedLink || busy !== null}
          testID="watch-link-send"
          style={({ pressed }) => [
            styles.sendBtn,
            !parsedLink && styles.sendBtnOff,
            pressed && styles.pressed,
          ]}
        >
          <Text style={[styles.sendText, !parsedLink && styles.sendTextOff]}>
            Send
          </Text>
        </Pressable>
      </View>
      {link.trim() && !parsedLink ? (
        <Text style={styles.hint} testID="watch-link-hint">
          That isn’t a link from a service this box knows.
        </Text>
      ) : null}
      {parsedLink ? (
        <Text style={styles.hintOk} testID="watch-link-ok">
          Opens on {label(parsedLink.service)}
          {parsedLink.path ? ' at that title' : ''}.
        </Text>
      ) : null}

      <Text style={styles.section}>SERVICES</Text>
      <View style={styles.grid}>
        {services.map((id) => {
          const active = state.running && state.service === id;
          return (
            <Pressable
              key={id}
              onPress={() => open(id)}
              disabled={busy !== null}
              testID={`watch-service-${id}`}
              style={({ pressed }) => [
                styles.tile,
                active && styles.tileActive,
                pressed && styles.pressed,
              ]}
            >
              <Text style={[styles.tileText, active && styles.tileTextActive]}>
                {busy === id ? 'Opening…' : label(id)}
              </Text>
            </Pressable>
          );
        })}
      </View>
    </ScrollView>
  );
}

const makeStyles = (t: Palette) =>
  StyleSheet.create({
    root: { flex: 1 },
    content: { padding: 16, paddingBottom: 48, gap: 12 },
    empty: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32, gap: 8 },
    emptyTitle: { color: t.text, fontSize: 17, fontWeight: '700' },
    emptyBody: { color: t.textDim, fontSize: 14, textAlign: 'center', lineHeight: 20 },
    idle: { color: t.textDim, fontSize: 14 },
    section: {
      color: t.textFaint,
      fontSize: 11,
      fontWeight: '700',
      letterSpacing: 1.2,
      marginTop: 8,
    },
    nowCard: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 12,
      backgroundColor: t.card,
      borderColor: t.cardBorder,
      borderWidth: StyleSheet.hairlineWidth,
      borderRadius: 12,
      padding: 14,
    },
    nowLabel: { color: t.green, fontSize: 10, fontWeight: '700', letterSpacing: 1.2 },
    nowService: { color: t.text, fontSize: 20, fontWeight: '700', marginTop: 2 },
    nowPath: { color: t.textFaint, fontSize: 12, marginTop: 2 },
    stopBtn: {
      paddingHorizontal: 18,
      paddingVertical: 10,
      borderRadius: 10,
      backgroundColor: t.redDeep,
    },
    stopText: { color: '#fff', fontWeight: '700', fontSize: 14 },
    linkRow: { flexDirection: 'row', gap: 8 },
    input: {
      flex: 1,
      color: t.text,
      backgroundColor: t.inset,
      borderColor: t.cardBorder,
      borderWidth: StyleSheet.hairlineWidth,
      borderRadius: 10,
      paddingHorizontal: 12,
      paddingVertical: 10,
      fontSize: 14,
    },
    sendBtn: {
      paddingHorizontal: 18,
      justifyContent: 'center',
      borderRadius: 10,
      backgroundColor: t.accent,
    },
    sendBtnOff: { backgroundColor: t.inset },
    sendText: { color: '#0b1220', fontWeight: '700', fontSize: 14 },
    sendTextOff: { color: t.textFaint },
    hint: { color: t.amber, fontSize: 12 },
    hintOk: { color: t.green, fontSize: 12 },
    error: { color: t.red, fontSize: 13 },
    grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
    tile: {
      minWidth: '30%',
      flexGrow: 1,
      alignItems: 'center',
      justifyContent: 'center',
      paddingVertical: 22,
      paddingHorizontal: 10,
      borderRadius: 12,
      backgroundColor: t.card,
      borderColor: t.cardBorder,
      borderWidth: StyleSheet.hairlineWidth,
    },
    tileActive: { borderColor: t.green, backgroundColor: t.inset },
    tileText: { color: t.text, fontSize: 14, fontWeight: '600', textAlign: 'center' },
    tileTextActive: { color: t.green },
    pressed: { opacity: 0.7 },
  });
