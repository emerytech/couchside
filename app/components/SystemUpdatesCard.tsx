/**
 * One compact card for updating the box's software (Flatpak apps + OS), in
 * Setup > Account under the agent-update banner. Replaces three tall cards with
 * a couple of tight rows and a single button.
 *
 * Pure ORCHESTRATION over the already-strict per-updater endpoints — there is no
 * "update all" route on the agent; the app fires flatpak then OS in that fixed
 * order (flatpak applies live; OS stages for a reboot that ends the session, so
 * it goes last). Each step's completion is read BACK from the box (flatpak
 * pending -> 0, OS staged), never assumed from having started.
 *
 * Probe-and-appear: rows only exist for updaters the box actually has (each
 * status 404s otherwise). The action needs the one-time opt-in
 * (`couchside allow-system-updates on`); without it the card shows the hint and
 * the button is disabled — there is no unprivileged way to update system apps
 * or an OS image.
 */
import Ionicons from '@expo/vector-icons/Ionicons';
import { useCallback, useRef, useState } from 'react';
import { Alert, Pressable, StyleSheet, Text, View } from 'react-native';

import { usePoll } from '@/hooks/usePoll';
import { useArmedAction } from '@/hooks/useArmedAction';
import { ArmedActionBar } from '@/components/ArmedActionBar';
import { api, FlatpakStatus, hostKey, OsStatus } from '@/lib/api';
import { flatpakStartMessage, isFlatpakUpdateComplete } from '@/lib/flatpakUpdate';
import { hapticLight } from '@/lib/haptics';
import { useSettings } from '@/lib/SettingsContext';
import { mono, useTheme, useThemedStyles } from '@/lib/theme';
import type { Palette } from '@/lib/theme';

const POLL_MS = 30 * 60 * 1000;
/** How long a press waits for a fresh flatpak status before using the cached
 *  count. Long enough for a normal LAN round-trip, short enough that a slow
 *  `remote-ls` on the box never makes the press look dead. */
const FRESH_STATUS_DEADLINE_MS = 1500;
type Step = 'idle' | 'running' | 'done' | 'staged' | 'skipped';

