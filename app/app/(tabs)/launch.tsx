/**
 * Launch tab: a grid of game/app tiles the box can launch. Steam games show
 * their library cover art (with a graceful text-card fallback on image error);
 * custom launchers are user-defined argv commands that can be added and
 * deleted here. Tapping a tile launches it (haptic + brief toast).
 */
import Ionicons from '@expo/vector-icons/Ionicons';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Image,
  Modal,
  Platform,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  useWindowDimensions,
  View,
} from 'react-native';

import { Gated } from '@/components/Gated';
import { TabScreen } from '@/components/TabScreen';
import { useLockOrientation } from '@/hooks/useLockOrientation';
import { usePoll } from '@/hooks/usePoll';
import {
  api,
  Downloads,
  hostKey,
  ImageSource,
  isActiveDownload,
  Launcher,
  SteamDownload,
  SteamLink,
} from '@/lib/api';
import { hapticError, hapticLight, hapticMedium, hapticSuccess } from '@/lib/haptics';
import { useSettings } from '@/lib/SettingsContext';
import { mono, useTheme, useThemedStyles, type Palette } from '@/lib/theme';

/** Cross-platform confirm (Alert buttons are no-ops on web). */
function confirmDelete(label: string, onConfirm: () => void) {
  if (Platform.OS === 'web') {
    // eslint-disable-next-line no-alert
    if (typeof window !== 'undefined' && window.confirm(`Delete "${label}"?`)) onConfirm();
    return;
  }
  Alert.alert('Delete launcher', `Delete "${label}"?`, [
    { text: 'Cancel', style: 'cancel' },
    { text: 'Delete', style: 'destructive', onPress: onConfirm },
  ]);
}

// ---------- Tile ----------

type TileProps = {
  launcher: Launcher;
  width: number;
  /** Agent-served cover art, present for Steam tiles; undefined shows the text card. */
  coverSource?: ImageSource;
  /** Bumped on pull-to-refresh to retry a cover that previously failed to load. */
  retryKey?: number;
  onLaunch: () => void;
  onDelete?: () => void;
  /** When this game is mid-download, drives a small progress pill on the tile. */
  download?: SteamDownload;
};

function LauncherTile({
  launcher,
  width,
  coverSource,
  retryKey,
  onLaunch,
  onDelete,
  download,
}: TileProps) {
  const t = useTheme();
  const styles = useThemedStyles(makeStyles);
  const [imgFailed, setImgFailed] = useState(false);
  // A failed cover latches to the text card so <Image> doesn't error-loop; clear
  // the latch when the URL changes (e.g. the app healed to the box's cached IP)
  // or the user pull-to-refreshes, so a recovered / newly-cached cover repaints.
  const uri = coverSource?.uri;
  useEffect(() => {
    setImgFailed(false);
  }, [uri, retryKey]);
  // Narrowed to a local so the <Image> branch sees a defined source (not the
  // `ImageSource | undefined` prop): shown only for Steam tiles that haven't errored.
  const art = imgFailed ? undefined : coverSource;
  const showArt = art != null;
  const height = Math.round(width * 1.5); // 600x900 aspect

  return (
    <Pressable
      onPress={onLaunch}
      style={({ pressed }) => [styles.tile, { width, height }, pressed && styles.tilePressed]}>
      {art ? (
        <Image
          source={art}
          style={styles.tileArt}
          resizeMode="cover"
          onError={() => setImgFailed(true)}
        />
      ) : (
        <View style={styles.tileFallback}>
          <Ionicons
            name={launcher.kind === 'steam' ? 'game-controller' : 'rocket'}
            size={32}
            color={t.textFaint}
          />
          <Text style={styles.tileFallbackLabel} numberOfLines={3}>
            {launcher.label}
          </Text>
        </View>
      )}

      {/* Label overlay for art tiles keeps the name legible. */}
      {showArt && (
        <View style={styles.tileLabelOverlay}>
          <Text style={styles.tileLabel} numberOfLines={1}>
            {launcher.label}
          </Text>
        </View>
      )}

      {download && isActiveDownload(download) && (
        <View style={styles.tilePill}>
          <Ionicons
            name={download.state === 'paused' ? 'pause' : 'cloud-download'}
            size={11}
            color={download.state === 'paused' ? t.amber : t.blue}
          />
          <Text style={styles.tilePillText}>{download.percent}%</Text>
        </View>
      )}
      {download && !isActiveDownload(download) && (
        <View style={[styles.tilePill, styles.tilePillQueued]}>
          <Ionicons name="time-outline" size={11} color={t.textDim} />
          <Text style={[styles.tilePillText, { color: t.textDim }]}>queued</Text>
        </View>
      )}

      {onDelete && (
        <Pressable
          onPress={onDelete}
          hitSlop={10}
          style={({ pressed }) => [styles.tileDelete, pressed && styles.pressed]}>
          <Ionicons name="trash" size={16} color={t.red} />
        </Pressable>
      )}
    </Pressable>
  );
}

