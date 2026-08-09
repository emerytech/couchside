/**
 * Setup → Utilities — one-click hardware/setup helpers (OPT-IN: gated on the
 * `utilitiesEnabled` pref AND caps.utilities). Reads GET /api/utilities and shows
 * each supported utility with its live state.
 *
 * STAGE 2: OpenPuck can now be FLASHED. When a board is in its UF2 bootloader
 * (state `board_ready`), a Flash button POSTs /api/utilities/openpuck/run; the
 * agent copies the pinned firmware onto the board, which reboots as a Steam
 * Controller Puck — the list then re-polls and the row flips to `puck_present`.
 * CEC stays display-only: enabling it is an install-time udev step, not a daemon
 * action, so there is deliberately no button that would lie about flipping it.
 */
import Ionicons from '@expo/vector-icons/Ionicons';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Alert, Platform, Pressable, StyleSheet, Text, View } from 'react-native';

import { hapticLight, hapticSuccess, hapticWarning } from '@/lib/haptics';
import { api, ApiError, type BoxCaps, type OpenpuckLatest, type Utility } from '@/lib/api';
import { useSettings } from '@/lib/SettingsContext';
import { useTheme, useThemedStyles, type Palette } from '@/lib/theme';

/** (statusLine, iconName, tone) for a utility's state. tone: 'good' | 'action' | 'idle'. */
function present(u: Utility): { line: string; icon: string; tone: 'good' | 'action' | 'idle' } {
  if (u.id === 'openpuck') {
    if (u.state === 'board_ready') return { line: 'Board connected — ready to flash.', icon: 'hardware-chip-outline', tone: 'action' };
    if (u.state === 'puck_present') return { line: 'A Steam Controller Puck is connected.', icon: 'checkmark-circle', tone: 'good' };
    return { line: 'Plug an nRF52840 board into the box to flash one.', icon: 'hardware-chip-outline', tone: 'idle' };
  }
  if (u.id === 'cec') {
    if (u.state === 'enabled') return { line: 'On — the box can control your TV over HDMI.', icon: 'checkmark-circle', tone: 'good' };
    if (u.state === 'needs_enable') return { line: 'Adapter found — re-run the installer to enable it.', icon: 'tv-outline', tone: 'action' };
    return { line: 'No HDMI-CEC adapter found on this box.', icon: 'tv-outline', tone: 'idle' };
  }
  return { line: u.state, icon: 'construct-outline', tone: 'idle' };
}

