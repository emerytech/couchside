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
  strokeRuns,
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

console.log('strokeRuns');
{
  // THE REGRESSION. A move past the per-event cap: trailPoints returns the
  // FINGER as `next` (so the stroke stays under the thumb), and the chaining
  // used to stop at the last point it laid -- leaving the span between them
  // undrawn forever, because the following event resumes from the finger.
  // Asserted as CONTINUITY, not as a run count: every run must start exactly
  // where the previous one ended, and the last must end at `next`. That is the
  // property the old code broke, and it is the property a future rewrite must
  // keep.
  const far = TRAIL_STEP_PX * (TRAIL_MAX_PER_EVENT + 4);
  const { runs, next } = strokeRuns({ x: 0, y: 0 }, far, 0);
  let contiguous = runs.length > 0;
  for (let i = 1; i < runs.length; i++) {
    if (runs[i].x !== runs[i - 1].x2 || runs[i].y !== runs[i - 1].y2) contiguous = false;
  }
  eq('capped flick: runs are contiguous', contiguous, true);
  eq('capped flick: starts at the previous point', [runs[0].x, runs[0].y], [0, 0]);
  eq(
    'capped flick: NO HOLE — the last run ends at the finger',
    [runs[runs.length - 1].x2, runs[runs.length - 1].y2],
    [next.x, next.y],
  );
  eq('capped flick: reaches the finger', [next.x, next.y], [far, 0]);
}
{
  // CONTROL: the ordinary case must NOT gain a zero-length run from the
  // closing step -- there, `next` already IS the last point laid.
  const { runs, next } = strokeRuns({ x: 0, y: 0 }, TRAIL_STEP_PX * 3, 0);
  eq('normal move: one run per step', runs.length, 3);
  eq('normal move: no zero-length run', runs.filter((r) => r.x === r.x2 && r.y === r.y2).length, 0);
  eq('normal move: ends at next', [runs[2].x2, runs[2].y2], [next.x, next.y]);
}
{
  // A lift-and-replace must draw NOTHING across the gap. Observing this state
  // as well as the joined one is the whole point: a chainer that always joined
  // would satisfy every assertion above and paint a line the finger never took.
  const { runs } = strokeRuns({ x: 0, y: 0 }, TRAIL_JUMP_PX + 1, 0);
  eq('a jump draws no run across the gap', runs.length, 0);
}
{
  const { runs } = strokeRuns(null, 5, 9);
  eq('the first touch of a gesture draws nothing', runs.length, 0);
}
{
  const { runs } = strokeRuns({ x: 0, y: 0 }, TRAIL_STEP_PX - 1, 0);
  eq('a sub-step move draws nothing', runs.length, 0);
}

console.log('segmentBox — arbitrary angles');
{
  // The review caught that rotation was only ever proven at 0 and pi/2, where
  // sign errors and axis swaps are invisible. A 45-degree run and a NEGATIVE-dy
  // run both have hand-checkable answers.
  const b = segmentBox(0, 0, 10, 10);
  near('45 degrees', b.angle, Math.PI / 4);
  near('45: length', b.width, Math.hypot(10, 10));
  near('45: centred on the midpoint (x)', b.left + b.width / 2, 5);
  near('45: centred on the midpoint (y)', b.top + b.height / 2, 5);
}
{
  // Upward drag: dy is negative, so the angle must be negative. atan2 with its
  // arguments swapped would return the complement here and look fine at 0.
  const b = segmentBox(0, 100, 100, 0);
  near('negative dy: angle is negative', b.angle, -Math.PI / 4);
  near('negative dy: midpoint x', b.left + b.width / 2, 50);
  near('negative dy: midpoint y', b.top + b.height / 2, 50);
}
{
  // Reversing a run must flip the angle by exactly pi and change nothing else.
  const f = segmentBox(10, 20, 40, 60);
  const r = segmentBox(40, 60, 10, 20);
  near('reversed: same length', r.width, f.width);
  near('reversed: same left', r.left, f.left);
  near('reversed: angle differs by pi', Math.abs(r.angle - f.angle), Math.PI);
}

console.log(bad ? `\n${bad} FAILED` : '\nall good');
process.exit(bad ? 1 : 0);