/** GB with one decimal (Steam's own display convention). */
function fmtGB(bytes: number): string {
  return (bytes / 1e9).toFixed(1);
}

function DownloadRow({ d }: { d: SteamDownload }) {
  const t = useTheme();
  const styles = useThemedStyles(makeStyles);
  const paused = d.state === 'paused';
  const fill = paused ? t.amber : t.blue;
  const pct = Math.max(0, Math.min(100, d.percent));
  return (
    <View style={styles.dlRow}>
      <View style={styles.dlTop}>
        <Text style={styles.dlName} numberOfLines={1}>
          {d.name}
        </Text>
        <Text style={styles.dlPct}>{d.percent}%</Text>
      </View>
      <View style={styles.dlTrack}>
        <View style={[styles.dlFill, { width: `${Math.max(2, pct)}%`, backgroundColor: fill }]} />
      </View>
      <View style={styles.dlMeta}>
        <Text style={[styles.dlState, paused && { color: t.amber }]}>
          {d.state.toUpperCase()}
        </Text>
        {d.bytes_total > 0 && (
          <Text style={styles.dlBytes}>
            {fmtGB(d.bytes_downloaded)} / {fmtGB(d.bytes_total)} GB
          </Text>
        )}
      </View>
    </View>
  );
}

/** A queued (pending, not-moving) update — compact, dimmed, no fake progress. */
function QueuedRow({ d }: { d: SteamDownload }) {
  const styles = useThemedStyles(makeStyles);
  return (
    <View style={styles.qRow}>
      <Text style={styles.qName} numberOfLines={1}>
        {d.name}
      </Text>
      {d.bytes_total > 0 && <Text style={styles.qSize}>{fmtGB(d.bytes_total)} GB</Text>}
    </View>
  );
}

/**
 * Steam downloads above the launcher grid. Splits what's ACTUALLY transferring
 * now (full progress rows) from Steam's queued/pending-update backlog (compact,
 * collapsed by default) — the backlog otherwise reads as downloads stuck for
 * days. Hidden when nothing is downloading or queued.
 */
function DownloadsSection({ downloads }: { downloads: SteamDownload[] }) {
  const t = useTheme();
  const styles = useThemedStyles(makeStyles);
  const [showQueue, setShowQueue] = useState(false);
  if (downloads.length === 0) return null;
  const active = downloads.filter(isActiveDownload);
  const queued = downloads.filter((d) => !isActiveDownload(d));
  return (
    <View style={styles.dlCard}>
      {active.length > 0 && (
        <>
          <View style={styles.dlHeader}>
            <Ionicons name="cloud-download" size={14} color={t.blue} />
            <Text style={styles.dlHeaderText}>DOWNLOADING</Text>
          </View>
          {active.map((d) => (
            <DownloadRow key={d.appid} d={d} />
          ))}
        </>
      )}
      {queued.length > 0 && (
        <>
          <Pressable
            onPress={() => {
              hapticLight();
              setShowQueue((v) => !v);
            }}
            style={({ pressed }) => [
              styles.dlHeader,
              active.length > 0 && styles.dlHeaderGap,
              pressed && styles.pressed,
            ]}>
            <Ionicons name="time-outline" size={13} color={t.textDim} />
            <Text style={[styles.dlHeaderText, { color: t.textDim }]}>
              QUEUED · {queued.length}
            </Text>
            <Ionicons
              name={showQueue ? 'chevron-up' : 'chevron-down'}
              size={14}
              color={t.textDim}
            />
          </Pressable>
          {showQueue && queued.map((d) => <QueuedRow key={d.appid} d={d} />)}
        </>
      )}
    </View>
  );
}

