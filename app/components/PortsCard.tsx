/**
 * Setup — a compact "Game Ports" card that OPENS the ports manager
 * (app/ports.tsx). An entry point, not a control surface: the catalogue, the
 * Install/Remove buttons and the bring-your-own-dump step live on /ports.
 *
 * Probe-and-appear: derives SOLELY from GET /api/ports. A 404 (old agent) or a
 * null answer hides the card, so a box whose agent predates Couchside-Ports
 * never shows it. The poll is slow (30 s) and tightens to 2 s only while an
 * install is in flight, so "Installing…" → Installed paints without a manual
 * refresh even though this card starts nothing itself.
 */
import Ionicons from '@expo/vector-icons/Ionicons';
import { router } from 'expo-router';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { usePoll } from '@/hooks/usePoll';
import { api, hostKey, type PortsState } from '@/lib/api';
import { anyPortJobActive } from '@/lib/ports';
import { hapticLight } from '@/lib/haptics';
import { useSettings } from '@/lib/SettingsContext';
import { useTheme, useThemedStyles, type Palette } from '@/lib/theme';

export function PortsCard() {
  const t = useTheme();
  const styles = useThemedStyles(makeStyles);
  const { settings } = useSettings();
  const configured = settings.host.trim().length > 0;
  const key = hostKey(settings);

  const state = usePoll<PortsState | null>(
    () => api.ports(settings), 30 * 1000, configured, key);
  const running = anyPortJobActive(state.data?.install);

  const fast = usePoll<PortsState | null>(
    () => api.ports(settings), 2000, configured && running, key);
  const live = fast.data ?? state.data;

  // Probe-and-appear: nothing until GET /api/ports answers.
  if (!configured || !live) return null;

  const count = live.ports.length;
  const installed = live.ports.filter((p) => p.installed).length;
  const job = live.install;
  const chip = job?.running
    ? (job.mode === 'uninstall' ? 'Removing…' : 'Installing…')
    : installed > 0 ? `${installed} installed` : `${count} available`;
  const chipColor = job?.running ? t.blue : installed > 0 ? t.green : t.textFaint;

  return (
    <Pressable
      onPress={() => { hapticLight(); router.push('/ports'); }}
      testID="ports-card"
      accessibilityRole="button"
      accessibilityLabel={`Game ports, ${chip}`}
      style={({ pressed }) => [styles.card, pressed && styles.pressed]}>
      <View style={styles.iconWrap}>
        <Ionicons name="game-controller-outline" size={22} color={t.blue} />
      </View>
      <View style={styles.body}>
        <View style={styles.titleRow}>
          <Text style={styles.title} numberOfLines={1}>Game Ports</Text>
          <View style={[styles.chip, { borderColor: chipColor }]}>
            <Text style={[styles.chipText, { color: chipColor }]} numberOfLines={1}>{chip}</Text>
          </View>
        </View>
        <Text style={styles.sub} numberOfLines={2}>
          Native game ports for your Steam Machine. Engine only — you bring your own game files.
        </Text>
        <Text style={styles.manage}>Browse &amp; install &rsaquo;</Text>
      </View>
      <Ionicons name="chevron-forward" size={18} color={t.textFaint} />
    </Pressable>
  );
}

const makeStyles = (t: Palette) =>
  StyleSheet.create({
    card: {
      flexDirection: 'row', alignItems: 'center', gap: 12,
      paddingVertical: 12, paddingHorizontal: 14, marginVertical: 8,
      borderRadius: 14, backgroundColor: t.card,
      borderWidth: 1, borderColor: t.blue + '55',
    },
    pressed: { opacity: 0.7 },
    iconWrap: {
      width: 40, height: 40, borderRadius: 20,
      alignItems: 'center', justifyContent: 'center', backgroundColor: t.blue + '22',
    },
    body: { flex: 1 },
    titleRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
    title: { color: t.text, fontWeight: '700', fontSize: 15, flexShrink: 1 },
    chip: { borderWidth: 1, borderRadius: 999, paddingHorizontal: 8, paddingVertical: 1 },
    chipText: { fontSize: 11, fontWeight: '700' },
    sub: { color: t.textDim, fontSize: 12, marginTop: 3 },
    manage: { color: t.blue, fontSize: 12, fontWeight: '600', marginTop: 5 },
  });
