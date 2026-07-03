import { useLocalSearchParams } from 'expo-router';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Alert,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import { TabScreen } from '@/components/TabScreen';
import { api, ApiError } from '@/lib/api';
import { recordPurchaseDate } from '@/lib/entitlement';
import { useEntitlement } from '@/lib/EntitlementContext';
import { buy, getProduct, restore } from '@/lib/purchase';
import { DEFAULT_PORT } from '@/lib/settings';
import { useBoxes, useBoxOnlineStatus, BoxReachability } from '@/lib/SettingsContext';
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

/** Subtle gold Early Adopter badge — purchased before the cutoff, local-only. */
function EarlyAdopterBadge() {
  const { entitlement, ready } = useEntitlement();
  if (!ready || !entitlement.isEarlyAdopter) return null;
  return (
    <View style={styles.earlyBadge}>
      <Text style={styles.earlyBadgeText}>★ EARLY ADOPTER</Text>
    </View>
  );
}

function dotColor(status: BoxReachability | undefined): string {
  if (status === 'reachable') return theme.green;
  if (status === 'offline') return theme.slate;
  return theme.amber;
}

/** Cross-platform confirm (Alert buttons are no-ops on web). */
function confirmRemove(name: string, onConfirm: () => void) {
  if (Platform.OS === 'web') {
    // eslint-disable-next-line no-alert
    if (typeof window !== 'undefined' && window.confirm(`Remove "${name}"?`)) onConfirm();
    return;
  }
  Alert.alert('Remove box', `Remove "${name}"?`, [
    { text: 'Cancel', style: 'cancel' },
    { text: 'Remove', style: 'destructive', onPress: onConfirm },
  ]);
}

export default function SetupScreen() {
  return (
    <TabScreen>
      <SetupBody />
    </TabScreen>
  );
}

