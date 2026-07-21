/**
 * Visible touch indicators: a ring wherever a finger lands, and optionally a
 * trail of dots while it drags.
 *
 * iOS exposes NO public API for system-wide touch events. There is no equivalent
 * of Android's "Show taps", and no screen recorder — built-in, third-party, or a
 * ReplayKit broadcast extension — can draw where a finger landed in another app.
 * The only process that knows where the user tapped is the app itself, so the
 * app has to draw its own. That makes a recording of Couchside legible for the
 * store listing, for support screen-shares, and for demo footage.
 *
 * OBSERVE, NEVER STEAL — this is load-bearing. `TapCapture` must be an ANCESTOR
 * of what it draws over (it reads the responder system in the CAPTURE phase; it
 * is not a sibling overlay), and every responder handler returns `false` so the
 * touch still reaches whatever child would normally handle it. Get this wrong
 * and every button in the app breaks. Worse, this app's gesture surfaces (the
 * swipe d-pad, the trackpad, the mode-switch bar) all refuse to yield the
 * responder, and a gesture stolen mid-swipe is exactly what leaves the agent's
 * LATCHED d-pad axis asserted — see tests/test_dpad_latch.py for what that costs.
 *
 * The host View renders UNCONDITIONALLY, gated only internally on the pref. If
 * the wrapper appeared and disappeared with the pref, the navigator would remount
 * and the user would lose the screen they were about to record.
 *
 * MODAL CAVEAT: React Native <Modal> renders in its own native window ABOVE this
 * host, so its touches never reach these handlers. Every sheet in the app records
 * without indicators (CouchModeSheet, SleepTimerSheet, ScreensaverSheet,
 * BoxSwitcher, RemotePowerBar, ScreenPreview, RemoteView's text sheet). TapCapture
 * is exported so a sheet CAN wrap its own content, but the shipping sheets are
 * deliberately not wrapped: that is seven production files touched for a
 * recording aid, and the layout-regression risk is not worth it.
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import {
  Animated,
  Easing,
  StyleSheet,
  View,
  type GestureResponderEvent,
  type StyleProp,
  type ViewStyle,
} from 'react-native';

import { usePref } from '@/lib/prefs';
import { useResolvedScheme, useTheme } from '@/lib/theme';

type MarkKind = 'tap' | 'trail';
type MarkSpec = { id: number; x: number; y: number; kind: MarkKind };

const TAP_SIZE = 76;
const TRAIL_SIZE = 26;
const TAP_MS = 520;
const TRAIL_MS = 320;
/** Minimum gap between trail dots while a finger drags. Caps the React churn a
 *  fast scrub on the trackpad/swipe surface can cause to ~22 elements/sec. */
const TRAIL_INTERVAL_MS = 45;
/** Hard cap on live marks so a long drag can't grow the tree without bound. */
const MAX_MARKS = 32;

let nextMarkId = 0;

/**
 * Instrumentation for the drag-trail bug (see the note on onTouchMove below).
 * Counters only, no rendering cost. Readable from the web harness or a dev build
 * as `globalThis.__touchTrace`, which is how the responder-vs-touch question was
 * settled by measurement rather than by reading renderer source.
 */
export const touchTrace = {
  startCapture: 0,
  moveCapture: 0,
  touchMove: 0,
  marks: 0,
  lastPageX: null as number | null,
  lastPageY: null as number | null,
};
if (typeof globalThis !== 'undefined') {
  (globalThis as Record<string, unknown>).__touchTrace = touchTrace;
}

/** One ripple. Self-animating, self-retiring: calls `onDone` to be unmounted. */
function Mark({
  mark,
  ring,
  fill,
  onDone,
}: {
  mark: MarkSpec;
  ring: string;
  fill: string;
  onDone: () => void;
}) {
  const p = useRef(new Animated.Value(0)).current;
  // The removal callback is identity-unstable by design (it closes over the id);
  // holding it in a ref keeps the animation effect from re-running on re-render.
  const done = useRef(onDone);
  done.current = onDone;

  useEffect(() => {
    Animated.timing(p, {
      toValue: 1,
      duration: mark.kind === 'tap' ? TAP_MS : TRAIL_MS,
      easing: Easing.out(Easing.quad),
      useNativeDriver: true,
    }).start(() => done.current());
  }, [p, mark.kind]);

  const size = mark.kind === 'tap' ? TAP_SIZE : TRAIL_SIZE;
  const scale = p.interpolate({
    inputRange: [0, 1],
    // A tap blooms outward; a trail dot just shrinks slightly as it fades, so a
    // drag reads as a line of shrinking beads rather than a row of explosions.
    outputRange: mark.kind === 'tap' ? [0.35, 1] : [1, 0.7],
  });
  const opacity = p.interpolate({
    inputRange: [0, 0.15, 1],
    outputRange: [0.55, 0.95, 0],
  });

  return (
    <Animated.View
      pointerEvents="none"
      style={[
        styles.mark,
        {
          left: mark.x - size / 2,
          top: mark.y - size / 2,
          width: size,
          height: size,
          borderRadius: size / 2,
          borderWidth: mark.kind === 'tap' ? 3 : 2,
          borderColor: ring,
          backgroundColor: fill,
          opacity,
          transform: [{ scale }],
        },
      ]}
    />
  );
}

