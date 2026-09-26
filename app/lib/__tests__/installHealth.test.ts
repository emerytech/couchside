/**
 * "Box installation is damaged" banner decisions — lib/installHealth.ts.
 *
 * Run: from app/, `node --experimental-strip-types --test lib/__tests__/*.test.ts`
 * (CI runs exactly that glob, so this file is picked up with no workflow edit).
 *
 * Both directions, with controls (CLAUDE.md §11): the Deck's real shape SHOWS the
 * banner; an older agent (field absent), a healthy box, and a box whose only
 * problem is a piece the agent could not check do NOT. A function that always
 * returned null would pass every "hide" case — the "show" cases are the control.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  damagedHeadline,
  damagedPieces,
  pieceLabel,
  PIECE_LABELS,
  REPAIR_COMMAND,
  repairCommand,
  REPAIR_HINT,
  uncheckedPieces,
} from '../installHealth.ts';

// What the agent returned when run read-only ON the Steam Deck OLED (SteamOS
// 3.9.2, 2026-09-26) — and what `--mock-install-health damaged` now sends.
const DECK = {
  ok: false,
  missing: ['token_canonical', 'sudoers_grant', 'journal_wrapper', 'udev_uinput', 'modules_uinput', 'udev_rtc'],
  unknown: [] as string[],
};
// A box whose sudo will not list rules without a password: the grant is unknown.
const UNLISTABLE = { ok: false, missing: ['udev_uinput'], unknown: ['sudoers_grant'] };

test('the Deck case shows the banner with every missing piece', () => {
  assert.deepEqual(damagedPieces(DECK), DECK.missing);
  const h = damagedHeadline(DECK.missing);
  assert.ok(h.startsWith('Box installation is damaged (missing: '), h);
  assert.ok(h.endsWith(') — re-run the installer on the box'), h);
  for (const id of DECK.missing) assert.ok(h.includes(pieceLabel(id)), `${id} named in ${h}`);
});

test('nothing to say: older agent, healthy box, malformed field', () => {
  assert.equal(damagedPieces(undefined), null, 'older agent omits the field');
  assert.equal(damagedPieces(null), null);
  assert.equal(damagedPieces({ ok: true, missing: [], unknown: [] }), null, 'healthy');
  assert.equal(damagedPieces('damaged'), null, 'not an object');
  assert.equal(damagedPieces({ missing: ['udev_uinput'] }), null, 'no ok:false -> not a verdict');
  assert.equal(damagedPieces({ ok: 'false', missing: ['udev_uinput'] }), null, 'ok must be boolean false');
  assert.equal(damagedPieces({ ok: false, missing: 'udev_uinput' }), null, 'missing must be a list');
});

test('ok:false with only UNKNOWN pieces is not damage (agent degrading closed)', () => {
  const onlyUnknown = { ok: false, missing: [], unknown: ['sudoers_grant'] };
  assert.equal(damagedPieces(onlyUnknown), null);
  // Control: the same block with one real loss DOES show.
  assert.deepEqual(damagedPieces({ ...onlyUnknown, missing: ['udev_rtc'] }), ['udev_rtc']);
});

test('non-string / empty ids are dropped; if nothing valid is left, no banner', () => {
  assert.equal(damagedPieces({ ok: false, missing: [1, '', null] }), null);
  assert.deepEqual(damagedPieces({ ok: false, missing: [1, 'udev_cec'] }), ['udev_cec']);
});

test('an id from a NEWER agent still counts and renders raw', () => {
  assert.deepEqual(damagedPieces({ ok: false, missing: ['some_future_piece'] }), ['some_future_piece']);
  assert.equal(pieceLabel('some_future_piece'), 'some_future_piece');
  assert.equal(pieceLabel('toString'), 'toString', 'no prototype leakage into labels');
});

test('every agent id has a human label (read from the agent source, not a copy)', () => {
  // The frozen table in agent/couchsided.py. Parsed from the real file so a new
  // agent id without a label here fails this test instead of shipping as a raw
  // snake_case id in the banner.
  const src = readFileSync(
    fileURLToPath(new URL('../../../agent/couchsided.py', import.meta.url)), 'utf8');
  const m = src.match(/^_INSTALL_PIECE_IDS = \(([\s\S]*?)^\)/m);
  assert.ok(m, '_INSTALL_PIECE_IDS found in the agent');
  const agentIds = [...m[1].matchAll(/^\s*"([a-z_]+)",/gm)].map((x) => x[1]);
  assert.equal(agentIds.length, 9, `parsed ${agentIds.join(',')}`);
  assert.deepEqual(Object.keys(PIECE_LABELS).sort(), [...agentIds].sort());
  for (const id of agentIds) assert.notEqual(pieceLabel(id), id, `${id} has a label`);
});

test('the repair is the terminal one-liner, and the hint says why the phone cannot do it', () => {
  assert.equal(REPAIR_COMMAND, 'curl -fsSL https://couchside.tv/install.sh | bash');
  assert.match(REPAIR_HINT, /terminal on the box/);
  assert.match(REPAIR_HINT, /cannot restore/);
});

test('unchecked pieces are listed separately and never throw', () => {
  assert.deepEqual(uncheckedPieces(UNLISTABLE), ['sudoers_grant']);
  assert.deepEqual(damagedPieces(UNLISTABLE), ['udev_uinput'], 'unknowns do not hide a real loss');
  assert.deepEqual(uncheckedPieces(DECK), []);
  assert.deepEqual(uncheckedPieces(undefined), []);
  assert.deepEqual(uncheckedPieces({ ok: false }), []);
});

test('a --no-sudoers box gets a repair command that keeps the opt-out', () => {
  assert.equal(
    repairCommand({ ok: false, missing: ['token_canonical'], no_sudoers: true }),
    'curl -fsSL https://couchside.tv/install.sh | bash -s -- --no-sudoers',
  );
  // Only a literal true opts out: absent, older agent, or a malformed value = plain command.
  assert.equal(repairCommand({ ok: false, missing: ['token_canonical'] }), REPAIR_COMMAND);
  assert.equal(repairCommand({ ok: false, missing: ['token_canonical'], no_sudoers: 'yes' }), REPAIR_COMMAND);
  assert.equal(repairCommand({ ok: false, missing: ['token_canonical'], no_sudoers: 1 }), REPAIR_COMMAND);
  assert.equal(repairCommand(undefined), REPAIR_COMMAND);
  assert.equal(repairCommand(null), REPAIR_COMMAND);
});
