/**
 * Visible touch indicators: a ring wherever a finger lands, and optionally a
 * stroke following the finger while it drags.
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
import { segmentBox, strokeRuns } from '@/lib/touchTrail';
import { useResolvedScheme, useTheme } from '@/lib/theme';

type MarkInput =
  | { kind: 'tap'; x: number; y: number }
  /** One straight run of the stroke, from (x,y) to (x2,y2). `order` is its
   *  index within the batch emitted by a single move event -- see Seg. */
  | { kind: 'seg'; x: number; y: number; x2: number; y2: number; order: number };
/** Split from MarkInput because `Omit<Union, 'id'>` collapses a union to its
 *  shared keys — which silently dropped x2/y2 from what the emitter accepted. */
type MarkSpec = MarkInput & { id: number };

const TAP_SIZE = 76;
const TAP_MS = 520;
/**
 * Stroke thickness, and how long a run of it stays on screen.
 *
 * This used to draw a DOT every TRAIL_STEP_PX, each shrinking as it faded. At
 * 20px spacing with 26px dots that should have overlapped into a line -- but
 * every dot started shrinking the moment it appeared, so by the time the finger
 * was a few steps further on the earlier ones had pulled apart into beads. On
 * video it read as a dotted trail, which is not what a drag looks like.
 *
 * Segments fix it structurally rather than by tuning: consecutive runs ABUT, so
 * there is no spacing to pull apart. They also carry no scale animation --
 * shrinking is what opened the gaps.
 */
const TRAIL_MS = 700;
/** Offset between runs emitted in the same frame, so a batch fades as a
 *  gradient instead of a block. Small enough that it never reads as lag. */
const TRAIL_STAGGER_MS = 45;
/** Glow blur radius, in px. Subtle on purpose: the stroke has to stay legible
 *  over game art and through video compression, and a wide halo just turns the
 *  line into a smudge. */
const GLOW_RADIUS = 9;
/** Hard cap on live marks so a long drag can't grow the tree without bound.
 *  At 20px per run this is ~960px of visible stroke. */
const MAX_MARKS = 48;

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
  mark: Extract<MarkSpec, { kind: 'tap' }>;
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
      duration: TAP_MS,
      easing: Easing.out(Easing.quad),
      useNativeDriver: true,
    }).start(() => done.current());
  }, [p]);

  const scale = p.interpolate({ inputRange: [0, 1], outputRange: [0.35, 1] });
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
          left: mark.x - TAP_SIZE / 2,
          top: mark.y - TAP_SIZE / 2,
          width: TAP_SIZE,
          height: TAP_SIZE,
          borderRadius: TAP_SIZE / 2,
          borderWidth: 3,
          borderColor: ring,
          backgroundColor: fill,
          opacity,
          transform: [{ scale }],
        },
      ]}
    />
  );
}

/** One run of the drag stroke. Fades in place — NO scale, see STROKE_W. */
function Seg({
  mark,
  color,
  onDone,
}: {
  mark: Extract<MarkSpec, { kind: 'seg' }>;
  color: string;
  onDone: () => void;
}) {
  const p = useRef(new Animated.Value(0)).current;
  const done = useRef(onDone);
  done.current = onDone;

  useEffect(() => {
    Animated.timing(p, {
      toValue: 1,
      duration: TRAIL_MS,
      // One move event can emit up to TRAIL_MAX_PER_EVENT runs in the SAME
      // frame. Without a stagger they fade in lockstep, so a fast drag renders
      // as ~120px blocks of uniform opacity with hard edges between them --
      // measured on a real Razr at 3x zoom, and it read as stacked rectangles
      // rather than a stroke. Offsetting each run inside its batch turns those
      // steps back into a gradient.
      delay: mark.order * TRAIL_STAGGER_MS,
      easing: Easing.out(Easing.quad),
      useNativeDriver: true,
    }).start(() => done.current());
  }, [p, mark.order]);

  const box = segmentBox(mark.x, mark.y, mark.x2, mark.y2);
  // Holds full strength for the first two thirds, then goes. The older end of
  // the stroke fading first is what makes it read as a direction of travel; a
  // linear fade from the first frame just makes the whole line dim.
  const opacity = p.interpolate({
    inputRange: [0, 0.65, 1],
    outputRange: [0.9, 0.85, 0],
  });

  return (
    <Animated.View
      pointerEvents="none"
      style={{
        position: 'absolute',
        left: box.left,
        top: box.top,
        width: box.width,
        height: box.height,
        backgroundColor: color,
        // The glow. boxShadow (not the deprecated shadow* props) is the one
        // form RN renders on BOTH platforms, and it costs no extra node -- the
        // alternative, a second wider translucent View per run, would double an
        // already 48-node tree on the latency-critical trackpad path.
        boxShadow: `0px 0px ${GLOW_RADIUS}px ${color}`,
        opacity,
        transform: [{ rotate: `${box.angle}rad` }],
      }}
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
  /** Last point a trail dot was laid at, or null between gestures. Nulling it on
   *  touch-down is what stops a new drag from drawing a line back to where the
   *  previous one ended. */
  const lastTrailPt = useRef<{ x: number; y: number } | null>(null);

  const push = useCallback((spec: MarkInput) => {
    touchTrace.marks += 1;
    setMarks((prev) => {
      const next = prev.concat({ ...spec, id: nextMarkId++ });
      return next.length > MAX_MARKS ? next.slice(next.length - MAX_MARKS) : next;
    });
  }, []);

  const add = useCallback((pageX: number, pageY: number) => {
    // Guard NaN/undefined explicitly: a mark at NaN renders nothing and would
    // look identical to "the handler never fired", which is exactly the
    // ambiguity that made this bug hard to place.
    if (!Number.isFinite(pageX) || !Number.isFinite(pageY)) return;
    touchTrace.lastPageX = pageX;
    touchTrace.lastPageY = pageY;
    push({ kind: 'tap', x: pageX, y: pageY });
  }, [push]);

  const onStartCapture = useCallback(
    (e: GestureResponderEvent) => {
      touchTrace.startCapture += 1;
      lastTrailPt.current = null; // new gesture: never interpolate from the old one
      if (on) add(e.nativeEvent.pageX, e.nativeEvent.pageY);
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
      const { pageX, pageY } = e.nativeEvent;
      if (!Number.isFinite(pageX) || !Number.isFinite(pageY)) return;

      // strokeRuns owns the chaining, INCLUDING closing the run to the finger
      // when the per-event cap bites. That closing step was missing while this
      // was a loop inline here, and a fast flick left a permanent hole in the
      // stroke. It is pure and tested now precisely because untested glue is
      // where it hid.
      const { runs, next } = strokeRuns(lastTrailPt.current, pageX, pageY);
      runs.forEach((r, i) => push({ kind: 'seg', ...r, order: i }));
      lastTrailPt.current = next;
    },
    [on, trail, push],
  );

  const onTouchEnd = useCallback(() => {
    lastTrailPt.current = null;
  }, []);

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
      onTouchEnd={onTouchEnd}
      onTouchCancel={onTouchEnd}
    >
      {children}
      {marks.length > 0 ? (
        <View style={StyleSheet.absoluteFill} pointerEvents="none">
          {marks.map((m) =>
            m.kind === 'tap' ? (
              <Mark
                key={m.id}
                mark={m}
                ring={t.accent}
                fill={fill}
                onDone={() => remove(m.id)}
              />
            ) : (
              <Seg key={m.id} mark={m} color={t.accent} onDone={() => remove(m.id)} />
            ),
          )}
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
