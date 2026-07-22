/**
 * App-wide scalar preferences, persisted as a single JSON blob.
 *
 * This complements the single-boolean external stores (haptics.ts, keepAwake.ts):
 * rather than a separate module per small enum/number setting, the handful added
 * here live together. Same external-store shape so a `<Switch>` or segmented
 * control can read/write a field and re-render live via usePref(); non-React
 * code reads getPref(). Unknown/missing/invalid fields fall back to DEFAULTS on
 * load, so older stored blobs and new keys both work.
 */
import * as SecureStore from 'expo-secure-store';
import { useSyncExternalStore } from 'react';
import { Platform } from 'react-native';

import { PadMode } from './settings';

/** Tabs the app can open on. Values are the expo-router route names ('index' is
 *  Console). Setup is deliberately not offered: nobody wants to land there, and
 *  first-run already forces it when no box is paired. */
export const LANDING_TABS = ['index', 'actions', 'pad', 'launch'] as const;
export type LandingTab = (typeof LANDING_TABS)[number];

export type Prefs = {
  /** Ask before suspending the box (the Suspend button in the header). */
  confirmSuspend: boolean;
  /** Which tab the app opens on.
   *
   *  Defaults to 'index' (Console) because that is what the app has ALWAYS
   *  actually done, whatever the layout claimed. `unstable_settings.
   *  initialRouteName = 'pad'` sits in app/(tabs)/_layout.tsx under a comment
   *  saying "Default screen = the swipe Remote (Pad)", but the index route wins
   *  on cold start and Console is what opens — verified in the harness, where
   *  loading "/" leaves Console as the active tab. Changing the default here
   *  would move every existing user's landing screen, so it stays on the
   *  observed behaviour and the choice becomes theirs. */
  landingTab: LandingTab;
  /** Raise the phone's keyboard when the BOX raises its own.
   *
   *  Steam's on-screen keyboard is a letter grid you drive with a d-pad. When
   *  it opens, you almost always want to type on the phone instead — so the
   *  agent reports the event and the app focuses its compose field. Default ON:
   *  it only fires at the exact moment a keyboard is already wanted. Agent
   *  >= 2.9.38; older agents never send the frame and this stays inert. */
  autoKeyboard: boolean;
  /** Drive the swipe/remote surfaces with KEYBOARD keys instead of a virtual
   *  gamepad.
   *
   *  Steam navigates identically from arrow keys, but the pad has a cost the
   *  keyboard does not: the agent creates a virtual controller on connect, so
   *  the PC announces "controller connected" every time the app foregrounds,
   *  and a game already running sees a SECOND controller that can steal player
   *  one. In keyboard mode the agent is asked not to create a pad at all.
   *
   *  Off by default — the pad is what the app has always sent, and the d-pad
   *  path is better tested. Needs agent >= 2.9.39; older agents ignore the
   *  request and keep creating a pad, so the app still works, just without the
   *  benefit. The dedicated PAD screen always sends gamepad frames regardless:
   *  a gamepad screen with no gamepad would be a lie. */
  keyboardMode: boolean;
  /** Input mode a newly paired box starts on. */
  /** Where the Steam search button sits on the keyboard bar, or 'off' to hide
   *  it entirely.
   *
   *  Defaults to LEFT: the bar's right end is where the thumb rests and where
   *  PASTE/HIDE appear once the bar opens, so a search button there is easy to
   *  hit by accident. Handedness varies, so side is a preference rather than a
   *  decision — and 'off' exists because a control you never use is still a
   *  control you can fat-finger. */
  searchButtonSide: 'left' | 'right' | 'off';
  /** Collapse the "Stream from PC" card on the Launch tab to just its header.
   *  Distinct from hiding it: a collapsed card still says the feature is there
   *  and reopens in one tap, which a hidden one cannot. Persisted, because a
   *  section you fold away should stay folded. */
  streamCollapsed: boolean;
  defaultPadMode: PadMode;
  /** How often the console/header polls the box for vitals (ms). */
  statusIntervalMs: number;
  /** Journal lines fetched per unit on the Logs tab. */
  journalLines: number;
  /** Swipe-surface sensitivity multiplier (higher = smaller step, more steps). */
  swipeSensitivity: number;
  /** Trackpad pointer-speed multiplier. */
  trackpadSensitivity: number;
  /** Invert two-finger scroll direction (macOS-style "natural" scrolling). */
  naturalScroll: boolean;
  // ---- Pad layout: every optional button row/view can be hidden ----
  /** L/M/R mouse-button row under the trackpad. */
  padMouseRow: boolean;
  /** STEAM + QAM (⋯) buttons in the trackpad button row. */
  padSteamRow: boolean;
  /** Desktop-nav cluster (Start/Overview/Esc…) + the D-pad↔trackpad toggle. */
  padDesktopNav: boolean;
  /** Windows shortcut row (WIN/ALT+TAB/LOCK/TASK) on ViGEm boxes. */
  padWinShortcuts: boolean;
  /** The KEYBOARD bar at the bottom of the Pad tab. */
  padKeyboardBar: boolean;
  /** Gesture hint text on the swipe/trackpad surfaces. */
  padHints: boolean;
  /** When another phone joins a box you're controlling, ask before handing
      over (true) vs let it grab control immediately (false). Agent >= 2.9.2. */
  askToSwitchControl: boolean;
  /** Let the phone's hardware Vol +/- buttons drive the box/TV volume while the
      Remote screen is open. Default ON for Android; OFF for iOS, where the OS
      volume HUD can't be suppressed and repurposing the buttons is App-Review
      risky (opt-in, experimental). */
  volumeButtons: boolean;
  /** Drop hosts the box reports as offline from the Launch tab's "Stream from
      PC" list entirely, rather than dimming them. Off by default: the online
      check is conservative and does call a live host offline, so the row stays
      visible and tappable unless you ask for it gone. Agent >= 2.9.32. */
  hideOfflineStreamHosts: boolean;
  /** Drop the Launch tab's "Stream from PC" section entirely.
   *
   *  Distinct from hideOfflineStreamHosts, which only filters rows: this hides
   *  the whole card. Asked for by a user running SteamOS on their main PC with
   *  Remote Play disabled -- every host listed was one they would never stream
   *  from, and there was no way to make the section go away. The agent cannot
   *  currently tell "Remote Play is off" from "no host is online", so this stays
   *  a manual switch rather than an auto-hide; guessing wrong here removes a
   *  working feature. */
  hideStreamFromPc: boolean;
  /** Drop the TV side of the Box/TV volume switch.
   *
   *  On a setup where the box's own volume already reaches the speakers -- CEC
   *  forwarding, an AVR, a soundbar over ARC -- the TV target adjusts the TV's
   *  internal speakers, which may be muted or unused. Reported by a user whose
   *  TV outputs to a soundbar: "Box" was right and "TV" moved a volume nothing
   *  was playing through. */
  hideTvVolume: boolean;
  // ---- Touch indicators: making a screen recording of this app legible ----
  /** Draw a ring wherever a finger lands. iOS exposes NO public API for
      system-wide touch events -- no equivalent of Android's "Show taps", and no
      screen recorder can draw touches from another app -- so the only process
      that can show what was pressed is this one. Off by default; the whole
      feature is inert until asked for. */
  showTaps: boolean;
  /** Also leave a trail of dots while a finger moves, which is what makes the
      swipe remote and the trackpad readable on video. Requires showTaps. Off by
      default: it emits a mark every 45ms, which is pure noise outside a
      recording. */
  traceDrags: boolean;
};

