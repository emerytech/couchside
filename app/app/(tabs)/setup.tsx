import React, { useCallback, useState } from 'react';
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { api, ApiError } from '@/lib/api';
import { useSettings } from '@/lib/SettingsContext';
import { mono, theme } from '@/lib/theme';

type StepState =
  | { state: 'idle' }
  | { state: 'running' }
  | { state: 'ok'; detail: string }
  | { state: 'fail'; detail: string };

function errDetail(e: unknown): string {
  if (e instanceof ApiError) return `${e.kind}: ${e.message}`;
  return e instanceof Error ? e.message : String(e);
}

function StepRow({ label, step }: { label: string; step: StepState }) {
  const mark =
    step.state === 'ok' ? '✓' : step.state === 'fail' ? '✗' : step.state === 'running' ? '…' : '·';
  const color =
    step.state === 'ok'
      ? theme.green
      : step.state === 'fail'
        ? theme.red
        : theme.textFaint;
  return (
    <View style={styles.stepRow}>
      <Text style={[styles.stepMark, { color }]}>{mark}</Text>
      <View style={styles.stepBody}>
        <Text style={styles.stepLabel}>{label}</Text>
        {(step.state === 'ok' || step.state === 'fail') && (
          <Text style={[styles.stepDetail, { color }]}>{step.detail}</Text>
        )}
      </View>
    </View>
  );
}

