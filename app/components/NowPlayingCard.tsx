/**
 * Now Playing card (Console tab). Polls /api/media (MPRIS) and shows the active
 * player's track with a tap-to-seek progress bar and capability-gated transport
 * controls. Probe-and-appear: renders nothing when the agent has no media
 * backend (404 -> null) or no players. Album art is fetched as a base64 data
 * URI from the resolved host (never a raw <Image> URL, which can't carry auth).
 */
import Ionicons from '@expo/vector-icons/Ionicons';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Image, LayoutChangeEvent, Pressable, StyleSheet, Text, View } from 'react-native';

import { usePoll } from '@/hooks/usePoll';
import { api, Media, MediaOp, MediaPlayer, mediaArtSource } from '@/lib/api';
import { hapticLight, hapticMedium } from '@/lib/haptics';
import { useSettings } from '@/lib/SettingsContext';
import { mono, numeric, theme } from '@/lib/theme';

function fmtTime(ms: number): string {
  const t = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(t / 60);
  const s = t % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

export function NowPlayingCard() {
  const { settings, ready } = useSettings();
  const configured = !!settings.host && !!settings.token;

  const poll = usePoll<Media | null>(() => api.media(settings), 5000, ready && configured);
  const players = poll.data?.players ?? [];

  // Active player: user's pick if still present, else first Playing, else first.
  const [picked, setPicked] = useState<string | null>(null);
  const active: MediaPlayer | null = useMemo(() => {
    if (players.length === 0) return null;
    if (picked) {
      const p = players.find((x) => x.id === picked);
      if (p) return p;
    }
    return players.find((x) => x.status === 'Playing') ?? players[0];
  }, [players, picked]);

  // Album art -> base64 data URI, refetched when the track (art_key) changes.
  const [artUri, setArtUri] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    if (!active || !active.art || !active.art_key) {
      setArtUri(null);
      return;
    }
    mediaArtSource(settings, active.id, active.art_key).then((uri) => {
      if (alive) setArtUri(uri);
    });
    return () => {
      alive = false;
    };
  }, [active?.id, active?.art, active?.art_key, settings]);

  // Interpolate position between polls while playing (a 1s ticker re-renders).
  // `tick` is a real dep of displayedMs below, so each tick recomputes it.
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (active?.status !== 'Playing') return;
    const id = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, [active?.status]);

  const displayedMs = useMemo(() => {
    if (!active) return 0;
    let ms = active.position_ms;
    if (active.status === 'Playing' && poll.lastSuccess != null) {
      ms += (Date.now() - poll.lastSuccess) * (active.rate || 1);
    }
    if (active.length_ms > 0) ms = Math.min(ms, active.length_ms);
    return Math.max(0, ms);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, poll.lastSuccess, tick]);

  const [barWidth, setBarWidth] = useState(0);
  const onBarLayout = useCallback((e: LayoutChangeEvent) => {
    setBarWidth(e.nativeEvent.layout.width);
  }, []);

  const send = useCallback(
    async (op: MediaOp, body?: { position_ms: number }) => {
      if (!active) return;
      hapticMedium();
      try {
        await api.mediaOp(settings, active.id, op, body);
      } catch {
        // best-effort transport; the next poll reflects reality
      }
      poll.refresh();
    },
    [active, settings, poll.refresh],
  );

  const seekTo = useCallback(
    (e: { nativeEvent: { locationX: number } }) => {
      if (!active || !active.can_seek || active.length_ms <= 0 || barWidth <= 0) return;
      const frac = Math.max(0, Math.min(1, e.nativeEvent.locationX / barWidth));
      hapticLight();
      send('seek', { position_ms: Math.round(frac * active.length_ms) });
    },
    [active, barWidth, send],
  );

  if (!active) return null;

  const pct =
    active.length_ms > 0 ? Math.max(0, Math.min(100, (displayedMs / active.length_ms) * 100)) : 0;
  const playing = active.status === 'Playing';

  return (
    <View style={styles.card}>
      <Text style={styles.cardTitle}>NOW PLAYING</Text>

      {players.length > 1 && (
        <View style={styles.pills}>
          {players.map((p) => {
            const on = p.id === active.id;
            return (
              <Pressable
                key={p.id}
                onPress={() => {
                  hapticLight();
                  setPicked(p.id);
                }}
                style={[styles.pill, on && styles.pillOn]}>
                <Text style={[styles.pillText, on && styles.pillTextOn]} numberOfLines={1}>
                  {p.identity}
                </Text>
              </Pressable>
            );
          })}
        </View>
      )}

      <View style={styles.row}>
        <View style={styles.art}>
          {artUri ? (
            <ArtImage uri={artUri} />
          ) : (
            <View style={styles.artPlaceholder}>
              <Ionicons name="musical-notes" size={22} color={theme.textFaint} />
            </View>
          )}
        </View>
        <View style={styles.meta}>
          <Text style={styles.trackTitle} numberOfLines={1}>
            {active.title || active.identity}
          </Text>
          <Text style={styles.trackArtist} numberOfLines={1}>
            {active.artist || active.album || '—'}
          </Text>
        </View>
      </View>

      {/* Progress: tap anywhere to seek (when supported). */}
      <Pressable onPress={seekTo} disabled={!active.can_seek || active.length_ms <= 0}>
        <View style={styles.barTrack} onLayout={onBarLayout}>
          <View style={[styles.barFill, { width: `${pct}%` }]} />
        </View>
      </Pressable>
      <View style={styles.times}>
        <Text style={styles.time}>{fmtTime(displayedMs)}</Text>
        <Text style={styles.time}>{active.length_ms > 0 ? fmtTime(active.length_ms) : '--:--'}</Text>
      </View>

      <View style={styles.transport}>
        <TransportButton
          icon="play-skip-back"
          disabled={!active.can_go_previous}
          onPress={() => send('previous')}
        />
        <TransportButton
          icon={playing ? 'pause' : 'play'}
          primary
          disabled={playing ? !active.can_pause : !active.can_play}
          onPress={() => send('play_pause')}
        />
        <TransportButton
          icon="play-skip-forward"
          disabled={!active.can_go_next}
          onPress={() => send('next')}
        />
      </View>
    </View>
  );
}

