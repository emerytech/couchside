/**
 * WatchDpad — a swipe pad for driving the page open in the Couchside Player
 * (Netflix/YouTube tile grids, and any web page's focus ring).
 *
 * WHY THIS EXISTS: streaming UIs are spatial grids you navigate with a remote,
 * not by scrolling. Before this, the Watch panel could only launch a service
 * and then abandon it — you could not move between tiles from the couch.
 *
 * WHY SWIPES, NOT BUTTONS: owner feedback once the arrow buttons worked —
 * swiping is the natural phone gesture for "move one tile", and a tap beats
 * hunting for an OK button mid-scroll. Gestures map onto the same verbs the
 * buttons used:
 *
 *   swipe left/right -> one focus step along the row
 *   swipe up/down    -> one spatial step between rows
 *   tap              -> OK (enter)
 *   two-finger tap   -> Back (esc), same convention as the trackpad's
 *                       two-finger right-click; a visible Back button stays
 *                       for discoverability
 *
 * The step engine is lib/swipeSteps.planSteps — the unit-tested planner the
 * Pad's swipe mode uses (first step cheap, repeats expensive, so a flick moves
 * ONE tile and a deliberate drag walks several; dominant axis wins so a
 * diagonal never fires both).
 *
 * HOW IT WORKS: the agent exposes a token-authed, hold-gated uinput keyboard on
 * /ws/gamepad, so this reuses GamepadClient.sendKey() exactly like the desktop
 * keyboard does. uinput delivers a REAL, trusted key event to whatever the
 * compositor has focused — the Player tile's fullscreen Chrome — so the page's
 * own key handler responds. (A synthetic CDP KeyboardEvent would be
 * isTrusted:false and Netflix ignores it; that is why this path, not CDP.)
 *
 * WHICH KEYS — MEASURED, NOT ASSUMED (2026-08-17, reference box, real sites,
 * each run carrying a control key whose answer was already known):
 *
 *   netflix.com   right/down -> focus UNCHANGED     tab -> Mima to pokemonRhyott
 *   youtube.com   right/down -> focus UNCHANGED     tab -> "Skip navigation" to
 *                                                          "Search with voice"
 *
 * Arrow-key grid navigation is a TV-APP behaviour; the WEB versions of these
 * services ignore arrows entirely and move their focus ring on Tab. So:
 *
 *   left / right -> Shift+Tab / Tab   walk the focus ring ALONG a row
 *   up / down    -> navup / navdown   a SPATIAL focus step between rows
 *   OK           -> enter             activates whatever now has focus
 *   Back         -> esc
 *
 * Up/down cannot be keys. Tab is linear, so from the middle of a row it would
 * have to walk every remaining tile to reach the row below, and arrow keys only
 * scroll the viewport on these sites — the focus ring stays put. The agent's
 * navup/navdown ops instead pick the nearest focusable element above/below
 * geometrically (agent >= 2.9.95). Verified on the real Netflix browse grid:
 * down walked More Info -> Netflix Minigolf -> The Last House -> Walter Boys and
 * up retraced it; OK then opened that title's detail modal, proving the focus
 * those ops set is REAL focus a genuine key activates.
 *
 * Shift+Tab needs agent >= 2.9.95 (the `shifttab` chord). An older agent does
 * not merely ignore an unknown key name — it errors and CLOSES the session — so
 * the back-direction button feature-detects via client.supportsKey() and falls
 * back to a plain arrow rather than risking the socket.
 *
 * We connect with noPad:true so the agent never materialises a virtual Xbox pad
 * for this session (which would make Steam announce a controller). Keys only
 * flow while this session HOLDS control; if another device holds, the panel
 * offers Take control, mirroring the Pad tab's handoff.
 */
import React, { useEffect, useRef, useState } from 'react';
import {
  AppState,
  PanResponder,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useNavigation } from 'expo-router';

import { api } from '@/lib/api';
import { GamepadClient, GamepadStatus, SpecialKey } from '@/lib/gamepad';
import { hapticLight } from '@/lib/haptics';
import { usePref } from '@/lib/prefs';
import { planSteps, type StepDir, type StepState } from '@/lib/swipeSteps';
import { useThemedStyles, type Palette } from '@/lib/theme';
import type { Settings } from '@/lib/settings';

