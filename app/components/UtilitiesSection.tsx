/**
 * Setup → Utilities — one-click hardware/setup helpers (OPT-IN: gated on the
 * `utilitiesEnabled` pref AND caps.utilities). Reads GET /api/utilities and shows
 * each supported utility with its live state.
 *
 * STAGE 1 is READ-ONLY: it surfaces what the box detects (a puck connected, a board
 * ready to flash, CEC on/available). The state-changing actions (flash the board /
 * enable CEC) are a deliberate next step — a firmware flash and a system change are
 * not things to wire up on the way past, and the copy here says what's next rather
 * than offering a control that isn't wired.
 */
import Ionicons from '@expo/vector-icons/Ionicons';
import { useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { api, type BoxCaps, type Utility } from '@/lib/api';
import { useSettings } from '@/lib/SettingsContext';
import { useTheme, useThemedStyles, type Palette } from '@/lib/theme';

/** (statusLine, iconName, tone) for a utility's state. tone: 'good' | 'action' | 'idle'. */
function present(u: Utility): { line: string; icon: string; tone: 'good' | 'action' | 'idle' } {
  if (u.id === 'openpuck') {
    if (u.state === 'board_ready') return { line: 'Board connected — ready to flash (next update).', icon: 'hardware-chip-outline', tone: 'action' };
    if (u.state === 'puck_present') return { line: 'A Steam Controller Puck is connected.', icon: 'checkmark-circle', tone: 'good' };
    return { line: 'Plug an nRF52840 board into the box to flash one.', icon: 'hardware-chip-outline', tone: 'idle' };
  }
  if (u.id === 'cec') {
    if (u.state === 'enabled') return { line: 'On — the box can control your TV over HDMI.', icon: 'checkmark-circle', tone: 'good' };
    if (u.state === 'needs_enable') return { line: 'Adapter found — enable coming (next update).', icon: 'tv-outline', tone: 'action' };
    return { line: 'No HDMI-CEC adapter found on this box.', icon: 'tv-outline', tone: 'idle' };
  }
  return { line: u.state, icon: 'construct-outline', tone: 'idle' };
}

export function UtilitiesSection({ caps }: { caps?: BoxCaps }) {
  const t = useTheme();
  const styles = useThemedStyles(makeStyles);
  const { settings } = useSettings();
  const [utils, setUtils] = useState<Utility[] | null>(null);

  const canProbe = caps?.utilities !== false;

  useEffect(() => {
    if (!canProbe) { setUtils(null); return; }
    let live = true;
    void (async () => {
      const res = await api.utilities(settings);
      if (live) setUtils(res ? res.utilities : null);
    })();
    return () => { live = false; };
  }, [settings, canProbe]);

  // Nothing to show if the box lacks the endpoint (old agent / Windows).
  if (!canProbe || !utils || utils.length === 0) return null;

  return (
    <View style={styles.wrap}>
      <Text style={styles.h}>UTILITIES</Text>
      {utils.map((u) => {
        const p = present(u);
        const color = p.tone === 'good' ? t.green : p.tone === 'action' ? t.blue : t.textFaint;
        return (
          <View key={u.id} style={styles.row}>
            <Ionicons name={p.icon as never} size={20} color={color} style={styles.icon} />
            <View style={styles.body}>
              <Text style={styles.label}>{u.label}</Text>
              <Text style={styles.sub}>{u.description}</Text>
              <Text style={[styles.status, { color }]}>{p.line}</Text>
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
  });
