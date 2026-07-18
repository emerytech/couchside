import Ionicons from '@expo/vector-icons/Ionicons';
import Constants from 'expo-constants';
import * as Linking from 'expo-linking';
import { useLocalSearchParams, useRouter } from 'expo-router';
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

import { AgentUpdateBanner } from '@/components/AgentUpdateBanner';
import { Gated } from '@/components/Gated';
import { LogsPanel } from '@/components/LogsPanel';
import { QrView } from '@/components/QrView';
import { BoxScanPair } from '@/components/BoxScanPair';
import { SmartTvSetup } from '@/components/SmartTvSetup';
import { TabScreen } from '@/components/TabScreen';
import { useLockOrientation } from '@/hooks/useLockOrientation';
import { api, ApiError } from '@/lib/api';
import { isGenuinelyPurchased, recordPurchaseDate } from '@/lib/entitlement';
import { useEntitlement } from '@/lib/EntitlementContext';
import { openWriteReview } from '@/lib/review';
import {
  hapticLight,
  hapticSelection,
  hapticSuccess,
  setHapticsEnabled,
  useHapticsEnabled,
} from '@/lib/haptics';
import { setKeepAwakeEnabled, useKeepAwakeEnabled } from '@/lib/keepAwake';
import { setPref, usePref } from '@/lib/prefs';
import { buy, getProduct, restore } from '@/lib/purchase';
import { Box, DEFAULT_PORT, normalizeMac } from '@/lib/settings';
import { VolumeTarget } from '@/lib/api';
import { useBoxes, useBoxOnlineStatus, BoxReachability } from '@/lib/SettingsContext';
import {
  ACCENTS,
  ACCENT_KEYS,
  mono,
  setAccent,
  setThemeMode,
  useAccent,
  useResolvedScheme,
  useTheme,
  useThemedStyles,
  useThemeMode,
  type Palette,
} from '@/lib/theme';

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

// About-row app version. `expoConfig` is embedded in store builds, so it
// reflects the installed binary: the marketing version plus the native build
// number (iOS buildNumber / Android versionCode).
const APP_VERSION = Constants.expoConfig?.version ?? '—';
const APP_BUILD =
  Platform.OS === 'ios'
    ? Constants.expoConfig?.ios?.buildNumber ?? ''
    : Constants.expoConfig?.android?.versionCode != null
      ? String(Constants.expoConfig.android.versionCode)
      : '';

// couchside.tv setup guide — how to install the agent on a box. New users who
// grabbed the app from a store land here with no idea a box-side agent exists.
const SETUP_GUIDE_URL = 'https://couchside.tv/#how';

function PairingQrModal({ box, onClose }: { box: Box | null; onClose: () => void }) {
  const styles = useThemedStyles(makeStyles);
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
  const t = useTheme();
  const styles = useThemedStyles(makeStyles);
  const mark =
    step.state === 'ok' ? '✓' : step.state === 'fail' ? '✗' : step.state === 'running' ? '…' : '·';
  const color =
    step.state === 'ok'
      ? t.green
      : step.state === 'fail'
        ? t.red
        : t.textFaint;
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
  const t = useTheme();
  const styles = useThemedStyles(makeStyles);
  const { entitlement, ready } = useEntitlement();
  if (!ready) return null;
  // A store-unreachable fail-open must not claim "Unlocked": report the real
  // trial clock it still carries, so the Buy button beside it makes sense.
  const purchased = isGenuinelyPurchased(entitlement);
  const label = purchased
    ? 'Unlocked, thank you'
    : entitlement.trialDaysLeft > 0
      ? `Trial: ${entitlement.trialDaysLeft} day${entitlement.trialDaysLeft === 1 ? '' : 's'} left`
      : 'Trial ended';
  const color = purchased
    ? t.green
    : entitlement.trialDaysLeft > 0
      ? t.amber
      : t.red;
  return (
    <View style={[styles.pill, { borderColor: color }]}>
      <Text style={[styles.pillText, { color }]}>{label}</Text>
    </View>
  );
}

/** Subtle gold Early Adopter badge: purchased before the cutoff, local-only. */
function EarlyAdopterBadge() {
  const styles = useThemedStyles(makeStyles);
  const { entitlement, ready } = useEntitlement();
  if (!ready || !entitlement.isEarlyAdopter) return null;
  return (
    <View style={styles.earlyBadge}>
      <Text style={styles.earlyBadgeText}>★ EARLY ADOPTER</Text>
    </View>
  );
}

