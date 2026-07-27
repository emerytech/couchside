/**
 * Every DECISION the interactive setup card makes (components/SetupProgress.tsx),
 * with no React, no timers and no fetch — so it is unit-testable on bare Node.
 *
 * WHY IT IS ITS OWN FILE. The card's whole claim is "it advances itself": it
 * changes state from a network event the user cannot see, on a screen they are
 * not looking at (they are at their PC watching an installer scroll). That makes
 * every one of its rules — which sighting wins, when a spinner is allowed to
 * stop, when a PIN is dead, when to stop burning battery, which agents can even
 * do this — the kind of thing that must be *proved*, not felt. A component can
 * only be checked by driving it; a pure reducer can be checked exhaustively,
 * including the (phase x event) cross product, which is how "never leave a
 * spinner stuck" stops being a code-review habit and becomes a test.
 *
 * The two imports are deliberate and both are themselves import-free, so the
 * bare-Node runner can load this file (lib/pairLink.ts -> lib/lanIp.ts is the
 * existing precedent for the explicit `.ts` specifier):
 *   - cmpVersion  — component-wise numeric compare; a string compare reads
 *                   2.9.9 > 2.9.21, which is exactly backwards.
 *   - isValidLanIp — the LAN-shape gate. Single-sourced on purpose: it is the
 *                   security control that keeps an address learned from an
 *                   unauthenticated reply from becoming a token destination.
 */
import { cmpVersion } from './appUpdate.ts';
import { isValidLanIp } from './lanIp.ts';

/** Structurally identical to boxDiscovery's FoundBox (kept local so this file
 *  imports nothing that pulls in react-native / expo). A FoundBox satisfies it. */
export type SetupBox = {
  name: string;
  host: string;
  ip: string;
  port: number;
  version: string;
};

// ---------------------------------------------------------------------------
// Which agents can do unauthenticated PIN pairing
// ---------------------------------------------------------------------------

/**
 * Linux agent floor. PIN pairing (`pair_pin_start`) landed with agent 2.9.12
 * (commit 1f0952f, "Couchside 2.9.3 — remote-input, discovery, PIN pairing,
 * agent 2.9.12"), which is also what lib/api.ts documents on pairStart.
 */
export const PIN_PAIR_MIN_LINUX = '2.9.12';
/**
 * Windows agent floor. The spec for this card said the Windows agent has NO PIN
 * pairing at all, from a grep. That claim has EXPIRED: it shipped in 0.4.2-win
 * (commit a131bc5, "fix(win): PIN pairing + fail the build without
 * ViGEmClient.dll (0.4.2-win)"), current is 0.4.3-win, and the source header
 * says "parity with the Linux agent". Verified by reading
 * agent/win/couchsided-win.py at the commit that introduced pair_pin_start.
 *
 * This is why the test is a two-track version floor and NOT a `-win` sniff: a
 * naive compare of 0.4.3-win against 2.9.12 marks every Windows box
 * unsupported, which is the exact bug the phase exists to prevent.
 */
export const PIN_PAIR_MIN_WINDOWS = '0.4.2';

/**
 * Can this agent pop a PIN on its own screen for an unauthenticated phone?
 *
 * DEGRADES CLOSED (CLAUDE.md §3.7): an empty, malformed or unrecognised version
 * answers false, which routes the user to the QR / token path rather than to a
 * PIN input that would answer 401 and print the word "unauthorized" at them.
 * Cost of a false negative: one extra tap. Cost of a false positive: a dead end.
 */
export function supportsPinPairing(version: string): boolean {
  const v = (version ?? '').trim();
  if (!v) return false;
  // A version we cannot even parse the first component of is not a version.
  if (!/^\d/.test(v)) return false;
  // Windows builds carry the suffix; anything else is read as the Linux track.
  // A future `0.5.0-win-rc1` fails endsWith, is read as Linux, and lands
  // unsupported — wrong but CLOSED, and it costs one tap, not a dead end.
  return v.toLowerCase().endsWith('-win')
    ? cmpVersion(v, PIN_PAIR_MIN_WINDOWS) >= 0
    : cmpVersion(v, PIN_PAIR_MIN_LINUX) >= 0;
}

// ---------------------------------------------------------------------------
// PIN countdown
// ---------------------------------------------------------------------------

/**
 * Whole seconds left on a PIN, never negative.
 *
 * The app already asks for `ttl` and throws it away (BoxScanPair checks only
 * `r.ok`), so today an expired PIN is discovered by typing it and being told no.
 * The agent's TTL is 120 s but the RETURNED ttl is not always 120: inside
 * PAIR_PIN_START_DEBOUNCE (3 s) `/api/pair/start` hands back the LIVE pairing
 * with its REMAINING seconds. So the countdown is driven by the returned ttl,
 * never by a hardcoded 120.
 */
