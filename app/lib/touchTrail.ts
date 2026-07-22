/**
 * Pure geometry for the touch-drag stroke. NO react-native import, on purpose.
 *
 * The trail path cannot be exercised in the web harness at all -- React Native
 * Web emits MOUSE events, never touch events, so onTouchMove never fires there.
 * That is how the first version shipped drawing nothing at all on a real
 * iPhone. Splitting the risky half out as plain functions is what makes it
 * checkable without a device; app/__tests__/touch-trail.ts is the check.
 */

/** Stroke thickness in px. */
export const STROKE_W = 7;

/**
 * Stroke points are spaced by DISTANCE, not by time.
 *
 * The first shipped version throttled to one dot per 45ms. Measured off a
 * device recording (2.9.17, iPhone, Track surface), that produced tight clumps
 * of 3-4 dots spanning ~40-60px separated by 200-400px of nothing — specks, not
 * a stroke, which fails the one job the feature has.
 *
 * Two things caused it and a time throttle can fix neither: 45ms of travel is
 * hundreds of pixels during a real trackpad scrub, and iOS delivers touch-moves
 * COALESCED in bursts, so events arrive clumped and then not at all. Lowering
 * the interval cannot invent samples the OS never sent. Interpolating along the
 * segment between the previous point and the new one does, and it is
 * indifferent to how bursty the event stream is.
 */
export const TRAIL_STEP_PX = 20;
/**
 * Cap dots emitted per event so one coalesced jump cannot spawn a whole stroke
 * in a single frame — this runs on the trackpad path, which is latency-critical.
 */
export const TRAIL_MAX_PER_EVENT = 6;
/**
 * Past this, treat the gap as a DISCONTINUITY (finger lifted and re-placed, or a
 * dropped event) and drop a single dot instead of drawing a line the finger
 * never travelled. A phantom stroke across the screen is worse than a gap.
 */
export const TRAIL_JUMP_PX = 320;

type Pt = { x: number; y: number };

/**
 * Where to lay trail dots for one move event, given where the last one landed.
 *
 * Pure on purpose. The trail path cannot be exercised on web at all — RNW emits
 * mouse events, not touch events — so the previous version's bug survived every
 * check that was run before it shipped. Keeping the geometry in a pure function
 * means the risky half is testable with synthetic input on any platform;
 * `__touchTrailPoints` exposes it for exactly that.
 *
 * Returns the points to draw through and the point to carry forward. `next` is
 * the LAST POINT LAID, not the event coordinate — carrying the event coordinate
 * forward would silently swallow the leftover sub-step distance and let spacing
 * drift.
 *
 * `joins` says whether the returned points CONTINUE the stroke from `last`. The
 * caller draws runs of line between consecutive points, so it needs to know
 * where the pen lifted; deriving that from the distance a second time at the
 * call site would put the discontinuity threshold in two places.
 */
export function trailPoints(
  last: Pt | null,
  x: number,
  y: number,
): { points: Pt[]; next: Pt; joins: boolean } {
  if (!last) return { points: [{ x, y }], next: { x, y }, joins: false };
  const dx = x - last.x;
  const dy = y - last.y;
  const dist = Math.hypot(dx, dy);
  if (dist < TRAIL_STEP_PX) return { points: [], next: last, joins: true };
  // Discontinuity: finger lifted and re-placed, or events were dropped. Draw
  // where it IS rather than a line it never travelled.
  if (dist > TRAIL_JUMP_PX) return { points: [{ x, y }], next: { x, y }, joins: false };
  const want = Math.floor(dist / TRAIL_STEP_PX);
  const steps = Math.min(want, TRAIL_MAX_PER_EVENT);
  const points: Pt[] = [];
  for (let i = 1; i <= steps; i += 1) {
    const t = (i * TRAIL_STEP_PX) / dist;
    points.push({ x: last.x + dx * t, y: last.y + dy * t });
  }
  // When the per-event cap bites, resume from the FINGER, not from the last dot
  // drawn. Resuming from the dot makes the shortfall accumulate: every event
  // falls further behind until the gap trips the discontinuity guard and the
  // trail visibly snaps. Accepting one gap keeps the stroke under the finger.
  if (want > steps) return { points, next: { x, y }, joins: true };
  const done = (steps * TRAIL_STEP_PX) / dist;
  return { points, next: { x: last.x + dx * done, y: last.y + dy * done }, joins: true };
}

/**
 * Absolute-position box for one run of the stroke, as a plain object.
 *
 * A View is an axis-aligned rectangle, so an arbitrary line is a rect of
 * width=length and height=STROKE_W, centred on the run's midpoint and rotated
 * about that centre (RN rotates about the centre by default).
 *
 * SQUARE ends, not rounded, and length is EXACTLY the distance -- consecutive
 * runs then meet edge-to-edge with zero overlap. Rounded caps would each spill
 * STROKE_W/2 past the endpoint, so every joint would be double-painted and a
 * semi-transparent stroke would bead at exactly the interval the dots used to.
 * Trading that for sub-pixel notches on the outside of a curve is the right way
 * round at this thickness.
 *
 * Pure and exported because the trail path CANNOT be exercised in the web
 * harness -- RNW emits mouse events, not touch events -- so this geometry is
 * only checkable as a function. `__touchSegmentBox` exposes it.
 */
export function segmentBox(x1: number, y1: number, x2: number, y2: number) {
  const len = Math.hypot(x2 - x1, y2 - y1);
  return {
    left: (x1 + x2) / 2 - len / 2,
    top: (y1 + y2) / 2 - STROKE_W / 2,
    width: len,
    height: STROKE_W,
    angle: Math.atan2(y2 - y1, x2 - x1),
  };
}
