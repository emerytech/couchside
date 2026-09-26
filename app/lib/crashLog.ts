/**
 * The app's local error log — the wiring half: storage, the global JS error
 * handler, the "closed unexpectedly" session marker, and the external store the
 * Setup card and the next-launch banner read. The data model and every decision
 * worth testing live in ./crashLogCore (import-free, bare-Node tested).
 *
 * Imported FIRST by app/_layout.tsx so the handler is chained before any screen
 * renders. Nothing here is ever sent anywhere: the log leaves the phone only
 * when the user taps Copy or Share (CLAUDE.md: no analytics, no crash SaaS).
 *
 * PERSISTENCE — the app's settings mechanism (expo-secure-store on native,
 * localStorage on web; the same split as lib/prefs.ts and friends), but through
 * the SYNCHRONOUS `getItem`/`setItem` rather than the async pair every other
 * module uses. That is deliberate and it is the whole best-effort story:
 *
 *   - A JS FATAL in a release build is handed to RN's ExceptionsManager, which
 *     throws natively and ends the process moments later. An async write queued
 *     from the handler may never reach disk. So the fatal path writes
 *     SYNCHRONOUSLY (Android: AES + SharedPreferences.commit(); iOS: a Keychain
 *     SecItemAdd/Update — both return only once written, per the SDK 57 module
 *     source) and only then calls the previous handler. Mark before you die.
 *   - Every write of the log is sync, not just the fatal one: an async write
 *     racing a later sync write can land AFTER it with an older snapshot and
 *     erase the fatal. Writes are rare (errors, Clear, Dismiss) and a non-fatal
 *     burst is coalesced, so the JS-thread cost is a few ms, occasionally.
 *   - NATIVE crashes run no JS at all and cannot be recorded. For those the
 *     session marker (see crashLogCore) is written sync on every foreground /
 *     background transition, and a marker still reading "fg" at the next launch
 *     becomes an inferred "closed unexpectedly" entry — no stack, but it points
 *     the user at the OS crash log. Only on native release builds: a web reload
 *     or a dev-server reload also "dies on screen" and would cry wolf.
 */
import * as SecureStore from 'expo-secure-store';
import { useSyncExternalStore } from 'react';
import { AppState, Platform, type AppStateStatus } from 'react-native';

import { lastExitReason } from '../modules/exit-reason';

import { APP_ID, APP_LABEL } from './appVersion';
import {
  appendEntry,
  chainGlobalHandler,
  clearPending,
  emptyLog,
  classifyExit,
  exitEntryFromMarker,
  exitRaisesBanner,
  formatReport,
  makeEntry,
  markPending,
  parseLog,
  parseMarker,
  serializeLog,
  serializeMarker,
  shrinkLog,
  type CrashEntry,
  type CrashKind,
  type CrashLog,
  type SessionMarker,
  type SessionState,
} from './crashLogCore';

export type { CrashEntry, CrashKind } from './crashLogCore';

const LOG_KEY = 'couchside.errorlog.v1';
const SESSION_KEY = 'couchside.session.v1';

// ---------- persistence (SecureStore native / localStorage web), SYNC ----------

function readSync(key: string): string | null {
  try {
    if (Platform.OS === 'web') {
      return typeof window !== 'undefined' && window.localStorage
        ? window.localStorage.getItem(key)
        : null;
    }
    return SecureStore.getItem(key);
  } catch {
    return null; // unreadable reads as empty — never block startup on the log
  }
}

function writeSync(key: string, value: string): boolean {
  try {
    if (Platform.OS === 'web') {
      if (typeof window === 'undefined' || !window.localStorage) return false;
      window.localStorage.setItem(key, value);
      return true;
    }
    SecureStore.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

// ---------- the store ----------

let log: CrashLog = emptyLog();
const listeners = new Set<() => void>();
function emit(): void {
  for (const l of listeners) l();
}
/** Listeners re-render components; never do that from inside an error handler
 *  (it can run mid-render). Defer to a clean turn. */
function emitSoon(): void {
  setTimeout(emit, 0);
}
function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}
const getLog = () => log;

/** Write the current log now. If storage refuses it (size), halve and retry,
 *  keeping the newest entries and the pending crash. */
function persistNow(): void {
  if (persistTimer) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
  let snap = log;
  for (let i = 0; i < 6; i++) {
    if (writeSync(LOG_KEY, serializeLog(snap))) return;
    const smaller = shrinkLog(snap);
    if (smaller.entries.length === snap.entries.length) return;
    snap = smaller;
  }
}

let persistTimer: ReturnType<typeof setTimeout> | null = null;
/** Non-fatal errors can come in bursts (a render loop, a mashed button): write
 *  once for the burst. Still a SYNC write when it fires — see header. */
function persistSoon(): void {
  if (persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    persistNow();
  }, 300);
}

// ---------- session marker ----------

// Native release builds only (see header): a web or Metro reload is not a crash.
const markersEnabled = Platform.OS !== 'web' && !__DEV__;
let route = '';
let marker: SessionMarker = { state: 'fg', ts: Date.now(), app: APP_LABEL, route: '' };

function writeMarker(state: SessionState): void {
  if (!markersEnabled) return;
  // Once a fatal is recorded the process is going down; don't let a late
  // AppState event turn that back into "fg" and add a second, stackless entry.
  if (marker.state === 'crashed' && state !== 'crashed') return;
  marker = { state, ts: Date.now(), app: APP_LABEL, route };
  writeSync(SESSION_KEY, serializeMarker(marker));
}