export const DEFAULTS: Prefs = {
  confirmSuspend: true,
  landingTab: 'index',
  autoKeyboard: true,
  keyboardMode: false,
  searchButtonSide: 'left',
  streamCollapsed: false,
  defaultPadMode: 'swipe',
  statusIntervalMs: 5000,
  journalLines: 100,
  swipeSensitivity: 1,
  trackpadSensitivity: 1,
  naturalScroll: false,
  padMouseRow: true,
  padSteamRow: true,
  padDesktopNav: true,
  padWinShortcuts: true,
  padKeyboardBar: true,
  padHints: true,
  askToSwitchControl: true,
  // Android intercepts the keycode cleanly (no HUD); iOS can't, so it stays off
  // until the user opts in.
  volumeButtons: Platform.OS === 'android',
  hideOfflineStreamHosts: false,
  hideStreamFromPc: false,
  hideTvVolume: false,
  showTaps: false,
  traceDrags: false,
};

/** The choices each select-style pref offers (kept next to the store it feeds). */
export const STATUS_INTERVAL_OPTIONS = [2000, 5000, 15000, 30000] as const;
export const JOURNAL_LINE_OPTIONS = [50, 100, 250, 500] as const;
export const SENSITIVITY_OPTIONS = [0.6, 1, 1.6] as const;

const KEY = 'couchside.prefs.v1';

// ---------- persistence (SecureStore native / localStorage web) ----------

async function storageGet(key: string): Promise<string | null> {
  if (Platform.OS === 'web') {
    try {
      return typeof window !== 'undefined' && window.localStorage
        ? window.localStorage.getItem(key)
        : null;
    } catch {
      return null;
    }
  }
  return SecureStore.getItemAsync(key);
}

async function storageSet(key: string, value: string): Promise<void> {
  if (Platform.OS === 'web') {
    try {
      if (typeof window !== 'undefined' && window.localStorage) {
        window.localStorage.setItem(key, value);
      }
    } catch {
      // storage unavailable (private mode): prefs live in memory this session
    }
    return;
  }
  await SecureStore.setItemAsync(key, value);
}

