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
import { MEDIA_HOLD_MS, nextSeekPosition } from '@/lib/mediaSeek';
import { usePref } from '@/lib/prefs';
import { api, hostKey, Media, MediaOp, MediaPlayer, mediaArtSource } from '@/lib/api';
import { hapticHeavy, hapticLight, hapticMedium } from '@/lib/haptics';
import { useSkinKit } from '@/lib/skin';
import { useSettings } from '@/lib/SettingsContext';
import { mono, numeric, useTheme, useThemedStyles, type Palette } from '@/lib/theme';

function fmtTime(ms: number): string {
  const t = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(t / 60);
  const s = t % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

export function NowPlayingCard() {
  const t = useTheme();
  const styles = useThemedStyles(makeStyles);
  const { Card } = useSkinKit();
  const { settings, ready } = useSettings();
  const skipSec = usePref('mediaSkipSec');
  const holdEnabled = usePref('mediaHoldSkip');
  const holdSkipSec = usePref('mediaHoldSkipSec');
  const configured = !!settings.host && !!settings.token;

  const poll = usePoll<Media | null>(
    () => api.media(settings), 5000, ready && configured, hostKey(settings));
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

  /**
   * Jump by a relative offset. Requested on r/SteamOS: "a button that fast
   * forwards media or goes back like 10+ seconds".
   *
   * The scrub bar above can already reach any position, but only via a precise
   * tap on a thin target — which is the wrong instrument from a couch, and the
   * wrong one for "what did they just say". This is that gesture.
   *
   * Uses displayedMs, not active.position_ms: displayedMs interpolates playback
   * since the last poll, so "back 10s" means 10s from where the track actually
   * is, not from a reading up to a poll-interval stale. Off by that interval
   * otherwise, which on a 5s poll is a visibly wrong jump.
   *
   * Note this is gated ONLY on can_seek, unlike the bar, which also requires
   * length_ms > 0. The bar needs a known length to map a tap fraction to a
   * position; a relative offset does not. Live streams and players that report
   * no duration can still skip. The agent clamps to the track length itself
   * when it knows one, and falls back to a relative MPRIS Seek when the player
   * rejects SetPosition.
   */
  const seekBy = useCallback(
    (deltaMs: number, long = false) => {
      if (!active || !active.can_seek) return;
      // A hold is a bigger, blind jump, so it gets a heavier confirmation than
      // the tap's — you should be able to feel which one you got without
      // watching the timecode.
      if (long) hapticHeavy();
      send('seek', {
        position_ms: nextSeekPosition({
          currentMs: displayedMs,
          deltaMs,
          lengthMs: active.length_ms,
        }),
      });
    },
    [active, displayedMs, send],
  );

  if (!active) return null;

  const pct =
    active.length_ms > 0 ? Math.max(0, Math.min(100, (displayedMs / active.length_ms) * 100)) : 0;
  const playing = active.status === 'Playing';

  return (
    <Card title="NOW PLAYING" index={0}>

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
              <Ionicons name="musical-notes" size={22} color={t.textFaint} />
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
          accessibilityLabel="Previous track"
          onPress={() => send('previous')}
        />
        <TransportButton
          icon="play-back"
          label={String(skipSec)}
          disabled={!active.can_seek}
          accessibilityLabel={`Back ${skipSec} seconds`}
          accessibilityHint={
            holdEnabled ? `Hold to go back ${holdSkipSec} seconds` : undefined
          }
          onPress={() => seekBy(-skipSec * 1000)}
          onLongPress={holdEnabled ? () => seekBy(-holdSkipSec * 1000, true) : undefined}
          delayLongPress={MEDIA_HOLD_MS}
        />
        <TransportButton
          icon={playing ? 'pause' : 'play'}
          primary
          disabled={playing ? !active.can_pause : !active.can_play}
          accessibilityLabel={playing ? 'Pause' : 'Play'}
          onPress={() => send('play_pause')}
        />
        <TransportButton
          icon="play-forward"
          label={String(skipSec)}
          disabled={!active.can_seek}
          accessibilityLabel={`Forward ${skipSec} seconds`}
          accessibilityHint={
            holdEnabled ? `Hold to jump forward ${holdSkipSec} seconds` : undefined
          }
          onPress={() => seekBy(skipSec * 1000)}
          onLongPress={holdEnabled ? () => seekBy(holdSkipSec * 1000, true) : undefined}
          delayLongPress={MEDIA_HOLD_MS}
        />
        <TransportButton
          icon="play-skip-forward"
          disabled={!active.can_go_next}
          accessibilityLabel="Next track"
          onPress={() => send('next')}
        />
      </View>
    </Card>
  );
}

/** Split out so the art <Image> can fail-soft to a placeholder via onError. */
function ArtImage({ uri }: { uri: string }) {
  const t = useTheme();
  const styles = useThemedStyles(makeStyles);
  const [failed, setFailed] = useState(false);
  if (failed) {
    return (
      <View style={styles.artPlaceholder}>
        <Ionicons name="musical-notes" size={22} color={t.textFaint} />
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
  label,
  accessibilityLabel,
  accessibilityHint,
  onLongPress,
  delayLongPress,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  onPress: () => void;
  disabled?: boolean;
  primary?: boolean;
  onLongPress?: () => void;
  delayLongPress?: number;
  accessibilityHint?: string;
  /** Small digits over the glyph — "10" on the skip buttons, so the amount is
   * stated rather than left to a bare ⏪/⏩ the user has to guess at. */
  label?: string;
  accessibilityLabel?: string;
}) {
  const t = useTheme();
  const styles = useThemedStyles(makeStyles);
  const color = disabled ? t.textFaint : primary ? t.bg : t.text;
  return (
    <Pressable
      onPress={onPress}
      onLongPress={onLongPress}
      delayLongPress={delayLongPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityHint={accessibilityHint}
      style={({ pressed }) => [
        styles.tBtn,
        primary && styles.tBtnPrimary,
        pressed && styles.tBtnPressed,
        disabled && styles.tBtnDisabled,
      ]}>
      <Ionicons name={icon} size={primary ? 26 : 22} color={color} />
      {!!label && <Text style={[styles.tBtnLabel, { color }]}>{label}</Text>}
    </Pressable>
  );
}

const makeStyles = (t: Palette) => StyleSheet.create({
  card: {
    backgroundColor: t.card,
    borderColor: t.cardBorder,
    borderWidth: 1,
    borderRadius: 12,
    padding: 14,
    marginBottom: 10,
  },
  cardTitle: {
    color: t.textFaint,
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 1.2,
    marginBottom: 10,
    fontFamily: mono,
  },
  pills: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginBottom: 10 },
  pill: {
    borderColor: t.cardBorder,
    borderWidth: 1,
    borderRadius: 999,
    paddingVertical: 4,
    paddingHorizontal: 10,
    maxWidth: 160,
  },
  pillOn: { backgroundColor: t.green, borderColor: t.green },
  pillText: { color: t.textDim, fontSize: 11, fontFamily: mono },
  pillTextOn: { color: t.bg, fontWeight: '700' },

  row: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  art: { width: 56, height: 56, borderRadius: 8, overflow: 'hidden' },
  artImg: { width: 56, height: 56 },
  artPlaceholder: {
    width: 56,
    height: 56,
    borderRadius: 8,
    backgroundColor: t.inset,
    alignItems: 'center',
    justifyContent: 'center',
  },
  meta: { flex: 1 },
  trackTitle: { color: t.text, fontSize: 15, fontWeight: '700' },
  trackArtist: { color: t.textDim, fontSize: 13, marginTop: 2 },

  barTrack: {
    height: 6,
    borderRadius: 3,
    backgroundColor: t.inset,
    overflow: 'hidden',
    marginTop: 14,
  },
  barFill: { height: '100%', borderRadius: 3, backgroundColor: t.green },
  times: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 6 },
  time: { color: t.textDim, fontSize: 11, ...numeric },

  tBtnLabel: {
    // Digits sit tight under the glyph inside the same round button, so the
    // control reads as one unit rather than an icon with a caption.
    fontSize: 9,
    fontWeight: '700',
    marginTop: -2,
  },
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
    backgroundColor: t.inset,
  },
  tBtnPrimary: { backgroundColor: t.green, width: 54, height: 54 },
  tBtnPressed: { opacity: 0.7 },
  tBtnDisabled: { opacity: 0.4 },
});
