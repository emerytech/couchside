import React, { useCallback, useEffect, useState } from 'react';
import {
  Alert,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from 'react-native';

import { QrView } from '@/components/QrView';
import { TabScreen } from '@/components/TabScreen';
import { useLockOrientation } from '@/hooks/useLockOrientation';
import { api, ApiError } from '@/lib/api';
import { recordPurchaseDate } from '@/lib/entitlement';
import { useEntitlement } from '@/lib/EntitlementContext';
import {
  hapticSelection,
  hapticSuccess,
  setHapticsEnabled,
  useHapticsEnabled,
} from '@/lib/haptics';
import { buy, getProduct, restore } from '@/lib/purchase';
import { Box, DEFAULT_PORT } from '@/lib/settings';
import { useBoxes, useBoxOnlineStatus, BoxReachability } from '@/lib/SettingsContext';
import { mono, theme } from '@/lib/theme';

/**
 * Build the pairing link for a box.
 *
 * HTTPS (not couchside://) because Android camera apps won't open custom
 * schemes from a QR; every scanner opens https. The couchside.tv/pair page
 * relaunches the app via the scheme (or offers install links). Params ride
 * the #FRAGMENT so the token never leaves the browser. Fragments aren't
 * sent to the server or its logs.
 */
function pairingUrl(box: Box): string {
  let q =
    `host=${encodeURIComponent(box.host)}` +
    `&port=${encodeURIComponent(String(box.port))}` +
    `&token=${encodeURIComponent(box.token)}`;
  // Pass the cached fallback IP along so the next device starts resilient too.
  if (box.lastIp) q += `&ip=${encodeURIComponent(box.lastIp)}`;
  return `https://couchside.tv/pair#${q}`;
}

/**
 * Modal that renders a box's pairing deep link as a scannable QR on a white
 * card (QRs need a light background + quiet zone). The host + token are shown
 * as small monospace text as a copy-by-hand fallback. Rendered by <QrView>
 * (pure-JS bit matrix -> Views): qrcode's toDataURL needs a canvas/zlib and
 * silently fails on native, which is exactly the "Could not render QR" bug.
 */
const QR_SIZE = 232;

function PairingQrModal({ box, onClose }: { box: Box | null; onClose: () => void }) {
  return (
    <Modal
      visible={box != null}
      transparent
      animationType="fade"
      onRequestClose={onClose}>
      <Pressable style={styles.qrBackdrop} onPress={onClose}>
        {/* Stop taps on the sheet itself from closing the modal. */}
        <Pressable style={styles.qrSheet} onPress={() => {}}>
          <Text style={styles.qrTitle}>{box?.name ?? 'Pair box'}</Text>
          <View style={styles.qrCard}>
            {box && <QrView value={pairingUrl(box)} size={QR_SIZE} />}
          </View>
          <Text style={styles.qrCaption}>Scan with another device to pair it</Text>
          {box && (
            <View style={styles.qrFallback}>
              <Text style={styles.qrFallbackText} selectable>
                {box.host}:{box.port}
              </Text>
              <Text style={styles.qrFallbackToken} selectable numberOfLines={1}>
                {box.token}
              </Text>
            </View>
          )}
          <Pressable
            onPress={onClose}
            style={({ pressed }) => [styles.qrClose, pressed && styles.pressed]}>
            <Text style={styles.qrCloseText}>CLOSE</Text>
          </Pressable>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

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
      ? 'Unlocked, thank you'
      : entitlement.state === 'trial'
        ? `Trial: ${entitlement.trialDaysLeft} day${entitlement.trialDaysLeft === 1 ? '' : 's'} left`
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

/** Subtle gold Early Adopter badge: purchased before the cutoff, local-only. */
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

/**
 * Inline editor for an existing box's connection values. Opens under the box
 * card when it's tapped. Self-contained: seeds its own draft from the box,
 * runs its own ping/auth test, and saves back via updateBox (padMode left
 * untouched). The mount site keys this on the box's id + host/port/token, so
 * it remounts (reseeding the draft) if the underlying box changes out from
 * under it, e.g. an inbound QR re-pair updates the same box while it's open.
 */
function BoxEditPanel({
  box,
  onSave,
  onCancel,
  conflict,
}: {
  box: Box;
  onSave: (patch: { name: string; host: string; port: number; token: string }) => void | Promise<void>;
  onCancel: () => void;
  /** True if the given host+port already belongs to a *different* box. */
  conflict: (host: string, port: number) => boolean;
}) {
  const [name, setName] = useState(box.name);
  const [host, setHost] = useState(box.host);
  const [port, setPort] = useState(String(box.port));
  const [token, setToken] = useState(box.token);
  const [showToken, setShowToken] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [pingStep, setPingStep] = useState<StepState>({ state: 'idle' });
  const [authStep, setAuthStep] = useState<StepState>({ state: 'idle' });
  const [testing, setTesting] = useState(false);

  const conn = useCallback(() => {
    const p = parseInt(port, 10);
    return {
      host: host.trim(),
      port: Number.isFinite(p) && p > 0 && p <= 65535 ? p : DEFAULT_PORT,
      token,
    };
  }, [host, port, token]);

  const test = useCallback(async () => {
    const s = conn();
    setTesting(true);
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
      setAuthStep({ state: 'ok', detail: `${st.hostname} · agent v${st.agent_version}` });
    } catch (e: unknown) {
      setAuthStep({ state: 'fail', detail: errDetail(e) });
    }
    setTesting(false);
  }, [conn]);

  const hostEmpty = host.trim().length === 0;
  const save = useCallback(() => {
    if (hostEmpty) return;
    const c = conn();
    if (conflict(c.host, c.port)) {
      setError('Another box already uses this host:port.');
      return;
    }
    // Preserve the existing token if the (masked) field was left blank. Mirrors
    // addBox, so clearing it can't silently destroy a working credential.
    void onSave({ name: name.trim() || c.host, host: c.host, port: c.port, token: c.token || box.token });
  }, [conn, hostEmpty, name, box.token, conflict, onSave]);

  const showSteps = pingStep.state !== 'idle' || authStep.state !== 'idle';

  return (
    <View style={styles.editPanel}>
      <Text style={styles.fieldLabel}>NAME</Text>
      <TextInput
        style={styles.input}
        value={name}
        onChangeText={setName}
        placeholder="box name"
        placeholderTextColor={theme.textFaint}
        autoCapitalize="none"
        autoCorrect={false}
      />

      <Text style={styles.fieldLabel}>HOST</Text>
      <TextInput
        style={styles.input}
        value={host}
        onChangeText={(t) => {
          setHost(t);
          setError(null);
        }}
        placeholder="steamdeck.local · bazzite.local"
        placeholderTextColor={theme.textFaint}
        autoCapitalize="none"
        autoCorrect={false}
      />

      <Text style={styles.fieldLabel}>PORT</Text>
      <TextInput
        style={styles.input}
        value={port}
        onChangeText={(t) => {
          setPort(t);
          setError(null);
        }}
        placeholder="8787"
        placeholderTextColor={theme.textFaint}
        keyboardType="number-pad"
      />

      <View style={styles.tokenLabelRow}>
        <Text style={[styles.fieldLabel, { marginBottom: 0 }]}>TOKEN</Text>
        <Pressable onPress={() => setShowToken((v) => !v)} hitSlop={8}>
          <Text style={styles.tokenToggle}>{showToken ? 'HIDE' : 'SHOW'}</Text>
        </Pressable>
      </View>
      <TextInput
        style={styles.input}
        value={token}
        onChangeText={setToken}
        placeholder="bearer token"
        placeholderTextColor={theme.textFaint}
        secureTextEntry={!showToken}
        autoCapitalize="none"
        autoCorrect={false}
      />

      <View style={styles.btnRow}>
        <Pressable
          onPress={test}
          disabled={testing}
          style={({ pressed }) => [styles.btn, styles.btnTest, (pressed || testing) && styles.pressed]}>
          <Text style={styles.btnTestText}>{testing ? 'TESTING…' : 'TEST'}</Text>
        </Pressable>
        <Pressable
          onPress={save}
          disabled={hostEmpty}
          style={({ pressed }) => [styles.btn, styles.btnSave, (pressed || hostEmpty) && styles.pressed]}>
          <Text style={styles.btnSaveText}>SAVE</Text>
        </Pressable>
      </View>

      {error && <Text style={styles.editError}>{error}</Text>}

      {showSteps && (
        <View style={styles.editSteps}>
          <StepRow label="1 · /api/ping (unauthenticated)" step={pingStep} />
          <StepRow label="2 · /api/status (Bearer token)" step={authStep} />
        </View>
      )}

      <View style={styles.editFooter}>
        {box.lastIp != null && (
          <Text style={styles.editLastIp}>last seen at {box.lastIp}</Text>
        )}
        <Pressable onPress={onCancel} hitSlop={8} style={styles.iconBtn}>
          <Text style={styles.iconBtnText}>CANCEL</Text>
        </Pressable>
      </View>
    </View>
  );
}

export default function SetupScreen() {
  useLockOrientation('portrait');
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
    updateBox,
    switchBox,
  } = useBoxes();

  const status = useBoxOnlineStatus(boxes, { active: true, intervalMs: 10000 });
  const hapticsOn = useHapticsEnabled();

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
      hapticSuccess();
      setRestoreMsg({ text: 'Purchased, unlocked. Thank you!', ok: true });
    } else if (result.reason === 'pending') {
      setRestoreMsg({
        text: "Purchase pending: you'll be unlocked once payment completes.",
        ok: true,
      });
    } else if (result.reason === 'unavailable') {
      setRestoreMsg({ text: 'Store unavailable, try again later.', ok: false });
    } else if (result.reason === 'error') {
      setRestoreMsg({ text: result.message || 'Purchase failed, try again.', ok: false });
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
      setRestoreMsg({ text: 'Purchase restored, unlocked.', ok: true });
    } else if (result.state === 'none') {
      setRestoreMsg({ text: 'No previous purchase found for this account.', ok: false });
    } else if (result.state === 'unavailable') {
      setRestoreMsg({ text: 'Store unavailable, try again later.', ok: false });
    } else {
      setRestoreMsg({ text: result.message || 'Restore failed, try again.', ok: false });
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
    hapticSuccess();
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  }, [addBox, draftConn, name]);

  // QR / deep-link pairing is handled entirely by the root <DeepLinkHandler/>
  // (app/lib/DeepLink.tsx): it adds the box and navigates here, where the new
  // box appears active at the top of the fleet.

  // ---------- Show pairing QR ----------
  const [qrBox, setQrBox] = useState<Box | null>(null);

  // ---------- Edit connection in place ----------
  // Which box (if any) has its inline edit panel open. Tapping a box card
  // toggles this; only one box edits at a time.
  const [editingId, setEditingId] = useState<string | null>(null);

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

        {/* ---- Fleet list ---- */}
        <Text style={styles.sectionLabel}>YOUR FLEET</Text>
        {boxes.length === 0 ? (
          <View style={styles.card}>
            <Text style={styles.emptyText}>
              No boxes yet. Pair your first machine below: enter its host, port,
              and token, or scan a QR from the agent.
            </Text>
          </View>
        ) : (
          boxes.map((box) => {
            const isActive = box.id === activeBoxId;
            const isEditing = editingId === box.id;
            return (
              <View key={box.id} style={styles.boxCard}>
                <Pressable
                  onPress={() => setEditingId(isEditing ? null : box.id)}
                  style={styles.boxMain}>
                  <View style={[styles.boxDot, { backgroundColor: dotColor(status[box.id]) }]} />
                  <View style={styles.boxBody}>
                    <Text style={styles.boxName} numberOfLines={1}>
                      {box.name}
                      {isActive && <Text style={styles.activeTag}>  · active</Text>}
                    </Text>
                    <Text style={styles.boxHost} numberOfLines={1}>
                      {box.host}:{box.port}
                    </Text>
                  </View>
                  <Text style={styles.chevron}>{isEditing ? '✕' : 'EDIT ›'}</Text>
                </Pressable>
                {isEditing ? (
                  <BoxEditPanel
                    key={`${box.id}|${box.host}|${box.port}|${box.token}`}
                    box={box}
                    conflict={(h, p) =>
                      boxes.some((b) => b.id !== box.id && b.host === h && b.port === p)
                    }
                    onSave={async (patch) => {
                      // A changed host points at a (potentially) different
                      // machine, so drop the cached fallback IP so requests
                      // can't silently keep landing on the old box.
                      await updateBox(
                        box.id,
                        patch.host !== box.host ? { ...patch, lastIp: undefined } : patch,
                      );
                      setEditingId(null);
                    }}
                    onCancel={() => setEditingId(null)}
                  />
                ) : (
                  <View style={styles.boxActions}>
                    {!isActive && (
                      <Pressable
                        onPress={() => {
                          hapticSelection();
                          switchBox(box.id);
                        }}
                        hitSlop={8}
                        style={styles.iconBtn}>
                        <Text style={[styles.iconBtnText, { color: theme.blue }]}>SET ACTIVE</Text>
                      </Pressable>
                    )}
                    <Pressable
                      onPress={() => setQrBox(box)}
                      hitSlop={8}
                      style={styles.iconBtn}>
                      <Text style={[styles.iconBtnText, { color: theme.textDim }]}>SHOW QR</Text>
                    </Pressable>
                    <Pressable
                      onPress={() => setEditingId(box.id)}
                      hitSlop={8}
                      style={styles.iconBtn}>
                      <Text style={styles.iconBtnText}>EDIT</Text>
                    </Pressable>
                    <Pressable
                      onPress={() => confirmRemove(box.name, () => void removeBox(box.id))}
                      hitSlop={8}
                      style={styles.iconBtn}>
                      <Text style={[styles.iconBtnText, { color: theme.red }]}>REMOVE</Text>
                    </Pressable>
                  </View>
                )}
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
          <Text style={styles.fieldLabel}>PREFERENCES</Text>
          <View style={styles.prefRow}>
            <View style={styles.prefBody}>
              <Text style={styles.prefLabel}>Haptic feedback</Text>
              <Text style={styles.prefSub}>
                Vibration on taps, buttons, swipes, and actions.
              </Text>
            </View>
            <Switch
              value={hapticsOn}
              onValueChange={(v) => {
                // Buzz on enable so the toggle confirms itself; setHapticsEnabled
                // runs first so the cue isn't gated off when turning it on.
                void setHapticsEnabled(v);
                if (v) hapticSelection();
              }}
              trackColor={{ false: theme.inset, true: theme.blue }}
              thumbColor="#f8fafc"
              ios_backgroundColor={theme.inset}
            />
          </View>
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
                {buying ? 'PURCHASING…' : `UNLOCK ${price ?? '$4.99'}`}
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
      <PairingQrModal box={qrBox} onClose={() => setQrBox(null)} />
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
  chevron: {
    color: theme.textFaint,
    fontSize: 12,
    fontWeight: '800',
    letterSpacing: 1,
    fontFamily: mono,
  },
  editPanel: {
    marginTop: 12,
    borderTopColor: theme.cardBorder,
    borderTopWidth: 1,
    paddingTop: 14,
  },
  editSteps: { marginTop: 14 },
  editError: {
    color: theme.red,
    fontSize: 12,
    fontFamily: mono,
    marginTop: 10,
  },
  editFooter: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: 20,
    marginTop: 16,
  },
  editLastIp: {
    color: theme.textFaint,
    fontSize: 11,
    fontFamily: mono,
    marginRight: 'auto',
  },
  tokenLabelRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 6,
  },
  tokenToggle: {
    color: theme.blue,
    fontSize: 11,
    fontWeight: '800',
    letterSpacing: 1,
    fontFamily: mono,
  },
  boxActions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'flex-end',
    gap: 16,
    rowGap: 8,
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
  prefRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
  },
  prefBody: { flex: 1, minWidth: 0 },
  prefLabel: { color: theme.text, fontSize: 15, fontWeight: '600', fontFamily: mono },
  prefSub: { color: theme.textFaint, fontSize: 12, marginTop: 3 },
  versionLabel: { color: theme.textDim, fontSize: 13 },
  versionValue: { color: theme.green, fontSize: 13, fontFamily: mono, fontWeight: '700' },
  hint: { color: theme.textFaint, fontSize: 12, lineHeight: 17, fontFamily: mono },

  // ---- Pairing QR modal ----
  qrBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.7)',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
  },
  qrSheet: {
    width: '100%',
    maxWidth: 360,
    backgroundColor: theme.card,
    borderColor: theme.cardBorder,
    borderWidth: 1,
    borderRadius: 16,
    padding: 20,
    alignItems: 'center',
  },
  qrTitle: {
    color: theme.text,
    fontSize: 16,
    fontWeight: '700',
    fontFamily: mono,
    marginBottom: 14,
    textAlign: 'center',
  },
  qrCard: {
    backgroundColor: '#ffffff',
    borderRadius: 16,
    padding: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
  qrCaption: {
    color: theme.textDim,
    fontSize: 13,
    fontFamily: mono,
    marginTop: 14,
    textAlign: 'center',
  },
  qrFallback: {
    marginTop: 12,
    alignItems: 'center',
    alignSelf: 'stretch',
  },
  qrFallbackText: {
    color: theme.textFaint,
    fontSize: 11,
    fontFamily: mono,
  },
  qrFallbackToken: {
    color: theme.textFaint,
    fontSize: 11,
    fontFamily: mono,
    marginTop: 2,
    maxWidth: '100%',
  },
  qrClose: {
    marginTop: 18,
    backgroundColor: theme.inset,
    borderColor: theme.cardBorder,
    borderWidth: 1,
    borderRadius: 8,
    paddingVertical: 12,
    paddingHorizontal: 32,
    alignItems: 'center',
  },
  qrCloseText: {
    color: theme.textDim,
    fontWeight: '800',
    fontSize: 13,
    letterSpacing: 1,
    fontFamily: mono,
  },
});
