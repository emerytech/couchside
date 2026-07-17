/**
 * Relative-mouse trackpad gesture, as a reusable PanResponder.
 *
 *  - 1-finger drag        -> onMove(dx, dy) with a light acceleration curve
 *  - 1-finger tap         -> onLeftClick
 *  - 2-finger tap         -> onRightClick
 *  - 2-finger drag        -> onScroll(notches), honoring the naturalScroll pref
 *  - double-tap + hold-drag -> onDragStart / onMove* / onDragEnd (marquee):
 *      tap, then on the second touch keep the finger down and drag. The caller
 *      holds the left button for the whole drag, so a desktop file manager
 *      rubber-bands a selection — like click-drag-selecting files in a GUI.
 *      A double-tap that does NOT drag is just a second onLeftClick.
 *
 * Pointer speed (trackpadSensitivity) and scroll direction (naturalScroll) are
 * read live from prefs so a single once-created responder always uses the
 * current values. Shared by the Pad tab's Trackpad surface and the RemoteView
 * nav circle's trackpad toggle. Haptics are the caller's concern (wrap onMove
 * / onDragStart).
 */
import { useRef } from 'react';
import { PanResponder, PanResponderInstance } from 'react-native';

import { usePref } from '@/lib/prefs';

/** Movement under this (px) still counts as a tap/click. */
const TP_TAP_SLOP = 8;
/** Touches longer than this aren't taps. */
const TP_TAP_MS = 350;
/**
 * Max gap between the first tap's release and the second touch's start for the
 * pair to read as a double-tap (which, if the second touch then drags, arms a
 * held-button marquee drag). Matches the platform double-tap feel.
 */
const TP_DOUBLE_TAP_MS = 300;
/**
 * Light acceleration: pointer delta = raw * (BASE + GAIN * speed). Slow drags
 * track ~1:1 for precision; fast flicks cover more screen.
 */
const TP_BASE = 1.1;
const TP_GAIN = 0.05;
/** Screen px of two-finger drag per wheel notch. */
const TP_SCROLL_STEP = 18;

export type TrackpadCallbacks = {
  onMove: (dx: number, dy: number) => void;
  onLeftClick: () => void;
  onRightClick: () => void;
  onScroll: (notches: number) => void;
  /** Left button pressed for a double-tap-drag marquee. Hold it until onDragEnd. */
  onDragStart?: () => void;
  /** Marquee drag finished (or interrupted) — release the left button. */
  onDragEnd?: () => void;
};

export function useTrackpad(cbs: TrackpadCallbacks): PanResponderInstance {
  const cb = useRef(cbs);
  cb.current = cbs;

  const feel = useRef({ sens: 1, natural: false });
  feel.current = {
    sens: usePref('trackpadSensitivity'),
    natural: usePref('naturalScroll'),
  };

  const st = useRef({
    lastX: 0,
    lastY: 0,
    lastT: 0,
    moved: false,
    t0: 0,
    maxTouches: 1,
    scrollAccum: 0,
    scrollLastY: 0,
    /** Wall-clock of the previous quick tap's release, for double-tap detection. */
    lastTapEndT: 0,
    /** This gesture began within the double-tap window (may become a marquee). */
    armed: false,
    /** Left button is currently held for a marquee drag. */
    dragging: false,
  });

  return useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      // Inside a ScrollView (the RemoteView nav circle) the scroll container
      // asks to take over mid-drag — which scrolled the page and killed the
      // pointer gesture. Refuse: once the trackpad owns the touch, it keeps it.
      onPanResponderTerminationRequest: () => false,
      onShouldBlockNativeResponder: () => true,
      onPanResponderGrant: (evt) => {
        const touches = evt.nativeEvent.touches.length || 1;
        const prev = st.current;
        const now = Date.now();
        // Arm a marquee if this single-finger touch lands within the double-tap
        // window of the previous quick tap. The button is only actually held
        // once the finger starts dragging (below), so a plain double-tap that
        // never moves stays a second click.
        const armed = touches === 1 && now - prev.lastTapEndT < TP_DOUBLE_TAP_MS;
        st.current = {
          lastX: 0,
          lastY: 0,
          lastT: now,
          moved: false,
          t0: now,
          maxTouches: touches,
          scrollAccum: 0,
          scrollLastY: 0,
          lastTapEndT: prev.lastTapEndT,
          armed,
          dragging: false,
        };
      },
      onPanResponderMove: (evt, g) => {
        const s = st.current;
        const touches = evt.nativeEvent.touches.length;
        if (touches > s.maxTouches) s.maxTouches = touches;
        if (!s.moved && Math.hypot(g.dx, g.dy) > TP_TAP_SLOP) s.moved = true;

        if (s.maxTouches >= 2) {
          // Two-finger drag -> vertical scroll. g.dy is cumulative from grant.
          const delta = g.dy - s.scrollLastY;
          s.scrollAccum += delta;
          while (Math.abs(s.scrollAccum) >= TP_SCROLL_STEP) {
            const dir = s.scrollAccum > 0 ? 1 : -1;
            s.scrollAccum -= dir * TP_SCROLL_STEP;
            // Drag down (dy>0) scrolls content up -> wheel down (negative).
            // "Natural" scrolling inverts that (content follows the fingers).
            cb.current.onScroll(feel.current.natural ? dir : -dir);
          }
          s.scrollLastY = g.dy;
          return;
        }

        // One-finger drag -> relative pointer move with light acceleration.
        const now = Date.now();
        const rawDx = g.dx - s.lastX;
        const rawDy = g.dy - s.lastY;
        const dt = Math.max(1, now - s.lastT);
        const speed = Math.hypot(rawDx, rawDy) / dt; // px/ms
        const gain = (TP_BASE + TP_GAIN * speed * 16) * feel.current.sens;
        s.lastX = g.dx;
        s.lastY = g.dy;
        s.lastT = now;
        // Marquee: first real movement of an armed (double-tap) gesture presses
        // and holds the left button, so the move that follows drags a selection.
        if (s.armed && !s.dragging && s.moved) {
          s.dragging = true;
          cb.current.onDragStart?.();
        }
        cb.current.onMove(rawDx * gain, rawDy * gain);
      },
      onPanResponderRelease: () => {
        const s = st.current;
        const now = Date.now();
        if (s.dragging) {
          // End the held-button marquee. Not a tap; don't chain another.
          s.dragging = false;
          s.lastTapEndT = 0;
          cb.current.onDragEnd?.();
          return;
        }
        const wasTap = !s.moved && now - s.t0 < TP_TAP_MS;
        if (wasTap) {
          if (s.maxTouches >= 2) {
            cb.current.onRightClick();
            s.lastTapEndT = 0; // two-finger tap doesn't start a marquee
          } else {
            cb.current.onLeftClick();
            // Record the tap so a quick follow-up touch+drag becomes a marquee.
            s.lastTapEndT = now;
          }
        } else {
          s.lastTapEndT = 0;
        }
      },
      // A drag can be torn away (app backgrounded, navigation) mid-marquee —
      // release the held button so it never sticks down on the box.
      onPanResponderTerminate: () => {
        const s = st.current;
        if (s.dragging) {
          s.dragging = false;
          s.lastTapEndT = 0;
          cb.current.onDragEnd?.();
        }
      },
    }),
  ).current;
}
