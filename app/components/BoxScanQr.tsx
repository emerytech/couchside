/**
 * Scan the pairing QR with the phone's own camera — the in-app version of
 * pointing the system camera at the box's /pair screen, minus the detour
 * through Safari and couchside.tv. Owner's reference: Netflix's scanner
 * (full-bleed feed, four corner brackets, translucent bottom card).
 *
 * TRUST MODEL — why this is not a straight Netflix copy. Netflix's card says
 * "Your controller will open automatically": auto-apply, no questions. Their QR
 * resolves to Netflix-controlled infrastructure, so the worst a hostile code
 * can do is nothing. Ours literally says "here is a host to trust and a bearer
 * token to send it" — the app then opens a WebSocket to that host and polls it
 * forever. So every decode goes through parsePairLink (SCAN_FORMS — the camera
 * accepts ONLY the https form the agent emits), a hostile-but-valid code for a
 * box the user already owns must be CONFIRMED before its token is overwritten
 * (pairCollision), and the raw payload is never rendered, logged, or navigated
 * with. The reject copy explains without echoing.
 *
 * THE LATCH (load-bearing, do not simplify): onBarcodeScanned fires at FRAME
 * RATE while a code is in view. The SDK's internal 500 ms throttle only skips
 * byte-identical event JSON, and bounds/cornerPoints jitter every handheld
 * frame, so it never matches. A useState guard is too late — setState batches
 * while more frames land. The `locked` ref closes the door synchronously, and
 * flipping the callback to `undefined` sets the native barcodeScannerEnabled
 * prop false, tearing the analyzer down (verified in the SDK 57 source; the
 * iOS-only `active` prop is NOT that switch — Android ignores it).
 *
 * Camera is a NATIVE module: on a binary without it (an OTA bundle on an older
 * build) the trigger row renders nothing, mirroring lib/boxDiscovery's UDP
 * gate. Deliberately NOT gated off Platform.OS === 'web' — expo-camera has a
 * real web implementation, and the web harness pressing this control is the
 * §6 verification path.
 */
import Ionicons from '@expo/vector-icons/Ionicons';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  AppState,
  Linking,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from 'react-native';

import { hapticError, hapticSelection, hapticSuccess, hapticWarning } from '@/lib/haptics';
import {
  SCAN_FORMS,
  pairCollision,
  parsePairLink,
  type PairLink,
  type PairRejectReason,
} from '@/lib/pairLink';
import { navigateAfterPair } from '@/lib/postPair';
import { DEFAULT_PORT } from '@/lib/settings';
import { useBoxes } from '@/lib/SettingsContext';
import { useThemedStyles, type Palette } from '@/lib/theme';

// Lazy native-module gate — mirrors lib/boxDiscovery's UDP require. `null`
// hides the whole feature, so a JS bundle on an older binary degrades to
// "the row isn't there" instead of crashing at import (§3.7).
type CameraModule = {
  CameraView: React.ComponentType<Record<string, unknown>>;
  useCameraPermissions: () => [
    { granted: boolean; canAskAgain: boolean } | null,
    () => Promise<unknown>,
  ];
};
let Camera: CameraModule | null = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const m = require('expo-camera');
  Camera = m?.CameraView && m?.useCameraPermissions ? (m as CameraModule) : null;
} catch {
  Camera = null;
}

type Phase =
  | { k: 'scanning' }
  | { k: 'rejected'; reason: PairRejectReason }
  | { k: 'confirm'; link: PairLink; name: string }
  | { k: 'pairing' }
  | { k: 'done'; name: string }
  | { k: 'failed' };

/** Hold a reject banner long enough to read, then resume scanning. */
const REJECT_HOLD_MS = 2500;
/** Ignore re-decodes of the SAME rejected payload for this long, or the
 *  banner strobes at frame rate while the user holds the phone still. */
const SAME_REJECT_MS = 3000;
/** Let "Paired" land before the modal closes and the app navigates. */
const DONE_HOLD_MS = 600;
/** Show the step-closer hint if nothing has decoded yet. */
const HINT_AFTER_MS = 6000;

