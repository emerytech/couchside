/**
 * Flatpak-update completion — lib/flatpakUpdate.ts.
 *
 * Run: from app/, `node --experimental-strip-types --test lib/__tests__/*.test.ts`
 * Picked up by the CI app-input glob.
 *
 * THE BUG (KI-036, device-confirmed 2026-07-27): "done" was `count === 0`, but
 * an end-of-life runtime `flatpak update` can't apply pins the count above zero,
 * so done was unreachable — the card spun ten minutes and blocked the OS update
 * behind it. The first test is that exact scenario: a NEW agent reports the
 * process finished (running=false) while the count is still nonzero, and that
 * MUST read as complete.
 *
 * Controls run both directions (CLAUDE.md §11.3): every "complete" case is
 * paired with a "not complete" one, so a function that always returned true
 * would fail.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { flatpakStartMessage, isFlatpakUpdateComplete } from '../flatpakUpdate.ts';

test('THE BUG: a finished update with an un-updatable app left over is COMPLETE', () => {
  // New agent: process done, but the EOL runtime keeps count at 1.
  assert.equal(isFlatpakUpdateComplete({ running: false, count: 1 }), true);
  // ...even with several stuck EOL apps.
  assert.equal(isFlatpakUpdateComplete({ running: false, count: 5 }), true);
  // CONTROL, opposite direction: while the process is still running it is NOT
  // complete, whatever the count — so this cannot pass by always returning true.
  assert.equal(isFlatpakUpdateComplete({ running: true, count: 0 }), false);
  assert.equal(isFlatpakUpdateComplete({ running: true, count: 5 }), false);
});

test('new agent: running is the sole signal, count is ignored', () => {
  assert.equal(isFlatpakUpdateComplete({ running: false, count: 0 }), true);
  assert.equal(isFlatpakUpdateComplete({ running: true, count: 0 }), false);
});

test('old agent (no running field) falls back to count === 0, unchanged', () => {
  assert.equal(isFlatpakUpdateComplete({ count: 0 }), true);
  assert.equal(isFlatpakUpdateComplete({ count: 1 }), false);
  // The EOL runtime is exactly why the old path hangs — documented, not fixed
  // for old agents (they never send `running`). This asserts the pre-fix
  // behaviour is preserved so upgrading the app alone changes nothing there.
  assert.equal(isFlatpakUpdateComplete({ count: 3 }), false);
});

test('a not-yet-readable status keeps the poller waiting', () => {
  assert.equal(isFlatpakUpdateComplete(null), false);
  assert.equal(isFlatpakUpdateComplete(undefined), false);
});

test('running takes precedence even when count would say otherwise', () => {
  // Both fields present and disagreeing: the process signal wins in both
  // directions — done-with-leftovers is done; still-running-at-zero is not.
  assert.equal(isFlatpakUpdateComplete({ running: false, count: 9 }), true);
  assert.equal(isFlatpakUpdateComplete({ running: true, count: 0 }), false);
});

// ---- flatpakStartMessage: a failed press must SAY something -----------------
//
// THE BUG: the card set 'skipped' with no message on every started:false and on
// every throw, and 'skipped' draws no icon — so a sudo denial, a missing
// wrapper, or a 400ms death all looked like "I press update and nothing
// happens" (a user's exact words). The agent returned the reason every time.

test('THE BUG: a failed start is never silent — the agent reason is surfaced', () => {
  // Could not even spawn (missing wrapper, EACCES): the agent's `error` wins.
  assert.equal(
    flatpakStartMessage({ started: false, error: 'No such file: couchside-flatpak-update' }, 3),
    'Update did not start: No such file: couchside-flatpak-update',
  );
  // Died within 400ms: the LAST non-blank transcript line is what flatpak said.
  assert.equal(
    flatpakStartMessage(
      { started: false, exit_code: 1, lines: ['Looking for updates…', '', 'error: sudo: a password is required', '  '] },
      3,
    ),
    'Update did not start: error: sudo: a password is required',
  );
  // No transcript at all: fall back to the exit code, still never silent.
  assert.equal(flatpakStartMessage({ started: false, exit_code: 127 }, 3), 'Update did not start (exit 127).');
  assert.equal(flatpakStartMessage({ started: false }, 3), 'Update did not start.');
  // CONTROL, opposite direction: a clean elevated start says NOTHING (no nag).
  assert.equal(flatpakStartMessage({ started: true, elevated: true }, 3), null);
  assert.equal(flatpakStartMessage({ started: true, elevated: true }, 0), null);
});

test('an un-elevated run with system updates pending says why the count did not move', () => {
  // `flatpak update --user` on a system-installed box: finishes at once having
  // done nothing; the checkmark would lie without this.
  assert.equal(
    flatpakStartMessage({ started: true, elevated: false }, 39),
    'Only your user-installed apps were updated. Enable system updates on the box to update the rest.',
  );
  // CONTROLS: nothing pending -> nothing to explain; elevated -> nothing to explain;
  // an agent too old to report `elevated` -> don't invent a complaint.
  assert.equal(flatpakStartMessage({ started: true, elevated: false }, 0), null);
  assert.equal(flatpakStartMessage({ started: true, elevated: true }, 39), null);
  assert.equal(flatpakStartMessage({ started: true }, 39), null);
});

test('terminal escapes in the transcript never reach the user (measured on a Bazzite box)', () => {
  // A real log tail ends in a bare cursor-show sequence; earlier lines carry
  // line-clear + colour codes. The message must be the last REAL line, clean.
  const lines = ['\x1b[2K\x1b[31merror: sudo: a password is required\x1b[0m', '\x1b[?25h'];
  assert.equal(
    flatpakStartMessage({ started: false, exit_code: 1, lines }, 2),
    'Update did not start: error: sudo: a password is required',
  );
  // A transcript that is ONLY escapes yields nothing usable -> fall through to
  // the exit code rather than printing an empty "did not start: ".
  assert.equal(flatpakStartMessage({ started: false, exit_code: 1, lines: ['\x1b[?25h', '\x1b[2K'] }, 2),
    'Update did not start (exit 1).');
});

test('the OS row reuses the same failed-start messaging (same silent-failure class)', () => {
  // POST /api/update/os returns the same launch contract; the card passes its
  // result straight in with pendingCount 0 (no un-elevated note applies).
  assert.equal(
    flatpakStartMessage({ started: false, exit_code: 1, lines: ['error: no atomic OS updater found'] }, 0),
    'Update did not start: error: no atomic OS updater found',
  );
  // A clean OS start says nothing, and the un-elevated note can never fire at 0.
  assert.equal(flatpakStartMessage({ started: true }, 0), null);
  assert.equal(flatpakStartMessage({ started: true, elevated: false }, 0), null);
});

test('error beats transcript beats exit code (precedence is deterministic)', () => {
  const both = { started: false, error: 'spawn failed', exit_code: 2, lines: ['flatpak: nope'] };
  assert.equal(flatpakStartMessage(both, 1), 'Update did not start: spawn failed');
  const noErr = { started: false, exit_code: 2, lines: ['flatpak: nope'] };
  assert.equal(flatpakStartMessage(noErr, 1), 'Update did not start: flatpak: nope');
});