/** Movement under this (px) within TAP_MS is a tap, not a swipe. Matches the
 *  Pad's swipe surface. */
const TAP_SLOP = 10;
const TAP_MS = 350;

/** Names this device to the current holder's Pass/Keep prompt. Matches pad.tsx. */
const DEVICE_LABEL =
  Platform.OS === 'ios' ? 'iPhone' : Platform.OS === 'android' ? 'Android phone' : 'A device';

/** How long to wait on a silent holder before offering a forced takeover. */
const FORCE_AFTER_MS = 20_000;

export function WatchDpad({
  settings,
  ready,
  navOps,
  onGestureActive,
}: {
  settings: Settings;
  ready: boolean;
  /** PlayerState.nav_ops — which spatial steps this box accepts. */
  navOps?: string[];
  /**
   * Fires true while a touch is on the swipe pad, false when it ends. The
   * parent ScrollView must set scrollEnabled={false} during it — a native
   * scroll otherwise steals every vertical drag from the pad's PanResponder,
   * turning "swipe down a row" into "scroll the panel".
   */
  onGestureActive?: (active: boolean) => void;
}) {
  const styles = useThemedStyles(makeStyles);
  const navigation = useNavigation();

  // Same handoff preference the Pad uses: ask-to-pass vs grab. Read through a
  // ref so flipping it never re-runs the connection effect (which keys on the
  // connection identity only).
  const askToSwitch = usePref('askToSwitchControl');
  const askRef = useRef(askToSwitch);
  askRef.current = askToSwitch;

  const [status, setStatus] = useState<GamepadStatus>('closed');
  const [holder, setHolder] = useState<string | null>(null);
  const [canForce, setCanForce] = useState(false);

  const clientRef = useRef<GamepadClient | null>(null);
  if (clientRef.current == null) clientRef.current = new GamepadClient();
  const client = clientRef.current;

  const settingsRef = useRef(settings);
  settingsRef.current = settings;

  // Connection lifecycle, mirrored from pad.tsx: connect on mount and on tab
  // focus, disconnect on blur/unmount and when backgrounded, so a key can never
  // leak to the box while the user is on another tab. connect() is idempotent;
  // an idle socket sends nothing, so holding it open while a page is up is free.
  useEffect(() => {
    if (!ready) return undefined;

    client.onStatus((s, d) => {
      setStatus(s);
      setHolder(d);
      if (s !== 'waiting') setCanForce(false);
    });

    const connect = () =>
      client.connect(settingsRef.current, {
        handoffAsk: askRef.current,
        deviceName: DEVICE_LABEL,
        noPad: true, // never create a virtual gamepad — we only send key frames
      });
    const disconnect = () => client.close();

    const offFocus = navigation.addListener('focus', connect);
    const offBlur = navigation.addListener('blur', disconnect);
    const appSub = AppState.addEventListener('change', (state) => {
      if (state === 'active') {
        connect();
        client.ensureLive();
      } else disconnect();
    });

    connect();

    return () => {
      offFocus();
      offBlur();
      appSub.remove();
      disconnect();
      client.onStatus(null);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- connection identity
    // only; settingsRef/askRef carry the rest without re-running.
  }, [client, ready, settings.host, settings.port, settings.token, navigation]);

  // A holder who never answers (walked away / app backgrounded) shouldn't block
  // forever: after a grace period, offer to force the takeover.
  useEffect(() => {
    if (status !== 'waiting') return undefined;
    const t = setTimeout(() => setCanForce(true), FORCE_AFTER_MS);
    return () => clearTimeout(t);
  }, [status]);

  const holding = status === 'connected';

  /** Send without haptic — the gesture path fires ONE haptic per move event,
   *  never one per step; per-step ticks flooded iOS's feedback queue on the Pad
   *  and were the best-motivated suspect for a JS stall (see pad.tsx). */
  const pressQuiet = (key: SpecialKey) => {
    if (!holding) return;
    client.sendKey(key);
  };

  const press = (key: SpecialKey) => {
    hapticLight();
    pressQuiet(key);
  };

  /**
   * Walk the page's focus ring. Forward is Tab everywhere; backward needs the
   * Shift+Tab chord (agent >= 2.9.95). Against an older agent that name would
   * close the session, so fall back to a plain Left arrow — which does nothing
   * on Netflix/YouTube but is harmless, and still scrolls pages that respond to
   * arrows. Checked at press time, not mount: the socket may reconnect to a
   * different box while the panel is open.
   */
  const focusStep = (forward: boolean) => {
    if (forward) return pressQuiet('tab');
    return pressQuiet(client.supportsKey('shifttab') ? 'shifttab' : 'left');
  };

  /**
   * Vertical step. Rides the agent's spatial nav op when the box offers it,
   * else falls back to an arrow key — which on these sites only scrolls, but is
   * the most a pre-2.9.95 box can do and is never harmful.
   *
   * Fire-and-forget: a failed step is not worth an error banner (the common
   * "failure" is simply having reached the last row), and the d-pad must stay
   * responsive to rapid presses rather than serialising on a round trip.
   */
  const canNav = (op: 'navup' | 'navdown') => navOps?.includes(op) === true;
  const vertical = (down: boolean) => {
    const op = down ? 'navdown' : 'navup';
    if (!canNav(op)) return pressQuiet(down ? 'down' : 'up');
    api.playerOp(settings, op).catch(() => {});
  };

  /** One gesture step from the planner onto the right verb. */
  const stepDir = (d: StepDir) => {
    if (d === 'dl') focusStep(false);
    else if (d === 'dr') focusStep(true);
    else if (d === 'du') vertical(false);
    else vertical(true);
  };
  const stepRef = useRef(stepDir);
  stepRef.current = stepDir;
  // press() closes over `holding`; the once-created responder must see the
  // live version, not the first render's. Same for the gesture-active signal.
  const pressRef = useRef(press);
  pressRef.current = press;
  const gestureRef = useRef<(active: boolean) => void>(() => {});
  gestureRef.current = onGestureActive ?? (() => {});

  // Swipe surface. planSteps is the Pad's unit-tested planner: first step
  // cheap, repeats expensive, dominant axis wins. The responder is created
  // once; live state reaches it through refs.
  const track = useRef({
    consumedX: 0,
    consumedY: 0,
    stepped: false,
    moved: false,
    twoFinger: false,
    t0: 0,
  });
  const sens = usePref('swipeSensitivity');
  const sensRef = useRef(sens);
  sensRef.current = sens;

  const responder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderGrant: () => {
        gestureRef.current(true);
        track.current = {
          consumedX: 0,
          consumedY: 0,
          stepped: false,
          moved: false,
          twoFinger: false,
          t0: Date.now(),
        };
      },
      onPanResponderMove: (_evt, g) => {
        const t = track.current;
        // A second finger at ANY point marks the gesture two-finger; checked on
        // move because Grant often fires before the second finger lands.
        if (g.numberActiveTouches >= 2) t.twoFinger = true;
        if (!t.moved && Math.hypot(g.dx, g.dy) > TAP_SLOP) t.moved = true;
        if (t.twoFinger) return; // two-finger = Back on release, never steps
        const plan = planSteps(g.dx, g.dy, t as StepState, sensRef.current);
        t.consumedX = plan.next.consumedX;
        t.consumedY = plan.next.consumedY;
        t.stepped = plan.next.stepped;
        for (const d of plan.dirs) stepRef.current(d);
        // ONE haptic per move event, never per step — a fast swipe emits a
        // burst, and per-step selectionAsync() floods iOS's feedback queue
        // (measured on the Pad; see pad.tsx SwipeSurface).
        if (plan.dirs.length > 0) hapticLight();
      },
      onPanResponderRelease: () => {
        gestureRef.current(false);
        const t = track.current;
        if (t.moved || Date.now() - t.t0 >= TAP_MS) return;
        // Tap: one finger = OK, two fingers = Back (the trackpad's two-finger
        // right-click convention, answering "how do we do the back button").
        if (t.twoFinger) pressRef.current('esc');
        else pressRef.current('enter');
      },
      // A parent stealing the gesture (edge-swipe, navigation) just cancels
      // it — steps already sent are single presses, nothing latches. Still must
      // re-enable the parent's scroll.
      onPanResponderTerminate: () => {
        gestureRef.current(false);
      },
      onPanResponderTerminationRequest: () => false,
    }),
  ).current;

  const takeControl = () => {
    hapticLight();
    const s = client.getStatus();
    if (s === 'waiting') {
      if (canForce) client.forceControl();
      else client.requestControl();
    } else if (s === 'released') {
      client.requestControl();
    } else {
      // replaced / closed / error / connecting: re-dial and grab (this tap is an
      // explicit "I want to drive now", so don't ask).
      client.connect(settingsRef.current, {
        handoffAsk: false,
        deviceName: DEVICE_LABEL,
        noPad: true,
      });
    }
  };

  // Not holding control: show who does and a way to take it, instead of a live
  // d-pad whose presses the box would silently drop.
  if (!holding) {
    const waiting = status === 'connecting' || status === 'closed';
    return (
      <View style={styles.wrap} testID="watch-dpad">
        <Text style={styles.title}>NAVIGATE</Text>
        <View style={styles.handoff}>
          <Text style={styles.handoffText} numberOfLines={2}>
            {waiting
              ? 'Connecting to the box…'
              : holder
                ? `${holder} has the controller.`
                : 'Another device has the controller.'}
          </Text>
          {!waiting && (
            <Pressable
              onPress={takeControl}
              testID="watch-dpad-take"
              style={({ pressed }) => [styles.takeBtn, pressed && styles.pressed]}
            >
              <Text style={styles.takeText}>
                {status === 'waiting' && canForce ? 'Take control now' : 'Take control'}
              </Text>
            </Pressable>
          )}
        </View>
      </View>
    );
  }

  return (
    <View style={styles.wrap} testID="watch-dpad">
      <Text style={styles.title}>NAVIGATE</Text>

      {/* Swipe surface: flick left/right = one step along the row, up/down =
          one row; tap = OK; two-finger tap = Back. */}
      <View style={styles.swipePad} testID="watch-dpad-swipe" {...responder.panHandlers}>
        <Text style={styles.swipeGlyph}>✦</Text>
        <Text style={styles.swipeHint}>swipe to move · tap for OK</Text>
      </View>

      <Pressable
        onPress={() => press('esc')}
        testID="watch-dpad-back"
        style={({ pressed }) => [styles.backBtn, pressed && styles.pressed]}
      >
        <Text style={styles.backText}>Back</Text>
      </Pressable>

      <Text style={styles.hint}>
        swipe ◀ ▶ along a row · ▲ ▼ between rows · tap selects · two-finger tap
        or Back exits
      </Text>
    </View>
  );
}