/** Wrap a subtree to paint touch indicators over it while the prefs are on. */
export function TapCapture({
  children,
  style,
}: {
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
}) {
  const on = usePref('showTaps');
  const trail = usePref('traceDrags');
  const t = useTheme();
  const scheme = useResolvedScheme();
  const [marks, setMarks] = useState<MarkSpec[]>([]);
  const lastTrailAt = useRef(0);

  const add = useCallback((pageX: number, pageY: number, kind: MarkKind) => {
    // Guard NaN/undefined explicitly: a mark at NaN renders nothing and would
    // look identical to "the handler never fired", which is exactly the
    // ambiguity that made this bug hard to place.
    if (!Number.isFinite(pageX) || !Number.isFinite(pageY)) return;
    touchTrace.marks += 1;
    touchTrace.lastPageX = pageX;
    touchTrace.lastPageY = pageY;
    setMarks((prev) => {
      const next = prev.concat({ id: nextMarkId++, x: pageX, y: pageY, kind });
      return next.length > MAX_MARKS ? next.slice(next.length - MAX_MARKS) : next;
    });
  }, []);

  const onStartCapture = useCallback(
    (e: GestureResponderEvent) => {
      touchTrace.startCapture += 1;
      if (on) add(e.nativeEvent.pageX, e.nativeEvent.pageY, 'tap');
      return false; // observe only — the child still becomes the responder
    },
    [on, add],
  );

  // Kept for instrumentation and as the trail's fallback path. On device this
  // fires far less than you would expect once a child owns the responder, which
  // is why the trail does NOT depend on it — see onTouchMove.
  const onMoveCapture = useCallback(() => {
    touchTrace.moveCapture += 1;
    return false;
  }, []);

  /**
   * THE DRAG-TRAIL FIX.
   *
   * The prototype drove the trail from onMoveShouldSetResponderCapture. On a
   * real iPhone that produced NOTHING while taps worked, because responder
   * NEGOTIATION is not re-run for an ancestor once a child owns the gesture and
   * refuses to give it up — and every surface worth tracing does exactly that
   * (useTrackpad and the swipe pad both set
   * onPanResponderTerminationRequest: () => false).
   *
   * onTouchMove is an ordinary BUBBLING touch event, dispatched independently of
   * responder negotiation, so a child holding the responder does not suppress
   * it. Taps stay on the capture handler, which is confirmed working; only the
   * trail moves here, which is the minimal change.
   */
  const onTouchMove = useCallback(
    (e: GestureResponderEvent) => {
      touchTrace.touchMove += 1;
      if (!on || !trail) return;
      const now = Date.now();
      if (now - lastTrailAt.current < TRAIL_INTERVAL_MS) return;
      lastTrailAt.current = now;
      add(e.nativeEvent.pageX, e.nativeEvent.pageY, 'trail');
    },
    [on, trail, add],
  );

  const remove = useCallback((id: number) => {
    setMarks((prev) => prev.filter((m) => m.id !== id));
  }, []);

  // Turning the pref off mid-recording clears instantly rather than leaving the
  // last ripple to finish its half-second fade.
  useEffect(() => {
    if (!on) setMarks([]);
  }, [on]);

  const fill = scheme === 'light' ? 'rgba(15,23,42,0.16)' : 'rgba(255,255,255,0.24)';

  return (
    <View
      style={style ?? styles.host}
      collapsable={false}
      onStartShouldSetResponderCapture={onStartCapture}
      onMoveShouldSetResponderCapture={onMoveCapture}
      onTouchMove={onTouchMove}
    >
      {children}
      {marks.length > 0 ? (
        <View style={StyleSheet.absoluteFill} pointerEvents="none">
          {marks.map((m) => (
            <Mark
              key={m.id}
              mark={m}
              ring={t.accent}
              fill={fill}
              onDone={() => remove(m.id)}
            />
          ))}
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  host: { flex: 1 },
  mark: {
    position: 'absolute',
    // Keeps a white-on-white / dark-on-dark ripple legible whatever screen it
    // lands on, which matters more here than anywhere else in the app: the
    // whole point of the ripple is to survive video compression.
    shadowColor: '#000',
    shadowOpacity: 0.35,
    shadowRadius: 4,
    shadowOffset: { width: 0, height: 1 },
  },
});
