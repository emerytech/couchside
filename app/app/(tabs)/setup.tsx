import { createContext, useContext } from 'react';
import Ionicons from '@expo/vector-icons/Ionicons';
import * as Application from 'expo-application';
import Constants from 'expo-constants';
import * as Linking from 'expo-linking';
import { useLocalSearchParams, useRouter } from 'expo-router';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
import { AppUpdateRow } from '@/components/AppUpdateRow';
import { SystemUpdatesCard } from '@/components/SystemUpdatesCard';
import { Gated } from '@/components/Gated';
import { LogsPanel } from '@/components/LogsPanel';
import { QrView } from '@/components/QrView';
import { BoxScanPair } from '@/components/BoxScanPair';
import { GuideHoldSetup } from '@/components/GuideHoldSetup';
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
import { navigateAfterPair } from '@/lib/postPair';
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

// About-row app version. Read the NATIVE values — CFBundleShortVersionString /
// CFBundleVersion on iOS, versionName / versionCode on Android — because
// `expoConfig` is baked from app.json when the JS bundle is built and can lag
// the actual binary: a TestFlight build 46 install reported "build 45", which
// sent us chasing a phantom install problem. expoConfig is only a fallback
// (e.g. Expo Go, where the native values are the host app's).
//
// These come from expo-application. `Constants.nativeBuildVersion` does NOT
// exist in SDK 57 — expo-constants only carries a deprecation note pointing
// here — and reading it off Constants silently yields undefined (it typechecks
// only because those manifest types have a `Record<string, any>` index
// signature), which would quietly reinstate the very bug this fixes.
const APP_VERSION =
  Application.nativeApplicationVersion ?? Constants.expoConfig?.version ?? '—';
const APP_BUILD =
  Application.nativeBuildVersion ??
  (Platform.OS === 'ios'
    ? Constants.expoConfig?.ios?.buildNumber ?? ''
    : Constants.expoConfig?.android?.versionCode != null
      ? String(Constants.expoConfig.android.versionCode)
      : '');

// couchside.tv setup guide — how to install the agent on a box. New users who
// grabbed the app from a store land here with no idea a box-side agent exists.
const SETUP_GUIDE_URL = 'https://couchside.tv/#install';

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
      setAuthStep({ state: 'ok', detail: `${st.hostname} · service v${st.agent_version}` });
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

      <View style={styles.guideHoldWrap}>
        <GuideHoldSetup settings={box} />
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
/**
 * Prefs filtering.
 *
 * Lives in a context so a row does not have to be told about it: there are ~25
 * of them and threading a `query` prop through every one is the kind of
 * mechanical edit that silently misses two.
 *
 * A row matches on its label OR its sub-text. Sub-text matters -- "controller"
 * appears in several descriptions but only one label, and someone typing it
 * almost certainly means the description.
 */
/**
 * The live query, plus a way for a row to say "I matched".
 *
 * The counter exists because rows self-hide: nothing upstream can otherwise
 * tell an empty result from a rendering failure, and a query that matches
 * nothing used to leave the whole tab blank. The alternative -- a flat registry
 * of every pref's text, consulted to decide the same thing -- is the exact
 * duplication that let the three hand-rolled rows drift out of the filter in
 * the first place. A row that renders counts itself, so it cannot drift.
 */
type PrefFilter = { q: string; hit: () => void };
const PrefFilterCtx = createContext<PrefFilter>({ q: '', hit: () => {} });

function prefMatches(q: string, label: string, sub?: string): boolean {
  if (!q) return true;
  const n = (x: string) => x.toLowerCase().replace(/\s+/g, '');
  const needle = n(q);
  return n(label).includes(needle) || (!!sub && n(sub).includes(needle));
}

/**
 * Filter wrapper for a row that CANNOT be a TogglePref.
 *
 * Three rows own their control -- haptics buzzes on enable, accent is a swatch
 * strip, keep-awake drives a native lock -- so they stay hand-rolled. Without
 * this they matched EVERY query, because the filter only ever saw TogglePref
 * and SegPref: searching "keyboard" returned Haptic feedback, Accent and Keep
 * screen awake alongside the real hits, which reads as a broken search.
 *
 * `label` and `sub` must repeat the row's own visible text. That duplication is
 * the cost of not restructuring three working controls.
 */