/** Split out so the art <Image> can fail-soft to a placeholder via onError. */
function ArtImage({ uri }: { uri: string }) {
  const [failed, setFailed] = useState(false);
  if (failed) {
    return (
      <View style={styles.artPlaceholder}>
        <Ionicons name="musical-notes" size={22} color={theme.textFaint} />
      </View>
    );
  }
  return (
    <Image source={{ uri }} style={styles.artImg} resizeMode="cover" onError={() => setFailed(true)} />
  );
}

function TransportButton({
  icon,
  onPress,
  disabled,
  primary,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  onPress: () => void;
  disabled?: boolean;
  primary?: boolean;
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      style={({ pressed }) => [
        styles.tBtn,
        primary && styles.tBtnPrimary,
        pressed && styles.tBtnPressed,
        disabled && styles.tBtnDisabled,
      ]}>
      <Ionicons
        name={icon}
        size={primary ? 26 : 22}
        color={disabled ? theme.textFaint : primary ? theme.bg : theme.text}
      />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: theme.card,
    borderColor: theme.cardBorder,
    borderWidth: 1,
    borderRadius: 12,
    padding: 14,
    marginBottom: 10,
  },
  cardTitle: {
    color: theme.textFaint,
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 1.2,
    marginBottom: 10,
    fontFamily: mono,
  },
  pills: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginBottom: 10 },
  pill: {
    borderColor: theme.cardBorder,
    borderWidth: 1,
    borderRadius: 999,
    paddingVertical: 4,
    paddingHorizontal: 10,
    maxWidth: 160,
  },
  pillOn: { backgroundColor: theme.green, borderColor: theme.green },
  pillText: { color: theme.textDim, fontSize: 11, fontFamily: mono },
  pillTextOn: { color: theme.bg, fontWeight: '700' },

  row: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  art: { width: 56, height: 56, borderRadius: 8, overflow: 'hidden' },
  artImg: { width: 56, height: 56 },
  artPlaceholder: {
    width: 56,
    height: 56,
    borderRadius: 8,
    backgroundColor: theme.inset,
    alignItems: 'center',
    justifyContent: 'center',
  },
  meta: { flex: 1 },
  trackTitle: { color: theme.text, fontSize: 15, fontWeight: '700' },
  trackArtist: { color: theme.textDim, fontSize: 13, marginTop: 2 },

  barTrack: {
    height: 6,
    borderRadius: 3,
    backgroundColor: theme.inset,
    overflow: 'hidden',
    marginTop: 14,
  },
  barFill: { height: '100%', borderRadius: 3, backgroundColor: theme.green },
  times: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 6 },
  time: { color: theme.textDim, fontSize: 11, ...numeric },

  transport: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 18,
    marginTop: 12,
  },
  tBtn: {
    width: 46,
    height: 46,
    borderRadius: 999,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: theme.inset,
  },
  tBtnPrimary: { backgroundColor: theme.green, width: 54, height: 54 },
  tBtnPressed: { opacity: 0.7 },
  tBtnDisabled: { opacity: 0.4 },
});