export function ttlRemaining(expiresAt: number, now: number): number {
  if (!Number.isFinite(expiresAt) || !Number.isFinite(now)) return 0;
  return Math.max(0, Math.ceil((expiresAt - now) / 1000));
}

/** `m:ss`, for a countdown that must not jitter. Clamped at zero. */
export function formatCountdown(totalSec: number): string {
  const s = Math.max(0, Math.floor(Number.isFinite(totalSec) ? totalSec : 0));
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, '0')}`;
}

// ---------------------------------------------------------------------------
// Sweep policy — how hard, and for how long, to look
// ---------------------------------------------------------------------------

/** Gap between sweeps while the install is plausibly still running. */
export const SWEEP_GAP_MS = 6000;
/** Gap after the fast window. One sweep is 254 connection attempts; at 6 s
 *  forever that is ~2,500 per minute, which costs battery and looks like a port
 *  scan to a router/IDS. The install is normally over inside a minute. */
export const SWEEP_GAP_BACKOFF_MS = 15000;
/** How long the fast cadence lasts. */
export const SWEEP_FAST_WINDOW_MS = 60000;
/** Total time before the card stops on its own and offers "Keep looking". */
export const SWEEP_GIVE_UP_MS = 300000;
/** When the honest "here is what it is usually" list replaces "looking…".
 *  Long enough that a normal install-then-find never sees it. */
export const DIAGNOSE_AFTER_MS = 25000;

export type SweepDecision = {
  /** Run another sweep now. */
  shouldSweep: boolean;
  /** Wait this long before the sweep after that one. */
  delayMs: number;
  /** Stop and hand the user the button. */
  giveUp: boolean;
};

/** `elapsedMs` is time since the search started, not since the last sweep. */
export function sweepPolicy(elapsedMs: number): SweepDecision {
  const e = Number.isFinite(elapsedMs) ? Math.max(0, elapsedMs) : 0;
  if (e >= SWEEP_GIVE_UP_MS) return { shouldSweep: false, delayMs: 0, giveUp: true };
  return {
    shouldSweep: true,
    delayMs: e < SWEEP_FAST_WINDOW_MS ? SWEEP_GAP_MS : SWEEP_GAP_BACKOFF_MS,
    giveUp: false,
  };
}

// ---------------------------------------------------------------------------
// Should we sweep at all, and if not, what is honestly known
// ---------------------------------------------------------------------------

export type NetFacts = {
  /** expo-network's NetworkStateType as a string, or undefined if unknown. */
  networkType?: string;
  isConnected?: boolean;
  /** The device's own IPv4 per expo-network, or undefined if unusable. */
  selfIp?: string;
};

export type NetVerdict =
  | { k: 'sweepable'; subnet: string }
  | { k: 'offline' }
  | { k: 'cellular' }
  | { k: 'no-lan-ip'; ip?: string };

/**
 * Whether a /24 sweep is even meaningful, and what the card may state as FACT.
 *
 * There is NO API in Expo SDK 57 (or in RN's fetch) that reports iOS Local
 * Network permission — checked against the v57 docs for expo-network, whose
 * whole surface is useNetworkState / getIpAddressAsync / getNetworkStateAsync /
 * isAirplaneModeEnabledAsync / addNetworkStateListener; "local network" does not
 * appear. whatwg-fetch rejects with a flat `TypeError('Network request failed')`,
 * so a permission denial is byte-identical to a timeout, a dead host and a wrong
 * subnet. A `blocked` phase therefore CANNOT be entered from evidence, and this
 * function does not pretend otherwise: it returns only what is actually known.
 * The two things that ARE known — no connection, and cellular / not-LAN-shaped —
 * get their own verdicts; everything else is left to honest differential copy.
 *
 * Order matters: a real cellular IP is often CGNAT (100.64/10), which
 * isValidLanIp accepts, so the cellular test has to come first or a phone on
 * mobile data sweeps the carrier's /24.
 */
export function netVerdict(f: NetFacts): NetVerdict {
  if (f.isConnected === false) return { k: 'offline' };
  const type = (f.networkType ?? '').toUpperCase();
  if (type === 'NONE') return { k: 'offline' };
  // NOTE (unverified): with iOS Personal Hotspot on, the phone may report
  // CELLULAR while a box IS reachable on its shared network. Such a user can
  // still pair with "Scan for boxes" / QR / add-by-IP below, all unchanged.
  if (type === 'CELLULAR') return { k: 'cellular' };
  const ip = f.selfIp;
  if (!ip || !isValidLanIp(ip)) return { k: 'no-lan-ip', ip };
  return { k: 'sweepable', subnet: ip.replace(/\.\d+$/, '.x') };
}

// ---------------------------------------------------------------------------
// The phase machine
// ---------------------------------------------------------------------------

export type SetupPhase =
  /** Nothing started yet. */
  | { k: 'idle' }
  /** A sweep is running (or the gap between two). */
  | { k: 'looking'; since: number; sweeps: number }
  /** Stopped after SWEEP_GIVE_UP_MS with nothing found. */
  | { k: 'stalled'; since: number; sweeps: number }
  /** Not sweeping because sweeping cannot work from here. */
  | { k: 'nonet'; verdict: NetVerdict }
  /** A box answered /api/ping while the fleet was empty. THE payoff moment. */
  | { k: 'found'; box: SetupBox }
  /** Agent too old (or non-conforming) for PIN pairing — route to QR/token. */
  | { k: 'unsupported'; box: SetupBox }
  /** POST /api/pair/start in flight. */
  | { k: 'starting'; box: SetupBox }
  /** PIN is on the box's TV; awaiting entry. */
  | { k: 'pin'; box: SetupBox; expiresAt: number }
  /** POST /api/pair/finish in flight. */
  | { k: 'pairing'; box: SetupBox; expiresAt: number }
  /** Pairing refused. `msg` is the AGENT'S OWN string, verbatim. */
  /** `shown` records whether a PIN was ever actually put on the box's screen.
   *  Without it the card cannot tell "the PIN expired" from "there was never a
   *  PIN", and it printed the former for the latter — see START_ERR below. */
  | { k: 'failed'; box: SetupBox; msg: string; expiresAt: number; shown: boolean }
  /** Token in hand and stored. */
  | { k: 'paired'; box: SetupBox };

export type SetupEvent =
  | { t: 'SWEEP_START'; now: number }
  | { t: 'SWEEP_EMPTY' }
  | { t: 'FOUND'; box: SetupBox }
  | { t: 'NO_NET'; verdict: NetVerdict }
  | { t: 'GIVE_UP' }
  | { t: 'KEEP_LOOKING'; now: number }
  | { t: 'START_PIN' }
  | { t: 'START_OK'; ttl: number; now: number }
  | { t: 'START_ERR'; msg: string }
  /**
   * Runtime backstop for an agent whose version claimed PIN support but whose
   * /api/pair/start hit the bearer gate and answered 401. unauthPost resolves
   * that body instead of throwing, so without this the card would print the
   * bare word "unauthorized" at the user. This is the ONE place the
   * surface-the-agent's-error-verbatim rule is deliberately overridden.
   */
  | { t: 'UNSUPPORTED' }
  | { t: 'SUBMIT' }
  | { t: 'PAIR_OK' }
  /** `dead` means the pairing is spent server-side, so no countdown may survive
   *  it — e.g. the agent accepted the PIN and something after that failed. */
  | { t: 'PAIR_ERR'; msg: string; dead?: boolean }
  /** Back to the found box without losing it (explicit escape from PIN entry). */
  | { t: 'BACK' }
  /** Back to the very start (explicit escape from anywhere). */
  | { t: 'RESET' };

/** Phases with an operation in flight. None of these may be a resting state:
 *  every one of them must be left by BOTH an ok and an error event. */
export const TRANSIENT: readonly SetupPhase['k'][] = ['looking', 'starting', 'pairing'];

/** Phases from which a fresh sighting is welcome. Anything else means the user
 *  has already committed to a box, and a straggler sighting from the sweep that
 *  was still draining must NOT yank the screen out from under them. */
const SIGHTING_OK: readonly SetupPhase['k'][] = ['idle', 'looking', 'stalled', 'nonet'];

/**
 * The whole state machine. Pure, total (never throws for any phase x event) and
 * IDENTITY for any event that does not apply — an unexpected event is ignored,
 * never a crash and never a silent jump to a wrong phase.
 */
export function nextPhase(p: SetupPhase, e: SetupEvent): SetupPhase {
  // Always available, from everywhere: the explicit path back to idle.
  if (e.t === 'RESET') return { k: 'idle' };

  switch (e.t) {
    case 'SWEEP_START':
      if (p.k === 'looking') return p; // already looking; keep `since`
      if (p.k === 'idle' || p.k === 'stalled' || p.k === 'nonet') {
        return { k: 'looking', since: e.now, sweeps: 0 };
      }
      return p;

    case 'SWEEP_EMPTY':
      return p.k === 'looking' ? { ...p, sweeps: p.sweeps + 1 } : p;

    case 'FOUND':
      if (!SIGHTING_OK.includes(p.k)) return p;
      return supportsPinPairing(e.box.version)
        ? { k: 'found', box: e.box }
        : { k: 'unsupported', box: e.box };

    case 'NO_NET':
      // Only while searching. A verdict arriving mid-pairing is not a reason to
      // throw away a live PIN.
      return SIGHTING_OK.includes(p.k) ? { k: 'nonet', verdict: e.verdict } : p;

    case 'GIVE_UP':
      return p.k === 'looking' ? { k: 'stalled', since: p.since, sweeps: p.sweeps } : p;

    case 'KEEP_LOOKING':
      if (p.k === 'stalled' || p.k === 'nonet' || p.k === 'idle') {
        return { k: 'looking', since: e.now, sweeps: 0 };
      }
      return p;

    case 'START_PIN':
      // From `found` (first time), from `failed` or `pin` ("Show a new PIN").
      if (p.k === 'found' || p.k === 'pin' || p.k === 'failed') {
        return { k: 'starting', box: p.box };
      }
      return p;

    case 'START_OK':
      if (p.k !== 'starting') return p;
      return { k: 'pin', box: p.box, expiresAt: e.now + Math.max(0, e.ttl) * 1000 };

    case 'START_ERR':
      // expiresAt 0: there is no live PIN, so the card must offer a new one
      // rather than a text field that can only fail.
      //
      // shown:false is the load-bearing half (FINDING 2, HIGH). This is the
      // pairStart-NEVER-SUCCEEDED path — the box dropped off Wi-Fi, or the 8s
      // timeout fired — so nothing was ever displayed on the TV. Reporting
      // "The PIN on <box> has expired" here states a PIN existed, alongside
      // "Could not reach that box", which are contradictory claims about the
      // same moment. The user goes looking at a TV showing nothing.
      return p.k === 'starting'
        ? { k: 'failed', box: p.box, msg: e.msg, expiresAt: 0, shown: false }
        : p;

    case 'UNSUPPORTED':
      return p.k === 'starting' || p.k === 'found' ? { k: 'unsupported', box: p.box } : p;

    case 'SUBMIT':
      if (p.k === 'pin' || p.k === 'failed') {
        return { k: 'pairing', box: p.box, expiresAt: p.expiresAt };
      }
      return p;

    case 'PAIR_OK':
      return p.k === 'pairing' ? { k: 'paired', box: p.box } : p;

    case 'PAIR_ERR':
      // Carry expiresAt: a wrong PIN (attempts 1-4) is retryable against the
      // SAME pairing, so retry must need no re-scan and no new PIN.
      return p.k === 'pairing'
        ? { k: 'failed', box: p.box, msg: e.msg, expiresAt: e.dead ? 0 : p.expiresAt,
           shown: true }
        : p;

    case 'BACK':
      return p.k === 'pin' || p.k === 'failed' || p.k === 'unsupported'
        ? { k: 'found', box: p.box }
        : p;
  }
}

/** Is a sweep loop supposed to be running in this phase? */
export function isSearching(p: SetupPhase): boolean {
  return p.k === 'looking';
}

/**
 * May a sweep run, and may a sighting be acted on, from this phase?
 *
 * The same predicate gates the reducer's FOUND rule and the component's loop, on
 * purpose: "the user has committed to a box" must mean one thing. False here is
 * what stops a straggler sighting — from the sweep that was still draining when
 * they tapped Pair now — from yanking the screen out from under a typed PIN.
 */
export function acceptsSighting(p: SetupPhase): boolean {
  return SIGHTING_OK.includes(p.k);
}

// ---------------------------------------------------------------------------
// The four steps
// ---------------------------------------------------------------------------

/** `todo` renders `·`, `active` renders `…`, `done` renders `✓`. */
export type StepMark = 'todo' | 'active' | 'done';

/**
 * The four onboarding steps' marks for a phase — i.e. the literal meaning of
 * "the card advances itself", as a function.
 *
 * Steps 1 and 2 happen on the user's PC and are UNVERIFIABLE from here, so they
 * are never marked done on a guess: they go done only once a box has actually
 * answered, which proves both. Step 3 ("watch this screen") is active only while
 * a sweep loop is genuinely running — when the card gives up, or cannot sweep,
 * it stops claiming to be watching.
 */
export function stepMarks(p: SetupPhase): [StepMark, StepMark, StepMark, StepMark] {
  switch (p.k) {
    case 'idle':
      return ['active', 'todo', 'todo', 'todo'];
    case 'looking':
      return ['active', 'active', 'active', 'todo'];
    case 'stalled':
    case 'nonet':
      return ['active', 'active', 'todo', 'todo'];
    case 'found':
    case 'starting':
    case 'pin':
    case 'pairing':
    case 'failed':
      return ['done', 'done', 'done', 'active'];
    case 'unsupported':
      return ['done', 'done', 'done', 'todo'];
    case 'paired':
      return ['done', 'done', 'done', 'done'];
  }
}
