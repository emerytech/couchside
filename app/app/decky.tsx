/**
 * Decky — manage Decky Loader and its plugins from the phone.
 * (Spec: docs/memory/project_decky-manager.md §12 bullet 3.)
 *
 * Three surfaces on one virtualised list:
 *   LOADER CARD  state chip · version / remote / channel · Check for updates ·
 *                Repair (= install = update, ONE idempotent wrapper on the box,
 *                §11) · Uninstall… (plugins kept) · live log tail while an op
 *                runs · the agent's correlated result (did_not_start /
 *                interrupted / refused have reasons; `unit_pinned:false` says
 *                Decky's own updater drifted the service file).
 *   INSTALLED    filesystem-listed plugins: name, version, author, root badge,
 *                disabled / hidden / frozen marks, a running dot ONLY when the
 *                agent's probe is real (`running_probe === "proc"`), "Update to
 *                x.y.z", Reload / Uninstall…; the Couchside panel is read-only.
 *   STORE        the box's cached catalogue, searched and sorted ON THE PHONE
 *                (lib/deckyPlugins.ts — no free text reaches the box), icons
 *                proxied by the box, and a button whose label is the honest
 *                install_type: Install / Update to x / Reinstall x / Downgrade
 *                to x (the last two confirm naming both versions).
 *
 * EVERY plugin op is a JOB (§10): the POST returns as soon as the box has
 * queued it, and the banner polls GET /api/decky/jobs every 2 s until `done`,
 * then re-polls the list at 1.5 s and 6 s. A client timeout is never reported
 * as a failure — the poll is the truth. `outcome:"unknown"` renders
 * "Checking…" until the box's read-back settles; a failed update whose old
 * copy Decky already removed offers one-tap Reinstall; a prompt timeout says
 * "Decky may be asking on the TV" (KI-068: our socket displaces Steam's
 * frontend, and a reconnect in the gap moves the confirm modal to the TV).
 *
 * Nothing here restarts the loader silently. A stopped loader answers 409
 * `loader_stopped` and the app OFFERS the existing Restart Decky action with
 * the KI-037 wording ("restarts all plugins"). Portrait-locked like every
 * screen but the Pad.
 */
import Ionicons from '@expo/vector-icons/Ionicons';
import { Stack, router } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator, FlatList, Image, Modal, Pressable, StyleSheet, Text, TextInput, View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import {
  confirmDeckyLoaderInstall, confirmDeckyLoaderUninstall, confirmRestartDecky, deckyConfirm,
  toneColor, useDeckyLoaderOp,
} from '@/components/DeckyCard';
import { useLockOrientation } from '@/hooks/useLockOrientation';
import { usePoll } from '@/hooks/usePoll';
import {
  api, ApiError, hostKey,
  type DeckyJob, type DeckyLoader, type DeckyPlugin, type DeckyPluginsList, type DeckyStore,
  type DeckyStoreEntry,
} from '@/lib/api';
import {
  apiErrorHint, canRunLoaderOp, channelLabel, DECKY_BLINK_LINE, DECKY_PANEL_MISSING,
  DECKY_REPAIR_STABLE, DECKY_UNIT_DRIFTED, deckyHint, describeLoaderState, installConfirmCopy,
  installLabel, installType, isJobActive, isLoaderOpActive, jobCopy, loaderOpCopy, searchStore,
  sortStore, storeLoadMessage, visibleJobNote, type StoreSort,
} from '@/lib/deckyPlugins';
import { hapticLight, hapticSuccess, hapticWarning } from '@/lib/haptics';
import { useSettings } from '@/lib/SettingsContext';
import { useArmedAction } from '@/hooks/useArmedAction';
import { ArmedActionBar } from '@/components/ArmedActionBar';
import { mono, useTheme, useThemedStyles, type Palette } from '@/lib/theme';

type Tab = 'installed' | 'store';
type Note = { tone: 'ok' | 'err' | 'info'; msg: string; restartAction?: string; at?: number };

const SORTS: { key: StoreSort; label: string }[] = [
  { key: 'downloads', label: 'Popular' },
  { key: 'name', label: 'Name' },
  { key: 'updated', label: 'Updated' },
];

/** Compact "when" for the store's fetched_at. */
function ago(sec: number | null | undefined): string {
  if (!sec) return '';
  const d = Math.max(0, Math.floor(Date.now() / 1000 - sec));
  if (d < 60) return 'just now';
  if (d < 3600) return `${Math.floor(d / 60)}m ago`;
  if (d < 86400) return `${Math.floor(d / 3600)}h ago`;
  return `${Math.floor(d / 86400)}d ago`;
}

