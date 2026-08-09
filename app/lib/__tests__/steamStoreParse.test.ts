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

import {
  parseAppDetails, isInstallableGameType, parseReviewSummary,
} from '../steamStoreParse.ts';

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

test('extracts release year + lowercased genres (real store shape)', () => {
  // Shape verified against store.steampowered.com 2026-08-08 (Portal 2).
  const body = { '620': { success: true, data: {
    type: 'game', name: 'Portal 2',
    release_date: { coming_soon: false, date: 'Apr 18, 2011' },
    genres: [{ id: '1', description: 'Action' }, { id: '25', description: 'Adventure' }],
  } } };
  const d = parseAppDetails(620, body);
  assert.equal(d?.releaseYear, 2011);
  assert.deepEqual(d?.genres, ['action', 'adventure']);
});

test('year is pulled from varied date strings, absent when unparseable', () => {
  const mk = (date: string) => ({ '1': { success: true, data: { type: 'game', name: 'X', release_date: { date } } } });
  assert.equal(parseAppDetails(1, mk('Nov 16, 2004'))?.releaseYear, 2004);
  assert.equal(parseAppDetails(1, mk('2015'))?.releaseYear, 2015);
  assert.equal(parseAppDetails(1, mk('Q3 2024'))?.releaseYear, 2024);
  assert.equal(parseAppDetails(1, mk('Coming soon'))?.releaseYear, undefined);
});

test('missing release/genres is simply absent (never invented)', () => {
  const d = parseAppDetails(1, { '1': { success: true, data: { type: 'game', name: 'X' } } });
  assert.equal(d?.releaseYear, undefined);
  assert.equal(d?.genres, undefined);
});

test('only type "game" is installable', () => {
  assert.equal(isInstallableGameType({ name: 'Portal 2', type: 'game' }), true);
  assert.equal(isInstallableGameType({ name: 'Soundtrack', type: 'dlc' }), false);
  assert.equal(isInstallableGameType({ name: 'Runtime', type: 'tool' }), false);
  assert.equal(isInstallableGameType(null), false);
  assert.equal(isInstallableGameType(undefined), false);
});

test('parses metacritic, recommendations, and controller support (free fields)', () => {
  const body = { '620': { success: true, data: {
    type: 'game', name: 'Portal 2',
    metacritic: { score: 95, url: 'x' },
    recommendations: { total: 388848 },
    controller_support: 'full',
  } } };
  const d = parseAppDetails(620, body);
  assert.equal(d?.metacritic, 95);
  assert.equal(d?.recommendations, 388848);
  assert.equal(d?.controllerSupport, 'full');
});

test('bad rating fields are dropped, not clamped or invented', () => {
  const mk = (data: object) => parseAppDetails(1, { '1': { success: true, data: { type: 'game', name: 'X', ...data } } });
  assert.equal(mk({ metacritic: { score: 150 } })?.metacritic, undefined); // out of range
  assert.equal(mk({ metacritic: { score: 'high' } })?.metacritic, undefined); // wrong type
  assert.equal(mk({ metacritic: {} })?.metacritic, undefined); // no score
  assert.equal(mk({})?.metacritic, undefined); // absent entirely
  assert.equal(mk({ controller_support: 'none' })?.controllerSupport, undefined); // not full/partial
  assert.equal(mk({ recommendations: { total: -5 } })?.recommendations, undefined);
});

test('parseReviewSummary reads the appreviews query_summary', () => {
  const body = { success: 1, query_summary: {
    review_score: 9, review_score_desc: 'Overwhelmingly Positive',
    total_positive: 459021, total_negative: 6028, total_reviews: 465049,
  } };
  assert.deepEqual(parseReviewSummary(body), {
    score: 9, desc: 'Overwhelmingly Positive', total: 465049, positivePct: 99,
  });
});

test('parseReviewSummary is null for no reviews / malformed / failure', () => {
  assert.equal(parseReviewSummary({ success: 1, query_summary: { review_score: 0, review_score_desc: '', total_reviews: 0 } }), null);
  assert.equal(parseReviewSummary({ success: 0 }), null);
  assert.equal(parseReviewSummary({ success: 1 }), null); // no summary
  assert.equal(parseReviewSummary(null), null);
  assert.equal(parseReviewSummary('nope'), null);
});
