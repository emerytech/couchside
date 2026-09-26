/**
 * "Closed unexpectedly" must mean a crash, not an update — lib/crashLogCore.ts
 * classifyExit / exitEntryFromMarker / exitRaisesBanner.
 *
 * Run: from app/, `node --experimental-strip-types --test lib/__tests__/*.test.ts`.
 *
 * FOUND ON A DEVICE (Razr 2023, Android 16, 2026-09-26): the banner said "likely a
 * native crash" after an APK update and after Force stop; `dumpsys activity
 * exit-info` showed PACKAGE_UPDATED (16) and USER_REQUESTED (10). These tests pin
 * every ApplicationExitInfo reason code to a verdict.
 *
 * CONTROLS (CLAUDE.md §11): a real CRASH_NATIVE must still record an entry AND raise
 * the banner — a classifier that returned 'benign' for everything would pass every
 * "no banner" case, and fail here. The stale-record and unavailable cases prove the
 * fallback is the old inference (entry + banner), not silence.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  appendEntry,
  classifyExit,
  emptyLog,
  EXIT_REASON_UNAVAILABLE,
  EXIT_STALE_SLACK_MS,
  exitBannerText,
  exitEntryFromMarker,
  exitRaisesBanner,
  exitSummary,
  formatEntry,
  parseLog,
  serializeLog,
  type SessionMarker,
} from '../crashLogCore.ts';

const T0 = Date.UTC(2026, 8, 26, 22, 0, 0);
const FG: SessionMarker = { state: 'fg', ts: T0, app: '2.9.62 (vc 5)', route: '/setup' };
const after = (reason: number, status?: number) => ({ reason, timestamp: T0 + 30_000, status });

// Verified against android-36.1 ApplicationExitInfo.REASON_*.
const EXPECT: Record<number, 'crash' | 'system' | 'benign' | 'unknown'> = {
  0: 'unknown', // REASON_UNKNOWN
  1: 'benign', // EXIT_SELF
  2: 'system', // SIGNALED (also how a low-memory kill appears without LMK reporting)
  3: 'system', // LOW_MEMORY
  4: 'crash', // CRASH
  5: 'crash', // CRASH_NATIVE
  6: 'crash', // ANR
  7: 'crash', // INITIALIZATION_FAILURE
  8: 'benign', // PERMISSION_CHANGE
  9: 'system', // EXCESSIVE_RESOURCE_USAGE
  10: 'benign', // USER_REQUESTED (Force stop, swipe from Recents; pre-14 updates too)
  11: 'benign', // USER_STOPPED
  12: 'benign', // DEPENDENCY_DIED
  13: 'benign', // OTHER
  14: 'benign', // FREEZER
  15: 'benign', // PACKAGE_STATE_CHANGE
  16: 'benign', // PACKAGE_UPDATED
};

test('every ApplicationExitInfo reason code maps to the documented verdict', () => {
  for (const [code, verdict] of Object.entries(EXPECT)) {
    assert.deepEqual(classifyExit(after(Number(code)), T0, 'android'), { verdict, code: Number(code) }, `code ${code}`);
  }
});

test('the device bug: PACKAGE_UPDATED and Force stop record NOTHING (no entry, no banner)', () => {
  for (const code of [16, 10]) {
    const d = classifyExit(after(code), T0, 'android');
    assert.equal(exitEntryFromMarker(FG, 'x', 0, d, after(code)), null, `code ${code}`);
  }
});

test('CONTROL: a real native crash still records an entry AND raises the banner, with the reason', () => {
  const info = after(5);
  const d = classifyExit(info, T0, 'android');
  const e = exitEntryFromMarker(FG, 'x', 0, d, info)!;
  assert.ok(e, 'CRASH_NATIVE must produce an entry');
  assert.equal(e.kind, 'exit');
  assert.equal(e.name, 'Native crash');
  assert.equal(e.exitVerdict, 'crash');
  assert.equal(e.exitCode, 5);
  assert.equal(exitRaisesBanner(e), true);
  assert.match(e.message, /CRASH_NATIVE, 5/);
  assert.match(formatEntry(e), /CRASH_NATIVE, 5/, 'the reason code reaches the copied log');
  assert.match(exitBannerText(e), /crashed in native code/);
  assert.match(exitSummary(e), /native crash \(CRASH_NATIVE\)/);
});

test('Java crash and ANR are crashes too, each worded for what happened', () => {
  for (const [code, re] of [[4, /unhandled exception/], [6, /stopped responding/], [7, /while starting/]] as const) {
    const e = exitEntryFromMarker(FG, 'x', 0, classifyExit(after(code), T0, 'android'), after(code))!;
    assert.equal(exitRaisesBanner(e), true, `code ${code}`);
    assert.match(exitBannerText(e), re);
  }
});

test('system kills (low memory, SIGNALED, excessive use) are LOGGED but raise no banner', () => {
  for (const code of [3, 2, 9]) {
    const info = after(code, code === 2 ? 9 : undefined);
    const e = exitEntryFromMarker(FG, 'x', 0, classifyExit(info, T0, 'android'), info)!;
    assert.ok(e, `code ${code} must be logged`);
    assert.equal(e.exitVerdict, 'system');
    assert.equal(exitRaisesBanner(e), false, `code ${code} must not raise the banner`);
    assert.match(e.message, /not a crash in the app/);
    if (code === 2) assert.match(e.message, /signal 9/);
  }
});

test('degrade closed: no OS answer keeps the old inference (entry + banner), worded "may have"', () => {
  for (const info of [null, undefined, { reason: 'x' as unknown as number, timestamp: T0 }]) {
    const d = classifyExit(info as never, T0, 'android');
    assert.deepEqual(d, { verdict: 'unknown', code: EXIT_REASON_UNAVAILABLE });
    const e = exitEntryFromMarker(FG, 'x', 0, d, null)!;
    assert.ok(e);
    assert.equal(exitRaisesBanner(e), true);
    assert.match(exitBannerText(e), /may have been a native crash/);
    assert.doesNotMatch(exitBannerText(e), /likely/);
    assert.match(e.message, /Android 11 or newer/);
  }
});

test('REASON_UNKNOWN and a future code this build does not know are "unknown", not benign', () => {
  for (const code of [0, 42]) {
    const e = exitEntryFromMarker(FG, 'x', 0, classifyExit(after(code), T0, 'android'), after(code))!;
    assert.equal(e.exitVerdict, 'unknown');
    assert.equal(exitRaisesBanner(e), true);
    assert.match(e.message, new RegExp(`, ${code}\\)`));
  }
});

test('a record OLDER than the marker describes an earlier process -> unknown (even if it says PACKAGE_UPDATED)', () => {
  const stale = { reason: 16, timestamp: T0 - EXIT_STALE_SLACK_MS - 1 };
  assert.equal(classifyExit(stale, T0, 'android').verdict, 'unknown');
  // within the slack it still counts as this process's record
  assert.equal(classifyExit({ reason: 16, timestamp: T0 - EXIT_STALE_SLACK_MS + 1 }, T0, 'android').verdict, 'benign');
});

test('iOS keeps today\'s behaviour: entry + banner, "likely" wording, no reason fields', () => {
  const d = classifyExit(after(16), T0, 'ios');
  assert.equal(d.verdict, 'legacy');
  const e = exitEntryFromMarker(FG, 'x', 0, d, null)!;
  assert.equal(e.name, 'Closed unexpectedly');
  assert.equal(exitRaisesBanner(e), true);
  assert.match(exitBannerText(e), /likely a native crash/);
});

test('entries recorded before this change (no exit fields) still read as before', () => {
  const old = exitEntryFromMarker(FG, 'x')!;
  assert.equal(old.exitVerdict, undefined);
  assert.equal(exitRaisesBanner(old), true);
  assert.match(exitSummary(old), /likely a native crash/);
});

test('storage round trip keeps exitVerdict/exitCode; hostile values are dropped, never trusted', () => {
  const e = exitEntryFromMarker(FG, 'x', 0, classifyExit(after(5), T0, 'android'), after(5))!;
  const back = parseLog(serializeLog(appendEntry(emptyLog(), e).log)).entries[0];
  assert.equal(back.exitVerdict, 'crash');
  assert.equal(back.exitCode, 5);
  const hostile = JSON.stringify({
    v: 1,
    pending: null,
    entries: [
      { ...e, id: 'h1', exitVerdict: 'pwned', exitCode: 5 },
      { ...e, id: 'h2', exitVerdict: 'crash', exitCode: 1e9 },
      { ...e, id: 'h3', kind: 'fatal', exitVerdict: 'crash', exitCode: 5 }, // only exit entries carry them
    ],
  });
  const [h1, h2, h3] = parseLog(hostile).entries;
  assert.equal(h1.exitVerdict, undefined);
  assert.equal(h1.exitCode, 5);
  assert.equal(h2.exitVerdict, 'crash');
  assert.equal(h2.exitCode, undefined);
  assert.equal(h3.exitVerdict, undefined);
  assert.equal(h3.exitCode, undefined);
});
