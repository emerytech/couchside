/**
 * The app's local error log — the PURE half (no imports, runs under bare Node).
 *
 * WHY THIS EXISTS (2026-09-26). A direct-edition APK user on Android 15 reported
 * intermittent crashes while spamming buttons on the Pad tab's Remote surface,
 * and there was no way to get a crash out of the app without adb: the crash
 * screen showed four lines of `error.message`, nothing was persisted, and the
 * Pad diagnostics "copy" only vibrated. This module is the data model for a
 * small ring buffer of recent errors that the user can COPY or SHARE themselves.
 *
 * NOTHING HERE IS EVER SENT ANYWHERE. Couchside is LAN-only with no analytics
 * and no crash SaaS (CLAUDE.md). The log lives on the phone; getting it out is
 * always a deliberate tap on Copy or Share by the person holding it.
 *
 * Kept import-free on purpose (the CONVENTIONS "App-side lifecycle tests"
 * rule): lib/__tests__/crashLog.test.ts loads it with
 * `node --experimental-strip-types` and no node_modules. The storage, AppState
 * and ErrorUtils wiring live in lib/crashLog.ts.
 *
 * WHAT IT CAN AND CANNOT CATCH — the honest limit:
 *   - JS errors that reach React Native's global handler (a throw in an onPress,
 *     a timer, a native->JS callback; RN reports those as FATAL and, in a release
 *     build, kills the process right after). Recorded with message + stack.
 *   - Render errors the root ErrorBoundary catches. Recorded, not fatal.
 *   - NATIVE crashes (a Java/Kotlin/ObjC throw, a segfault in a native module)
 *     never run any JS, so they cannot be recorded. The best this can do is
 *     notice on the NEXT launch that the previous process died while it was on
 *     screen (the session marker below) and say so — with no stack. The real
 *     stack is in the OS crash log (`adb logcat -b crash`), which the Setup card
 *     explains how to get.
 */

/** How the entry happened. `exit` is the inferred one: no JS ran, see above. */
export type CrashKind = 'fatal' | 'error' | 'render' | 'exit';
const KINDS: readonly CrashKind[] = ['fatal', 'error', 'render', 'exit'];

export type CrashEntry = {
  /** Unique per entry; the pending-banner pointer refers to it. */
  id: string;
  /** First occurrence, ms since epoch. For `exit`: last time it was known to be
   *  on screen (the process died some time after this). */
  ts: number;
  /** Last occurrence; equals `ts` unless identical errors were folded together. */
  lastTs: number;
  /** How many times this exact error repeated back-to-back (folded, see DEDUPE_MS). */
  count: number;
  kind: CrashKind;
  name: string;
  message: string;
  /** Redacted + truncated. Empty for `exit`. */
  stack: string;
  /** App version at the time, e.g. "2.9.61 (vc 109)". After an update, the
   *  version that crashed is not the one reading the log. */
  app: string;
  /** Last screen path known when it happened ('' if unknown). Best effort. */
  route: string;
  /** `exit` only: how the OS classified the previous process's death (see classifyExit).
   *  Absent on entries recorded before 2026-09-26 and on non-exit kinds. */
  exitVerdict?: ExitVerdict;
  /** `exit` only: Android ApplicationExitInfo reason code, or EXIT_REASON_UNAVAILABLE. */
  exitCode?: number;
};

export type CrashLog = {
  v: 1;
  /** Oldest first. */
  entries: CrashEntry[];
  /** Id of the crash the next-launch banner should offer to copy, or null. Set
   *  by a fatal / an inferred exit; cleared by Copy or Dismiss — once per crash. */
  pending: string | null;
};

/** Entries kept. Older ones fall off the front. */
export const LOG_CAP = 20;
/** Per-field caps. A Hermes release stack line is ~70 chars, so STACK_MAX keeps
 *  the top ~25 frames — the ones that matter. */
export const NAME_MAX = 80;
export const MESSAGE_MAX = 500;
export const STACK_MAX = 2000;
export const ROUTE_MAX = 120;
export const APP_MAX = 60;
/**
 * Whole-log budget in UTF-8 bytes. The log persists in expo-secure-store (the
 * app's settings mechanism), whose SDK 57 docs warn that "large payloads can be
 * rejected by the underlying platform". The app already keeps multi-KB values
 * there (boxes, LED presets); this stays well under anything measured as a
 * problem, and lib/crashLog.ts still halves and retries if a write is refused.
 */