function dotColor(status: BoxReachability | undefined, t: Palette): string {
  if (status === 'reachable') return t.green;
  if (status === 'offline') return t.slate;
  return t.amber;
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
  onVolumeTarget,
  onCancel,
  conflict,
}: {
  box: Box;
  onSave: (patch: {
    name: string;
    host: string;
    port: number;
    token: string;
    mac?: string;
  }) => void | Promise<void>;
  /** Persist the volume target immediately (like the header control), so it
   * can't be reverted by a stale draft on a later Save. */
  onVolumeTarget: (target: VolumeTarget) => void;
  onCancel: () => void;
  /** True if the given host+port already belongs to a *different* box. */
  conflict: (host: string, port: number) => boolean;
}) {
  const t = useTheme();
  const styles = useThemedStyles(makeStyles);
  const [name, setName] = useState(box.name);
  const [host, setHost] = useState(box.host);
  const [port, setPort] = useState(String(box.port));
  const [token, setToken] = useState(box.token);
  const [showToken, setShowToken] = useState(false);
  const [mac, setMac] = useState(box.mac ?? '');
  // The MAC known when the editor opened. Save only writes MAC when the field
  // was actually changed, so a value auto-learned from /api/status while the
  // editor is open (RemotePowerBar polls the active box) is never clobbered.
  const [seedMac] = useState<string | undefined>(box.mac ?? undefined);
  const volumeTarget: VolumeTarget = box.volumeTarget ?? 'box';
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
    // A typed MAC must be a real address. A blank field means "leave it alone"
    // (not "clear"), so a MAC auto-learned while the editor was open survives.
    const macTrim = mac.trim();
    const patch: {
      name: string;
      host: string;
      port: number;
      token: string;
      mac?: string;
    } = {
      name: name.trim() || c.host,
      host: c.host,
      port: c.port,
      // Preserve the existing token if the (masked) field was left blank.
      // Mirrors addBox, so clearing it can't destroy a working credential.
      token: c.token || box.token,
    };
    if (macTrim) {
      const n = normalizeMac(macTrim);
      if (!n) {
        setError('MAC must look like aa:bb:cc:dd:ee:ff.');
        return;
      }
      // Only write when the user actually changed it, so we never overwrite a
      // newer auto-learned MAC with the value that was on screen at open time.
      if (n !== seedMac) patch.mac = n;
    }
    void onSave(patch);
  }, [conn, hostEmpty, name, box.token, conflict, onSave, mac, seedMac]);

  const showSteps = pingStep.state !== 'idle' || authStep.state !== 'idle';

  return (
    <View style={styles.editPanel}>
      <Text style={styles.fieldLabel}>NAME</Text>
      <TextInput
        style={styles.input}
        value={name}
        onChangeText={setName}
        placeholder="box name"
        placeholderTextColor={t.textFaint}
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
        placeholderTextColor={t.textFaint}
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
        placeholderTextColor={t.textFaint}
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
        placeholderTextColor={t.textFaint}
        secureTextEntry={!showToken}
        autoCapitalize="none"
        autoCorrect={false}
      />

      <Text style={styles.fieldLabel}>MAC (WAKE-ON-LAN)</Text>
      <TextInput
        style={styles.input}
        value={mac}
        onChangeText={(t) => {
          setMac(t);
          setError(null);
        }}
        placeholder="aa:bb:cc:dd:ee:ff · auto-learned when reachable"
        placeholderTextColor={t.textFaint}
        autoCapitalize="none"
        autoCorrect={false}
      />

      <Text style={styles.fieldLabel}>VOLUME CONTROLS</Text>
      <View style={styles.segRow}>
        <Pressable
          onPress={() => onVolumeTarget('box')}
          style={[styles.seg, volumeTarget === 'box' && styles.segActive]}>
          <Text style={[styles.segText, volumeTarget === 'box' && styles.segTextActive]}>
            Box
          </Text>
        </Pressable>
        <Pressable
          onPress={() => onVolumeTarget('tv')}
          style={[styles.seg, volumeTarget === 'tv' && styles.segActive]}>
          <Text style={[styles.segText, volumeTarget === 'tv' && styles.segTextActive]}>
            TV
          </Text>
        </Pressable>
      </View>

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

      <View style={styles.smartTvWrap}>
        <SmartTvSetup settings={box} />
      </View>

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

/** A labeled on/off row for the Preferences card. */
function TogglePref({
  label,
  sub,
  value,
  onValueChange,
}: {
  label: string;
  sub: string;
  value: boolean;
  onValueChange: (v: boolean) => void;
}) {
  const t = useTheme();
  const styles = useThemedStyles(makeStyles);
  return (
    <View style={styles.prefRow}>
      <View style={styles.prefBody}>
        <Text style={styles.prefLabel}>{label}</Text>
        <Text style={styles.prefSub}>{sub}</Text>
      </View>
      <Switch
        value={value}
        onValueChange={onValueChange}
        trackColor={{ false: t.inset, true: t.blue }}
        thumbColor="#f8fafc"
        ios_backgroundColor={t.inset}
      />
    </View>
  );
}

/** A labeled segmented picker for the Preferences card. */
function SegPref<T extends string | number>({
  label,
  sub,
  options,
  value,
  onSelect,
}: {
  label: string;
  sub: string;
  options: { value: T; label: string }[];
  value: T;
  onSelect: (v: T) => void;
}) {
  const styles = useThemedStyles(makeStyles);
  return (
    <View style={styles.prefCol}>
      <View style={styles.prefBody}>
        <Text style={styles.prefLabel}>{label}</Text>
        <Text style={styles.prefSub}>{sub}</Text>
      </View>
      <View style={styles.segRow}>
        {options.map((o) => (
          <Pressable
            key={String(o.value)}
            onPress={() => onSelect(o.value)}
            style={[styles.seg, value === o.value && styles.segActive]}>
            <Text style={[styles.segText, value === o.value && styles.segTextActive]}>
              {o.label}
            </Text>
          </Pressable>
        ))}
      </View>
    </View>
  );
}

type IoniconName = React.ComponentProps<typeof Ionicons>['name'];

/** The category tabs across the top of the setup screen. */
type SetupTab = 'boxes' | 'prefs' | 'logs' | 'account';
const SETUP_TABS: { key: SetupTab; label: string; icon: IoniconName }[] = [
  { key: 'boxes', label: 'Boxes', icon: 'hardware-chip-outline' },
  { key: 'prefs', label: 'Prefs', icon: 'options-outline' },
  { key: 'logs', label: 'Logs', icon: 'reader-outline' },
  { key: 'account', label: 'Account', icon: 'card-outline' },
];

function CategoryTabs({ tab, onTab }: { tab: SetupTab; onTab: (t: SetupTab) => void }) {
  const pal = useTheme();
  const styles = useThemedStyles(makeStyles);
  return (
    <View style={styles.tabBar}>
      {SETUP_TABS.map((t) => {
        const active = t.key === tab;
        return (
          <Pressable
            key={t.key}
            onPress={() => {
              hapticSelection();
              onTab(t.key);
            }}
            style={[styles.tabItem, active && styles.tabItemActive]}>
            <Ionicons name={t.icon} size={15} color={active ? pal.text : pal.textFaint} />
            <Text style={[styles.tabLabel, active && styles.tabLabelActive]} numberOfLines={1}>
              {t.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

/** A small section header inside a card: icon + uppercase label. */
function CardHeader({ icon, label }: { icon: IoniconName; label: string }) {
  const t = useTheme();
  const styles = useThemedStyles(makeStyles);
  return (
    <View style={styles.cardHeader}>
      <Ionicons name={icon} size={14} color={t.textDim} />
      <Text style={styles.cardHeaderText}>{label}</Text>
    </View>
  );
}

function SetupBody() {
  const t = useTheme();
  const styles = useThemedStyles(makeStyles);
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
  const keepAwakeOn = useKeepAwakeEnabled();
  const themeMode = useThemeMode();
  const accent = useAccent();
  const scheme = useResolvedScheme();
  const confirmSuspend = usePref('confirmSuspend');
  const defaultPadMode = usePref('defaultPadMode');
  const statusIntervalMs = usePref('statusIntervalMs');
  const journalLines = usePref('journalLines');
  const swipeSensitivity = usePref('swipeSensitivity');
  const trackpadSensitivity = usePref('trackpadSensitivity');
  const naturalScroll = usePref('naturalScroll');
  const padMouseRow = usePref('padMouseRow');
  const padSteamRow = usePref('padSteamRow');
  const padDesktopNav = usePref('padDesktopNav');
  const padWinShortcuts = usePref('padWinShortcuts');
  const padKeyboardBar = usePref('padKeyboardBar');
  const padHints = usePref('padHints');
  const askToSwitchControl = usePref('askToSwitchControl');

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

  // Active category tab (Boxes / Preferences / Account).
  const [tab, setTab] = useState<SetupTab>('boxes');

  // Deep-link straight to the purchase: the trial nudge banner pushes
  // /setup?tab=account. Clear the param once applied, so tapping the banner
  // again still lands here instead of being swallowed as a no-op re-render.
  const params = useLocalSearchParams<{ tab?: string }>();
  const router = useRouter();
  useEffect(() => {
    if (params.tab === 'account') {
      setTab('account');
      router.setParams({ tab: undefined });
    }
  }, [params.tab, router]);

  return (
    <KeyboardAvoidingView
      style={styles.screen}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <View style={styles.header}>
        <CategoryTabs tab={tab} onTab={setTab} />
      </View>
      {/* The unlock is a one-time purchase buried under the Account category,
          and during the trial nothing else points at it — App Review could not
          find it at all (2.1(b), build 27). This row is the signpost: always on
          screen while unpurchased, on whichever category is open. */}
      {!isGenuinelyPurchased(entitlement) && tab !== 'account' && (
        <Pressable
          onPress={() => {
            hapticLight();
            setTab('account');
          }}
          style={({ pressed }) => [styles.unlockRow, pressed && styles.pressed]}>
          <Ionicons name="lock-open-outline" size={18} color={t.blue} />
          <View style={styles.unlockRowBody}>
            <Text style={styles.unlockRowTitle}>Unlock Couchside — {price ?? '$4.99'}</Text>
            <Text style={styles.unlockRowSub}>
              {entitlement.trialDaysLeft > 0
                ? `Trial: ${entitlement.trialDaysLeft} day${
                    entitlement.trialDaysLeft === 1 ? '' : 's'
                  } left · one-time purchase, no subscription`
                : 'Trial ended · one-time purchase, no subscription'}
            </Text>
          </View>
          <Ionicons name="chevron-forward" size={18} color={t.textDim} />
        </Pressable>
      )}
      {/* Logs hosts its own FlatList and must not live inside a ScrollView.
          Gated like the old top-level Logs tab (the journal is a paid surface;
          Setup itself stays un-gated so purchase/restore is always reachable). */}
      {tab === 'logs' && (
        <Gated>
          <LogsPanel />
        </Gated>
      )}
      <ScrollView
        style={tab === 'logs' ? styles.hidden : undefined}
        contentContainerStyle={{
          paddingTop: 14,
          paddingHorizontal: 14,
          paddingBottom: 32,
        }}
        keyboardShouldPersistTaps="handled">
        {tab === 'boxes' && (
          <>
            {/* ---- Fleet list ---- */}
            <Text style={styles.sectionLabel}>YOUR FLEET</Text>
        {boxes.length === 0 ? (
          <View style={styles.card}>
            <Text style={styles.emptyText}>
              No boxes yet. Pair your first machine below: enter its host, port,
              and token, or scan a QR from the agent.
            </Text>
            {/* The box needs the agent installed before it can be paired at
                all — surface the setup guide right where a new user gets stuck. */}
            <Pressable
              onPress={() => {
                hapticLight();
                void Linking.openURL(SETUP_GUIDE_URL);
              }}
              style={({ pressed }) => [styles.emptyLink, pressed && styles.pressed]}>
              <Ionicons name="hardware-chip-outline" size={15} color={t.blue} />
              <Text style={styles.emptyLinkText}>
                Haven&apos;t installed the agent? Setup guide
              </Text>
              <Ionicons name="open-outline" size={13} color={t.blue} />
            </Pressable>
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
                  <View style={[styles.boxDot, { backgroundColor: dotColor(status[box.id], t) }]} />
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
                    onVolumeTarget={(target) => void updateBox(box.id, { volumeTarget: target })}
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
                        <Text style={[styles.iconBtnText, { color: t.blue }]}>SET ACTIVE</Text>
                      </Pressable>
                    )}
                    <Pressable
                      onPress={() => setQrBox(box)}
                      hitSlop={8}
                      style={styles.iconBtn}>
                      <Text style={[styles.iconBtnText, { color: t.textDim }]}>SHOW QR</Text>
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
                      <Text style={[styles.iconBtnText, { color: t.red }]}>REMOVE</Text>
                    </Pressable>
                  </View>
                )}
              </View>
            );
          })
        )}

        {/* ---- Add / pair ---- */}
        <Text style={[styles.sectionLabel, { marginTop: 18 }]}>ADD / PAIR A BOX</Text>
        {/* Scan the LAN + PIN-pair (no IP/token typing). Hidden on builds without
            the UDP native module. The manual card below stays as the fallback. */}
        <View style={styles.card}>
          <BoxScanPair />
        </View>
        <View style={styles.card}>
          <Text style={styles.fieldLabel}>NAME (optional)</Text>
          <TextInput
            style={styles.input}
            value={name}
            onChangeText={setName}
            placeholder="Media center · Steam Deck"
            placeholderTextColor={t.textFaint}
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
            placeholderTextColor={t.textFaint}
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
            placeholderTextColor={t.textFaint}
            keyboardType="number-pad"
            editable={ready}
          />

          <Text style={styles.fieldLabel}>TOKEN</Text>
          <TextInput
            style={styles.input}
            value={token}
            onChangeText={setToken}
            placeholder="bearer token"
            placeholderTextColor={t.textFaint}
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
          <CardHeader icon="pulse-outline" label="CONNECTION TEST" />
          <StepRow label="1 · /api/ping (unauthenticated)" step={pingStep} />
          <StepRow label="2 · /api/status (Bearer token)" step={authStep} />
          {agentVersion != null && (
            <View style={styles.versionRow}>
              <Text style={styles.versionLabel}>agent version</Text>
              <Text style={styles.versionValue}>{agentVersion}</Text>
            </View>
          )}
        </View>
          </>
        )}

        {tab === 'prefs' && (
          <>
            <View style={[styles.card, styles.cardGroup]}>
              <CardHeader icon="options-outline" label="GENERAL" />
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
                    // Buzz on enable so the toggle confirms itself;
                    // setHapticsEnabled runs first so the cue isn't gated off.
                    void setHapticsEnabled(v);
                    if (v) hapticSelection();
                  }}
                  trackColor={{ false: t.inset, true: t.blue }}
                  thumbColor="#f8fafc"
                  ios_backgroundColor={t.inset}
                />
              </View>
              <TogglePref
                label="Confirm before suspend"
                sub="Ask before putting the box to sleep."
                value={confirmSuspend}
                onValueChange={(v) => {
                  void setPref('confirmSuspend', v);
                  hapticSelection();
                }}
              />
              <SegPref
                label="Vitals refresh"
                sub="How often the console polls the box."
                options={[
                  { value: 2000, label: '2s' },
                  { value: 5000, label: '5s' },
                  { value: 15000, label: '15s' },
                  { value: 30000, label: '30s' },
                ]}
                value={statusIntervalMs}
                onSelect={(v) => {
                  void setPref('statusIntervalMs', v);
                  hapticSelection();
                }}
              />
              <SegPref
                label="Journal lines"
                sub="Lines fetched per unit on the Logs tab."
                options={[
                  { value: 50, label: '50' },
                  { value: 100, label: '100' },
                  { value: 250, label: '250' },
                  { value: 500, label: '500' },
                ]}
                value={journalLines}
                onSelect={(v) => {
                  void setPref('journalLines', v);
                  hapticSelection();
                }}
              />
            </View>

            <View style={[styles.card, styles.cardGroup]}>
              <CardHeader icon="color-palette-outline" label="APPEARANCE" />
              <SegPref
                label="Theme"
                sub="Follow the system, or force light or dark."
                options={[
                  { value: 'system', label: 'System' },
                  { value: 'light', label: 'Light' },
                  { value: 'dark', label: 'Dark' },
                ]}
                value={themeMode}
                onSelect={(v) => {
                  void setThemeMode(v);
                  hapticSelection();
                }}
              />
              <View style={styles.prefCol}>
                <View style={styles.prefBody}>
                  <Text style={styles.prefLabel}>Accent</Text>
                  <Text style={styles.prefSub}>The app&apos;s highlight color.</Text>
                </View>
                <View style={styles.accentRow}>
                  {ACCENT_KEYS.map((k) => (
                    <Pressable
                      key={k}
                      onPress={() => {
                        void setAccent(k);
                        hapticSelection();
                      }}
                      accessibilityRole="button"
                      accessibilityLabel={ACCENTS[k].label}
                      style={[
                        styles.accentSwatch,
                        { backgroundColor: ACCENTS[k][scheme] },
                        accent === k && styles.accentSwatchActive,
                      ]}
                    />
                  ))}
                </View>
              </View>
            </View>

            <View style={[styles.card, styles.cardGroup]}>
              <CardHeader icon="game-controller-outline" label="INPUT & PAD" />
              <View style={styles.prefRow}>
                <View style={styles.prefBody}>
                  <Text style={styles.prefLabel}>Keep screen awake on Pad</Text>
                  <Text style={styles.prefSub}>
                    Hold the display on while the controller is open. Off saves
                    battery.
                  </Text>
                </View>
                <Switch
                  value={keepAwakeOn}
                  onValueChange={(v) => {
                    void setKeepAwakeEnabled(v);
                    hapticSelection();
                  }}
                  trackColor={{ false: t.inset, true: t.blue }}
                  thumbColor="#f8fafc"
                  ios_backgroundColor={t.inset}
                />
              </View>
              <SegPref
                label="Default input mode"
                sub="What a newly paired box starts on."
                options={[
                  { value: 'gamepad', label: 'Pad' },
                  { value: 'swipe', label: 'Swipe' },
                  { value: 'trackpad', label: 'Track' },
                  { value: 'remote', label: 'Remote' },
                ]}
                value={defaultPadMode}
                onSelect={(v) => {
                  void setPref('defaultPadMode', v);
                  hapticSelection();
                }}
              />
              <SegPref
                label="Swipe sensitivity"
                sub="Steps per swipe on the Pad's swipe surface."
                options={[
                  { value: 0.6, label: 'Low' },
                  { value: 1, label: 'Normal' },
                  { value: 1.6, label: 'High' },
                ]}
                value={swipeSensitivity}
                onSelect={(v) => {
                  void setPref('swipeSensitivity', v);
                  hapticSelection();
                }}
              />
              <SegPref
                label="Trackpad speed"
                sub="Pointer speed on the trackpad surface."
                options={[
                  { value: 0.6, label: 'Low' },
                  { value: 1, label: 'Normal' },
                  { value: 1.6, label: 'High' },
                ]}
                value={trackpadSensitivity}
                onSelect={(v) => {
                  void setPref('trackpadSensitivity', v);
                  hapticSelection();
                }}
              />
              <TogglePref
                label="Natural scrolling"
                sub="Two-finger scroll follows your fingers (macOS style)."
                value={naturalScroll}
                onValueChange={(v) => {
                  void setPref('naturalScroll', v);
                  hapticSelection();
                }}
              />
            </View>

            {/* Every optional Pad row/view can be hidden — declutter to taste. */}
            <View style={styles.card}>
              <CardHeader icon="game-controller-outline" label="PAD LAYOUT" />
              <TogglePref
                label="Mouse buttons"
                sub="L / M / R click row under the trackpad."
                value={padMouseRow}
                onValueChange={(v) => {
                  void setPref('padMouseRow', v);
                  hapticSelection();
                }}
              />
              <TogglePref
                label="Steam buttons"
                sub="STEAM and ⋯ (Quick Access) in the trackpad row."
                value={padSteamRow}
                onValueChange={(v) => {
                  void setPref('padSteamRow', v);
                  hapticSelection();
                }}
              />
              <TogglePref
                label="Desktop navigation"
                sub="Start menu, Overview, and the D-pad↔trackpad toggle on SteamOS/Bazzite desktops."
                value={padDesktopNav}
                onValueChange={(v) => {
                  void setPref('padDesktopNav', v);
                  hapticSelection();
                }}
              />
              <TogglePref
                label="Windows shortcuts"
                sub="WIN / ALT+TAB / LOCK / TASK row on Windows boxes."
                value={padWinShortcuts}
                onValueChange={(v) => {
                  void setPref('padWinShortcuts', v);
                  hapticSelection();
                }}
              />
              <TogglePref
                label="Keyboard bar"
                sub="The KEYBOARD button at the bottom of the Pad tab."
                value={padKeyboardBar}
                onValueChange={(v) => {
                  void setPref('padKeyboardBar', v);
                  hapticSelection();
                }}
              />
              <TogglePref
                label="Gesture hints"
                sub="The helper text on swipe and trackpad surfaces."
                value={padHints}
                onValueChange={(v) => {
                  void setPref('padHints', v);
                  hapticSelection();
                }}
              />
              <TogglePref
                label="Ask before switching control"
                sub="When another phone joins a box you're controlling, it asks and you tap Pass — instead of taking over instantly. Needs agent 2.9.2+."
                value={askToSwitchControl}
                onValueChange={(v) => {
                  void setPref('askToSwitchControl', v);
                  hapticSelection();
                }}
              />
            </View>
          </>
        )}

        {tab === 'account' && (
          <>
            <AgentUpdateBanner />
            <View style={styles.accountBadges}>
              <EarlyAdopterBadge />
              <EntitlementPill />
            </View>
            <View style={styles.card}>
              <CardHeader icon="card-outline" label="PURCHASE" />
              {!isGenuinelyPurchased(entitlement) && (
                <Pressable
                  onPress={onBuy}
                  disabled={buying || restoring}
                  style={({ pressed }) => [styles.btnBuy, (pressed || buying) && styles.pressed]}>
                  <Text style={styles.btnBuyText}>
                    {buying ? 'PURCHASING…' : `UNLOCK ${price ?? '$4.99'}`}
                  </Text>
                </Pressable>
              )}
              <Pressable
                onPress={onRestore}
                disabled={restoring || buying}
                style={({ pressed }) => [styles.btnRestore, (pressed || restoring) && styles.pressed]}>
                <Text style={styles.btnRestoreText}>
                  {restoring ? 'RESTORING…' : 'RESTORE PURCHASES'}
                </Text>
              </Pressable>
              {restoreMsg != null && (
                <Text style={[styles.restoreMsg, { color: restoreMsg.ok ? t.green : t.red }]}>
                  {restoreMsg.text}
                </Text>
              )}
              {!isGenuinelyPurchased(entitlement) && (
                <Text style={styles.purchaseHint}>
                  One-time unlock · no subscription, no account, no tracking.
                </Text>
              )}
            </View>

            {/* User-initiated, always available. This LINKS OUT to the store's
                write-review page — it must never call requestReview(): Apple
                does not allow the native sheet to be summoned by a tap. The
                app-triggered sheet lives in components/ReviewPrompt.tsx. */}
            <Pressable
              onPress={() => {
                hapticLight();
                void openWriteReview();
              }}
              style={({ pressed }) => [styles.rateRow, pressed && styles.pressed]}>
              <Ionicons name="star-outline" size={18} color={t.amber} />
              <View style={styles.rateBody}>
                <Text style={styles.rateTitle}>Rate Couchside</Text>
                <Text style={styles.rateSub}>
                  A quick review helps other people find it.
                </Text>
              </View>
              <Ionicons name="open-outline" size={16} color={t.textDim} />
            </Pressable>

            {/* First-run lifeline: the app is useless without the box-side agent,
                and a store download gives no hint one exists. Links to the
                install/setup guide on couchside.tv. */}
            <Pressable
              onPress={() => {
                hapticLight();
                void Linking.openURL(SETUP_GUIDE_URL);
              }}
              style={({ pressed }) => [styles.rateRow, pressed && styles.pressed]}>
              <Ionicons name="hardware-chip-outline" size={18} color={t.blue} />
              <View style={styles.rateBody}>
                <Text style={styles.rateTitle}>Set up a box</Text>
                <Text style={styles.rateSub}>
                  Install the agent — instructions at couchside.tv.
                </Text>
              </View>
              <Ionicons name="open-outline" size={16} color={t.textDim} />
            </Pressable>

            <View style={styles.aboutRow}>
              <Ionicons name="information-circle-outline" size={16} color={t.textDim} />
              <Text style={styles.aboutText}>
                Couchside v{APP_VERSION}
                {APP_BUILD ? ` (${Platform.OS === 'ios' ? 'build' : 'vc'} ${APP_BUILD})` : ''}
              </Text>
            </View>

            <Text style={styles.hint}>
              Each agent listens on http://&lt;host&gt;:&lt;port&gt;. All routes except
              /api/ping require the bearer token.
            </Text>
          </>
        )}
      </ScrollView>
      <PairingQrModal box={qrBox} onClose={() => setQrBox(null)} />
    </KeyboardAvoidingView>
  );
}

