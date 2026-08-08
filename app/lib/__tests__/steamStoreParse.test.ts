/**
 * Steam store metadata parsing — lib/steamStoreParse.ts.
 *
 * Run: from app/, `node --experimental-strip-types --test lib/__tests__/*.test.ts`
 *
 * The name + type of an owned-but-uninstalled game come from Valve's keyless
 * appdetails endpoint. A wrong parse would either mislabel a game or, worse, let a
 * Steam tool/DLC through the type=game filter and offer it as something to install.
 * These assert the response shape (keyed by appid string, wrapped in success/data),
 * that a failed lookup is `null` not a guess, and that only type "game" installs.
 *
 * Payload shapes are the real ones from store.steampowered.com/api/appdetails
 * ?appids=<id>&filters=basic (trimmed to the fields parsed).
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { parseAppDetails, isInstallableGameType } from '../steamStoreParse.ts';

test('parses a real game entry', () => {
  const body = { '620': { success: true, data: { type: 'game', name: 'Portal 2', steam_appid: 620 } } };
  assert.deepEqual(parseAppDetails(620, body), { name: 'Portal 2', type: 'game' });
});

test('keys strictly by the requested appid string', () => {
  const body = { '620': { success: true, data: { type: 'game', name: 'Portal 2' } } };
  // Asking for a different appid than the one present must not borrow its data.
  assert.equal(parseAppDetails(400, body), null);
});

test('success:false (delisted / region-locked) is null, not an error', () => {
  assert.equal(parseAppDetails(999999, { '999999': { success: false } }), null);
});

test('a tool/DLC keeps its real type so the filter can drop it', () => {
  const dlc = { '323180': { success: true, data: { type: 'dlc', name: "A Game's Soundtrack" } } };
  const tool = { '228980': { success: true, data: { type: 'tool', name: 'Steamworks Common Redistributables' } } };
  assert.equal(parseAppDetails(323180, dlc)?.type, 'dlc');
  assert.equal(parseAppDetails(228980, tool)?.type, 'tool');
});

test('missing name or type is null (never a guessed value)', () => {
  assert.equal(parseAppDetails(1, { '1': { success: true, data: { type: 'game' } } }), null);
  assert.equal(parseAppDetails(1, { '1': { success: true, data: { name: 'X' } } }), null);
});

test('garbage bodies degrade to null, never throw', () => {
  for (const bad of [null, undefined, 42, 'nope', {}, { '620': null }, { '620': { success: true } }]) {
    assert.equal(parseAppDetails(620, bad), null);
  }
});

test('only type "game" is installable', () => {
  assert.equal(isInstallableGameType({ name: 'Portal 2', type: 'game' }), true);
  assert.equal(isInstallableGameType({ name: 'Soundtrack', type: 'dlc' }), false);
  assert.equal(isInstallableGameType({ name: 'Runtime', type: 'tool' }), false);
  assert.equal(isInstallableGameType(null), false);
  assert.equal(isInstallableGameType(undefined), false);
});