function PrefFilterable({
  label,
  sub,
  children,
}: {
  label: string;
  sub?: string;
  children: React.ReactNode;
}) {
  const styles = useThemedStyles(makeStyles);
  const { q, hit } = useContext(PrefFilterCtx);
  if (!prefMatches(q, label, sub)) return null;
  hit();
  // Fragment when not filtering, so the normal layout is untouched; a spacing
  // host when filtering, because a fragment cannot carry a margin.
  if (!q) return <>{children}</>;
  return <View style={styles.prefHit}>{children}</View>;
}

export function TogglePref({
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
  const { q, hit } = useContext(PrefFilterCtx);
  if (!prefMatches(q, label, sub)) return null;
  hit();
  return (
    <View style={[styles.prefRow, q ? styles.prefHit : null]}>
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
export function SegPref<T extends string | number>({
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
  const { q, hit } = useContext(PrefFilterCtx);
  if (!prefMatches(q, label, sub)) return null;
  hit();
  return (
    <View style={[styles.prefCol, q ? styles.prefHit : null]}>
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
/**
 * Shown when a query matches nothing. Without it the body went completely
 * blank -- indistinguishable from the tab failing to render, and with no hint
 * that the text you typed is the reason.
 */
function PrefNoMatches({ query }: { query: string }) {
  const t = useTheme();
  const styles = useThemedStyles(makeStyles);
  return (
    <View style={styles.prefEmpty}>
      <Ionicons name="search-outline" size={18} color={t.textFaint} />
      <Text style={styles.prefEmptyText}>No settings match “{query}”.</Text>
    </View>
  );
}

function CardHeader({ icon, label }: { icon: IoniconName; label: string }) {
  const t = useTheme();
  const styles = useThemedStyles(makeStyles);
  // While a query is active the group headers go away: search results read as
  // one flat list, and a header left stranded above zero matching rows is
  // noise that makes the results look emptier than they are.
  const { q } = useContext(PrefFilterCtx);
  if (q) return null;
  return (
    <View style={styles.cardHeader}>
      <Ionicons name={icon} size={14} color={t.textDim} />
      <Text style={styles.cardHeaderText}>{label}</Text>
    </View>
  );
}

function SetupBody() {
  const [prefQuery, setPrefQuery] = useState('');
  const t = useTheme();
  const styles = useThemedStyles(makeStyles);
  // While a query is active the card chrome dissolves. Two things go wrong
  // without it: a card whose every row was filtered out still draws as an empty
  // bordered box, and the cards that DO have a hit chop the survivors into
  // separate panels. Either way the results look emptier and more scattered
  // than they are. Flat, the hits read as one list.
  // TRIMMED, everywhere. A query of only spaces used to be truthy here and
  // in the provider, so it flattened every card and hid every header while
  // prefMatches -- which strips whitespace -- went on matching everything.
  const prefFiltering = prefQuery.trim().length > 0;
  // Counted during render, read after commit. A ref rather than state because
  // incrementing state from a child's render body is a loop; the effect below
  // is the only thing that turns the count into UI, and setState bails when the
  // value is unchanged so it settles in one extra pass.
  const prefHits = useRef(0);
  prefHits.current = 0;
  const [prefNoMatch, setPrefNoMatch] = useState(false);
  const prefFilter = useMemo(
    () => ({ q: prefQuery.trim(), hit: () => { prefHits.current += 1; } }),
    [prefQuery],
  );
  useEffect(() => {
    setPrefNoMatch(prefFiltering && prefHits.current === 0);
  });
  const prefCardStyle = prefFiltering ? styles.prefFlat : styles.card;
  const prefCardGroupStyle = prefFiltering
    ? styles.prefFlat
    : [styles.card, styles.cardGroup];
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
  const landingTab = usePref('landingTab');
  const autoKeyboard = usePref('autoKeyboard');
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
  const keyboardMode = usePref('keyboardMode');
  const searchButtonSide = usePref('searchButtonSide');
  const volumeButtons = usePref('volumeButtons');
  const hideOfflineStreamHosts = usePref('hideOfflineStreamHosts');
  const hideDownloads = usePref('hideDownloads');
  const hideStreamFromPc = usePref('hideStreamFromPc');
  const hideTvVolume = usePref('hideTvVolume');
  const showTaps = usePref('showTaps');
  const traceDrags = usePref('traceDrags');

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
  // Scan + PIN is the primary way to add a box; the manual host/port/token card
  // is a collapsed "advanced" fallback (headless / cross-subnet / non-Linux).
  const [showManual, setShowManual] = useState(false);

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
          detail: `${st.hostname} · service v${st.agent_version}`,
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
    const added = await addBox({
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
    // Straight to the remote — see lib/postPair.ts. The "Saved" flag above is
    // still set so the confirmation is there if the user comes back to Setup.
    navigateAfterPair(added);
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
            <Text style={styles.unlockRowTitle}>
              Enjoying Couchside? Unlock for {price ?? '$4.99'}
            </Text>
            <Text style={styles.unlockRowSub}>
              {entitlement.trialDaysLeft > 0
                ? `Trial: ${entitlement.trialDaysLeft} day${
                    entitlement.trialDaysLeft === 1 ? '' : 's'
                  } left · one-time purchase, no subscription · supports the work`
                : 'Trial ended · one-time purchase, no subscription · supports the work'}
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
              No boxes yet. Tap Scan for boxes below — your box shows a PIN on its
              own screen and you type it here. No IP or token needed.
            </Text>
            {/* The box needs the agent installed before it can be paired at
                all — surface the setup guide right where a new user gets stuck. */}
            <Pressable
              onPress={() => {
                hapticLight();
                void Linking.openURL(SETUP_GUIDE_URL);
              }}
              style={({ pressed }) => [styles.emptyLink, pressed && styles.pressed]}>
              <Ionicons name="hardware-chip-outline" size={15} color={t.blue} style={styles.emptyLinkIcon} />
              <Text style={styles.emptyLinkText}>
                Haven&apos;t installed the Couchside service? Setup guide
              </Text>
              <Ionicons name="open-outline" size={13} color={t.blue} style={styles.emptyLinkIcon} />
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
        {/* Scan the LAN + PIN-pair (no IP/token typing) is the primary method.
            Hidden on builds without the UDP native module — the manual card then
            carries the whole flow. */}
        <View style={styles.card}>
          <BoxScanPair />
        </View>
        {/* Manual host/port/token: collapsed fallback for headless / cross-subnet
            / non-Linux boxes that scanning can't reach. */}
        <Pressable onPress={() => setShowManual((v) => !v)} style={styles.advancedToggle}>
          <Text style={styles.advancedToggleText}>Add by IP (advanced)</Text>
          <Ionicons name={showManual ? 'chevron-up' : 'chevron-down'} size={16} color={t.textDim} />
        </Pressable>
        {showManual ? (
        <>
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
              <Text style={styles.versionLabel}>service version</Text>
              <Text style={styles.versionValue}>{agentVersion}</Text>
            </View>
          )}
        </View>
        </>
        ) : null}
          </>
        )}

        {tab === 'prefs' && (
          <PrefFilterCtx.Provider value={prefFilter}>
            {/* Find-as-you-type. ~25 controls across six groups is past the
                point where scanning works, and half of them live in one card.
                Filtering beats reorganising here: it costs no navigation layer
                and hides nothing behind a tab you have to guess. */}
            <View style={styles.prefSearchWrap}>
              <Ionicons name="search" size={15} color={t.textDim} />
              <TextInput
                value={prefQuery}
                onChangeText={setPrefQuery}
                placeholder="Search settings"
                placeholderTextColor={t.textFaint}
                style={styles.prefSearchInput}
                autoCapitalize="none"
                autoCorrect={false}
                returnKeyType="search"
              />
              {prefQuery.length > 0 && (
                <Pressable
                  onPress={() => setPrefQuery('')}
                  hitSlop={10}
                  accessibilityLabel="Clear settings search">
                  <Ionicons name="close-circle" size={17} color={t.textDim} />
                </Pressable>
              )}
            </View>
            <View style={prefCardGroupStyle}>
              <CardHeader icon="options-outline" label="GENERAL" />
              <PrefFilterable
                label="Haptic feedback"
                sub="Vibration on taps, buttons, swipes, and actions.">
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
              </PrefFilterable>
              <TogglePref
                label="Hide the downloads card"
                sub="Removes the Steam downloads panel from the top of the Launch tab. Downloads keep running — this only hides the card."
                value={hideDownloads}
                onValueChange={(v) => {
                  void setPref('hideDownloads', v);
                  hapticSelection();
                }}
              />
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

            <View style={prefCardGroupStyle}>
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
              <PrefFilterable
                label="Accent"
                sub="The app&apos;s highlight color.">
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
              </PrefFilterable>
            </View>

            <View style={prefCardGroupStyle}>
              <CardHeader icon="game-controller-outline" label="INPUT & PAD" />
              <PrefFilterable
                label="Keep screen awake on Pad"
                sub="Hold the display on while the controller is open. Off saves battery.">
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
              </PrefFilterable>
              <SegPref
                label="Open on"
                sub="The tab the app starts on. Pairing wins on first run — with no box paired you still land on Setup."
                options={[
                  { value: 'index', label: 'Console' },
                  { value: 'actions', label: 'Actions' },
                  { value: 'pad', label: 'Pad' },
                  { value: 'launch', label: 'Launch' },
                ]}
                value={landingTab}
                onSelect={(v) => {
                  void setPref('landingTab', v);
                  hapticSelection();
                }}
              />
              <SegPref
                label="Default input mode"
                sub="The view the Pad tab opens on. Applies to the active box now, and seeds newly paired boxes."
                options={[
                  { value: 'gamepad', label: 'Pad' },
                  { value: 'swipe', label: 'Swipe' },
                  { value: 'trackpad', label: 'Track' },
                  { value: 'remote', label: 'Remote' },
                ]}
                value={defaultPadMode}
                onSelect={(v) => {
                  void setPref('defaultPadMode', v);
                  // The Pad tab reads the ACTIVE box's per-box padMode once a box
                  // is paired, so the pref alone changes nothing for existing
                  // boxes. Write it through so the setting takes effect live.
                  if (activeBoxId) void updateBox(activeBoxId, { padMode: v });
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
            <View style={prefCardStyle}>
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
              <SegPref
                label="Steam search button"
                sub="Opens Steam's search on the box and brings up your keyboard. Left by default — the right end of the bar is where your thumb rests, so it's easier to hit by accident there."
                options={[
                  { value: 'left', label: 'LEFT' },
                  { value: 'right', label: 'RIGHT' },
                  { value: 'off', label: 'OFF' },
                ]}
                value={searchButtonSide}
                onSelect={(v) => {
                  void setPref('searchButtonSide', v);
                  hapticSelection();
                }}
              />
              <TogglePref
                label="Send keys instead of a controller"
                sub="Steam navigates the same from arrow keys, and the box stops announcing a controller every time you connect — so a game already running can't lose player one to your phone. Swipe and Remote send keys; the Pad screen is hidden. Steam and QAM buttons need a controller, so they're not available. Needs the Couchside service 2.9.39 or newer."
                value={keyboardMode}
                onValueChange={(v) => {
                  void setPref('keyboardMode', v);
                  hapticSelection();
                }}
              />
              <TogglePref
                label="Ask before switching control"
                sub="When another phone joins a box you're controlling, it asks and you tap Pass — instead of taking over instantly. Needs the Couchside service 2.9.2 or newer."
                value={askToSwitchControl}
                onValueChange={(v) => {
                  void setPref('askToSwitchControl', v);
                  hapticSelection();
                }}
              />
              <TogglePref
                label="Open keyboard with the box"
                sub="When the box raises its own on-screen keyboard, raise this phone's too — so you can type or paste instead of picking letters with a d-pad. Needs a recent Couchside service."
                value={autoKeyboard}
                onValueChange={(v) => {
                  void setPref('autoKeyboard', v);
                  hapticSelection();
                }}
              />
              <TogglePref
                label="Hardware volume buttons"
                sub={
                  Platform.OS === 'ios'
                    ? "The phone's Vol +/- control the box/TV volume on any Pad tab surface. Experimental on iOS: the phone's volume overlay still shows and it only works with the app in front."
                    : "The phone's Vol +/- control the box/TV volume (box or TV, per box) on any Pad tab surface."
                }
                value={volumeButtons}
                onValueChange={(v) => {
                  void setPref('volumeButtons', v);
                  hapticSelection();
                }}
              />
              <TogglePref
                label="Hide the TV volume target"
                sub="Drops the Box/TV switch and always sends volume to the box. For setups where the box's own volume already drives the speakers — CEC forwarding, a soundbar or an AVR — and the TV target moves a level nothing plays through."
                value={hideTvVolume}
                onValueChange={(v) => {
                  void setPref('hideTvVolume', v);
                  hapticSelection();
                }}
              />
            </View>

            {/* The box's offline check is conservative and will sometimes call a
                live PC offline, so dimming is the default and hiding is opt-in. */}
            <View style={prefCardStyle}>
              <CardHeader icon="tv-outline" label="STREAM FROM PC" />
              <TogglePref
                label="Hide offline stream hosts"
                sub="Offline PCs are dimmed with the reason shown, and stay tappable. Turn this on to drop them from the Launch tab's stream list entirely."
                value={hideOfflineStreamHosts}
                onValueChange={(v) => {
                  void setPref('hideOfflineStreamHosts', v);
                  hapticSelection();
                }}
              />
              <TogglePref
                label="Hide this section"
                sub="Removes Stream from PC from the Launch tab. For setups where you'd never stream a game off another machine."
                value={hideStreamFromPc}
                onValueChange={(v) => {
                  void setPref('hideStreamFromPc', v);
                  hapticSelection();
                }}
              />
            </View>

            {/* Named for WHAT IT DOES, not for one use case. Recording is the
                motivating example, but these also make the swipe and trackpad
                surfaces legible live -- neither gives any visual feedback on its
                own -- and help on a support screen-share. Calling the card
                "SCREEN RECORDING" would hide it from anyone looking for the
                other two. */}
            <View style={prefCardStyle}>
              <CardHeader icon="hand-left-outline" label="TOUCH ANIMATIONS" />
              <TogglePref
                label="Show taps"
                sub="Draws a ring wherever you tap, so a screen recording shows what was pressed. iOS can't do this system-wide, so the app draws its own."
                value={showTaps}
                onValueChange={(v) => {
                  void setPref('showTaps', v);
                  hapticSelection();
                }}
              />
              <TogglePref
                label="Trace drags"
                sub="Draws a line along the path a finger travels, which makes swipe and trackpad gestures readable on video. Needs Show taps."
                value={traceDrags}
                onValueChange={(v) => {
                  void setPref('traceDrags', v);
                  hapticSelection();
                }}
              />
            </View>
            {prefNoMatch && <PrefNoMatches query={prefQuery.trim()} />}
          </PrefFilterCtx.Provider>
        )}

        {tab === 'account' && (
          <>
            <AgentUpdateBanner />
            {/* Phone-app update check (direct, anonymous) sits with the
                agent check; then the box-software card. */}
            <AppUpdateRow />
            <SystemUpdatesCard />
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
                  Install the Couchside service — instructions at couchside.tv.
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
              Each box&apos;s Couchside service listens on http://&lt;host&gt;:&lt;port&gt;. All routes except
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
  advancedToggle: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 12,
    paddingHorizontal: 4,
    marginTop: 4,
  },
  advancedToggleText: { color: t.textDim, fontSize: 13, fontWeight: '700' },
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
  prefSearchWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: t.card,
    borderColor: t.cardBorder,
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 9,
    marginBottom: 10,
  },
  prefSearchInput: { flex: 1, color: t.text, fontSize: 15, padding: 0 },
  cardHeaderText: {
    color: t.textDim,
    fontSize: 11,
    fontWeight: '800',
    letterSpacing: 1.2,
    fontFamily: mono,
  },
  cardGroup: { gap: 16 },
  // The card wrapper while a search query is active: no border, background,
  // padding or bottom margin, so a card with zero surviving rows takes ZERO
  // height instead of leaving an empty panel. Keeps the gap so adjacent hits
  // from different sections don't collide.
  prefFlat: {},
  // Spacing while filtering belongs to the visible ROW, not to the card that
  // contains it. A container `gap` only separates siblings INSIDE one card, so
  // two hits from different groups rendered flush against each other -- seen on
  // "taps", which matches Haptic feedback in GENERAL and Show taps in TOUCH
  // ANIMATIONS. Putting it on the row also means a card whose every row was
  // filtered out still contributes exactly zero height, which a marginBottom on
  // the card itself would not.
  prefHit: { marginBottom: 16 },
  prefEmpty: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingVertical: 24,
    paddingHorizontal: 4,
  },
  prefEmptyText: { color: t.textDim, fontSize: 13, flex: 1, minWidth: 0 },
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
    // flex-start, not center: once the label wraps to two lines, centred icons
    // float in the middle of the block instead of sitting on the first line.
    alignItems: 'flex-start',
    gap: 6,
    marginTop: 12,
  },
  // flex:1 is load-bearing. Without it the Text takes its INTRINSIC width, so a
  // label wider than the row pushes the trailing ↗ off the edge rather than
  // wrapping. It fit on iOS and overflowed on Android, which is exactly the
  // shape of bug that a single-platform check misses.
  // Aligns the glyphs with the first line of a wrapped label.
  emptyLinkIcon: { marginTop: 2 },
  emptyLinkText: {
    color: t.blue,
    fontSize: 13,
    fontWeight: '600',
    flex: 1,
    lineHeight: 18,
  },
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
  guideHoldWrap: { marginTop: 14 },
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