const makeStyles = (t: Palette) => StyleSheet.create({
  screen: { flex: 1, backgroundColor: t.bg },
  // Collapse the ScrollView while the Logs tab (its own FlatList) is showing.
  hidden: { display: 'none' },
  title: { color: t.text, fontSize: 26, fontWeight: '700', fontFamily: mono },
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
    backgroundColor: t.inset,
  },
  pillText: { fontSize: 11, fontWeight: '700', letterSpacing: 0.5, fontFamily: mono },
  earlyBadge: {
    borderWidth: 1,
    borderColor: t.amber,
    borderRadius: 999,
    paddingVertical: 4,
    paddingHorizontal: 10,
    backgroundColor: 'rgba(251,191,36,0.12)',
  },
  earlyBadgeText: {
    color: t.amber,
    fontSize: 10,
    fontWeight: '800',
    letterSpacing: 0.6,
    fontFamily: mono,
  },
  sectionLabel: {
    color: t.textFaint,
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 1.2,
    marginBottom: 8,
  },
  header: {
    paddingHorizontal: 14,
    paddingTop: 8,
    paddingBottom: 10,
    borderBottomColor: t.cardBorder,
    borderBottomWidth: 1,
    backgroundColor: t.bg,
  },
  tabBar: {
    flexDirection: 'row',
    gap: 4,
    padding: 4,
    borderRadius: 12,
    backgroundColor: t.inset,
    borderWidth: 1,
    borderColor: t.cardBorder,
  },
  tabItem: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingVertical: 9,
    borderRadius: 9,
  },
  tabItemActive: {
    backgroundColor: t.card,
    borderWidth: 1,
    borderColor: t.cardBorder,
  },
  tabLabel: {
    color: t.textFaint,
    fontSize: 12,
    fontWeight: '700',
    letterSpacing: 0.3,
    fontFamily: mono,
  },
  tabLabelActive: { color: t.text },
  cardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
    marginBottom: 12,
  },
  cardHeaderText: {
    color: t.textDim,
    fontSize: 11,
    fontWeight: '800',
    letterSpacing: 1.2,
    fontFamily: mono,
  },
  cardGroup: { gap: 16 },
  accountBadges: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: 8,
    marginBottom: 12,
    minHeight: 26,
  },
  card: {
    backgroundColor: t.card,
    borderColor: t.cardBorder,
    borderWidth: 1,
    borderRadius: 12,
    padding: 14,
    marginBottom: 12,
  },
  emptyText: { color: t.textDim, fontSize: 13, lineHeight: 19 },
  emptyLink: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginTop: 12,
  },
  emptyLinkText: { color: t.blue, fontSize: 13, fontWeight: '600' },
  boxCard: {
    backgroundColor: t.card,
    borderColor: t.cardBorder,
    borderWidth: 1,
    borderRadius: 12,
    paddingVertical: 12,
    paddingHorizontal: 14,
    marginBottom: 8,
  },
  boxMain: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  boxDot: { width: 10, height: 10, borderRadius: 5 },
  boxBody: { flex: 1, minWidth: 0 },
  boxName: { color: t.text, fontSize: 15, fontWeight: '700', fontFamily: mono },
  activeTag: { color: t.blue, fontSize: 12, fontWeight: '700' },
  boxHost: { color: t.textFaint, fontSize: 12, fontFamily: mono, marginTop: 2 },
  chevron: {
    color: t.textFaint,
    fontSize: 12,
    fontWeight: '800',
    letterSpacing: 1,
    fontFamily: mono,
  },
  editPanel: {
    marginTop: 12,
    borderTopColor: t.cardBorder,
    borderTopWidth: 1,
    paddingTop: 14,
  },
  editSteps: { marginTop: 14 },
  smartTvWrap: { marginTop: 14 },
  editError: {
    color: t.red,
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
    color: t.textFaint,
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
    color: t.blue,
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
    color: t.textDim,
    fontSize: 11,
    fontWeight: '800',
    letterSpacing: 1,
    fontFamily: mono,
  },
  fieldLabel: {
    color: t.textFaint,
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 1.2,
    marginBottom: 6,
  },
  input: {
    backgroundColor: t.inset,
    borderColor: t.cardBorder,
    borderWidth: 1,
    borderRadius: 8,
    color: t.text,
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
  btnTest: { backgroundColor: t.inset, borderColor: t.blue, borderWidth: 1 },
  btnTestText: { color: t.blue, fontWeight: '800', fontSize: 13, letterSpacing: 1 },
  btnSave: { backgroundColor: t.blue },
  btnSaveText: { color: '#0b1220', fontWeight: '800', fontSize: 13, letterSpacing: 1 },
  rateRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    marginTop: 12,
    // `hint` below carries no margin of its own — it leans on the preceding
    // block's bottom margin, so this row has to provide it.
    marginBottom: 16,
    paddingVertical: 12,
    paddingHorizontal: 14,
    backgroundColor: t.card,
    borderColor: t.cardBorder,
    borderWidth: 1,
    borderRadius: 12,
  },
  rateBody: { flex: 1 },
  rateTitle: { color: t.text, fontSize: 14, fontWeight: '700' },
  rateSub: { color: t.textDim, fontSize: 11, marginTop: 2 },
  aboutRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginBottom: 4,
    paddingHorizontal: 2,
  },
  aboutText: { color: t.textDim, fontSize: 12 },
  unlockRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    marginHorizontal: 14,
    marginTop: 10,
    paddingVertical: 12,
    paddingHorizontal: 14,
    backgroundColor: t.card,
    borderColor: t.blue,
    borderWidth: 1,
    borderRadius: 12,
  },
  unlockRowBody: { flex: 1 },
  unlockRowTitle: { color: t.text, fontSize: 14, fontWeight: '800' },
  unlockRowSub: { color: t.textDim, fontSize: 11, marginTop: 2 },
  btnBuy: {
    backgroundColor: t.blue,
    borderRadius: 8,
    paddingVertical: 14,
    alignItems: 'center',
    marginBottom: 10,
  },
  btnBuyText: { color: '#0b1220', fontWeight: '800', fontSize: 13, letterSpacing: 1 },
  btnRestore: {
    backgroundColor: t.inset,
    borderColor: t.cardBorder,
    borderWidth: 1,
    borderRadius: 8,
    paddingVertical: 14,
    alignItems: 'center',
  },
  btnRestoreText: { color: t.textDim, fontWeight: '800', fontSize: 13, letterSpacing: 1 },
  restoreMsg: { fontSize: 12, fontFamily: mono, marginTop: 10 },
  purchaseHint: { color: t.textFaint, fontSize: 11, marginTop: 10 },
  pressed: { opacity: 0.7 },
  stepRow: { flexDirection: 'row', alignItems: 'flex-start', marginBottom: 10, gap: 10 },
  stepMark: { fontSize: 18, fontWeight: '800', width: 22, textAlign: 'center' },
  stepBody: { flex: 1 },
  stepLabel: { color: t.text, fontSize: 13, fontFamily: mono },
  stepDetail: { fontSize: 12, fontFamily: mono, marginTop: 3 },
  versionRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    borderTopColor: t.cardBorder,
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
  prefCol: { gap: 10 },
  prefLabel: { color: t.text, fontSize: 15, fontWeight: '600', fontFamily: mono },
  prefSub: { color: t.textFaint, fontSize: 12, marginTop: 3 },
  segRow: {
    flexDirection: 'row',
    gap: 2,
    padding: 2,
    borderRadius: 10,
    backgroundColor: t.inset,
  },
  seg: { flex: 1, paddingVertical: 10, borderRadius: 8, alignItems: 'center' },
  segActive: { backgroundColor: t.card },
  segText: { color: t.textDim, fontSize: 13, fontWeight: '700', fontFamily: mono },
  segTextActive: { color: t.text },
  accentRow: { flexDirection: 'row', gap: 12, flexWrap: 'wrap' },
  accentSwatch: {
    width: 30,
    height: 30,
    borderRadius: 15,
    borderWidth: 2,
    borderColor: 'transparent',
  },
  accentSwatchActive: { borderColor: t.text },
  versionLabel: { color: t.textDim, fontSize: 13 },
  versionValue: { color: t.green, fontSize: 13, fontFamily: mono, fontWeight: '700' },
  hint: { color: t.textFaint, fontSize: 12, lineHeight: 17, fontFamily: mono },

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
    backgroundColor: t.card,
    borderColor: t.cardBorder,
    borderWidth: 1,
    borderRadius: 16,
    padding: 20,
    alignItems: 'center',
  },
  qrTitle: {
    color: t.text,
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
    color: t.textDim,
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
    color: t.textFaint,
    fontSize: 11,
    fontFamily: mono,
  },
  qrFallbackToken: {
    color: t.textFaint,
    fontSize: 11,
    fontFamily: mono,
    marginTop: 2,
    maxWidth: '100%',
  },
  qrClose: {
    marginTop: 18,
    backgroundColor: t.inset,
    borderColor: t.cardBorder,
    borderWidth: 1,
    borderRadius: 8,
    paddingVertical: 12,
    paddingHorizontal: 32,
    alignItems: 'center',
  },
  qrCloseText: {
    color: t.textDim,
    fontWeight: '800',
    fontSize: 13,
    letterSpacing: 1,
    fontFamily: mono,
  },
});