const REJECT_COPY: Record<PairRejectReason, { title: string; sub: string }> = {
  'store-code': {
    title: "That's the install code",
    sub: 'You already have the app. The pairing code is the big one, under "Pair your phone".',
  },
  'not-pair-link': {
    title: 'Not a Couchside pairing code',
    sub: "Scan the big code on your box's screen, under \"Pair your phone\".",
  },
  'bad-host': {
    title: 'That code points off your network',
    sub: "A Couchside code only ever names a box on your own network. This one doesn't, so it was ignored.",
  },
  'bad-port': {
    title: 'That code is damaged',
    sub: 'Part of it didn\'t read cleanly. Show the code again on the box and scan it once more.',
  },
  'bad-token': {
    title: 'That code is damaged',
    sub: 'Part of it didn\'t read cleanly. Show the code again on the box and scan it once more.',
  },
  'missing-host': {
    title: 'That code is damaged',
    sub: 'Part of it didn\'t read cleanly. Show the code again on the box and scan it once more.',
  },
  'missing-token': {
    title: 'That code is damaged',
    sub: 'Part of it didn\'t read cleanly. Show the code again on the box and scan it once more.',
  },
  'duplicate-param': {
    title: 'Not a Couchside pairing code',
    sub: "Scan the big code on your box's screen, under \"Pair your phone\".",
  },
  empty: {
    title: 'Not a Couchside pairing code',
    sub: "Scan the big code on your box's screen, under \"Pair your phone\".",
  },
  'too-long': {
    title: 'Not a Couchside pairing code',
    sub: "Scan the big code on your box's screen, under \"Pair your phone\".",
  },
};

export function BoxScanQr() {
  const styles = useThemedStyles(makeStyles);
  const [open, setOpen] = useState(false);

  // Native module absent (older binary running a newer OTA bundle): no row at
  // all — probe-and-appear, same as every capability-gated control.
  if (!Camera) return null;

  return (
    <>
      <Pressable
        onPress={() => {
          hapticSelection();
          setOpen(true);
        }}
        accessibilityRole="button"
        accessibilityLabel="Scan a pairing code"
        style={({ pressed }) => [styles.trigger, pressed && styles.pressed]}>
        <Ionicons name="qr-code-outline" size={16} color={styles.triggerText.color as string} />
        <Text style={styles.triggerText}>Scan a pairing code</Text>
      </Pressable>
      {open && <ScannerModal onClose={() => setOpen(false)} />}
    </>
  );
}