export const LOG_BYTES_MAX = 24_000;
/** The same error repeating within this window folds into one entry (count++)
 *  instead of flushing every other entry out of a 20-slot buffer. */
export const DEDUPE_MS = 10_000;

export function emptyLog(): CrashLog {
  return { v: 1, entries: [], pending: null };
}

/** Cut `s` to at most `max` chars, saying how much was dropped. */
export function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  const keep = Math.max(0, max - 24);
  return `${s.slice(0, keep)}… [+${s.length - keep} chars]`;
}

/**
 * Scrub anything that looks like a bearer credential before it is stored. The
 * app handles a box token and pairing links (`…#host=…&token=…`); an error
 * message that quotes one must not put it in a log the user will paste into a
 * bug report. Over-redaction is fine; a leak is not.
 */
export function redact(s: string): string {
  return s
    .replace(/\b(Bearer)\s+[A-Za-z0-9._~+/=-]+/gi, '$1 [redacted]')
    .replace(/(token["']?\s*[=:]\s*["']?)[^\s&"',;}\]#]+/gi, '$1[redacted]');
}

type Described = { name: string; message: string; stack: string };

/** Read name/message/stack off anything that was thrown, never throwing itself
 *  (a hostile getter, a revoked proxy, `throw null` are all possible). */
export function describeError(err: unknown): Described {
  try {
    if (err !== null && typeof err === 'object') {
      const o = err as { name?: unknown; message?: unknown; stack?: unknown };
      const message = typeof o.message === 'string' ? o.message : safeString(err);
      const name = typeof o.name === 'string' && o.name ? o.name : 'Error';
      let stack = typeof o.stack === 'string' ? o.stack : '';
      // Hermes/V8 stacks begin with "Name: message" — already shown, drop it.
      const head = `${name}: ${message}`;
      if (stack.startsWith(head)) stack = stack.slice(head.length).replace(/^\r?\n/, '');
      return { name, message, stack };
    }
    return { name: 'Thrown', message: safeString(err), stack: '' };
  } catch {
    return { name: 'Thrown', message: '(unreadable error)', stack: '' };
  }
}

function safeString(v: unknown): string {
  try {
    if (typeof v === 'string') return v;
    if (v !== null && typeof v === 'object') {
      const j = JSON.stringify(v);
      if (typeof j === 'string') return j;
    }
    return String(v);
  } catch {
    return '(unprintable value)';
  }
}

function newId(now: number): string {
  return `${now.toString(36)}-${Math.floor(Math.random() * 1e9).toString(36)}`;
}

export type EntryContext = { app: string; route: string; id?: string };

/** Build a stored entry from a thrown value: redacted, truncated, stamped. */
export function makeEntry(err: unknown, kind: CrashKind, now: number, ctx: EntryContext): CrashEntry {
  const d = describeError(err);
  return {
    id: ctx.id ?? newId(now),
    ts: now,
    lastTs: now,
    count: 1,
    kind,
    name: truncate(redact(d.name), NAME_MAX),
    message: truncate(redact(d.message), MESSAGE_MAX),
    stack: truncate(redact(d.stack), STACK_MAX),
    app: truncate(ctx.app, APP_MAX),
    route: truncate(redact(ctx.route), ROUTE_MAX),
  };
}

function firstLine(s: string): string {
  const i = s.indexOf('\n');
  return i < 0 ? s : s.slice(0, i);
}

function sameError(a: CrashEntry, b: CrashEntry): boolean {
  return (
    a.kind === b.kind &&
    a.name === b.name &&
    a.message === b.message &&
    firstLine(a.stack) === firstLine(b.stack)
  );
}

/** UTF-8 byte length without TextEncoder (keeps this module dependency-free). */
export function utf8Length(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff) {
      n += 4;
      i++; // the low surrogate is part of the same code point
    } else n += 3;
  }
  return n;
}

/** Drop the OLDEST entries (never the pending one) until the log fits the byte
 *  budget. Always keeps at least one entry. */
export function fitBudget(log: CrashLog, maxBytes = LOG_BYTES_MAX): CrashLog {
  let entries = log.entries;
  while (entries.length > 1 && utf8Length(JSON.stringify({ ...log, entries })) > maxBytes) {
    const drop = entries.findIndex((e) => e.id !== log.pending);
    if (drop < 0) break;
    entries = entries.slice(0, drop).concat(entries.slice(drop + 1));
  }
  return entries === log.entries ? log : withPendingChecked({ ...log, entries });
}