function SetupBody() {
  const { entitlement, recordPurchase } = useEntitlement();
  const {
    boxes,
    activeBoxId,
    ready,
    addBox,
    removeBox,
    renameBox,
    switchBox,
  } = useBoxes();

  const status = useBoxOnlineStatus(boxes, { active: true, intervalMs: 10000 });

  const [restoring, setRestoring] = useState(false);
  const [buying, setBuying] = useState(false);
  const [restoreMsg, setRestoreMsg] = useState<{ text: string; ok: boolean } | null>(null);

  // Localized price for the Setup buy button.
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
    setBuying(false);
  }, [recordPurchase]);

  const onRestore = useCallback(async () => {
    setRestoring(true);
    setRestoreMsg(null);
    const result = await restore();
    if (result.state === 'purchased') {
      if (result.purchaseDateMs != null) await recordPurchaseDate(result.purchaseDateMs);
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

  // ---------- Add / pair draft ----------

  const [name, setName] = useState('');
  const [host, setHost] = useState('');
  const [port, setPort] = useState('');
  const [token, setToken] = useState('');

  const [pingStep, setPingStep] = useState<StepState>({ state: 'idle' });
  const [authStep, setAuthStep] = useState<StepState>({ state: 'idle' });
  const [agentVersion, setAgentVersion] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);
  const [saved, setSaved] = useState(false);

  const draftConn = useCallback(() => {
    const p = parseInt(port, 10);
    return {
      host: host.trim(),
      port: Number.isFinite(p) && p > 0 && p <= 65535 ? p : DEFAULT_PORT,
      token,
    };
  }, [host, port, token]);

  const test = useCallback(
    async (override?: { host: string; port: number; token: string }) => {
      const s = override ?? draftConn();
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
        const st = await api.status(s);
        setAuthStep({
          state: 'ok',
          detail: `${st.hostname} · agent v${st.agent_version}`,
        });
        setAgentVersion(st.agent_version);
      } catch (e: unknown) {
        setAuthStep({ state: 'fail', detail: errDetail(e) });
      }
      setTesting(false);
    },
    [draftConn],
  );

  const save = useCallback(async () => {
    const conn = draftConn();
    if (!conn.host) return;
    await addBox({
      host: conn.host,
      port: conn.port,
      token: conn.token,
      name: name.trim() || undefined,
    });
    // Clear the add form after a successful add/pair.
    setName('');
    setHost('');
    setPort('');
    setToken('');
    setPingStep({ state: 'idle' });
    setAuthStep({ state: 'idle' });
    setAgentVersion(null);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  }, [addBox, draftConn, name]);

  // ---------- QR / deep-link pairing ----------
  // couchside://setup?host=..&port=..&token=..  → ADD (or update+select) a box.
  const params = useLocalSearchParams<{ host?: string; port?: string; token?: string }>();
  const [fromQr, setFromQr] = useState(false);
  const appliedQrRef = useRef<string | null>(null);

  useEffect(() => {
    if (!ready) return;
    const qHost = typeof params.host === 'string' ? params.host : undefined;
    const qToken = typeof params.token === 'string' ? params.token : undefined;
    if (!qHost || !qToken) return;
    const qPort = typeof params.port === 'string' ? params.port : String(DEFAULT_PORT);
    const key = `${qHost}|${qPort}|${qToken}`;
    if (appliedQrRef.current === key) return;
    appliedQrRef.current = key;

    const p = parseInt(qPort, 10);
    void addBox({
      host: qHost.trim(),
      port: Number.isFinite(p) && p > 0 && p <= 65535 ? p : DEFAULT_PORT,
      token: qToken,
    });
    setFromQr(true);
  }, [ready, params.host, params.port, params.token, addBox]);

  // ---------- Rename in place ----------
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameText, setRenameText] = useState('');

  const beginRename = (id: string, current: string) => {
    setRenamingId(id);
    setRenameText(current);
  };
  const commitRename = async () => {
    if (renamingId) await renameBox(renamingId, renameText);
    setRenamingId(null);
    setRenameText('');
  };

  return (
    <KeyboardAvoidingView
      style={styles.screen}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScrollView
        contentContainerStyle={{
          paddingTop: 12,
          paddingHorizontal: 14,
          paddingBottom: 32,
        }}
        keyboardShouldPersistTaps="handled">
        <View style={styles.titleRow}>
          <Text style={styles.title}>Boxes</Text>
          <View style={styles.titleBadges}>
            <EarlyAdopterBadge />
            <EntitlementPill />
          </View>
        </View>

        {fromQr && (
          <View style={styles.qrBanner}>
            <Text style={styles.qrBannerText}>Added from QR — now active</Text>
          </View>
        )}

        {/* ---- Fleet list ---- */}
        <Text style={styles.sectionLabel}>YOUR FLEET</Text>
        {boxes.length === 0 ? (
          <View style={styles.card}>
            <Text style={styles.emptyText}>
              No boxes yet. Pair your first machine below — enter its host, port,
              and token, or scan a QR from the agent.
            </Text>
          </View>
        ) : (
          boxes.map((box) => {
            const isActive = box.id === activeBoxId;
            const isRenaming = renamingId === box.id;
            return (
              <View key={box.id} style={styles.boxCard}>
                <Pressable
                  onPress={() => switchBox(box.id)}
                  style={styles.boxMain}
                  disabled={isRenaming}>
                  <View style={[styles.boxDot, { backgroundColor: dotColor(status[box.id]) }]} />
                  <View style={styles.boxBody}>
                    {isRenaming ? (
                      <TextInput
                        style={styles.renameInput}
                        value={renameText}
                        onChangeText={setRenameText}
                        onSubmitEditing={commitRename}
                        autoFocus
                        placeholder="box name"
                        placeholderTextColor={theme.textFaint}
                        autoCapitalize="none"
                      />
                    ) : (
                      <Text style={styles.boxName} numberOfLines={1}>
                        {box.name}
                        {isActive && <Text style={styles.activeTag}>  · active</Text>}
                      </Text>
                    )}
                    <Text style={styles.boxHost} numberOfLines={1}>
                      {box.host}:{box.port}
                    </Text>
                  </View>
                </Pressable>
                <View style={styles.boxActions}>
                  {isRenaming ? (
                    <Pressable onPress={commitRename} hitSlop={8} style={styles.iconBtn}>
                      <Text style={styles.iconBtnText}>DONE</Text>
                    </Pressable>
                  ) : (
                    <>
                      <Pressable
                        onPress={() => beginRename(box.id, box.name)}
                        hitSlop={8}
                        style={styles.iconBtn}>
                        <Text style={styles.iconBtnText}>RENAME</Text>
                      </Pressable>
                      <Pressable
                        onPress={() => confirmRemove(box.name, () => void removeBox(box.id))}
                        hitSlop={8}
                        style={styles.iconBtn}>
                        <Text style={[styles.iconBtnText, { color: theme.red }]}>REMOVE</Text>
                      </Pressable>
                    </>
                  )}
                </View>
              </View>
            );
          })
        )}

        {/* ---- Add / pair ---- */}
        <Text style={[styles.sectionLabel, { marginTop: 18 }]}>ADD / PAIR A BOX</Text>
        <View style={styles.card}>
          <Text style={styles.fieldLabel}>NAME (optional)</Text>
          <TextInput
            style={styles.input}
            value={name}
            onChangeText={setName}
            placeholder="Media center · Steam Deck"
            placeholderTextColor={theme.textFaint}
            autoCapitalize="none"
            autoCorrect={false}
            editable={ready}
          />

          <Text style={styles.fieldLabel}>HOST</Text>
          <TextInput
            style={styles.input}
            value={host}
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
            value={port}
            onChangeText={setPort}
            placeholder="8787"
            placeholderTextColor={theme.textFaint}
            keyboardType="number-pad"
            editable={ready}
          />

          <Text style={styles.fieldLabel}>TOKEN</Text>
          <TextInput
            style={styles.input}
            value={token}
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
              disabled={!ready || host.trim().length === 0}
              style={({ pressed }) => [
                styles.btn,
                styles.btnSave,
                (pressed || host.trim().length === 0) && styles.pressed,
              ]}>
              <Text style={styles.btnSaveText}>{saved ? 'ADDED ✓' : 'ADD BOX'}</Text>
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
          Each agent listens on http://&lt;host&gt;:&lt;port&gt;. All routes except
          /api/ping require the bearer token.
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
  titleBadges: { flexDirection: 'row', alignItems: 'center', gap: 8, flexShrink: 1 },
  pill: {
    borderWidth: 1,
    borderRadius: 999,
    paddingVertical: 4,
    paddingHorizontal: 10,
    backgroundColor: theme.inset,
  },
  pillText: { fontSize: 11, fontWeight: '700', letterSpacing: 0.5, fontFamily: mono },
  earlyBadge: {
    borderWidth: 1,
    borderColor: theme.amber,
    borderRadius: 999,
    paddingVertical: 4,
    paddingHorizontal: 10,
    backgroundColor: 'rgba(251,191,36,0.12)',
  },
  earlyBadgeText: {
    color: theme.amber,
    fontSize: 10,
    fontWeight: '800',
    letterSpacing: 0.6,
    fontFamily: mono,
  },
  sectionLabel: {
    color: theme.textFaint,
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 1.2,
    marginBottom: 8,
  },
  card: {
    backgroundColor: theme.card,
    borderColor: theme.cardBorder,
    borderWidth: 1,
    borderRadius: 12,
    padding: 14,
    marginBottom: 12,
  },
  emptyText: { color: theme.textDim, fontSize: 13, lineHeight: 19 },
  boxCard: {
    backgroundColor: theme.card,
    borderColor: theme.cardBorder,
    borderWidth: 1,
    borderRadius: 12,
    paddingVertical: 12,
    paddingHorizontal: 14,
    marginBottom: 8,
  },
  boxMain: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  boxDot: { width: 10, height: 10, borderRadius: 5 },
  boxBody: { flex: 1, minWidth: 0 },
  boxName: { color: theme.text, fontSize: 15, fontWeight: '700', fontFamily: mono },
  activeTag: { color: theme.blue, fontSize: 12, fontWeight: '700' },
  boxHost: { color: theme.textFaint, fontSize: 12, fontFamily: mono, marginTop: 2 },
  renameInput: {
    backgroundColor: theme.inset,
    borderColor: theme.blue,
    borderWidth: 1,
    borderRadius: 8,
    color: theme.text,
    fontSize: 15,
    fontFamily: mono,
    paddingVertical: 6,
    paddingHorizontal: 10,
  },
  boxActions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: 16,
    marginTop: 10,
  },
  iconBtn: { paddingVertical: 2 },
  iconBtnText: {
    color: theme.textDim,
    fontSize: 11,
    fontWeight: '800',
    letterSpacing: 1,
    fontFamily: mono,
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
