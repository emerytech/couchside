import * as Haptics from 'expo-haptics';
import React, { useCallback, useState } from 'react';
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
import { usePoll } from '@/hooks/usePoll';
import { ActionInfo, ActionResult, api, Danger } from '@/lib/api';
import { useSettings } from '@/lib/SettingsContext';
import { mono, numeric, theme } from '@/lib/theme';

const DANGER_ORDER: Danger[] = ['low', 'medium', 'high'];

const DANGER_COLOR: Record<Danger, string> = {
  low: theme.slate,
  medium: theme.amber,
  high: theme.red,
};

function hapticImpact(style: Haptics.ImpactFeedbackStyle) {
  if (Platform.OS !== 'web') {
    Haptics.impactAsync(style).catch(() => {});
  }
}

function hapticNotify(type: Haptics.NotificationFeedbackType) {
  if (Platform.OS !== 'web') {
    Haptics.notificationAsync(type).catch(() => {});
  }
}

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
  return (
    <TabScreen>
      <Gated>
        <ActionsScreen />
      </Gated>
    </TabScreen>
  );
}

function ActionsScreen() {
  const { settings, ready } = useSettings();
  const [run, setRun] = useState<RunRecord | null>(null);

  const actions = usePoll<{ actions: ActionInfo[] }>(
    () => api.actions(settings),
    30000,
    ready,
  );

  const execute = useCallback(
    async (action: ActionInfo) => {
      hapticImpact(Haptics.ImpactFeedbackStyle.Heavy);
      setRun({ action, running: true });
      try {
        const result = await api.runAction(settings, action.id);
        setRun({ action, result, running: false });
        hapticNotify(
          result.ok
            ? Haptics.NotificationFeedbackType.Success
            : Haptics.NotificationFeedbackType.Error,
        );
      } catch (e: unknown) {
        setRun({
          action,
          error: e instanceof Error ? e.message : String(e),
          running: false,
        });
        hapticNotify(Haptics.NotificationFeedbackType.Error);
      }
    },
    [settings],
  );

  const onTap = useCallback(
    (action: ActionInfo) => {
      hapticImpact(Haptics.ImpactFeedbackStyle.Light);
      confirm(action.label, `${action.description}\n\nRun this action?`, () => {
        if (action.danger === 'high') {
          confirm('Are you sure?', `Really run "${action.label}"? This is a HIGH danger action.`, () =>
            execute(action),
          );
        } else {
          execute(action);
        }
      });
    },
    [execute],
  );

  const groups = DANGER_ORDER.map((danger) => ({
    danger,
    items: (actions.data?.actions ?? []).filter((a) => a.danger === danger),
  })).filter((g) => g.items.length > 0);

  return (
    <View style={[styles.screen, { paddingTop: 12 }]}>
      <Text style={styles.title}>Actions</Text>
      <ScrollView style={styles.list} contentContainerStyle={{ paddingBottom: 12 }}>
        {actions.error != null && !actions.data && (
          <View style={styles.errBox}>
            <Text style={styles.errText}>{actions.error.message}</Text>
            <Pressable
              style={({ pressed }) => [styles.retryBtn, pressed && styles.pressed]}
              onPress={actions.refresh}>
              <Text style={styles.retryText}>RETRY</Text>
            </Pressable>
          </View>
        )}
        {!actions.data && actions.error == null && (
          <Text style={styles.dim}>loading…</Text>
        )}
        {groups.map((g) => (
          <View key={g.danger} style={styles.group}>
            <Text style={[styles.groupTitle, { color: DANGER_COLOR[g.danger] }]}>
              {g.danger.toUpperCase()} DANGER
            </Text>
            {g.items.map((a) => (
              <Pressable
                key={a.id}
                onPress={() => onTap(a)}
                style={({ pressed }) => [styles.card, pressed && styles.pressed]}>
                <View style={styles.cardHead}>
                  <Text style={styles.cardLabel}>{a.label}</Text>
                  <View style={[styles.badge, { backgroundColor: DANGER_COLOR[a.danger] }]}>
                    <Text style={styles.badgeText}>{a.danger}</Text>
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
                  { color: run.result.ok ? theme.green : theme.red },
                ]}>
                exit {run.result.exit_code} · {run.result.duration_ms}ms ·{' '}
                {run.result.ok ? 'OK' : 'FAILED'}
              </Text>
              <ScrollView style={styles.resultScroll}>
                {run.result.stdout ? (
                  <Text style={styles.resultOut}>{run.result.stdout}</Text>
                ) : null}
                {run.result.stderr ? (
                  <Text style={[styles.resultOut, { color: theme.red }]}>
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

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: theme.bg, paddingHorizontal: 14 },
  title: { color: theme.text, fontSize: 26, fontWeight: '700', marginBottom: 12, fontFamily: mono },
  list: { flex: 1 },
  group: { marginBottom: 16 },
  groupTitle: { fontSize: 11, fontWeight: '800', letterSpacing: 1.5, marginBottom: 8 },
  card: {
    backgroundColor: theme.card,
    borderColor: theme.cardBorder,
    borderWidth: 1,
    borderRadius: 12,
    padding: 14,
    marginBottom: 8,
  },
  cardHead: { flexDirection: 'row', alignItems: 'center', marginBottom: 4 },
  cardLabel: { color: theme.text, fontSize: 16, fontWeight: '700', flex: 1 },
  badge: {
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 3,
  },
  badgeText: { color: '#0b1220', fontSize: 11, fontWeight: '800' },
  cardDesc: { color: theme.textDim, fontSize: 13, lineHeight: 18 },
  pressed: { opacity: 0.7 },
  errBox: {
    backgroundColor: theme.redDeep,
    borderColor: theme.red,
    borderWidth: 1,
    borderRadius: 12,
    padding: 14,
    alignItems: 'center',
    marginBottom: 12,
  },
  errText: { color: '#fecaca', fontSize: 13, marginBottom: 8 },
  retryBtn: {
    backgroundColor: theme.red,
    paddingVertical: 10,
    paddingHorizontal: 28,
    borderRadius: 8,
  },
  retryText: { color: '#450a0a', fontWeight: '800', fontSize: 13, letterSpacing: 1 },
  dim: { color: theme.textDim, fontSize: 13 },
  dimMono: { color: theme.textFaint, fontSize: 12, fontFamily: mono },
  resultPanel: {
    backgroundColor: theme.inset,
    borderColor: theme.cardBorder,
    borderWidth: 1,
    borderRadius: 12,
    padding: 12,
    marginBottom: 8,
    maxHeight: 240,
  },
  resultHead: { flexDirection: 'row', alignItems: 'center', marginBottom: 4 },
  resultTitle: { color: theme.text, fontSize: 14, fontWeight: '700', flex: 1 },
  resultClose: { color: theme.textDim, fontSize: 16, padding: 4 },
  resultExit: { fontSize: 12, marginBottom: 6, ...numeric },
  resultErr: { color: theme.red, fontSize: 13, fontFamily: mono },
  resultScroll: { maxHeight: 150 },
  resultOut: { color: theme.textDim, fontSize: 12, fontFamily: mono, lineHeight: 17 },
});