function withPendingChecked(log: CrashLog): CrashLog {
  if (log.pending && !log.entries.some((e) => e.id === log.pending)) return { ...log, pending: null };
  return log;
}

/**
 * Append one entry. An error identical to the newest entry within DEDUPE_MS is
 * folded into it (count++, lastTs updated) rather than stored again — a render
 * loop or a button mashed fifty times must not evict the one different error
 * that explains it. Returns the new log and the id the entry landed under.
 */
export function appendEntry(log: CrashLog, entry: CrashEntry): { log: CrashLog; id: string } {
  const last = log.entries[log.entries.length - 1];
  if (last && sameError(last, entry) && entry.ts - last.lastTs <= DEDUPE_MS && entry.ts >= last.lastTs) {
    const merged: CrashEntry = { ...last, count: last.count + 1, lastTs: entry.ts };
    return { log: { ...log, entries: [...log.entries.slice(0, -1), merged] }, id: last.id };
  }
  const entries = [...log.entries, entry].slice(-LOG_CAP);
  return { log: fitBudget(withPendingChecked({ ...log, entries })), id: entry.id };
}

export function markPending(log: CrashLog, id: string): CrashLog {
  return log.entries.some((e) => e.id === id) ? { ...log, pending: id } : log;
}

export function clearPending(log: CrashLog): CrashLog {
  return log.pending === null ? log : { ...log, pending: null };
}

/** Halve the log (newest kept, pending kept) — the retry when storage refuses a write. */
export function shrinkLog(log: CrashLog): CrashLog {
  if (log.entries.length <= 1) return log;
  const keep = Math.ceil(log.entries.length / 2);
  let entries = log.entries.slice(-keep);
  const pend = log.pending ? log.entries.find((e) => e.id === log.pending) : undefined;
  if (pend && !entries.includes(pend)) entries = [pend, ...entries.slice(1)];
  return withPendingChecked({ ...log, entries });
}

export function serializeLog(log: CrashLog): string {
  return JSON.stringify(fitBudget(log));
}

function str(v: unknown, max: number): string {
  return typeof v === 'string' ? truncate(v, max) : '';
}

function sanitizeEntry(raw: unknown): CrashEntry | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.id !== 'string' || !o.id || o.id.length > 64) return null;
  if (typeof o.ts !== 'number' || !Number.isFinite(o.ts) || o.ts <= 0) return null;
  if (typeof o.kind !== 'string' || !KINDS.includes(o.kind as CrashKind)) return null;
  if (typeof o.message !== 'string') return null;
  const lastTs = typeof o.lastTs === 'number' && Number.isFinite(o.lastTs) && o.lastTs >= o.ts ? o.lastTs : o.ts;
  const count = typeof o.count === 'number' && Number.isInteger(o.count) && o.count >= 1 ? o.count : 1;
  return {
    id: o.id,
    ts: o.ts,
    lastTs,
    count,
    kind: o.kind as CrashKind,
    name: str(o.name, NAME_MAX) || 'Error',
    message: truncate(o.message, MESSAGE_MAX),
    stack: str(o.stack, STACK_MAX),
    app: str(o.app, APP_MAX),
    route: str(o.route, ROUTE_MAX),
    ...(o.kind === 'exit' && typeof o.exitVerdict === 'string' && (EXIT_VERDICTS as readonly string[]).includes(o.exitVerdict)
      ? { exitVerdict: o.exitVerdict as ExitVerdict }
      : {}),
    ...(o.kind === 'exit' && typeof o.exitCode === 'number' && Number.isInteger(o.exitCode) && o.exitCode >= -1 && o.exitCode <= 99
      ? { exitCode: o.exitCode }
      : {}),
  };
}

/**
 * Stored string -> log, NEVER throwing. A blob that is not JSON, not an object,
 * or from a future shape reads as an empty log; individual bad entries are
 * dropped and the good ones kept. A corrupt log must never be why the app
 * cannot start — this runs at import time, before any UI.
 */
