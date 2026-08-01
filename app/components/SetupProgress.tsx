/**
 * The no-box empty state, as a card that ADVANCES ITSELF.
 *
 * WHY IT EXISTS (measured): in the first six days after launch ~9-15 strangers
 * downloaded the app and ~0 got an agent paired. The app is useless without the
 * box-side agent and a store download gives no hint one exists, so the old empty
 * state — a paragraph and two links to a website — was the whole funnel.
 *
 * WHAT MAKES IT WORK: the agent binds at the MIDPOINT of install.sh, ~850 lines
 * before the terminal prints its QR. So the phone can say "found your box" while
 * the installer is still scrolling, with the user standing at their PC. That is
 * the moment the funnel dies and the one this card is engineered for: it sweeps
 * the LAN on its own and flips the instant /api/ping answers, before the user
 * has typed anything.
 *
 * SECURITY MODEL (do not "fix" the asymmetry): /api/ping, /api/pair/start and
 * /api/pair/finish are unauthenticated and LAN-reachable — that IS the
 * zero-terminal path. /pair and /api/pair/status are loopback-only, so the phone
 * can never read the PIN: /api/pair/start pops it FULL-SCREEN ON THE BOX'S OWN
 * TV and returns only {ok, ttl}. Physical presence is the proof and the secret
 * never crosses the network. This card needs NO new agent endpoint and no new
 * /api/ping field — it is app-only.
 *
 * NO REANIMATED. State changes are the feedback. An animation here would buy a
 * pulse and cost the whole animation-verification trap surface (rAF runs at 0fps
 * in the web harness), on the one screen whose behaviour most needs proving.
 *
 * Every DECISION lives in lib/setupPhase.ts and is unit-tested on bare Node
 * (lib/__tests__/setupPhase.test.ts). This file owns effects and pixels only.
 */
import Ionicons from '@expo/vector-icons/Ionicons';
import * as Linking from 'expo-linking';
import * as Network from 'expo-network';
import { useFocusEffect } from 'expo-router';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  AppState,
  type AppStateStatus,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import { ApiError, pairFinish, pairStart } from '@/lib/api';
import { scanForBoxes, selfIp, type FoundBox } from '@/lib/boxDiscovery';
import { hapticLight, hapticSelection, hapticSuccess } from '@/lib/haptics';
import { navigateAfterPair } from '@/lib/postPair';
import { useBoxes } from '@/lib/SettingsContext';
import {
  maySweep,
  DIAGNOSE_AFTER_MS,
  formatCountdown,
  netVerdict,
  nextPhase,
  stepMarks,
  sweepPolicy,
  ttlRemaining,
  type NetFacts,
  type SetupEvent,
  type SetupPhase,
  type StepMark,
  type SetupBox,
} from '@/lib/setupPhase';
import { useTheme, useThemedStyles, type Palette } from '@/lib/theme';

/**
 * couchside.tv setup guide — how to install the agent on a box. New users who
 * grabbed the app from a store land here with no idea a box-side agent exists.
 * Lives here rather than in setup.tsx because this card is the primary consumer;
 * setup.tsx imports it (one direction only — the reverse would be a cycle).
 */
export const SETUP_GUIDE_URL = 'https://couchside.tv/#install';

/** The four steps, in the order a new user actually performs them.
 *
 * Step 1 used to read "switch to Desktop Mode and open a terminal". That
 * imperative presumes you are IN Game Mode, which is true on a Deck and false
 * on every desktop Linux box — CachyOS, Nobara, Pop!_OS, plain systemd — all of
 * which README.md sells to and which are already sitting at a desktop. It sent
 * those users hunting for a toggle their machine does not have, on the first
 * line of the first screen. ("Desktop Mode" itself is fine as a noun; the app
 * uses it for any non-gamescope session in RemotePowerBar. It was the verb.)
 *
 * Text here is not load-bearing: stepMarks() keys off the array INDEX. */
const STEPS = [
  'On your PC, open a terminal. (On a Steam Deck or in Game Mode, switch to Desktop Mode first.)',
  'Open couchside.tv and run the install command.',
  'Watch this screen — it updates by itself.',
  'A PIN appears on your TV. Type it here.',
];

