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
import { api, type BoxCaps, type Utility } from '@/lib/api';
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
  const [note, setNote] = useState<Record<string, { ok: boolean; msg: string }>>({});
  const live = useRef(true);

  const canProbe = caps?.utilities !== false;

  const refresh = useCallback(async () => {
    const res = await api.utilities(settings);
    if (live.current) setUtils(res ? res.utilities : null);
  }, [settings]);

  useEffect(() => {
    live.current = true;
    if (!canProbe) { setUtils(null); return; }
    void refresh();
    return () => { live.current = false; };
  }, [refresh, canProbe]);

  const flashOpenpuck = useCallback(() => {
    const doFlash = async () => {
      hapticLight();
      setBusy('openpuck');
      setNote((n) => { const c = { ...n }; delete c.openpuck; return c; });
      try {
        const r = await api.runUtility(settings, 'openpuck');
        if (!live.current) return;
        const msg = r.ok
          ? (r.stdout || 'Flashed. The board is rebooting as a Steam Controller Puck.')
          : (r.stderr || 'Flash failed.');
        setNote((n) => ({ ...n, openpuck: { ok: r.ok, msg } }));
        if (r.ok) hapticSuccess(); else hapticWarning();
        // The board re-enumerates as a puck a few seconds after flashing; re-poll
        // so the row flips board_ready -> puck_present.
        setTimeout(() => { void refresh(); }, 4000);
      } catch {
        if (live.current) {
          setNote((n) => ({ ...n, openpuck: { ok: false, msg: 'Could not reach the box.' } }));
          hapticWarning();
        }
      } finally {
        if (live.current) setBusy(null);
      }
    };
    // A firmware write is a real action — confirm first, even though the
    // bootloader stays intact and it's re-flashable.
    const q = 'Flash the OpenPuck firmware to the plugged-in board? It reboots as '
      + 'a Steam Controller Puck when done. The bootloader is kept, so you can '
      + 're-flash any time.';
    if (Platform.OS === 'web') {
      // eslint-disable-next-line no-alert
      if (typeof window !== 'undefined' && window.confirm(q)) void doFlash();
      return;
    }
    Alert.alert('Flash OpenPuck receiver?', q, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Flash', onPress: () => { void doFlash(); } },
    ]);
  }, [settings, refresh]);

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
                  onPress={flashOpenpuck}
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
                <Text style={[styles.note, { color: n.ok ? t.green : t.red }]}>{n.msg}</Text>
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
  });
