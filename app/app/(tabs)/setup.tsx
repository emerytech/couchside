import { useLocalSearchParams } from 'expo-router';
import React, { useCallback, useEffect, useRef, useState } from 'react';
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
import { useEntitlement } from '@/lib/EntitlementContext';
import { buy, getProduct, restore } from '@/lib/purchase';
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

/** Subtle entitlement pill: trial countdown (amber) / unlocked (green). */
function EntitlementPill() {
  const { entitlement, ready } = useEntitlement();
  if (!ready) return null;
  const label =
    entitlement.state === 'purchased'
      ? 'Unlocked — thank you'
      : entitlement.state === 'trial'
        ? `Trial — ${entitlement.trialDaysLeft} day${entitlement.trialDaysLeft === 1 ? '' : 's'} left`
        : 'Trial ended';
  const color =
    entitlement.state === 'purchased'
      ? theme.green
      : entitlement.state === 'trial'
        ? theme.amber
        : theme.red;
  return (
    <View style={[styles.pill, { borderColor: color }]}>
      <Text style={[styles.pillText, { color }]}>{label}</Text>
    </View>
  );
}

export default function SetupScreen() {
  const insets = useSafeAreaInsets();
  const { settings, ready, update } = useSettings();
  const { entitlement, recordPurchase } = useEntitlement();

  const [restoring, setRestoring] = useState(false);
  const [buying, setBuying] = useState(false);
  const [restoreMsg, setRestoreMsg] = useState<{ text: string; ok: boolean } | null>(null);

  // Localized price for the Setup buy button (spec: the unlock is purchasable
  // from the Setup tab, not just the post-trial paywall).
  const [price, setPrice] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    getProduct().then((p) => {
      if (!cancelled && p?.displayPrice) setPrice(p.displayPrice);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const onBuy = useCallback(async () => {
    setBuying(true);
    setRestoreMsg(null);
    const result = await buy();
    if (result.ok) {
      await recordPurchase();
      setRestoreMsg({ text: 'Purchased — unlocked. Thank you!', ok: true });
    } else if (result.reason === 'pending') {
      setRestoreMsg({
        text: "Purchase pending — you'll be unlocked once payment completes.",
        ok: true,
      });
    } else if (result.reason === 'unavailable') {
      setRestoreMsg({ text: 'Store unavailable — try again later.', ok: false });
    } else if (result.reason === 'error') {
      setRestoreMsg({ text: result.message || 'Purchase failed — try again.', ok: false });
    }
    // 'cancelled': no message, the user changed their mind
    setBuying(false);
  }, [recordPurchase]);

  const onRestore = useCallback(async () => {
    setRestoring(true);
    setRestoreMsg(null);
    const result = await restore();
    if (result.state === 'purchased') {
      await recordPurchase();
      setRestoreMsg({ text: 'Purchase restored — unlocked.', ok: true });
    } else if (result.state === 'none') {
      setRestoreMsg({ text: 'No previous purchase found for this account.', ok: false });
    } else if (result.state === 'unavailable') {
      setRestoreMsg({ text: 'Store unavailable — try again later.', ok: false });
    } else {
      setRestoreMsg({ text: result.message || 'Restore failed — try again.', ok: false });
    }
    setRestoring(false);
  }, [recordPurchase]);

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
      host: draftHost.trim(),
      port: Number.isFinite(p) && p > 0 && p <= 65535 ? p : 8787,
      token: draftToken,
    };
  }, [draftHost, draftPort, draftToken]);

  const test = useCallback(async (override?: { host: string; port: number; token: string }) => {
    const s = override ?? draftSettings();
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

  // QR / deep-link pairing: couchpilot://setup?host=..&port=..&token=..
  // Prefills the draft fields (never auto-saves) and auto-runs the test once.
  const params = useLocalSearchParams<{ host?: string; port?: string; token?: string }>();
  const [fromQr, setFromQr] = useState(false);
  // Guard: the same params must apply exactly once, not on every re-render.
  const appliedQrRef = useRef<string | null>(null);
  const pendingQrTestRef = useRef(false);

  useEffect(() => {
    const qHost = params.host;
    const qToken = params.token;
    if (!qHost || !qToken) return;
    const key = `${qHost}|${params.port ?? '8787'}|${qToken}`;
    if (appliedQrRef.current === key) return;
    appliedQrRef.current = key;
    setHost(qHost);
    setPort(params.port ?? '8787');
    setToken(qToken);
    setFromQr(true);
    pendingQrTestRef.current = true;
  }, [params.host, params.port, params.token]);

  // Run the connection test once after the QR drafts have been applied
  // (test() is recreated with the new drafts, which re-fires this effect).
  // Only consume the pending flag once the current drafts actually match the
  // applied QR values — on a cold-start deep link both effects run in the same
  // mount flush, where test() still closes over the pre-QR drafts.
  useEffect(() => {
    if (!pendingQrTestRef.current) return;
    if (`${draftHost}|${draftPort}|${draftToken}` !== appliedQrRef.current) return;
    pendingQrTestRef.current = false;
    test();
  }, [test, draftHost, draftPort, draftToken]);

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
        <View style={styles.titleRow}>
          <Text style={styles.title}>Setup</Text>
          <EntitlementPill />
        </View>

        {fromQr && (
          <View style={styles.qrBanner}>
            <Text style={styles.qrBannerText}>Loaded from QR — test &amp; save</Text>
          </View>
        )}

        <View style={styles.card}>
          <Text style={styles.fieldLabel}>HOST</Text>
          <TextInput
            style={styles.input}
            value={draftHost}
            onChangeText={setHost}
            placeholder="steamdeck.local · bazzite.local"
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
              onPress={() => test()}
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

          <Pressable
            onPress={() => {
              // No box handy? Fill in the built-in demo target and test it.
              setHost('demo');
              setPort('8787');
              test({ host: 'demo', port: 8787, token: draftToken });
            }}
            disabled={testing || !ready}
            style={({ pressed }) => [styles.demoBtn, pressed && styles.pressed]}>
            <Text style={styles.demoBtnText}>TRY DEMO MODE</Text>
          </Pressable>
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

        <View style={styles.card}>
          <Text style={styles.fieldLabel}>PURCHASE</Text>
          {entitlement.state !== 'purchased' && (
            <Pressable
              onPress={onBuy}
              disabled={buying || restoring}
              style={({ pressed }) => [
                styles.btnBuy,
                (pressed || buying) && styles.pressed,
              ]}>
              <Text style={styles.btnBuyText}>
                {buying ? 'PURCHASING…' : `UNLOCK — ${price ?? '$4.99'}`}
              </Text>
            </Pressable>
          )}
          <Pressable
            onPress={onRestore}
            disabled={restoring || buying}
            style={({ pressed }) => [
              styles.btnRestore,
              (pressed || restoring) && styles.pressed,
            ]}>
            <Text style={styles.btnRestoreText}>
              {restoring ? 'RESTORING…' : 'RESTORE PURCHASES'}
            </Text>
          </Pressable>
          {restoreMsg != null && (
            <Text
              style={[styles.restoreMsg, { color: restoreMsg.ok ? theme.green : theme.red }]}>
              {restoreMsg.text}
            </Text>
          )}
          {entitlement.state !== 'purchased' && (
            <Text style={styles.purchaseHint}>
              One-time unlock · no subscription, no account, no tracking.
            </Text>
          )}
        </View>

        <Text style={styles.hint}>
          The agent listens on http://{draftHost.trim() || '<host>'}:{draftPort || '8787'}. All
          routes except /api/ping require the bearer token.
        </Text>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: theme.bg },
  title: { color: theme.text, fontSize: 26, fontWeight: '700', fontFamily: mono },
  titleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 12,
  },
  pill: {
    borderWidth: 1,
    borderRadius: 999,
    paddingVertical: 4,
    paddingHorizontal: 10,
    backgroundColor: theme.inset,
  },
  pillText: { fontSize: 11, fontWeight: '700', letterSpacing: 0.5, fontFamily: mono },
  card: {
    backgroundColor: theme.card,
    borderColor: theme.cardBorder,
    borderWidth: 1,
    borderRadius: 12,
    padding: 14,
    marginBottom: 12,
  },
  qrBanner: {
    backgroundColor: theme.card,
    borderColor: theme.blue,
    borderWidth: 1,
    borderRadius: 12,
    paddingVertical: 10,
    paddingHorizontal: 14,
    marginBottom: 12,
  },
  qrBannerText: { color: theme.blue, fontSize: 13, fontFamily: mono, fontWeight: '700' },
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
  btnBuy: {
    backgroundColor: theme.blue,
    borderRadius: 8,
    paddingVertical: 14,
    alignItems: 'center',
    marginBottom: 10,
  },
  btnBuyText: { color: '#0b1220', fontWeight: '800', fontSize: 13, letterSpacing: 1 },
  btnRestore: {
    backgroundColor: theme.inset,
    borderColor: theme.cardBorder,
    borderWidth: 1,
    borderRadius: 8,
    paddingVertical: 14,
    alignItems: 'center',
  },
  btnRestoreText: { color: theme.textDim, fontWeight: '800', fontSize: 13, letterSpacing: 1 },
  restoreMsg: { fontSize: 12, fontFamily: mono, marginTop: 10 },
  purchaseHint: { color: theme.textFaint, fontSize: 11, marginTop: 10 },
  demoBtn: { alignSelf: 'center', paddingVertical: 10, paddingHorizontal: 8, marginTop: 4 },
  demoBtnText: { color: theme.textFaint, fontSize: 12, fontWeight: '700', letterSpacing: 1.2 },
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