// ---------- external store ----------

let prefs: Prefs = { ...DEFAULTS };
const listeners = new Set<() => void>();

function emitChange(): void {
  for (const l of listeners) l();
}

/** Coerce a parsed blob into a valid Prefs, filling anything missing/invalid. */
function normalize(raw: unknown): Prefs {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const num = (v: unknown, allowed: readonly number[], fallback: number): number =>
    typeof v === 'number' && allowed.includes(v) ? v : fallback;
  const bool = (v: unknown, fallback: boolean): boolean =>
    typeof v === 'boolean' ? v : fallback;
  const padMode: PadMode =
    o.defaultPadMode === 'gamepad' ||
    o.defaultPadMode === 'trackpad' ||
    o.defaultPadMode === 'remote'
      ? o.defaultPadMode
      : 'swipe';
  const streamCollapsed = bool(o.streamCollapsed, DEFAULTS.streamCollapsed);
  const searchSide: 'left' | 'right' | 'off' =
    o.searchButtonSide === 'right' || o.searchButtonSide === 'off'
      ? o.searchButtonSide
      : 'left';
  const landingTab: LandingTab = LANDING_TABS.includes(o.landingTab as LandingTab)
    ? (o.landingTab as LandingTab)
    : DEFAULTS.landingTab;
  return {
    searchButtonSide: searchSide,
    streamCollapsed,
    confirmSuspend:
      typeof o.confirmSuspend === 'boolean' ? o.confirmSuspend : DEFAULTS.confirmSuspend,
    landingTab,
    autoKeyboard: bool(o.autoKeyboard, DEFAULTS.autoKeyboard),
    keyboardMode: bool(o.keyboardMode, DEFAULTS.keyboardMode),
    defaultPadMode: padMode,
    statusIntervalMs: num(o.statusIntervalMs, STATUS_INTERVAL_OPTIONS, DEFAULTS.statusIntervalMs),
    journalLines: num(o.journalLines, JOURNAL_LINE_OPTIONS, DEFAULTS.journalLines),
    swipeSensitivity: num(o.swipeSensitivity, SENSITIVITY_OPTIONS, DEFAULTS.swipeSensitivity),
    trackpadSensitivity: num(o.trackpadSensitivity, SENSITIVITY_OPTIONS, DEFAULTS.trackpadSensitivity),
    naturalScroll: bool(o.naturalScroll, DEFAULTS.naturalScroll),
    padMouseRow: bool(o.padMouseRow, DEFAULTS.padMouseRow),
    padSteamRow: bool(o.padSteamRow, DEFAULTS.padSteamRow),
    padDesktopNav: bool(o.padDesktopNav, DEFAULTS.padDesktopNav),
    padWinShortcuts: bool(o.padWinShortcuts, DEFAULTS.padWinShortcuts),
    padKeyboardBar: bool(o.padKeyboardBar, DEFAULTS.padKeyboardBar),
    padHints: bool(o.padHints, DEFAULTS.padHints),
    askToSwitchControl: bool(o.askToSwitchControl, DEFAULTS.askToSwitchControl),
    volumeButtons: bool(o.volumeButtons, DEFAULTS.volumeButtons),
    hideOfflineStreamHosts: bool(o.hideOfflineStreamHosts, DEFAULTS.hideOfflineStreamHosts),
    hideStreamFromPc: bool(o.hideStreamFromPc, DEFAULTS.hideStreamFromPc),
    hideTvVolume: bool(o.hideTvVolume, DEFAULTS.hideTvVolume),
    showTaps: bool(o.showTaps, DEFAULTS.showTaps),
    traceDrags: bool(o.traceDrags, DEFAULTS.traceDrags),
  };
}

let loadStarted = false;
/** Load the persisted prefs once. Safe to call repeatedly. */
export async function loadPrefs(): Promise<void> {
  if (loadStarted) return;
  loadStarted = true;
  const raw = await storageGet(KEY);
  if (raw == null) return;
  try {
    const next = normalize(JSON.parse(raw));
    prefs = next;
    emitChange();
  } catch {
    // malformed blob: keep defaults
  }
}
// Kick the load off at import so values are ready by first interaction.
void loadPrefs();

export function getPref<K extends keyof Prefs>(key: K): Prefs[K] {
  return prefs[key];
}

export async function setPref<K extends keyof Prefs>(key: K, value: Prefs[K]): Promise<void> {
  if (prefs[key] === value) return;
  prefs = { ...prefs, [key]: value };
  emitChange();
  await storageSet(KEY, JSON.stringify(prefs));
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

/** React hook: live value of a single preference (for a Switch/segmented control). */
export function usePref<K extends keyof Prefs>(key: K): Prefs[K] {
  return useSyncExternalStore(
    subscribe,
    () => prefs[key],
    () => prefs[key],
  );
}