function ScannerModal({ onClose }: { onClose: () => void }) {
  const styles = useThemedStyles(makeStyles);
  const { width } = useWindowDimensions();
  const { boxes, addBox } = useBoxes();
  const cam = Camera as CameraModule;
  const { CameraView } = cam;
  const [permission, requestPermission] = cam.useCameraPermissions();

  const [phase, setPhase] = useState<Phase>({ k: 'scanning' });
  const [hint, setHint] = useState(false);

  // Synchronous latch — see the header. Closes on the first ACCEPTED decode,
  // before any await; resets only when scanning deliberately resumes.
  const locked = useRef(false);
  const lastReject = useRef<{ data: string; at: number }>({ data: '', at: 0 });
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const later = useCallback((fn: () => void, ms: number) => {
    timers.current.push(setTimeout(fn, ms));
  }, []);
  useEffect(() => () => timers.current.forEach(clearTimeout), []);

  // Backgrounding mid-scan: drop back to scanning with the latch open, so a
  // half-finished confirm can't act on stale state when the app returns.
  useEffect(() => {
    const sub = AppState.addEventListener('change', (s) => {
      if (s !== 'active') {
        locked.current = false;
        setPhase((p) => (p.k === 'pairing' || p.k === 'done' ? p : { k: 'scanning' }));
      }
    });
    return () => sub.remove();
  }, []);

  useEffect(() => {
    const t = setTimeout(() => setHint(true), HINT_AFTER_MS);
    return () => clearTimeout(t);
  }, []);

  const pair = useCallback(
    async (link: PairLink) => {
      setPhase({ k: 'pairing' });
      try {
        const added = await addBox({
          host: link.host,
          port: link.port,
          token: link.token,
          lastIp: link.ip,
        });
        // The success beat fires HERE, after the collision gate and the write
        // — not on decode. A success haptic before the one dialog that defends
        // the user primes them to tap through it.
        hapticSuccess();
        setPhase({ k: 'done', name: added.name });
        later(() => {
          onClose();
          navigateAfterPair(added);
        }, DONE_HOLD_MS);
      } catch {
        hapticError();
        setPhase({ k: 'failed' });
      }
    },
    [addBox, later, onClose],
  );

  const onScan = useCallback(
    ({ data }: { data: string }) => {
      if (locked.current) return;
      const parsed = parsePairLink(data, { forms: SCAN_FORMS, defaultPort: DEFAULT_PORT });

      if (!parsed.ok) {
        // No latch on a reject — the user may pan to the right code. Debounce
        // the identical payload instead. The reason is shown; the payload never.
        const now = Date.now();
        if (lastReject.current.data === data && now - lastReject.current.at < SAME_REJECT_MS) {
          return;
        }
        lastReject.current = { data, at: now };
        hapticWarning();
        setPhase({ k: 'rejected', reason: parsed.reason });
        later(() => {
          setPhase((p) => (p.k === 'rejected' ? { k: 'scanning' } : p));
        }, REJECT_HOLD_MS);
        return;
      }

      locked.current = true; // synchronous — closes the door on this tick
      const c = pairCollision(boxes, parsed.link);
      if (c.kind === 'token-change') {
        // A distinct, non-success beat: this is the one dialog defending the
        // user's working credential, and it must not arrive pre-approved.
        hapticWarning();
        setPhase({ k: 'confirm', link: parsed.link, name: c.name });
        return;
      }
      void pair(parsed.link);
    },
    [boxes, later, pair],
  );

  // Live only while a decode may be acted on. `undefined` flips the native
  // barcodeScannerEnabled prop off — a hard analyzer stop, not a dropped call.
  const live = phase.k === 'scanning' || phase.k === 'rejected';

  const RETICLE = Math.min(320, Math.max(220, Math.round(width * 0.68)));
  const ARM = Math.round(RETICLE * 0.22);

  let cardTitle: string;
  let cardSub: string | null = null;
  if (phase.k === 'rejected') {
    const c = REJECT_COPY[phase.reason];
    cardTitle = c.title;
    cardSub = c.sub;
  } else if (phase.k === 'confirm') {
    cardTitle = `Replace the key for ${phase.name}?`;
    cardSub =
      `That code carries a different key than the one saved for ${phase.name}. ` +
      'Replacing it is how you re-pair after the box was reset — but a code from ' +
      'anywhere else would break the box you already have.';
  } else if (phase.k === 'pairing') {
    cardTitle = 'Pairing…';
  } else if (phase.k === 'done') {
    cardTitle = `Paired ${phase.name}`;
    cardSub = 'Opening the remote.';
  } else if (phase.k === 'failed') {
    cardTitle = "Couldn't save that box";
    cardSub =
      "The code was good, but your phone's secure storage refused the write, so " +
      'nothing was stored. Close and reopen Couchside, then scan again.';
  } else {
    cardTitle = 'Center the pairing code';
    cardSub = hint
      ? 'Not reading? Step closer until the code fills the brackets, or move a little to one side to get the room\'s reflection off the screen.'
      : "The big code on your box's screen, under \"Pair your phone\".";
  }

  const bracketColor =
    phase.k === 'failed'
      ? '#f87171'
      : phase.k === 'rejected'
        ? '#fbbf24'
        : phase.k === 'scanning'
          ? '#ffffff'
          : '#34d399';

  const perm = permission; // null on first render — the doc's own guard
  return (
    <Modal visible transparent={false} animationType="slide" onRequestClose={onClose}>
      <View style={styles.scanRoot}>
        {perm?.granted ? (
          <CameraView
            style={StyleSheet.absoluteFill}
            facing="back"
            // Explicit: omitting barcodeTypes silently disables scanning on web.
            barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
            onBarcodeScanned={live ? onScan : undefined}
          />
        ) : (
          <PermissionGate
            perm={perm}
            request={requestPermission}
            styles={styles}
          />
        )}

        {/* Reticle — DECORATIVE: SDK 57 exposes no scan region, the detector
            reads the whole frame. The brackets are aim guidance, nothing else.
            CameraView cannot take children, so everything overlays as siblings. */}
        {perm?.granted && (
          <View
            pointerEvents="none"
            style={styles.reticleWrap}
            accessibilityElementsHidden
            importantForAccessibility="no-hide-descendants">
            <View style={{ width: RETICLE, height: RETICLE }}>
              <View style={[styles.corner, styles.tl, { width: ARM, height: ARM, borderColor: bracketColor }]} />
              <View style={[styles.corner, styles.tr, { width: ARM, height: ARM, borderColor: bracketColor }]} />
              <View style={[styles.corner, styles.bl, { width: ARM, height: ARM, borderColor: bracketColor }]} />
              <View style={[styles.corner, styles.br, { width: ARM, height: ARM, borderColor: bracketColor }]} />
            </View>
          </View>
        )}

        {/* Back chevron, 44pt target, over the feed. */}
        <Pressable
          onPress={onClose}
          accessibilityRole="button"
          accessibilityLabel="Back"
          accessibilityHint="Returns to Setup without pairing"
          style={({ pressed }) => [styles.backBtn, pressed && styles.pressed]}>
          <Ionicons name="chevron-back" size={28} color="#ffffff" />
        </Pressable>

        {/* Bottom card — the Netflix element: glyph, bold title, lighter sub. */}
        {perm?.granted && (
          <View style={styles.cardWrap} accessible accessibilityLiveRegion="polite">
            <View style={styles.scanCard}>
              <Ionicons name="qr-code" size={22} color="#ffffff" style={styles.cardGlyph} />
              <Text style={styles.cardTitle}>{cardTitle}</Text>
              {cardSub != null && <Text style={styles.cardSub}>{cardSub}</Text>}
              {phase.k === 'confirm' && (
                <View style={styles.confirmRow}>
                  <Pressable
                    onPress={() => {
                      hapticSelection();
                      locked.current = false;
                      setPhase({ k: 'scanning' });
                    }}
                    accessibilityRole="button"
                    style={({ pressed }) => [styles.confirmBtn, pressed && styles.pressed]}>
                    <Text style={styles.confirmBtnText}>KEEP MINE</Text>
                  </Pressable>
                  <Pressable
                    onPress={() => void pair(phase.link)}
                    accessibilityRole="button"
                    style={({ pressed }) => [styles.confirmBtn, styles.confirmDanger, pressed && styles.pressed]}>
                    <Text style={[styles.confirmBtnText, styles.confirmDangerText]}>REPLACE KEY</Text>
                  </Pressable>
                </View>
              )}
              {phase.k === 'failed' && (
                <Pressable
                  onPress={() => {
                    hapticSelection();
                    locked.current = false;
                    setPhase({ k: 'scanning' });
                  }}
                  accessibilityRole="button"
                  style={({ pressed }) => [styles.confirmBtn, styles.scanAgain, pressed && styles.pressed]}>
                  <Text style={styles.confirmBtnText}>SCAN AGAIN</Text>
                </Pressable>
              )}
            </View>
          </View>
        )}
      </View>
    </Modal>
  );
}

