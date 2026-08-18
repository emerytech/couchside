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
import { api, hostKey, PlayerOp, PlayerPlayback, PlayerState } from '@/lib/api';
import { hapticError, hapticLight, hapticSuccess } from '@/lib/haptics';
import { useSettings } from '@/lib/SettingsContext';
import { clearRecents, noteRecent, useWatchRecents } from '@/lib/watchRecents';
import { useTheme, useThemedStyles, type Palette } from '@/lib/theme';
import { WatchDpad } from '@/components/WatchDpad';
import { useDesktopKeyboard } from '@/components/DesktopKeyboard';
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
  const services = state?.services ?? [];

  // Poll confirmed the player is up (or it never came up): drop the optimism.
  React.useEffect(() => {
    if (!pending) return undefined;
    if (state?.running) {
      setPending(null);
      return undefined;
    }
    const timer = setTimeout(() => setPending(null), 25_000);
    return () => clearTimeout(timer);
  }, [pending, state?.running]);
  // Which services can be searched is the BOX's answer, not a guess here:
  // a verified search URL exists for some services and not others.
  const searchable = state?.searchable ?? [];
  const recents = useWatchRecents();

  const open = useCallback(
    async (service: string, path = '', query = '') => {
      hapticLight();
      setBusy(service);
      setError(null);
      try {
        // A query and a deep-link path are mutually exclusive, same as on the
        // box — sending both would leave the winner to the agent's read order.
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
  const back = offsets.filter((n) => n < 0).sort((a, b) => b - a)[0] ?? null;
  const fwd = offsets.filter((n) => n > 0).sort((a, b) => a - b)[0] ?? null;

  const transport = useCallback(
    async (op: PlayerOp, opts: { secs?: number; value?: string } = {}) => {
      hapticLight();
      setBusy(op);
      setError(null);
      try {
        await api.playerOp(settings, op, opts);
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
    <ScrollView
      ref={scrollRef}
      style={styles.root}
      contentContainerStyle={styles.content}
      keyboardShouldPersistTaps="handled"
      scrollEnabled={!dpadGesture}
    >
      {state.running ? (
        <View
          style={[
            styles.nowCard,
            // Service-branded card: the accent the tile carries follows the
            // service onto the now-playing card, so Netflix feels like
            // Netflix's card and not a generic player shell.
            { borderLeftColor: ACCENTS[state.service ?? ''] ?? t.accent, borderLeftWidth: 3 },
          ]}
          testID="watch-now-playing"
        >
          <View style={styles.nowTop}>
            <View style={{ flex: 1 }}>
              <Text
                style={[
                  styles.nowLabel,
                  { color: ACCENTS[state.service ?? ''] ?? t.green },
                ]}
              >
                ON THE TV
              </Text>
              <Text style={styles.nowService}>{label(state.service)}</Text>
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

          {/* D-pad drives the page's focus ring (Netflix/YouTube tile grids,
              and any web page). Rides the existing uinput key path, so it shows
              for ANY open page — not gated on <video> like the scrubber below. */}
          <WatchDpad
            settings={settings}
            ready={ready}
            navOps={state.nav_ops}
            onGestureActive={setDpadGesture}
            client={gpRef.current}
            onKeyboard={kb.toggle}
            keyboardOpen={kb.open}
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
                    disabled={busy !== null}
                    testID="watch-seek-back"
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
                    disabled={busy !== null}
                    testID="watch-seek-fwd"
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
                {pending === '__web__' ? 'Web page' : label(pending)}
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
              <View
                style={[
                  styles.tileAccent,
                  { backgroundColor: ACCENTS[id] ?? t.slate },
                ]}
              />
              <Text style={[styles.tileText, active && styles.tileTextActive]}>
                {busy === id ? 'Opening…' : label(id)}
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
    tBtnMainText: { color: '#0b1220', fontWeight: '700' },
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
    zoomTextOn: { color: '#0b1220', fontWeight: '700' },
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
    sendText: { color: '#0b1220', fontWeight: '700', fontSize: 14 },
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
    tileTextActive: { color: t.green },
    pressed: { opacity: 0.7 },
  });