/**
 * Steam Remote Play — "Stream from PC". Games another Steam machine on the LAN
 * offers to stream (grouped by host, freshest host expanded). Tapping a game
 * fires steam://rungameid on the box, which streams it natively — no Steam Link
 * app to install. Probe-and-appear: the parent renders this only when the box
 * reports at least one host. Covers aren't shown (host-only games have no local
 * capsule), so it's a compact list rather than the cover grid below.
 */
function SteamLinkSection({
  data,
  onStream,
}: {
  data: SteamLink;
  onStream: (appid: number, label: string) => void;
}) {
  const t = useTheme();
  const styles = useThemedStyles(makeStyles);
  // Expand the most-recently-seen host by default; the rest start collapsed.
  const [expanded, setExpanded] = useState<Record<string, boolean>>(() =>
    data.hosts.length ? { [data.hosts[0].host]: true } : {},
  );
  if (data.hosts.length === 0) return null;
  return (
    <View style={styles.dlCard}>
      <View style={styles.dlHeader}>
        <Ionicons name="tv-outline" size={14} color={t.blue} />
        <Text style={styles.dlHeaderText}>STREAM FROM PC</Text>
      </View>
      <Text style={styles.slHint}>
        Play a game from another Steam PC on your network. Make sure it&rsquo;s powered on and
        running Steam.
      </Text>
      {data.hosts.map((h, i) => {
        const open = !!expanded[h.host];
        return (
          <View key={h.host} style={i > 0 ? styles.dlHeaderGap : undefined}>
            <Pressable
              onPress={() => {
                hapticLight();
                setExpanded((e) => ({ ...e, [h.host]: !e[h.host] }));
              }}
              style={({ pressed }) => [styles.slHostHeader, pressed && styles.pressed]}>
              <Ionicons name="desktop-outline" size={14} color={t.textDim} />
              <Text style={styles.slHostName} numberOfLines={1}>
                {h.host}
              </Text>
              <Text style={styles.slHostCount}>{h.games.length}</Text>
              <Ionicons name={open ? 'chevron-up' : 'chevron-down'} size={14} color={t.textDim} />
            </Pressable>
            {open &&
              h.games.map((g) => (
                <Pressable
                  key={g.appid}
                  onPress={() => onStream(g.appid, g.label)}
                  style={({ pressed }) => [styles.slGameRow, pressed && styles.pressed]}>
                  <Ionicons name="play-circle" size={16} color={t.blue} />
                  <Text style={styles.slGameName} numberOfLines={1}>
                    {g.label}
                  </Text>
                </Pressable>
              ))}
          </View>
        );
      })}
    </View>
  );
}

// ---------- Add-launcher form ----------

type AddFormProps = {
  visible: boolean;
  onClose: () => void;
  onSubmit: (label: string, cmd: string[]) => Promise<void>;
};

