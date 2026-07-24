/**
 * Pure trackpad-gesture decision logic, split out of useTrackpad.ts so it can be
 * unit-tested. useTrackpad.ts owns the PanResponder + mutable ref state and
 * imports react-native (so it can't be loaded standalone), and RN-Web emits
 * mouse events, not touch — so the classifier is the only place these gestures
 * can be verified without a physical device. Keep this file react-native-free.
 */

/** Movement under this (px) still counts as a one-finger tap/click. */
export const TP_TAP_SLOP = 8;
/** Two-finger travel over this (px) is a scroll, not a right-click tap. Tighter
 *  than TP_TAP_SLOP and well below the scroll-notch step, so the ambiguous band
 *  between "moved a little" and "emitted a notch" resolves to scroll — the fix
 *  for a short two-finger stroke leaking a spurious right-click. */
export const TP_TWO_FINGER_SLOP = 6;
/** Touches longer than this aren't taps. */
export const TP_TAP_MS = 350;
/** Screen px of two-finger drag per wheel notch. */
export const TP_SCROLL_STEP = 18;

export type ReleaseAction = 'left-click' | 'right-click' | 'none';

/** State a release is classified from. */
export type ReleaseState = {
  /** Highest concurrent touch count seen this gesture (from onStart, live). */
  maxTouches: number;
  /** One-finger net travel exceeded TP_TAP_SLOP. */
  moved: boolean;
  /** A two-finger scroll actually happened (travel > TP_TWO_FINGER_SLOP). */
  scrolled: boolean;
  /** ms from first touch to release. */
  elapsedMs: number;
};

/**
 * Decide what a lifted trackpad gesture was. Pure.
 *
 *  - too slow (> TP_TAP_MS)        -> 'none' (a press/hold, not a tap)
 *  - two fingers, scrolled         -> 'none' (it was a scroll — never a click)
 *  - two fingers, quick + still    -> 'right-click' (independent of one-finger
 *                                     slop: a two-finger tap classifies on
 *                                     `scrolled`, which is what the misfires were)
 *  - one finger, quick, not moved  -> 'left-click'
 *  - one finger, moved             -> 'none' (a pointer drag)
 *
 * A ≥2-finger gesture NEVER falls through to a left-click, and a scroll never
 * yields any click — the two reported bugs.
 */
export function classifyRelease(s: ReleaseState): ReleaseAction {
  if (s.elapsedMs >= TP_TAP_MS) return 'none';
  if (s.maxTouches >= 2) return s.scrolled ? 'none' : 'right-click';
  return s.moved ? 'none' : 'left-click';
}