export function UtilitiesSection({ caps }: { caps?: BoxCaps }) {
  const t = useTheme();
  const styles = useThemedStyles(makeStyles);
  const { settings } = useSettings();
  const [utils, setUtils] = useState<Utility[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null); // utility id being run
  const [note, setNote] = useState<Record<string, { tone: 'ok' | 'err' | 'info'; msg: string }>>({});
  // Opt-in "check for newer firmware": null = not checked, then the box's answer.
  const [latest, setLatest] = useState<OpenpuckLatest | null>(null);
  const [checking, setChecking] = useState(false);
  const live = useRef(true);
  const lastUtils = useRef<Utility[] | null>(null);

  const canProbe = caps?.utilities !== false;

  const refresh = useCallback(async () => {
    const res = await api.utilities(settings);
    if (!live.current) return;
    const next = res ? res.utilities : null;
    // A state flip makes any old flash note stale — the fresh status line is the
    // truth now. (Hardware-observed: a stale "No board in DFU mode" error sat
    // under a fresh "A Steam Controller Puck is connected" after the row updated.)
    const prev = lastUtils.current;
    if (prev && next) {
      const changed = next
        .filter((u) => prev.find((p) => p.id === u.id)?.state !== u.state)
        .map((u) => u.id);
      if (changed.length) {
        setNote((n) => {
          const c = { ...n };
          for (const id of changed) delete c[id];
          return c;
        });
      }
    }
    lastUtils.current = next;
    setUtils(next);
  }, [settings]);

  useEffect(() => {
    live.current = true;
    if (!canProbe) { setUtils(null); return; }
    void refresh();
    return () => { live.current = false; };
  }, [refresh, canProbe]);

  const flashOpenpuck = useCallback((variant: 'pinned' | 'latest' = 'pinned') => {
    const doFlash = async () => {
      hapticLight();
      setBusy('openpuck');
      setNote((n) => { const c = { ...n }; delete c.openpuck; return c; });
      try {
        const r = await api.runUtility(settings, 'openpuck', variant);
        if (!live.current) return;
        const msg = r.ok
          ? (r.stdout || 'Flashed. The board is rebooting as a Steam Controller Puck.')
          : (r.stderr || 'Flash failed.');
        setNote((n) => ({ ...n, openpuck: { tone: r.ok ? 'ok' : 'err', msg } }));
        if (r.ok) hapticSuccess(); else hapticWarning();
      } catch (e) {
        if (live.current) {
          if (e instanceof ApiError && e.kind === 'timeout') {
            // The write may simply be outlasting our patience — the flash often
            // SUCCEEDS after this (hardware-observed). Say so; the re-poll below
            // replaces this with the real state.
            setNote((n) => ({ ...n, openpuck: {
              tone: 'info',
              msg: 'Still flashing — the box is writing firmware. The status here '
                + 'updates when it finishes.',
            } }));
          } else {
            setNote((n) => ({ ...n, openpuck: { tone: 'err', msg: 'Could not reach the box.' } }));
            hapticWarning();
          }
        }
      } finally {
        if (live.current) setBusy(null);
        // Re-poll REGARDLESS of outcome. After a timeout the flash may still have
        // succeeded box-side; after "no board in DFU" the truthful row state
        // (e.g. puck_present) replaces the stale one. Twice: once right away,
        // once after the board has had time to reboot + re-enumerate.
        setTimeout(() => { void refresh(); }, 1500);
        setTimeout(() => { void refresh(); }, 6000);
      }
    };
    // A firmware write is a real action — confirm first, even though the
    // bootloader stays intact and it's re-flashable. The 'latest' path is opt-in
    // and flashes a build newer than the one the app pins, so it says so.
    const newer = latest?.tag ? ` (${latest.tag})` : '';
    const q = variant === 'latest'
      ? 'Flash the NEWEST OpenPuck firmware' + newer + ' to the plugged-in board? '
        + 'This is newer than the build the app ships and pins. It reboots as a '
        + 'Steam Controller Puck when done; the bootloader is kept, so you can '
        + 're-flash any time.'
      : 'Flash the OpenPuck firmware to the plugged-in board? It reboots as '
        + 'a Steam Controller Puck when done. The bootloader is kept, so you can '
        + 're-flash any time.';
    if (Platform.OS === 'web') {
      // eslint-disable-next-line no-alert
      if (typeof window !== 'undefined' && window.confirm(q)) void doFlash();
      return;
    }
    Alert.alert(
      variant === 'latest' ? 'Flash newest firmware?' : 'Flash OpenPuck receiver?',
      q,
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Flash', onPress: () => { void doFlash(); } },
      ],
    );
  }, [settings, refresh, latest]);

  // Opt-in: ask the box to compare its pinned firmware against the fork's newest
  // release. Read-only — this NEVER flashes; it only reveals the "Flash newest"
  // control when a newer build exists.
  const checkNewer = useCallback(async () => {
    hapticLight();
    setChecking(true);
    try {
      // null == a 404: the box's service is too old for this endpoint (distinct
      // from a thrown error, which is an unreachable/unhealthy box).
      const r = await api.openpuckLatest(settings);
      if (live.current) setLatest(r ?? { available: false, pinned_tag: '', error: 'old-agent' });
    } catch {
      if (live.current) setLatest({ available: false, pinned_tag: '', error: 'unreachable' });
    } finally {
      if (live.current) setChecking(false);
    }
  }, [settings]);

  // Nothing to show if the box lacks the endpoint (old agent / Windows).
  if (!canProbe || !utils || utils.length === 0) return null;

  return (
    <View style={styles.wrap}>
      <Text style={styles.h}>UTILITIES</Text>
      {utils.map((u) => {
        const p = present(u);
        const color = p.tone === 'good' ? t.green : p.tone === 'action' ? t.blue : t.textFaint;
        const canFlash = u.id === 'openpuck' && u.state === 'board_ready';
        const running = busy === u.id;
        const n = note[u.id];
        return (
          <View key={u.id} style={styles.row}>
            <Ionicons name={p.icon as never} size={20} color={color} style={styles.icon} />
            <View style={styles.body}>
              <Text style={styles.label}>{u.label}</Text>
              <Text style={styles.sub}>{u.description}</Text>
              <Text style={[styles.status, { color }]}>{p.line}</Text>
              {canFlash ? (
                <Pressable
                  onPress={() => flashOpenpuck('pinned')}
                  disabled={running}
                  style={({ pressed }) => [
                    styles.btn,
                    { borderColor: t.blue, opacity: running ? 0.6 : pressed ? 0.8 : 1 },
                  ]}
                  accessibilityRole="button"
                  accessibilityLabel="Flash OpenPuck receiver"
                >
                  {running ? (
                    <ActivityIndicator size="small" color={t.blue} />
                  ) : (
                    <Ionicons name="flash-outline" size={16} color={t.blue} />
                  )}
                  <Text style={[styles.btnText, { color: t.blue }]}>
                    {running ? 'Flashing…' : 'Flash receiver'}
                  </Text>
                </Pressable>
              ) : null}
              {n ? (
                <Text style={[styles.note, {
                  color: n.tone === 'ok' ? t.green : n.tone === 'err' ? t.red : t.blue,
                }]}>{n.msg}</Text>
              ) : null}
              {u.id === 'openpuck' ? (
                <View style={styles.newer}>
                  {latest === null ? (
                    <Pressable
                      onPress={checkNewer}
                      disabled={checking}
                      accessibilityRole="button"
                      accessibilityLabel="Check for newer OpenPuck firmware"
                      style={({ pressed }) => [{ opacity: checking ? 0.6 : pressed ? 0.7 : 1 }]}
                    >
                      <Text style={styles.link}>
                        {checking ? 'Checking…' : 'Check for newer firmware'}
                      </Text>
                    </Pressable>
                  ) : latest.available && latest.is_newer ? (
                    <>
                      <Text style={styles.newerLine}>
                        {`Newer firmware available${latest.tag ? ` (${latest.tag})` : ''}.`}
                      </Text>
                      {canFlash ? (
                        <Pressable
                          onPress={() => flashOpenpuck('latest')}
                          disabled={running}
                          style={({ pressed }) => [
                            styles.btn,
                            { borderColor: t.blue, opacity: running ? 0.6 : pressed ? 0.8 : 1 },
                          ]}
                          accessibilityRole="button"
                          accessibilityLabel="Flash newest OpenPuck firmware"
                        >
                          {running ? (
                            <ActivityIndicator size="small" color={t.blue} />
                          ) : (
                            <Ionicons name="flash-outline" size={16} color={t.blue} />
                          )}
                          <Text style={[styles.btnText, { color: t.blue }]}>
                            {running ? 'Flashing…' : 'Flash newest'}
                          </Text>
                        </Pressable>
                      ) : (
                        <Text style={styles.newerHint}>Plug a board in to flash it.</Text>
                      )}
                    </>
                  ) : (
                    <Text style={styles.newerLine}>
                      {latest.available
                        ? "You're on the newest firmware."
                        : latest.error === 'old-agent'
                          ? "Update the box's Couchside service to check for newer firmware."
                          : "Couldn't reach the box to check."}
                    </Text>
                  )}
                </View>
              ) : null}
            </View>
          </View>
        );
      })}
    </View>
  );
}

