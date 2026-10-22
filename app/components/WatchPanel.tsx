import React, { useCallback, useMemo, useRef, useState } from 'react';
import {
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import { usePoll } from '@/hooks/usePoll';
import { api, ApiError, hostKey, MediaApp, MediaAppsState, PlayerOp, PlayerPlayback, PlayerState } from '@/lib/api';
import { hapticError, hapticHeavy, hapticLight, hapticSuccess } from '@/lib/haptics';
import { MEDIA_HOLD_MS } from '@/lib/mediaSeek';
import { useSettings } from '@/lib/SettingsContext';
import { supportsBoxPanel } from '@/lib/setupPhase';
import { clearRecents, noteRecent, useWatchRecents } from '@/lib/watchRecents';
import { useTheme, useThemedStyles, type Palette } from '@/lib/theme';
import { WatchDpad } from '@/components/WatchDpad';
import { useDesktopKeyboard } from '@/components/DesktopKeyboard';
import { blockTabSwipe } from '@/lib/tabSwipe';
import { orderFavoriteServices } from '@/lib/watchFavoriteOrder';
import { toggleWatchFavorite, useWatchFavorites } from '@/lib/watchFavorites';
import { GamepadClient } from '@/lib/gamepad';

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

/**
 * Brand accent per service — a COLOUR, deliberately not a logo.
 *
 * Bundling Netflix/Hulu/Disney+ logo artwork into an app shipped on two stores
 * is a trademark question, and most of these companies' brand guidelines forbid
 * third-party use that implies integration. Naming a service you are launching
 * is ordinary nominative use; redistributing its artwork is not. So the tile
 * carries a colour bar and the service's name as text, and no logo file ships.
 *
 * (The box's own hub page DOES show real icons — it fetches them live from the
 * service, in the user's own browser, on their own machine. Nothing is bundled
 * or redistributed there, which is what makes that different.)
 *
 * Display only, like LABELS: an unknown id gets the neutral accent.
 */
const ACCENTS: Record<string, string> = {
  netflix: '#E50914',
  youtube: '#FF0033',
  max: '#7B4DFF',
  hulu: '#1CE783',
  disneyplus: '#1F80E0',
  primevideo: '#00A8E1',
  appletv: '#B9BFC9',
  paramount: '#0064FF',
  peacock: '#F5A623',
  crunchyroll: '#F47521',
  twitch: '#9146FF',
  plutotv: '#FFE000',
  plex: '#EBAF00',
  spotify: '#1DB954',
};

function label(id: string): string {
  return LABELS[id] ?? id.charAt(0).toUpperCase() + id.slice(1);
}

/** h:mm:ss, dropping the hour when there isn't one. */
function fmtTime(secs: number): string {
  const s = Math.max(0, Math.floor(secs || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`;
}

/** Progress as a percentage. A live stream reports duration 0 — show an empty
 *  bar rather than dividing by zero and rendering NaN%. */
function progressPct(p: PlayerPlayback): number {
  if (!p.duration || p.duration <= 0) return 0;
  return Math.max(0, Math.min(100, (p.position / p.duration) * 100));
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
  serviceHosts?: Record<string, string[]>,
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
    // Alias hosts come from the BOX (service_hosts). Measured: play.max.com
    // redirects to play.hbomax.com and a shared Max link uses the latter, so
    // matching only the canonical host rejected the one service whose
    // deep-link pattern is actually verified.
    const aliases = serviceHosts?.[service] ?? [];
    if (homeHost !== parsed.host && !aliases.includes(parsed.host)) continue;
    // Query and fragment are dropped: no service the box ships has a pattern
    // that includes them, so keeping them would only produce a link the box
    // refuses, which reads to the user as "the app is broken".
    const path = parsed.pathname === '/' ? '' : parsed.pathname;
    return { service, path };
  }
  return null;
}

/**
 * The Watch surface, hosted as a SEGMENT of the Launch tab rather than a tab of
 * its own.
 *
 * Why it lives under Launch: that tab already means "start something on the
 * TV", which is exactly what picking a service is, and the tab bar was getting
 * crowded. Safe to nest, and that is checkable rather than hopeful — the
 * agent's player_available() requires `steam` and `steamos-add-to-steam`
 * (couchsided.py), so `player: true` implies Steam is present, which means
 * Launch is never hidden on a box where Watch exists. It cannot be stranded.
 *
 * Same reasoning as Steam menus moving out of Actions into a Pad segment: one
 * door per thing. There is deliberately no /watch route.
 */
export function WatchPanel() {
  const t = useTheme();
  const styles = useThemedStyles(makeStyles);
  const { settings, ready } = useSettings();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [link, setLink] = useState('');
  const [query, setQuery] = useState('');
  const [remoteMode, setRemoteMode] = useState<'browse' | 'playback'>('browse');
  // True while a finger is on the d-pad's swipe surface. The ScrollView must
  // not scroll during it, or a vertical swipe scrolls the panel instead of
  // stepping the TV's focus a row.
  const [dpadGesture, setDpadGesture] = useState(false);
  // Optimistic "Starting…" card. The box's truth arrives on a 5s poll, so
  // without this a tapped service shows NOTHING for up to five seconds — the
  // single biggest "does not feel native" gap. Set from the POST's own success
  // (the box really is starting it), cleared when the poll confirms running or
  // after a timeout that means the tile died.
  const [pending, setPending] = useState<string | null>(null);
  // Jump the panel to the top when an open starts, so the Starting/Now card is
  // on screen instead of below the fold the user tapped from.
  const scrollRef = useRef<ScrollView | null>(null);
  // The gamepad session is OWNED here (WatchDpad runs its lifecycle) so the
  // phone-keyboard hook can share it: typing rides the same {t:'kt'} path,
  // and the compose bar must render at panel root, outside the ScrollView.
  const gpRef = useRef<GamepadClient | null>(null);
  if (gpRef.current == null) gpRef.current = new GamepadClient();
  const kb = useDesktopKeyboard(gpRef.current);

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
  const favorites = useWatchFavorites();
  const services = orderFavoriteServices(state?.services ?? [], favorites);
  const activeService = state?.surface?.kind === 'home' ? ''
    : state?.surface?.kind === 'service' ? state.surface.service : state?.service ?? '';
  const atHome = state?.surface?.kind === 'home';
  // Autoplay trailers on service home pages are not evidence that the user
  // started watching a title. Keep navigation stable until they choose a mode.
  React.useEffect(() => {
    setRemoteMode(state?.catalog_video ? 'playback' : 'browse');
  }, [hostKey(settings), activeService, state?.catalog_video?.id]);

  // A browser already running is not confirmation that it switched apps.
  const pendingConfirmed = state?.running === true && (
    pending === '__hub__' ? atHome
      : pending === activeService || pending === state?.catalog_video?.name
        || pending === '__web__' || pending === '__panel__'
  );
  React.useEffect(() => {
    if (!pending) return undefined;
    if (pendingConfirmed) {
      setPending(null);
      return undefined;
    }
    const timer = setTimeout(() => {
      setPending(null);
      setError('Couldn’t confirm the TV opened that screen. Try Home or open the app again.');
    }, 25_000);
    return () => clearTimeout(timer);
  }, [pending, pendingConfirmed]);
  // Which services can be searched is the BOX's answer, not a guess here:
  // a verified search URL exists for some services and not others.
  const searchable = state?.searchable ?? [];
  const recents = useWatchRecents();

  // Native media apps installed on the box (agent >= 2.9.110, cap `medialaunch`).
  // Polled independently of the web Player: a box can have Kodi without the
  // Couchside Player tile. A slow 20s cadence — the installed set rarely changes.
  const mediaAppsPoll = usePoll<MediaAppsState | null>(
    () => api.mediaApps(settings),
    20000,
    ready && configured,
    hostKey(settings),
  );
  const mediaApps = mediaAppsPoll.data?.apps ?? [];

  // Launch a native media app (optionally a named action like Kodi Fullscreen).
  // The box is the authority: an unknown id 404s having launched nothing. No
  // optimistic "running" card — native apps report no playback state back.
  const launchApp = useCallback(
    async (appId: string, actionId?: string) => {
      hapticLight();
      const token = `app:${appId}${actionId ? ':' + actionId : ''}`;
      setBusy(token);
      setError(null);
      try {
        const ok = await api.launchMediaApp(settings, appId, actionId);
        if (ok) hapticSuccess();
        else { hapticError(); setError('The box couldn’t launch that app.'); }
      } finally {
        setBusy(null);
      }
    },
    [settings],
  );

  // "APPS ON THE BOX" — the native media apps grid, rendered both on the full
  // Watch surface and on a box that has media apps but no web Player (so it is
  // built once here and dropped into both return sites).
  const mediaGrid = mediaApps.length > 0 ? (
    <>
      <Text style={styles.section}>APPS ON THE BOX</Text>
      <View style={styles.grid}>
        {mediaApps.map((appItem: MediaApp) => (
          <View key={appItem.id} style={styles.mediaCol}>
            <Pressable
              onPress={() => launchApp(appItem.id)}
              disabled={busy !== null}
              testID={`media-app-${appItem.id}`}
              style={({ pressed }) => [styles.tile, styles.mediaTile, pressed && styles.pressed]}
            >
              <View style={[styles.tileAccent, { backgroundColor: ACCENTS[appItem.id] ?? t.slate }]} />
              <Text style={styles.tileText}>
                {busy === `app:${appItem.id}` ? 'Opening…' : appItem.name}
              </Text>
            </Pressable>
            {appItem.actions.map((a) => (
              <Pressable
                key={a.id}
                onPress={() => launchApp(appItem.id, a.id)}
                disabled={busy !== null}
                testID={`media-action-${appItem.id}-${a.id}`}
                style={({ pressed }) => [styles.mediaAction, pressed && styles.pressed]}
              >
                <Text style={styles.mediaActionText} numberOfLines={1}>
                  {busy === `app:${appItem.id}:${a.id}` ? 'Opening…' : a.name}
                </Text>
              </Pressable>
            ))}
          </View>
        ))}
      </View>
    </>
  ) : null;

  const open = useCallback(
    async (service: string, path = '', query = '') => {
      hapticLight();
      setBusy(service);
      setError(null);
      try {
        // A query and a deep-link path are mutually exclusive, same as on the
        // box — sending both would leave the winner to the agent's read order.
        gpRef.current?.noteUserActivity();
        await api.playerOp(
          settings,
          'open',
          query ? { service, query } : path ? { service, path } : { service },
        );
        hapticSuccess();
        setPending(service);
        scrollRef.current?.scrollTo({ y: 0, animated: true });
        noteRecent({ service, query, path: query ? '' : path });
        setLink('');
        setQuery('');
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

  // Free-URL tier (agent §5 tier 3): only when the BOX opted in (open_url) does
  // the app offer opening an arbitrary web page. The box does the real
  // validation; looksLikeUrl is a client hint only, so a bad paste is refused
  // helpfully rather than sent.
  const canOpenAnyLink = state?.open_url === true;
  const openUrl = useCallback(
    async (url: string) => {
      hapticLight();
      setBusy('__url__');
      setError(null);
      try {
        await api.playerOp(settings, 'open', { url });
        hapticSuccess();
        setPending('__web__');
        scrollRef.current?.scrollTo({ y: 0, animated: true });
        setLink('');
        player.refresh();
      } catch (e) {
        hapticError();
        setError(
          `The box wouldn’t open that page. ${e instanceof Error ? e.message : ''}`.trim(),
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

  // The on-box quick panel (agent >= 2.9.113): Couchside's own vitals + quick
  // actions on the BOX's screen in Game Mode, without Decky. It rides the Player
  // tile, so the Stop button on the now-card closes it too, and /api/player
  // reports it as running with an empty service. Gated on the agent version the
  // status poll has LEARNED (settings.version, re-learned every poll) rather than
  // on a 404 at press time — the same degrade-closed rule as PIN pairing: an
  // unknown version hides the button instead of offering one that fails.
  const canShowPanel = supportsBoxPanel(settings.version);
  const showPanel = useCallback(async () => {
    hapticLight();
    setBusy('__panel__');
    setError(null);
    try {
      await api.panelOp(settings, 'open');
      hapticSuccess();
      setPending('__panel__');
      scrollRef.current?.scrollTo({ y: 0, animated: true });
      player.refresh();
    } catch (e) {
      hapticError();
      // A 404 here means the route is absent: the version gate was stale or the
      // box was downgraded. Name the fix rather than echoing "not found".
      setError(
        e instanceof ApiError && e.kind === 'http' && e.status === 404
          ? 'This box needs agent 2.9.113 or newer for the on-box panel.'
          : `The box wouldn’t open the panel. ${e instanceof Error ? e.message : ''}`.trim(),
      );
    } finally {
      setBusy(null);
    }
  }, [settings, player]);

  const parsedLink = useMemo(
    () =>
      link.trim()
        ? splitLink(link, state?.service_urls, state?.service_hosts)
        : null,
    [link, state?.service_urls, state?.service_hosts],
  );
  // A pasted string the box's free-URL tier could accept: an http(s) URL that
  // isn't already a known service (those take the deep-link path above). Client
  // hint only — the box validates scheme/host/port and refuses the rest.
  const webLink = useMemo(() => {
    const s = link.trim();
    return canOpenAnyLink && !parsedLink && /^https?:\/\/\S+$/i.test(s) ? s : null;
  }, [link, canOpenAnyLink, parsedLink]);

  const playback = state?.playback ?? null;
  // Offsets come from the BOX (seek_secs), so the app can never offer a value
  // the box would refuse. Smallest magnitude each way is what the buttons use.
  const offsets = state?.seek_secs ?? [];
  // Ordered by magnitude each way, e.g. [-10,-30,-90] / [10,30,90]. The button
  // TAP uses the smallest jump; a HOLD uses the next one up (the box's own next
  // allowlisted offset, ±30 on a typical box), so both still come only from
  // seek_secs — the app never invents an offset the box would refuse.
  const backSteps = offsets.filter((n) => n < 0).sort((a, b) => b - a);
  const fwdSteps = offsets.filter((n) => n > 0).sort((a, b) => a - b);
  const back = backSteps[0] ?? null;
  const fwd = fwdSteps[0] ?? null;
  const backHold = backSteps[1] ?? null;
  const fwdHold = fwdSteps[1] ?? null;

  const transport = useCallback(
    async (op: PlayerOp, opts: { secs?: number; value?: string } = {}) => {
      hapticLight();
      setBusy(op);
      setError(null);
      try {
        gpRef.current?.noteUserActivity();
        await api.playerOp(settings, op, opts);
        if (op === 'hub') {
          setPending('__hub__');
          scrollRef.current?.scrollTo({ y: 0, animated: true });
        }
        player.refresh();
      } catch (e) {
        hapticError();
        setError(e instanceof Error ? e.message : 'That control was refused.');
      } finally {
        setBusy(null);
      }
    },
    [settings, player],
  );

  const openCatalog = useCallback(async (videoId: string, name: string) => {
    hapticLight();
    setBusy('catalog');
    setError(null);
    try {
      await api.playerCatalogOpen(settings, videoId);
      setPending(name);
      scrollRef.current?.scrollTo({ y: 0, animated: true });
      player.refresh();
    } catch (e) {
      hapticError();
      setError(e instanceof Error ? e.message : 'Couldn’t start that video.');
    } finally {
      setBusy(null);
    }
  }, [settings, player]);

  const sendLink = useCallback(() => {
    if (parsedLink) { open(parsedLink.service, parsedLink.path); return; }
    if (webLink) openUrl(webLink);              // free-URL tier (box opted in)
  }, [parsedLink, webLink, open, openUrl]);

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
    // No web Player tile — but the box may still have native media apps to
    // launch (the two caps are independent). Show just their grid rather than a
    // dead-end "not installed" screen.
    if (mediaGrid) {
      return (
        <View style={styles.root}>
          <ScrollView style={styles.root} contentContainerStyle={styles.content}>
            {mediaGrid}
          </ScrollView>
        </View>
      );
    }
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
    <View style={styles.root}>
    <View style={styles.switcher} testID="watch-app-switcher">
      <Pressable onPress={() => transport('hub')} disabled={busy !== null}
        accessibilityRole="button" accessibilityLabel="Player Home on TV"
        testID="watch-home" style={styles.homeShortcut}>
        <Text style={styles.searchBtnText}>{busy === 'hub' ? 'Opening…' : '⌂ Home'}</Text>
      </Pressable>
      <ScrollView horizontal showsHorizontalScrollIndicator={false}
        onTouchStart={blockTabSwipe} directionalLockEnabled
        contentContainerStyle={styles.switcherServices}>
        {services.map((id) => (
          <Pressable key={id} onPress={() => open(id)} disabled={busy !== null}
            accessibilityRole="button" accessibilityLabel={`Open ${label(id)} on TV`}
            accessibilityState={{ selected: state.running && activeService === id }}
            testID={`watch-switch-${id}`} style={[styles.serviceShortcut,
              state.running && activeService === id && { borderColor: t.accent }]}>
            <Text style={styles.searchBtnText}>{busy === id ? 'Opening…' : `${favorites.includes(id) ? '★ ' : ''}${label(id)}`}</Text>
          </Pressable>
        ))}
      </ScrollView>
    </View>
    <ScrollView
      ref={scrollRef}
      style={styles.root}
      contentContainerStyle={styles.content}
      keyboardShouldPersistTaps="handled"
      scrollEnabled={!dpadGesture}
    >
      {state.running && !pending ? (
        <View
          style={[
            styles.nowCard,
            // Service-branded card: the accent the tile carries follows the
            // service onto the now-playing card, so Netflix feels like
            // Netflix's card and not a generic player shell.
            { borderLeftColor: ACCENTS[activeService] ?? t.accent, borderLeftWidth: 3 },
          ]}
          testID="watch-now-playing"
        >
          <View style={styles.nowTop}>
            <View style={{ flex: 1 }}>
              <Text
                style={[
                  styles.nowLabel,
                  { color: ACCENTS[activeService] ?? t.green },
                ]}
              >
                ON THE TV
              </Text>
              <Text style={styles.nowService}>
                {/* The panel and a free-URL page both report an empty service. */}
                {atHome ? 'Player Home' : state.catalog_video?.name ?? (activeService ? label(activeService) : 'The box’s own screen')}
              </Text>
              {playback?.title ? (
                <Text style={styles.nowPath} numberOfLines={1}>
                  {playback.title}
                </Text>
              ) : state.path ? (
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

          <View style={styles.btnRow} testID="watch-remote-mode">
            {(['browse', 'playback'] as const).map((mode) => (
              <Pressable key={mode} onPress={() => { hapticLight(); setRemoteMode(mode); }}
                accessibilityRole="button" accessibilityState={{ selected: remoteMode === mode }}
                testID={`watch-mode-${mode}`} disabled={mode === 'playback' && !playback}
                style={[styles.tBtn, remoteMode === mode && styles.tBtnMain]}>
                <Text style={[styles.tBtnText, remoteMode === mode && styles.tBtnMainText]}>
                  {mode === 'browse' ? 'Browse' : 'Playback'}
                </Text>
              </Pressable>
            ))}
          </View>

          {/* D-pad drives the page's focus ring (Netflix/YouTube tile grids,
              and any web page). Rides the existing uinput key path, so it shows
              for ANY open page — not gated on <video> like the scrubber below. */}
          <WatchDpad
            settings={settings}
            ready={ready}
            navOps={state.nav_ops}
            keyOps={state.key_ops}
            onGestureActive={setDpadGesture}
            client={gpRef.current}
            onKeyboard={kb.toggle}
            keyboardOpen={kb.open}
            // Explicit mode keeps service-home trailers from silently turning
            // browsing gestures into seek or volume commands.
            playing={remoteMode === 'playback'}
            onSeek={(dir) => {
              const secs = dir > 0 ? fwd : back;
              if (secs != null) transport('seek', { secs });
            }}
            onPlayPause={() => transport('playpause')}
            onVolume={(dir) => {
              hapticLight();
              void api
                .tvSend(
                  settings,
                  dir > 0 ? 'volume_up' : 'volume_down',
                  settings.volumeTarget ?? 'box',
                )
                .catch(() => {});
            }}
          />

          {/* TV zoom. Values come from the BOX (ui_scales — a frozen set), so
              the app can never offer a scale the box would refuse. Older
              agents don't send it and the row hides. */}
          {(state.ui_scales?.length ?? 0) > 0 && (
            <View style={styles.zoomRow} testID="watch-zoom">
              <Text style={styles.zoomLabel}>TV ZOOM</Text>
              <View style={styles.zoomChips}>
                {state.ui_scales!.map((v) => {
                  const on = v === (state.ui_scale ?? '');
                  return (
                    <Pressable
                      key={v}
                      onPress={() => transport('scale', { value: v })}
                      disabled={busy !== null}
                      testID={`watch-zoom-${v}`}
                      style={[styles.zoomChip, on && styles.zoomChipOn]}
                    >
                      <Text style={[styles.zoomText, on && styles.zoomTextOn]}>
                        {v}×
                      </Text>
                    </Pressable>
                  );
                })}
              </View>
            </View>
          )}

          {/* Transport appears only when the box reports a real <video>. A
              service that is open but sitting on its home screen has nothing to
              scrub, and a dead scrubber is worse than no scrubber. */}
          {playback ? (
            <View style={styles.transport} testID="watch-transport">
              {playback.error ? (
                <Text style={styles.error} accessibilityRole="alert" testID="watch-playback-error">
                  Playback failed: {playback.error.message}. Stop and retry.
                </Text>
              ) : null}
              <View style={styles.scrubRow}>
                <Text style={styles.time}>{fmtTime(playback.position)}</Text>
                <View style={styles.track}>
                  <View
                    style={[
                      styles.trackFill,
                      { width: `${progressPct(playback)}%` },
                    ]}
                  />
                </View>
                <Text style={styles.time}>
                  {playback.duration > 0 ? fmtTime(playback.duration) : 'LIVE'}
                </Text>
              </View>

              <View style={styles.btnRow}>
                {back != null && (
                  <Pressable
                    onPress={() => transport('seek', { secs: back })}
                    onLongPress={
                      backHold != null
                        ? () => {
                            hapticHeavy();
                            transport('seek', { secs: backHold });
                          }
                        : undefined
                    }
                    delayLongPress={MEDIA_HOLD_MS}
                    disabled={busy !== null}
                    testID="watch-seek-back"
                    accessibilityHint={
                      backHold != null
                        ? `Hold to jump back ${Math.abs(backHold)} seconds`
                        : undefined
                    }
                    style={({ pressed }) => [styles.tBtn, pressed && styles.pressed]}
                  >
                    <Text style={styles.tBtnText}>{back}s</Text>
                  </Pressable>
                )}
                <Pressable
                  onPress={() => transport('playpause')}
                  disabled={busy !== null}
                  testID="watch-playpause"
                  style={({ pressed }) => [
                    styles.tBtn,
                    styles.tBtnMain,
                    pressed && styles.pressed,
                  ]}
                >
                  <Text style={[styles.tBtnText, styles.tBtnMainText]}>
                    {playback.playing ? 'Pause' : 'Play'}
                  </Text>
                </Pressable>
                {fwd != null && (
                  <Pressable
                    onPress={() => transport('seek', { secs: fwd })}
                    onLongPress={
                      fwdHold != null
                        ? () => {
                            hapticHeavy();
                            transport('seek', { secs: fwdHold });
                          }
                        : undefined
                    }
                    delayLongPress={MEDIA_HOLD_MS}
                    disabled={busy !== null}
                    testID="watch-seek-fwd"
                    accessibilityHint={
                      fwdHold != null ? `Hold to jump forward ${fwdHold} seconds` : undefined
                    }
                    style={({ pressed }) => [styles.tBtn, pressed && styles.pressed]}
                  >
                    <Text style={styles.tBtnText}>+{fwd}s</Text>
                  </Pressable>
                )}
                <Pressable
                  onPress={() => transport('mute')}
                  disabled={busy !== null}
                  testID="watch-mute"
                  style={({ pressed }) => [styles.tBtn, pressed && styles.pressed]}
                >
                  <Text style={styles.tBtnText}>
                    {playback.muted ? 'Unmute' : 'Mute'}
                  </Text>
                </Pressable>
              </View>

            </View>
          ) : null}
        </View>
      ) : pending ? (
        <View
          style={[
            styles.nowCard,
            {
              borderLeftColor:
                pending === '__web__' ? t.accent : (ACCENTS[pending] ?? t.accent),
              borderLeftWidth: 3,
            },
          ]}
          testID="watch-starting"
        >
          <View style={styles.nowTop}>
            <View style={{ flex: 1 }}>
              <Text
                style={[
                  styles.nowLabel,
                  {
                    color:
                      pending === '__web__' ? t.accent : (ACCENTS[pending] ?? t.green),
                  },
                ]}
              >
                STARTING
              </Text>
              <Text style={styles.nowService}>
                {pending === '__hub__' ? 'Player Home' : pending === '__web__' ? 'Web page' : pending === '__panel__' ? 'Couchside panel' : label(pending)}
              </Text>
              <Text style={styles.nowPath}>Opening on the TV…</Text>
            </View>
          </View>
        </View>
      ) : (
        <Text style={styles.idle}>Nothing playing. Pick a service.</Text>
      )}

      {error ? <Text style={styles.error}>{error}</Text> : null}

      <Text style={styles.beta} testID="watch-beta">
        EXPERIMENTAL — expect rough edges. Swipe the pad above to move between
        tiles once a page is open.
      </Text>

      {/* The box's own screen. Useful when the phone is not the thing in your
          hand — someone opening the tile from the Steam library with a
          controller gets a grid with a focus ring instead of whatever service
          happened to be configured last. */}
      <Pressable
        onPress={() => transport('hub')}
        disabled={busy !== null}
        testID="watch-hub"
        style={({ pressed }) => [styles.hubBtn, pressed && styles.pressed]}
      >
        <Text style={styles.hubBtnText}>
          {busy === 'hub' ? 'Opening…' : 'Show the home screen on the TV'}
        </Text>
      </Pressable>

      {/* Couchside's own panel on the box's screen — vitals + quick actions in
          Game Mode with no Decky. Hidden until the status poll has learned an
          agent version that serves it (supportsBoxPanel). */}
      {canShowPanel ? (
        <Pressable
          onPress={showPanel}
          disabled={busy !== null}
          testID="watch-panel"
          style={({ pressed }) => [styles.hubBtn, pressed && styles.pressed]}
        >
          <Text style={styles.hubBtnText}>
            {busy === '__panel__' ? 'Opening…' : 'Show the Couchside panel on the TV'}
          </Text>
        </Pressable>
      ) : null}

      {recents.length > 0 && (
        <>
          <View style={styles.sectionRow}>
            <Text style={styles.section}>RECENT</Text>
            <Pressable
              onPress={() => {
                hapticLight();
                clearRecents();
              }}
              hitSlop={10}
              testID="watch-recents-clear"
            >
              <Text style={styles.clearText}>Clear</Text>
            </Pressable>
          </View>
          <View style={styles.grid} testID="watch-recents">
            {recents.map((r) => (
              <Pressable
                key={`${r.service}|${r.query}|${r.path}`}
                onPress={() => open(r.service, r.path, r.query)}
                disabled={busy !== null}
                testID={`watch-recent-${r.service}`}
                style={({ pressed }) => [styles.searchBtn, pressed && styles.pressed]}
              >
                <Text style={styles.searchBtnText} numberOfLines={1}>
                  {r.query ? `${label(r.service)}: ${r.query}` : label(r.service)}
                </Text>
              </Pressable>
            ))}
          </View>
        </>
      )}

      {/* SEARCH. There is no metadata service behind this and no API key: you
          type on the phone, pick a service, and the box opens that service's
          own search results. It exists because typing a title on a TV with a
          d-pad is miserable. Only services with a VERIFIED search URL are
          offered — the box says which. */}
      {searchable.length > 0 && (
        <>
          <Text style={styles.section}>SEARCH ON THE BOX</Text>
          <TextInput
            value={query}
            onChangeText={setQuery}
            placeholder="Title to search for"
            placeholderTextColor={t.textFaint}
            autoCorrect={false}
            returnKeyType="search"
            maxLength={80}
            style={styles.input}
            testID="watch-search-input"
          />
          {query.trim() ? (
            <View style={styles.grid} testID="watch-search-targets">
              {searchable.map((id) => (
                <Pressable
                  key={id}
                  onPress={() => open(id, '', query.trim())}
                  disabled={busy !== null}
                  testID={`watch-search-${id}`}
                  style={({ pressed }) => [
                    styles.searchBtn,
                    pressed && styles.pressed,
                  ]}
                >
                  <Text style={styles.searchBtnText}>
                    {busy === id ? 'Opening…' : `Search ${label(id)}`}
                  </Text>
                </Pressable>
              ))}
            </View>
          ) : null}
        </>
      )}

      <Text style={styles.section}>SEND A LINK</Text>
      <View style={styles.linkRow}>
        <TextInput
          value={link}
          onChangeText={setLink}
          placeholder={canOpenAnyLink ? 'Paste a service link or any web page' : 'Paste a link from a service'}
          placeholderTextColor={t.textFaint}
          autoCapitalize="none"
          autoCorrect={false}
          inputMode="url"
          style={styles.input}
          testID="watch-link-input"
        />
        <Pressable
          onPress={sendLink}
          disabled={!(parsedLink || webLink) || busy !== null}
          testID="watch-link-send"
          style={({ pressed }) => [
            styles.sendBtn,
            !(parsedLink || webLink) && styles.sendBtnOff,
            pressed && styles.pressed,
          ]}
        >
          <Text style={[styles.sendText, !(parsedLink || webLink) && styles.sendTextOff]}>
            {webLink ? 'Open' : 'Send'}
          </Text>
        </Pressable>
      </View>
      {link.trim() && !parsedLink && !webLink ? (
        <Text style={styles.hint} testID="watch-link-hint">
          {canOpenAnyLink
            ? 'Paste a service link, or a full http(s) web address to open on the box.'
            : 'That isn’t a link from a service this box knows.'}
        </Text>
      ) : null}
      {webLink ? (
        <Text style={styles.hintOk} testID="watch-weblink-ok">
          Opens as a web page on the box.
        </Text>
      ) : null}
      {parsedLink ? (
        <Text style={styles.hintOk} testID="watch-link-ok">
          Opens on {label(parsedLink.service)}
          {parsedLink.path ? ' at that title' : ''}.
        </Text>
      ) : null}

      {mediaGrid}

      {state.catalog ? (
        <View testID="watch-catalog">
          <Text style={styles.section}>{state.catalog.name.toUpperCase()}</Text>
          {state.catalog.metas.map((video) => (
            <View key={video.id} style={styles.nowCard}>
              <Text style={styles.tileText}>{video.name}</Text>
              <Text style={styles.hint}>{video.description}</Text>
              <Text style={styles.hint}>{video.credit}</Text>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`Play ${video.name} on TV`}
                testID="watch-catalog-play"
                disabled={busy !== null}
                onPress={() => openCatalog(video.id, video.name)}
                style={({ pressed }) => [styles.tile, pressed && styles.pressed]}
              >
                <Text style={styles.tileText}>{busy === 'catalog' ? 'Opening…' : 'Play on TV'}</Text>
              </Pressable>
            </View>
          ))}
        </View>
      ) : null}

      <Text style={styles.section}>SERVICES</Text>
      <Text style={{ color: t.textFaint }}>Hold an app to add or remove it from favorites.</Text>
      <View style={styles.grid}>
        {services.map((id) => {
          const active = state.running && activeService === id;
          return (
            <Pressable
              key={id}
              onPress={() => open(id)}
              disabled={busy !== null}
              testID={`watch-service-${id}`}
              onLongPress={() => { toggleWatchFavorite(id); hapticLight(); }}
              accessibilityRole="button"
              accessibilityHint="Hold to add or remove favorite"
              style={({ pressed }) => [
                styles.tile,
                active && styles.tileActive,
                pressed && styles.pressed,
              ]}
            >
              <View
                style={[
                  styles.tileAccent,
                  { backgroundColor: ACCENTS[id] ?? t.slate },
                ]}
              />
              <Text style={[styles.tileText, active && styles.tileTextActive]}>
                {busy === id ? 'Opening…' : `${favorites.includes(id) ? '★ ' : ''}${label(id)}`}
              </Text>
            </Pressable>
          );
        })}
      </View>
    </ScrollView>
    {/* Phone-keyboard compose bar: absolute at panel root so its keyboard-lift
        math sees the screen, not a card inside the scroll. */}
    {kb.bar}
    </View>
  );
}

const makeStyles = (t: Palette) =>
  StyleSheet.create({
    root: { flex: 1 },
    switcher: { flexDirection: 'row', gap: 8, padding: 12, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: t.cardBorder },
    homeShortcut: { justifyContent: 'center', paddingHorizontal: 14, minHeight: 44, backgroundColor: t.card, borderRadius: 12 },
    switcherServices: { gap: 8 },
    serviceShortcut: { justifyContent: 'center', paddingHorizontal: 14, minHeight: 44, backgroundColor: t.card, borderRadius: 12, borderWidth: 1, borderColor: t.cardBorder },
    content: { padding: 16, paddingBottom: 48, gap: 12 },
    empty: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32, gap: 8 },
    emptyTitle: { color: t.text, fontSize: 17, fontWeight: '700' },
    emptyBody: { color: t.textDim, fontSize: 14, textAlign: 'center', lineHeight: 20 },
    idle: { color: t.textDim, fontSize: 14 },
    beta: { color: t.amber, fontSize: 11, lineHeight: 15 },
    section: {
      color: t.textFaint,
      fontSize: 11,
      fontWeight: '700',
      letterSpacing: 1.2,
      marginTop: 8,
    },
    nowCard: {
      gap: 12,
      backgroundColor: t.card,
      borderColor: t.cardBorder,
      borderWidth: StyleSheet.hairlineWidth,
      borderRadius: 12,
      padding: 14,
    },
    nowTop: { flexDirection: 'row', alignItems: 'center', gap: 12 },
    transport: {
      gap: 10,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: t.cardBorder,
      paddingTop: 12,
    },
    scrubRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
    time: { color: t.textFaint, fontSize: 11, minWidth: 46 },
    track: {
      flex: 1,
      height: 4,
      borderRadius: 2,
      backgroundColor: t.inset,
      overflow: 'hidden',
    },
    trackFill: { height: 4, backgroundColor: t.accent },
    btnRow: { flexDirection: 'row', gap: 8 },
    tBtn: {
      flex: 1,
      alignItems: 'center',
      paddingVertical: 11,
      borderRadius: 10,
      backgroundColor: t.inset,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: t.cardBorder,
    },
    tBtnMain: { backgroundColor: t.accent, borderColor: t.accent },
    tBtnText: { color: t.text, fontSize: 13, fontWeight: '600' },
    tBtnMainText: { color: t.onAccent, fontWeight: '700' },
    nowLabel: { color: t.green, fontSize: 10, fontWeight: '700', letterSpacing: 1.2 },
    zoomRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 10,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: t.cardBorder,
      paddingTop: 12,
    },
    zoomLabel: { color: t.textFaint, fontSize: 11, fontWeight: '700', letterSpacing: 1.2 },
    zoomChips: { flexDirection: 'row', gap: 6, flex: 1, justifyContent: 'flex-end' },
    zoomChip: {
      paddingHorizontal: 10,
      paddingVertical: 6,
      borderRadius: 8,
      backgroundColor: t.inset,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: t.cardBorder,
    },
    zoomChipOn: { backgroundColor: t.accent, borderColor: t.accent },
    zoomText: { color: t.textDim, fontSize: 12, fontWeight: '600' },
    zoomTextOn: { color: t.onAccent, fontWeight: '700' },
    nowService: { color: t.text, fontSize: 20, fontWeight: '700', marginTop: 2 },
    nowPath: { color: t.textFaint, fontSize: 12, marginTop: 2 },
    stopBtn: {
      paddingHorizontal: 18,
      paddingVertical: 10,
      borderRadius: 10,
      backgroundColor: t.redDeep,
    },
    // '#fff' here was 1.45:1 on light's redDeep — an invisible Stop label.
    stopText: { color: t.onRedDeep, fontWeight: '700', fontSize: 14 },
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
    sendText: { color: t.onAccent, fontWeight: '700', fontSize: 14 },
    sendTextOff: { color: t.textFaint },
    searchBtn: {
      flexGrow: 1,
      minWidth: '46%',
      alignItems: 'center',
      paddingVertical: 12,
      borderRadius: 10,
      backgroundColor: t.inset,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: t.cardBorder,
    },
    searchBtnText: { color: t.text, fontSize: 13, fontWeight: '600' },
    hubBtn: {
      alignItems: 'center',
      paddingVertical: 12,
      borderRadius: 10,
      backgroundColor: t.inset,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: t.cardBorder,
    },
    hubBtnText: { color: t.textDim, fontSize: 13, fontWeight: '600' },
    sectionRow: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
    },
    clearText: { color: t.textDim, fontSize: 12, fontWeight: '600' },
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
    tileAccent: {
      width: 26,
      height: 4,
      borderRadius: 2,
      marginBottom: 8,
    },
    tileText: { color: t.text, fontSize: 14, fontWeight: '600', textAlign: 'center' },
    // A media app + its optional action chips stacked in one grid cell.
    mediaCol: { minWidth: '30%', flexGrow: 1, gap: 6 },
    mediaTile: { minWidth: undefined, flexGrow: undefined, width: '100%' },
    mediaAction: {
      alignItems: 'center', justifyContent: 'center',
      paddingVertical: 9, paddingHorizontal: 8, borderRadius: 9,
      backgroundColor: t.inset, borderColor: t.cardBorder, borderWidth: StyleSheet.hairlineWidth,
    },
    mediaActionText: { color: t.textDim, fontSize: 12, fontWeight: '600' },
    tileTextActive: { color: t.green },
    pressed: { opacity: 0.7 },
  });
