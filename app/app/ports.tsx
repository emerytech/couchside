/**
 * Ports — install Couchside-Ports (native game ports) onto the paired Steam
 * Machine from the phone.
 *
 * Probe-and-appear: the whole surface derives from GET /api/ports. An old agent
 * 404s the route, api.ports() returns null, and the Setup entry (PortsCard)
 * never pushes here. The AGENT owns the catalogue as its install allowlist;
 * this screen only ever sends a port `id` to install/uninstall — never a URL or
 * a command. Engines are redistributable; a port that needs the player's own
 * game files says so and that step is surfaced here (lib/ports.ts).
 *
 * Every install/uninstall is a JOB: the POST returns once the box has staged it,
 * and this screen polls GET /api/ports every 2 s while `install.running` so
 * "Installing…" resolves to Installed/Failed on its own; a client timeout is
 * never reported as a failure. Install is OFF until the owner runs
 * `couchside allow-ports on` on the box — until then a 403 surfaces that exact
 * command rather than a dead button. Portrait-locked like every screen but Pad.
 */
import Ionicons from '@expo/vector-icons/Ionicons';
import { Stack, router } from 'expo-router';
import { useCallback, useState } from 'react';
import {
  ActivityIndicator, FlatList, Pressable, ScrollView, StyleSheet, Text, View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useConfirm } from '@/components/ConfirmDialog';
import { useLockOrientation } from '@/hooks/useLockOrientation';
import { usePoll } from '@/hooks/usePoll';
import { api, hostKey, type Port, type PortsState } from '@/lib/api';
import { hapticLight, hapticSuccess, hapticWarning } from '@/lib/haptics';
import {
  anyPortJobActive, installConfirmCopy, PORTS_LEGAL_LINE, PORTS_OPTIN_CMD, portActionError,
  portButton, portJobCopy, uninstallConfirmCopy,
} from '@/lib/ports';
import { useSettings } from '@/lib/SettingsContext';
import { mono, useTheme, useThemedStyles, type Palette } from '@/lib/theme';

const SCREEN_OPTIONS = { headerShown: false };
type Note = { tone: 'ok' | 'err' | 'info'; msg: string } | null;