const makeStyles = (t: Palette) =>
  StyleSheet.create({
    wrap: { marginTop: 8 },
    h: { color: t.textFaint, fontSize: 11, fontWeight: '700', letterSpacing: 1, marginBottom: 6 },
    row: {
      flexDirection: 'row', gap: 12, paddingVertical: 12, paddingHorizontal: 12,
      backgroundColor: t.card, borderRadius: 12, borderWidth: 1, borderColor: t.cardBorder,
      marginBottom: 8,
    },
    icon: { marginTop: 2 },
    body: { flex: 1 },
    label: { color: t.text, fontWeight: '700', fontSize: 14 },
    sub: { color: t.textFaint, fontSize: 12, marginTop: 2, lineHeight: 17 },
    status: { fontSize: 12, marginTop: 6, fontWeight: '600' },
    btn: {
      flexDirection: 'row', alignItems: 'center', gap: 8, alignSelf: 'flex-start',
      marginTop: 10, paddingVertical: 8, paddingHorizontal: 14,
      borderWidth: 1, borderRadius: 10,
    },
    btnText: { fontSize: 13, fontWeight: '700' },
    note: { fontSize: 12, marginTop: 8, fontWeight: '600', lineHeight: 17 },
    newer: { marginTop: 10 },
    link: { color: t.blue, fontSize: 12, fontWeight: '700' },
    newerLine: { color: t.textFaint, fontSize: 12, fontWeight: '600', lineHeight: 17 },
    newerHint: { color: t.textFaint, fontSize: 12, marginTop: 6 },
  });
