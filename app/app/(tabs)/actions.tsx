import React, { useCallback, useMemo, useState } from 'react';
import {
  Alert,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';

import { Gated } from '@/components/Gated';
import { TabScreen } from '@/components/TabScreen';
import { useLockOrientation } from '@/hooks/useLockOrientation';
import { usePoll } from '@/hooks/usePoll';
import { ActionInfo, ActionResult, api, Danger, hostKey } from '@/lib/api';
import { hapticError, hapticHeavy, hapticLight, hapticSuccess } from '@/lib/haptics';
import { useSettings } from '@/lib/SettingsContext';
import { mono, numeric, useTheme, useThemedStyles, type Palette } from '@/lib/theme';

const DANGER_ORDER: Danger[] = ['low', 'medium', 'high'];

// The agent's action contract keeps low/medium/high (custom actions set it too,
// and 'high' still gates the extra confirm), but showing it as "DANGER" badly
// overstates what these do: Switch to Desktop isn't dangerous, it just changes
// what's on the TV. Label by IMPACT — what the user actually loses by tapping —
// and let colour carry the severity instead of the word "danger".
const GROUP_TITLE: Record<Danger, string> = {
  low: 'ROUTINE',
  medium: 'CHANGES WHAT’S ON SCREEN',
  high: 'ENDS YOUR SESSION',
};
const BADGE_TEXT: Record<Danger, string> = {
  low: 'routine',
  medium: 'interrupts',
  high: 'ends session',
};

/** Confirm helper that also works on web (Alert buttons are no-ops on web). */
function confirm(title: string, message: string, onConfirm: () => void) {
  if (Platform.OS === 'web') {
    // eslint-disable-next-line no-alert
    if (typeof window !== 'undefined' && window.confirm(`${title}\n\n${message}`)) onConfirm();
    return;
  }
  Alert.alert(title, message, [
    { text: 'Cancel', style: 'cancel' },
    { text: 'Run', style: 'destructive', onPress: onConfirm },
  ]);
}

type RunRecord = {
  action: ActionInfo;
  result?: ActionResult;
  error?: string;
  running: boolean;
};

export default function ActionsTab() {
  useLockOrientation('portrait');
  return (
    <TabScreen>
      <Gated>
        <ActionsScreen />
      </Gated>
    </TabScreen>
  );
}

function ActionsScreen() {
  const t = useTheme();
  const styles = useThemedStyles(makeStyles);
  const { settings, ready } = useSettings();
  const [run, setRun] = useState<RunRecord | null>(null);

  const DANGER_COLOR = useMemo<Record<Danger, string>>(
    () => ({ low: t.slate, medium: t.amber, high: t.red }),
    [t],
  );

  // No host yet (fresh install): don't poll, and show the pairing hint instead
  // of a red "Box unreachable" banner retrying every 2s against http://:8787.
  const configured = settings.host.trim().length > 0;

  const actions = usePoll<{ actions: ActionInfo[] }>(
    () => api.actions(settings),
    30000,
    ready && configured,
    hostKey(settings), // clear the previous box's actions on switch
  );

  const execute = useCallback(
    async (action: ActionInfo) => {
      hapticHeavy();
      setRun({ action, running: true });
      try {
        const result = await api.runAction(settings, action.id);
        setRun({ action, result, running: false });
        if (result.ok) hapticSuccess();
        else hapticError();
      } catch (e: unknown) {
        setRun({
          action,
          error: e instanceof Error ? e.message : String(e),
          running: false,
        });
        hapticError();
      }
    },
    [settings],
  );

  const onTap = useCallback(
    (action: ActionInfo) => {
      hapticLight();
      confirm(action.label, `${action.description}\n\nRun this action?`, () => {
        if (action.danger === 'high') {
          confirm(
            'Are you sure?',
            `"${action.label}" ends your session on the box — anything running there stops.`,
            () => execute(action),
          );
        } else {
          execute(action);
        }
      });
    },
    [execute],
  );

  // "suspend" is handled by the Console tab's power control, which pairs it
  // with the Wake-on-LAN wake button and the wired-only guard, so it is left
  // out of the generic action list here to keep one safe entry point.
  const groups = DANGER_ORDER.map((danger) => ({
    danger,
    items: (actions.data?.actions ?? []).filter(
      (a) => a.danger === danger && a.id !== 'suspend',
    ),
  })).filter((g) => g.items.length > 0);

  return (
    <View style={[styles.screen, { paddingTop: 12 }]}>
      <Text style={styles.title}>Actions</Text>
      <ScrollView style={styles.list} contentContainerStyle={{ paddingBottom: 12 }}>
        {/* Fresh install: nothing paired yet, so nothing is "unreachable". */}
        {!configured && (
          <View style={styles.emptyCard}>
            <Text style={styles.emptyTitle}>No box configured</Text>
            <Text style={styles.emptyText}>
              Open the Setup tab to pair with the Couchside service on your media center,
              Steam machine, or PC — then add your TV for one remote that drives both.
            </Text>
          </View>
        )}
        {configured && actions.error != null && !actions.data && (
          <View style={styles.errBox}>
            <Text style={styles.errText}>{actions.error.message}</Text>
            <Pressable
              style={({ pressed }) => [styles.retryBtn, pressed && styles.pressed]}
              onPress={actions.refresh}>
              <Text style={styles.retryText}>RETRY</Text>
            </Pressable>
          </View>
        )}
        {configured && !actions.data && actions.error == null && (
          <Text style={styles.dim}>loading…</Text>
        )}
        {groups.map((g) => (
          <View key={g.danger} style={styles.group}>
            <Text style={[styles.groupTitle, { color: DANGER_COLOR[g.danger] }]}>
              {GROUP_TITLE[g.danger]}
            </Text>
            {g.items.map((a) => (
              <Pressable
                key={a.id}
                onPress={() => onTap(a)}
                style={({ pressed }) => [styles.card, pressed && styles.pressed]}>
                <View style={styles.cardHead}>
                  <Text style={styles.cardLabel}>{a.label}</Text>
                  <View style={[styles.badge, { backgroundColor: DANGER_COLOR[a.danger] }]}>
                    <Text style={styles.badgeText}>{BADGE_TEXT[a.danger]}</Text>
                  </View>
                </View>
                <Text style={styles.cardDesc}>{a.description}</Text>
              </Pressable>
            ))}
          </View>
        ))}
      </ScrollView>

      {/* Result panel */}
      {run && (
        <View style={styles.resultPanel}>
          <View style={styles.resultHead}>
            <Text style={styles.resultTitle}>
              {run.action.label} {run.running ? '· running…' : ''}
            </Text>
            {!run.running && (
              <Pressable onPress={() => setRun(null)} hitSlop={12}>
                <Text style={styles.resultClose}>✕</Text>
              </Pressable>
            )}
          </View>
          {run.error != null && <Text style={styles.resultErr}>{run.error}</Text>}
          {run.result && (
            <>
              <Text
                style={[
                  styles.resultExit,
                  { color: run.result.ok ? t.green : t.red },
                ]}>
                exit {run.result.exit_code} · {run.result.duration_ms}ms ·{' '}
                {run.result.ok ? 'OK' : 'FAILED'}
              </Text>
              <ScrollView style={styles.resultScroll}>
                {run.result.stdout ? (
                  <Text style={styles.resultOut}>{run.result.stdout}</Text>
                ) : null}
                {run.result.stderr ? (
                  <Text style={[styles.resultOut, { color: t.red }]}>
                    {run.result.stderr}
                  </Text>
                ) : null}
                {!run.result.stdout && !run.result.stderr ? (
                  <Text style={styles.dimMono}>(no output)</Text>
                ) : null}
              </ScrollView>
            </>
          )}
        </View>
      )}
    </View>
  );
}

const makeStyles = (t: Palette) => StyleSheet.create({
  screen: { flex: 1, backgroundColor: t.bg, paddingHorizontal: 14 },
  title: { color: t.text, fontSize: 26, fontWeight: '700', marginBottom: 12, fontFamily: mono },
  list: { flex: 1 },
  group: { marginBottom: 16 },
  groupTitle: { fontSize: 11, fontWeight: '800', letterSpacing: 1.5, marginBottom: 8 },
  card: {
    backgroundColor: t.card,
    borderColor: t.cardBorder,
    borderWidth: 1,
    borderRadius: 12,
    padding: 14,
    marginBottom: 8,
  },
  cardHead: { flexDirection: 'row', alignItems: 'center', marginBottom: 4 },
  cardLabel: { color: t.text, fontSize: 16, fontWeight: '700', flex: 1 },
  badge: {
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 3,
  },
  badgeText: { color: '#0b1220', fontSize: 11, fontWeight: '800' },
  cardDesc: { color: t.textDim, fontSize: 13, lineHeight: 18 },
  pressed: { opacity: 0.7 },
  emptyCard: {
    backgroundColor: t.card,
    borderColor: t.cardBorder,
    borderWidth: 1,
    borderRadius: 12,
    padding: 16,
    marginBottom: 12,
  },
  emptyTitle: { color: t.text, fontSize: 16, fontWeight: '700', marginBottom: 6 },
  emptyText: { color: t.textDim, fontSize: 13, lineHeight: 19 },
  errBox: {
    backgroundColor: t.redDeep,
    borderColor: t.red,
    borderWidth: 1,
    borderRadius: 12,
    padding: 14,
    alignItems: 'center',
    marginBottom: 12,
  },
  errText: { color: '#fecaca', fontSize: 13, marginBottom: 8 },
  retryBtn: {
    backgroundColor: t.red,
    paddingVertical: 10,
    paddingHorizontal: 28,
    borderRadius: 8,
  },
  retryText: { color: '#450a0a', fontWeight: '800', fontSize: 13, letterSpacing: 1 },
  dim: { color: t.textDim, fontSize: 13 },
  dimMono: { color: t.textFaint, fontSize: 12, fontFamily: mono },
  resultPanel: {
    backgroundColor: t.inset,
    borderColor: t.cardBorder,
    borderWidth: 1,
    borderRadius: 12,
    padding: 12,
    marginBottom: 8,
    maxHeight: 240,
  },
  resultHead: { flexDirection: 'row', alignItems: 'center', marginBottom: 4 },
  resultTitle: { color: t.text, fontSize: 14, fontWeight: '700', flex: 1 },
  resultClose: { color: t.textDim, fontSize: 16, padding: 4 },
  resultExit: { fontSize: 12, marginBottom: 6, ...numeric },
  resultErr: { color: t.red, fontSize: 13, fontFamily: mono },
  resultScroll: { maxHeight: 150 },
  resultOut: { color: t.textDim, fontSize: 12, fontFamily: mono, lineHeight: 17 },
});
