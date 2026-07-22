/**
 * Virtual gamepad + trackpad + keyboard. Emulates an Xbox 360 pad, a relative
 * mouse, and a keyboard on the box over the agent's /ws/gamepad WebSocket
 * (protocol v2). Connected only while this tab is focused and the app is
 * foregrounded; everything is released on the way out.
 *
 * The Pad tab is the one screen that allows landscape (see useLockOrientation);
 * in landscape the gamepad controls spread out like a real controller.
 */
import Ionicons from '@expo/vector-icons/Ionicons';

import { hapticLight, hapticSelection } from '@/lib/haptics';
import { getKeepAwakeEnabled, useKeepAwakeEnabled } from '@/lib/keepAwake';
import { getPref, usePref } from '@/lib/prefs';
import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake';
import { useNavigation } from 'expo-router';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Animated,
  AppState,
  InputAccessoryView,
  Keyboard,
  PanResponder,
  Platform,
  ScrollView,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  useWindowDimensions,
  View,
  ViewStyle,
} from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Gated } from '@/components/Gated';
import { SteamMenusPanel } from '@/components/SteamMenusPanel';
import { RemoteView } from '@/components/RemoteView';
import { TabScreen } from '@/components/TabScreen';
import { useLockOrientation } from '@/hooks/useLockOrientation';
import { usePoll } from '@/hooks/usePoll';
import type { SteamMenus } from '@/lib/api';
import { useTrackpad } from '@/hooks/useTrackpad';
import { useVolumeButtons } from '@/hooks/useVolumeButtons';
import { api, hostKey, Status } from '@/lib/api';
import { ButtonKey, DesktopKey, GamepadClient, GamepadStatus, SpecialKey, StickKey, SystemChord, TriggerKey } from '@/lib/gamepad';
import { PadMode } from '@/lib/settings';
import { useSettings } from '@/lib/SettingsContext';
import { mono, useTheme, useThemedStyles } from '@/lib/theme';
import type { Palette } from '@/lib/theme';

const KEEP_AWAKE_TAG = 'rescue-remote-pad';

// All Pad haptics (swipe steps, taps, buttons, sticks, mode switch) route
// through the app-wide gated emitter so the Settings toggle governs them.
function haptic() {
  hapticSelection();
}

/** Stable no-op for momentary buttons whose action fires (and self-releases) on press. */
const NOOP = () => {};

// ---------- Buttons ----------

type PadButtonProps = {
  label: string;
  onDown: () => void;
  onUp: () => void;
  style?: ViewStyle | ViewStyle[];
  color?: string;
  fontSize?: number;
};

function PadButton({ label, onDown, onUp, style, color, fontSize }: PadButtonProps) {
  const styles = useThemedStyles(makeStyles);
  return (
    <Pressable
      onPressIn={() => {
        haptic();
        onDown();
      }}
      onPressOut={onUp}
      style={({ pressed }) => [styles.btn, style, pressed && styles.btnPressed]}>
      <Text
        style={[
          styles.btnText,
          color != null && { color },
          fontSize != null && { fontSize },
        ]}>
        {label}
      </Text>
    </Pressable>
  );
}

// ---------- Analog stick ----------

const STICK_SIZE = 132;
const NUB_SIZE = 56;
const STICK_RADIUS = (STICK_SIZE - NUB_SIZE) / 2;

type StickProps = {
  onMove: (x: number, y: number) => void;
  onRelease: () => void;
};

function Stick({ onMove, onRelease }: StickProps) {
  const pan = useRef(new Animated.ValueXY({ x: 0, y: 0 })).current;
  const cb = useRef({ onMove, onRelease });
  cb.current = { onMove, onRelease };

  const responder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderGrant: () => {
        haptic();
      },
      onPanResponderMove: (_evt, g) => {
        let dx = g.dx;
        let dy = g.dy;
        const len = Math.hypot(dx, dy);
        if (len > STICK_RADIUS) {
          dx = (dx / len) * STICK_RADIUS;
          dy = (dy / len) * STICK_RADIUS;
        }
        pan.setValue({ x: dx, y: dy });
        // +y down in screen coords matches the protocol directly.
        cb.current.onMove(dx / STICK_RADIUS, dy / STICK_RADIUS);
      },
      onPanResponderRelease: () => {
        Animated.spring(pan, {
          toValue: { x: 0, y: 0 },
          useNativeDriver: false,
          friction: 6,
        }).start();
        cb.current.onRelease();
      },
      onPanResponderTerminate: () => {
        Animated.spring(pan, {
          toValue: { x: 0, y: 0 },
          useNativeDriver: false,
          friction: 6,
        }).start();
        cb.current.onRelease();
      },
    }),
  ).current;

  const styles = useThemedStyles(makeStyles);
  return (
    <View style={styles.stickPad} {...responder.panHandlers}>
      <View style={styles.stickCross} pointerEvents="none" />
      <Animated.View
        pointerEvents="none"
        style={[styles.stickNub, { transform: pan.getTranslateTransform() }]}
      />
    </View>
  );
}

// ---------- Swipe surface (Apple TV remote style) ----------

/** Pixels of travel per emitted d-pad step. */
const SWIPE_STEP = 56;
/** Movement under this is still a tap. */
const TAP_SLOP = 12;
/** Touches longer than this aren't taps. */
const TAP_MS = 450;

type DpadKey = 'du' | 'dd' | 'dl' | 'dr';

// Keyboard-mode equivalent for the swipe surface. Arrow keys were measured
// driving Steam Game Mode on a Bazzite box (three DOWN taps moved the selection
// two rows and stopped at the list end; one UP moved it back; a Ctrl+9 control
// moved nothing).
const SWIPE_KEY: Record<DpadKey, SpecialKey> = {
  du: 'up',
  dd: 'down',
  dl: 'left',
  dr: 'right',
};

type SwipeSurfaceProps = {
  onStep: (k: DpadKey) => void;
  /** Gesture ended (lifted OR terminated) — release whatever is still held. */
  onStepEnd: () => void;
  onSelect: () => void;
};

/**
 * Trackpad-like surface: dragging emits one d-pad step per SWIPE_STEP px along
 * the dominant axis (a long swipe = several steps, like scrolling a menu);
 * a quick tap is A/select.
 */
function SwipeSurface({ onStep, onStepEnd, onSelect }: SwipeSurfaceProps) {
  const cb = useRef({ onStep, onStepEnd, onSelect });
  cb.current = { onStep, onStepEnd, onSelect };
  const track = useRef({ consumedX: 0, consumedY: 0, moved: false, t0: 0 });
  // Sensitivity read into a ref so the once-created responder sees live changes.
  // Higher sensitivity = smaller step = more steps per swipe.
  const sens = usePref('swipeSensitivity');
  const sensRef = useRef(sens);
  sensRef.current = sens;

  const responder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderGrant: () => {
        track.current = { consumedX: 0, consumedY: 0, moved: false, t0: Date.now() };
      },
      onPanResponderMove: (_evt, g) => {
        const t = track.current;
        if (!t.moved && Math.hypot(g.dx, g.dy) > TAP_SLOP) t.moved = true;
        const step = SWIPE_STEP / sensRef.current;
        let stepped = false;
        // Emit steps until the un-consumed travel is under one step on both axes.
        for (;;) {
          const availX = g.dx - t.consumedX;
          const availY = g.dy - t.consumedY;
          const ax = Math.abs(availX);
          const ay = Math.abs(availY);
          if (ax < step && ay < step) break;
          stepped = true;
          if (ax >= ay) {
            t.consumedX += Math.sign(availX) * step;
            cb.current.onStep(availX > 0 ? 'dr' : 'dl');
          } else {
            t.consumedY += Math.sign(availY) * step;
            cb.current.onStep(availY > 0 ? 'dd' : 'du');
          }
        }
        // ONE haptic per move event, never one per step. This loop is unbounded
        // — a fast swipe emits a burst — and on iOS each selectionAsync() hops
        // to the main queue with a fresh feedback generator, so a per-step tick
        // floods it. The trackpad surface already rate-limits this way
        // (tpHapticAcc). Cheap, and it removes the best-motivated suspect for
        // the JS stall that swallowed d-pad releases.
        if (stepped) haptic();
      },
      // Release AND terminate both end the gesture. Only Release fired before,
      // so an iOS gesture stolen mid-swipe (screen-edge back, a parent
      // responder) left the d-pad asserted with nothing to let it go — and the
      // agent latches that axis until something explicitly zeroes it.
      onPanResponderRelease: () => {
        const t = track.current;
        cb.current.onStepEnd();
        if (!t.moved && Date.now() - t.t0 < TAP_MS) cb.current.onSelect();
      },
      onPanResponderTerminate: () => {
        cb.current.onStepEnd();
      },
      // Keep the touch: both sibling surfaces already refuse termination
      // (useTrackpad, the stick). Without this the surface can lose a gesture
      // it is mid-way through emitting.
      onPanResponderTerminationRequest: () => false,
    }),
  ).current;

  const hints = usePref('padHints');
  const styles = useThemedStyles(makeStyles);
  return (
    <View style={styles.swipeSurface} {...responder.panHandlers}>
      {hints && <Text style={styles.swipeHint}>swipe to move · tap to select</Text>}
    </View>
  );
}

// ---------- Trackpad surface (relative mouse, protocol v2) ----------

/** Pointer travel (px) per haptic "texture" tick while dragging. */
const TP_HAPTIC_PX = 56;

type TrackpadProps = {
  onMove: (dx: number, dy: number) => void;
  onLeftClick: () => void;
  onRightClick: () => void;
  onScroll: (notches: number) => void;
  onDragStart: () => void;
  onDragEnd: () => void;
};

/**
 * Relative-mouse surface (gesture logic shared with the RemoteView nav circle
 * via useTrackpad):
 *  - 1-finger drag        -> sendMouseMove (with a light acceleration curve)
 *  - 1-finger tap         -> left click
 *  - 2-finger tap         -> right click
 *  - 2-finger drag        -> vertical scroll (wheel)
 *  - double-tap + drag    -> hold left button + drag = marquee select
 */
