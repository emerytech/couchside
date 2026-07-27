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
/**
 * ADDITIONAL travel before each step after the first, VERTICALLY.
 *
 * WHY VERTICAL IS DIFFERENT (reported from the couch 2026-07-27): "swiping down
 * in the Steam menu skips every other button", while horizontal tile navigation
 * was confirmed working. Same code, same thresholds — so the difference is the
 * gesture, not the rule. A thumb swiping DOWN travels much further than the same
 * intent swiping ACROSS: the screen is taller than it is wide and the thumb arcs
 * away from the joint. With one shared 160px repeat, a one-item-intent vertical
 * flick sailed past 56+160=216px and emitted two steps, while an equivalent
 * horizontal flick stayed under it and emitted one.
 *
 * MEASURED against the same planner, one continuous flick:
 *
 *     flick    live 2.9.29   2.9.30 (shared 160)   this (vertical 300)
 *     180px         3                1                     1
 *     220px         3                2                     1
 *     320px         5                2                     1
 *     400px         7                3                     2
 *
 * 300 is chosen so the second vertical step needs 56+300=356px — past any
 * flick, still reachable by a deliberate drag down the pad, which is how you
 * scroll a long library. HORIZONTAL IS DELIBERATELY UNCHANGED at 160: the tile
 * navigation that value produced was confirmed good on hardware, and this file
 * must not put that at risk to fix the other axis.
 */
export const SWIPE_REPEAT_Y_PX = 300;

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
  const repeatX = SWIPE_REPEAT_PX / sens;
  const repeatY = SWIPE_REPEAT_Y_PX / sens;

  let { consumedX, consumedY, stepped } = state;
  const dirs: StepDir[] = [];

  // Bounded: each iteration consumes at least `first` (>0), so this terminates.
  // Capped anyway — a runaway gesture must not be able to emit unbounded input.
  for (let guard = 0; guard < 64; guard++) {
    const availX = dx - consumedX;
    const availY = dy - consumedY;
    const ax = Math.abs(availX);
    const ay = Math.abs(availY);
    // Per-axis thresholds: a repeat costs more vertically (see
    // SWIPE_REPEAT_Y_PX). The FIRST step is identical on both axes, so a flick
    // in any direction still moves one item at the same distance.
    const needX = stepped ? repeatX : first;
    const needY = stepped ? repeatY : first;
    const canX = ax >= needX;
    const canY = ay >= needY;
    if (!canX && !canY) break;
    // Dominant axis still wins — but only among axes that have actually earned
    // a step. Previously one shared threshold meant the dominant axis always
    // qualified; with different thresholds an axis can lead in raw travel while
    // still being short of its own bar, and stepping it then would be the
    // overshoot this whole module exists to prevent.
    if (canX && (!canY || ax >= ay)) {
      consumedX += Math.sign(availX) * needX;
      dirs.push(availX > 0 ? 'dr' : 'dl');
    } else {
      consumedY += Math.sign(availY) * needY;
      dirs.push(availY > 0 ? 'dd' : 'du');
    }
    stepped = true;
  }
  return { dirs, next: { consumedX, consumedY, stepped } };
}