export function parseLog(raw: string | null | undefined): CrashLog {
  if (!raw) return emptyLog();
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return emptyLog();
  }
  if (!data || typeof data !== 'object' || !Array.isArray((data as { entries?: unknown }).entries)) {
    return emptyLog();
  }
  const d = data as { entries: unknown[]; pending?: unknown };
  const entries = d.entries
    .map(sanitizeEntry)
    .filter((e): e is CrashEntry => e !== null)
    .slice(-LOG_CAP);
  const pending = typeof d.pending === 'string' ? d.pending : null;
  return withPendingChecked({ v: 1, entries, pending });
}

// ---------------------------------------------------------------- session marker

/**
 * The "did the last process die on screen?" marker, for crashes no JS saw.
 *
 * lib/crashLog.ts writes it SYNCHRONOUSLY: `fg` when the app becomes active,
 * `bg` on any move away from active (iOS `inactive` included — the app switcher
 * is inactive, and a swipe-kill from there is the user's choice, not a crash),
 * and `crashed` when a JS fatal has already been recorded. On the next launch a
 * marker still reading `fg` means the process ended while it was on screen
 * without ever leaving it: a native crash, an ANR the user closed, or the OS
 * killing it (e.g. low memory). Rare false positives (the phone powered off
 * with the app open) are why the banner words it as "closed unexpectedly", not
 * "crashed".
 */
export type SessionState = 'fg' | 'bg' | 'crashed';
export type SessionMarker = { state: SessionState; ts: number; app: string; route: string };

export function parseMarker(raw: string | null | undefined): SessionMarker | null {
  if (!raw) return null;
  try {
    const o = JSON.parse(raw) as Record<string, unknown>;
    if (!o || typeof o !== 'object') return null;
    if (o.state !== 'fg' && o.state !== 'bg' && o.state !== 'crashed') return null;
    if (typeof o.ts !== 'number' || !Number.isFinite(o.ts)) return null;
    return { state: o.state, ts: o.ts, app: str(o.app, APP_MAX), route: str(o.route, ROUTE_MAX) };
  } catch {
    return null;
  }
}

export function serializeMarker(m: SessionMarker): string {
  return JSON.stringify(m);
}

// ---------------------------------------------------------------- exit reason (Android 11+)

/**
 * WHY. A marker still reading `fg` only says the previous process ended while on
 * screen. On a real phone that is far more often an APK/Play UPDATE or a Force
 * stop than a crash (Razr 2023, Android 16, 2026-09-26: `dumpsys activity
 * exit-info` said PACKAGE_UPDATED and FORCE STOP while the banner claimed "likely a
 * native crash"). Android 11+ records WHY each process died
 * (ActivityManager.getHistoricalProcessExitReasons -> ApplicationExitInfo); the
 * local module app/modules/exit-reason reads the newest record and this pure code
 * decides what to say. Codes are ApplicationExitInfo.REASON_* (verified against
 * the android-36.1 SDK sources).
 *
 * VERDICTS:
 *   crash   — CRASH, CRASH_NATIVE, ANR, INITIALIZATION_FAILURE: the app failed.
 *             Entry + next-launch banner, worded with what Android reported.
 *   system  — LOW_MEMORY, SIGNALED, EXCESSIVE_RESOURCE_USAGE: the system ended a
 *             process that was on screen. Not a crash in the app, but the user saw
 *             it vanish and it matters for diagnosis (e.g. memory pressure while
 *             streaming), so it is LOGGED — with no banner. SIGNALED belongs here
 *             because on devices without LMK reporting a low-memory kill is
 *             reported as SIGNALED + SIGKILL (ApplicationExitInfo javadoc).
 *   benign  — every other known reason (PACKAGE_UPDATED, USER_REQUESTED = Force
 *             stop / swipe from Recents, EXIT_SELF, USER_STOPPED,
 *             PERMISSION_CHANGE, DEPENDENCY_DIED, OTHER, FREEZER,
 *             PACKAGE_STATE_CHANGE). Nothing recorded: an update is not an error.
 *   unknown — no usable record: OS call unavailable (< Android 11, iOS has no
 *             module), failed, REASON_UNKNOWN, a code this build does not know, or
 *             a record OLDER than the marker (it describes an earlier process).
 *             Degrade closed: keep the old inference, but say "may have".
 *   legacy  — iOS and entries recorded before this change: today's wording.
 *             (iOS does not update or force-kill a FOREGROUND app, so an `fg`
 *             marker there is still most likely a crash.)
 */