function PermissionGate({
  perm,
  request,
  styles,
}: {
  perm: { granted: boolean; canAskAgain: boolean } | null;
  request: () => Promise<unknown>;
  styles: ReturnType<typeof makeStyles>;
}) {
  if (!perm) return <View style={styles.scanRoot} />; // hook still resolving

  const deniedForever = !perm.canAskAgain;
  return (
    <View style={[styles.scanRoot, styles.permWrap]}>
      <Ionicons name="camera-outline" size={40} color="#8b97ad" />
      <Text style={styles.permTitle}>Couchside needs the camera</Text>
      <Text style={styles.permSub}>
        {deniedForever
          ? Platform.OS === 'ios'
            ? "iOS won't ask again from inside the app — turn on Camera for Couchside in Settings, then come back."
            : "Android won't ask again from inside the app — turn on Camera for Couchside in Settings (Permissions → Camera), then come back."
          : 'Only to read the pairing code on your box\'s screen. Nothing is recorded, and no image leaves your phone.'}
      </Text>
      <Pressable
        onPress={() => {
          hapticSelection();
          if (deniedForever) void Linking.openSettings();
          else void request();
        }}
        accessibilityRole="button"
        style={({ pressed }) => [styles.permBtn, pressed && styles.pressed]}>
        <Text style={styles.permBtnText}>{deniedForever ? 'OPEN SETTINGS' : 'ALLOW CAMERA'}</Text>
      </Pressable>
    </View>
  );
}