export function SetupProgress() {
  const t = useTheme();
  const styles = useThemedStyles(makeStyles);
  const { addBox } = useBoxes();

  const [phase, setPhase] = useState<SetupPhase>({ k: 'idle' });
  const [pin, setPin] = useState('');
  /** Client-side note that must NOT change phase — e.g. a short PIN, which the
   *  agent would count as one of its five attempts. */
  const [hint, setHint] = useState<string | null>(null);
  const [subnet, setSubnet] = useState<string | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());

  const mounted = useRef(true);
  const phaseRef = useRef<SetupPhase>(phase);
  /** Set by the search effect while this screen is focused; null otherwise. */
  const ctl = useRef<{ start: () => void; stop: () => void } | null>(null);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  /**
   * The ref is the authority, the state is the mirror.
   *
   * setState is not synchronous, so a handler that dispatches and then asks the
   * loop to restart would have the loop read the PREVIOUS phase and refuse to
   * run. Reducing off the ref makes every dispatch immediately visible to the
   * async code that has to make a decision on it. Safe because nextPhase is
   * pure and dispatch is only ever called from handlers and effects, never
   * during render.
   */
  const dispatch = useCallback((e: SetupEvent) => {
    const n = nextPhase(phaseRef.current, e);
    phaseRef.current = n;
    setPhase(n);
  }, []);

  // ---------------------------------------------------------------------
  // The search loop
  // ---------------------------------------------------------------------
  // Runs ONLY while: this screen is focused (useFocusEffect), the app is active
  // (AppState), and the phase is still looking. The component itself is rendered
  // only when the fleet is empty, which is the third condition from the spec —
  // and is also why any box found here is new *to this phone*, the only sense of
  // "new" that matters (the agent has no first-run flag to ask about).
  useFocusEffect(
    useCallback(() => {
      let gen = 0;
      let timer: ReturnType<typeof setTimeout> | null = null;
      let ac: AbortController | null = null;
      let startedAt = 0;
      let appActive = AppState.currentState === 'active' || AppState.currentState == null;

      const stop = () => {
        gen++; // invalidates any cycle currently suspended in an await
        if (timer) {
          clearTimeout(timer);
          timer = null;
        }
        if (ac) {
          // Synchronous: a worker suspended in pingHost resumes, sees aborted,
          // and exits. Without this ~254 fetches keep running after a blur.
          ac.abort();
          ac = null;
        }
      };

      const cycle = async (g: number) => {
        const live = () => g === gen && mounted.current && appActive;
        if (!live()) return;
        // Never sweep once the user has COMMITTED to a box (tapped Pair now).
        // `found` is not commitment — more boxes may still be out there, and
        // stopping there is what hid them.
        if (!maySweep(phaseRef.current)) return;

        // 1. Is a sweep even meaningful from here? Answered from facts only —
        //    there is no API that reports iOS Local Network permission, so the
        //    card never claims to know that (see netVerdict).
        const facts: NetFacts = {};
        try {
          const st = await Network.getNetworkStateAsync();
          facts.networkType = st?.type != null ? String(st.type) : undefined;
          facts.isConnected = st?.isConnected;
        } catch {
          // Unknown network type is not a verdict; fall through to the IP test.
        }
        try {
          facts.selfIp = await selfIp();
        } catch {
          facts.selfIp = undefined;
        }
        if (!live()) return;
        const v = netVerdict(facts);
        if (v.k !== 'sweepable') {
          setSubnet(null);
          // Terminal for the loop: it will not fix itself by sweeping harder.
          // The user gets an explicit "Try again" back to idle.
          dispatch({ t: 'NO_NET', verdict: v });
          return;
        }
        setSubnet(v.subnet);

        if (startedAt === 0) startedAt = Date.now();
        dispatch({ t: 'SWEEP_START', now: startedAt });
        if (sweepPolicy(Date.now() - startedAt).giveUp) {
          dispatch({ t: 'GIVE_UP' });
          return;
        }

        ac = new AbortController();
        try {
          const boxes = await scanForBoxes({
            timeoutMs: 3000,
            signal: ac.signal,
            // THE POINT OF THE WHOLE FEATURE: fired the instant a host answers,
            // seconds before the sweep drains.
            onFound: (b: FoundBox) => {
              if (!live()) return;
              // Report it and KEEP SWEEPING. This used to abort the remaining
              // ~250 probes on the first hit, on the reasoning that the card
              // commits to one box — which is exactly the bug: whichever box
              // answered first won, and a user with a PC and a Steam Deck was
              // shown the PC with no hint the Deck existed. Sweep timing is not
              // intent. The reducer now accumulates, so let the sweep finish
              // and let the user choose.
              dispatch({ t: 'FOUND', box: b });
            },
          });
          if (!live()) return;
          // The resolved array is authoritative on completion; a FOUND that no
          // longer applies is identity in the reducer, so this cannot clobber a
          // PIN the user is already typing.
          if (boxes.length > 0) {
            // EVERY box, not boxes[0]. The resolved array is authoritative on
            // completion, and onFound may have missed a late responder; the
            // reducer dedupes by ip, so re-reporting one already seen is free.
            // Sending only the first is how the card used to hide the rest.
            for (const b of boxes) dispatch({ t: 'FOUND', box: b });
          } else {
            dispatch({ t: 'SWEEP_EMPTY' });
          }
        } catch {
          if (!live()) return;
          // A scan that threw found nothing. Never a stuck spinner. SWEEP_EMPTY
          // is identity unless the phase is `looking`, so this cannot wipe
          // boxes already on screen from an earlier sweep.
          dispatch({ t: 'SWEEP_EMPTY' });
        } finally {
          ac = null;
        }

        // Keep sweeping even with boxes already found — another may appear.
        // maySweep() (read from the phase, which the reducer owns) is the only
        // thing that stops this, and it stops at `starting`: the user choosing.
        if (!live() || !maySweep(phaseRef.current)) return;
        const next = sweepPolicy(Date.now() - startedAt);
        if (next.giveUp) {
          dispatch({ t: 'GIVE_UP' });
          return;
        }
        timer = setTimeout(() => void cycle(g), next.delayMs);
      };

      /** Begin (or resume) searching, with a FRESH give-up budget. Coming back
       *  to a focused Setup tab, or back into the app, is the user asking again
       *  — the five minutes are there to stop background battery burn, not to
       *  refuse someone who is standing right there watching. */
      const start = () => {
        stop();
        startedAt = 0;
        void cycle(gen);
      };

      ctl.current = { start, stop };

      const sub = AppState.addEventListener('change', (s: AppStateStatus) => {
        const nowActive = s === 'active';
        if (nowActive === appActive) return;
        appActive = nowActive;
        if (appActive) start();
        else stop();
      });
      if (appActive) start();

      return () => {
        stop();
        sub.remove();
        ctl.current = null;
      };
    }, [dispatch]),
  );

  // ---------------------------------------------------------------------
  // PIN countdown
  // ---------------------------------------------------------------------
  const expiresAt =
    phase.k === 'pin' || phase.k === 'pairing' || phase.k === 'failed' ? phase.expiresAt : 0;

  useEffect(() => {
    if (expiresAt <= 0) return;
    setNowMs(Date.now());
    const id = setInterval(() => {
      const n = Date.now();
      setNowMs(n);
      if (n >= expiresAt) clearInterval(id); // stop at zero; never count negative
    }, 1000);
    return () => clearInterval(id);
  }, [expiresAt]);

  const secsLeft = expiresAt > 0 ? ttlRemaining(expiresAt, nowMs) : 0;

  // ---------------------------------------------------------------------
  // Handlers. Every one of them sets a terminal phase in BOTH the ok and the
  // catch branch (BoxScanPair's rule), and there is always a path back.
  // ---------------------------------------------------------------------

  // `pick` names the box when the user chose one from a multi-box list; a retry
  // from `pin`/`failed` passes nothing and reuses the box already in flight.
  const startPair = useCallback(async (pick?: SetupBox) => {
    const p = phaseRef.current;
    if (p.k !== 'found' && p.k !== 'pin' && p.k !== 'failed') return;
    const box = pick ?? (p.k === 'found' ? p.boxes[0] : p.box);
    if (!box) return;
    hapticSelection();
    ctl.current?.stop(); // stop sweeping the moment the user commits to a box
    setHint(null);
    setPin('');
    dispatch({ t: 'START_PIN', box });
    try {
      const r = await pairStart(box.ip, box.port);
      if (!mounted.current) return;
      if (r.ok) {
        // Drive the countdown off the RETURNED ttl: inside the agent's 3 s
        // start-debounce it hands back the LIVE pairing's remaining seconds,
        // not a fresh 120.
        dispatch({
          t: 'START_OK',
          ttl: typeof r.ttl === 'number' && r.ttl > 0 ? r.ttl : 120,
          now: Date.now(),
        });
      } else if (r.error === 'unauthorized') {
        // An agent predating PIN pairing answers 401 here, and unauthPost
        // resolves that body rather than throwing. Printing "unauthorized" at a
        // user would be verbatim and useless.
        dispatch({ t: 'UNSUPPORTED' });
      } else {
        dispatch({ t: 'START_ERR', msg: r.error ?? 'That box would not start pairing.' });
      }
    } catch (e: unknown) {
      if (!mounted.current) return;
      dispatch({
        t: 'START_ERR',
        msg: e instanceof ApiError ? e.message : 'Could not reach that box.',
      });
    }
  }, [dispatch]);

  const submitPin = useCallback(async () => {
    const p = phaseRef.current;
    if (p.k !== 'pin' && p.k !== 'failed') return;
    const box = p.box;
    const code = pin.trim();
    if (code.length !== 6) {
      // Deliberately NOT a phase change: the agent counts a wrong PIN against a
      // hard limit of five, and a half-typed one must never spend an attempt.
      setHint('Enter the 6-digit PIN from the box.');
      return;
    }
    setHint(null);
    dispatch({ t: 'SUBMIT' });
    try {
      const r = await pairFinish(box.ip, box.port, code);
      if (!mounted.current) return;
      if (r.ok && r.token) {
        // addBox gets its OWN try/catch: it THROWS when its pairing-host
        // allowlist refuses the discovered host, and by then the agent has
        // CONSUMED the PIN. Folding that into the outer catch would report
        // "could not reach that box" — a lie, about an unrecoverable state.
        try {
          // No userTypedHost: a discovered host is machine-supplied by
          // definition and must pass the allowlist in addBox.
          const added = await addBox({
            host: box.host,
            port: r.port ?? box.port,
            token: r.token,
            lastIp: box.ip,
          });
          if (!mounted.current) return;
          dispatch({ t: 'PAIR_OK' });
          hapticSuccess();
          navigateAfterPair(added); // straight to the remote — lib/postPair.ts
        } catch (e: unknown) {
          if (!mounted.current) return;
          dispatch({
            t: 'PAIR_ERR',
            dead: true, // the PIN is spent server-side; no countdown may survive
            msg: `${e instanceof Error ? e.message : String(e)}. Add this box with "Scan a pairing code" or "Add by IP" below.`,
          });
        }
        return;
      }
      // FINDING 1 (HIGH). Two of the agent's three failures mean the session is
      // GONE server-side — both agents do `PAIR_PIN = None` before raising
      // "no active pairing …" and "too many wrong PINs …". Without marking those
      // dead, the card carried `expiresAt` forward and kept rendering "A 6-digit
      // PIN is on <box>'s screen. Expires in 1:03." over a PIN that no longer
      // exists, with the input live and PAIR enabled — every press guaranteed to
      // fail. The flagship scenario hits this: the installer restarting the
      // agent mid-pair (PAIR_PIN is an in-memory global) lands on "no active
      // pairing" while the countdown runs on.
      //
      // Matching on the message is safe HERE and only here: the two substrings
      // below are identical in both agents and contain no dash, so the em-dash
      // vs hyphen difference the note at the render site warns about cannot
      // bite. The agent's own string is still what the user is SHOWN — this
      // only decides whether the countdown dies with it.
      const spent = /too many wrong PINs|no active pairing/i.test(r.error ?? '');
      dispatch({
        t: 'PAIR_ERR',
        dead: spent,
        msg: r.error ?? 'Pairing failed — check the PIN and retry.',
      });
    } catch (e: unknown) {
      if (!mounted.current) return;
      dispatch({
        t: 'PAIR_ERR',
        msg: e instanceof ApiError ? e.message : 'Could not reach that box.',
      });
    }
  }, [pin, addBox, dispatch]);

  /** Back to the found box without losing it (no re-scan needed). */
  const back = useCallback(() => {
    hapticLight();
    setPin('');
    setHint(null);
    dispatch({ t: 'BACK' });
  }, [dispatch]);

  /** Resume searching: from stalled ("Keep looking") or a network verdict. */
  const keepLooking = useCallback(() => {
    hapticLight();
    dispatch({ t: 'KEEP_LOOKING', now: Date.now() });
    ctl.current?.start();
  }, [dispatch]);

  /** The explicit path back to idle from a box the user does not want — the
   *  wrong machine answered, or its agent is too old to PIN-pair. */
  const searchAgain = useCallback(() => {
    hapticLight();
    setPin('');
    setHint(null);
    dispatch({ t: 'RESET' });
    ctl.current?.start();
  }, [dispatch]);

  const openGuide = useCallback(() => {
    hapticLight();
    void Linking.openURL(SETUP_GUIDE_URL);
  }, []);

  const openSettings = useCallback(() => {
    hapticLight();
    void Linking.openSettings();
  }, []);

  // ---------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------
  const marks = stepMarks(phase);
  const elapsed =
    phase.k === 'looking' || phase.k === 'stalled' ? Math.max(0, Date.now() - phase.since) : 0;
  const showDiagnosis =
    (phase.k === 'looking' && elapsed >= DIAGNOSE_AFTER_MS) || phase.k === 'stalled';

  return (
    <View style={styles.card}>
      {(phase.k === 'idle' ||
        phase.k === 'looking' ||
        phase.k === 'stalled' ||
        phase.k === 'nonet') && (
        <>
          <Text style={styles.lead}>
            Couchside needs a small service running on the box you want to control. It takes about
            a minute.
          </Text>
          <View style={styles.steps}>
            {STEPS.map((label, i) => (
              <StepLine key={label} n={i + 1} label={label} mark={marks[i]} />
            ))}
          </View>
        </>
      )}

      {phase.k === 'looking' && !showDiagnosis && (
        <View style={styles.statusRow}>
          <ActivityIndicator size="small" color={t.blue} />
          <Text style={styles.statusText}>
            {subnet
              ? `Looking for your box on ${subnet}… leave this open, it updates by itself.`
              : 'Looking for your box…'}
          </Text>
        </View>
      )}

      {/* The honest not-finding-anything state. There is NO API in Expo SDK 57
          that reports iOS Local Network permission, and RN's fetch collapses a
          denial, a timeout and a dead host into one identical TypeError — so the
          card offers a differential diagnosis instead of claiming to know which
          it is. It is also better copy: the likeliest reason by far is that the
          installer simply has not finished yet. */}
      {showDiagnosis && (
        <View style={styles.diag}>
          <Text style={styles.diagTitle}>
            {phase.k === 'stalled'
              ? `Stopped looking${subnet ? ` on ${subnet}` : ''} to save battery.`
              : `Still nothing${subnet ? ` on ${subnet}` : ''}. Usually one of:`}
          </Text>
          <Text style={styles.diagItem}>
            · the installer has not finished on your PC yet — keep this open
          </Text>
          <Text style={styles.diagItem}>
            · your phone is on a different network from your box (guest Wi-Fi, or the other band
            on a mesh router)
          </Text>
          <Text style={styles.diagItem}>
            · this phone is blocking local-network access for Couchside
          </Text>
          <View style={styles.btnRow}>
            {phase.k === 'stalled' && (
              <Pressable
                onPress={keepLooking}
                accessibilityRole="button"
                accessibilityLabel="Keep looking for a box"
                style={({ pressed }) => [styles.btn, styles.btnPrimary, pressed && styles.pressed]}>
                <Text style={styles.btnPrimaryText}>KEEP LOOKING</Text>
              </Pressable>
            )}
            <Pressable
              onPress={openSettings}
              accessibilityRole="button"
              accessibilityLabel="Open this app's system settings"
              style={({ pressed }) => [styles.btn, styles.btnGhost, pressed && styles.pressed]}>
              <Text style={styles.btnGhostText}>OPEN SETTINGS</Text>
            </Pressable>
          </View>
        </View>
      )}

      {/* Facts, not guesses: these two are actually knowable. */}
      {phase.k === 'nonet' && (
        <View style={styles.diag}>
          <Text style={styles.diagTitle}>
            {phase.verdict.k === 'offline'
              ? 'This phone has no network connection, so there is nothing to search.'
              : phase.verdict.k === 'cellular'
                ? 'This phone is on mobile data. Join the same Wi-Fi as your box and the search starts again.'
                : 'This phone has no local-network address, so there is no network to search.'}
          </Text>
          <View style={styles.btnRow}>
            <Pressable
              onPress={keepLooking}
              accessibilityRole="button"
              accessibilityLabel="Try searching again"
              style={({ pressed }) => [styles.btn, styles.btnPrimary, pressed && styles.pressed]}>
              <Text style={styles.btnPrimaryText}>TRY AGAIN</Text>
            </Pressable>
          </View>
        </View>
      )}

      {/* THE PAYOFF. Can fire while the installer is still scrolling. */}
      {phase.k === 'found' && (
        <View style={styles.foundWrap}>
          {/* ONE box: unchanged — the payoff moment this card was built around.
              A name, a button, no decision. MORE than one: a short list, because
              announcing "Found <name>" for whichever answered the sweep first is
              a claim we cannot back. Which box answers first is timing, not
              intent, and a user with a Deck and a PC was shown the PC. */}
          {phase.boxes.length === 1 ? (
            <>
              <View style={styles.foundRow}>
                <Ionicons name="checkmark-circle" size={20} color={t.green} />
                <View style={styles.foundBody}>
                  <Text style={styles.foundName} numberOfLines={1}>
                    Found {phase.boxes[0].name}
                  </Text>
                  <Text style={styles.foundMeta} numberOfLines={1}>
                    {phase.boxes[0].ip} · service v{phase.boxes[0].version || '?'}
                  </Text>
                </View>
              </View>
              <View style={styles.btnRow}>
                <Pressable
                  onPress={searchAgain}
                  accessibilityRole="button"
                  accessibilityLabel="Not this box — search again"
                  style={({ pressed }) => [styles.btn, styles.btnGhost, pressed && styles.pressed]}>
                  <Text style={styles.btnGhostText}>NOT THIS ONE</Text>
                </Pressable>
                <Pressable
                  onPress={() => void startPair(phase.boxes[0])}
                  accessibilityRole="button"
                  accessibilityLabel={`Pair with ${phase.boxes[0].name}`}
                  style={({ pressed }) => [styles.btn, styles.btnPrimary, pressed && styles.pressed]}>
                  <Text style={styles.btnPrimaryText}>PAIR NOW</Text>
                </Pressable>
              </View>
            </>
          ) : (
            <>
              <View style={styles.foundRow}>
                <Ionicons name="checkmark-circle" size={20} color={t.green} />
                <View style={styles.foundBody}>
                  <Text style={styles.foundName}>
                    Found {phase.boxes.length} boxes
                  </Text>
                  <Text style={styles.foundMeta}>Pick the one you just set up.</Text>
                </View>
              </View>
              {phase.boxes.map((b) => (
                <Pressable
                  key={b.ip}
                  onPress={() => void startPair(b)}
                  accessibilityRole="button"
                  accessibilityLabel={`Pair with ${b.name} at ${b.ip}`}
                  style={({ pressed }) => [styles.pickRow, pressed && styles.pressed]}>
                  <Ionicons name="hardware-chip-outline" size={18} color={t.blue} />
                  <View style={styles.foundBody}>
                    <Text style={styles.pickName} numberOfLines={1}>{b.name}</Text>
                    <Text style={styles.foundMeta} numberOfLines={1}>
                      {b.ip} · service v{b.version || '?'}
                    </Text>
                  </View>
                  <Ionicons name="chevron-forward" size={16} color={t.textFaint} />
                </Pressable>
              ))}
            </>
          )}
          <Text style={styles.foundHint}>
            The box will show a 6-digit PIN on its own screen. Nothing is sent until you type it.
          </Text>
        </View>
      )}

      {/* Agent too old for PIN pairing — route to the paths that DO work rather
          than to an input that would 404. */}
      {phase.k === 'unsupported' && (
        <View style={styles.diag}>
          <Text style={styles.diagTitle}>
            Found {phase.box.name} at {phase.box.ip}, but its Couchside service (v
            {phase.box.version || '?'}) is too old to show a PIN.
          </Text>
          <Text style={styles.diagItem}>
            · update the service on the box, then tap Try again
          </Text>
          <Text style={styles.diagItem}>
            · or pair it now with &quot;Scan a pairing code&quot; or &quot;Add by IP&quot; below
          </Text>
          <View style={styles.btnRow}>
            <Pressable
              onPress={searchAgain}
              accessibilityRole="button"
              accessibilityLabel="Search again for a box"
              style={({ pressed }) => [styles.btn, styles.btnGhost, pressed && styles.pressed]}>
              <Text style={styles.btnGhostText}>TRY AGAIN</Text>
            </Pressable>
          </View>
        </View>
      )}

      {phase.k === 'starting' && (
        <View style={styles.statusRow}>
          <ActivityIndicator size="small" color={t.blue} />
          <Text style={styles.statusText}>Asking {phase.box.name} to show a PIN…</Text>
        </View>
      )}

      {(phase.k === 'pin' || phase.k === 'pairing' || phase.k === 'failed') && (
        <View style={styles.pinWrap}>
          <Text style={styles.statusText}>
            {/* Three states, not two (FINDING 2, HIGH). "expired" may only be
                said about a PIN that was actually SHOWN — `failed` from
                START_ERR is the pairStart-never-succeeded path, where nothing
                ever appeared on the TV. Printing "The PIN has expired" there,
                next to "Could not reach that box", made two contradictory
                claims about the same moment and sent the user to look at a
                blank screen. */}
            {secsLeft > 0
              ? `A 6-digit PIN is on ${phase.box.name}'s screen. Expires in ${formatCountdown(secsLeft)}.`
              : phase.k === 'failed' && !phase.shown
                ? `No PIN was shown on ${phase.box.name}.`
                : `The PIN on ${phase.box.name} has expired.`}
          </Text>
          <TextInput
            value={pin}
            onChangeText={(v) => setPin(v.replace(/[^0-9]/g, '').slice(0, 6))}
            placeholder="6-digit PIN"
            placeholderTextColor={t.textFaint}
            keyboardType="number-pad"
            accessibilityLabel="6-digit PIN from the box"
            editable={phase.k !== 'pairing' && secsLeft > 0}
            autoFocus
            style={styles.input}
          />
          {hint && <Text style={styles.err}>{hint}</Text>}
          {/* The agent's OWN string, verbatim — "wrong PIN", "no active pairing
              - start it again from the app", "too many wrong PINs - start
              again". Never matched on: Linux uses an em dash where Windows uses
              a hyphen. */}
          {phase.k === 'failed' && <Text style={styles.err}>{phase.msg}</Text>}
          <View style={styles.btnRow}>
            <Pressable
              onPress={back}
              disabled={phase.k === 'pairing'}
              accessibilityRole="button"
              accessibilityLabel="Cancel PIN entry"
              style={({ pressed }) => [styles.btn, styles.btnGhost, pressed && styles.pressed]}>
              <Text style={styles.btnGhostText}>CANCEL</Text>
            </Pressable>
            {secsLeft > 0 ? (
              <Pressable
                onPress={() => void submitPin()}
                disabled={phase.k === 'pairing'}
                accessibilityRole="button"
                accessibilityLabel="Submit the PIN and pair"
                style={({ pressed }) => [
                  styles.btn,
                  styles.btnPrimary,
                  (pressed || phase.k === 'pairing') && styles.pressed,
                ]}>
                {phase.k === 'pairing' ? (
                  <ActivityIndicator size="small" color={t.bg} />
                ) : (
                  <Text style={styles.btnPrimaryText}>PAIR</Text>
                )}
              </Pressable>
            ) : (
              /* At zero the old PIN is dead server-side; retrying it can only
                 fail, so the only forward move is a fresh one. */
              <Pressable
                onPress={() => void startPair()}
                accessibilityRole="button"
                accessibilityLabel="Show a new PIN on the box"
                style={({ pressed }) => [styles.btn, styles.btnPrimary, pressed && styles.pressed]}>
                <Text style={styles.btnPrimaryText}>SHOW A NEW PIN</Text>
              </Pressable>
            )}
          </View>
        </View>
      )}

      {phase.k === 'paired' && (
        <View style={styles.statusRow}>
          <Ionicons name="checkmark-circle" size={20} color={t.green} />
          <Text style={styles.statusText}>Paired {phase.box.name}.</Text>
        </View>
      )}

      {/* The escape hatch, kept verbatim from the empty state this replaces: the
          box needs the agent installed before it can be paired at all. */}
      <Pressable
        onPress={openGuide}
        accessibilityRole="button"
        accessibilityLabel="Open the Couchside setup guide"
        style={({ pressed }) => [styles.emptyLink, pressed && styles.pressed]}>
        <Ionicons
          name="hardware-chip-outline"
          size={15}
          color={t.blue}
          style={styles.emptyLinkIcon}
        />
        <Text style={styles.emptyLinkText}>
          Haven&apos;t installed the Couchside service? Setup guide
        </Text>
        <Ionicons name="open-outline" size={13} color={t.blue} style={styles.emptyLinkIcon} />
      </Pressable>
    </View>
  );
}

