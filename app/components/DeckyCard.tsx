/**
 * Setup › Account — the "Decky Loader" card under Box software, plus the
 * confirm helpers and the loader-op hook every Decky surface shares (this
 * card, the Utilities row, the /decky screen), so the three never word the
 * same consent differently.
 *
 * Spec: docs/memory/project_decky-manager.md §12 bullet 2. NOT pref-gated: the
 * box-side opt-in (`couchside allow-decky on`) is the consent, and the card is
 * where that opt-in is discoverable from the phone the owner actually holds.
 *
 * Probe-and-appear, in PHASES. The card derives SOLELY from GET /api/decky/loader
 * (Phase A): a 404 hides it entirely, and it also hides when the box has neither
 * a loader, the opt-in, nor the installer (nothing to say). The "N plugin
 * updates" line is a SEPARATE probe of GET /api/decky/plugins, rendered only
 * when it answers — a Phase A agent 404s that route and the card is unaffected.
 *
 * The poll runs slow (30 s) except while a loader op is in flight, when it
 * tightens to 2 s so "Starting…" → running → done paints as it happens. The op's
 * result is the AGENT's correlated verdict (spec §4.5): a previous run's `done`
 * is never shown as this run's outcome, so the card renders "Starting…" until
 * a fresh result or the lock appears — never a stale success.
 */
import Ionicons from '@expo/vector-icons/Ionicons';
import { router } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Alert, Platform, Pressable, StyleSheet, Text, View } from 'react-native';

import { usePoll } from '@/hooks/usePoll';
import { api, ApiError, hostKey, type DeckyLoader, type DeckyPluginsList } from '@/lib/api';
import {
  apiErrorHint, canRunLoaderOp, DECKY_INSTALL_ALERT, DECKY_RESTART_ALL_PLUGINS, DECKY_UNINSTALL_KEEPS,
  deckyHint, describeLoaderState, isLoaderOpActive, loaderOpCopy, runResultCopy, type Tone,
} from '@/lib/deckyPlugins';
import { hapticLight, hapticSuccess, hapticWarning } from '@/lib/haptics';
import { useSettings } from '@/lib/SettingsContext';
import { mono, useTheme, useThemedStyles, type Palette } from '@/lib/theme';

/**
 * House confirm: native Alert, `window.confirm` on web (the harness has no
 * Alert). `destructive` styles the OK button red on iOS.
 */
export function deckyConfirm(
  title: string,
  message: string,
  okLabel: string,
  onOk: () => void,
  destructive = false,
): void {
  if (Platform.OS === 'web') {
    // eslint-disable-next-line no-alert
    if (typeof window !== 'undefined' && window.confirm(`${title}\n\n${message}`)) onOk();
    return;
  }
  Alert.alert(title, message, [
    { text: 'Cancel', style: 'cancel' },
    { text: okLabel, style: destructive ? 'destructive' : 'default', onPress: onOk },
  ]);
}

/** Install and Repair share ONE procedure on the box (spec §11) and ONE alert:
 *  the root-from-home sentence first, then GitHub / no checksum / Steam restart. */
export function confirmDeckyLoaderInstall(mode: 'install' | 'repair', onOk: () => void): void {
  deckyConfirm(
    mode === 'repair' ? 'Repair Decky Loader?' : 'Install Decky Loader?',
    mode === 'repair'
      ? `${DECKY_INSTALL_ALERT}\n\nRepair re-downloads the loader, re-pins its service file and restarts it — every plugin restarts. Your plugins and settings are kept.`
      : DECKY_INSTALL_ALERT,
    mode === 'repair' ? 'Repair' : 'Install',
    onOk,
  );
}

/** Uninstall mirrors upstream: plugins/ and settings/ stay (spec §11). */
export function confirmDeckyLoaderUninstall(onOk: () => void): void {
  deckyConfirm(
    'Uninstall Decky Loader?',
    `The loader service and its binary are removed. ${DECKY_UNINSTALL_KEEPS} Reinstalling later brings them back.`,
    'Uninstall',
    onOk,
    true,
  );
}

/** KI-037: a loader restart restarts EVERY plugin — said every time it is offered. */
export function confirmRestartDecky(onOk: () => void, title = 'Restart Decky?'): void {
  deckyConfirm(
    title,
    `${DECKY_RESTART_ALL_PLUGINS} Any plugin mid-task loses its state; Steam's Decky menu blinks.`,
    'Restart',
    onOk,
  );
}

export type DeckyNote = { tone: 'ok' | 'err' | 'info'; msg: string };