const makeStyles = (t: Palette) =>
  StyleSheet.create({
    // Trigger row inside the ADD / PAIR card. styles.card has no `gap`.
    trigger: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 8,
      marginTop: 10,
      minHeight: 44,
      borderRadius: 10,
      borderWidth: 1,
      borderColor: t.cardBorder,
      backgroundColor: t.inset,
    },
    triggerText: { color: t.blue, fontSize: 13, fontWeight: '700' },
    pressed: { opacity: 0.7 },

    // Scanner surface. Literal colours over a live feed, not theme tokens —
    // the feed is not themed, and the card must hold AA over a white TV frame.
    scanRoot: { flex: 1, backgroundColor: '#000000' },
    reticleWrap: {
      position: 'absolute',
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      alignItems: 'center',
      justifyContent: 'center',
    },
    corner: { position: 'absolute' },
    tl: { top: 0, left: 0, borderTopWidth: 4, borderLeftWidth: 4, borderTopLeftRadius: 16 },
    tr: { top: 0, right: 0, borderTopWidth: 4, borderRightWidth: 4, borderTopRightRadius: 16 },
    bl: { bottom: 0, left: 0, borderBottomWidth: 4, borderLeftWidth: 4, borderBottomLeftRadius: 16 },
    br: { bottom: 0, right: 0, borderBottomWidth: 4, borderRightWidth: 4, borderBottomRightRadius: 16 },
    backBtn: {
      position: 'absolute',
      top: 56,
      left: 12,
      width: 44,
      height: 44,
      alignItems: 'center',
      justifyContent: 'center',
    },
    cardWrap: {
      position: 'absolute',
      left: 16,
      right: 16,
      bottom: 40,
      alignItems: 'center',
    },
    scanCard: {
      alignSelf: 'stretch',
      alignItems: 'center',
      borderRadius: 16,
      paddingVertical: 18,
      paddingHorizontal: 20,
      backgroundColor: 'rgba(11,18,32,0.72)',
    },
    cardGlyph: { marginBottom: 8 },
    cardTitle: {
      color: '#ffffff',
      fontSize: 17,
      fontWeight: '700',
      textAlign: 'center',
    },
    cardSub: {
      color: 'rgba(229,236,248,0.75)',
      fontSize: 13,
      lineHeight: 18,
      textAlign: 'center',
      marginTop: 6,
    },
    confirmRow: { flexDirection: 'row', gap: 10, marginTop: 14 },
    confirmBtn: {
      minHeight: 44,
      paddingHorizontal: 18,
      alignItems: 'center',
      justifyContent: 'center',
      borderRadius: 10,
      borderWidth: 1,
      borderColor: 'rgba(255,255,255,0.35)',
    },
    confirmBtnText: { color: '#ffffff', fontSize: 13, fontWeight: '700' },
    confirmDanger: { borderColor: '#f87171' },
    confirmDangerText: { color: '#f87171' },
    scanAgain: { marginTop: 14 },

    // Permission gate — no feed behind it, so theme-ish darks are fine.
    permWrap: { alignItems: 'center', justifyContent: 'center', padding: 32, gap: 12 },
    permTitle: { color: '#e5ecf8', fontSize: 17, fontWeight: '700', textAlign: 'center' },
    permSub: {
      color: '#8b97ad',
      fontSize: 13,
      lineHeight: 19,
      textAlign: 'center',
    },
    permBtn: {
      marginTop: 8,
      minHeight: 44,
      paddingHorizontal: 22,
      alignItems: 'center',
      justifyContent: 'center',
      borderRadius: 10,
      borderWidth: 1,
      borderColor: t.blue,
    },
    permBtnText: { color: t.blue, fontSize: 13, fontWeight: '700' },
  });
