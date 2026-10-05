/**
 * Advanced setting: connect an OPT-IN Steam Web API key so the box can enrich
 * What-to-Play and show the user's own Steam profile. The key is entered here,
 * sent once over the authed channel, stored ONLY on the box (0600), and never
 * comes back — the status shows a masked key. Probe-and-appear: renders nothing
 * on an agent that doesn't support it (api.steamWebApi -> null on 404), so the
 * card only shows where it works. A "How to get your key" link opens the guide.
 *
 * Not a paywall and not on by default — it's a power-user convenience the app
 * mounts only for a box that has Steam.
 */
import React, { useCallback, useState } from 'react';
import {
  ActivityIndicator, Image, Linking, Pressable, StyleSheet, Text, TextInput, View,
} from 'react-native';

import { usePoll } from '@/hooks/usePoll';
import { ApiError, api, hostKey, type SteamWebApiStatus } from '@/lib/api';
import { hapticLight } from '@/lib/haptics';
import { useSettings } from '@/lib/SettingsContext';
import { mono, useTheme, useThemedStyles, type Palette } from '@/lib/theme';

const GUIDE_URL = 'https://couchside.tv/steam-setup';

export function SteamIntegrationCard() {
  const t = useTheme();
  const styles = useThemedStyles(makeStyles);
  const { settings, ready } = useSettings();
  const configured = !!settings.host && !!settings.token;

  // usePoll, NOT a one-shot try/catch that mapped EVERY error to null. null MUST
  // mean only "agent doesn't support it" (api.steamWebApi -> null on an exact
  // 404), because null hides the card; the old catch also set null on a
  // transient failure (box asleep, timeout, 5xx), so one bad fetch hid the card
  // and it never retried. usePoll keeps the card hidden while unknown (degrade
  // closed) and a throwing fetch retries every ~2s, so the card returns on its
  // own when the box is reachable again. A mutation calls poll.refresh() to
  // re-read the box (the source of truth).
  const poll = usePoll(
    () => api.steamWebApi(settings), 30_000, ready && configured, hostKey(settings));
  const status = poll.data; // SteamWebApiStatus (show) | null (404, hide)
  // Still the very first attempt with no answer yet: show the spinner. After a
  // failure settles (loading false, still null) the card just stays hidden.
  const loading = status == null && poll.loading && poll.error == null;
  const [steamId, setSteamId] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Once set up, the card collapses to a one-line summary; tap the header to expand.
  const [expanded, setExpanded] = useState(false);

  const connect = async () => {
    const id = steamId.trim();
    const key = apiKey.trim();
    if (!id || !key) {
      setError('Enter your Steam profile (ID or name) and your API key.');
      return;
    }
    hapticLight();
    setError(null);
    setBusy(true);
    try {
      // 17 digits = a SteamID64; anything else is treated as a vanity name the
      // box resolves. The box re-validates either way.
      const payload = /^\d{17}$/.test(id)
        ? { steamid64: id, apikey: key }
        : { vanity: id, apikey: key };
      await api.steamWebApiConnect(settings, payload);
      poll.refresh(); // re-read the box's new status (source of truth)
      setApiKey('');
      setSteamId('');
    } catch (e) {
      setError(e instanceof ApiError && e.message ? e.message
        : 'Could not connect. Check your Steam ID and key.');
    } finally {
      setBusy(false);
    }
  };

  const disconnect = async () => {
    hapticLight();
    setBusy(true);
    try {
      await api.steamWebApiDisconnect(settings);
      poll.refresh();
    } catch {
      // best-effort; a failed disconnect leaves the card as-is
    } finally {
      setBusy(false);
    }
  };

  const openGuide = () => { hapticLight(); void Linking.openURL(GUIDE_URL); };

  // Probe-and-appear: render nothing once we KNOW the box can't offer it (null
  // after a real answer) OR while a transient failure leaves us hidden and
  // retrying. Only the first in-flight probe shows the spinner (`loading`).
  if (status == null && !loading) return null;

  const collapsible = !!status && status.configured;

  return (
    <View style={styles.card}>
      <Pressable
        onPress={() => collapsible && setExpanded((e) => !e)}
        disabled={!collapsible}
        style={styles.headerRow}>
        <Text style={styles.title}>STEAM INTEGRATION</Text>
        <View style={styles.advChip}><Text style={styles.advChipTxt}>ADVANCED</Text></View>
        {collapsible ? (
          <Text style={styles.chevron}>{expanded ? '▴' : '▾'}</Text>
        ) : null}
      </Pressable>

      {status == null ? (
        <ActivityIndicator color={t.green} style={{ marginVertical: 16 }} />
      ) : status.configured && !expanded ? (
        <Text style={styles.collapsedSummary} numberOfLines={1}>
          {status.persona ?? 'Steam account'}
          {'  ·  '}{status.connected ? 'Connected' : 'Saved — Steam unreachable'}
          {status.apikey_masked ? `  ·  key ${status.apikey_masked}` : ''}
        </Text>
      ) : status.configured ? (
        <View style={styles.connectedBox}>
          <View style={styles.connectedRow}>
            {status.avatar ? (
              <Image source={{ uri: status.avatar }} style={styles.avatar} />
            ) : (
              <View style={[styles.avatar, styles.avatarFallback]} />
            )}
            <View style={{ flex: 1 }}>
              <Text style={styles.connectedName} numberOfLines={1}>
                {status.persona ?? 'Steam account'}
              </Text>
              <Text style={styles.connectedSub} numberOfLines={1}>
                {status.connected ? 'Connected' : 'Saved — Steam not reachable right now'}
                {status.apikey_masked ? `  ·  key ${status.apikey_masked}` : ''}
              </Text>
            </View>
          </View>
          <Pressable
            onPress={disconnect}
            disabled={busy}
            accessibilityRole="button"
            accessibilityLabel="Disconnect Steam"
            style={({ pressed }) => [styles.disconnectBtn, pressed && styles.pressed]}>
            {busy ? <ActivityIndicator size="small" color={t.red} />
              : <Text style={styles.disconnectTxt}>Disconnect</Text>}
          </Pressable>
        </View>
      ) : (
        <>
          <Text style={styles.help}>
            Optional. Add your Steam profile and a free Steam Web API key to make
            recommendations smarter and show your Steam profile. Your key is stored only
            on this box and is used only to read your own Steam data.
          </Text>
          <Pressable onPress={openGuide} accessibilityRole="link"
            accessibilityLabel="How to get your Steam API key"
            hitSlop={6} style={({ pressed }) => [pressed && styles.pressed]}>
            <Text style={styles.link}>How to get your key  →</Text>
          </Pressable>

          <Text style={styles.label}>Steam ID or profile name</Text>
          <TextInput
            value={steamId}
            onChangeText={setSteamId}
            placeholder="7656119… or your profile name"
            placeholderTextColor={t.textFaint}
            autoCapitalize="none"
            autoCorrect={false}
            style={styles.input}
          />

          <Text style={styles.label}>Steam Web API key</Text>
          <TextInput
            value={apiKey}
            onChangeText={setApiKey}
            placeholder="32-character key"
            placeholderTextColor={t.textFaint}
            autoCapitalize="none"
            autoCorrect={false}
            secureTextEntry
            style={styles.input}
          />

          {error ? <Text style={styles.error}>{error}</Text> : null}

          <Pressable
            onPress={connect}
            disabled={busy}
            accessibilityRole="button"
            accessibilityLabel="Connect Steam"
            style={({ pressed }) => [styles.connectBtn, (pressed || busy) && styles.pressed]}>
            {busy ? <ActivityIndicator size="small" color={t.onAccent} />
              : <Text style={styles.connectTxt}>Connect Steam</Text>}
          </Pressable>
        </>
      )}
    </View>
  );
}