/**
 * Start a loader op (install/repair or uninstall) through the Utilities tenant
 * and report ONLY what the box confirmed. A client timeout is never a failure:
 * the box confirms `started` in <=3 s but the app's transport can still lose the
 * reply, and the loader poll is the truth — so a timeout says "still starting"
 * and hands control to the poll (`onStarted`), exactly like the OpenPuck flash.
 */
export function useDeckyLoaderOp(onStarted: () => void): {
  start: (mode: 'install' | 'uninstall') => void;
  busy: boolean;
  note: DeckyNote | null;
  clearNote: () => void;
} {
  const { settings } = useSettings();
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<DeckyNote | null>(null);
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    return () => { live.current = false; };
  }, []);

  const start = useCallback((mode: 'install' | 'uninstall') => {
    hapticLight();
    setBusy(true);
    setNote(null);
    void (async () => {
      try {
        const r = await api.runUtility(settings, 'decky', undefined, { op: mode });
        if (!live.current) return;
        if (r.started) {
          hapticSuccess();
          setNote({ tone: 'info', msg: 'Starting…' });
          onStarted();
        } else {
          hapticWarning();
          setNote({ tone: 'err', msg: runResultCopy(r) ?? 'Could not start.' });
        }
      } catch (e) {
        if (!live.current) return;
        if (e instanceof ApiError && e.kind === 'timeout') {
          // The box may have started the unit and we lost the reply — the poll
          // decides. Never "failed" from a timeout alone.
          setNote({ tone: 'info', msg: 'Still starting — the box reports the result here.' });
          onStarted();
        } else if (e instanceof ApiError && e.kind === 'http') {
          hapticWarning();
          setNote({ tone: 'err', msg: apiErrorHint(e.status, e.body, e.message).text });
        } else {
          hapticWarning();
          setNote({ tone: 'err', msg: 'Could not reach the box.' });
        }
      } finally {
        if (live.current) setBusy(false);
      }
    })();
  }, [settings, onStarted]);

  return { start, busy, note, clearNote: () => setNote(null) };
}

const POLL_SLOW_MS = 30 * 1000;
const POLL_OP_MS = 2000;

export function toneColor(t: Palette, tone: Tone): string {
  return tone === 'good' ? t.green : tone === 'action' ? t.blue : tone === 'warn' ? t.amber : t.textFaint;
}