function Trackpad({
  onMove,
  onLeftClick,
  onRightClick,
  onScroll,
  onDragStart,
  onDragEnd,
}: TrackpadProps) {
  const responder = useTrackpad({
    onMove,
    onLeftClick,
    onRightClick,
    onScroll,
    onDragStart,
    onDragEnd,
  });
  const hints = usePref('padHints');
  const styles = useThemedStyles(makeStyles);
  return (
    <View style={styles.trackpadSurface} {...responder.panHandlers}>
      {hints && (
        <Text style={styles.swipeHint}>
          drag = move · tap = click · two-finger tap = right-click · two-finger
          drag = scroll · double-tap-drag = select
        </Text>
      )}
    </View>
  );
}

// ---------- Keyboard bar (visible compose field -> protocol v2 keys) ----------

/**
 * What to send the box when the compose field goes from `prev` to `next`.
 *
 * The field used to be invisible and was wiped to '' on every change, which
 * streamed keystrokes fine but made PASTE impossible: iOS will not offer a
 * paste menu for a field you cannot long-press, and anything pasted would have
 * been erased on the next render anyway.
 *
 * Keeping the text on screen means the field can now differ from the box in any
 * way — mid-string edits, autocorrect replacements, a paste dropped into the
 * middle. Rather than special-case those, diff on the common prefix: erase back
 * to where the two agree, then type the rest. That is correct for every edit,
 * including the ordinary ones (a typed character is 0 backspaces + 1 char; a
 * paste is 0 backspaces + the whole chunk).
 *
 * Pure and exported so the risky half is testable with synthetic input — the
 * drag-trail bug shipped because its geometry could only be exercised on a
 * device. `__textDelta` exposes it for the harness.
 */
export function textDelta(prev: string, next: string): { backspaces: number; insert: string } {
  let c = 0;
  const max = Math.min(prev.length, next.length);
  while (c < max && prev[c] === next[c]) c += 1;
  return { backspaces: prev.length - c, insert: next.slice(c) };
}
if (typeof globalThis !== 'undefined') {
  (globalThis as Record<string, unknown>).__textDelta = textDelta;
}

// iOS accessory bar id: rides on TOP of the system keyboard so a Done button is
// always visible while typing (the in-layout bar below is hidden behind the
// raised keyboard, which left users no obvious way to dismiss it).
const KB_ACCESSORY_ID = 'couchside-kb-accessory';

type KeyboardBarProps = {
  /** Bumped when the BOX raised its own keyboard; each increment focuses this
      bar's field so the phone keyboard comes up too. A counter rather than a
      boolean so two opens in a row both register. */
  autoOpenSignal?: number;
  onText: (s: string) => void;
  onBackspace: () => void;
  onEnter: () => void;
  /** Horizontal swipe across the (closed) bar: cycle the input mode.
      +1 = swipe left (next mode), -1 = swipe right (previous). */
  onSwipeMode?: (dir: 1 | -1) => void;
};

/**
 * A visible "keyboard" button that focuses a hidden TextInput to raise the iOS
 * keyboard. Printable characters are streamed via onText; Backspace and Enter
 * are surfaced as their own callbacks. The input is kept effectively empty so
 * each keystroke is captured individually rather than accumulating a value.
 *
 * Dismissal is made bulletproof: an explicit "Done" button, a swipe-DOWN drag
 * handle, and a subscription to the OS 'keyboardDidHide' event that resyncs the
 * bar's open/closed state so the affordance can never get stuck showing "open"
 * while the real keyboard is down (or vice-versa). `open` is mirrored into a ref
 * so callbacks always see the live value without stale closures.
 */
