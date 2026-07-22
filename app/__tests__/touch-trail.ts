/**
 * Geometry checks for the touch-drag stroke.
 *
 *   node --experimental-strip-types app/__tests__/touch-trail.ts
 *
 * Why a test at all: the trail path CANNOT be exercised in the web harness --
 * React Native Web emits mouse events, never touch events, so onTouchMove never
 * fires there. The first version of this feature shipped drawing nothing on a
 * real iPhone precisely because every check that ran before it was a render.
 * The pure half is therefore the only half that can be proved off-device, and
 * what it proves is stated narrowly below.
 *
 * Every group carries a CONTROL: an input whose answer is known without
 * consulting the code under test.
 */
import {
  STROKE_W,
  TRAIL_JUMP_PX,
  TRAIL_MAX_PER_EVENT,
  TRAIL_STEP_PX,
  segmentBox,
  trailPoints,
} from '../lib/touchTrail.ts';

let bad = 0;

function eq(name: string, got: unknown, want: unknown) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(
    `  ${ok ? 'PASS' : 'FAIL'}  ${name}` +
      (ok ? '' : ` (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`),
  );
  if (!ok) bad++;
}

function near(name: string, got: number, want: number, tol = 1e-9) {
  const ok = Math.abs(got - want) <= tol;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}` + (ok ? '' : ` (got ${got}, want ${want})`));
  if (!ok) bad++;
}

console.log('trailPoints');
// CONTROL. A move shorter than one step must produce NOTHING. If this ever
// returns a point, spacing is not distance-based and nothing below means much.
eq('sub-step move draws nothing', trailPoints({ x: 0, y: 0 }, TRAIL_STEP_PX - 1, 0).points, []);
eq('sub-step still joins', trailPoints({ x: 0, y: 0 }, TRAIL_STEP_PX - 1, 0).joins, true);
eq('first point of a gesture does not join', trailPoints(null, 5, 9).joins, false);
eq('first point sits where the finger is', trailPoints(null, 5, 9).points, [{ x: 5, y: 9 }]);

{
  const r = trailPoints({ x: 0, y: 0 }, TRAIL_STEP_PX * 3, 0);
  eq('3 steps of travel -> 3 points', r.points.length, 3);
  eq(
    'spaced one step apart',
    r.points.map((p) => p.x),
    [TRAIL_STEP_PX, TRAIL_STEP_PX * 2, TRAIL_STEP_PX * 3],
  );
  eq('carries the last point laid', r.next, { x: TRAIL_STEP_PX * 3, y: 0 });
}

{
  // BOTH STATES. `joins` is observed true above and false here. A `joins` that
  // was hardcoded true would satisfy every other assertion in this file, and
  // the stroke would then draw a line across a lift the finger never travelled.
  const r = trailPoints({ x: 0, y: 0 }, TRAIL_JUMP_PX + 1, 0);
  eq('a jump does not join', r.joins, false);
  eq('a jump lays one point at the finger', r.points, [{ x: TRAIL_JUMP_PX + 1, y: 0 }]);
}

{
  const r = trailPoints({ x: 0, y: 0 }, TRAIL_STEP_PX * (TRAIL_MAX_PER_EVENT + 4), 0);
  eq('per-event cap holds', r.points.length, TRAIL_MAX_PER_EVENT);
  eq('a capped event resumes from the finger, not the last point drawn', r.next, {
    x: TRAIL_STEP_PX * (TRAIL_MAX_PER_EVENT + 4),
    y: 0,
  });
}

console.log('segmentBox');
{
  // CONTROL. A horizontal run has an answer that needs no trigonometry: it must
  // start at x=10, end at x=30, sit centred on y=50, and not be rotated.
  const b = segmentBox(10, 50, 30, 50);
  eq('horizontal: spans exactly the two ends', [b.left, b.left + b.width], [10, 30]);
  near('horizontal: centred on the line', b.top + b.height / 2, 50);
  near('horizontal: no rotation', b.angle, 0);
  eq('thickness is the stroke width', b.height, STROKE_W);
}

{
  const b = segmentBox(0, 0, 0, 20);
  near('vertical: quarter turn', b.angle, Math.PI / 2);
  // A View rotates about its own centre, so the box must be laid out centred on
  // the run and then turned -- not positioned at one end.
  near('vertical: rotates about its centre back onto the line', b.left + b.width / 2, 0);
  near('vertical: midpoint', b.top + b.height / 2, 10);
}

{
  // THE property the whole change rests on. Length === true distance and square
  // ends means run A's far edge is exactly run B's near edge: no overlap to
  // bead at the joints (which is what semi-transparent rounded caps would do,
  // reintroducing the beading this replaced) and no gap to read as dots.
  const a = segmentBox(0, 0, 20, 0);
  const b = segmentBox(20, 0, 40, 0);
  near('run A ends where run B begins', a.left + a.width, b.left);
  near('no overlap at the joint', a.left + a.width - b.left, 0);
}

{
  const b = segmentBox(0, 0, 3, 4);
  near('length is the true distance, not a bounding box', b.width, 5);
}

console.log(bad ? `\n${bad} FAILED` : '\nall good');
process.exit(bad ? 1 : 0);
