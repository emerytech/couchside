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

export type TourTab = 'index' | 'launch' | 'pad' | 'actions' | 'setup';

export type TourStep = {
  /** Route name of the tab this step points at. */
  tab: TourTab;
  /**
   * Id of the ELEMENT to spotlight inside that tab — the CPU temp card, the
   * filter button, the mode selector. Registered by the screen via
   * useTourAnchor(); see hooks/useTourAnchor.ts.
   *
   * Absent = spotlight the tab-bar icon instead, which is all this tour could
   * do originally.
   *
   * AN ANCHOR IS ALSO THE GATE, and this is the fix for a real bug rather than
   * a convenience. Steps used to describe controls that were not on screen: the
   * library filter and shuffle are hidden on agents older than 2.9.71 (no
   * playtime data), yet two steps cheerfully explained how to use them, so the
   * user hunted for a button that was deliberately absent. A screen only
   * registers an anchor for something it actually rendered, so an unregistered
   * anchor means "this build/box does not have this" and the step is SKIPPED.
   * The rule: never describe a control the user cannot see.
   */
  anchor?: string;
  title: string;
  body: string;
};

export const TOUR_STEPS: TourStep[] = [
  // CONSOLE — why the app exists.
  {
    tab: 'index',
    anchor: 'console.cpu',
    title: 'Is the box even awake?',
    body: 'Temperature, load, memory and disks, live. The first thing to check when the TV is black and the controller does nothing.',
  },
  {
    tab: 'index',
    anchor: 'console.display',
    title: 'What the TV is actually being sent',
    body: 'Resolution, refresh, HDR and which output is connected. When the picture is wrong, this says whether the box even thinks a screen is there.',
  },
  {
    tab: 'index',
    anchor: 'console.screen',
    title: 'See the screen from here',
    body: 'Pull a still frame of what the TV is actually showing — the difference between "it crashed" and "it is sitting on a login prompt".',
  },

  // LAUNCH — the thing people open it for daily.
  {
    tab: 'launch',
    anchor: 'launch.grid',
    title: 'Your library, with cover art',
    // Do NOT say "tap one and it starts": tapping opens the confirm sheet, and
    // the very next step explains that. Saying both is a tour arguing with
    // itself in front of a new user.
    body: 'Every game the box has, laid out with its art. No Big Picture menus, no hunting across a grid with a D-pad.',
  },
  {
    tab: 'launch',
    anchor: 'launch.grid',
    title: 'Tap asks before it launches',
    body: 'A tap opens the game rather than starting it, with playtime and when you last opened it. Launching takes over the TV, so it is never one stray tap.',
  },
  // The next two are anchored to controls that only exist once a library is
  // big enough to need them (8+ games). On a small library there is no filter
  // and no shuffle, and these steps skip themselves rather than describing
  // buttons the user will go hunting for and never find.
  {
    tab: 'launch',
    anchor: 'launch.filter',
    title: 'Narrow it down',
    body: 'Filter by never-played, under two hours, or not touched in a year. The button counts as you go, so you can see the shortlist shrink.',
  },
  {
    tab: 'launch',
    anchor: 'launch.shuffle',
    title: 'Or let it choose',
    body: 'The shuffle picks from whatever is currently showing — so "something short I have never played" is one tap away.',
  },
  // Anchored INSIDE the cards (components/InstallableSection, PlaylogCard), so
  // each step only shows when its card actually rendered: the install card needs
  // owned-but-uninstalled games, the Playlog needs at least one queued game.
  // No card, no anchor, step skips — the same "never describe an absent control"
  // rule as the filter/shuffle steps above.
  {
    tab: 'launch',
    anchor: 'launch.installable',
    title: 'Your whole library — even what you haven’t installed',
    body: 'Games you own but never downloaded show up here. Kick off the install on the box from the couch; no Big Picture, no keyboard.',
  },
  {
    tab: 'launch',
    anchor: 'launch.playlog',
    title: 'Line up what to play next',
    body: 'Bookmark a game and it lands in your Playlog — a play-next queue you can reorder. Not installed yet? Tap it there to install.',
  },

  // PAD — the hardware replacement.
  // Anchored to the mode selector rather than the surface below it: the pad
  // opens on SWIPE, so a step promising sticks and triggers used to point at an
  // empty trackpad. Pointing at the switch tells the user how to GET there.
  {
    tab: 'pad',
    anchor: 'pad.modes',
    title: 'The phone is a controller',
    body: 'Switch to PAD for a real gamepad the box cannot tell from plastic: sticks, D-pad, triggers, haptics. For when the real one is dead or across the room.',
  },
  {
    tab: 'pad',
    anchor: 'pad.modes',
    title: 'Trackpad, swipe, and a keyboard',
    body: 'SWIPE works like an Apple TV remote and MOUSE is a trackpad you can type through — for the login boxes and launcher updates a controller cannot handle.',
  },
  // The shortcut for the switch two steps up. Worth its own step because the
  // selector sits at the very top of the screen and this does the same job
  // under your thumb — and nobody finds it by accident.
  {
    tab: 'pad',
    anchor: 'pad.keybar',
    title: 'Switch modes without reaching',
    body: 'Swipe left or right across this bar to change mode — same as the buttons at the top, but where your thumb already is. Tap it to type on the box instead.',
  },

  // ACTIONS — the rescue.
  {
    tab: 'actions',
    anchor: 'actions.high',
    title: 'Unstick a frozen display',
    // NAME THE CONTROL AS IT IS LABELLED. This used to say "restart the
    // display", which is not a button that exists — the user scanned the list
    // for it and found nothing. It also sold the action as the harmless hero
    // move while the UI tags it red and "ends session". A tour that undersells
    // the cost of a destructive action is worse than one that never mentions it.
    body: 'Restart Session rebuilds the desktop when the TV is black but the machine is plainly still running. It closes what is open, which is why it sits under "Ends your session".',
  },
  // Anchored to the ROUTINE group, which is the one that is often ABSENT: a
  // plain Linux box reports no harmless actions at all (the only one is
  // "Restart Decky", which needs Decky installed), while a Windows box does.
  // This step used to claim three groups unconditionally, in front of a screen
  // showing two.
  {
    tab: 'actions',
    anchor: 'actions.routine',
    title: 'Grouped by what it costs you',
    body: 'The harmless ones sit up here, apart from the ones that change what is on the TV and the ones that end your session. Nothing destructive sits next to something safe.',
  },

  // SETUP — where the rest lives.
  // The logs step lives HERE, not on Console. It used to be a Console step
  // describing "the services you care about and their journal" — a screen that
  // has no logs on it at all. LogsPanel is a Setup section, and always was.
  {
    tab: 'setup',
    anchor: 'setup.logs',
    title: 'Read the logs without a keyboard',
    body: 'The services you care about and their journal, on the phone. No SSH, no crawling behind the TV.',
  },
  {
    tab: 'setup',
    anchor: 'setup.tabs',
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

/**
 * Step BACK, for a mis-tapped GOT IT.
 *
 * Clamped at zero rather than wrapping or going negative: the first step's back
 * is a no-op, not an exit. Leaving is what SKIP is for, and a back gesture that
 * silently ends the tour is the same conflation the first-run flow had to fix.
 *
 * A step whose anchor is absent will simply skip forward again as soon as it is
 * shown, so going back past one lands where it started — correct, if slightly
 * surprising, and better than pretending the step exists.
 */
export function previousTour(state: TourState): TourState {
  return { step: Math.max(0, state.step - 1), done: false };
}

/** "Skip" and finishing land in the same place: never shown again. */
export function dismissTour(): TourState {
  return TOUR_FINISHED;
}

/**
 * Is this the LAST step — i.e. will the next tap finish the tour rather than
 * advance it?
 *
 * Used for two things: the button says DONE instead of "GOT IT →", and the
 * thank-you note is shown only to someone who actually reached the end. The
 * state cannot tell you afterwards, because skipping and finishing both land on
 * TOUR_FINISHED — and the difference matters, since pressing "Skip tour" is
 * someone asking to be left alone, which is the worst possible moment to hand
 * them a note about buying.
 */
export function isFinalStep(state: TourState): boolean {
  return state.step === TOUR_STEPS.length - 1;
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

/**
 * The hole for an ELEMENT spotlight: the measured rect, breathing room around
 * it, clamped to the screen.
 *
 * Clamping is not cosmetic. dimRects tiles four rectangles around the hole, and
 * a hole hanging off the edge would hand it a negative width — the panel gets
 * dropped and a strip of the screen is left undimmed, which reads as a
 * rendering fault. A card half off-screen (a wide row, a tall list) should
 * still be spotlit as far as it is visible.
 */
export function anchorHole(
  rect: Rect,
  pad: number,
  screenWidth: number,
  screenHeight: number,
): Rect {
  const x = Math.max(0, rect.x - pad);
  const y = Math.max(0, rect.y - pad);
  const right = Math.min(screenWidth, rect.x + rect.width + pad);
  const bottom = Math.min(screenHeight, rect.y + rect.height + pad);
  return { x, y, width: Math.max(0, right - x), height: Math.max(0, bottom - y) };
}

/**
 * How far to scroll so an anchor sits comfortably inside the visible band.
 * Negative scrolls up, positive scrolls down, 0 means it is already fine.
 *
 * Most of the things worth pointing at (the disks card, the screen preview) are
 * below the fold on a phone. Spotlighting them where they sit would dim the
 * whole screen and cut a hole over empty space — confidently pointing at
 * nothing, the exact failure the geometry lives here to prevent.
 *
 * An anchor TALLER than the band cannot be centred, so its top is aligned
 * instead: showing the beginning of a long card beats showing its middle.
 */
export function scrollDeltaFor(
  rect: Rect,
  viewportTop: number,
  viewportBottom: number,
  margin = 24,
): number {
  const band = viewportBottom - viewportTop;
  if (band <= 0) return 0;
  const top = rect.y - margin;
  const bottom = rect.y + rect.height + margin;
  if (bottom - top > band) return top - viewportTop;
  if (top < viewportTop) return top - viewportTop;
  if (bottom > viewportBottom) return bottom - viewportBottom;
  return 0;
}

/** Where the explanation card goes relative to the hole. `top` is measured from
 *  the top of the screen. */
export type CardSlot = { placement: 'above' | 'below'; top: number };

/**
 * Place the card so it never covers the thing it is describing.
 *
 * With a tab-bar spotlight the card always went above, because the hole was
 * always at the bottom. An element anchor can be anywhere, so the side is
 * chosen by whichever has more room, then clamped into the safe area — a card
 * pinned under the notch or behind the home indicator is unreadable, and it is
 * the only thing on screen the user is meant to read.
 */
export function cardSlot(
  hole: Rect,
  screenHeight: number,
  cardHeight: number,
  gap: number,
  safeTop: number,
  safeBottom: number,
): CardSlot {
  const roomAbove = hole.y - safeTop;
  const roomBelow = screenHeight - safeBottom - (hole.y + hole.height);
  const below = roomBelow >= roomAbove;
  const wanted = below ? hole.y + hole.height + gap : hole.y - gap - cardHeight;
  const lo = safeTop;
  // Math.max guards the case where the card is taller than the safe area
  // entirely: clamp to the top rather than producing a negative range.
  const hi = Math.max(lo, screenHeight - safeBottom - cardHeight);
  return { placement: below ? 'below' : 'above', top: Math.min(hi, Math.max(lo, wanted)) };
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