export default function SetupScreen() {
  const insets = useSafeAreaInsets();
  const { settings, ready, update } = useSettings();

  const [host, setHost] = useState<string | null>(null);
  const [port, setPort] = useState<string | null>(null);
  const [token, setToken] = useState<string | null>(null);

  // Draft values fall back to persisted settings until the field is edited.
  const draftHost = host ?? settings.host;
  const draftPort = port ?? String(settings.port);
  const draftToken = token ?? settings.token;

  const [pingStep, setPingStep] = useState<StepState>({ state: 'idle' });
  const [authStep, setAuthStep] = useState<StepState>({ state: 'idle' });
  const [agentVersion, setAgentVersion] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);
  const [saved, setSaved] = useState(false);

  const draftSettings = useCallback(() => {
    const p = parseInt(draftPort, 10);
    return {
      host: draftHost.trim() || 'bazzite.local',
      port: Number.isFinite(p) && p > 0 && p <= 65535 ? p : 8787,
      token: draftToken,
    };
  }, [draftHost, draftPort, draftToken]);

  const test = useCallback(async () => {
    const s = draftSettings();
    setTesting(true);
    setAgentVersion(null);
    setAuthStep({ state: 'idle' });
    setPingStep({ state: 'running' });

    try {
      const ping = await api.ping(s);
      setPingStep({ state: 'ok', detail: `${ping.app} v${ping.version}` });
    } catch (e: unknown) {
      setPingStep({ state: 'fail', detail: errDetail(e) });
      setTesting(false);
      return;
    }

    setAuthStep({ state: 'running' });
    try {
      const status = await api.status(s);
      setAuthStep({
        state: 'ok',
        detail: `${status.hostname} · agent v${status.agent_version}`,
      });
      setAgentVersion(status.agent_version);
    } catch (e: unknown) {
      setAuthStep({ state: 'fail', detail: errDetail(e) });
    }
    setTesting(false);
  }, [draftSettings]);

  const save = useCallback(async () => {
    await update(draftSettings());
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  }, [update, draftSettings]);

  return (
    <KeyboardAvoidingView
      style={styles.screen}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScrollView
        contentContainerStyle={{
          paddingTop: insets.top + 12,
          paddingHorizontal: 14,
          paddingBottom: 32,
        }}
        keyboardShouldPersistTaps="handled">
        <Text style={styles.title}>Setup</Text>

        <View style={styles.card}>
          <Text style={styles.fieldLabel}>HOST</Text>
          <TextInput
            style={styles.input}
            value={draftHost}
            onChangeText={setHost}
            placeholder="bazzite.local"
            placeholderTextColor={theme.textFaint}
            autoCapitalize="none"
            autoCorrect={false}
            editable={ready}
          />

          <Text style={styles.fieldLabel}>PORT</Text>
          <TextInput
            style={styles.input}
            value={draftPort}
            onChangeText={setPort}
            placeholder="8787"
            placeholderTextColor={theme.textFaint}
            keyboardType="number-pad"
            editable={ready}
          />

          <Text style={styles.fieldLabel}>TOKEN</Text>
          <TextInput
            style={styles.input}
            value={draftToken}
            onChangeText={setToken}
            placeholder="bearer token"
            placeholderTextColor={theme.textFaint}
            secureTextEntry
            autoCapitalize="none"
            autoCorrect={false}
            editable={ready}
          />

          <View style={styles.btnRow}>
            <Pressable
              onPress={test}
              disabled={testing || !ready}
              style={({ pressed }) => [
                styles.btn,
                styles.btnTest,
                (pressed || testing) && styles.pressed,
              ]}>
              <Text style={styles.btnTestText}>
                {testing ? 'TESTING…' : 'TEST CONNECTION'}
              </Text>
            </Pressable>
            <Pressable
              onPress={save}
              disabled={!ready}
              style={({ pressed }) => [styles.btn, styles.btnSave, pressed && styles.pressed]}>
              <Text style={styles.btnSaveText}>{saved ? 'SAVED ✓' : 'SAVE'}</Text>
            </Pressable>
          </View>
        </View>

        <View style={styles.card}>
          <Text style={styles.fieldLabel}>CONNECTION TEST</Text>
          <StepRow label="1 · /api/ping (unauthenticated)" step={pingStep} />
          <StepRow label="2 · /api/status (Bearer token)" step={authStep} />
          {agentVersion != null && (
            <View style={styles.versionRow}>
              <Text style={styles.versionLabel}>agent version</Text>
              <Text style={styles.versionValue}>{agentVersion}</Text>
            </View>
          )}
        </View>

        <Text style={styles.hint}>
          The agent listens on http://{draftHost || 'bazzite.local'}:{draftPort || '8787'}. All
          routes except /api/ping require the bearer token.
        </Text>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: theme.bg },
  title: { color: theme.text, fontSize: 26, fontWeight: '700', marginBottom: 12, fontFamily: mono },
  card: {
    backgroundColor: theme.card,
    borderColor: theme.cardBorder,
    borderWidth: 1,
    borderRadius: 12,
    padding: 14,
    marginBottom: 12,
  },
  fieldLabel: {
    color: theme.textFaint,
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 1.2,
    marginBottom: 6,
  },
  input: {
    backgroundColor: theme.inset,
    borderColor: theme.cardBorder,
    borderWidth: 1,
    borderRadius: 8,
    color: theme.text,
    fontSize: 15,
    fontFamily: mono,
    paddingVertical: 12,
    paddingHorizontal: 12,
    marginBottom: 14,
  },
  btnRow: { flexDirection: 'row', gap: 10 },
  btn: {
    flex: 1,
    borderRadius: 8,
    paddingVertical: 14,
    alignItems: 'center',
  },
  btnTest: { backgroundColor: theme.inset, borderColor: theme.blue, borderWidth: 1 },
  btnTestText: { color: theme.blue, fontWeight: '800', fontSize: 13, letterSpacing: 1 },
  btnSave: { backgroundColor: theme.blue },
  btnSaveText: { color: '#0b1220', fontWeight: '800', fontSize: 13, letterSpacing: 1 },
  pressed: { opacity: 0.7 },
  stepRow: { flexDirection: 'row', alignItems: 'flex-start', marginBottom: 10, gap: 10 },
  stepMark: { fontSize: 18, fontWeight: '800', width: 22, textAlign: 'center' },
  stepBody: { flex: 1 },
  stepLabel: { color: theme.text, fontSize: 13, fontFamily: mono },
  stepDetail: { fontSize: 12, fontFamily: mono, marginTop: 3 },
  versionRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    borderTopColor: theme.cardBorder,
    borderTopWidth: 1,
    paddingTop: 10,
    marginTop: 2,
  },
  versionLabel: { color: theme.textDim, fontSize: 13 },
  versionValue: { color: theme.green, fontSize: 13, fontFamily: mono, fontWeight: '700' },
  hint: { color: theme.textFaint, fontSize: 12, lineHeight: 17, fontFamily: mono },
});