const makeStyles = (t: Palette) =>
  StyleSheet.create({
    wrap: {
      gap: 8,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: t.cardBorder,
      paddingTop: 12,
      alignItems: 'center',
    },
    title: {
      color: t.textFaint,
      fontSize: 11,
      fontWeight: '700',
      letterSpacing: 1.2,
      alignSelf: 'stretch',
    },
    swipePad: {
      alignSelf: 'stretch',
      height: 168,
      alignItems: 'center',
      justifyContent: 'center',
      gap: 6,
      borderRadius: 12,
      backgroundColor: t.inset,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: t.cardBorder,
    },
    swipeGlyph: { color: t.textFaint, fontSize: 22 },
    swipeHint: { color: t.textFaint, fontSize: 12 },
    backBtn: {
      marginTop: 2,
      paddingHorizontal: 22,
      paddingVertical: 10,
      borderRadius: 10,
      backgroundColor: t.inset,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: t.cardBorder,
    },
    backText: { color: t.text, fontSize: 13, fontWeight: '600' },
    hint: { color: t.textFaint, fontSize: 11, textAlign: 'center' },
    pressed: { opacity: 0.6 },
    handoff: {
      alignSelf: 'stretch',
      flexDirection: 'row',
      alignItems: 'center',
      gap: 12,
      paddingVertical: 4,
    },
    handoffText: { color: t.textDim, fontSize: 13, flex: 1 },
    takeBtn: {
      paddingHorizontal: 16,
      paddingVertical: 10,
      borderRadius: 10,
      backgroundColor: t.accent,
    },
    takeText: { color: '#0b1220', fontSize: 13, fontWeight: '700' },
  });
