/**
 * The one-time feature tour, shown AFTER the first box is paired.
 *
 * WHY AFTER THE PAIR, not on first launch: before a box exists, none of these
 * tabs do anything. A tour on launch would be the second thing overwhelming a
 * new user — the exact complaint that prompted the first-run rework ("I just
 * landed on the overwhelming set up page"). Once a box is paired the tabs are
 * live, and every step points at something they can try in the next second.
 *
 * ZERO imports, so the sequencing — which is where an off-by-one silently skips
 * a step or repeats one forever — is testable in bare Node.
 *
 * Each step names a TAB and says what is behind it in the user's own terms, not
 * the feature's name. "Vitals" is a word we use; "is my box actually alive" is
 * the thing they came for.
 */

export type TourStep = {
  /** Route name of the tab this step points at. */
  tab: 'index' | 'launch' | 'pad' | 'actions' | 'setup';
  title: string;
  body: string;
};

export const TOUR_STEPS: TourStep[] = [
  // CONSOLE — why the app exists.
  {
    tab: 'index',
    title: 'Is the box even awake?',
    body: 'Temperature, load, memory and disks, live. The first thing to check when the TV is black and the controller does nothing.',
  },
  {
    tab: 'index',
    title: 'See the screen from here',
    body: 'Pull a still frame of what the TV is actually showing — the difference between "it crashed" and "it is sitting on a login prompt".',
  },
  {
    tab: 'index',
    title: 'Read the logs without a keyboard',
    body: 'The services you care about and their journal, on the phone. No SSH, no crawling behind the TV.',
  },

  // LAUNCH — the thing people open it for daily.
  {
    tab: 'launch',
    title: 'Your library, with cover art',
    body: 'Every game the box has. Tap one and it starts on the TV — no Big Picture menus, no hunting with a D-pad.',
  },
  {
    tab: 'launch',
    title: 'Tap asks before it launches',
    body: 'A tap opens the game rather than starting it, with playtime and when you last opened it. Launching takes over the TV, so it is never one stray tap.',
  },
  {
    tab: 'launch',
    title: 'Narrow it down',
    body: 'Filter by never-played, under two hours, or not touched in a year. The button counts as you go, so you can see the shortlist shrink.',
  },
  {
    tab: 'launch',
    title: 'Or let it choose',
    body: 'The shuffle picks from whatever is currently showing — so "something short I have never played" is one tap away.',
  },

  // PAD — the hardware replacement.
  {
    tab: 'pad',
    title: 'The phone is a controller',
    body: 'A real gamepad the box cannot tell from plastic: sticks, D-pad, triggers, haptics. For when the real one is dead or across the room.',
  },
  {
    tab: 'pad',
    title: 'Trackpad, swipe, and a keyboard',
    body: 'Swipe like an Apple TV remote, or use it as a trackpad and type into the box — for the login boxes and launcher updates a controller cannot handle.',
  },

  // ACTIONS — the rescue.
  {
    tab: 'actions',
    title: 'Unstick a frozen display',
    body: 'Restart the display when the TV goes black but the machine is plainly still running. The one that saves the evening.',
  },
  {
    tab: 'actions',
    title: 'Grouped by what it costs you',
    body: 'Routine, changes-what-is-on-screen, and ends-your-session are separated on purpose — nothing destructive sits next to something harmless.',
  },

  // SETUP — where the rest lives.
  {
    tab: 'setup',
    title: 'Everything else lives here',
    body: 'Add more boxes, switch between them, and turn things on or off — including this tour, if you ever want to watch it again.',
  },
];

export type TourState = {
  /** Index of the step to show; equal to TOUR_STEPS.length once finished. */
  step: number;
  /** True once the user finished or dismissed it. Never shown again. */
  done: boolean;
};

export const TOUR_NOT_STARTED: TourState = { step: 0, done: false };
export const TOUR_FINISHED: TourState = { step: TOUR_STEPS.length, done: true };

/**
 * Should the tour run right now?
 *
 * `paired` is "this phone has at least one box". The tour is gated on it rather
 * than on a first-run flag so it cannot fire for someone who has not got
 * anything working yet — and so it DOES fire for an existing user who has been
 * limping along without ever finding the Pad tab.
 */
export function shouldRun(state: TourState, paired: boolean, enabled: boolean): boolean {
  return enabled && paired && !state.done && state.step < TOUR_STEPS.length;
}

/** The step to render, or null when there is nothing to show. */
export function currentStep(state: TourState): TourStep | null {
  if (state.done || state.step < 0 || state.step >= TOUR_STEPS.length) return null;
  return TOUR_STEPS[state.step];
}

/** Advance. The LAST "next" finishes the tour rather than leaving it dangling
 *  one past the end, so a resumed session cannot show an empty toast. */
export function advanceTour(state: TourState): TourState {
  const next = state.step + 1;
  return next >= TOUR_STEPS.length ? TOUR_FINISHED : { step: next, done: false };
}

/** "Skip" and finishing land in the same place: never shown again. */
export function dismissTour(): TourState {
  return TOUR_FINISHED;
}

/** 1-based position for the "2 of 4" label. */
export function stepLabel(state: TourState): string {
  const n = Math.min(state.step + 1, TOUR_STEPS.length);
  return `${n} of ${TOUR_STEPS.length}`;
}

// ---------------------------------------------------------------------------
// Spotlight geometry
//
// The dim layer is drawn as FOUR rectangles around the target rather than with
// a mask: React Native has no cross-platform cutout, and four Views need no
// dependency and no SVG. Get the arithmetic wrong and the hole lands over the
// wrong tab — which is worse than no tour, because it points confidently at
// something unrelated. Hence it lives here, tested, instead of inline in JSX.
// ---------------------------------------------------------------------------

export type Rect = { x: number; y: number; width: number; height: number };

/**
 * Where the highlighted tab sits. Tabs are evenly divided across the bar, so
 * the index and the count are enough — no measurement pass, no layout race on
 * the frame the overlay appears.
 */
export function spotlightRect(
  screenWidth: number,
  screenHeight: number,
  tabBarHeight: number,
  tabCount: number,
  tabIndex: number,
  /** Home-indicator inset. EXCLUDED from the hole: including it made the ring
   *  taller than the tab it points at, so it hung into the gesture strip and
   *  looked clipped at the bottom of the screen (seen on an iPhone 17 Pro Max).
   *  The hole should hug the icon and label, nothing else. */
  bottomInset = 0,
): Rect {
  const count = Math.max(1, tabCount);
  // Clamp rather than trust: a tab hidden by caps (remote-only mode) could
  // otherwise index past the end and spotlight empty space off-screen.
  const i = Math.min(Math.max(0, tabIndex), count - 1);
  const width = screenWidth / count;
  const height = Math.min(tabBarHeight, screenHeight);
  return {
    x: i * width,
    y: Math.max(0, screenHeight - bottomInset - height),
    width,
    height,
  };
}

/** The four dim rectangles that surround `hole`, covering everything else. */
export function dimRects(screenWidth: number, screenHeight: number, hole: Rect): Rect[] {
  const right = hole.x + hole.width;
  const bottom = hole.y + hole.height;
  return [
    { x: 0, y: 0, width: screenWidth, height: hole.y },                        // above
    { x: 0, y: bottom, width: screenWidth, height: Math.max(0, screenHeight - bottom) }, // below
    { x: 0, y: hole.y, width: hole.x, height: hole.height },                   // left
    { x: right, y: hole.y, width: Math.max(0, screenWidth - right), height: hole.height }, // right
  ].filter((r) => r.width > 0 && r.height > 0);
}