export function DeckyCard() {
  const t = useTheme();
  const styles = useThemedStyles(makeStyles);
  const { settings } = useSettings();
  const configured = settings.host.trim().length > 0;

  const [fast, setFast] = useState(false);
  const loader = usePoll<DeckyLoader | null>(
    () => api.deckyLoader(settings),
    fast ? POLL_OP_MS : POLL_SLOW_MS,
    configured,
    hostKey(settings),
  );
  const l = loader.data;
  const opActive = isLoaderOpActive(l?.op);
  useEffect(() => { setFast(opActive); }, [opActive]);

  // Phase B line, its own probe: absent on a Phase A agent, card intact.
  const plugins = usePoll<DeckyPluginsList | null>(
    () => api.deckyPlugins(settings),
    60 * 1000,
    configured && !!l?.installed,
    hostKey(settings),
  );

  const refreshLoader = loader.refresh;   // stable (useCallback []), unlike the poll object
  const onStarted = useCallback(() => { setFast(true); refreshLoader(); }, [refreshLoader]);
  const op = useDeckyLoaderOp(onStarted);

  if (!configured || !l) return null;
  // Nothing to say: no loader, no opt-in, no installer on the box.
  if (!l.installed && !l.allowed && !l.installer_ready) return null;

  const d = describeLoaderState(l);
  const hint = deckyHint(l);
  const canOp = canRunLoaderOp(l);
  const opLine = loaderOpCopy(l.op);
  const pl = plugins.data;
  const updates = pl && pl.available ? pl.updates : null;

  return (
    <View style={styles.card} testID="decky-card">
      <View style={styles.header}>
        <Ionicons name="extension-puzzle-outline" size={16} color={t.blue} />
        <Text style={styles.title} numberOfLines={1}>Decky Loader</Text>
        <View style={[styles.chip, { borderColor: toneColor(t, d.tone) }]}>
          <Text style={[styles.chipText, { color: toneColor(t, d.tone) }]}>{d.chip}</Text>
        </View>
      </View>

      <Text style={[styles.line, { color: toneColor(t, d.tone) }]}>{d.line}</Text>

      {l.installed ? (
        <View style={styles.row}>
          <Ionicons name="pricetag-outline" size={14} color={t.textDim} />
          <Text style={styles.rowLabel}>Version</Text>
          <Text style={styles.rowValue} numberOfLines={1}>
            {l.loader_update?.current ?? l.version ?? 'unknown'}
            {l.loader_update?.updatable && l.loader_update.remote ? `  →  ${l.loader_update.remote} available` : ''}
          </Text>
        </View>
      ) : null}

      {/* Phase B only: rendered when the plugins route answers. */}
      {pl && pl.available ? (
        <View style={styles.row}>
          <Ionicons name="apps-outline" size={14} color={t.textDim} />
          <Text style={styles.rowLabel}>Plugins</Text>
          <Text style={styles.rowValue} numberOfLines={1}>
            {`${pl.plugins.length} installed`}
            {updates != null ? ` · ${updates} update${updates === 1 ? '' : 's'}` : ''}
          </Text>
        </View>
      ) : null}

      {opLine ? (
        <View style={styles.opRow}>
          {opActive ? <ActivityIndicator size="small" color={t.blue} /> : null}
          <Text style={[styles.opText, { color: toneColor(t, opLine.tone) }]}>{opLine.line}</Text>
        </View>
      ) : null}

      {op.note && !(opLine && op.note.tone === 'info') ? (
        <Text style={[styles.note, { color: op.note.tone === 'ok' ? t.green : op.note.tone === 'err' ? t.red : t.blue }]}>
          {op.note.msg}
        </Text>
      ) : null}

      {l.installed ? (
        <Pressable
          onPress={() => { hapticLight(); router.push('/decky'); }}
          testID="decky-manage"
          style={({ pressed }) => [styles.btn, pressed && styles.btnPressed]}
          accessibilityRole="button"
          accessibilityLabel="Manage Decky Loader and plugins">
          <Text style={styles.btnText}>Manage ›</Text>
        </Pressable>
      ) : l.allowed && l.state === 'not_installed' && canOp ? (
        <Pressable
          onPress={() => confirmDeckyLoaderInstall('install', () => op.start('install'))}
          disabled={op.busy}
          testID="decky-install"
          style={({ pressed }) => [styles.btn, (pressed || op.busy) && styles.btnPressed]}
          accessibilityRole="button"
          accessibilityLabel="Install Decky Loader">
          <Text style={styles.btnText}>{op.busy ? 'Starting…' : 'Install Decky Loader'}</Text>
        </Pressable>
      ) : null}

      {/* The opt-in / installer / helper hint — shown whatever the loader state,
          so the feature is discoverable from the phone (spec §5). */}
      {hint ? (
        hint.kind === 'optin' ? (
          <Text style={styles.hint}>
            Enable on the box: <Text style={styles.code}>couchside allow-decky on</Text>
          </Text>
        ) : (
          <Text style={styles.hint}>{hint.text}</Text>
        )
      ) : null}
    </View>
  );
}

const makeStyles = (t: Palette) => StyleSheet.create({
  card: {
    backgroundColor: t.card,
    borderColor: t.cardBorder,
    borderWidth: 1,
    borderRadius: 12,
    padding: 12,
    marginBottom: 14,
    gap: 7,
  },
  header: { flexDirection: 'row', alignItems: 'center', gap: 7 },
  title: { color: t.text, fontSize: 13, fontWeight: '700', flex: 1 },
  chip: { borderWidth: 1, borderRadius: 999, paddingHorizontal: 8, paddingVertical: 2 },
  chipText: { fontSize: 10, fontWeight: '800', letterSpacing: 0.5, textTransform: 'uppercase' },
  line: { fontSize: 12, fontWeight: '600', lineHeight: 17 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  rowLabel: { color: t.textDim, fontSize: 12, width: 64 },
  rowValue: { color: t.text, fontSize: 12, fontFamily: mono, flex: 1 },
  opRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  opText: { fontSize: 12, fontWeight: '600', lineHeight: 17, flex: 1 },
  note: { fontSize: 12, fontWeight: '600', lineHeight: 17 },
  btn: {
    backgroundColor: t.blue,
    borderRadius: 9,
    paddingVertical: 9,
    alignItems: 'center',
    marginTop: 1,
  },
  btnPressed: { opacity: 0.85 },
  btnText: { color: t.onAccent, fontSize: 13, fontWeight: '700' },
  hint: { color: t.textFaint, fontSize: 11, lineHeight: 16 },
  code: { fontFamily: mono, color: t.textDim },
});
