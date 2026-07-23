/**
 * Atomic OS update card (Setup > Account, under the Flatpak card).
 *
 * SteamOS / Bazzite only — osStatus 404s elsewhere and the card renders nothing
 * (probe-and-appear). An atomic OS update STAGES for the next boot, so this card
 * is honest about that: after an update runs it shows "Staged — reboot to apply"
 * and a Reboot button, never a bare "done". The staged state is read back from
 * the box (rpm-ostree status), not inferred from having started.
 *
 * Requires the same opt-in as the Flatpak card. Unlike flatpak there is no
 * unprivileged fallback for an OS image, so without the grant the card shows the
 * opt-in hint and the Update button is disabled.
 */
import Ionicons from '@expo/vector-icons/Ionicons';
import { useCallback, useRef, useState } from 'react';
import { Alert, Pressable, StyleSheet, Text, View } from 'react-native';

import { usePoll } from '@/hooks/usePoll';
import { api, hostKey, OsStatus } from '@/lib/api';
import { hapticLight } from '@/lib/haptics';
import { useSettings } from '@/lib/SettingsContext';
import { mono, useTheme, useThemedStyles } from '@/lib/theme';
import type { Palette } from '@/lib/theme';

const POLL_MS = 30 * 60 * 1000;

function lastMeaningful(lines: string[]): string | null {
  const real = lines
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !/^Note:/.test(l));
  const pick = real[real.length - 1];
  if (!pick) return null;
  return pick.length > 68 ? pick.slice(0, 67) + '…' : pick;
}

export function OsUpdateCard() {
  const t = useTheme();
  const styles = useThemedStyles(makeStyles);
  const { settings } = useSettings();
  const configured = settings.host.trim().length > 0;
  const poll = usePoll<OsStatus | null>(
    () => api.osStatus(settings),
    POLL_MS,
    configured,
    hostKey(settings),
  );
  const status = poll.data;

  const [running, setRunning] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [step, setStep] = useState<string | null>(null);
  const [rebooting, setRebooting] = useState(false);
  const runningRef = useRef(false);

  const run = useCallback(async () => {
    if (runningRef.current) return;
    runningRef.current = true;
    setRunning(true);
    setMsg('Staging the OS update on your box…');
    try {
      const r = await api.osUpdate(settings);
      if (!r.started) {
        setMsg(
          r.needs_optin
            ? 'Enable system updates on your box first (see below).'
            : `Couldn't start (${r.error ?? 'unknown error'}).`,
        );
        return;
      }
      // Poll status until the box reports a staged deployment (or we give up —
      // pulling an OS image is minutes). Completion = staged read BACK, never
      // assumed. If the box was already current the run no-ops and staged stays
      // false; the timeout message covers that honestly.
      let staged = false;
      for (let i = 0; i < 120 && !staged; i++) {
        await new Promise((res) => setTimeout(res, 5000));
        try {
          const lines = await api.osLog(settings);
          const last = lastMeaningful(lines);
          if (last) setStep(last);
        } catch {
          // progress line is a nicety
        }
        if (i % 6 === 5) {
          try {
            const s2 = await api.osStatus(settings);
            if (s2?.staged) {
              staged = true;
              poll.refresh();
            }
          } catch {
            // box busy
          }
        }
      }
      if (staged) {
        setMsg('Update staged. Reboot your box to apply it.');
        setStep(null);
      } else {
        setMsg('Done — no OS update was pending, or it is still downloading.');
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

  const reboot = useCallback(() => {
    Alert.alert('Reboot the box?', 'This applies the staged OS update. Any unsaved work will be lost.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Reboot',
        style: 'destructive',
        onPress: async () => {
          setRebooting(true);
          hapticLight();
          try {
            await api.runAction(settings, 'reboot');
            setMsg('Rebooting… your box will be back in a minute.');
          } catch (e) {
            const detail = e instanceof Error ? e.message : String(e);
            setMsg(`Couldn't reboot (${detail}). Reboot the box manually to apply.`);
          } finally {
            setRebooting(false);
          }
        },
      },
    ]);
  }, [settings]);

  if (!configured || status == null) return null;

  const staged = status.staged;

  return (
    <View style={styles.card}>
      <View style={styles.header}>
        <Ionicons name="hardware-chip-outline" size={18} color={t.blue} />
        <Text style={styles.title} numberOfLines={1}>
          Operating system
        </Text>
        {staged && !running && (
          <View style={styles.badge}>
            <Text style={styles.badgeText}>reboot</Text>
          </View>
        )}
      </View>

      {status.current ? (
        <Text style={styles.sub}>
          {status.kind === 'steamos' ? 'SteamOS' : 'Bazzite'} · {status.current}
        </Text>
      ) : null}

      {msg ? (
        <>
          <Text style={styles.msg}>{msg}</Text>
          {step ? <Text style={styles.step}>{step}</Text> : null}
        </>
      ) : null}

      {/* Staged wins: once an update is downloaded, the only useful action is a
          reboot to apply it — not staging another. */}
      {staged ? (
        <Pressable
          onPress={reboot}
          disabled={rebooting}
          style={({ pressed }) => [styles.btn, pressed && styles.btnPressed]}>
          <Text style={styles.btnText}>{rebooting ? 'Rebooting…' : 'Reboot to apply'}</Text>
        </Pressable>
      ) : !msg ? (
        <Pressable
          onPress={() => {
            hapticLight();
            void run();
          }}
          disabled={running || !status.elevated}
          style={({ pressed }) => [
            styles.btn,
            (pressed || !status.elevated) && styles.btnPressed,
          ]}>
          <Text style={styles.btnText}>{running ? 'Updating…' : 'Update OS'}</Text>
        </Pressable>
      ) : null}

      {!status.elevated && (
        <Text style={styles.hint}>
          OS updates need a one-time opt-in on the box:{' '}
          <Text style={styles.code}>couchside allow-system-updates on</Text>.
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
    backgroundColor: t.amber ?? t.blue,
    borderRadius: 10,
    paddingHorizontal: 8,
    paddingVertical: 2,
    alignItems: 'center',
  },
  badgeText: { color: '#0b1220', fontSize: 11, fontWeight: '700' },
  sub: { color: t.textDim, fontSize: 13, fontFamily: mono },
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