function fmtDownloads(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${Math.round(n / 1000)}k`;
  return String(n);
}

// ---------- rows ----------

function DeckyPluginRow({ p, storeEntry, runningProbe, disabled, installsDisabled, onUpdate, onManage }: {
  p: DeckyPlugin; storeEntry?: DeckyStoreEntry; runningProbe: 'proc' | 'unknown';
  disabled: boolean; installsDisabled: boolean; onUpdate: (entry: DeckyStoreEntry, p: DeckyPlugin) => void;
  onManage: (p: DeckyPlugin) => void;
}) {
  const t = useTheme();
  const styles = useThemedStyles(makeStyles);
  return <View style={styles.row} testID={`decky-plugin-${p.name}`}>
    <View style={[styles.icon, styles.iconFallback]}><Ionicons name="extension-puzzle-outline" size={24} color={t.blue} /></View>
    <View style={styles.rowMain}>
      <View style={styles.rowTitle}>
        {runningProbe === 'proc' && typeof p.running === 'boolean' ? <View style={[styles.dot, { backgroundColor: p.running ? t.green : t.textFaint }]} /> : null}
        <Text style={styles.name}>{p.name}</Text>
        {p.root ? <Text style={[styles.badgeText, { color: t.amber }]}>ROOT</Text> : null}
        {!p.protected ? <Pressable onPress={() => onManage(p)} disabled={disabled} style={styles.moreBtn}
          accessibilityRole="button" accessibilityLabel={`Manage ${p.name}`} testID={`decky-manage-${p.name}`}>
          <Ionicons name="ellipsis-horizontal" size={22} color={t.textDim} />
        </Pressable> : null}
      </View>
      <Text style={styles.sub}>{p.author}</Text>
      <View style={styles.badgeRow}>{(['disabled', 'hidden', 'frozen'] as const).filter(k => p[k] === true).map(k =>
        <View key={k} style={styles.badge}><Text style={styles.badgeText}>{k[0].toUpperCase() + k.slice(1)}</Text></View>)}</View>
      <View style={styles.pluginFooter}>
        <Text style={styles.sub}>{p.version ?? 'Version unknown'}{p.update ? ` → ${p.update.version}` : ''}</Text>
        {!p.protected && p.update && storeEntry ? <Pressable onPress={() => onUpdate(storeEntry, p)} disabled={installsDisabled}
          testID={`decky-update-${p.name}`} style={[styles.primaryBtn, installsDisabled && styles.pressed]}
          accessibilityRole="button" accessibilityLabel={`Update ${p.name} to ${p.update.version}`}>
          <Text style={styles.primaryBtnText}>Update</Text></Pressable> : null}
      </View>
      {p.protected ? <Text style={styles.faint}>Managed by the Couchside installer.</Text> : !p.update ? <Text style={styles.installedLabel}>Installed</Text> : !storeEntry ? <Text style={styles.faint}>Update available — open Store.</Text> : null}
    </View>
  </View>;
}

function StoreRow({
  e, installedRoot, disabled, installsDisabled, onInstall, onManage,
}: {
  e: DeckyStoreEntry;
  installedRoot: boolean | undefined;
  disabled: boolean;
  installsDisabled: boolean;
  onInstall: (e: DeckyStoreEntry) => void;
  onManage: (e: DeckyStoreEntry) => void;
}) {
  const t = useTheme();
  const styles = useThemedStyles(makeStyles);
  const { settings } = useSettings();
  const top = e.versions[0];
  const type = e.install_type ?? (top ? installType(e.installed_version, top.name) : 'install');
  // Freeze the icon URL per row. api.deckyIconUrl() derives its host from
  // resolveEffectiveHost(), which OSCILLATES between the box hostname and its
  // cached IP as each poll's raceGet winner flips (lib/api). Recomputing `src`
  // every render therefore changed src.uri constantly; on the TLS path the
  // ticket is cached per-host, so a flip to the not-yet-warm host made the box
  // 401 the image → onError → retry → 401 …, an unbounded reload churn across
  // ~110 store rows that crashed the screen on-device ("Maximum update depth").
  // useMemo on the STABLE box identity (never the effective host) pins the URL,
  // and failure is tracked BY URL so a failed image can never reset-and-retry.
  const src = useMemo(
    () => (e.has_icon ? api.deckyIconUrl(settings, e.id) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- stable identity only, NOT resolveEffectiveHost
    [e.has_icon, e.id, settings.host, settings.port, settings.secure],
  );
  const [failedUri, setFailedUri] = useState<string | null>(null);
  const showIcon = !!src && src.uri !== failedUri;
  const root = e.root ?? installedRoot ?? false;
  return (
    <View style={styles.row} testID={`decky-store-${e.id}`}>
      {showIcon && src ? (
        <Image source={src} style={styles.icon} onError={() => setFailedUri(src.uri)} />
      ) : (
        <View style={[styles.icon, styles.iconFallback]}>
          <Ionicons name="extension-puzzle-outline" size={18} color={t.textDim} />
        </View>
      )}
      <View style={styles.rowMain}>
        <View style={styles.rowTitle}>
          <Text style={styles.name} numberOfLines={1}>{e.name}</Text>
          {root ? (
            <View style={[styles.badge, { borderColor: t.amber }]}>
              <Ionicons name="shield-outline" size={10} color={t.amber} />
              <Text style={[styles.badgeText, { color: t.amber }]}>root</Text>
            </View>
          ) : null}
        </View>
        <Text style={styles.sub} numberOfLines={1}>
          {e.author} · {fmtDownloads(e.downloads)} downloads
        </Text>
        {e.description ? <Text style={styles.desc} numberOfLines={2}>{e.description}</Text> : null}
        <Text style={styles.sub}>{e.installed_version && top && e.installed_version !== top.name ? `${e.installed_version} → ${top.name}` : top?.name}</Text>
        {top ? (
          <View style={styles.actions}>
            {type === 'reinstall' ? <>
              <Text style={styles.installedLabel}>✓ Installed</Text>
              <Pressable onPress={() => onManage(e)} disabled={disabled} style={styles.moreBtn}
                accessibilityRole="button" accessibilityLabel={`Manage ${e.name}`}><Ionicons name="ellipsis-horizontal" size={22} color={t.textDim} /></Pressable>
            </> : <Pressable
              onPress={() => onInstall(e)}
              disabled={installsDisabled}
              testID={`decky-store-install-${e.id}`}
              style={({ pressed }) => [
                type === 'downgrade' ? styles.warnBtn : styles.primaryBtn,
                (pressed || installsDisabled) && styles.pressed,
              ]}
              accessibilityRole="button"
              accessibilityLabel={`${installLabel(type, top.name)} ${e.name}`}>
              <Text style={type === 'downgrade' ? styles.warnBtnText : styles.primaryBtnText}>
                {type === 'update' ? 'Update' : type === 'install' ? 'Install' : installLabel(type, top.name)}
              </Text>
            </Pressable>}
          </View>
        ) : (
          <Text style={styles.faint}>No installable version listed.</Text>
        )}
      </View>
    </View>
  );
}

// ---------- the page ----------

// STABLE reference — an inline options object re-fires expo-router's <Stack.Screen>
// layout effect (navigation.setOptions) on every render, and this screen re-renders
// constantly from its four polls, which ran setOptions away into "Maximum update
// depth exceeded" (crash log 2026-09-28, screen /decky). A module const fixes it:
// the effect's deps are stable, so setOptions runs once on mount.
const SCREEN_OPTIONS = { headerShown: false };

type ListItem =
  | { key: string; kind: 'overview' }
  | { key: string; kind: 'controls' }
  | { key: string; kind: 'plugin'; p: DeckyPlugin }
  | { key: string; kind: 'store'; e: DeckyStoreEntry }
  | { key: string; kind: 'msg'; text: string; spinner?: boolean; retry?: boolean };

export default function DeckyPage() {
  const { settings } = useSettings();
  // Remount box-local operation notices/menus as well as polls when switching boxes.
  return <DeckyContent key={hostKey(settings)} />;
}

function DeckyContent() {
  const t = useTheme();
  const styles = useThemedStyles(makeStyles);
  const insets = useSafeAreaInsets();
  const { settings } = useSettings();
  useLockOrientation('portrait'); // like every screen but the Pad
  const configured = settings.host.trim().length > 0;
  const key = hostKey(settings);

  const [tab, setTab] = useState<Tab>('installed');
  const [manageOpen, setManageOpen] = useState(false);
  const [menuPlugin, setMenuPlugin] = useState<DeckyPlugin | DeckyStoreEntry | null>(null);
  const [restartSince, setRestartSince] = useState<number | null>(null);
  const [restarting, setRestarting] = useState(false);

  // ---- loader ----
  const [fastLoader, setFastLoader] = useState(false);
  const loader = usePoll<DeckyLoader | null>(
    () => api.deckyLoader(settings), fastLoader || restarting ? 2000 : 15000, configured, key);
  const l = loader.data;
  const opActive = isLoaderOpActive(l?.op);
  useEffect(() => { setFastLoader(opActive); }, [opActive]);

  // Live transcript while an op runs; the last tail is kept afterwards so a
  // failure's reason stays readable. "Show log" fetches it on demand otherwise.
  const [log, setLog] = useState<string[]>([]);
  const [showLog, setShowLog] = useState(false);
  useEffect(() => {
    if (!opActive) return undefined;
    let live = true;
    const tick = () => {
      void api.deckyLoaderLog(settings, 40).then((ls) => { if (live) setLog(ls); }).catch(() => {});
    };
    tick();
    const id = setInterval(tick, 2000);
    return () => { live = false; clearInterval(id); };
  }, [opActive, settings]);
  const fetchLog = useCallback(() => {
    void api.deckyLoaderLog(settings, 60).then(setLog).catch(() => {});
  }, [settings]);

  const refreshLoader = loader.refresh;   // stable (useCallback []), unlike the poll object
  const onOpStarted = useCallback(() => { setFastLoader(true); refreshLoader(); }, [refreshLoader]);
  const op = useDeckyLoaderOp(onOpStarted);

  const [checking, setChecking] = useState(false);
  const [checkNote, setCheckNote] = useState<Note | null>(null);
  const checkForUpdates = useCallback(() => {
    hapticLight();
    setChecking(true);
    setCheckNote(null);
    void (async () => {
      try {
        const r = await api.deckyLoaderCheck(settings);
        if (r && r.updatable && r.remote) setCheckNote({ tone: 'info', msg: `Loader ${r.remote} is available — Repair installs it.` });
        else if (r?.current && r.remote) setCheckNote({ tone: 'ok', msg: `Loader is up to date (${r.current}).` });
        else setCheckNote({ tone: 'info', msg: 'No version info from the box.' });
        refreshLoader();
      } catch (e) {
        if (e instanceof ApiError && e.kind === 'http') {
          setCheckNote({ tone: 'err', msg: apiErrorHint(e.status, e.body, "Couldn't check.").text });
        } else if (e instanceof ApiError && e.kind === 'timeout') {
          setCheckNote({ tone: 'info', msg: 'Still checking — the version line updates when the box answers.' });
          refreshLoader();
        } else {
          setCheckNote({ tone: 'err', msg: 'Could not reach the box.' });
        }
      } finally {
        setChecking(false);
      }
    })();
  }, [settings, refreshLoader]);

  // The existing injected action, named by the agent — KI-037 wording, user-invoked.
  useEffect(() => {
    if (restartSince === null) return;
    if (loader.lastSuccess && loader.lastSuccess > restartSince && l?.state === 'running') {
      setRestarting(false); setRestartSince(null); setCheckNote(null);
    }
  }, [restartSince, loader.lastSuccess, l?.state]);
  useEffect(() => {
    if (restartSince === null) return;
    const timer = setTimeout(() => {
      setRestarting(false); setRestartSince(null);
      setCheckNote({ tone: 'err', msg: 'Restart requested, but Decky has not confirmed it is running. Check its status or logs.' });
    }, 20000);
    return () => clearTimeout(timer);
  }, [restartSince]);
  const jobRef = useRef<DeckyJob | null>(null);
  const restartDecky = useCallback((action: string, title?: string) => {
    confirmRestartDecky(() => {
      void (async () => {
        setRestarting(true);
        setCheckNote(null); setJobNote(null); setDismissedJob(jobRef.current?.started_at ?? null);
        hapticLight();
        try {
          // runAction resolves ok:false (it does NOT throw) when the box refuses
          // — a missing sudo grant for `restart plugin_loader` (KI-050 plugin
          // box, or a hand-edited sudoers), a helper refusal, a failed unit. A
          // success haptic then lied and the loader stayed stopped with nothing
          // said. Read the result and surface the box's own stderr on failure.
          const r = await api.runAction(settings, action);
          if (r.ok) {
            hapticSuccess(); setRestartSince(Date.now());
          } else {
            setRestarting(false);
            hapticWarning();
            setCheckNote({ tone: 'err', msg: (r.stderr || '').trim() || 'Restart Decky did not run on the box.' });
          }
        } catch {
          setRestarting(false);
          hapticWarning();
          setCheckNote({ tone: 'err', msg: 'Could not reach the box.' });
        } finally {
          refreshLoader();
          setTimeout(() => refreshLoader(), 1500);
          setTimeout(() => refreshLoader(), 6000);
        }
      })();
    }, title);
  }, [settings, refreshLoader]);

  // Reboot: confirm once, then a cancellable countdown (Cancel / Do it now) —
  // the same window the Actions tab gives a session-ending action, instead of a
  // one-shot Alert that reboots the instant you tap through.
  const { armed, arm, cancel, fireNow } = useArmedAction(key);
  const [rebooting, setRebooting] = useState(false);
  const runReboot = useCallback(() => {
    void (async () => {
      setRebooting(true);
      hapticLight();
      try { await api.runAction(settings, 'reboot'); } catch { /* connection drops on reboot — expected */ }
      finally { setRebooting(false); }
    })();
  }, [settings]);
  const reboot = useCallback(() => {
    deckyConfirm('Reboot the box?', 'Steam restarts with it and the Decky menu appears. Any unsaved work is lost.', 'Reboot', () => {
      arm('Reboot the box', runReboot);
    }, true);
  }, [arm, runReboot]);

  // ---- plugins / store / jobs (Phase B; each 404s → null on a Phase A agent) ----
  const installed = !!l?.installed;
  const plugins = usePoll<DeckyPluginsList | null>(
    () => api.deckyPlugins(settings), 15000, configured && installed, key);
  const store = usePoll<DeckyStore | null>(
    () => api.deckyStore(settings), 5 * 60 * 1000, configured && installed, key);
  const storeFetching = !!store.data?.fetching;
  // Changing usePoll's interval does not replace an already scheduled five-
  // minute tick. Explicitly follow a cold-cache/background fetch until done.
  const pollStoreNow = store.refresh;
  useEffect(() => {
    if (!storeFetching) return;
    const timer = setTimeout(pollStoreNow, 2000);
    return () => clearTimeout(timer);
  }, [storeFetching, store.lastSuccess, store.error, pollStoreNow]);

  const [jobFast, setJobFast] = useState(false);
  const jobs = usePoll<{ job: DeckyJob | null } | null>(
    () => api.deckyJobs(settings), jobFast ? 2000 : 30000, configured && installed, key);
  const job = jobs.data?.job ?? null;
  useEffect(() => { jobRef.current = job; }, [job]);
  const jobActive = isJobActive(job);
  useEffect(() => { setJobFast(jobActive); }, [jobActive]);
  // Active → done: re-poll the list twice, like the flash (1.5 s, 6 s).
  const refreshPlugins = plugins.refresh;
  const refreshStore = store.refresh;
  const refreshJobs = jobs.refresh;
  const jobWas = useRef(false);
  useEffect(() => {
    if (jobWas.current && !jobActive) {
      setTimeout(() => { refreshPlugins(); refreshStore(); }, 1500);
      setTimeout(() => { refreshPlugins(); }, 6000);
    }
    jobWas.current = jobActive;
  }, [jobActive, refreshPlugins, refreshStore]);
  const [dismissedJob, setDismissedJob] = useState<number | null>(null);

  const [jobNote, setJobNote] = useState<Note | null>(null);
  const [jobBusy, setJobBusy] = useState(false);
  // steam_ui_up as the op reply carried it (§10) — falls back to the loader's.
  const [opSteamUiUp, setOpSteamUiUp] = useState<boolean | undefined>(undefined);
  const steamUiUp = l?.steam_ui_up ?? false;

  const runPluginJob = useCallback((fn: () => Promise<{ ok: boolean; job: DeckyJob | null; steam_ui_up?: boolean }>) => {
    hapticLight();
    setJobNote(null);
    setJobBusy(true);
    setDismissedJob(jobRef.current?.started_at ?? null);
    void (async () => {
      try {
        const r = await fn();
        if (typeof r.steam_ui_up === 'boolean') setOpSteamUiUp(r.steam_ui_up);
        hapticSuccess();
        setJobFast(true);
        refreshJobs();
      } catch (e) {
        if (e instanceof ApiError && e.kind === 'timeout') {
          // The job may well be queued; the poll decides. Never "failed" here.
          setJobNote({ tone: 'info', msg: 'Still working — the box reports the result below.' });
          setJobFast(true);
          refreshJobs();
        } else if (e instanceof ApiError && e.kind === 'http') {
          hapticWarning();
          const h = apiErrorHint(e.status, e.body, e.message);
          setJobNote({ tone: 'err', msg: h.text, restartAction: h.restartAction, at: Date.now() });
        } else {
          hapticWarning();
          setJobNote({ tone: 'err', msg: 'Could not reach the box.' });
        }
      } finally {
        setJobBusy(false);
      }
    })();
  }, [refreshJobs]);

  const installedByName = useMemo(() => {
    const m = new Map<string, DeckyPlugin>();
    for (const p of plugins.data?.plugins ?? []) m.set(p.name, p);
    return m;
  }, [plugins.data]);
  const storeByName = useMemo(() => {
    const m = new Map<string, DeckyStoreEntry>();
    for (const e of store.data?.plugins ?? []) m.set(e.name, e);
    return m;
  }, [store.data]);

  const installFromStore = useCallback((e: DeckyStoreEntry) => {
    const top = e.versions[0];
    if (!top) return;
    const installedCopy = installedByName.get(e.name);
    const type = e.install_type ?? installType(e.installed_version ?? installedCopy?.version ?? null, top.name);
    const copy = installConfirmCopy({
      name: e.name,
      author: e.author,
      type,
      installedVersion: e.installed_version ?? installedCopy?.version ?? null,
      remoteVersion: top.name,
      root: e.root ?? installedCopy?.root ?? false,
      steamUiUp,
    });
    deckyConfirm(copy.title, copy.message, copy.okLabel,
      () => runPluginJob(() => api.deckyInstall(settings, e.id)), type === 'downgrade');
  }, [installedByName, steamUiUp, runPluginJob, settings]);

  const uninstallPlugin = useCallback((p: DeckyPlugin) => {
    const msg = `Decky Loader removes its files and cleans up its settings.`
      + (steamUiUp ? `\n\n${DECKY_BLINK_LINE}` : '');
    deckyConfirm(`Uninstall ${p.name}?`, msg, 'Uninstall',
      () => runPluginJob(() => api.deckyPluginOp(settings, 'uninstall', p.name)), true);
  }, [steamUiUp, runPluginJob, settings]);

  const reloadPlugin = useCallback((p: DeckyPlugin) => {
    // One backend restarted (KI-037's preferred granularity) — no confirm.
    runPluginJob(() => api.deckyPluginOp(settings, 'reload', p.name));
  }, [runPluginJob, settings]);

  // ---- store search / sort (phone-side) ----
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<StoreSort>('downloads');
  const storeRows = useMemo(() => {
    const list = store.data?.plugins ?? [];
    return sortStore(searchStore(list, query), sort);
  }, [store.data, query, sort]);

  const [refreshNote, setRefreshNote] = useState<Note | null>(null);
  const refreshStoreOnBox = useCallback(() => {
    hapticLight();
    setRefreshNote(null);
    void (async () => {
      try {
        const r = await api.deckyStoreRefresh(settings);
        setRefreshNote(r.fetching || r.refreshed ? null : { tone: 'info', msg: 'Refreshed recently — try again in a minute.' });
        refreshStore();
      } catch (e) {
        setRefreshNote({ tone: 'err', msg: e instanceof ApiError && e.kind === 'http'
          ? apiErrorHint(e.status, e.body, "Couldn't refresh.").text
          : 'Could not reach the box.' });
      }
    })();
  }, [settings, refreshStore]);

  // ---- list items ----
  const items: ListItem[] = useMemo(() => {
    if (!l) return [];
    if (!l.installed) return [{ key: 'm', kind: 'msg', text: 'Install Decky Loader to manage plugins.' }];
    if (tab === 'installed') {
      const pl = plugins.data;
      if (!pl) {
        return plugins.loading
          ? [{ key: 'm', kind: 'msg', text: 'Reading plugins…', spinner: true }]
          : [{ key: 'm', kind: 'msg', text: "Plugin management needs a newer Couchside service on the box (update it from Setup › Account)." }];
      }
      if (!pl.available) return [{ key: 'm', kind: 'msg', text: "Decky Loader isn't installed." }];
      if (!pl.plugins.length) return [{ key: 'm', kind: 'msg', text: 'No plugins installed yet — browse the Store tab.' }];
      return pl.plugins.map((p) => ({ key: `p:${p.folder}`, kind: 'plugin' as const, p }));
    }
    const st = store.data;
    const message = storeLoadMessage(st, store.loading, !!store.error, l.allowed);
    if (message) return [{ key: 'm', kind: 'msg', ...message }];
    if (!storeRows.length) return [{ key: 'm', kind: 'msg', text: query ? 'No plugins match.' : 'The store list is empty.' }];
    return storeRows.map((e) => ({ key: `s:${e.id}`, kind: 'store' as const, e }));
  }, [l, tab, plugins.data, plugins.loading, store.data, store.loading, store.error, storeRows, query]);

  // ---- render pieces ----
  const renderLoaderCard = () => {
    if (!l) return null;
    const d = describeLoaderState(l);
    const expanded = manageOpen || !l.installed || opActive;
    const recovering = restarting || !!loader.error;
    const hint = deckyHint(l);
    const canOp = canRunLoaderOp(l);
    const opLine = loaderOpCopy(l.op);
    const ch = channelLabel(l.channel);
    const busyOp = op.busy || opActive;
    const updatable = !!l.loader_update?.updatable && !!l.loader_update.remote;
    return (
      <View style={styles.card} testID="decky-loader-card">
        <View style={styles.cardHead}>
          <Ionicons name="extension-puzzle-outline" size={16} color={t.blue} />
          <Text style={styles.cardTitle}>Decky Loader</Text>
          <Pressable onPress={() => setManageOpen(v => !v)} style={styles.moreBtn} testID="decky-manage-loader"
            accessibilityRole="button" accessibilityLabel="Manage Decky Loader" accessibilityState={{ expanded }}>
            <Text style={styles.link}>Manage</Text><Ionicons name={expanded ? 'chevron-up' : 'chevron-down'} size={15} color={t.textDim} />
          </Pressable>
        </View>
        <Text style={[styles.stateLine, { color: recovering ? t.amber : toneColor(t, d.tone) }]}>
          {restarting ? 'Restarting Decky…' : loader.error ? 'Connection interrupted — checking again…' : d.line}
          {l.installed && !expanded ? ` · ${l.loader_update?.current ?? l.version ?? 'Version unknown'}` : ''}
        </Text>
        {checkNote && !expanded ? <Text style={[styles.note, { color: toneColor(t, checkNote.tone === 'err' ? 'warn' : 'action') }]}>{checkNote.msg}</Text> : null}
        {!expanded && !recovering && l.state !== 'running' ? <Pressable onPress={() => setManageOpen(true)} accessibilityRole="button" style={styles.ghostBtn}><Text style={styles.ghostBtnText}>View status and recovery options</Text></Pressable> : null}
        {expanded ? <>
        {l.installed ? (
          <View style={styles.kv}>
            <Text style={styles.k}>Version</Text>
            <Text style={styles.v} numberOfLines={1}>
              {l.loader_update?.current ?? (l.version ? `${l.version} (as recorded)` : 'unknown')}
            </Text>
          </View>
        ) : null}
        {l.installed ? (
          <View style={styles.kv}>
            <Text style={styles.k}>Latest</Text>
            <Text style={styles.v} numberOfLines={1}>
              {l.loader_update?.remote ?? 'Not checked'}{updatable ? ' — update available' : ''}
            </Text>
          </View>
        ) : null}
        {ch ? (
          <View style={styles.kv}>
            <Text style={styles.k}>Channel</Text>
            <Text style={styles.v} numberOfLines={2}>{ch}{l.channel !== 0 ? ` · ${DECKY_REPAIR_STABLE}` : ''}</Text>
          </View>
        ) : null}
        {l.installed && l.unit_pinned === false ? <Text style={styles.warnLine}>{DECKY_UNIT_DRIFTED}</Text> : null}
        {l.installed && l.panel === 'missing' ? <Text style={styles.faint}>{DECKY_PANEL_MISSING}</Text> : null}

        {opLine ? (
          <View style={styles.opRow}>
            {opActive ? <ActivityIndicator size="small" color={t.blue} /> : null}
            <Text style={[styles.opText, { color: toneColor(t, opLine.tone) }]}>{opLine.line}</Text>
          </View>
        ) : null}
        {(opActive || showLog) && log.length ? (
          <View style={styles.log}>
            {log.slice(-(opActive ? 8 : 30)).map((ln, i) => (
              <Text key={`${i}-${ln}`} style={styles.logLine} numberOfLines={1}>{ln}</Text>
            ))}
          </View>
        ) : null}
        {op.note && !(opLine && op.note.tone === 'info') ? (
          <Text style={[styles.note, { color: op.note.tone === 'ok' ? t.green : op.note.tone === 'err' ? t.red : t.blue }]}>{op.note.msg}</Text>
        ) : null}
        {checkNote ? (
          <Text style={[styles.note, { color: checkNote.tone === 'ok' ? t.green : checkNote.tone === 'err' ? t.red : t.blue }]}>{checkNote.msg}</Text>
        ) : null}

        <View style={styles.btnRow}>
          {!l.installed && l.allowed && canOp ? (
            <Pressable onPress={() => confirmDeckyLoaderInstall('install', () => op.start('install'))} disabled={busyOp}
              testID="decky-loader-install"
              style={({ pressed }) => [styles.primaryBtn, (pressed || busyOp) && styles.pressed]}
              accessibilityRole="button" accessibilityLabel="Install Decky Loader">
              <Text style={styles.primaryBtnText}>{op.busy ? 'Starting…' : 'Install Decky Loader'}</Text>
            </Pressable>
          ) : null}
          {l.installed && d.action === 'start' && l.restart_action ? (
            <Pressable onPress={() => restartDecky(l.restart_action as string, 'Start Decky?')} disabled={restarting}
              testID="decky-loader-start"
              style={({ pressed }) => [styles.primaryBtn, (pressed || restarting) && styles.pressed]}
              accessibilityRole="button" accessibilityLabel="Start Decky (restarts all plugins)">
              <Text style={styles.primaryBtnText}>{restarting ? 'Starting…' : 'Start Decky'}</Text>
            </Pressable>
          ) : null}
          {l.installed && l.allowed ? (
            <Pressable onPress={checkForUpdates} disabled={checking || busyOp}
              testID="decky-loader-check"
              style={({ pressed }) => [styles.ghostBtn, (pressed || checking || busyOp) && styles.pressed]}
              accessibilityRole="button" accessibilityLabel="Check for Decky Loader updates">
              {checking ? <ActivityIndicator size="small" color={t.text} /> : <Ionicons name="cloud-outline" size={14} color={t.text} />}
              <Text style={styles.ghostBtnText}>{checking ? 'Checking…' : 'Check for updates'}</Text>
            </Pressable>
          ) : null}
          {l.installed && canOp ? (
            <Pressable onPress={() => confirmDeckyLoaderInstall('repair', () => op.start('install'))} disabled={busyOp}
              testID="decky-loader-repair"
              style={({ pressed }) => [updatable || d.action === 'repair' ? styles.primaryBtn : styles.ghostBtn, (pressed || busyOp) && styles.pressed]}
              accessibilityRole="button" accessibilityLabel={updatable ? `Update Decky Loader to ${l.loader_update?.remote}` : 'Repair Decky Loader'}>
              {updatable || d.action === 'repair' ? null : <Ionicons name="build-outline" size={14} color={t.text} />}
              <Text style={updatable || d.action === 'repair' ? styles.primaryBtnText : styles.ghostBtnText}>
                {updatable ? `Update to ${l.loader_update?.remote}` : 'Repair'}
              </Text>
            </Pressable>
          ) : null}
          {l.installed && canOp ? (
            <Pressable onPress={() => confirmDeckyLoaderUninstall(() => op.start('uninstall'))} disabled={busyOp}
              testID="decky-loader-uninstall"
              style={({ pressed }) => [styles.ghostBtn, (pressed || busyOp) && styles.pressed]}
              accessibilityRole="button" accessibilityLabel="Uninstall Decky Loader">
              <Ionicons name="trash-outline" size={14} color={t.red} />
              <Text style={[styles.ghostBtnText, { color: t.red }]}>Uninstall…</Text>
            </Pressable>
          ) : null}
          {l.state === 'installed_steam_needs_restart' ? (
            <Pressable onPress={reboot} disabled={rebooting}
              testID="decky-loader-reboot"
              style={({ pressed }) => [styles.ghostBtn, (pressed || rebooting) && styles.pressed]}
              accessibilityRole="button" accessibilityLabel="Reboot the box">
              <Ionicons name="power-outline" size={14} color={t.text} />
              <Text style={styles.ghostBtnText}>{rebooting ? 'Rebooting…' : 'Reboot'}</Text>
            </Pressable>
          ) : null}
          {l.installed && !opActive ? (
            <Pressable onPress={() => { setShowLog((v) => !v); if (!showLog) fetchLog(); }}
              testID="decky-loader-log"
              style={({ pressed }) => [styles.linkBtn, pressed && styles.pressed]}
              accessibilityRole="button" accessibilityLabel="Toggle the installer log">
              <Text style={styles.link}>{showLog ? 'Hide log' : 'Show log'}</Text>
            </Pressable>
          ) : null}
        </View>

        {hint ? (
          hint.kind === 'optin' ? (
            <Text style={styles.hint}>Enable on the box: <Text style={styles.code}>couchside allow-decky on</Text></Text>
          ) : (
            <Text style={styles.hint}>{hint.text}</Text>
          )
        ) : null}
        </> : null}
      </View>
    );
  };

  const renderJobBanner = () => {
    if (restarting) return <View style={styles.banner} accessibilityLiveRegion="polite"><ActivityIndicator color={t.blue} /><Text style={styles.note}>Reconnecting plugins…</Text><Text style={styles.faint}>Waiting for Decky to confirm it is running.</Text></View>;
    const note = visibleJobNote(jobNote, l?.state, !!loader.error, loader.lastSuccess);
    const shown = !note && job && job.started_at !== dismissedJob ? job : null;
    if (!shown && !note) return null;
    const jc = shown ? jobCopy(shown, opSteamUiUp ?? l?.steam_ui_up) : null;
    return (
      <View style={styles.banner} testID="decky-job-banner">
        {jc && shown ? (
          <>
            <View style={styles.opRow}>
              {!shown.done || shown.outcome === 'unknown' ? <ActivityIndicator size="small" color={t.blue} /> : null}
              <Text style={[styles.opText, { color: toneColor(t, jc.tone) }]}>{jc.line}</Text>
              {shown.done ? (
                <Pressable onPress={() => setDismissedJob(shown.started_at)} hitSlop={10} accessibilityRole="button" accessibilityLabel="Dismiss">
                  <Ionicons name="close" size={16} color={t.textFaint} />
                </Pressable>
              ) : null}
            </View>
            {shown.done && (jc.reinstallId != null || jc.offerReload || jc.offerRetry) ? (
              <View style={styles.btnRow}>
                {jc.reinstallId != null ? (
                  <Pressable onPress={() => runPluginJob(() => api.deckyInstall(settings, jc.reinstallId as number))} disabled={jobBusy}
                    testID="decky-job-reinstall"
                    style={({ pressed }) => [styles.primaryBtn, (pressed || jobBusy) && styles.pressed]}
                    accessibilityRole="button" accessibilityLabel={`Reinstall ${shown.name}`}>
                    <Text style={styles.primaryBtnText}>{`Reinstall ${shown.name}`}</Text>
                  </Pressable>
                ) : null}
                {jc.offerRetry && shown.store_id != null ? (
                  <Pressable onPress={() => runPluginJob(() => api.deckyInstall(settings, shown.store_id as number))} disabled={jobBusy}
                    testID="decky-job-retry"
                    style={({ pressed }) => [styles.ghostBtn, (pressed || jobBusy) && styles.pressed]}
                    accessibilityRole="button" accessibilityLabel="Retry">
                    <Text style={styles.ghostBtnText}>Retry</Text>
                  </Pressable>
                ) : null}
                {jc.offerReload && l?.restart_action ? (
                  <Pressable onPress={() => restartDecky(l.restart_action as string, 'Restart Decky?')} disabled={restarting}
                    testID="decky-job-reload-decky"
                    style={({ pressed }) => [styles.ghostBtn, (pressed || restarting) && styles.pressed]}
                    accessibilityRole="button" accessibilityLabel="Restart Decky (restarts all plugins)">
                    <Text style={styles.ghostBtnText}>Restart Decky</Text>
                  </Pressable>
                ) : null}
              </View>
            ) : null}
          </>
        ) : null}
        {note ? (
          <View>
            <Text style={[styles.note, { color: note.tone === 'ok' ? t.green : note.tone === 'err' ? t.red : t.blue }]}>{note.msg}</Text>
            {note.restartAction ? (
              <View style={styles.btnRow}>
                <Pressable onPress={() => restartDecky(note.restartAction as string)} disabled={restarting}
                  testID="decky-note-restart"
                  style={({ pressed }) => [styles.primaryBtn, (pressed || restarting) && styles.pressed]}
                  accessibilityRole="button" accessibilityLabel="Restart Decky (restarts all plugins)">
                  <Text style={styles.primaryBtnText}>{restarting ? 'Restarting…' : 'Restart Decky'}</Text>
                </Pressable>
              </View>
            ) : null}
          </View>
        ) : null}
      </View>
    );
  };

  const renderTabs = () => {
    if (!l?.installed) return null;
    const pl = plugins.data;
    const updates = pl && pl.available ? pl.updates : null;
    return (
      <View style={styles.stickyControls}>
        <View style={styles.tabBar}>
          {(['installed', 'store'] as Tab[]).map((k) => {
            const active = k === tab;
            return (
              <Pressable key={k} onPress={() => { hapticLight(); setTab(k); }}
                testID={`decky-tab-${k}`}
                style={[styles.tabItem, active && styles.tabItemActive]}
                accessibilityRole="button" accessibilityState={{ selected: active }}>
                <Ionicons name={k === 'installed' ? 'albums-outline' : 'storefront-outline'} size={15} color={active ? t.text : t.textFaint} />
                <Text style={[styles.tabLabel, active && styles.tabLabelActive]} numberOfLines={1}>
                  {k === 'installed' ? `Installed${pl && pl.available ? ` (${pl.plugins.length})` : ''}` : 'Store'}
                </Text>
                {k === 'installed' && updates ? (
                  <View style={styles.countPill}><Text style={styles.countPillText}>{updates} {updates === 1 ? 'update' : 'updates'}</Text></View>
                ) : null}
              </Pressable>
            );
          })}
        </View>
        {tab === 'installed' && pl && pl.available ? (
          <Text style={styles.listMeta}>
            {pl.flags_available ? '' : 'Plugin flags unknown this poll (Decky is rewriting its settings). '}
            {pl.unreadable ? `${pl.unreadable} folder${pl.unreadable === 1 ? '' : 's'} unreadable. ` : ''}
            {pl.store_checked_at ? `Updates checked ${ago(pl.store_checked_at)}.` : 'Updates unknown until the store is fetched.'}
          </Text>
        ) : null}
        {tab === 'store' ? (
          <View>
            <View style={styles.controls}>
              <View style={styles.searchWrap}>
                <Ionicons name="search" size={16} color={t.textFaint} />
                <TextInput
                  value={query}
                  onChangeText={setQuery}
                  placeholder="Search plugins"
                  placeholderTextColor={t.textFaint}
                  style={styles.search}
                  autoCorrect={false}
                  autoCapitalize="none"
                  returnKeyType="search"
                  testID="decky-store-search"
                />
                {query ? (
                  <Pressable onPress={() => setQuery('')} hitSlop={8} accessibilityRole="button" accessibilityLabel="Clear search">
                    <Ionicons name="close-circle" size={16} color={t.textFaint} />
                  </Pressable>
                ) : null}
              </View>
              <Pressable onPress={refreshStoreOnBox} disabled={storeFetching}
                testID="decky-store-refresh"
                style={({ pressed }) => [styles.iconBtn, (pressed || storeFetching) && styles.pressed]}
                accessibilityRole="button" accessibilityLabel="Refresh the store list on the box">
                {storeFetching ? <ActivityIndicator size="small" color={t.text} /> : <Ionicons name="refresh" size={18} color={t.text} />}
              </Pressable>
            </View>
            <View style={styles.chips}>
              {SORTS.map((s) => (
                <Pressable key={s.key} onPress={() => { hapticLight(); setSort(s.key); }}
                  testID={`decky-sort-${s.key}`}
                  style={[styles.sortChip, sort === s.key && styles.sortChipOn]}
                  accessibilityRole="button" accessibilityState={{ selected: sort === s.key }}>
                  <Text style={[styles.sortChipText, sort === s.key && styles.sortChipTextOn]}>{s.label}</Text>
                </Pressable>
              ))}
              <Text style={styles.listMetaInline} numberOfLines={1}>
                {store.data?.available
                  ? `${storeRows.length}${query ? ' match' : ''} · ${store.data.stale ? 'last copy · ' : ''}${ago(store.data.fetched_at)}`
                  : ''}
              </Text>
            </View>
            {store.data?.stale ? <Text style={styles.warnLine}>{store.data.error_code === 'loader_update_required' ? 'Update Decky Loader to install plugins. Showing the last catalog.' : 'Couldn’t refresh. Showing the last saved catalog.'}</Text> : null}
            {storeFetching ? <Text style={styles.listMeta}>Refreshing on the box…</Text> : refreshNote ? <Text style={refreshNote.tone === 'err' ? styles.warnLine : styles.listMeta}>{refreshNote.msg}</Text> : null}
          </View>
        ) : null}
      </View>
    );
  };

  const runningProbe = plugins.data?.running_probe ?? 'unknown';
  const rowsDisabled = jobBusy || jobActive || opActive || restarting;
  const installsDisabled = rowsDisabled || store.data?.error_code === 'loader_update_required';

  const renderItem = ({ item }: { item: ListItem }) => {
    if (item.kind === 'overview') return <View style={{ gap: 10, paddingBottom: 8 }}>{renderLoaderCard()}{renderJobBanner()}</View>;
    if (item.kind === 'controls') return renderTabs();
    if (item.kind === 'msg') {
      return (
        <View style={styles.emptyState} accessibilityLiveRegion="polite">
          {item.spinner ? <ActivityIndicator size="small" color={t.blue} /> : null}
          <Text style={styles.msgText}>{item.text}</Text>
          {item.retry ? <Pressable onPress={refreshStoreOnBox} style={styles.primaryBtn} accessibilityRole="button" testID="decky-store-retry"><Text style={styles.primaryBtnText}>Try again</Text></Pressable> : null}
          {item.spinner ? [0, 1, 2].map(n => <View key={n} style={styles.skeleton}><View style={styles.skeletonLine} /><View style={[styles.skeletonLine, { width: '65%' }]} /></View>) : null}
        </View>
      );
    }
    if (item.kind === 'plugin') {
      return (
        <DeckyPluginRow
          p={item.p}
          storeEntry={storeByName.get(item.p.name)}
          runningProbe={runningProbe}
          disabled={rowsDisabled}
          installsDisabled={installsDisabled}
          onUpdate={(e) => installFromStore(e)}
          onManage={setMenuPlugin}
        />
      );
    }
    return (
      <StoreRow
        e={item.e}
        installedRoot={installedByName.get(item.e.name)?.root}
        disabled={rowsDisabled}
        installsDisabled={installsDisabled}
        onInstall={installFromStore}
        onManage={setMenuPlugin}
      />
    );
  };

  return (
    <View style={[styles.screen, { paddingTop: insets.top }]}>
      <Stack.Screen options={SCREEN_OPTIONS} />
      <View style={styles.header}>
        <Pressable onPress={() => router.back()} hitSlop={12} accessibilityRole="button" accessibilityLabel="Back">
          <Ionicons name="chevron-back" size={26} color={t.text} />
        </Pressable>
        <Text style={styles.title}>Decky</Text>
        <View style={{ width: 26 }} />
      </View>

      {/* Pinned above the list so an armed reboot's countdown is visible no
          matter how far the plugin list is scrolled. */}
      <View style={{ paddingHorizontal: 14 }}>
        <ArmedActionBar
          armed={armed}
          boxName={settings.host}
          onCancel={cancel}
          onFireNow={fireNow}
        />
      </View>

      {!configured ? (
        <View style={styles.msg}><Text style={styles.msgText}>Pair a box first.</Text></View>
      ) : loader.loading && !l ? (
        <View style={styles.msg}><ActivityIndicator size="small" color={t.blue} /><Text style={styles.msgText}>Reaching the box…</Text></View>
      ) : !l ? (
        <View style={styles.msg}>
          <Text style={styles.msgText}>
            {loader.error
              ? 'Could not reach the box.'
              : 'This box does not offer Decky management (no Steam, or the Couchside service is too old).'}
          </Text>
        </View>
      ) : (
        <FlatList
          data={[{ key: 'overview', kind: 'overview' }, { key: 'controls', kind: 'controls' }, ...items] as ListItem[]}
          stickyHeaderIndices={[1]}
          keyExtractor={(i) => i.key}
          renderItem={renderItem}
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={{ paddingHorizontal: 14, paddingBottom: insets.bottom + 24, gap: 8 }}
          initialNumToRender={12}
          windowSize={7}
        />
      )}
      <Modal visible={!!menuPlugin} transparent animationType="fade" onRequestClose={() => setMenuPlugin(null)}>
        <View style={styles.modalBackdrop}><View style={styles.menu} accessibilityViewIsModal>
          <Text style={styles.title}>{menuPlugin?.name}</Text>
          <Text style={styles.sub}>Plugin actions</Text>
          {menuPlugin && !rowsDisabled ? <>
            {installedByName.get(menuPlugin.name) && !installedByName.get(menuPlugin.name)?.protected ? <>
              <Pressable accessibilityRole="button" style={styles.ghostBtn} onPress={() => { setMenuPlugin(null); reloadPlugin(installedByName.get(menuPlugin.name) as DeckyPlugin); }}><Text style={styles.ghostBtnText}>Reload this plugin</Text></Pressable>
              <Pressable accessibilityRole="button" style={styles.ghostBtn} onPress={() => { setMenuPlugin(null); uninstallPlugin(installedByName.get(menuPlugin.name) as DeckyPlugin); }}><Text style={[styles.ghostBtnText, { color: t.red }]}>Uninstall…</Text></Pressable>
            </> : null}
            {storeByName.get(menuPlugin.name) && !installedByName.get(menuPlugin.name)?.protected && !installsDisabled ? <Pressable accessibilityRole="button" style={styles.ghostBtn} onPress={() => { setMenuPlugin(null); installFromStore(storeByName.get(menuPlugin.name) as DeckyStoreEntry); }}><Text style={styles.ghostBtnText}>{installLabel(storeByName.get(menuPlugin.name)?.install_type ?? 'reinstall', storeByName.get(menuPlugin.name)?.versions[0]?.name ?? '')}…</Text></Pressable> : null}
          </> : <Text style={styles.faint}>Wait for the current operation to finish.</Text>}
          <Pressable accessibilityRole="button" style={styles.primaryBtn} onPress={() => setMenuPlugin(null)}><Text style={styles.primaryBtnText}>Close</Text></Pressable>
        </View></View>
      </Modal>
    </View>
  );
}

const makeStyles = (t: Palette) =>
  StyleSheet.create({
    stickyControls: { backgroundColor: t.bg, paddingVertical: 8 },
    moreBtn: { minWidth: 44, minHeight: 44, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 5, marginLeft: 'auto' },
    badgeRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 5 },
    pluginFooter: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginTop: 8 },
    installedLabel: { color: t.green, fontSize: 12, fontWeight: '600', alignSelf: 'center' },
    modalBackdrop: { flex: 1, backgroundColor: t.bg + 'ee', justifyContent: 'center', padding: 24 },
    menu: { backgroundColor: t.card, borderColor: t.cardBorder, borderWidth: 1, borderRadius: 20, padding: 20, gap: 14, width: '100%', maxWidth: 440, alignSelf: 'center' },
    emptyState: { paddingVertical: 20, gap: 14, alignItems: 'center' },
    skeleton: { width: '100%', height: 110, backgroundColor: t.card, borderColor: t.cardBorder, borderWidth: 1, borderRadius: 16, padding: 20, gap: 14 },
    skeletonLine: { backgroundColor: t.inset, height: 14, width: '85%', borderRadius: 5 },
    screen: { flex: 1, backgroundColor: t.bg },
    header: {
      flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
      paddingHorizontal: 12, paddingVertical: 10,
    },
    title: { color: t.text, fontSize: 20, fontWeight: '800' },
    card: {
      backgroundColor: t.card, borderColor: t.cardBorder, borderWidth: 1, borderRadius: 12,
      padding: 12, gap: 7,
    },
    cardHead: { flexDirection: 'row', alignItems: 'center', gap: 7 },
    cardTitle: { color: t.text, fontSize: 14, fontWeight: '800', flex: 1 },
    chip: { borderWidth: 1, borderRadius: 999, paddingHorizontal: 8, paddingVertical: 2 },
    chipText: { color: t.text, fontSize: 10, fontWeight: '800', letterSpacing: 0.5, textTransform: 'uppercase' },
    stateLine: { color: t.text, fontSize: 12, fontWeight: '600', lineHeight: 17 },
    kv: { flexDirection: 'row', alignItems: 'center', gap: 8 },
    k: { color: t.textDim, fontSize: 12, width: 64 },
    v: { color: t.text, fontSize: 12, fontFamily: mono, flex: 1 },
    warnLine: { color: t.amber, fontSize: 12, fontWeight: '600', lineHeight: 17 },
    faint: { color: t.textFaint, fontSize: 11, lineHeight: 16, marginTop: 4 },
    opRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
    opText: { color: t.text, fontSize: 12, fontWeight: '600', lineHeight: 17, flex: 1 },
    log: { padding: 8, borderRadius: 8, backgroundColor: t.inset, borderWidth: 1, borderColor: t.cardBorder },
    logLine: { color: t.textDim, fontSize: 10, fontFamily: mono, lineHeight: 14 },
    note: { color: t.text, fontSize: 12, fontWeight: '600', lineHeight: 17 },
    btnRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 2, alignItems: 'center' },
    primaryBtn: {
      flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: t.blue,
      minHeight: 44, borderRadius: 11, paddingVertical: 10, paddingHorizontal: 14,
    },
    primaryBtnText: { color: t.onAccent, fontSize: 13, fontWeight: '700' },
    warnBtn: {
      flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: t.card,
      minHeight: 44, borderRadius: 11, paddingVertical: 10, paddingHorizontal: 14, borderWidth: 1, borderColor: t.amber,
    },
    warnBtnText: { color: t.amber, fontSize: 13, fontWeight: '700' },
    ghostBtn: {
      flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: t.card,
      minHeight: 44, borderRadius: 11, paddingVertical: 10, paddingHorizontal: 14, borderWidth: 1, borderColor: t.cardBorder,
    },
    ghostBtnText: { color: t.text, fontSize: 13, fontWeight: '700' },
    linkBtn: { paddingVertical: 8, paddingHorizontal: 4 },
    link: { color: t.blue, fontSize: 12, fontWeight: '700' },
    pressed: { opacity: 0.7 },
    hint: { color: t.textFaint, fontSize: 11, lineHeight: 16 },
    code: { fontFamily: mono, color: t.textDim },
    banner: {
      backgroundColor: t.inset, borderColor: t.cardBorder, borderWidth: 1, borderRadius: 12,
      padding: 10, gap: 6,
    },
    tabBar: {
      flexDirection: 'row', gap: 4, padding: 4, borderRadius: 12,
      backgroundColor: t.inset, borderWidth: 1, borderColor: t.cardBorder,
    },
    tabItem: {
      flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6,
      paddingVertical: 9, borderRadius: 9,
    },
    tabItemActive: { backgroundColor: t.card, borderWidth: 1, borderColor: t.cardBorder },
    tabLabel: { color: t.textFaint, fontSize: 12, fontWeight: '700' },
    tabLabelActive: { color: t.text },
    countPill: { backgroundColor: t.blue, borderRadius: 999, paddingHorizontal: 6, paddingVertical: 1 },
    countPillText: { color: t.onAccent, fontSize: 10, fontWeight: '800' },
    listMeta: { color: t.textFaint, fontSize: 11, lineHeight: 16, marginTop: 6, paddingHorizontal: 2 },
    listMetaInline: { color: t.textFaint, fontSize: 11, marginLeft: 'auto' },
    controls: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 8 },
    searchWrap: {
      flex: 1, flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 12, height: 40,
      backgroundColor: t.card, borderRadius: 10, borderWidth: 1, borderColor: t.cardBorder,
    },
    search: { flex: 1, color: t.text, fontSize: 15, paddingVertical: 0 },
    iconBtn: {
      width: 40, height: 40, alignItems: 'center', justifyContent: 'center',
      backgroundColor: t.card, borderRadius: 10, borderWidth: 1, borderColor: t.cardBorder,
    },
    chips: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 8 },
    sortChip: {
      paddingVertical: 5, paddingHorizontal: 10, borderRadius: 999,
      backgroundColor: t.card, borderWidth: 1, borderColor: t.cardBorder,
    },
    sortChipOn: { borderColor: t.blue },
    sortChipText: { color: t.textDim, fontSize: 12, fontWeight: '600' },
    sortChipTextOn: { color: t.blue },
    row: {
      flexDirection: 'row', gap: 12, padding: 16,
      backgroundColor: t.card, borderRadius: 12, borderWidth: 1, borderColor: t.cardBorder,
    },
    rowMain: { flex: 1, gap: 3 },
    rowTitle: { flexDirection: 'row', alignItems: 'center', gap: 6 },
    dot: { width: 8, height: 8, borderRadius: 4 },
    name: { color: t.text, fontSize: 16, fontWeight: '700', flexShrink: 1 },
    badge: {
      flexDirection: 'row', alignItems: 'center', gap: 3, borderWidth: 1, borderRadius: 999,
      paddingHorizontal: 6, paddingVertical: 1,
    },
    badgeText: { color: t.amber, fontSize: 10, fontWeight: '800' },
    sub: { color: t.textDim, fontSize: 12 },
    desc: { color: t.textDim, fontSize: 13, lineHeight: 19, marginVertical: 6 },
    actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 6 },
    icon: { width: 48, height: 48, borderRadius: 12, backgroundColor: t.inset },
    iconFallback: { alignItems: 'center', justifyContent: 'center' },
    msg: { flexDirection: 'row', alignItems: 'center', gap: 10, padding: 16, justifyContent: 'center' },
    msgText: { color: t.textFaint, fontSize: 13, lineHeight: 19, textAlign: 'center', flexShrink: 1 },
  });
