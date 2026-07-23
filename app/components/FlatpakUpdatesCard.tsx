/**
 * Flatpak updates card (Setup > Account, under the agent-update banner).
 *
 * Probe-and-appear: agents < 2.9.46 and boxes without flatpak 404 the status
 * endpoint, so the card renders nothing there. The box does all the network
 * work (remote-ls against its own configured remotes); the app only reads the
 * result over the LAN — same privacy stance as AgentUpdateBanner.
 *
 * The Update button fires ONE frozen box-side command (the app sends no body,
 * names no package). While it runs, the card tails the box's transcript the
 * same way the agent update does, and calls it done when the box's own pending
 * count returns 0 — reading the state back, not trusting that starting implied
 * finishing.
 *
 * When the box CAN'T update system apps (elevated:false — the owner never ran
 * `couchside allow-system-updates on`), the card says so and shows the command,
 * mirroring AgentUpdateBanner's opt-in hint. The app can never flip that switch
 * itself; the whole point of the opt-in is that it happens on the box.
 */
import Ionicons from '@expo/vector-icons/Ionicons';
import { useCallback, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { usePoll } from '@/hooks/usePoll';
import { api, FlatpakStatus, hostKey } from '@/lib/api';
import { hapticLight } from '@/lib/haptics';
import { useSettings } from '@/lib/SettingsContext';
import { mono, useTheme, useThemedStyles } from '@/lib/theme';
import type { Palette } from '@/lib/theme';

const POLL_MS = 30 * 60 * 1000; // matches the agent-update cadence

/**
 * The most recent transcript line a person can act on. flatpak's output is
 * dominated by icon-cache warnings and byte counters; the lines that mean
 * something start with Updating/Installing. Same philosophy as the installer's
 * lastMeaningful(), tuned to flatpak's shape.
 */
function lastMeaningful(lines: string[]): string | null {
  const real = lines
    .map((l) => l.trim())
    .filter((l) => /^(Updating|Installing) /.test(l));
  const pick = real[real.length - 1] ?? lines[lines.length - 1]?.trim();
  if (!pick) return null;
  // "Updating app/org.mozilla.firefox/x86_64/stable" -> "Updating org.mozilla.firefox"
  const m = pick.match(/^(Updating|Installing) (?:app|runtime)\/([^/]+)/);
  const text = m ? `${m[1]} ${m[2]}` : pick;
  return text.length > 68 ? text.slice(0, 67) + '…' : text;
}

export function FlatpakUpdatesCard() {
  const t = useTheme();
  const styles = useThemedStyles(makeStyles);
  const { settings } = useSettings();
  const configured = settings.host.trim().length > 0;
  const poll = usePoll<FlatpakStatus | null>(
    () => api.flatpakStatus(settings),
    POLL_MS,
    configured,
    hostKey(settings),
  );
  const status = poll.data;

  const [running, setRunning] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [step, setStep] = useState<string | null>(null);
  const runningRef = useRef(false);

  const run = useCallback(async () => {
    if (runningRef.current) return;
    runningRef.current = true;
    setRunning(true);
    setMsg('Starting the update on your box…');
    try {
      const r = await api.flatpakUpdate(settings);
      if (!r.started) {
        setMsg(`Couldn't start (${r.error ?? 'unknown error'}).`);
        return;
      }
      setMsg(
        r.elevated
          ? 'Updating apps on your box…'
          : 'Updating your per-user apps… (system apps need the opt-in below)',
      );
      // Tail the transcript until the box's own pending count reads 0 (or we
      // give up waiting — big runtimes legitimately take many minutes, so the
      // cap is generous and the timeout message stays honest: started, not
      // failed).
      let done = false;
      for (let i = 0; i < 120 && !done; i++) {
        await new Promise((res) => setTimeout(res, 5000));
        try {
          const lines = await api.flatpakLog(settings);
          const last = lastMeaningful(lines);
          if (last) setStep(last);
        } catch {
          // progress line is a nicety, never a blocker
        }
        // Every ~30s, ask the box how much is left. remote-ls is a network
        // call on the box, so not every tick.
        if (i % 6 === 5) {
          try {
            const s2 = await api.flatpakStatus(settings);
            if (s2 && s2.count === 0) {
              setMsg('All apps up to date.');
              setStep(null);
              poll.refresh();
              done = true;
            }
          } catch {
            // box busy — keep tailing
          }
        }
      }
      if (!done) {
        setMsg('Still updating — large apps can take a while. Check back shortly.');
        setStep(null);
        poll.refresh();
      }
    } catch (e) {
      const detail = e instanceof Error ? e.message : String(e);
      setMsg(`Couldn't start the update (${detail}).`);
    } finally {
      setRunning(false);
      runningRef.current = false;
    }
  }, [poll, settings]);

  // Probe-and-appear: no box, old agent, or no flatpak -> nothing at all.
  if (!configured || status == null) return null;

  const count = status.count;

  return (
    <View style={styles.card}>
      <View style={styles.header}>
        <Ionicons name="cube-outline" size={18} color={t.blue} />
        <Text style={styles.title} numberOfLines={1}>
          App updates on your box
        </Text>
        {count > 0 && !running && (
          <View style={styles.badge}>
            <Text style={styles.badgeText}>{count}</Text>
          </View>
        )}
      </View>

      {msg ? (
        <>
          <Text style={styles.msg}>{msg}</Text>
          {step ? <Text style={styles.step}>{step}</Text> : null}
        </>
      ) : count > 0 ? (
        <>
          <Text style={styles.sub}>
            {count === 1
              ? '1 Flatpak app has an update.'
              : `${count} Flatpak apps have updates.`}
          </Text>
          <Pressable
            onPress={() => {
              hapticLight();
              void run();
            }}
            disabled={running}
            style={({ pressed }) => [styles.btn, pressed && styles.btnPressed]}>
            <Text style={styles.btnText}>{running ? 'Updating…' : 'Update apps'}</Text>
          </Pressable>
        </>
      ) : (
        <Text style={styles.sub}>Flatpak apps are up to date.</Text>
      )}

      {/* The opt-in hint renders whenever system updates are off — including
          mid-run, because a --user run on a system-app box is exactly when the
          user needs to learn why nothing moved. */}
      {!status.elevated && (
        <Text style={styles.hint}>
          System apps need a one-time opt-in on the box:{' '}
          <Text style={styles.code}>couchside allow-system-updates on</Text>
          {' '}— it shows exactly what it grants before enabling.
        </Text>
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
    padding: 14,
    marginBottom: 14,
    gap: 8,
  },
  header: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  title: { color: t.text, fontSize: 14, fontWeight: '700', flex: 1 },
  badge: {
    backgroundColor: t.blue,
    borderRadius: 10,
    minWidth: 20,
    paddingHorizontal: 6,
    paddingVertical: 2,
    alignItems: 'center',
  },
  badgeText: { color: '#0b1220', fontSize: 12, fontWeight: '700' },
  sub: { color: t.textDim, fontSize: 13, lineHeight: 19 },
  btn: {
    backgroundColor: t.blue,
    borderRadius: 10,
    paddingVertical: 11,
    alignItems: 'center',
    marginTop: 2,
  },
  btnPressed: { opacity: 0.85 },
  btnText: { color: '#0b1220', fontSize: 14, fontWeight: '700' },
  msg: { color: t.text, fontSize: 13, lineHeight: 19 },
  step: { color: t.textDim, fontSize: 11, lineHeight: 16, fontFamily: mono, marginTop: 3 },
  hint: { color: t.textDim, fontSize: 12, lineHeight: 18 },
  code: { fontFamily: mono, color: t.text },
});
