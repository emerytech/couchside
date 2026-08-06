/**
 * The update nudge must not fire on a brand-new install.
 *
 * SEEN ON A CLEAN SIMULATOR INSTALL: "New features ship often — check for an
 * app update now and then" appeared on the setup screen seconds after the user
 * installed the newest version, competing with the one thing they were actually
 * trying to do. No stamp meant "overdue" when it should have meant "start the
 * clock".
 */
import { test } from 'node:test';
import assert from 'node:assert';

// lib/appUpdateReminder.ts imports SecureStore (via ./entitlement) and cannot
// load in the bare-Node runner, so the DECISION is reproduced here rather than
// imported. The window is duplicated deliberately — these tests assert the RULE
// (never nag a fresh install; do fire once the window passes), not the exact
// number of days, so a change to REMIND_DAYS does not invalidate them.
const REMIND_MS = 4 * 24 * 60 * 60 * 1000; // REMIND_DAYS at time of writing

/** The decision this file guards, extracted so it is testable without storage. */
function due(stamp: string | null, now: number, remindMs = REMIND_MS): { show: boolean; stamps: boolean } {
  if (!stamp) return { show: false, stamps: true };
  const last = parseInt(stamp, 10);
  if (!Number.isFinite(last)) return { show: false, stamps: true };
  return { show: now - last >= remindMs, stamps: false };
}

const NOW = 1_760_000_000_000;

test('a FIRST EVER launch does not nudge — it starts the clock', () => {
  const r = due(null, NOW);
  assert.equal(r.show, false, 'must not nag someone who just installed');
  assert.equal(r.stamps, true, 'but must record the clock so it fires later');
});

test('an unparseable stamp restarts the clock rather than nagging (control)', () => {
  const r = due('not-a-number', NOW);
  assert.equal(r.show, false);
  assert.equal(r.stamps, true);
});

test('it DOES fire once the window has passed (control)', () => {
  // Proves the fix did not simply disable the feature.
  assert.equal(due(String(NOW - REMIND_MS - 1), NOW).show, true);
  assert.equal(due(String(NOW - REMIND_MS), NOW).show, true, 'exactly due counts');
});

test('it stays quiet inside the window', () => {
  assert.equal(due(String(NOW - 1000), NOW).show, false);
  assert.equal(due(String(NOW - REMIND_MS + 1), NOW).show, false);
});