export type ExitVerdict = 'crash' | 'system' | 'benign' | 'unknown' | 'legacy';
export const EXIT_VERDICTS: readonly ExitVerdict[] = ['crash', 'system', 'benign', 'unknown', 'legacy'];

/** The OS call was not available or failed. */
export const EXIT_REASON_UNAVAILABLE = -1;

/** ApplicationExitInfo.REASON_* -> name (android-36.1 sources). */
export const EXIT_REASON_NAMES: Readonly<Record<number, string>> = {
  0: 'UNKNOWN',
  1: 'EXIT_SELF',
  2: 'SIGNALED',
  3: 'LOW_MEMORY',
  4: 'CRASH',
  5: 'CRASH_NATIVE',
  6: 'ANR',
  7: 'INITIALIZATION_FAILURE',
  8: 'PERMISSION_CHANGE',
  9: 'EXCESSIVE_RESOURCE_USAGE',
  10: 'USER_REQUESTED',
  11: 'USER_STOPPED',
  12: 'DEPENDENCY_DIED',
  13: 'OTHER',
  14: 'FREEZER',
  15: 'PACKAGE_STATE_CHANGE',
  16: 'PACKAGE_UPDATED',
};
const CRASH_CODES: readonly number[] = [4, 5, 6, 7];
const SYSTEM_CODES: readonly number[] = [2, 3, 9];
const BENIGN_CODES: readonly number[] = [1, 8, 10, 11, 12, 13, 14, 15, 16];

/** The newest ApplicationExitInfo record, as the native module reports it. */
export type ExitInfo = { reason: number; timestamp: number; status?: number; description?: string };

/** A record may be stamped slightly before the marker's last write by clock rounding. */
export const EXIT_STALE_SLACK_MS = 2_000;

export function exitReasonName(code: number | undefined): string {
  if (code === undefined || code === EXIT_REASON_UNAVAILABLE) return 'unavailable';
  return EXIT_REASON_NAMES[code] ?? `code ${code}`;
}

/**
 * Decide what the previous process's death means. `info` is null when the OS
 * call is unavailable or failed; `platform` is Platform.OS. Pure, never throws.
 */
export function classifyExit(
  info: ExitInfo | null | undefined,
  markerTs: number,
  platform: string,
): { verdict: ExitVerdict; code: number } {
  if (platform === 'ios') return { verdict: 'legacy', code: EXIT_REASON_UNAVAILABLE };
  if (!info || typeof info.reason !== 'number' || !Number.isInteger(info.reason)) {
    return { verdict: 'unknown', code: EXIT_REASON_UNAVAILABLE };
  }
  const code = info.reason;
  // A record older than the marker describes an EARLIER process, not the one
  // that wrote `fg` — say nothing specific about it.
  if (!(typeof info.timestamp === 'number' && Number.isFinite(info.timestamp)) ||
      info.timestamp + EXIT_STALE_SLACK_MS < markerTs) {
    return { verdict: 'unknown', code };
  }
  if (CRASH_CODES.includes(code)) return { verdict: 'crash', code };
  if (SYSTEM_CODES.includes(code)) return { verdict: 'system', code };
  if (BENIGN_CODES.includes(code)) return { verdict: 'benign', code };
  return { verdict: 'unknown', code }; // REASON_UNKNOWN (0) or a future code
}

/** Does this exit entry raise the next-launch banner? System kills are logged quietly. */
export function exitRaisesBanner(e: Pick<CrashEntry, 'kind' | 'exitVerdict'>): boolean {
  if (e.kind !== 'exit') return true;
  return e.exitVerdict !== 'system' && e.exitVerdict !== 'benign';
}

const CRASH_TEXT: Readonly<Record<number, { name: string; says: string; banner: string }>> = {
  4: { name: 'Crash', says: 'an unhandled Java/Kotlin exception', banner: 'Android reports it crashed (unhandled exception).' },
  5: { name: 'Native crash', says: 'a crash in native code', banner: 'Android reports it crashed in native code.' },
  6: { name: 'Not responding', says: 'that it stopped responding (ANR)', banner: 'Android closed it because it stopped responding.' },
  7: { name: 'Failed to start', says: 'a failure while starting', banner: 'Android reports it failed while starting.' },
};
const WHEN = 'The time shown is the last moment it was known to be running on screen.';

