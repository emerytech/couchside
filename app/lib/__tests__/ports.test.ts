/**
 * Couchside-Ports phone-side logic — lib/ports.ts.
 *
 * Run: from app/, `node --experimental-strip-types --test lib/__tests__/ports.test.ts`
 * Picked up by the CI app-input glob (lib/__tests__/*.test.ts).
 *
 * Controls run both directions (CLAUDE.md §11.3): a running job AND a finished
 * one, an opted-in path AND a needs_optin one, a byo-dump port AND one without.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  PORTS_OPTIN_CMD, portActionError, portButton, portJobActive, anyPortJobActive,
  portJobCopy, portMatchesPlatform, installConfirmCopy, uninstallConfirmCopy,
} from '../ports.ts';
import type { PortInstallJob } from '../api';

const BB = {
  id: 'couchside-bbport',
  name: 'Bloodborne (native port)',
  installed: false,
  requires_user_files: true,
  user_files_prompt: 'Point the launcher at your own Bloodborne folder.',
  platforms: ['steamos', 'bazzite'],
};

function job(over: Partial<PortInstallJob> = {}): PortInstallJob {
  return {
    id: 'couchside-bbport', mode: 'install', running: true, started: 1, finished: null,
    exit_code: null, ok: null, requires_user_files: true,
    user_files_prompt: BB.user_files_prompt, lines: [], ...over,
  };
}

test('platform match: known platform filters, unknown shows', () => {
  assert.equal(portMatchesPlatform(BB, 'steamos'), true);
  assert.equal(portMatchesPlatform(BB, 'windows'), false);   // not in list
  assert.equal(portMatchesPlatform(BB, null), true);         // box did not say -> show
  assert.equal(portMatchesPlatform({ platforms: [] }, 'windows'), true); // catch-all port
});

test('button: install when absent, remove when installed, busy while its job runs', () => {
  assert.deepEqual(portButton(BB, null), { label: 'Install', action: 'install', busy: false });
  assert.deepEqual(portButton({ ...BB, installed: true }, null),
    { label: 'Remove', action: 'uninstall', busy: false });
  // Its own install running -> busy, no action.
  assert.deepEqual(portButton(BB, job({ running: true })),
    { label: 'Installing…', action: null, busy: true });
  assert.deepEqual(portButton({ ...BB, installed: true }, job({ mode: 'uninstall', running: true })),
    { label: 'Removing…', action: null, busy: true });
  // CONTROL: a job for a DIFFERENT port does not make this row busy.
  assert.deepEqual(portButton(BB, job({ id: 'other', running: true })),
    { label: 'Install', action: 'install', busy: false });
});

test('job active helpers key on id + running', () => {
  assert.equal(portJobActive(job({ running: true }), 'couchside-bbport'), true);
  assert.equal(portJobActive(job({ running: false }), 'couchside-bbport'), false);
  assert.equal(portJobActive(job({ id: 'other', running: true }), 'couchside-bbport'), false);
  assert.equal(anyPortJobActive(job({ running: true })), true);
  assert.equal(anyPortJobActive(job({ running: false })), false);
  assert.equal(anyPortJobActive(null), false);
});

test('job copy: running, then installed-with-dump vs installed-plain vs failed', () => {
  assert.equal(portJobCopy(job({ running: true }), BB.name)?.tone, 'action');

  const okDump = portJobCopy(job({ running: false, ok: true, requires_user_files: true }), BB.name);
  assert.equal(okDump?.tone, 'good');
  assert.equal(okDump?.needsDump, true);
  assert.ok(okDump?.line.includes('One more step'));

  // CONTROL: a port that needs no dump does NOT raise the byo step.
  const okPlain = portJobCopy(job({ running: false, ok: true, requires_user_files: false }), BB.name);
  assert.equal(okPlain?.needsDump, false);
  assert.ok(!okPlain?.line.includes('One more step'));

  const removed = portJobCopy(job({ mode: 'uninstall', running: false, ok: true }), BB.name);
  assert.ok(removed?.line.includes('removed'));

  const failed = portJobCopy(job({ running: false, ok: false, exit_code: 1 }), BB.name);
  assert.equal(failed?.tone, 'warn');
  assert.ok(failed?.line.includes('failed'));

  assert.equal(portJobCopy(null), null);
});

test('action error: started -> null, needs_optin names the command, running is friendly', () => {
  assert.equal(portActionError({ started: true, id: 'x' }), null);
  const optin = portActionError({ started: false, needs_optin: true });
  assert.ok(optin && optin.includes(PORTS_OPTIN_CMD));
  assert.ok(portActionError({ started: false, running: true })?.includes('already running'));
  assert.ok(portActionError({ started: false, error: 'boom', exit_code: 2 })?.includes('boom'));
  assert.equal(portActionError({ started: false })?.length! > 0, true);
});

test('confirm copy carries the legal line, and the dump step only when needed', () => {
  const ci = installConfirmCopy(BB);
  assert.equal(ci.okLabel, 'Install');
  assert.ok(ci.message.includes('engine only'));
  assert.ok(ci.message.includes(BB.user_files_prompt));
  // CONTROL: a non-dump port's confirm has no "After it installs" step.
  const plain = installConfirmCopy({ name: 'X', requires_user_files: false, user_files_prompt: null });
  assert.ok(!plain.message.includes('After it installs'));

  const un = uninstallConfirmCopy(BB);
  assert.equal(un.okLabel, 'Remove');
  assert.ok(un.message.includes('left where they are'));
});
