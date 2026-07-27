/**
 * Swipe-to-d-pad stepping, with ZERO runtime imports.
 *
 * THE BUG THIS FIXES (reported 2026-07-26): pressing STEAM and swiping right to
 * reach the open-apps entry overshot it. The old rule emitted one step per
 * SWIPE_STEP (56px) of travel with no distinction between the first step and
 * the rest, so a natural ~200px flick emitted 3-4 presses. That is right for a
 * long game grid — it is how you scroll one — and wrong for a short menu, where
 * three presses sail past the entry you wanted.
 *
 * So the FIRST step is cheap and REPEATS are expensive: a flick moves one item,
 * and a deliberate long drag still scrolls. That matches how a TV remote
 * behaves, and it is the shape the reporter described wanting.
 *
 * Split out and import-free so it is unit-testable on bare Node — this is the
 * safety-critical input path (CLAUDE.md §4), and "how many presses does a
 * gesture send" is exactly the kind of thing that should not be verified by
 * feel alone.
 */

/** Travel before the FIRST step of a gesture. Small, so a flick responds. */
export const SWIPE_FIRST_PX = 56;
/**
 * ADDITIONAL travel before each step after the first.
 *
 * 160 was chosen so a normal flick (~200px on a phone) emits exactly one step —
 * 56 + 160 = 216px is more than a flick — while a deliberate drag across the
 * pad still scrolls several. Under the old flat 56px rule that same flick sent
 * three.
 */
export const SWIPE_REPEAT_PX = 160;

export type StepDir = 'du' | 'dd' | 'dl' | 'dr';

export type StepState = {
  /** Travel already turned into steps, per axis (signed). */
  consumedX: number;
  consumedY: number;
  /** Has this gesture emitted anything yet? Gates first-vs-repeat spacing. */
  stepped: boolean;
};

export type StepPlan = {
  dirs: StepDir[];
  next: StepState;
};

/**
 * Steps to emit for a gesture currently at (dx, dy), given what it has already
 * consumed. Pure: callers apply `next` and fire `dirs` in order.
 *
 * `sensitivity` scales BOTH thresholds — higher means smaller steps, i.e. more
 * of them, preserving the existing preference's meaning.
 *
 * The dominant axis wins each iteration, matching the previous behaviour: a
 * diagonal drag steps along whichever axis has more unconsumed travel, never
 * both at once, so a d-pad never gets two directions from one movement.
 */
export function planSteps(
  dx: number,
  dy: number,
  state: StepState,
  sensitivity = 1,
): StepPlan {
  const sens = sensitivity > 0 ? sensitivity : 1;
  const first = SWIPE_FIRST_PX / sens;
  const repeat = SWIPE_REPEAT_PX / sens;

  let { consumedX, consumedY, stepped } = state;
  const dirs: StepDir[] = [];

  // Bounded: each iteration consumes at least `first` (>0), so this terminates.
  // Capped anyway — a runaway gesture must not be able to emit unbounded input.
  for (let guard = 0; guard < 64; guard++) {
    const availX = dx - consumedX;
    const availY = dy - consumedY;
    const ax = Math.abs(availX);
    const ay = Math.abs(availY);
    const need = stepped ? repeat : first;
    if (ax < need && ay < need) break;
    if (ax >= ay) {
      consumedX += Math.sign(availX) * need;
      dirs.push(availX > 0 ? 'dr' : 'dl');
    } else {
      consumedY += Math.sign(availY) * need;
      dirs.push(availY > 0 ? 'dd' : 'du');
    }
    stepped = true;
  }
  return { dirs, next: { consumedX, consumedY, stepped } };
}