function Row({
  icon,
  label,
  value,
  step,
  onUpdate,
  canUpdate,
}: {
  icon: string;
  label: string;
  value: string;
  step: Step;
  onUpdate?: () => void;
  canUpdate?: boolean;
}) {
  const t = useTheme();
  const styles = useThemedStyles(makeStyles);
  const statusIcon =
    step === 'done' || step === 'staged'
      ? 'checkmark-circle'
      : step === 'running'
        ? 'sync'
        : null;
  const statusColor = step === 'staged' ? (t.amber ?? t.blue) : t.green;
  return (
    <View style={styles.row}>
      <Ionicons name={icon as never} size={15} color={t.textDim} />
      <Text style={styles.rowLabel}>{label}</Text>
      <Text style={styles.rowValue} numberOfLines={1}>
        {value}
      </Text>
      {/* A failed press marks the ROW, beside (not instead of) its Update
          button so the retry stays reachable; the `msg` line below says why.
          'idle' stays icon-free — this is the one state that must not look
          like nothing was pressed. */}
      {step === 'skipped' && (
        <Ionicons name="alert-circle" size={15} color={t.amber ?? t.red} />
      )}
      {statusIcon ? (
        <Ionicons name={statusIcon} size={15} color={statusColor} />
      ) : canUpdate && onUpdate ? (
        // Per-row update: do just this one, without touching the other. Small
        // and quiet so "Update everything" below stays the primary action.
        <Pressable onPress={onUpdate} hitSlop={8} style={styles.rowBtn}>
          <Text style={styles.rowBtnText}>Update</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

export function SystemUpdatesCard() {
  const t = useTheme();
  const styles = useThemedStyles(makeStyles);
  const { settings } = useSettings();
  const configured = settings.host.trim().length > 0;

  const fp = usePoll<FlatpakStatus | null>(
    () => api.flatpakStatus(settings),
    POLL_MS,
    configured,
    hostKey(settings),
  );
  const os = usePoll<OsStatus | null>(
    () => api.osStatus(settings),
    POLL_MS,
    configured,
    hostKey(settings),
  );

  const [running, setRunning] = useState(false);
  const [fpStep, setFpStep] = useState<Step>('idle');
  const [osStep, setOsStep] = useState<Step>('idle');
  const [msg, setMsg] = useState<string | null>(null);
  const [rebooting, setRebooting] = useState(false);
  const runningRef = useRef(false);

  const hasFp = fp.data != null;
  const hasOs = os.data != null;
  const elevated = (fp.data?.elevated ?? false) || (os.data?.elevated ?? false);
  const osStaged = osStep === 'staged' || (os.data?.staged ?? false);

  const drain = useCallback(
    async (poll: () => Promise<boolean>) => {
      for (let i = 0; i < 120; i++) {
        await new Promise((r) => setTimeout(r, 5000));
        // Probe at 5s and 10s, then every 30s. With the agent's `running`
        // signal a `--user` "Nothing to do" finishes in under a second; the
        // old first probe at 30s showed a half-minute spinner for a no-op, so
        // the honest note arrived late enough to look like a hang. Not every
        // 5s: each status GET costs the box a `sudo -l` and a network
        // remote-ls.
        if ((i < 2 || i % 6 === 5) && (await poll().catch(() => false))) return true;
      }
      return false;
    },
    [],
  );

  // One flatpak run, self-contained so it can be fired on its own (tap the Apps
  // row) OR as step 1 of "everything".
  const runFlatpak = useCallback(async () => {
    setFpStep('running');
    try {
      const r = await api.flatpakUpdate(settings);
      if (r.started) {
        // Wait for the box's update PROCESS to finish, polled via `running`
        // (agent >= 2.9.59) — NOT `count === 0`. An end-of-life runtime that
        // `flatpak update` can't apply pins the count above zero forever, so
        // count===0 was unreachable: the drain ran its full 10 minutes, a
        // successful update showed as "skipped", and in "update everything" the
        // OS step was blocked behind that dead wait (KI-036). Old agents don't
        // send `running`, so fall back to the historical count===0 there.
        await drain(async () => isFlatpakUpdateComplete(await api.flatpakStatus(settings)));
        // It launched and we waited it out. A count that remains is an
        // un-updatable app (e.g. an EOL runtime) — honest to leave shown, not a
        // failure. Only an update that never STARTED is "skipped".
        setFpStep('done');
        // ...but an un-elevated run with system updates still pending did
        // nothing visible; say why, or the checkmark lies.
        const note = flatpakStartMessage(r, fp.data?.count ?? 0);
        if (note) setMsg(note);
      } else {
        // Never silently revert: the agent's diagnostics are in `r`. Discarding
        // them here is what made a failed press look like no press at all.
        setFpStep('skipped');
        setMsg(flatpakStartMessage(r, fp.data?.count ?? 0));
      }
    } catch {
      setFpStep('skipped');
      setMsg('Could not reach the box to start the update.');
    }
    fp.refresh();
  }, [drain, fp, settings]);

  // One OS run — stages for a reboot, so nothing may follow it in a sequence.
  const runOs = useCallback(async () => {
    setOsStep('running');
    try {
      const r = await api.osUpdate(settings);
      if (r.started) {
        const staged = await drain(async () => (await api.osStatus(settings))?.staged === true);
        setOsStep(staged ? 'staged' : 'done');
      } else {
        setOsStep('skipped');
        // Same silent-failure class as the flatpak row: a spawn error or a
        // 400ms death carries error/exit_code/lines; say them. The opt-in
        // refusal keeps its friendlier copy.
        setMsg(
          r.needs_optin
            ? 'OS updates are not enabled on this box.'
            : flatpakStartMessage(r, 0),
        );
      }
    } catch {
      setOsStep('skipped');
      setMsg('Could not reach the box to start the update.');
    }
    os.refresh();
  }, [drain, os, settings]);

  // `which`: 'flatpak' | 'os' | 'all'. A row taps its own target; the button
  // runs everything (flatpak first — live — then OS, which stages for a reboot).
  const run = useCallback(
    async (which: 'flatpak' | 'os' | 'all') => {
      if (runningRef.current) return;
      runningRef.current = true;
      setRunning(true);
      setMsg(null);
      if (which !== 'os') setFpStep('idle');
      if (which !== 'flatpak') setOsStep('idle');

      // Decide on FRESH box state, not the 30-minute cache: updates that
      // appeared (or a grant added) while this tab sat open were invisible,
      // and "nothing pending" from a stale count painted a green checkmark on
      // apps that were never updated. But a status GET costs the box a
      // `flatpak remote-ls` (30s timeout on a slow network), and a press that
      // sits there before anything starts reads as a hang — so RACE the fresh
      // read against a short deadline and fall back to the cached count; the
      // polls are refreshed regardless so the UI catches up.
      const freshFp = await Promise.race([
        api.flatpakStatus(settings).catch(() => null),
        new Promise<null>((r) => setTimeout(() => r(null), FRESH_STATUS_DEADLINE_MS)),
      ]);
      const pending = freshFp?.count ?? fp.data?.count ?? 0;
      fp.refresh();
      os.refresh();

      if ((which === 'flatpak' || which === 'all') && hasFp) {
        if (pending > 0) await runFlatpak();
        else setFpStep('done');
      }
      if ((which === 'os' || which === 'all') && hasOs) {
        await runOs();
      }

      setRunning(false);
      runningRef.current = false;
    },
    [fp.data?.count, hasFp, hasOs, runFlatpak, runOs],
  );

  // Confirm once, then a cancellable countdown (Cancel / Do it now) before the
  // reboot actually fires — the same window the Actions tab gives a session-
  // ending action, instead of the one-shot Alert this used to be.
  const { armed, arm, cancel, fireNow } = useArmedAction(hostKey(settings));
  const runReboot = useCallback(() => {
    void (async () => {
      setRebooting(true);
      hapticLight();
      try {
        await api.runAction(settings, 'reboot');
      } catch {
        // connection drops on reboot — expected
      } finally {
        setRebooting(false);
      }
    })();
  }, [settings]);
  const reboot = useCallback(() => {
    Alert.alert('Reboot the box?', 'This applies the staged OS update. Any unsaved work will be lost.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Reboot', style: 'destructive', onPress: () => arm('Reboot the box', runReboot) },
    ]);
  }, [arm, runReboot]);

  if (!configured || (!hasFp && !hasOs)) return null;

  const count = fp.data?.count ?? 0;
  const osName = os.data?.kind === 'steamos' ? 'SteamOS' : 'Bazzite';

  return (
    <View style={styles.card}>
      <View style={styles.header}>
        <Ionicons name="cube-outline" size={16} color={t.blue} />
        <Text style={styles.title} numberOfLines={1}>
          Box software
        </Text>
      </View>

      {hasFp && (
        <Row
          icon="apps-outline"
          label="Apps"
          value={count > 0 ? `${count} update${count === 1 ? '' : 's'}` : 'up to date'}
          step={fpStep}
          canUpdate={!running && elevated && count > 0}
          onUpdate={() => {
            hapticLight();
            void run('flatpak');
          }}
        />
      )}
      {hasOs && (
        <Row
          icon="hardware-chip-outline"
          label={osName}
          value={osStaged ? 'staged · reboot to apply' : (os.data?.current ?? 'up to date')}
          step={osStep}
          canUpdate={!running && elevated && !osStaged}
          onUpdate={() => {
            hapticLight();
            void run('os');
          }}
        />
      )}

      {msg ? <Text style={styles.msg}>{msg}</Text> : null}

      <ArmedActionBar
        armed={armed}
        boxName={settings.host}
        onCancel={cancel}
        onFireNow={fireNow}
      />

      {osStaged ? (
        <Pressable
          onPress={reboot}
          disabled={rebooting}
          style={({ pressed }) => [styles.btn, pressed && styles.btnPressed]}>
          <Text style={styles.btnText}>{rebooting ? 'Rebooting…' : 'Reboot to finish'}</Text>
        </Pressable>
      ) : (
        <Pressable
          onPress={() => {
            hapticLight();
            void run('all');
          }}
          disabled={running || !elevated}
          style={({ pressed }) => [
            styles.btn,
            (pressed || !elevated) && styles.btnPressed,
          ]}>
          <Text style={styles.btnText}>{running ? 'Updating…' : 'Update everything'}</Text>
        </Pressable>
      )}

      {!elevated && (
        // Pressable: the grant lives on the box, and `elevated` rides a
        // 30-minute poll — so after running the command, a tap here re-checks
        // instead of leaving the buttons dead until the next poll.
        <Pressable
          onPress={() => {
            hapticLight();
            fp.refresh();
            os.refresh();
          }}
          accessibilityRole="button"
          accessibilityLabel="Re-check whether system updates are enabled">
          <Text style={styles.hint}>
            Enable on the box: <Text style={styles.code}>couchside allow-system-updates on</Text>
            {' '}· tap to re-check
          </Text>
        </Pressable>
      )}
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
  row: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  rowLabel: { color: t.textDim, fontSize: 12, width: 64 },
  rowValue: { color: t.text, fontSize: 12, fontFamily: mono, flex: 1 },
  rowBtn: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 6, backgroundColor: t.inset },
  rowBtnText: { color: t.blue, fontSize: 11, fontWeight: '700' },
  msg: { color: t.textDim, fontSize: 12, lineHeight: 17 },
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
