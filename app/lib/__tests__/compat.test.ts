/**
 * Compatibility parsing, against payloads CAPTURED FROM THE REAL SERVICES
 * (2026-08-06). Invented shapes would have missed both traps below.
 *
 * What these protect: telling someone a game they own runs well when it does
 * not, or hiding a game because a third party has no data on it.
 */
import { test } from 'node:test';
import assert from 'node:assert';

import {
  deckRank,
  matchesCompat,
  parseDeckStatus,
  parseProton,
  protonRank,
  UNKNOWN_COMPAT,
  type Compat,
} from '../compat.ts';

// --- real payloads, verbatim -------------------------------------------------

// Baldur's Gate 3 (1086940) — Steam lists it Verified.
const BG3_DECK = { success: 1, results: { appid: 1086940, resolved_category: 3 } };
// Rainbow Six Siege (359550) — Steam lists it Unsupported.
const R6_DECK = { success: 1, results: { appid: 359550, resolved_category: 1 } };
// Red Dead Redemption 2 (1174180) — Playable.
const RDR2_DECK = { success: 1, results: { appid: 1174180, resolved_category: 2 } };
// An appid Valve has never rated. NOTE `results` is an ARRAY here, not an
// object — the shape changes, which is exactly the kind of thing a hand-written
// fixture would have got wrong.
const UNRATED_DECK = { success: 1, results: [] };

// Baldur's Gate 3 on ProtonDB.
const BG3_PROTON = {
  bestReportedTier: 'platinum', confidence: 'strong',
  score: 0.84, tier: 'gold', total: 1511, trendingTier: 'platinum',
};
// Rainbow Six Siege on ProtonDB. THE TRAP: bestReportedTier says "platinum"
// while the actual consensus tier is "borked".
const R6_PROTON = {
  bestReportedTier: 'platinum', confidence: 'strong',
  score: 0.08, tier: 'borked', total: 309, trendingTier: 'bronze',
};

test('Deck status parses the real payloads', () => {
  assert.equal(parseDeckStatus(BG3_DECK), 'verified');
  assert.equal(parseDeckStatus(R6_DECK), 'unsupported');
  assert.equal(parseDeckStatus(RDR2_DECK), 'playable');
});

test('an UNRATED game is unknown, not unsupported (results is an array)', () => {
  // Getting this wrong would tell a user a game they own will not run, when
  // Valve has simply never looked at it.
  assert.equal(parseDeckStatus(UNRATED_DECK), 'unknown');
});

test('garbage in never becomes a verdict (control)', () => {
  for (const junk of [null, undefined, {}, { success: 0 }, { success: 1 }, 'nope', 42]) {
    assert.equal(parseDeckStatus(junk), 'unknown', JSON.stringify(junk));
  }
});

test('ProtonDB uses the CONSENSUS tier, never bestReportedTier', () => {
  // The whole point. R6 Siege's best-ever report is platinum; the consensus is
  // borked. Quoting the flattering number would recommend a broken game.
  const r6 = parseProton(R6_PROTON);
  assert.equal(r6.tier, 'borked');
  assert.equal(r6.reports, 309);

  const bg3 = parseProton(BG3_PROTON);
  assert.equal(bg3.tier, 'gold', 'consensus gold, not the platinum best-report');
  assert.equal(bg3.reports, 1511);
});

test('a game with no ProtonDB entry is unknown (404 -> no body)', () => {
  assert.deepEqual(parseProton(null), { tier: 'unknown', reports: 0 });
  assert.deepEqual(parseProton({}), { tier: 'unknown', reports: 0 });
  assert.deepEqual(parseProton({ tier: 'gibberish' }), { tier: 'unknown', reports: 0 });
});

test('unknown ranks above borked, below every real rating', () => {
  // "Nobody has tested it" is not worse than "known to be broken".
  assert.ok(protonRank('unknown') > protonRank('borked'));
  assert.ok(protonRank('bronze') > protonRank('unknown'));
  assert.ok(protonRank('platinum') > protonRank('gold'));
  assert.ok(deckRank('unknown') > deckRank('unsupported'));
  assert.ok(deckRank('playable') > deckRank('unknown'));
});

test('UNKNOWN ALWAYS PASSES a filter (the load-bearing rule)', () => {
  // A third party having no data must never hide a game the user owns.
  const c: Compat = { deck: 'unknown', proton: 'unknown', protonReports: 0 };
  assert.equal(matchesCompat(c, ['verified'], ['platinum']), true);
  assert.equal(matchesCompat(undefined, ['verified'], ['platinum']), true, 'not fetched yet');
  assert.equal(matchesCompat(UNKNOWN_COMPAT, ['verified'], []), true);
});

test('a known rating IS filtered out when it does not match (control)', () => {
  // Proves the test above is not just "everything passes".
  const r6: Compat = { deck: 'unsupported', proton: 'borked', protonReports: 309 };
  assert.equal(matchesCompat(r6, ['verified'], []), false);
  assert.equal(matchesCompat(r6, [], ['platinum', 'gold']), false);
  const bg3: Compat = { deck: 'verified', proton: 'gold', protonReports: 1511 };
  assert.equal(matchesCompat(bg3, ['verified'], ['gold']), true);
});

test('an empty filter selects everything', () => {
  const r6: Compat = { deck: 'unsupported', proton: 'borked', protonReports: 309 };
  assert.equal(matchesCompat(r6, [], []), true);
});