export default function PortsScreen() {
  useLockOrientation('portrait');
  const t = useTheme();
  const styles = useThemedStyles(makeStyles);
  const insets = useSafeAreaInsets();
  const confirm = useConfirm();
  const { settings } = useSettings();
  const configured = settings.host.trim().length > 0;
  const key = hostKey(settings);

  const [note, setNote] = useState<Note>(null);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  const state = usePoll<PortsState | null>(
    () => api.ports(settings), 30 * 1000, configured, key);
  const job = state.data?.install ?? null;
  const running = anyPortJobActive(job);

  // Tighten to 2 s only while a job runs, so progress paints without a refresh.
  const fast = usePoll<PortsState | null>(
    () => api.ports(settings), 2000, configured && running, key);
  const live = fast.data ?? state.data;
  const ports = live?.ports ?? [];
  const allowed = live?.allowed ?? true;
  const activeJob = live?.install ?? job;

  const act = useCallback(
    async (port: Port, mode: 'install' | 'uninstall') => {
      const copy = mode === 'install' ? installConfirmCopy(port) : uninstallConfirmCopy(port);
      const ok = await confirm({
        title: copy.title, message: copy.message,
        confirmText: copy.okLabel, destructive: mode === 'uninstall',
      });
      if (!ok) return;
      hapticLight();
      setNote({ tone: 'info', msg: mode === 'install' ? `Starting ${port.name}…` : `Removing ${port.name}…` });
      try {
        const r = mode === 'install'
          ? await api.installPort(settings, port.id)
          : await api.uninstallPort(settings, port.id);
        const err = portActionError(r);
        if (err) {
          hapticWarning();
          setNote({ tone: r.needs_optin ? 'info' : 'err', msg: err });
          return;
        }
        hapticSuccess();
        setNote(null);
        state.refresh();
        fast.refresh();
      } catch (e) {
        hapticWarning();
        setNote({ tone: 'err', msg: e instanceof Error ? e.message : 'Could not reach the box.' });
      }
    },
    [confirm, settings, state, fast],
  );

  const jobLine = portJobCopy(
    activeJob,
    activeJob ? ports.find((p) => p.id === activeJob.id)?.name : undefined,
  );

  const renderPort = ({ item }: { item: Port }) => {
    const btn = portButton(item, activeJob);
    const isExpanded = !!expanded[item.id];
    return (
      <View style={styles.card}>
        <View style={styles.cardHead}>
          <View style={{ flex: 1 }}>
            <View style={styles.titleRow}>
              <Text style={styles.cardTitle} numberOfLines={1}>{item.name}</Text>
              {item.installed ? (
                <View style={[styles.chip, { borderColor: t.green }]}>
                  <Text style={[styles.chipText, { color: t.green }]}>Installed</Text>
                </View>
              ) : null}
            </View>
            <Text style={styles.cardDesc}>{item.description}</Text>
            <View style={styles.metaRow}>
              {item.platforms.map((p) => (
                <View key={p} style={styles.metaChip}><Text style={styles.metaChipText}>{p}</Text></View>
              ))}
              {item.arch ? (
                <View style={styles.metaChip}><Text style={styles.metaChipText}>{item.arch}</Text></View>
              ) : null}
              {item.requires_user_files ? (
                <View style={[styles.metaChip, { borderColor: t.amber ?? t.blue }]}>
                  <Text style={[styles.metaChipText, { color: t.amber ?? t.blue }]}>Bring your own game</Text>
                </View>
              ) : null}
            </View>
          </View>
        </View>

        {item.requires_user_files && item.user_files_prompt ? (
          <Text style={styles.dumpNote}>
            <Ionicons name="information-circle-outline" size={13} color={t.textDim} /> {item.user_files_prompt}
          </Text>
        ) : null}

        <View style={styles.actionRow}>
          <Pressable
            onPress={() => btn.action && act(item, btn.action)}
            disabled={btn.busy || !btn.action}
            accessibilityRole="button"
            accessibilityLabel={`${btn.label} ${item.name}`}
            style={({ pressed }) => [
              styles.btn,
              btn.action === 'uninstall' ? styles.btnDanger : styles.btnPrimary,
              (btn.busy || !btn.action) && styles.btnDisabled,
              pressed && styles.pressed,
            ]}>
            {btn.busy ? <ActivityIndicator size="small" color={t.onAccent} /> : null}
            <Text style={btn.action === 'uninstall' ? styles.btnDangerText : styles.btnPrimaryText}>
              {btn.label}
            </Text>
          </Pressable>
          {item.setup_flow.length > 0 ? (
            <Pressable
              onPress={() => { hapticLight(); setExpanded((e) => ({ ...e, [item.id]: !e[item.id] })); }}
              hitSlop={8} style={styles.howBtn} accessibilityRole="button">
              <Text style={styles.howText}>How it works</Text>
              <Ionicons name={isExpanded ? 'chevron-up' : 'chevron-down'} size={14} color={t.blue} />
            </Pressable>
          ) : null}
        </View>

        {isExpanded ? (
          <View style={styles.flow}>
            {item.setup_flow.map((step, i) => (
              <View key={i} style={styles.flowRow}>
                <Text style={styles.flowNum}>{i + 1}</Text>
                <Text style={styles.flowText}>{step}</Text>
              </View>
            ))}
          </View>
        ) : null}
      </View>
    );
  };

  return (
    <View style={[styles.screen, { paddingTop: insets.top }]}>
      <Stack.Screen options={SCREEN_OPTIONS} />
      <View style={styles.header}>
        <Pressable onPress={() => router.back()} hitSlop={12} accessibilityRole="button" accessibilityLabel="Back">
          <Ionicons name="chevron-back" size={26} color={t.text} />
        </Pressable>
        <Text style={styles.title}>Ports</Text>
        <View style={{ width: 26 }} />
      </View>

      {!configured ? (
        <Text style={styles.empty}>Pair a box first.</Text>
      ) : (
        <FlatList
          data={ports}
          keyExtractor={(p) => p.id}
          renderItem={renderPort}
          contentContainerStyle={{ padding: 14, paddingBottom: insets.bottom + 24 }}
          ListHeaderComponent={
            <View>
              <Text style={styles.legal}>{PORTS_LEGAL_LINE}</Text>

              {!allowed ? (
                <View style={[styles.banner, styles.bannerInfo]}>
                  <Text style={styles.bannerText}>
                    Port installs are off on this box. Enable them on the box, then try again:
                  </Text>
                  <Text style={styles.cmd}>{PORTS_OPTIN_CMD}</Text>
                </View>
              ) : null}

              {note ? (
                <View style={[
                  styles.banner,
                  note.tone === 'err' ? styles.bannerErr : note.tone === 'ok' ? styles.bannerOk : styles.bannerInfo,
                ]}>
                  <Text style={styles.bannerText}>{note.msg}</Text>
                </View>
              ) : null}

              {jobLine ? (
                <View style={[
                  styles.banner,
                  jobLine.tone === 'warn' ? styles.bannerErr : jobLine.tone === 'good' ? styles.bannerOk : styles.bannerInfo,
                ]}>
                  <View style={styles.jobLineRow}>
                    {activeJob?.running ? <ActivityIndicator size="small" color={t.blue} /> : null}
                    <Text style={[styles.bannerText, { flex: 1 }]}>{jobLine.line}</Text>
                  </View>
                  {activeJob && activeJob.lines.length > 0 && (activeJob.running || !activeJob.ok) ? (
                    <ScrollView style={styles.log} nestedScrollEnabled>
                      <Text style={styles.logText}>{activeJob.lines.slice(-12).join('\n')}</Text>
                    </ScrollView>
                  ) : null}
                </View>
              ) : null}
            </View>
          }
          ListEmptyComponent={
            state.loading
              ? <ActivityIndicator style={{ marginTop: 40 }} color={t.textDim} />
              : <Text style={styles.empty}>No ports available for this box.</Text>
          }
        />
      )}
    </View>
  );
}