function KeyboardBar({ autoOpenSignal, onText, onBackspace, onEnter, onSwipeMode }: KeyboardBarProps) {
  const inputRef = useRef<TextInput>(null);
  const [open, setOpen] = useState(false);
  // Live ref so the once-created swipe responder sees the current callback.
  const swipeModeRef = useRef(onSwipeMode);
  swipeModeRef.current = onSwipeMode;
  // Live mirror of `open` for use inside event callbacks/PanResponder, which
  // capture their closure once and would otherwise read a stale value.
  const openRef = useRef(false);
  const setOpenSynced = useCallback((v: boolean) => {
    openRef.current = v;
    setOpen(v);
  }, []);
  const [value, setValue] = useState('');
  const pal = useTheme();
  // Live mirror: onChangeText/onKeyPress are memoised, and a stale `value` in
  // their closure would diff against the wrong text and send garbage.
  const valueRef = useRef(value);
  valueRef.current = value;

  // Belt-and-suspenders dismiss: hide the OS keyboard AND blur our input, so it
  // works no matter which one is actually holding focus.
  const dismiss = useCallback(() => {
    Keyboard.dismiss();
    inputRef.current?.blur();
    setOpenSynced(false);
    setValue('');
  }, [setOpenSynced]);

  const focus = useCallback(() => {
    haptic();
    setOpenSynced(true);
    // Focus SYNCHRONOUSLY inside the tap handler. Deferring with
    // requestAnimationFrame pushed focus() into a later tick, outside the touch
    // event, which iOS can treat as non-interactive and refuse to raise the
    // keyboard. The input is always mounted, so the ref is ready here.
    inputRef.current?.focus();
  }, [setOpenSynced]);

  // The BOX raised its keyboard, so raise ours. Skips the first render: the
  // signal starts at 0 and only a real event increments it, otherwise every
  // mount would pop the keyboard unprompted.
  //
  // NOTE this is the one focus() path NOT inside a touch handler, which iOS can
  // legitimately refuse (see the comment above). Refusal is a no-op — the bar
  // simply stays closed — but it is the reason this needs a device check rather
  // than a harness one.
  const lastAutoOpen = useRef(autoOpenSignal ?? 0);
  useEffect(() => {
    const sig = autoOpenSignal ?? 0;
    if (sig === lastAutoOpen.current) return;
    lastAutoOpen.current = sig;
    if (sig > 0 && !openRef.current) focus();
  }, [autoOpenSignal, focus]);

  // Lift for the floating HIDE pill: measured, not framework-magic. The pill
  // is absolutely positioned inside the SCREEN container, but the keyboard's
  // frame is in WINDOW coordinates — and with SDK 57's edge-to-edge Android
  // the window doesn't resize (the keyboard overlays), while iOS's
  // KeyboardAvoidingView missed events when it mounted late. So: a zero-size
  // anchor marks the container's bottom in window coords; on keyboard-show,
  // lift = anchorY - keyboardTopY. Deterministic on both platforms.
  const [kbLift, setKbLift] = useState(0);
  const anchorRef = useRef<View>(null);
  useEffect(() => {
    const showEvent = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
    const show = Keyboard.addListener(showEvent, (e) => {
      const kbTop = e.endCoordinates?.screenY;
      if (kbTop == null) return;
      anchorRef.current?.measureInWindow((_x, y) => {
        if (typeof y === 'number') setKbLift(Math.max(0, y - kbTop));
      });
    });
    const hide = Keyboard.addListener('keyboardDidHide', () => setKbLift(0));
    return () => {
      show.remove();
      hide.remove();
    };
  }, []);

  // Source of truth: whenever the OS reports the keyboard went down, mark the
  // bar closed. This catches every dismissal path (Done, swipe, the system
  // keyboard's own hide, app backgrounding) so state can't drift.
  useEffect(() => {
    const sub = Keyboard.addListener('keyboardDidHide', () => {
      openRef.current = false;
      setOpen(false);
      setValue('');
    });
    return () => sub.remove();
  }, []);

  // Swipe-DOWN on the bar dismisses. A downward drag past a small threshold, or
  // a downward flick, closes the keyboard.
  const panResponder = useRef(
    PanResponder.create({
      onMoveShouldSetPanResponder: (_e, g) =>
        g.dy > 6 && g.dy > Math.abs(g.dx),
      onPanResponderRelease: (_e, g) => {
        if (openRef.current && (g.dy > 24 || g.vy > 0.4)) dismiss();
      },
    }),
  ).current;

  // While CLOSED the bar doubles as a mode-switch rail: a horizontal swipe
  // cycles the input mode (a Pressable tap still opens the keyboard — this
  // responder only claims clearly-horizontal drags).
  const modeSwipeResponder = useRef(
    PanResponder.create({
      // CAPTURE phase: the bar's Pressable child otherwise wins the touch and
      // a horizontal swipe reads as a tap (opening the keyboard). Only clearly
      // horizontal drags are captured, so plain taps still reach the Pressable.
      onMoveShouldSetPanResponderCapture: (_e, g) =>
        Math.abs(g.dx) > 14 && Math.abs(g.dx) > Math.abs(g.dy) * 1.5,
      onPanResponderTerminationRequest: () => false,
      onPanResponderRelease: (_e, g) => {
        const fn = swipeModeRef.current;
        if (fn && (Math.abs(g.dx) > 48 || Math.abs(g.vx) > 0.5)) {
          fn(g.dx < 0 ? 1 : -1);
        }
      },
    }),
  ).current;

  const onChangeText = useCallback(
    (next: string) => {
      // The field KEEPS its text now, so what changed has to be worked out
      // rather than assumed to be an append — see textDelta. This is what makes
      // paste work: a pasted chunk is just a large insert.
      const { backspaces, insert } = textDelta(valueRef.current, next);
      for (let i = 0; i < backspaces; i += 1) onBackspace();
      if (insert.length > 0) onText(insert);
      setValue(next);
    },
    [onText, onBackspace],
  );

  /**
   * Paste the phone's clipboard into the box.
   *
   * Deliberately routed through onChangeText rather than sending the text
   * directly: that path already diffs against what is on screen (see
   * textDelta), so a paste behaves exactly like typing the same characters and
   * the compose field stays in sync with the box. Sending straight past it
   * would leave the field and the box disagreeing, and the next keystroke would
   * then diff against the wrong text.
   *
   * This exists because iOS's own paste menu needs a long-press on a field, and
   * on a TV remote you are usually pasting a password or a URL you have no
   * intention of retyping — one button beats a long-press hunt.
   */
  const pasteFromClipboard = useCallback(async () => {
    try {
      const text = await Clipboard.getStringAsync();
      if (!text) return;
      haptic();
      onChangeText(valueRef.current + text);
    } catch {
      // Clipboard unavailable (permission, web without a secure context):
      // silently do nothing rather than break the keyboard bar.
    }
  }, [onChangeText]);

  const onKeyPress = useCallback(
    (e: { nativeEvent: { key: string } }) => {
      const key = e.nativeEvent.key;
      // Backspace on an EMPTY field can't show up as a diff, but it is how you
      // delete text that is already on the box rather than in this field, so it
      // still has to be forwarded. A non-empty field is left to onChangeText,
      // or the deletion would be sent twice.
      if (key === 'Backspace') {
        if (valueRef.current.length === 0) onBackspace();
      } else if (key === 'Enter') {
        onEnter();
      }
    },
    [onBackspace, onEnter],
  );

  const styles = useThemedStyles(makeStyles);
  return (
    <>
      <View
        style={styles.kbBarRow}
        {...(open ? panResponder.panHandlers : modeSwipeResponder.panHandlers)}>
        <Pressable
          onPress={open ? dismiss : focus}
          style={({ pressed }) => [
            styles.kbBar,
            styles.kbBarFlex,
            open && styles.kbBarOpen,
            pressed && styles.btnPressed,
          ]}>
          {open && <View style={styles.kbDragHandle} pointerEvents="none" />}
          {/* Closed: edge chevrons advertise the horizontal mode-switch swipe. */}
          {!open && <Text style={styles.kbSwipeCue}>‹</Text>}
          <Text style={[styles.kbBarText, open && styles.kbBarTextOpen]}>
            {open ? '⌨  type to send · swipe down or tap Done' : '⌨  KEYBOARD  ·  swipe to switch mode'}
          </Text>
          {!open && <Text style={styles.kbSwipeCue}>›</Text>}
        </Pressable>
        {open && (
          <>
            {/* Android has no InputAccessoryView, so PASTE has to live here too
                or half the users never get it. */}
            <Pressable
              onPress={pasteFromClipboard}
              hitSlop={8}
              style={({ pressed }) => [styles.kbDone, pressed && styles.btnPressed]}>
              <Text style={styles.kbDoneText}>PASTE</Text>
            </Pressable>
            <Pressable
              onPress={dismiss}
              hitSlop={8}
              style={({ pressed }) => [styles.kbDone, pressed && styles.btnPressed]}>
              <Text style={styles.kbDoneText}>DONE</Text>
            </Pressable>
          </>
        )}
      </View>
      {/* Zero-size anchor at the container's bottom edge — measured in window
          coordinates to compute the pill's keyboard lift (see kbLift above). */}
      <View ref={anchorRef} collapsable={false} style={styles.kbAnchor} />
      {/* Floating dismiss while typing: rides just ABOVE the keyboard,
          bottom-right (thumb range), lifted by the MEASURED keyboard overlap.
          Exists because the in-layout DONE gets covered by the raised keyboard
          and the InputAccessoryView Done bar stopped rendering under newer iOS
          SDKs (build 30), which left the keyboard stuck open. */}
      {open && (
        <View pointerEvents="box-none" style={[styles.kbFloatWrap, { bottom: 10 + kbLift }]}>
          <Pressable
            onPress={dismiss}
            hitSlop={10}
            style={({ pressed }) => [styles.kbFloatDone, pressed && styles.btnPressed]}>
            <Text style={styles.kbDoneText}>⌨ ✕ HIDE</Text>
          </Pressable>
        </View>
      )}
      {/* ONE input, restyled — not two.
          Closed it is the off-screen sliver it always was (iOS will not make a
          zero-size or fully transparent view first responder, which is why it
          cannot simply be unmounted). Open it becomes a real, touchable field
          above the keyboard, which is the entire point: iOS only offers Paste
          on a field you can long-press.

          Rendering a second visible input instead would not work — focus would
          stay on the hidden one that raised the keyboard, and the visible one
          would sit there inert. */}
      <TextInput
        ref={inputRef}
        value={value}
        onChangeText={onChangeText}
        onKeyPress={onKeyPress}
        onSubmitEditing={onEnter}
        onBlur={() => {
          setOpenSynced(false);
          setValue('');
        }}
        style={open ? [styles.kbCompose, { bottom: 10 + kbLift }] : styles.hiddenInput}
        placeholder={open ? 'type or paste — sent as you go' : undefined}
        placeholderTextColor={pal.textFaint}
        autoCapitalize="none"
        autoCorrect={false}
        autoComplete="off"
        spellCheck={false}
        blurOnSubmit={false}
        keyboardAppearance="dark"
        caretHidden={!open}
        inputAccessoryViewID={Platform.OS === 'ios' ? KB_ACCESSORY_ID : undefined}
      />
      {/* Done bar pinned to the top of the iOS keyboard — always reachable,
          unlike the in-layout bar which the raised keyboard covers. */}
      {Platform.OS === 'ios' && (
        <InputAccessoryView nativeID={KB_ACCESSORY_ID}>
          <View style={styles.kbAccessory}>
            <Text style={styles.kbAccessoryHint}>⌨  type to send</Text>
            <Pressable
              onPress={pasteFromClipboard}
              hitSlop={10}
              style={({ pressed }) => [
                styles.kbDone,
                styles.kbAccessoryDone,
                pressed && styles.btnPressed,
              ]}>
              <Text style={styles.kbDoneText}>PASTE</Text>
            </Pressable>
            <Pressable
              onPress={dismiss}
              hitSlop={10}
              style={({ pressed }) => [
                styles.kbDone,
                styles.kbAccessoryDone,
                pressed && styles.btnPressed,
              ]}>
              <Text style={styles.kbDoneText}>DONE</Text>
            </Pressable>
          </View>
        </InputAccessoryView>
      )}
    </>
  );
}

// ---------- Status pill ----------

/** This phone's label sent to the box so the holder's "wants control" prompt
 *  can name it. A platform label (no native device-name dependency). */
const DEVICE_LABEL =
  Platform.OS === 'ios' ? 'iPhone' : Platform.OS === 'android' ? 'Android phone' : 'A device';

function statusLabel(status: GamepadStatus, dev: string | null): string {
  switch (status) {
    case 'connected':
      return dev ?? 'connected';
    case 'connecting':
      return 'connecting…';
    case 'replaced':
      return 'another device has control · tap to take over';
    case 'waiting':
      return dev ? `waiting for ${dev} to pass control` : 'waiting for control';
    case 'released':
      return dev ? `${dev} has control · tap to request` : 'tap to request control';
    default:
      return 'disconnected, tap to retry';
  }
}

// ---------- Screen ----------

export default function PadTab() {
  // The one tab that allows landscape so the controller can spread out.
  useLockOrientation('allow-landscape');
  return (
    <TabScreen>
      <Gated>
        <PadScreen />
      </Gated>
    </TabScreen>
  );
}

const MODES: { key: PadMode; label: string }[] = [
  { key: 'gamepad', label: 'PAD' },
  { key: 'swipe', label: 'SWIPE' },
  // "MOUSE", not "TRACK": the surface IS a mouse — drag moves the pointer, tap
  // clicks. "Track" named the mechanism and left people guessing at the effect.
  { key: 'trackpad', label: 'MOUSE' },
  { key: 'remote', label: 'REMOTE' },
  // Sits AFTER remote on purpose: it is one swipe further from the surface you
  // reach for most. Conditional -- see `modes` below; a box without Steam menus
  // never sees this segment, because an empty panel is worse than no segment.
  { key: 'menus', label: 'STEAM' },
];