/** One line for the App error log card. */
export function exitSummary(e: Pick<CrashEntry, 'exitVerdict' | 'exitCode'>): string {
  const name = exitReasonName(e.exitCode);
  switch (e.exitVerdict) {
    case 'crash':
      return `Android reports: ${CRASH_TEXT[e.exitCode ?? -1]?.name.toLowerCase() ?? 'crash'} (${name}).`;
    case 'system':
      return `Closed by the system (${name}) — not a crash in the app.`;
    case 'unknown':
      return 'No app error captured — may have been a native crash.';
    default:
      return 'No app error captured — likely a native crash.';
  }
}

/** The banner's explanatory sentence for an exit entry. */
export function exitBannerText(e: Pick<CrashEntry, 'exitVerdict' | 'exitCode'>): string {
  const tail = ' Copy what was recorded; Setup › Account › App error log explains how to get the full system crash log.';
  if (e.exitVerdict === 'crash') return (CRASH_TEXT[e.exitCode ?? -1]?.banner ?? 'Android reports it crashed.') + tail;
  if (e.exitVerdict === 'unknown') return 'No app error was captured, so it may have been a native crash.' + tail;
  return 'No app error was captured, so it was likely a native crash.' + tail;
}

function exitName(verdict: ExitVerdict, code: number): string {
  if (verdict === 'crash') return CRASH_TEXT[code]?.name ?? 'Crash';
  if (verdict === 'system') return 'Closed by the system';
  return 'Closed unexpectedly';
}

function exitMessage(verdict: ExitVerdict, code: number, info?: ExitInfo | null): string {
  const name = exitReasonName(code);
  const reasonTag = code === EXIT_REASON_UNAVAILABLE ? '' : ` (Android exit reason ${name}, ${code}${
    name === 'SIGNALED' && typeof info?.status === 'number' ? `, signal ${info.status}` : ''})`;
  switch (verdict) {
    case 'crash':
      return `Android reports ${CRASH_TEXT[code]?.says ?? 'a crash'}${reasonTag}. No JavaScript error was recorded, so there is no stack here; the system crash log has the details. ${WHEN}`;
    case 'system':
      return `Android closed Couchside while it was on screen${reasonTag}. This is not a crash in the app: the phone was short on memory or the system ended the process. ${WHEN}`;
    case 'unknown':
      return `Couchside closed while it was on screen and no JavaScript error was recorded. It may have been a native crash, or the system ended the app. Android gave no usable exit reason${
        code === EXIT_REASON_UNAVAILABLE ? ' (it needs Android 11 or newer)' : reasonTag}. ${WHEN}`;
    default:
      return EXIT_MESSAGE;
  }
}

export const EXIT_MESSAGE =
  'Couchside closed while it was on screen and no JavaScript error was recorded. ' +
  'That usually means a native crash, or the system ended the app (for example, low memory). ' +
  'The time shown is the last moment it was known to be running on screen.';

/**
 * The entry to record for a previous process that died in the foreground, or null.
 *
 * `lastRecorded` is the newest `lastTs` already in the log. Anything newer than
 * the marker was recorded by that same (previous) process — the current one has
 * recorded nothing yet — so it was provably alive then, and the exit is stamped
 * at the later of the two. Without that, an error logged after the last marker
 * write would sort AFTER the exit in a "newest first" report while carrying a
 * later time.
 */
export function exitEntryFromMarker(
  prev: SessionMarker | null,
  id?: string,
  lastRecorded = 0,
  decision?: { verdict: ExitVerdict; code: number },
  info?: ExitInfo | null,
): CrashEntry | null {
  if (!prev || prev.state !== 'fg') return null;
  const d = decision ?? { verdict: 'legacy' as ExitVerdict, code: EXIT_REASON_UNAVAILABLE };
  // An update, a Force stop, a permission change...: the process ended on purpose.
  if (d.verdict === 'benign') return null;
  const ts = Math.max(prev.ts, Number.isFinite(lastRecorded) ? lastRecorded : 0);
  return {
    id: id ?? newId(ts),
    ts,
    lastTs: ts,
    count: 1,
    kind: 'exit',
    name: exitName(d.verdict, d.code),
    message: truncate(exitMessage(d.verdict, d.code, info), MESSAGE_MAX),
    stack: '',
    app: prev.app,
    route: prev.route,
    ...(decision ? { exitVerdict: d.verdict, exitCode: d.code } : {}),
  };
}

// ---------------------------------------------------------------- report text

