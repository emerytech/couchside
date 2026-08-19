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
import { GamepadClient, GamepadStatus, MouseButton, SpecialKey } from '@/lib/gamepad';
import { hapticLight } from '@/lib/haptics';
import { usePref } from '@/lib/prefs';
import { planSteps, type StepDir, type StepState } from '@/lib/swipeSteps';
import { useThemedStyles, type Palette } from '@/lib/theme';
import type { Settings } from '@/lib/settings';

/** Movement under this (px) within TAP_MS is a tap, not a swipe. Matches the
 *  Pad's swipe surface. */
const TAP_SLOP = 10;
const TAP_MS = 350;

/**
 * Pointer-mode gain: on-pad px -> on-TV pointer px. A flat multiplier rather
 * than the Pad trackpad's speed-adaptive curve — this pad is for picking a
 * tile, not desktop precision work; 1.6 crosses a 4K row in about one swipe.
 */
const POINTER_GAIN = 1.6;

type PadMode = 'tiles' | 'pointer';

/** Names this device to the current holder's Pass/Keep prompt. Matches pad.tsx. */
const DEVICE_LABEL =
  Platform.OS === 'ios' ? 'iPhone' : Platform.OS === 'android' ? 'Android phone' : 'A device';

/** How long to wait on a silent holder before offering a forced takeover. */
const FORCE_AFTER_MS = 20_000;