function AddLauncherForm({ visible, onClose, onSubmit }: AddFormProps) {
  const t = useTheme();
  const styles = useThemedStyles(makeStyles);
  const [label, setLabel] = useState('');
  const [cmd, setCmd] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reset = useCallback(() => {
    setLabel('');
    setCmd('');
    setError(null);
    setBusy(false);
  }, []);

  const close = useCallback(() => {
    reset();
    onClose();
  }, [reset, onClose]);

  const submit = useCallback(async () => {
    const trimmedLabel = label.trim();
    // Split the command on whitespace into an argv list.
    const argv = cmd.trim().split(/\s+/).filter(Boolean);
    if (!trimmedLabel) {
      setError('Enter a label.');
      return;
    }
    if (argv.length === 0) {
      setError('Enter a command to run.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await onSubmit(trimmedLabel, argv);
      reset();
      onClose();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  }, [label, cmd, onSubmit, reset, onClose]);

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={close}>
      <Pressable style={styles.backdrop} onPress={close}>
        <Pressable style={styles.formCard} onPress={() => {}}>
          <Text style={styles.formTitle}>Add custom launcher</Text>

          <Text style={styles.formLabel}>Label</Text>
          <TextInput
            value={label}
            onChangeText={setLabel}
            placeholder="e.g. RetroArch"
            placeholderTextColor={t.textFaint}
            style={styles.input}
            autoCapitalize="none"
            autoCorrect={false}
          />

          <Text style={styles.formLabel}>Command</Text>
          <TextInput
            value={cmd}
            onChangeText={setCmd}
            placeholder="e.g. flatpak run org.libretro.RetroArch"
            placeholderTextColor={t.textFaint}
            style={styles.input}
            autoCapitalize="none"
            autoCorrect={false}
          />
          <Text style={styles.formHint}>Split on spaces into an argv list.</Text>

          {error && <Text style={styles.formError}>{error}</Text>}

          <View style={styles.formButtons}>
            <Pressable
              onPress={close}
              style={({ pressed }) => [styles.formBtn, pressed && styles.pressed]}>
              <Text style={styles.formBtnText}>Cancel</Text>
            </Pressable>
            <Pressable
              onPress={submit}
              disabled={busy}
              style={({ pressed }) => [
                styles.formBtn,
                styles.formBtnPrimary,
                (pressed || busy) && styles.pressed,
              ]}>
              {busy ? (
                <ActivityIndicator color={t.bg} size="small" />
              ) : (
                <Text style={[styles.formBtnText, styles.formBtnTextPrimary]}>Add</Text>
              )}
            </Pressable>
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

// ---------- Screen ----------

export default function LaunchTab() {
  useLockOrientation('portrait');
  return (
    <TabScreen>
      <Gated>
        <LaunchScreen />
      </Gated>
    </TabScreen>
  );
}

/** Toast lives ~1.5s. */
const TOAST_MS = 1500;

function LaunchScreen() {
  const t = useTheme();
  const styles = useThemedStyles(makeStyles);
  const { settings, ready } = useSettings();
  const { width } = useWindowDimensions();
  const [addOpen, setAddOpen] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  // Bumped on pull-to-refresh so tiles retry any cover that failed to load.
  const [retryKey, setRetryKey] = useState(0);

  // No host yet (fresh install): don't poll, and show the pairing hint instead
  // of a red "Box unreachable" banner retrying every 2s against http://:8787.
  const configured = settings.host.trim().length > 0;

  const boxKey = hostKey(settings); // resetKey: clear stale data on box switch
  const list = usePoll<{ launchers: Launcher[] }>(
    () => api.launchers(settings),
    30000,
    ready && configured,
    boxKey,
  );

  const showToast = useCallback((msg: string) => {
    setToast(msg);
    setTimeout(() => setToast((cur) => (cur === msg ? null : cur)), TOAST_MS);
  }, []);

  // ---- Steam downloads (probe-and-appear; api.downloads() 404 -> null hides it) ----
  // `active` is declared BEFORE the poll that reads it (avoids a TDZ self-ref)
  // and flipped by the effect below; poll fast while something is downloading.
  const [active, setActive] = useState(false);
  const dl = usePoll<Downloads | null>(
    () => api.downloads(settings), active ? 5000 : 20000, ready && configured, boxKey);
  const downloads = useMemo(() => dl.data?.downloads ?? [], [dl.data]);

  // ---- Steam Remote Play "Stream from PC" (probe-and-appear; 404 -> null) ----
  const sl = usePoll<SteamLink | null>(
    () => api.steamlink(settings), 30000, ready && configured, boxKey);
  const steamlink = sl.data;
  const dlByAppid = useMemo(() => new Map(downloads.map((d) => [d.appid, d])), [downloads]);

  // Completion: an appid seen downloading/paused this session that then vanishes
  // from the list has finished — toast once and pull the game into the grid.
  const prevDl = useRef<Map<number, SteamDownload>>(new Map());
  const observedDl = useRef<Set<number>>(new Set());
  useEffect(() => {
    // Poll fast only while something is genuinely transferring — a static queue
    // of pending updates shouldn't hammer the box every 5s.
    setActive(downloads.some(isActiveDownload));
    const curIds = new Set(downloads.map((d) => d.appid));
    for (const d of downloads) {
      // Only track truly-active downloads for the "finished" toast; a queued
      // entry vanishing is a cancel/dequeue, not a completion.
      if (isActiveDownload(d)) observedDl.current.add(d.appid);
    }
    for (const [appid, prev] of prevDl.current) {
      if (!curIds.has(appid) && observedDl.current.has(appid)) {
        observedDl.current.delete(appid);
        // Disappearance means finished OR cancelled (the agent lists an app only
        // while an op runs). Only claim "finished" when it vanished near-complete;
        // a mid-progress vanish is a cancel/removal. Refresh either way so the
        // grid reflects the new install (or the cancellation).
        if (prev.percent >= 90 || prev.state === 'finalizing') {
          showToast(`${prev.name} finished downloading`);
        }
        list.refresh();
      }
    }
    prevDl.current = new Map(downloads.map((d) => [d.appid, d]));
    // showToast + list.refresh are stable; keying on `downloads` only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [downloads]);

  // Two columns with padding; each tile ~ half the content width.
  const COLS = 2;
  const H_PAD = 14;
  const GAP = 12;
  const tileWidth = Math.floor((width - H_PAD * 2 - GAP * (COLS - 1)) / COLS);

  const launch = useCallback(
    async (l: Launcher) => {
      hapticMedium();
      try {
        const res = await api.launch(settings, l.id);
        if (res.ok) {
          hapticSuccess();
          showToast(`Launching ${l.label}…`);
        } else {
          hapticError();
          showToast(res.error ? `Failed: ${res.error}` : `Failed to launch ${l.label}`);
        }
      } catch (e: unknown) {
        hapticError();
        showToast(e instanceof Error ? e.message : 'Launch failed');
      }
    },
    [settings, showToast],
  );

  const streamLaunch = useCallback(
    async (appid: number, label: string) => {
      hapticMedium();
      try {
        // Launch reuses the launcher route; the agent's stream:<appid> id fires
        // steam://rungameid, which Steam turns into a Remote Play stream when
        // the game isn't installed locally but an online host offers it.
        const res = await api.launch(settings, `stream:${appid}`);
        if (res.ok) {
          hapticSuccess();
          showToast(`Streaming ${label}…`);
        } else {
          hapticError();
          showToast(res.error ? `Failed: ${res.error}` : `Failed to stream ${label}`);
        }
      } catch (e: unknown) {
        hapticError();
        showToast(e instanceof Error ? e.message : 'Stream failed');
      }
    },
    [settings, showToast],
  );

  const remove = useCallback(
    (l: Launcher) => {
      confirmDelete(l.label, async () => {
        try {
          await api.deleteLauncher(settings, l.id);
          hapticSuccess();
          list.refresh();
        } catch (e: unknown) {
          hapticError();
          showToast(e instanceof Error ? e.message : 'Delete failed');
        }
      });
    },
    [settings, list, showToast],
  );

  const add = useCallback(
    async (label: string, cmd: string[]) => {
      await api.addLauncher(settings, { label, cmd });
      hapticSuccess();
      list.refresh();
    },
    [settings, list],
  );

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    setRetryKey((k) => k + 1); // let previously-failed covers try again
    list.refresh();
    // usePoll.refresh() re-runs on the next focus tick; drop the spinner soon.
    setTimeout(() => setRefreshing(false), 600);
  }, [list]);

  const launchers = list.data?.launchers ?? [];
  const rows = useMemo(() => {
    const out: Launcher[][] = [];
    for (let i = 0; i < launchers.length; i += COLS) {
      out.push(launchers.slice(i, i + COLS));
    }
    return out;
  }, [launchers]);

  return (
    <View style={styles.screen}>
      <View style={styles.header}>
        <Text style={styles.title}>Launch</Text>
        {/* Nothing to add a launcher to until a box is paired. */}
        {configured && (
          <Pressable
            onPress={() => {
              hapticLight();
              setAddOpen(true);
            }}
            style={({ pressed }) => [styles.addBtn, pressed && styles.pressed]}>
            <Ionicons name="add" size={18} color={t.blue} />
            <Text style={styles.addBtnText}>Add</Text>
          </Pressable>
        )}
      </View>

      <ScrollView
        style={styles.list}
        contentContainerStyle={{ paddingHorizontal: H_PAD, paddingBottom: 24 }}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={onRefresh}
            tintColor={t.textDim}
          />
        }>
        {/* Active Steam downloads (hidden when none / agent < 2.8) */}
        <DownloadsSection downloads={downloads} />

        {/* Stream from PC (hidden when no host / agent < 2.9.23) */}
        {steamlink?.available && (
          <SteamLinkSection data={steamlink} onStream={streamLaunch} />
        )}

        {/* Fresh install: nothing paired yet, so nothing is "unreachable". */}
        {!configured && (
          <View style={styles.emptyCard}>
            <Ionicons name="rocket" size={40} color={t.textFaint} />
            <Text style={styles.emptyTitle}>No box configured</Text>
            <Text style={styles.emptyText}>
              Open the Setup tab to pair with the Couchside service on your media center,
              Steam machine, or PC — then add your TV for one remote that drives both.
            </Text>
          </View>
        )}

        {/* Error (no data yet) */}
        {configured && list.error != null && !list.data && (
          <View style={styles.errBox}>
            <Text style={styles.errText}>{list.error.message}</Text>
            <Pressable
              style={({ pressed }) => [styles.retryBtn, pressed && styles.pressed]}
              onPress={list.refresh}>
              <Text style={styles.retryText}>RETRY</Text>
            </Pressable>
          </View>
        )}

        {/* Loading */}
        {configured && !list.data && list.error == null && (
          <View style={styles.center}>
            <ActivityIndicator color={t.textDim} />
            <Text style={styles.dim}>loading launchers…</Text>
          </View>
        )}

        {/* Empty state */}
        {list.data && launchers.length === 0 && (
          <View style={styles.emptyCard}>
            <Ionicons name="rocket" size={40} color={t.textFaint} />
            <Text style={styles.emptyTitle}>No launchers yet</Text>
            <Text style={styles.emptyText}>
              Steam games are discovered automatically once you install them on the box. You can
              also add a custom launcher for anything else.
            </Text>
            <Pressable
              onPress={() => setAddOpen(true)}
              style={({ pressed }) => [styles.emptyAddBtn, pressed && styles.pressed]}>
              <Ionicons name="add" size={18} color={t.bg} />
              <Text style={styles.emptyAddText}>Add a launcher</Text>
            </Pressable>
          </View>
        )}

        {/* Grid */}
        {rows.map((row, ri) => (
          <View key={ri} style={[styles.row, { gap: GAP, marginBottom: GAP }]}>
            {row.map((l) => (
              <LauncherTile
                key={l.id}
                launcher={l}
                width={tileWidth}
                coverSource={
                  l.kind === 'steam' && l.appid != null
                    ? api.steamCoverSource(settings, l.appid)
                    : undefined
                }
                retryKey={retryKey}
                onLaunch={() => launch(l)}
                onDelete={l.kind === 'custom' ? () => remove(l) : undefined}
                download={l.appid != null ? dlByAppid.get(l.appid) : undefined}
              />
            ))}
            {/* Pad an odd final row so the single tile stays left-aligned. */}
            {row.length < COLS && <View style={{ width: tileWidth }} />}
          </View>
        ))}
      </ScrollView>

      {/* Toast */}
      {toast && (
        <View style={styles.toast} pointerEvents="none">
          <Text style={styles.toastText}>{toast}</Text>
        </View>
      )}

      <AddLauncherForm visible={addOpen} onClose={() => setAddOpen(false)} onSubmit={add} />
    </View>
  );
}

const makeStyles = (t: Palette) => StyleSheet.create({
  screen: { flex: 1, backgroundColor: t.bg },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 14,
    paddingTop: 12,
    paddingBottom: 10,
  },
  title: { color: t.text, fontSize: 26, fontWeight: '700', fontFamily: mono, flex: 1 },
  addBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: t.card,
    borderColor: t.cardBorder,
    borderWidth: 1,
    borderRadius: 999,
    paddingVertical: 7,
    paddingHorizontal: 14,
  },
  addBtnText: { color: t.blue, fontSize: 14, fontWeight: '700', fontFamily: mono },

  list: { flex: 1 },
  row: { flexDirection: 'row' },

  // Downloads section
  dlCard: {
    backgroundColor: t.card,
    borderColor: t.cardBorder,
    borderWidth: 1,
    borderRadius: 14,
    padding: 14,
    marginBottom: 14,
    gap: 12,
  },
  dlHeader: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  dlHeaderGap: {
    marginTop: 4,
    borderTopColor: t.cardBorder,
    borderTopWidth: 1,
    paddingTop: 12,
  },
  dlHeaderText: {
    color: t.textDim,
    fontSize: 11,
    fontWeight: '700',
    fontFamily: mono,
    letterSpacing: 1,
  },
  // Queued (pending, not-moving) update rows: compact + dimmed.
  qRow: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingLeft: 19 },
  qName: { color: t.textDim, fontSize: 13, flex: 1, fontFamily: mono },
  qSize: { color: t.textFaint, fontSize: 11, fontFamily: mono },
  // Steam Remote Play "Stream from PC"
  slHint: { color: t.textFaint, fontSize: 12, lineHeight: 17, marginTop: -4 },
  slHostHeader: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 6 },
  slHostName: { color: t.text, fontSize: 14, fontWeight: '700', fontFamily: mono, flex: 1 },
  slHostCount: { color: t.textDim, fontSize: 12, fontFamily: mono },
  slGameRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 9,
    paddingLeft: 20,
    borderTopColor: t.cardBorder,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  slGameName: { color: t.text, fontSize: 14, fontFamily: mono, flex: 1 },

  dlRow: { gap: 6 },
  dlTop: { flexDirection: 'row', alignItems: 'center' },
  dlName: { color: t.text, fontSize: 14, fontWeight: '600', flex: 1, fontFamily: mono },
  dlPct: { color: t.text, fontSize: 13, fontWeight: '700', fontFamily: mono, marginLeft: 8 },
  dlTrack: {
    height: 6,
    borderRadius: 3,
    backgroundColor: t.cardBorder,
    overflow: 'hidden',
  },
  dlFill: { height: '100%', borderRadius: 3 },
  dlMeta: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  dlState: { color: t.blue, fontSize: 10, fontWeight: '700', fontFamily: mono, letterSpacing: 0.8 },
  dlBytes: { color: t.textDim, fontSize: 11, fontFamily: mono },

  // Per-tile download pill
  tilePill: {
    position: 'absolute',
    top: 6,
    left: 6,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    backgroundColor: 'rgba(0,0,0,0.72)',
    borderRadius: 999,
    paddingVertical: 3,
    paddingHorizontal: 7,
  },
  tilePillText: { color: t.text, fontSize: 11, fontWeight: '700', fontFamily: mono },
  tilePillQueued: { backgroundColor: 'rgba(0,0,0,0.55)' },

  tile: {
    borderRadius: 14,
    overflow: 'hidden',
    backgroundColor: t.card,
    borderColor: t.cardBorder,
    borderWidth: 1,
  },
  tilePressed: { opacity: 0.75, borderColor: t.blue },
  tileArt: { width: '100%', height: '100%' },
  tileFallback: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 12,
    gap: 10,
  },
  tileFallbackLabel: {
    color: t.text,
    fontSize: 14,
    fontWeight: '700',
    textAlign: 'center',
    fontFamily: mono,
  },
  tileLabelOverlay: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: 'rgba(11,18,32,0.82)',
    paddingVertical: 6,
    paddingHorizontal: 8,
  },
  tileLabel: { color: t.text, fontSize: 12, fontWeight: '700', fontFamily: mono },
  tileDelete: {
    position: 'absolute',
    top: 6,
    right: 6,
    backgroundColor: 'rgba(11,18,32,0.85)',
    borderRadius: 999,
    padding: 6,
  },

  center: { alignItems: 'center', justifyContent: 'center', paddingVertical: 48, gap: 12 },
  dim: { color: t.textDim, fontSize: 13 },

  errBox: {
    backgroundColor: t.redDeep,
    borderColor: t.red,
    borderWidth: 1,
    borderRadius: 12,
    padding: 14,
    alignItems: 'center',
    marginTop: 12,
  },
  errText: { color: '#fecaca', fontSize: 13, marginBottom: 8, textAlign: 'center' },
  retryBtn: {
    backgroundColor: t.red,
    paddingVertical: 10,
    paddingHorizontal: 28,
    borderRadius: 8,
  },
  retryText: { color: '#450a0a', fontWeight: '800', fontSize: 13, letterSpacing: 1 },

  emptyCard: {
    backgroundColor: t.card,
    borderColor: t.cardBorder,
    borderWidth: 1,
    borderRadius: 14,
    padding: 24,
    marginTop: 24,
    alignItems: 'center',
    gap: 12,
  },
  emptyTitle: { color: t.text, fontSize: 18, fontWeight: '700' },
  emptyText: { color: t.textDim, fontSize: 13, lineHeight: 19, textAlign: 'center' },
  emptyAddBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: t.blue,
    borderRadius: 999,
    paddingVertical: 10,
    paddingHorizontal: 20,
    marginTop: 4,
  },
  emptyAddText: { color: t.bg, fontSize: 14, fontWeight: '800' },

  pressed: { opacity: 0.7 },

  toast: {
    position: 'absolute',
    bottom: 20,
    left: 24,
    right: 24,
    backgroundColor: t.inset,
    borderColor: t.cardBorder,
    borderWidth: 1,
    borderRadius: 12,
    paddingVertical: 12,
    paddingHorizontal: 16,
    alignItems: 'center',
    shadowColor: '#000',
    shadowOpacity: 0.4,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: 8 },
    elevation: 8,
  },
  toastText: { color: t.text, fontSize: 14, fontWeight: '600', fontFamily: mono },

  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.5)',
    justifyContent: 'center',
    paddingHorizontal: 24,
  },
  formCard: {
    backgroundColor: t.card,
    borderColor: t.cardBorder,
    borderWidth: 1,
    borderRadius: 16,
    padding: 20,
  },
  formTitle: { color: t.text, fontSize: 18, fontWeight: '700', marginBottom: 14 },
  formLabel: {
    color: t.textFaint,
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 1,
    marginBottom: 6,
    marginTop: 8,
  },
  input: {
    backgroundColor: t.inset,
    borderColor: t.cardBorder,
    borderWidth: 1,
    borderRadius: 10,
    paddingVertical: 10,
    paddingHorizontal: 12,
    color: t.text,
    fontFamily: mono,
    fontSize: 14,
  },
  formHint: { color: t.textFaint, fontSize: 11, marginTop: 4 },
  formError: { color: t.red, fontSize: 13, marginTop: 10 },
  formButtons: { flexDirection: 'row', gap: 12, marginTop: 18 },
  formBtn: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 12,
    borderRadius: 10,
    backgroundColor: t.inset,
    borderColor: t.cardBorder,
    borderWidth: 1,
  },
  formBtnPrimary: { backgroundColor: t.blue, borderColor: t.blue },
  formBtnText: { color: t.text, fontSize: 14, fontWeight: '700' },
  formBtnTextPrimary: { color: t.bg, fontWeight: '800' },
});