/**
 * One onboarding step. Same structure as setup.tsx's StepRow (mark + label) but
 * deliberately NOT its style: that one is monospaced because it reports
 * diagnostics from a connection test, and four human-facing onboarding steps in
 * a diagnostic typeface read as an error log. It is also module-private there,
 * and importing it would make setup.tsx <-> SetupProgress a cycle.
 */
function StepLine({ n, label, mark }: { n: number; label: string; mark: StepMark }) {
  const t = useTheme();
  const styles = useThemedStyles(makeStyles);
  const glyph = mark === 'done' ? '✓' : mark === 'active' ? '…' : String(n);
  const color = mark === 'done' ? t.green : mark === 'active' ? t.blue : t.textFaint;
  return (
    <View style={styles.stepRow}>
      <Text style={[styles.stepMark, { color }]}>{glyph}</Text>
      <Text style={[styles.stepLabel, mark === 'todo' && styles.stepLabelDim]}>{label}</Text>
    </View>
  );
}

const makeStyles = (t: Palette) =>
  StyleSheet.create({
    // Values copied verbatim from setup.tsx's `card` so this sits IN the screen
    // rather than on it (that factory is module-private and not importable).
    card: {
      backgroundColor: t.card,
      borderColor: t.cardBorder,
      borderWidth: 1,
      borderRadius: 12,
      padding: 14,
      marginBottom: 12,
    },
    lead: { color: t.textDim, fontSize: 13, lineHeight: 19 },
    steps: { marginTop: 12, gap: 10 },
    stepRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 10 },
    stepMark: { fontSize: 14, fontWeight: '800', width: 18, textAlign: 'center', lineHeight: 19 },
    stepLabel: { color: t.text, fontSize: 13, lineHeight: 19, flex: 1 },
    stepLabelDim: { color: t.textDim },
    statusRow: { flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 14 },
    statusText: { color: t.textDim, fontSize: 13, lineHeight: 19, flex: 1 },
    diag: { marginTop: 14, gap: 6 },
    diagTitle: { color: t.text, fontSize: 13, lineHeight: 19 },
    diagItem: { color: t.textDim, fontSize: 12.5, lineHeight: 18 },
    err: { color: t.red, fontSize: 13, lineHeight: 18 },
    foundWrap: { marginTop: 14, gap: 10 },
    foundRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
    foundBody: { flex: 1 },
    foundName: { color: t.text, fontSize: 15, fontWeight: '700' },
    foundMeta: { color: t.textDim, fontSize: 12, marginTop: 1 },
    foundHint: { color: t.textFaint, fontSize: 12, lineHeight: 17 },
    pinWrap: { marginTop: 14, gap: 10 },
    input: {
      backgroundColor: t.inset,
      borderColor: t.cardBorder,
      borderWidth: StyleSheet.hairlineWidth,
      borderRadius: 10,
      paddingHorizontal: 12,
      paddingVertical: 11,
      color: t.text,
      fontSize: 18,
      letterSpacing: 4,
    },
    btnRow: { flexDirection: 'row', gap: 10, marginTop: 4 },
    btn: {
      flex: 1,
      borderRadius: 10,
      paddingVertical: 11,
      minHeight: 44,
      alignItems: 'center',
      justifyContent: 'center',
    },
    btnPrimary: { backgroundColor: t.blue },
    btnPrimaryText: { color: t.bg, fontWeight: '800', fontSize: 13 },
    btnGhost: { backgroundColor: t.inset },
    btnGhostText: { color: t.textDim, fontWeight: '700', fontSize: 13 },
    emptyLink: {
      flexDirection: 'row',
      // flex-start, not center: once the label wraps to two lines, centred icons
      // float in the middle of the block instead of sitting on the first line.
      alignItems: 'flex-start',
      gap: 6,
      marginTop: 14,
    },
    // Aligns the glyphs with the first line of a wrapped label.
    emptyLinkIcon: { marginTop: 2 },
    // flex:1 is load-bearing. Without it the Text takes its INTRINSIC width, so
    // a label wider than the row pushes the trailing ↗ off the edge rather than
    // wrapping. It fit on iOS and overflowed on Android, which is exactly the
    // shape of bug that a single-platform check misses.
    emptyLinkText: { color: t.blue, fontSize: 13, fontWeight: '600', flex: 1, lineHeight: 18 },
    pickRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 10,
      minHeight: 52,
      paddingHorizontal: 12,
      marginTop: 8,
      borderRadius: 10,
      borderWidth: 1,
      borderColor: t.cardBorder,
      backgroundColor: t.inset,
    },
    pickName: { color: t.text, fontSize: 14, fontWeight: '600' },
    pressed: { opacity: 0.7 },
  });