const makeStyles = (t: Palette) =>
  StyleSheet.create({
    screen: { flex: 1, backgroundColor: t.bg },
    header: {
      flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
      paddingHorizontal: 14, paddingVertical: 10,
    },
    title: { color: t.text, fontSize: 20, fontWeight: '800' },
    empty: { color: t.textDim, textAlign: 'center', marginTop: 40, fontSize: 14 },
    legal: { color: t.textDim, fontSize: 12, lineHeight: 17, marginBottom: 12 },

    banner: { borderRadius: 12, borderWidth: 1, padding: 12, marginBottom: 12 },
    bannerInfo: { backgroundColor: t.blue + '14', borderColor: t.blue + '55' },
    bannerOk: { backgroundColor: t.green + '14', borderColor: t.green + '55' },
    bannerErr: { backgroundColor: t.red + '14', borderColor: t.red + '55' },
    bannerText: { color: t.text, fontSize: 13, lineHeight: 19 },
    jobLineRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
    cmd: { color: t.blue, fontFamily: mono, fontSize: 13, marginTop: 6 },
    log: {
      maxHeight: 120, marginTop: 8, borderRadius: 8,
      backgroundColor: t.bg, padding: 8,
    },
    logText: { color: t.textDim, fontFamily: mono, fontSize: 11, lineHeight: 15 },

    card: {
      backgroundColor: t.card, borderRadius: 14, borderWidth: 1, borderColor: t.cardBorder,
      padding: 14, marginBottom: 12,
    },
    cardHead: { flexDirection: 'row', alignItems: 'flex-start' },
    titleRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
    cardTitle: { color: t.text, fontSize: 16, fontWeight: '700', flexShrink: 1 },
    cardDesc: { color: t.textDim, fontSize: 13, lineHeight: 19, marginTop: 5 },
    metaRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 9 },
    metaChip: {
      borderWidth: 1, borderColor: t.cardBorder, borderRadius: 999,
      paddingHorizontal: 8, paddingVertical: 2,
    },
    metaChipText: { color: t.textDim, fontSize: 11, fontWeight: '600' },
    chip: { borderWidth: 1, borderRadius: 999, paddingHorizontal: 8, paddingVertical: 1 },
    chipText: { fontSize: 11, fontWeight: '700' },
    dumpNote: { color: t.textDim, fontSize: 12, lineHeight: 17, marginTop: 10 },

    actionRow: { flexDirection: 'row', alignItems: 'center', gap: 14, marginTop: 12 },
    btn: {
      flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
      paddingHorizontal: 18, paddingVertical: 9, borderRadius: 10, minWidth: 110,
    },
    btnPrimary: { backgroundColor: t.blue },
    btnPrimaryText: { color: t.onAccent, fontSize: 14, fontWeight: '800' },
    btnDanger: { backgroundColor: 'transparent', borderWidth: 1, borderColor: t.red },
    btnDangerText: { color: t.red, fontSize: 14, fontWeight: '800' },
    btnDisabled: { opacity: 0.5 },
    pressed: { opacity: 0.7 },
    howBtn: { flexDirection: 'row', alignItems: 'center', gap: 3 },
    howText: { color: t.blue, fontSize: 13, fontWeight: '600' },

    flow: { marginTop: 12, gap: 8 },
    flowRow: { flexDirection: 'row', gap: 10, alignItems: 'flex-start' },
    flowNum: {
      color: t.onAccent, backgroundColor: t.blue, width: 18, height: 18, borderRadius: 9,
      textAlign: 'center', fontSize: 11, fontWeight: '800', overflow: 'hidden', lineHeight: 18,
    },
    flowText: { color: t.textDim, fontSize: 12, lineHeight: 18, flex: 1 },
  });
