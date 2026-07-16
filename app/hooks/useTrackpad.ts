/**
 * Relative-mouse trackpad gesture, as a reusable PanResponder.
 *
 *  - 1-finger drag  -> onMove(dx, dy) with a light acceleration curve
 *  - 1-finger tap   -> onLeftClick
 *  - 2-finger tap   -> onRightClick
 *  - 2-finger drag  -> onScroll(notches), honoring the naturalScroll pref
 *
 * Pointer speed (trackpadSensitivity) and scroll direction (naturalScroll) are
 * read live from prefs so a single once-created responder always uses the
 * current values. Shared by the Pad tab's Trackpad surface and the RemoteView
 * nav circle's trackpad toggle. Haptics are the caller's concern (wrap onMove).
 */
import { useRef } from 'react';
import { PanResponder, PanResponderInstance } from 'react-native';

import { usePref } from '@/lib/prefs';

/** Movement under this (px) still counts as a tap/click. */
const TP_TAP_SLOP = 8;
/** Touches longer than this aren't taps. */
const TP_TAP_MS = 350;
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
  });

  return useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderGrant: (evt) => {
        const touches = evt.nativeEvent.touches.length || 1;
        st.current = {
          lastX: 0,
          lastY: 0,
          lastT: Date.now(),
          moved: false,
          t0: Date.now(),
          maxTouches: touches,
          scrollAccum: 0,
          scrollLastY: 0,
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
        cb.current.onMove(rawDx * gain, rawDy * gain);
      },
      onPanResponderRelease: () => {
        const s = st.current;
        const wasTap = !s.moved && Date.now() - s.t0 < TP_TAP_MS;
        if (wasTap) {
          if (s.maxTouches >= 2) cb.current.onRightClick();
          else cb.current.onLeftClick();
        }
      },
    }),
  ).current;
}