const makeStyles = (t: Palette) =>
  StyleSheet.create({
    card: {
      backgroundColor: t.card, borderColor: t.cardBorder, borderWidth: 1,
      borderRadius: 12, padding: 16, marginBottom: 16,
    },
    headerRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 10 },
    title: { color: t.textFaint, fontFamily: mono, fontSize: 11, letterSpacing: 1.5 },
    chevron: { color: t.textDim, fontSize: 14, marginLeft: 'auto', paddingLeft: 8 },
    collapsedSummary: { color: t.textDim, fontSize: 13 },
    advChip: {
      backgroundColor: t.bg, borderColor: t.cardBorder, borderWidth: 1,
      borderRadius: 6, paddingHorizontal: 6, paddingVertical: 2,
    },
    advChipTxt: { color: t.textDim, fontFamily: mono, fontSize: 9, letterSpacing: 1 },
    help: { color: t.textDim, fontSize: 13, lineHeight: 19, marginBottom: 8 },
    link: { color: t.blue, fontSize: 13, fontWeight: '700', marginBottom: 14 },
    label: { color: t.textFaint, fontFamily: mono, fontSize: 10, letterSpacing: 1, marginBottom: 6 },
    input: {
      backgroundColor: t.bg, borderColor: t.cardBorder, borderWidth: 1, borderRadius: 8,
      paddingHorizontal: 12, paddingVertical: 10, color: t.text, fontSize: 15, marginBottom: 14,
    },
    error: { color: t.red, fontSize: 13, marginBottom: 10 },
    connectBtn: {
      backgroundColor: t.green, borderRadius: 999, paddingVertical: 12, alignItems: 'center',
    },
    connectTxt: { color: t.onAccent, fontWeight: '800', fontSize: 15 },
    pressed: { opacity: 0.6 },
    connectedBox: { gap: 14 },
    connectedRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
    avatar: { width: 44, height: 44, borderRadius: 8, backgroundColor: t.bg },
    avatarFallback: { borderColor: t.cardBorder, borderWidth: 1 },
    connectedName: { color: t.text, fontSize: 16, fontWeight: '700' },
    connectedSub: { color: t.textDim, fontSize: 12, marginTop: 2 },
    disconnectBtn: {
      borderColor: t.red, borderWidth: 1, borderRadius: 999, paddingVertical: 10, alignItems: 'center',
    },
    disconnectTxt: { color: t.red, fontWeight: '700', fontSize: 14 },
  });
