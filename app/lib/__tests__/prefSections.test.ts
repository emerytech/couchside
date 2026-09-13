/**
 * Preferences fold state — lib/prefSections.ts.
 *
 * Run: from app/, `node --experimental-strip-types --test lib/__tests__/*.test.ts`
 * Picked up by the CI app-input glob.
 *
 * Both directions on every rule (CLAUDE.md §11.3): each "folded" assertion is
 * paired with an "open" one, so a function that always returned one answer
 * would fail.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  PREF_SECTIONS,
  isPrefSectionId,
  normalizeCollapsed,
  sectionOpen,
  toggleCollapsed,
} from '../prefSections.ts';

test('the id list is frozen and includes the PAD LAYOUT split', () => {
  assert.ok(PREF_SECTIONS.includes('padLayout'));
  assert.ok(PREF_SECTIONS.includes('padBehavior'));
  assert.equal(new Set(PREF_SECTIONS).size, PREF_SECTIONS.length, 'no duplicate ids');
  assert.equal(isPrefSectionId('padBehavior'), true);
  assert.equal(isPrefSectionId('PAD LAYOUT'), false); // labels are not ids
  assert.equal(isPrefSectionId(42), false);
});

test('normalizeCollapsed keeps only known ids, once each, in order — junk never rides along', () => {
  assert.deepEqual(
    normalizeCollapsed(['padLayout', 'nope', 'general', 'padLayout', 7, null]),
    ['padLayout', 'general'],
  );
  // Not an array (older blob, hand-edited storage) -> nothing folded, the default.
  assert.deepEqual(normalizeCollapsed(undefined), []);
  assert.deepEqual(normalizeCollapsed('general'), []);
  assert.deepEqual(normalizeCollapsed({ general: true }), []);
  // CONTROL: a clean list survives untouched.
  assert.deepEqual(normalizeCollapsed(['media', 'touch']), ['media', 'touch']);
});

test('toggleCollapsed folds an open section and opens a folded one, never duplicating', () => {
  assert.deepEqual(toggleCollapsed([], 'media'), ['media']);
  assert.deepEqual(toggleCollapsed(['media'], 'media'), []);
  assert.deepEqual(toggleCollapsed(['media'], 'touch'), ['media', 'touch']);
  assert.deepEqual(toggleCollapsed(['media', 'touch'], 'media'), ['touch']);
  // Pure: the input is not mutated.
  const before: readonly ('media' | 'touch')[] = ['media'];
  toggleCollapsed(before, 'touch');
  assert.deepEqual(before, ['media']);
});

test('sectionOpen: folded hides rows, open shows them', () => {
  assert.equal(sectionOpen(['media'], 'media', ''), false);
  assert.equal(sectionOpen(['media'], 'touch', ''), true);
  assert.equal(sectionOpen([], 'media', ''), true);
});

test('THE RULE: a live search query overrides every fold — a match can never hide', () => {
  assert.equal(sectionOpen(['media'], 'media', 'volume'), true);
  assert.equal(sectionOpen(['media', 'padLayout', 'general'], 'padLayout', 'k'), true);
  // Whitespace-only is not a query; the fold still applies.
  assert.equal(sectionOpen(['media'], 'media', '   '), false);
  // CONTROL: clearing the query restores the fold.
  assert.equal(sectionOpen(['media'], 'media', ''), false);
});
