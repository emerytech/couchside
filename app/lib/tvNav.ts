/**
 * TV-mode cursor stepping, with ZERO runtime imports.
 *
 * WHY THIS MODE EXISTS: on SteamOS the streaming services people actually watch
 * are web pages in a browser. Arrow keys do NOT navigate them — Chromium has no
 * spatial navigation by default (its own flag breaks on any page that calls
 * Element.focus(), which Netflix does), and Firefox removed the feature
 * entirely. MEASURED 2026-07-26: arrow keys sent to the box moved Steam's own
 * selection, but a browser tile grid only scrolls. So the SWIPE mode that drives
 * Steam beautifully does nothing useful on Netflix.
 *
 * Every shipping Linux TV product converged on the same answer — drive a
 * CURSOR, not a focus ring (KDE's purpose-built Aura browser ships
 * `navMode: "vMouse"`). This mode does that, but in tile-sized jumps with a
 * haptic per step, so it FEELS like a d-pad while being a pointer underneath.
 * It therefore works on every service, including the ones with no TV UI at all.
 *
 * Split out and import-free so the arithmetic is unit-testable on bare Node,
 * like lib/gamepad.ts and lib/mediaSeek.ts (CI job `app-input`).
 */

/** Jump sizes offered in Settings, in pixels of box-screen travel per step. */
export const TV_STEPS = [160, 260, 380] as const;
export type TvStepPx = (typeof TV_STEPS)[number];

/**
 * Default. A 1080p tile row on Netflix/Disney+ runs roughly six tiles wide, so
 * ~260px lands about one tile per swipe-step at that size. Smaller screens and
 * denser grids are why this is a preference rather than a constant.
 */
export const TV_STEP_DEFAULT: TvStepPx = 260;

export function isTvStep(n: number): n is TvStepPx {
  return (TV_STEPS as readonly number[]).includes(n);
}

/** The four directions the swipe surface emits. */
export type TvDir = 'du' | 'dd' | 'dl' | 'dr';

/**
 * Relative pointer delta for one step in `dir`.
 *
 * Returns integers because the wire format is an int32 pair and the agent's
 * uinput write rounds anyway — emitting a fraction would silently truncate and
 * make repeated steps drift off the row.
 */
export function tvStepDelta(dir: TvDir, stepPx: number): { dx: number; dy: number } {
  const n = Math.max(1, Math.round(stepPx));
  switch (dir) {
    case 'dl':
      return { dx: -n, dy: 0 };
    case 'dr':
      return { dx: n, dy: 0 };
    case 'du':
      return { dx: 0, dy: -n };
    case 'dd':
      return { dx: 0, dy: n };
  }
}