let routeTimer: ReturnType<typeof setTimeout> | null = null;
/**
 * The screen the user is on, for context in entries and in the marker. Called
 * by CrashBanner on every pathname change. The marker write is throttled (a
 * tab flurry is one write) and writes whatever state is CURRENT when it fires,
 * so it can never resurrect "fg" after the app went to the background.
 */
export function noteRoute(path: string): void {
  route = path;
  if (!markersEnabled || routeTimer) return;
  routeTimer = setTimeout(() => {
    routeTimer = null;
    if (marker.state === 'fg') writeMarker('fg');
  }, 1000);
}

// ---------- recording ----------

function record(error: unknown, kind: CrashKind): string {
  const res = appendEntry(log, makeEntry(error, kind, Date.now(), { app: APP_LABEL, route }));
  log = res.log;
  return res.id;
}

function onGlobalError(error: unknown, isFatal: boolean): void {
  if (isFatal) {
    const id = record(error, 'fatal');
    log = markPending(log, id);
    persistNow(); // SYNC, before the chained handler ends the process
    writeMarker('crashed');
  } else {
    record(error, 'error');
    persistSoon();
  }
  emitSoon(); // dev and web keep running after a "fatal"; refresh the UI
}

const boundaryErrors = new WeakSet<object>();
/** A render error the root ErrorBoundary caught (recoverable, so not fatal).
 *  Once per error object: a remount or StrictMode re-run must not double it. */
export function recordScreenError(error: unknown): void {
  try {
    if (error && typeof error === 'object') {
      if (boundaryErrors.has(error)) return;
      boundaryErrors.add(error);
    }
    record(error, 'render');
    persistSoon();
    emitSoon();
  } catch {
    // never let the log be what breaks the crash screen
  }
}

// ---------- install (at import) ----------

let installed = false;
function install(): void {
  if (installed) return;
  installed = true;
  log = parseLog(readSync(LOG_KEY));

  if (markersEnabled) {
    // Previous process: did it die on screen with no JS fatal recorded?
    const newest = log.entries[log.entries.length - 1];
    const prev = parseMarker(readSync(SESSION_KEY));
    // Ask the OS why that process ended (Android 11+) before calling it a crash:
    // an APK/Play update or a Force stop also leaves the marker at `fg`. Only
    // consulted when the marker says it died on screen. lastExitReason() never throws.
    const info = prev?.state === 'fg' ? lastExitReason() : null;
    const decision = prev?.state === 'fg' ? classifyExit(info, prev.ts, Platform.OS) : undefined;
    const exit = exitEntryFromMarker(prev, undefined, newest?.lastTs ?? 0, decision, info);
    if (exit) {
      const res = appendEntry(log, exit);
      // A system kill (low memory, …) is logged for diagnosis but raises no banner.
      log = exitRaisesBanner(exit) ? markPending(res.log, res.id) : res.log;
      persistNow();
    }
    const now = AppState.currentState;
    writeMarker(now === 'background' ? 'bg' : 'fg');
    AppState.addEventListener('change', (s: AppStateStatus) => {
      writeMarker(s === 'active' ? 'fg' : 'bg');
    });
  }

  // ErrorUtils is RN's error-guard polyfill. This project's Expo web export
  // DOES include it (Metro applies RN's polyfills to web too — measured in the
  // harness 2026-09-26; its default handler re-throws), but nothing guarantees
  // it on web, so a missing/malformed one makes chainGlobalHandler a no-op.
  chainGlobalHandler((globalThis as { ErrorUtils?: unknown }).ErrorUtils, onGlobalError);
}

try {
  install();
} catch {
  // The log is a diagnostic; failing to set it up must never stop the app.
}

// ---------- public API ----------

export function useCrashLog(): CrashLog {
  return useSyncExternalStore(subscribe, getLog, getLog);
}

/** The crash the next-launch banner should offer, or null. */
export function usePendingCrash(): CrashEntry | null {
  const l = useCrashLog();
  return l.pending ? l.entries.find((e) => e.id === l.pending) ?? null : null;
}

/** Banner handled (copied or dismissed): once per crash. */
export function dismissPendingCrash(): void {
  log = clearPending(log);
  persistNow();
  emit();
}

export function clearCrashLog(): void {
  log = emptyLog();
  persistNow();
  emit();
}

function deviceLine(): string {
  const os = Platform.OS;
  const v = Platform.Version;
  if (os === 'android') {
    const c = Platform.constants as { Release?: string; Brand?: string; Model?: string };
    const model = [c.Brand, c.Model].filter(Boolean).join(' ');
    return `android ${c.Release ?? '?'} (API ${v})${model ? ` · ${model}` : ''}`;
  }
  if (os === 'web') return 'web';
  return `${os} ${v ?? ''}`.trim();
}

/** The whole log as text for Copy / Share, newest first, with the app + device
 *  header that decides which source map symbolicates it. */
export function crashReport(): string {
  return formatReport(log.entries, { app: APP_LABEL, appId: APP_ID, device: deviceLine(), now: Date.now() });
}

/** A single thrown value as report text (the crash screen: the error in hand,
 *  whether or not it made it into the log). */
export function errorReport(error: unknown): string {
  const e = makeEntry(error, 'render', Date.now(), { app: APP_LABEL, route });
  return formatReport([e], { app: APP_LABEL, appId: APP_ID, device: deviceLine(), now: Date.now() });
}
