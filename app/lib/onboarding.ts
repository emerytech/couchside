/**
 * The first-run flow's navigation rules, with no React and no router — so the
 * one rule that is easy to get wrong is testable on bare Node.
 *
 * THE RULE: "back" means two different things in a multi-step flow, and
 * conflating them is the bug. The spec for this feature (docs/memory/
 * project_first-run-mode-chooser.md) was written when the chooser was a SINGLE
 * screen, where the Android back button could only mean "leave". Folded into a
 * journey, back from step 3 must return to step 2 — marking onboarding done
 * there and dumping the user into the app is worse than the repeat-nag the rule
 * was protecting against.
 *
 * So: back NAVIGATES inside the flow, and only leaving from the first screen (or
 * an explicit skip, or finishing) is an EXIT. Only an exit sets onboardingDone.
 */

export type OnboardingStep =
  /** What Couchside is, in one sentence. */
  | 'welcome'
  /** Gaming machine, or smart TV only. Neither is "recommended" — the flow
   *  exists precisely because neither audience is the default. */
  | 'choose'
  /** Run the installer on the box. */
  | 'install'
  /** Pair a TV directly; no box involved. */
  | 'tv';

export const FIRST_STEP: OnboardingStep = 'welcome';

/** Where a "back" gesture goes. null means LEAVE the flow. */
export function backFrom(step: OnboardingStep): OnboardingStep | null {
  switch (step) {
    case 'welcome':
      return null; // back from the first screen is an exit
    case 'choose':
      return 'welcome';
    case 'install':
    case 'tv':
      return 'choose';
  }
}

/** Does leaving from here mean the flow is finished with? Every exit does —
 *  the flag records "seen and dealt with", not "completed successfully". */
export function isExit(step: OnboardingStep, action: 'back' | 'skip' | 'finish'): boolean {
  if (action !== 'back') return true;
  return backFrom(step) === null;
}

export type DeviceChoice = 'box' | 'tv';

/** Which screen a choice leads to. */
export function stepForChoice(choice: DeviceChoice): OnboardingStep {
  return choice === 'tv' ? 'tv' : 'install';
}

/**
 * Does the flow run at all?
 *
 * THE EMPTY-STATE GUARDS ARE NOT OPTIONAL. `onboardingDone` defaults false for
 * every install that already exists, so the pref alone would show a first-run
 * flow to someone who has been using the app for months. Anyone with a box or a
 * TV has already answered "which do you have?" by owning one.
 */
export function shouldShowOnboarding(args: {
  done: boolean;
  boxCount: number;
  tvCount: number;
  ready: boolean;
}): boolean {
  if (!args.ready) return false; // persisted state not loaded: decide nothing yet
  if (args.done) return false;
  return args.boxCount === 0 && args.tvCount === 0;
}

/**
 * What the box prints when the installer succeeds — the sentence the user is
 * asked to confirm they saw.
 *
 * The phone genuinely cannot see the box's stdout, so the USER is the sensor.
 * Taken from install.sh's own banner rather than paraphrased: a confirmation
 * question that quotes text the box never prints teaches the user to answer
 * "yes" to something they did not read.
 */
export const INSTALL_SUCCESS_MARKER = 'Couchside agent is running on';

/** The one-liner, single-sourced so the copy and any Copy button cannot drift. */
export const INSTALL_COMMAND = 'curl -fsSL https://couchside.tv/install.sh | bash';