export function WatchDpad({
  settings,
  ready,
  navOps,
  keyOps,
  onGestureActive,
  client: clientProp,
  onKeyboard,
  keyboardOpen,
  playing,
  onSeek,
  onPlayPause,
  onVolume,
}: {
  settings: Settings;
  ready: boolean;
  /** PlayerState.nav_ops — which spatial steps this box accepts. */
  navOps?: string[];
  /**
   * PlayerState.key_ops — OK/Back the box can deliver as TRUSTED CDP key events
   * (agent >= 2.9.96) instead of uinput. Preferred because uinput needs the
   * Player window to be OS-focused; CDP does not (KI-066). Falls back to the
   * uinput keys against an older box.
   */
  keyOps?: string[];
  /**
   * Fires true while a touch is on the swipe pad, false when it ends. The
   * parent ScrollView must set scrollEnabled={false} during it — a native
   * scroll otherwise steals every vertical drag from the pad's PanResponder,
   * turning "swipe down a row" into "scroll the panel".
   */
  onGestureActive?: (active: boolean) => void;
  /**
   * The gamepad client to drive. Owned by WatchPanel so the panel can ALSO
   * hang the phone-keyboard hook off the same session (its compose bar must
   * render at panel root, outside the ScrollView). This component still owns
   * the connect/hold lifecycle.
   */
  client?: GamepadClient;
  /** Present = render a Keyboard button next to Back (opens the phone keyboard
   *  for typing into whatever the TV has focused — search fields). */
  onKeyboard?: () => void;
  keyboardOpen?: boolean;
  /**
   * True while the box reports a video actually playing. MEASURED on the
   * reference box: during Netflix playback the page has ZERO focusable
   * controls until its control bar is revealed, so spatial nav has nothing to
   * land on and every swipe silently does nothing. So the pad becomes a
   * TRANSPORT while playing — which is what a TV remote does anyway — and
   * reverts to tile navigation the moment playback stops.
   */
  playing?: boolean;
  /** Seek by an offset the BOX advertised (PlayerState.seek_secs). */
  onSeek?: (secs: number) => void;
  /** Toggle play/pause on the box. */
  onPlayPause?: () => void;
  /** Nudge the box's volume. */
  onVolume?: (dir: 1 | -1) => void;
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

  // Use the panel-owned client when given (so the panel's keyboard hook shares
  // this session); create our own otherwise.
  const clientRef = useRef<GamepadClient | null>(clientProp ?? null);
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
  const holdingRef = useRef(holding);
  holdingRef.current = holding;

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
   * One focus step along the row. Prefer the agent's SPATIAL navleft/navright
   * (CDP, no keys): the key answer — Tab / Shift+Tab — is Steam's OVERLAY
   * hotkey, and in Game Mode a Shift+Tab from this pad opened the Steam side
   * menu on the TV instead of walking focus (owner report, Steam Machine).
   * Key fallback only for boxes whose agent predates the horizontal ops.
   */
  const focusStep = (forward: boolean) => {
    const op = forward ? 'navright' : 'navleft';
    if (navOps?.includes(op) === true) {
      api.playerOp(settings, op).catch(() => {});
      return;
    }
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

  /**
   * One gesture step onto the right verb.
   *
   * While a video is PLAYING the pad is a transport (seek / volume): the page
   * has no focusable controls then, so tile navigation would be a no-op with
   * no feedback. Otherwise it navigates tiles.
   */
  const stepDir = (d: StepDir) => {
    if (playing) {
      if (d === 'dl') onSeek?.(-1);
      else if (d === 'dr') onSeek?.(1);
      else onVolume?.(d === 'du' ? 1 : -1);
      return;
    }
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
  /** OK / Back, preferring the trusted CDP key op (focus-independent, agent
   *  >= 2.9.96) and falling back to the uinput key on older boxes. */
  const okAction = () => {
    if (!holding) return;
    hapticLight();
    if (keyOps?.includes('ok')) api.playerOp(settings, 'ok').catch(() => {});
    else pressQuiet('enter');
  };
  const backAction = () => {
    if (!holding) return;
    hapticLight();
    if (keyOps?.includes('back')) api.playerOp(settings, 'back').catch(() => {});
    else pressQuiet('esc');
  };
  const backRef = useRef(backAction);
  backRef.current = backAction;

  /** Centre tap: play/pause while playing, OK otherwise. */
  const tap = () => {
    if (playing) {
      hapticLight();
      onPlayPause?.();
      return;
    }
    okAction();
  };
  const tapRef = useRef(tap);
  tapRef.current = tap;
  /** Pointer-mode tap-click: press then release, gated on holding control. */
  const click = (btn: MouseButton) => {
    if (!holding) return;
    client.sendMouseButton(btn, 1);
    client.sendMouseButton(btn, 0);
  };
  const clickRef = useRef(click);
  clickRef.current = click;

  // Tiles vs Pointer. Tiles steps the focus ring (the couch default); Pointer
  // drives the real mouse like the Pad's trackpad — same {t:'m'}/{t:'mb'}
  // frames, so the agent needs nothing new. Per-mount state on purpose: the
  // right default after reopening a page is tiles.
  const [mode, setMode] = useState<PadMode>('tiles');
  const modeRef = useRef(mode);
  modeRef.current = mode;
  const clientRefStable = useRef(client);
  clientRefStable.current = client;

  // Swipe surface. planSteps is the Pad's unit-tested planner: first step
  // cheap, repeats expensive, dominant axis wins. The responder is created
  // once; live state reaches it through refs.
  const track = useRef({
    consumedX: 0,
    consumedY: 0,
    stepped: false,
    moved: false,
    twoFinger: false,
    lastX: 0,
    lastY: 0,
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
          lastX: 0,
          lastY: 0,
          t0: Date.now(),
        };
      },
      onPanResponderMove: (_evt, g) => {
        const t = track.current;
        // A second finger at ANY point marks the gesture two-finger; checked on
        // move because Grant often fires before the second finger lands.
        if (g.numberActiveTouches >= 2) t.twoFinger = true;
        if (!t.moved && Math.hypot(g.dx, g.dy) > TAP_SLOP) t.moved = true;
        if (t.twoFinger) return; // two-finger = Back on release, never moves
        if (modeRef.current === 'pointer') {
          if (!holdingRef.current) return;
          // Relative mouse, like the Pad trackpad. g.dx/dy are CUMULATIVE, so
          // send the delta since the last move event; sendMouseMove coalesces
          // and rate-limits internally.
          clientRefStable.current.sendMouseMove(
            (g.dx - t.lastX) * POINTER_GAIN,
            (g.dy - t.lastY) * POINTER_GAIN,
          );
          t.lastX = g.dx;
          t.lastY = g.dy;
          return;
        }
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
        // Tap: two fingers = Back in both modes; one finger = OK in tiles,
        // LEFT CLICK in pointer (what a trackpad tap means).
        if (t.twoFinger) {
          backRef.current();
        } else if (modeRef.current === 'pointer') {
          hapticLight();
          clickRef.current('l');
        } else {
          // Playing: tap is play/pause (a TV remote's centre button), because
          // there is no focus ring to "select" during playback.
          tapRef.current();
        }
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
        <View style={styles.titleRow}>
          <Text style={styles.title}>NAVIGATE</Text>
        </View>
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

  const pointer = mode === 'pointer';
  return (
    <View style={styles.wrap} testID="watch-dpad">
      <View style={styles.titleRow}>
        <Text style={styles.title}>NAVIGATE</Text>
        <View style={styles.modeRow}>
          <Pressable
            onPress={() => {
              hapticLight();
              setMode('tiles');
            }}
            testID="watch-dpad-mode-tiles"
            style={[styles.modeChip, !pointer && styles.modeChipOn]}
          >
            <Text style={[styles.modeText, !pointer && styles.modeTextOn]}>Tiles</Text>
          </Pressable>
          <Pressable
            onPress={() => {
              hapticLight();
              setMode('pointer');
            }}
            testID="watch-dpad-mode-pointer"
            style={[styles.modeChip, pointer && styles.modeChipOn]}
          >
            <Text style={[styles.modeText, pointer && styles.modeTextOn]}>Pointer</Text>
          </Pressable>
        </View>
      </View>

      {/* Tiles: flick = one focus step, tap = OK. Pointer: drag the real mouse,
          tap = left click. Two-finger tap = Back in both. */}
      <View style={styles.swipePad} testID="watch-dpad-swipe" {...responder.panHandlers}>
        <Text style={styles.swipeGlyph}>{pointer ? '⌖' : playing ? '⏯' : '✦'}</Text>
        <Text style={styles.swipeHint}>
          {pointer
            ? 'drag the pointer · tap to click'
            : playing
              ? 'swipe ◀ ▶ to seek · tap to play/pause'
              : 'swipe to move · tap for OK'}
        </Text>
      </View>

      <View style={styles.btnRow2}>
        <Pressable
          onPress={backAction}
          testID="watch-dpad-back"
          style={({ pressed }) => [styles.backBtn, pressed && styles.pressed]}
        >
          <Text style={styles.backText}>Back</Text>
        </Pressable>
        {onKeyboard && (
          <Pressable
            onPress={onKeyboard}
            testID="watch-dpad-keyboard"
            style={({ pressed }) => [
              styles.backBtn,
              keyboardOpen && styles.kbOn,
              pressed && styles.pressed,
            ]}
          >
            <Text style={[styles.backText, keyboardOpen && styles.kbOnText]}>
              Keyboard
            </Text>
          </Pressable>
        )}
      </View>

      <Text style={styles.hint}>
        {pointer
          ? 'drag moves the TV pointer · tap clicks · two-finger tap = Back'
          : playing
            ? '◀ ▶ seek · ▲ ▼ volume · tap play/pause · two-finger tap = Back'
            : 'swipe to move · tap selects · two-finger tap = Back'}
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
    titleRow: {
      alignSelf: 'stretch',
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
    },
    title: {
      color: t.textFaint,
      fontSize: 11,
      fontWeight: '700',
      letterSpacing: 1.2,
    },
    modeRow: { flexDirection: 'row', gap: 6 },
    modeChip: {
      paddingHorizontal: 12,
      paddingVertical: 6,
      borderRadius: 8,
      backgroundColor: t.inset,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: t.cardBorder,
    },
    modeChipOn: { backgroundColor: t.accent, borderColor: t.accent },
    modeText: { color: t.textDim, fontSize: 12, fontWeight: '600' },
    modeTextOn: { color: '#0b1220', fontWeight: '700' },
    swipePad: {
      alignSelf: 'stretch',
      // Owner feedback on the first build: 168 felt cramped. A swipe surface
      // is the primary control here — give it real estate.
      height: 300,
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
    btnRow2: { flexDirection: 'row', gap: 8, marginTop: 2 },
    backBtn: {
      paddingHorizontal: 22,
      paddingVertical: 10,
      borderRadius: 10,
      backgroundColor: t.inset,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: t.cardBorder,
    },
    backText: { color: t.text, fontSize: 13, fontWeight: '600' },
    kbOn: { backgroundColor: t.accent, borderColor: t.accent },
    kbOnText: { color: '#0b1220', fontWeight: '700' },
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