function PadScreen() {
  const t = useTheme();
  const styles = useThemedStyles(makeStyles);
  const STATUS_COLOR = useMemo<Record<GamepadStatus, string>>(
    () => ({
      connected: t.green,
      connecting: t.amber,
      error: t.red,
      closed: t.red,
      replaced: t.amber,
      waiting: t.amber,
      released: t.amber,
    }),
    [t],
  );
  const insets = useSafeAreaInsets();
  const navigation = useNavigation();
  const { width, height } = useWindowDimensions();
  const landscape = width > height;
  const { settings, ready, update } = useSettings();
  // Input mode lives on the active BOX record; with no box paired,
  // SettingsContext.update() is a silent no-op and the mode toggle looked
  // functional but did nothing. Local fallback keeps it switchable (session-
  // only) until a box exists — then the box's padMode takes over.
  // Keyboard instead of a virtual gamepad. Steam navigates identically from
  // arrow keys, and the pad has a cost the keyboard does not -- see the pref's
  // doc comment in lib/prefs.ts. Read here rather than inside the surfaces so
  // ONE value drives both the send path and which segments exist.
  const keyboardMode = usePref('keyboardMode');
  const [localMode, setLocalMode] = useState<PadMode>(getPref('defaultPadMode'));
  // EMPTY_SETTINGS hardcodes padMode:'swipe', so key off "is a box paired"
  // rather than ?? — otherwise the local fallback never engages.
  const rawMode: PadMode = settings.host.trim().length > 0
    ? settings.padMode ?? 'swipe'
    : localMode;
  // In keyboard mode the agent is asked NOT to create a pad, so the PAD screen
  // has nothing to drive. Fall back rather than render sticks that go nowhere.
  const mode: PadMode = keyboardMode && rawMode === 'gamepad' ? 'swipe' : rawMode;
  const [status, setStatus] = useState<GamepadStatus>('closed');
  const [dev, setDev] = useState<string | null>(null);
  // Non-null when the box is refusing input injection (locked / not the active
  // desktop / an elevated window has focus); the string is the hint to show.
  const [inputBlocked, setInputBlocked] = useState<string | null>(null);
  // Controller handoff (agent >= 2.9.2). askToSwitch: when another phone joins
  // a box we control, ask before passing (vs let it grab). controlReq: the
  // requesting device's name while a Pass/Keep prompt is up. canForce: a waiter
  // has waited long enough with no answer to force takeover.
  const askToSwitch = usePref('askToSwitchControl');
  const askToSwitchRef = useRef(askToSwitch);
  askToSwitchRef.current = askToSwitch;
  // The no-pad decision is made at HANDSHAKE time, so the live value has to be
  // reachable from the focus effect's connect(), not just from render.
  const keyboardModeRef = useRef(keyboardMode);
  keyboardModeRef.current = keyboardMode;

  // Hardware volume buttons -> box/TV volume across EVERY input mode (Pad,
  // Swipe, Track, Remote), mounted here on the always-present Pad screen rather
  // than inside RemoteView. Active while the user opted in and a box is
  // connected; the connection lifecycle is tied to tab focus, so leaving the
  // Pad tab restores the phone's own volume. Honors settings.volumeTarget.
  const volumeButtons = usePref('volumeButtons');
  const sendVol = useCallback(
    (op: 'volume_up' | 'volume_down') => {
      hapticLight();
      void api.tvSend(settings, op, settings.volumeTarget ?? 'box').catch(() => {});
    },
    [settings],
  );
  useVolumeButtons({
    enabled: volumeButtons && status === 'connected',
    onUp: () => sendVol('volume_up'),
    onDown: () => sendVol('volume_down'),
  });
  const [controlReq, setControlReq] = useState<string | null>(null);
  const [canForce, setCanForce] = useState(false);

  const clientRef = useRef<GamepadClient | null>(null);
  if (clientRef.current == null) {
    clientRef.current = new GamepadClient();
  }
  const client = clientRef.current;

  // Latest settings for connect() calls. The lifecycle effect below keys on
  // the connection identity (host/port/token) only. A background patch to
  // the active box (the lastIp learner, a padMode toggle) must NOT tear down
  // a healthy socket mid-game via a `settings` object-identity change.
  const settingsRef = useRef(settings);
  settingsRef.current = settings;

  // Whether the Pad is currently connected/focused, so the keep-awake effect
  // below can (de)acquire the wake lock when the pref loads or is toggled.
  const focusedRef = useRef(false);
  const keepAwakeOn = useKeepAwakeEnabled();

  // Manage the connection off the screen's mount lifecycle (reliable on web
  // and native) rather than useFocusEffect, whose callback-body timing is
  // unreliable on web. This screen mounts lazily on first visit to the Pad tab
  // and then stays mounted; connect() is idempotent, and an idle WS emits
  // nothing until a control is touched, so holding it open is harmless. Blur
  // releases everything (so inputs never leak to the box while you're on
  // another tab); focus and AppState-active re-open.
  useEffect(() => {
    if (!ready) return undefined;

    client.onStatus((s, d) => {
      setStatus(s);
      setDev(d);
      if (s !== 'waiting') setCanForce(false);
    });

    client.onInputBlocked((blocked, msg) => {
      setInputBlocked(blocked ? (msg ?? 'Input paused — unlock the box.') : null);
    });

    client.onControlRequest((name) => setControlReq(name));

    // Box raised its keyboard -> raise ours, unless the user turned it off.
    // Read through the ref so flipping the pref takes effect without
    // re-subscribing (and without tearing down the socket).
    client.onOsk(() => {
      if (autoKeyboardRef.current) setOskSignal((n) => n + 1);
    });

    const connect = () => {
      focusedRef.current = true;
      client.connect(settingsRef.current, {
        handoffAsk: askToSwitchRef.current,
        deviceName: DEVICE_LABEL,
        noPad: keyboardModeRef.current,
      });
      if (Platform.OS !== 'web') {
        // Honor the "keep screen awake on Pad" pref; if it was turned off while
        // focused, this re-connect path also releases a prior lock.
        if (getKeepAwakeEnabled()) {
          activateKeepAwakeAsync(KEEP_AWAKE_TAG).catch(() => {});
        } else {
          deactivateKeepAwake(KEEP_AWAKE_TAG).catch(() => {});
        }
      }
    };
    const disconnect = () => {
      focusedRef.current = false;
      client.close();
      if (Platform.OS !== 'web') {
        deactivateKeepAwake(KEEP_AWAKE_TAG).catch(() => {});
      }
    };

    const offFocus = navigation.addListener('focus', connect);
    const offBlur = navigation.addListener('blur', disconnect);
    const appSub = AppState.addEventListener('change', (state) => {
      if (state === 'active') connect();
      else disconnect();
    });

    // Baseline: connect on mount. Focus/blur listeners above refine this when
    // the platform delivers those events.
    connect();

    return () => {
      offFocus();
      offBlur();
      appSub.remove();
      disconnect();
      client.onStatus(null);
      client.onInputBlocked(null);
      client.onControlRequest(null);
      client.onOsk(null);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- connection
    // identity only; settingsRef carries the rest without re-running.
  }, [client, ready, settings.host, settings.port, settings.token, navigation]);

  // Re-apply the wake lock when the keep-awake pref loads or is toggled. The
  // pref loads asynchronously, so on a cold start straight onto the Pad tab the
  // first connect() can read the default (on) before a user's "off" resolves;
  // this corrects the lock once the real value arrives (and on later toggles).
  useEffect(() => {
    if (Platform.OS === 'web') return;
    if (focusedRef.current && keepAwakeOn) {
      activateKeepAwakeAsync(KEEP_AWAKE_TAG).catch(() => {});
    } else {
      deactivateKeepAwake(KEEP_AWAKE_TAG).catch(() => {});
    }
  }, [keepAwakeOn]);

  // Toggling keyboard mode has to RE-HANDSHAKE: whether the agent creates a
  // virtual pad is decided once, from the connect URL. Without this, turning the
  // mode on would leave the already-created pad alive until the next reconnect,
  // and the box would keep reporting a controller the app claims it did not make.
  // connect() itself notices the changed flag and tears the socket down; this
  // effect only has to call it.
  useEffect(() => {
    if (!ready) return;
    const st = client.getStatus();
    if (st !== 'connected' && st !== 'connecting') return;
    client.connect(settingsRef.current, {
      handoffAsk: askToSwitchRef.current,
      deviceName: DEVICE_LABEL,
      noPad: keyboardMode,
    });
  }, [client, ready, keyboardMode]);

  // A freshly-learned lastIp should reach the client's stored conn so future
  // reconnects can use it. connect() with an unchanged host/port/token just
  // refreshes the stored conn: it never drops a live socket.
  useEffect(() => {
    if (!ready || !settings.lastIp) return;
    if (client.getStatus() === 'connected' || client.getStatus() === 'connecting') {
      client.connect(settingsRef.current);
    }
  }, [client, ready, settings.lastIp]);

  // Waiting with no answer for 20s -> allow forcing control (the holder walked
  // away or its app is backgrounded). Reset whenever we leave the waiting state.
  useEffect(() => {
    if (status !== 'waiting') return undefined;
    const t = setTimeout(() => setCanForce(true), 20_000);
    return () => clearTimeout(t);
  }, [status]);

  // The status pill's tap does the right thing per state: request/force control
  // during a handoff, otherwise reconnect.
  const retry = useCallback(() => {
    haptic();
    if (status === 'released') {
      client.requestControl();
    } else if (status === 'waiting') {
      if (canForce) client.forceControl();
      else client.requestControl();
    } else if (status !== 'connected') {
      client.connect(settings, {
        handoffAsk: askToSwitch,
        deviceName: DEVICE_LABEL,
        noPad: keyboardMode,
      });
    }
  }, [client, settings, status, canForce, askToSwitch]);

  const btn = useCallback(
    (k: ButtonKey) => ({
      onDown: () => client.sendButton(k, 1),
      onUp: () => client.sendButton(k, 0),
    }),
    [client],
  );

  // ⋯ Quick Access Menu. Steam opens the QAM on an Xbox pad via a Guide + A
  // chord (Guide alone is the Steam menu); the client presses both and
  // auto-releases, so one tap opens the ⋯ panel where Decky / plugins live.
  const qam = useCallback(() => client.qamChord(), [client]);

  // Windows desktop shortcuts (Start / Alt+Tab / Lock / Task Manager). Only a
  // ViGEm (Windows) box maps these; the row that uses them is gated on that.
  const isWindows = dev === 'ViGEm X360 pad';
  const sys = useCallback(
    (name: SystemChord) => () => client.sendSystemChord(name),
    [client],
  );

  // SteamOS/Bazzite Plasma-desktop nav (Start menu / Overview / Esc). Session-
  // aware: caps.desktop flips with each Game Mode <-> desktop switch, so poll
  // status here like RemoteView does rather than trusting the persisted caps.
  const deskPoll = usePoll<Status>(() => api.status(settings), 8000, true, hostKey(settings));
  // Steam settings shortcuts (agent >= 2.9.31). api.steamMenus is already
  // capability-gated, so an older box resolves null and the mode disappears.
  // Slow poll: this list is static for the life of a Steam install.
  const menusPoll = usePoll<SteamMenus | null>(
    () => api.steamMenus(settings),
    60000,
    true,
    hostKey(settings),
  );
  const steamMenus = menusPoll.data?.menus ?? [];
  const hasSteamMenus = steamMenus.length > 0;
  // Declared BEFORE `modes` because the Steam segment depends on it.
  const hasDesktop = deskPoll.data?.caps?.desktop === true;
  // These shortcuts are steam:// deep links that Steam only acts on in GAME
  // MODE; on the Plasma desktop they do nothing useful. desktop_available() is
  // recomputed per /api/status request precisely because it flips on every
  // session switch, so this tracks a live Couch Mode handoff rather than
  // whatever session the agent booted in.
  //
  // `=== true` matters: only HIDE when we positively know it is the desktop.
  // Before the first poll lands, and on a box that isn't SteamOS-like, the flag
  // is false and the segment stays -- "never hide a tab on a guess", the same
  // rule the tab layout uses for caps-gated tabs.
  const inGameMode = !hasDesktop;
  // The segments this box actually has. Mode cycling walks THIS list, not
  // MODES, so a swipe can never land on a segment that isn't rendered.
  const modes = useMemo(
    () => MODES.filter(
      (m) => (m.key !== 'menus' || (hasSteamMenus && inGameMode))
        && (m.key !== 'gamepad' || !keyboardMode),
    ),
    [hasSteamMenus, inGameMode, keyboardMode],
  );
  const desk = useCallback(
    (name: DesktopKey | 'esc') => () =>
      name === 'esc' ? client.sendKey('esc') : client.sendDesktopKey(name),
    [client],
  );

  // Pad-layout prefs: every optional row/view can be hidden in Setup.
  const showMouseRow = usePref('padMouseRow');
  const showSteamRow = usePref('padSteamRow');
  const showDesktopNav = usePref('padDesktopNav');
  const showWinShortcuts = usePref('padWinShortcuts');
  const showKeyboardBar = usePref('padKeyboardBar');
  // Auto-raise the phone keyboard when the box raises its own. The counter is
  // what KeyboardBar watches; the ref lets the (memoised) socket callback read
  // the current pref without re-subscribing.
  const autoKeyboard = usePref('autoKeyboard');
  const autoKeyboardRef = useRef(autoKeyboard);
  autoKeyboardRef.current = autoKeyboard;
  const [oskSignal, setOskSignal] = useState(0);

  const trig = useCallback(
    (k: TriggerKey) => ({
      onDown: () => client.sendTrigger(k, 255),
      onUp: () => client.sendTrigger(k, 0),
    }),
    [client],
  );

  const stickMove = useCallback(
    (k: StickKey) => (x: number, y: number) => client.sendStick(k, x, y),
    [client],
  );
  const stickRelease = useCallback(
    (k: StickKey) => () => client.sendStick(k, 0, 0),
    [client],
  );

  const setMode = useCallback(
    (m: PadMode) => {
      if (m !== mode) {
        haptic();
        setLocalMode(m); // keeps the toggle live with no box paired
        update({ padMode: m }).catch(() => {});
      }
    },
    [mode, update],
  );

  // Horizontal swipe on the keyboard bar cycles PAD -> SWIPE -> TRACK -> REMOTE
  // (wrapping), matching the segmented control's order.
  const cycleMode = useCallback(
    (dir: 1 | -1) => {
      const i = modes.findIndex((m) => m.key === mode);
      const from = i < 0 ? 0 : i;
      setMode(modes[(from + dir + modes.length) % modes.length].key);
    },
    [mode, setMode, modes],
  );

  // Bounce off a mode this box can't serve -- the persisted padMode may say
  // 'menus' from another box, or the capability may have gone away.
  //
  // Gate on `loading`, NOT on `data !== undefined`: usePoll initialises data to
  // NULL, so an undefined-check is true on the very first render and bounced
  // straight off 'menus' before the fetch had a chance to land. A box whose
  // saved mode IS 'menus' then never opened on it. `loading` is documented as
  // "true while the very first request is in flight", which is exactly the
  // "don't judge yet" signal this needs.
  useEffect(() => {
    if (mode !== 'menus') return;
    // Fling the box to the desktop while sitting on this tab and it must let go
    // immediately -- that is a live session switch, not a stale capability.
    if (!inGameMode) {
      setMode('remote');
      return;
    }
    if (!menusPoll.loading && !hasSteamMenus) setMode('remote');
  }, [mode, hasSteamMenus, inGameMode, menusPoll.loading, setMode]);

  // Swipe mode drives the d-pad as an EXPLICIT hold, not a fire-and-forget
  // pulse.
  //
  // Why this is a state machine and not `press; setTimeout(release, 50)`:
  // the agent's d-pad is a LATCHED ABSOLUTE AXIS (ABS_HAT0X/Y), not an
  // edge-triggered key — see DPAD_MAP in agent/couchsided.py. Nothing on either
  // side ever re-zeroes it: there is no stuck-button watchdog, and the 12s idle
  // reap cannot fire while the app is pinging every 5s. So exactly ONE missing
  // `v:0` pins the axis and Steam auto-repeats it forever, which is the "swipe
  // sticks and keeps going that direction" bug.
  //
  // The old emitter lost that release in two ways. (1) Steps are DISTANCE-gated
  // but the release was TIME-gated at a fixed 50ms, so any finger faster than
  // ~1 px/ms re-pressed before the release fired — the hat was already held
  // continuously for the whole gesture, which is why the feature appeared to
  // work at all. (2) Every outstanding release lived in a setTimeout, so a
  // stalled JS thread simply never sent it. Measured on a real iPhone: the
  // session was reaped after ~12s of silence, meaning the app missed two
  // consecutive 5s pings — the same stall that swallowed the release.
  //
  // Now: assert once, re-arm while stepping, and ALWAYS release on gesture end
  // (see SwipeSurface's onPanResponderRelease/Terminate). Switching axis
  // releases the previous key first, because a stale axis is exactly what a
  // perpendicular swipe cannot clear.
  const dpadHeld = useRef<{ key: DpadKey | null; timer: ReturnType<typeof setTimeout> | null }>({
    key: null,
    timer: null,
  });
  const dpadRelease = useCallback(() => {
    if (keyboardMode) return;   // nothing was ever held down
    const h = dpadHeld.current;
    if (h.timer) {
      clearTimeout(h.timer);
      h.timer = null;
    }
    if (h.key) {
      client.sendButton(h.key, 0);
      h.key = null;
    }
  }, [client, keyboardMode]);
  const dpadStep = useCallback(
    (k: DpadKey) => {
      // Keyboard mode: one arrow-key TAP per step. Steam moves one row per tap,
      // so there is nothing to latch and nothing to release -- which also
      // removes this surface's whole class of stuck-direction bugs.
      if (keyboardMode) {
        client.sendKey(SWIPE_KEY[k]);
        return;
      }
      const h = dpadHeld.current;
      if (h.timer) clearTimeout(h.timer);
      if (h.key !== k) {
        // Release the old direction before asserting the new one, so a
        // direction change can never leave the previous axis latched.
        if (h.key) client.sendButton(h.key, 0);
        client.sendButton(k, 1);
        h.key = k;
      }
      // Safety net only: the authoritative release is the gesture-end handler.
      // Kept so a terminated gesture that somehow skips both handlers still
      // lets go, rather than latching for good.
      h.timer = setTimeout(() => {
        h.timer = null;
        if (h.key) {
          client.sendButton(h.key, 0);
          h.key = null;
        }
      }, 250);
    },
    [client, keyboardMode],
  );
  const selectTap = useCallback(() => {
    haptic();
    if (keyboardMode) {
      client.sendKey('enter');
      return;
    }
    client.sendButton('a', 1);
    setTimeout(() => client.sendButton('a', 0), 50);
  }, [client, keyboardMode]);

  // Trackpad handlers (protocol v2 mouse).
  // Drags emit a subtle "texture" tick per TP_HAPTIC_PX of pointer travel,
  // like detents under the finger, so moving the mouse feels alive without
  // buzzing continuously. Scroll ticks once per wheel notch.
  const tpHapticAcc = useRef(0);
  const tpMove = useCallback(
    (dx: number, dy: number) => {
      client.sendMouseMove(dx, dy);
      tpHapticAcc.current += Math.hypot(dx, dy);
      if (tpHapticAcc.current >= TP_HAPTIC_PX) {
        tpHapticAcc.current = 0;
        haptic();
      }
    },
    [client],
  );
  const tpLeft = useCallback(() => {
    haptic();
    client.sendMouseButton('l', 1);
    setTimeout(() => client.sendMouseButton('l', 0), 40);
  }, [client]);
  const tpRight = useCallback(() => {
    haptic();
    client.sendMouseButton('r', 1);
    setTimeout(() => client.sendMouseButton('r', 0), 40);
  }, [client]);
  const tpScroll = useCallback(
    (notches: number) => {
      if (notches !== 0) haptic();
      client.sendWheel(notches);
    },
    [client],
  );
  // Double-tap-drag marquee: hold the left button down for the whole drag so a
  // file manager rubber-bands a multi-item selection.
  const tpDragStart = useCallback(() => {
    haptic();
    client.sendMouseButton('l', 1);
  }, [client]);
  const tpDragEnd = useCallback(() => {
    client.sendMouseButton('l', 0);
  }, [client]);

  // Keyboard handlers (protocol v2 keyboard).
  const kbText = useCallback((s: string) => client.sendText(s), [client]);
  const kbBackspace = useCallback(() => client.sendKey('backspace'), [client]);
  const kbEnter = useCallback(() => client.sendKey('enter'), [client]);

  const keyboardBar = showKeyboardBar ? (
    <KeyboardBar
      onText={kbText}
      onBackspace={kbBackspace}
      onEnter={kbEnter}
      onSwipeMode={cycleMode}
      autoOpenSignal={oskSignal}
    />
  ) : null;

  return (
    <View
      style={[
        styles.screen,
        { paddingTop: 10, paddingBottom: Math.max(insets.bottom, 10) },
      ]}>
      {/* Header: status pill + input-mode toggle (all modes) */}
      <Pressable onPress={retry} style={styles.pill} hitSlop={8}>
        <View style={[styles.pillDot, { backgroundColor: STATUS_COLOR[status] }]} />
        <Text style={styles.pillText} numberOfLines={1}>
          {status === 'waiting' && canForce
            ? 'no response · tap to take control'
            : statusLabel(status, dev)}
        </Text>
      </Pressable>
      <View style={styles.modeToggle}>
        {modes.map((m) => (
          <Pressable
            key={m.key}
            onPress={() => setMode(m.key)}
            style={[styles.modeSeg, mode === m.key && styles.modeSegActive]}>
            <Text
              numberOfLines={1}
              style={[styles.modeSegText, mode === m.key && styles.modeSegTextActive]}>
              {m.label}
            </Text>
          </Pressable>
        ))}
      </View>

      {inputBlocked != null && status === 'connected' && (
        <View style={styles.inputBlockedBar}>
          <Text style={styles.inputBlockedText} numberOfLines={2}>
            {'⚠  '}
            {inputBlocked}
          </Text>
        </View>
      )}

      {/* Handoff prompt: another phone wants control of this box. */}
      {controlReq != null && (
        <View style={styles.handoffBar}>
          <Text style={styles.handoffText} numberOfLines={2}>
            {controlReq} wants control
          </Text>
          <View style={styles.handoffBtns}>
            <Pressable
              onPress={() => {
                haptic();
                client.denyControl();
                setControlReq(null);
              }}
              style={({ pressed }) => [styles.handoffBtn, pressed && styles.btnPressed]}>
              <Text style={styles.handoffBtnText}>KEEP</Text>
            </Pressable>
            <Pressable
              onPress={() => {
                haptic();
                client.grantControl();
                setControlReq(null);
              }}
              style={({ pressed }) => [
                styles.handoffBtn,
                styles.handoffBtnPass,
                pressed && styles.btnPressed,
              ]}>
              <Text style={[styles.handoffBtnText, styles.handoffBtnPassText]}>PASS</Text>
            </Pressable>
          </View>
        </View>
      )}

      {mode === 'menus' ? (
        // MUST scroll: TabScreen's body is a plain View, and this list is ~16
        // chips across five sections -- taller than the pane on a phone. The
        // Actions tab gets scrolling from its own ScrollView; Pad has none, so
        // without this the bottom sections are unreachable.
        <>
          <ScrollView
            style={styles.menusScroll}
            contentContainerStyle={styles.menusContent}
            showsVerticalScrollIndicator={false}>
            <SteamMenusPanel menus={steamMenus} />
          </ScrollView>
          {/* The mode-switch swipe lives on this bar, so a segment that omits it
              is a segment you cannot swipe out of — Steam was the only one, and
              it stranded people until they found the tab row. It sits BELOW the
              ScrollView, so vertical scrolling of the menus and the bar's
              horizontal swipe never contend. */}
          {keyboardBar}
        </>
      ) : mode === 'remote' ? (
        <>
          <RemoteView client={client} settings={settings} />
          {keyboardBar}
        </>
      ) : mode === 'swipe' ? (
        <>
          {/* Apple-TV-remote style: big swipe/tap surface + three big buttons */}
          <SwipeSurface onStep={dpadStep} onStepEnd={dpadRelease} onSelect={selectTap} />
          <View style={styles.swipeBtnRow}>
            <PadButton
              label="‹ BACK"
              {...(keyboardMode
                ? { onDown: () => client.sendKey('esc'), onUp: NOOP }
                : btn('b'))}
              style={styles.swipeBtn}
              color={t.red}
              fontSize={12}
            />
            {/* STEAM, QAM and MENU all ride gamepad buttons. Steam Game Mode
                exposes no keyboard equivalent for any of them -- Ctrl+1/Ctrl+2
                fired once on the box and then failed to reproduce -- so in
                keyboard mode they are removed rather than left to do nothing. */}
            {!keyboardMode && (
              <>
                <PadButton
                  label="STEAM"
                  {...btn('guide')}
                  style={[styles.swipeBtn, styles.guideBtn]}
                  color={t.blue}
                  fontSize={12}
                />
                <PadButton
                  label="⋯"
                  onDown={qam}
                  onUp={NOOP}
                  style={[styles.swipeBtn, styles.guideBtn]}
                  color={t.blue}
                  fontSize={26}
                />
                <PadButton label="MENU" {...btn('start')} style={styles.swipeBtn} fontSize={12} />
              </>
            )}
          </View>
          {keyboardBar}
        </>
      ) : mode === 'trackpad' ? (
        <>
          {/* Relative-mouse surface + a mouse-button row + keyboard */}
          <Trackpad
            onMove={tpMove}
            onLeftClick={tpLeft}
            onRightClick={tpRight}
            onScroll={tpScroll}
            onDragStart={tpDragStart}
            onDragEnd={tpDragEnd}
          />
          {(showMouseRow || showSteamRow) && (
            <View style={styles.swipeBtnRow}>
              {showMouseRow && (
                <>
                  {/* Spelled out rather than L/M/R. Reported as unclear, and
                      Ionicons has no honest left/middle/right-click glyph — a
                      vague icon would trade one guessing game for another. */}
                  <PadButton
                    label="LEFT"
                    onDown={() => client.sendMouseButton('l', 1)}
                    onUp={() => client.sendMouseButton('l', 0)}
                    style={styles.tpBtn}
                    fontSize={11}
                  />
                  <PadButton
                    label="MID"
                    onDown={() => client.sendMouseButton('m', 1)}
                    onUp={() => client.sendMouseButton('m', 0)}
                    style={styles.tpBtn}
                    fontSize={11}
                  />
                  <PadButton
                    label="RIGHT"
                    onDown={() => client.sendMouseButton('r', 1)}
                    onUp={() => client.sendMouseButton('r', 0)}
                    style={styles.tpBtn}
                    fontSize={11}
                  />
                  {/* Esc ONLY when the desktop-nav row below isn't providing
                      one. That row is gated on hasDesktop && showDesktopNav, so
                      in Game Mode this screen had no way out at all — but
                      showing it unconditionally puts two identical ESC keys on
                      screen, which is the same duplication complaint this pass
                      exists to fix. */}
                  {!(hasDesktop && showDesktopNav) && (
                    <PadButton
                      label="ESC"
                      onDown={desk('esc')}
                      onUp={NOOP}
                      style={styles.tpBtn}
                      fontSize={11}
                    />
                  )}
                </>
              )}
              {showSteamRow && (
                <>
                  <PadButton
                    label="STEAM"
                    {...btn('guide')}
                    style={[styles.tpBtn, styles.tpBtnWide, styles.guideBtn]}
                    color={t.blue}
                    fontSize={11}
                  />
                  <PadButton
                    label="⋯"
                    onDown={qam}
                    onUp={NOOP}
                    style={[styles.tpBtn, styles.guideBtn]}
                    color={t.blue}
                    fontSize={22}
                  />
                </>
              )}
            </View>
          )}
          {/* Plasma desktop nav — SteamOS/Bazzite boxes on the desktop only. */}
          {hasDesktop && showDesktopNav && (
            <View style={styles.swipeBtnRow}>
              <PadButton label="START" onDown={desk('meta')} onUp={NOOP}
                style={[styles.tpBtn, styles.tpBtnWide]} fontSize={11} />
              <PadButton label="OVERVIEW" onDown={desk('overview')} onUp={NOOP}
                style={[styles.tpBtn, styles.tpBtnWide]} fontSize={11} />
              <PadButton label="ESC" onDown={desk('esc')} onUp={NOOP}
                style={styles.tpBtn} fontSize={11} />
            </View>
          )}
          {/* Windows desktop shortcuts — one-shot chords, ViGEm boxes only. */}
          {isWindows && showWinShortcuts && (
            <View style={styles.swipeBtnRow}>
              <PadButton label="⊞ WIN" onDown={sys('win')} onUp={NOOP}
                style={[styles.tpBtn, styles.tpBtnWide]} fontSize={12} />
              <PadButton label="ALT+TAB" onDown={sys('alt-tab')} onUp={NOOP}
                style={[styles.tpBtn, styles.tpBtnWide]} fontSize={11} />
              <PadButton label="LOCK" onDown={sys('lock')} onUp={NOOP}
                style={styles.tpBtn} fontSize={11} />
              <PadButton label="TASK" onDown={sys('taskmgr')} onUp={NOOP}
                style={styles.tpBtn} fontSize={11} />
            </View>
          )}
          {keyboardBar}
        </>
      ) : landscape ? (
        // ---------- Landscape gamepad: real-controller spread ----------
        <View style={styles.landRoot}>
          {/* Bumpers/triggers along the top */}
          <View style={styles.landShoulderRow}>
            <View style={styles.landShoulderSide}>
              <PadButton label="LT" {...trig('lt')} style={styles.shoulderBtn} />
              <PadButton label="LB" {...btn('lb')} style={styles.shoulderBtn} />
            </View>
            <View style={styles.landShoulderSide}>
              <PadButton label="RB" {...btn('rb')} style={styles.shoulderBtn} />
              <PadButton label="RT" {...trig('rt')} style={styles.shoulderBtn} />
            </View>
          </View>

          <View style={styles.landMain}>
            {/* LEFT: stick above d-pad */}
            <View style={styles.landColumn}>
              <Stick onMove={stickMove('l')} onRelease={stickRelease('l')} />
              <View style={styles.dpad}>
                <View style={styles.dpadRow}>
                  <View style={styles.dpadSpacer} />
                  <PadButton label="▲" {...btn('du')} style={styles.dpadBtn} />
                  <View style={styles.dpadSpacer} />
                </View>
                <View style={styles.dpadRow}>
                  <PadButton label="◀" {...btn('dl')} style={styles.dpadBtn} />
                  {/* Center OK = A: opens/activates the highlighted item. */}
                  <PadButton label="OK" {...btn('a')} style={styles.dpadBtn} color={t.green} fontSize={14} />
                  <PadButton label="▶" {...btn('dr')} style={styles.dpadBtn} />
                </View>
                <View style={styles.dpadRow}>
                  <View style={styles.dpadSpacer} />
                  <PadButton label="▼" {...btn('dd')} style={styles.dpadBtn} />
                  <View style={styles.dpadSpacer} />
                </View>
              </View>
            </View>

            {/* CENTER: menu cluster + thumb-clicks */}
            <View style={styles.landCenter}>
              <View style={styles.menuRow}>
                <PadButton label="SELECT" {...btn('select')} style={styles.menuBtn} fontSize={11} />
                <PadButton
                  label="STEAM"
                  {...btn('guide')}
                  style={[styles.menuBtn, styles.guideBtn]}
                  color={t.blue}
                  fontSize={11}
                />
                <PadButton
                  label="⋯"
                  onDown={qam}
                  onUp={NOOP}
                  style={[styles.menuBtn, styles.qamBtn, styles.guideBtn]}
                  color={t.blue}
                  fontSize={20}
                />
                <PadButton label="START" {...btn('start')} style={styles.menuBtn} fontSize={11} />
              </View>
              <View style={styles.landThumbRow}>
                <PadButton label="L3" {...btn('l3')} style={styles.thumbBtn} fontSize={11} />
                <PadButton label="R3" {...btn('r3')} style={styles.thumbBtn} fontSize={11} />
              </View>
            </View>

            {/* RIGHT: ABXY above right stick */}
            <View style={styles.landColumn}>
              <View style={styles.abxy}>
                <View style={styles.abxyRow}>
                  <View style={styles.faceSpacer} />
                  <PadButton label="Y" {...btn('y')} style={styles.faceBtn} color={t.amber} />
                  <View style={styles.faceSpacer} />
                </View>
                <View style={styles.abxyRow}>
                  <PadButton label="X" {...btn('x')} style={styles.faceBtn} color={t.blue} />
                  <View style={styles.faceSpacer} />
                  <PadButton label="B" {...btn('b')} style={styles.faceBtn} color={t.red} />
                </View>
                <View style={styles.abxyRow}>
                  <View style={styles.faceSpacer} />
                  <PadButton label="A" {...btn('a')} style={styles.faceBtn} color={t.green} />
                  <View style={styles.faceSpacer} />
                </View>
              </View>
              <Stick onMove={stickMove('r')} onRelease={stickRelease('r')} />
            </View>
          </View>
        </View>
      ) : (
        // ---------- Portrait gamepad: original stacked layout ----------
        <>
          {/* Top row: triggers + bumpers */}
          <View style={styles.topRow}>
            <PadButton label="LT" {...trig('lt')} style={styles.shoulderBtn} />
            <PadButton label="LB" {...btn('lb')} style={styles.shoulderBtn} />
            <View style={styles.topSpacer} />
            <PadButton label="RB" {...btn('rb')} style={styles.shoulderBtn} />
            <PadButton label="RT" {...trig('rt')} style={styles.shoulderBtn} />
          </View>

          {/* Middle row: select / guide / start */}
          <View style={styles.menuRow}>
            <PadButton label="SELECT" {...btn('select')} style={styles.menuBtn} fontSize={11} />
            <PadButton
              label="STEAM"
              {...btn('guide')}
              style={[styles.menuBtn, styles.guideBtn]}
              color={t.blue}
              fontSize={11}
            />
            <PadButton
              label="⋯"
              onDown={qam}
              onUp={NOOP}
              style={[styles.menuBtn, styles.qamBtn, styles.guideBtn]}
              color={t.blue}
              fontSize={20}
            />
            <PadButton label="START" {...btn('start')} style={styles.menuBtn} fontSize={11} />
          </View>

          {/* Main clusters: d-pad left, ABXY right */}
          <View style={styles.clusterRow}>
            <View style={styles.dpad}>
              <View style={styles.dpadRow}>
                <View style={styles.dpadSpacer} />
                <PadButton label="▲" {...btn('du')} style={styles.dpadBtn} />
                <View style={styles.dpadSpacer} />
              </View>
              <View style={styles.dpadRow}>
                <PadButton label="◀" {...btn('dl')} style={styles.dpadBtn} />
                {/* Center OK = A: opens/activates the highlighted item. */}
                <PadButton label="OK" {...btn('a')} style={styles.dpadBtn} color={t.green} fontSize={14} />
                <PadButton label="▶" {...btn('dr')} style={styles.dpadBtn} />
              </View>
              <View style={styles.dpadRow}>
                <View style={styles.dpadSpacer} />
                <PadButton label="▼" {...btn('dd')} style={styles.dpadBtn} />
                <View style={styles.dpadSpacer} />
              </View>
            </View>

            <View style={styles.abxy}>
              <View style={styles.abxyRow}>
                <View style={styles.faceSpacer} />
                <PadButton label="Y" {...btn('y')} style={styles.faceBtn} color={t.amber} />
                <View style={styles.faceSpacer} />
              </View>
              <View style={styles.abxyRow}>
                <PadButton label="X" {...btn('x')} style={styles.faceBtn} color={t.blue} />
                <View style={styles.faceSpacer} />
                <PadButton label="B" {...btn('b')} style={styles.faceBtn} color={t.red} />
              </View>
              <View style={styles.abxyRow}>
                <View style={styles.faceSpacer} />
                <PadButton label="A" {...btn('a')} style={styles.faceBtn} color={t.green} />
                <View style={styles.faceSpacer} />
              </View>
            </View>
          </View>

          {/* Bottom corners: analog sticks with thumb-click buttons beside them */}
          <View style={styles.stickRow}>
            <View style={styles.stickGroup}>
              <Stick onMove={stickMove('l')} onRelease={stickRelease('l')} />
              <PadButton label="L3" {...btn('l3')} style={styles.thumbBtn} fontSize={11} />
            </View>
            <View style={styles.stickGroup}>
              <PadButton label="R3" {...btn('r3')} style={styles.thumbBtn} fontSize={11} />
              <Stick onMove={stickMove('r')} onRelease={stickRelease('r')} />
            </View>
          </View>
          {keyboardBar}
        </>
      )}

      {/* Another phone holds input for this box: every gesture on the surfaces
          below is silently dropped by the agent, and the pill alone proved too
          subtle to notice (a user debugged a "dead trackpad" for an hour while
          waiting). Cover the surface with an explicit takeover card. The
          overlay swallows touches by design — the input it blocks was going
          nowhere anyway. */}
      {/* NOT in remote mode: that surface drives the TV over HTTP, which works
          regardless of who holds the box's gamepad — covering it would block a
          living control. The pill still shows the handoff state there. */}
      {mode !== 'remote' && (status === 'waiting' || status === 'released') && (
        <View style={styles.waitOverlay} pointerEvents="auto">
          <View style={styles.waitCard}>
            <Ionicons name="phone-portrait-outline" size={28} color={t.amber} />
            <Text style={styles.waitTitle}>
              {dev ? `${dev} has control` : 'Another phone has control'}
            </Text>
            <Text style={styles.waitSub}>
              Your input is paused while the other phone drives this box.
            </Text>
            <Pressable
              onPress={retry}
              style={({ pressed }) => [styles.waitBtn, pressed && styles.btnPressed]}>
              <Text style={styles.waitBtnText}>
                {status === 'waiting' && canForce ? 'TAKE CONTROL' : 'REQUEST CONTROL'}
              </Text>
            </Pressable>
            {status === 'waiting' && !canForce && (
              <Text style={styles.waitHint}>
                They&apos;ll get a Pass / Keep prompt.
              </Text>
            )}
          </View>
        </View>
      )}
    </View>
  );
}

const makeStyles = (t: Palette) => StyleSheet.create({
  // Steam-menus mode scrolls on its own; TabScreen's body does not.
  menusScroll: { flex: 1 },
  menusContent: { paddingBottom: 16 },
  screen: {
    flex: 1,
    backgroundColor: t.bg,
    paddingHorizontal: 12,
    justifyContent: 'space-between',
  },

  // "Another phone has control" takeover. Covers the input surfaces (which are
  // functionally dead in this state) but NOT the header row, so the mode
  // toggle and pill stay reachable above it.
  waitOverlay: {
    position: 'absolute',
    left: 0,
    right: 0,
    top: 64,
    bottom: 0,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: t.bg + 'E6',
  },
  waitCard: {
    alignItems: 'center',
    backgroundColor: t.card,
    borderColor: t.cardBorder,
    borderWidth: 1,
    borderRadius: 16,
    paddingVertical: 22,
    paddingHorizontal: 26,
    maxWidth: 320,
    gap: 8,
  },
  waitTitle: {
    color: t.text,
    fontSize: 17,
    fontWeight: '700',
    textAlign: 'center',
  },
  waitSub: {
    color: t.textDim,
    fontSize: 13,
    textAlign: 'center',
  },
  waitBtn: {
    marginTop: 8,
    backgroundColor: t.blue,
    borderRadius: 10,
    paddingVertical: 10,
    paddingHorizontal: 22,
  },
  waitBtnText: {
    color: '#08101f',
    fontSize: 13,
    fontWeight: '800',
    letterSpacing: 1,
  },
  waitHint: {
    color: t.textFaint,
    fontSize: 11,
    textAlign: 'center',
  },

  btn: {
    backgroundColor: t.card,
    borderColor: t.cardBorder,
    borderWidth: 1,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  btnPressed: {
    backgroundColor: t.inset,
    borderColor: t.blue,
  },
  btnText: {
    color: t.textDim,
    fontFamily: mono,
    fontSize: 14,
    fontWeight: '700',
    letterSpacing: 1,
  },

  // The status pill and the mode toggle used to SHARE one row. With five
  // segments that squeezed the pill to "connecti..." and cramped the tabs at
  // the same time. They are stacked now, each spanning the full width, which
  // makes the status readable and lets the segments spread evenly.

  modeToggle: {
    flexDirection: 'row',
    marginBottom: 10,
    backgroundColor: t.inset,
    borderColor: t.cardBorder,
    borderWidth: 1,
    borderRadius: 999,
    padding: 3,
    gap: 2,
    // A fifth segment (STEAM) overflowed the row on narrow screens and the
    // label was clipped off the right edge. Let the group and its segments
    // shrink instead of running off.
    flexShrink: 1,
  },
  modeSeg: {
    // Full width now, so each segment takes an equal share instead of being
    // sized by its label -- even spacing and a bigger tap target.
    flex: 1,
    alignItems: 'center',
    paddingVertical: 6,
    paddingHorizontal: 4,
    borderRadius: 999,
  },
  modeSegActive: {
    backgroundColor: t.card,
  },
  modeSegText: {
    color: t.textFaint,
    fontFamily: mono,
    fontSize: 10,
    fontWeight: '700',
    letterSpacing: 0.5,
  },
  modeSegTextActive: {
    color: t.blue,
  },

  swipeSurface: {
    flex: 1,
    backgroundColor: t.card,
    borderColor: t.cardBorder,
    borderWidth: 1,
    borderRadius: 24,
    alignItems: 'center',
    justifyContent: 'flex-end',
    padding: 18,
  },
  trackpadSurface: {
    flex: 1,
    backgroundColor: t.card,
    borderColor: t.cardBorder,
    borderWidth: 1,
    borderRadius: 24,
    alignItems: 'center',
    justifyContent: 'flex-end',
    padding: 18,
  },
  swipeHint: {
    color: t.textFaint,
    fontFamily: mono,
    fontSize: 11,
    textAlign: 'center',
  },
  swipeBtnRow: {
    flexDirection: 'row',
    justifyContent: 'center',
    gap: 12,
    marginTop: 14,
  },
  swipeBtn: {
    flex: 1,
    maxWidth: 140,
    height: 64,
    borderRadius: 999,
  },
  // Trackpad button row: five buttons (L/M/R click + Steam + QAM) share the
  // width evenly — single-character labels so nothing wraps on narrow phones.
  tpBtn: {
    flex: 1,
    height: 64,
    borderRadius: 999,
  },
  tpBtnWide: { flex: 1.6 },

  // Keyboard bar
  kbBarRow: {
    marginTop: 12,
    flexDirection: 'row',
    alignItems: 'stretch',
    gap: 8,
  },
  kbBar: {
    backgroundColor: t.card,
    borderColor: t.cardBorder,
    borderWidth: 1,
    borderRadius: 999,
    paddingVertical: 12,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
  },
  kbBarFlex: {
    flex: 1,
  },
  kbBarOpen: {
    borderColor: t.blue,
    backgroundColor: t.inset,
  },
  kbDragHandle: {
    width: 36,
    height: 4,
    borderRadius: 2,
    backgroundColor: t.blue,
    opacity: 0.5,
    marginBottom: 6,
  },
  kbDone: {
    backgroundColor: t.blue,
    borderRadius: 999,
    paddingHorizontal: 20,
    alignItems: 'center',
    justifyContent: 'center',
  },
  kbDoneText: {
    color: '#0b1220',
    fontFamily: mono,
    fontSize: 13,
    fontWeight: '800',
    letterSpacing: 1,
  },
  // Floating keyboard dismiss: anchored bottom-right; kbLift raises it just
  // above the measured keyboard top.
  // Bottom-edge marker for the keyboard-lift measurement.
  kbAnchor: {
    position: 'absolute',
    bottom: 0,
    right: 0,
    width: 1,
    height: 1,
  },
  kbFloatWrap: {
    position: 'absolute',
    right: 14,
    zIndex: 60,
    elevation: 6,
  },
  kbFloatDone: {
    backgroundColor: t.blue,
    borderRadius: 999,
    paddingVertical: 12,
    paddingHorizontal: 18,
    shadowColor: '#000',
    shadowOpacity: 0.35,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 2 },
  },
  // Edge chevrons on the closed bar: the horizontal mode-switch swipe cue.
  kbSwipeCue: {
    color: t.textFaint,
    fontFamily: mono,
    fontSize: 16,
    fontWeight: '700',
    paddingHorizontal: 14,
  },
  kbBarText: {
    color: t.textDim,
    fontFamily: mono,
    fontSize: 12,
    fontWeight: '700',
    letterSpacing: 1,
  },
  kbAccessory: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 12,
    paddingVertical: 8,
    backgroundColor: t.inset,
    borderTopWidth: 1,
    borderTopColor: t.cardBorder,
  },
  kbAccessoryHint: {
    color: t.textDim,
    fontFamily: mono,
    fontSize: 12,
    fontWeight: '700',
    letterSpacing: 1,
  },
  kbAccessoryDone: {
    paddingVertical: 8,
  },
  inputBlockedBar: {
    marginTop: 8,
    backgroundColor: 'rgba(251, 191, 36, 0.12)',
    borderColor: t.amber,
    borderWidth: 1,
    borderRadius: 10,
    paddingVertical: 8,
    paddingHorizontal: 12,
  },
  handoffBar: {
    marginTop: 8,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 10,
    backgroundColor: 'rgba(96,165,250,0.12)',
    borderColor: t.blue,
    borderWidth: 1,
    borderRadius: 10,
    paddingVertical: 8,
    paddingHorizontal: 12,
  },
  handoffText: { flex: 1, color: t.text, fontSize: 13, fontWeight: '600' },
  handoffBtns: { flexDirection: 'row', gap: 8 },
  handoffBtn: {
    paddingVertical: 8,
    paddingHorizontal: 16,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: t.cardBorder,
    backgroundColor: t.card,
  },
  handoffBtnPass: { backgroundColor: t.blue, borderColor: t.blue },
  handoffBtnText: {
    color: t.textDim,
    fontFamily: mono,
    fontSize: 12,
    fontWeight: '800',
    letterSpacing: 1,
  },
  handoffBtnPassText: { color: '#0b1220' },
  inputBlockedText: {
    color: t.amber,
    fontFamily: mono,
    fontSize: 12,
    fontWeight: '700',
    lineHeight: 16,
  },
  kbBarTextOpen: {
    color: t.blue,
  },
  // The same input as hiddenInput, wearing its visible clothes. Sits above the
  // raised keyboard (its `bottom` is set inline from the measured lift) so it is
  // long-pressable — which is what makes iOS offer Paste at all.
  kbCompose: {
    position: 'absolute',
    left: 14,
    right: 14,
    zIndex: 61,
    elevation: 7,
    backgroundColor: t.card,
    borderColor: t.blue,
    borderWidth: 1,
    borderRadius: 12,
    paddingVertical: 10,
    paddingHorizontal: 12,
    color: t.text,
    fontSize: 15,
    fontFamily: mono,
  },
  hiddenInput: {
    // Invisible but FOCUSABLE. iOS won't let a fully transparent (alpha 0) or
    // off-window view become first responder, so a hidden keyboard-capture
    // input must stay on-screen with a hair of opacity. Transparent text keeps
    // the captured keystrokes from ever being seen.
    position: 'absolute',
    bottom: 0,
    left: 0,
    width: 1,
    height: 1,
    opacity: 0.02,
    color: 'transparent',
  },

  topRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  topSpacer: {
    flex: 1,
  },
  shoulderBtn: {
    width: 60,
    height: 48,
  },
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    backgroundColor: t.inset,
    borderColor: t.cardBorder,
    borderWidth: 1,
    borderRadius: 999,
    marginBottom: 8,
    paddingVertical: 6,
    paddingHorizontal: 10,
    minWidth: 0,
  },
  pillDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  pillText: {
    color: t.textDim,
    fontFamily: mono,
    fontSize: 10,
    flexShrink: 1,
  },

  menuRow: {
    flexDirection: 'row',
    justifyContent: 'center',
    gap: 8,
    marginTop: 12,
  },
  menuBtn: {
    width: 80,
    height: 40,
    borderRadius: 999,
  },
  // Compact icon-only ⋯ (Quick Access) button; overrides menuBtn's width.
  qamBtn: {
    width: 48,
  },
  guideBtn: {
    borderColor: t.blue,
  },

  clusterRow: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginVertical: 10,
  },
  dpad: {
    gap: 4,
  },
  dpadRow: {
    flexDirection: 'row',
    gap: 4,
  },
  dpadBtn: {
    width: 58,
    height: 58,
  },
  dpadSpacer: {
    width: 58,
    height: 58,
  },
  abxy: {
    gap: 4,
  },
  abxyRow: {
    flexDirection: 'row',
    gap: 4,
    justifyContent: 'center',
  },
  faceBtn: {
    width: 58,
    height: 58,
    borderRadius: 29,
  },
  faceSpacer: {
    width: 58,
    height: 58,
  },

  stickRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-end',
  },
  stickGroup: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 8,
  },
  thumbBtn: {
    width: 44,
    height: 44,
    borderRadius: 22,
    marginBottom: 8,
  },
  stickPad: {
    width: STICK_SIZE,
    height: STICK_SIZE,
    borderRadius: STICK_SIZE / 2,
    backgroundColor: t.inset,
    borderColor: t.cardBorder,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  stickCross: {
    position: 'absolute',
    width: 10,
    height: 10,
    borderRadius: 5,
    backgroundColor: t.cardBorder,
  },
  stickNub: {
    width: NUB_SIZE,
    height: NUB_SIZE,
    borderRadius: NUB_SIZE / 2,
    backgroundColor: t.card,
    borderColor: t.blue,
    borderWidth: 1,
  },

  // ---------- Landscape gamepad layout ----------
  landRoot: {
    flex: 1,
  },
  landShoulderRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 8,
  },
  landShoulderSide: {
    flexDirection: 'row',
    gap: 8,
  },
  landMain: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  landColumn: {
    alignItems: 'center',
    justifyContent: 'center',
    gap: 14,
  },
  landCenter: {
    alignItems: 'center',
    justifyContent: 'center',
    gap: 16,
  },
  landThumbRow: {
    flexDirection: 'row',
    gap: 16,
  },
});