export type ReportMeta = {
  /** "2.9.61 (vc 109)" */
  app: string;
  /** Android applicationId / iOS bundle id, '' on web. Says store vs direct edition. */
  appId: string;
  /** "android 15 (API 35) · Google Pixel 8" */
  device: string;
  now: number;
};

const KIND_LABEL: Record<CrashKind, string> = {
  fatal: 'FATAL JS ERROR',
  error: 'JS ERROR',
  render: 'SCREEN ERROR',
  exit: 'CLOSED UNEXPECTEDLY',
};

export function kindLabel(k: CrashKind): string {
  return KIND_LABEL[k];
}

function iso(ts: number): string {
  try {
    return new Date(ts).toISOString();
  } catch {
    return String(ts);
  }
}

/** One entry as plain text — what gets pasted into a bug report. */
export function formatEntry(e: CrashEntry): string {
  const bits = [KIND_LABEL[e.kind], iso(e.ts)];
  if (e.count > 1) bits.push(`x${e.count} (last ${iso(e.lastTs)})`);
  if (e.app) bits.push(`app ${e.app}`);
  if (e.route) bits.push(`screen ${e.route}`);
  const lines = [bits.join(' · '), `${e.name}: ${e.message}`];
  if (e.stack) lines.push(e.stack);
  return lines.join('\n');
}

/**
 * The whole log as one readable block, newest first, with the app/device
 * header a bug report needs (version + build decide which source map
 * symbolicates a Hermes `index.android.bundle:1:<offset>` stack).
 */
export function formatReport(entries: readonly CrashEntry[], meta: ReportMeta): string {
  const head = [
    'Couchside error log',
    `App: ${meta.app}${meta.appId ? ` · ${meta.appId}` : ''}`,
    `Device: ${meta.device}`,
    `Copied: ${iso(meta.now)}`,
  ];
  if (entries.length === 0) return [...head, '', 'No errors recorded.'].join('\n');
  head.push(`Entries: ${entries.length} (newest first)`);
  const blocks = [...entries].reverse().map((e, i) => `#${i + 1} ${formatEntry(e)}`);
  return [...head, '', blocks.join('\n\n')].join('\n');
}

// ---------------------------------------------------------------- global handler

export type GlobalErrorHandler = (error: unknown, isFatal?: boolean) => void;
type ErrorUtilsLike = {
  getGlobalHandler: () => GlobalErrorHandler | null | undefined;
  setGlobalHandler: (h: GlobalErrorHandler) => void;
};

const WRAPPED = '__couchsideCrashLog';

/**
 * Wrap React Native's global JS error handler so every error it sees is
 * recorded FIRST, then handed to the handler that was there before — with the
 * exact same arguments.
 *
 * NEVER SWALLOWS. The previous handler is what shows the dev red box and what,
 * in a release build, turns a fatal into a process exit via ExceptionsManager.
 * Recording is wrapped so a failure in it cannot stop that; and if there was no
 * previous handler, a fatal is re-thrown exactly as RN's own default does.
 *
 * `eu` is taken as unknown because nothing guarantees `ErrorUtils` exists (it
 * is RN's error-guard polyfill; this project's web export happens to include
 * it); this returns false and does nothing when it is absent or malformed.
 * Idempotent: a second install on top of our own wrapper is a no-op.
 */
export function chainGlobalHandler(
  eu: unknown,
  record: (error: unknown, isFatal: boolean) => void,
): boolean {
  if (!eu || typeof eu !== 'object') return false;
  const u = eu as Partial<ErrorUtilsLike>;
  if (typeof u.getGlobalHandler !== 'function' || typeof u.setGlobalHandler !== 'function') return false;
  let prev: GlobalErrorHandler | null | undefined;
  try {
    prev = u.getGlobalHandler();
  } catch {
    prev = undefined;
  }
  if (prev && (prev as unknown as Record<string, unknown>)[WRAPPED]) return true;
  const handler: GlobalErrorHandler = (error, isFatal) => {
    try {
      record(error, isFatal === true);
    } catch {
      // Logging must never be the thing that changes how an error is handled.
    }
    if (typeof prev === 'function') {
      prev(error, isFatal);
      return;
    }
    if (isFatal) throw error;
  };
  (handler as unknown as Record<string, unknown>)[WRAPPED] = true;
  u.setGlobalHandler(handler);
  return true;
}
