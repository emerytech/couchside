/**
 * Library triage predicates.
 *
 * THE FAILURE THESE GUARD AGAINST: a filter that silently hides a game the user
 * owns. They go looking for it, do not find it, and conclude the app lost their
 * library. So anything UNKNOWN is included, never excluded — and the tests below
 * spend most of their effort on the unknown/edge cases rather than the happy path.
 */
import { test } from 'node:test';
import assert from 'node:assert';

import {
  bookmarkKey,
  toggleBookmark,
  presetName,
  upsertPreset,
  normalizePresets,
  MAX_PRESETS,
  type FilterPreset,
  applyFilter,
  countLabel,
  countMatching,
  EMPTY_FILTER,
  hasPlaytimeData,
  isFiltering,
  matches,
  playtimeLabel,
  type FilterableGame,
  type FilterState,
} from '../libraryFilter.ts';

const NOW = 1_760_000_000; // fixed clock; these must not depend on the real date
const day = (n: number) => n * 86400;

const g = (over: Partial<FilterableGame> & { label: string }): FilterableGame => ({
  kind: 'steam',
  ...over,
});

const LIB: FilterableGame[] = [
  g({ label: 'Baldur’s Gate 3', playtime_min: 6000, last_played: NOW - day(2) }),
  g({ label: 'Dave the Diver', playtime_min: 45, last_played: NOW - day(400) }),
  g({ label: 'Crimson Desert' }), // never launched: no record at all
  g({ label: 'Hollow Knight', playtime_min: 0, last_played: NOW - day(10) }), // launched, played nothing
  g({ label: 'Netflix', kind: 'shortcut' }),
  g({ label: 'Restart Kodi', kind: 'custom' }),
];

test('no filter shows the whole library', () => {
  assert.equal(countMatching(LIB, EMPTY_FILTER, NOW), LIB.length);
  assert.equal(isFiltering(EMPTY_FILTER), false);
});

test('search is case-insensitive and matches inside the title', () => {
  const f: FilterState = { ...EMPTY_FILTER, search: 'DIVER' };
  assert.deepEqual(applyFilter(LIB, f, NOW).map((x) => x.label), ['Dave the Diver']);
});

test('"never played" catches BOTH no-record and an explicit zero', () => {
  // Two different states that mean the same thing to a person: bought and never
  // opened, versus opened once and immediately quit.
  const f: FilterState = { ...EMPTY_FILTER, played: 'never' };
  assert.deepEqual(
    applyFilter(LIB, f, NOW).map((x) => x.label).sort(),
    ['Crimson Desert', 'Hollow Knight', 'Netflix', 'Restart Kodi'].sort(),
  );
});

test('an UNKNOWN playtime is never hidden by a "played" bucket (the load-bearing rule)', () => {
  // Crimson Desert has no playtime record. Asking for "under 2 hours" must not
  // make it vanish — the user owns it and would go looking for it.
  const under: FilterState = { ...EMPTY_FILTER, played: 'under2h' };
  assert.ok(
    applyFilter(LIB, under, NOW).some((x) => x.label === 'Crimson Desert'),
    'unknown playtime must stay visible',
  );
  const over: FilterState = { ...EMPTY_FILTER, played: 'over2h' };
  assert.ok(applyFilter(LIB, over, NOW).some((x) => x.label === 'Crimson Desert'));
});

test('"under 2 hours" excludes zero — that is "never", not "barely"', () => {
  const f: FilterState = { ...EMPTY_FILTER, played: 'under2h' };
  const out = applyFilter(LIB, f, NOW).map((x) => x.label);
  assert.ok(out.includes('Dave the Diver'), '45m is under two hours');
  assert.ok(!out.includes('Hollow Knight'), '0 minutes is not "played a little"');
});

test('the 2-hour boundary is exact on both sides (control)', () => {
  const at = [g({ label: '119', playtime_min: 119 }), g({ label: '120', playtime_min: 120 })];
  assert.deepEqual(
    applyFilter(at, { ...EMPTY_FILTER, played: 'under2h' }, NOW).map((x) => x.label), ['119']);
  assert.deepEqual(
    applyFilter(at, { ...EMPTY_FILTER, played: 'over2h' }, NOW).map((x) => x.label), ['120']);
});

test('kind filter narrows to launcher types, empty means all', () => {
  assert.deepEqual(
    applyFilter(LIB, { ...EMPTY_FILTER, kinds: ['shortcut'] }, NOW).map((x) => x.label),
    ['Netflix'],
  );
  assert.equal(countMatching(LIB, { ...EMPTY_FILTER, kinds: [] }, NOW), LIB.length);
});

test('"not played in N days" counts never-launched as stale', () => {
  const f: FilterState = { ...EMPTY_FILTER, staleDays: 365 };
  const out = applyFilter(LIB, f, NOW).map((x) => x.label);
  assert.ok(out.includes('Dave the Diver'), 'last played 400 days ago');
  assert.ok(out.includes('Crimson Desert'), 'never launched has been unplayed the whole time');
  assert.ok(!out.includes('Baldur’s Gate 3'), 'played 2 days ago is not stale');
});

test('filters combine (search AND played AND kind)', () => {
  // 'des' hits Crimson Desert only; steam-kind only; never-played only. All
  // three must apply together, not any-of.
  const f: FilterState = { ...EMPTY_FILTER, search: 'des', kinds: ['steam'], played: 'never' };
  assert.deepEqual(applyFilter(LIB, f, NOW).map((x) => x.label), ['Crimson Desert']);
});

test('combining is AND, not OR (control)', () => {
  // 'des' matches Crimson Desert, which IS never-played; pairing it with the
  // OPPOSITE playtime bucket must yield nothing. Under OR it would still match.
  const f: FilterState = { ...EMPTY_FILTER, search: 'des', kinds: ['shortcut'] };
  assert.deepEqual(applyFilter(LIB, f, NOW), [], 'a steam game must not survive a shortcut-only filter');
});

test('the count matches what the list actually returns (control)', () => {
  // A count that disagrees with the list is the worst outcome: the button
  // promises N and the screen shows something else.
  const states: FilterState[] = [
    EMPTY_FILTER,
    { ...EMPTY_FILTER, played: 'never' },
    { ...EMPTY_FILTER, search: 'e' },
    { ...EMPTY_FILTER, kinds: ['steam'], played: 'over2h' },
    { ...EMPTY_FILTER, staleDays: 30 },
  ];
  for (const f of states) {
    assert.equal(countMatching(LIB, f, NOW), applyFilter(LIB, f, NOW).length, JSON.stringify(f));
  }
});

test('the button label is honest at 0 and singular at 1', () => {
  assert.equal(countLabel(0), 'NO GAMES MATCH');
  assert.equal(countLabel(1), 'SHOW 1 GAME');
  assert.equal(countLabel(272), 'SHOW 272 GAMES');
  assert.equal(countLabel(1234), 'SHOW 1,234 GAMES');
});

test('playtime reads naturally, and absent is not "0m"', () => {
  assert.equal(playtimeLabel(undefined), 'never played');
  assert.equal(playtimeLabel(0), 'never played');
  assert.equal(playtimeLabel(45), '45m');
  assert.equal(playtimeLabel(60), '1h');
  assert.equal(playtimeLabel(750), '12h 30m');
});

test('isFiltering reflects every dimension (control)', () => {
  assert.equal(isFiltering({ ...EMPTY_FILTER, search: '  ' }), false, 'whitespace is not a filter');
  assert.equal(isFiltering({ ...EMPTY_FILTER, search: 'x' }), true);
  assert.equal(isFiltering({ ...EMPTY_FILTER, kinds: ['steam'] }), true);
  assert.equal(isFiltering({ ...EMPTY_FILTER, played: 'never' }), true);
  assert.equal(isFiltering({ ...EMPTY_FILTER, staleDays: 30 }), true);
  assert.equal(isFiltering({ ...EMPTY_FILTER, staleDays: 0 }), false);
});

test('matches() and applyFilter() never disagree (control)', () => {
  const f: FilterState = { ...EMPTY_FILTER, played: 'under2h', staleDays: 100 };
  for (const game of LIB) {
    const single = matches(game, f, NOW);
    const inList = applyFilter([game], f, NOW).length === 1;
    assert.equal(single, inList, game.label);
  }
});

// ---- probe-and-appear: playtime controls must not lie on an old agent ----

test('hasPlaytimeData is false when the box sends none (the old-agent case)', () => {
  // Agent < 2.9.71 sends no playtime. Every game then LOOKS unplayed, so
  // offering "Never played" would state that the whole library was never
  // touched. The UI hides the controls on this signal.
  const old = [
    g({ label: 'Baldur’s Gate 3' }),
    g({ label: 'Netflix', kind: 'shortcut' }),
  ];
  assert.equal(hasPlaytimeData(old), false);
});

test('hasPlaytimeData is true on a single real datum (control)', () => {
  assert.equal(hasPlaytimeData([g({ label: 'A' }), g({ label: 'B', playtime_min: 0 })]), true,
    'an explicit zero IS data');
  assert.equal(hasPlaytimeData([g({ label: 'A' }), g({ label: 'B', last_played: 1 })]), true,
    'last_played alone is enough');
  assert.equal(hasPlaytimeData(LIB), true);
});

test('the old-agent library would otherwise report ALL games never played', () => {
  // Proves the danger the gate exists to prevent, so nobody "simplifies" it away.
  const old = [g({ label: 'A' }), g({ label: 'B' }), g({ label: 'C' })];
  const all = countMatching(old, { ...EMPTY_FILTER, played: 'never' }, NOW);
  assert.equal(all, old.length, 'without the gate this is the false claim');
  assert.equal(hasPlaytimeData(old), false, 'which is exactly why the gate hides it');
});

// ---- compatibility dimensions (phase 2) ----

import type { Compat } from '../compat.ts';

const RATED: Record<number, Compat> = {
  1: { deck: 'verified', proton: 'gold', protonReports: 1511 },
  2: { deck: 'unsupported', proton: 'borked', protonReports: 309 },
  // 3 is deliberately absent: nobody has rated it.
};
const WITH_IDS = [
  g({ label: 'Verified game', playtime_min: 600 }),
  g({ label: 'Broken game', playtime_min: 10 }),
  g({ label: 'Unrated game' }),
].map((x, i) => ({ ...x, appid: i + 1 }));

test('a compat filter keeps the matching game and drops the mismatching one', () => {
  const f: FilterState = { ...EMPTY_FILTER, deck: ['verified'] };
  const out = applyFilter(WITH_IDS, f, NOW, RATED).map((x) => x.label);
  assert.ok(out.includes('Verified game'));
  assert.ok(!out.includes('Broken game'), 'unsupported must not survive a verified-only filter');
});

test('an UNRATED game survives every compat filter (the load-bearing rule)', () => {
  // A third party having no data must never hide a game the user owns.
  for (const f of [
    { ...EMPTY_FILTER, deck: ['verified' as const] },
    { ...EMPTY_FILTER, proton: ['platinum' as const] },
    { ...EMPTY_FILTER, deck: ['verified' as const], proton: ['platinum' as const] },
  ]) {
    const out = applyFilter(WITH_IDS, f, NOW, RATED).map((x) => x.label);
    assert.ok(out.includes('Unrated game'), `unrated hidden by ${JSON.stringify(f)}`);
  }
});

test('with NO ratings loaded the library behaves exactly as before (control)', () => {
  // Compat filters must be inert until data arrives, not empty the screen.
  const f: FilterState = { ...EMPTY_FILTER, deck: ['verified'] };
  assert.equal(applyFilter(WITH_IDS, f, NOW, undefined).length, WITH_IDS.length);
  assert.equal(countMatching(WITH_IDS, f, NOW, undefined), WITH_IDS.length);
});

test('the count still equals the list once compat is in play (control)', () => {
  for (const f of [
    { ...EMPTY_FILTER, deck: ['verified' as const] },
    { ...EMPTY_FILTER, proton: ['gold' as const, 'platinum' as const] },
    { ...EMPTY_FILTER, deck: ['unsupported' as const], played: 'under2h' as const },
  ]) {
    assert.equal(
      countMatching(WITH_IDS, f, NOW, RATED),
      applyFilter(WITH_IDS, f, NOW, RATED).length,
      JSON.stringify(f),
    );
  }
});

test('isFiltering notices the compat dimensions (control)', () => {
  assert.equal(isFiltering({ ...EMPTY_FILTER, deck: [] }), false);
  assert.equal(isFiltering({ ...EMPTY_FILTER, deck: ['verified'] }), true);
  assert.equal(isFiltering({ ...EMPTY_FILTER, proton: ['gold'] }), true);
});

// ---- phase 4: pick something for me ----

import { pickRandom } from '../libraryFilter.ts';

test('shuffle returns null on an empty list rather than throwing', () => {
  assert.equal(pickRandom([]), null);
});

test('shuffle can reach every game and never goes out of range (control)', () => {
  const games = ['a', 'b', 'c'];
  const seen = new Set<string>();
  for (const r of [0, 0.32, 0.34, 0.66, 0.67, 0.999999]) {
    const got = pickRandom(games, () => r);
    assert.ok(got != null, `null at r=${r}`);
    seen.add(got as string);
  }
  assert.deepEqual([...seen].sort(), ['a', 'b', 'c'], 'every game is reachable');
});

test('a generator returning exactly 1 does not fall off the end (control)', () => {
  assert.equal(pickRandom(['a', 'b'], () => 1), 'b');
});

// ---------------------------------------------------------------------------
// Bookmarks and saved presets
// ---------------------------------------------------------------------------

test('a bookmark is keyed on the Steam appid when there is one', () => {
  // The appid is global and permanent; the launcher id is the agent's handle.
  // Keying a Steam game by launcher id would drop the bookmark the day the
  // agent renumbered anything.
  assert.equal(bookmarkKey({ appid: 702670, id: 'steam-3' }), 'app:702670');
  assert.equal(bookmarkKey({ id: 'custom-vlc' }), 'id:custom-vlc');
  assert.equal(bookmarkKey({}), null, 'neither: refuse to guess');
  assert.equal(bookmarkKey({ appid: 0, id: 'x' }), 'id:x', 'appid 0 is not a real appid');
});

test('toggling a bookmark is reversible and does not mutate (control)', () => {
  const a: string[] = [];
  const b = toggleBookmark(a, 'app:1');
  assert.deepEqual(a, [], 'input untouched');
  assert.deepEqual(b, ['app:1']);
  assert.deepEqual(toggleBookmark(b, 'app:1'), [], 'toggles back off');
});

test('the bookmarked filter shows only marked games, and none when nothing is marked', () => {
  const games = [
    { id: 'a', appid: 1, label: 'Alpha', kind: 'steam' as const },
    { id: 'b', label: 'Beta', kind: 'custom' as const },
  ];
  const f = { ...EMPTY_FILTER, bookmarked: true };
  const marks = new Set(['app:1']);
  assert.deepEqual(applyFilter(games, f, 0, undefined, marks).map((g) => g.label), ['Alpha']);
  // Empty is the CORRECT answer here, unlike every other filter in this file:
  // it is the user's own mark, so absence is an answer rather than ignorance.
  assert.equal(applyFilter(games, f, 0, undefined, new Set()).length, 0);
  // and with the filter off, the bookmark set is irrelevant (control)
  assert.equal(applyFilter(games, EMPTY_FILTER, 0, undefined, new Set()).length, 2);
});

test('bookmarked counts as filtering, so the clear affordance appears', () => {
  assert.equal(isFiltering(EMPTY_FILTER), false);
  assert.equal(isFiltering({ ...EMPTY_FILTER, bookmarked: true }), true);
});

test('preset names are collapsed and capped, and blank names are refused', () => {
  assert.equal(presetName('  weekend   short  '), 'weekend short');
  assert.equal(presetName('   '), null);
  assert.equal(presetName('x'.repeat(80))?.length, 28);
});

test('saving over an existing name edits in place rather than duplicating', () => {
  const f1 = { ...EMPTY_FILTER, played: 'never' as const };
  const f2 = { ...EMPTY_FILTER, played: 'over2h' as const };
  let list = upsertPreset([], 'Weekend', f1);
  list = upsertPreset(list, 'Backlog', f1);
  const before = list.length;
  list = upsertPreset(list, 'weekend', f2); // different case, same preset
  assert.equal(list.length, before, 'no duplicate');
  // Position is preserved so the list does not reshuffle under the user's
  // thumb, but the NAME is whatever they just typed — what you type is what you
  // get beats silently restoring capitalisation you did not ask for.
  assert.equal(list[0].name, 'weekend', 'takes the newly typed name');
  assert.equal(list[1].name, 'Backlog', 'the other preset stays put');
  assert.equal(list[0].filter.played, 'over2h', 'and takes the new filter');
});

test('the preset list is capped, dropping the oldest rather than refusing', () => {
  let list: FilterPreset[] = [];
  for (let i = 0; i < MAX_PRESETS + 3; i += 1) list = upsertPreset(list, `p${i}`, EMPTY_FILTER);
  assert.equal(list.length, MAX_PRESETS);
  assert.equal(list[list.length - 1].name, `p${MAX_PRESETS + 2}`, 'newest kept');
  assert.equal(list[0].name, 'p3', 'oldest dropped');
});

test('a malformed stored preset is skipped, not fatal (control)', () => {
  const raw = [
    { name: 'good', filter: { search: 'x', kinds: ['steam'], played: 'never' } },
    { name: '', filter: {} },
    { name: 'no filter' },
    'not an object',
    { name: 'bad fields', filter: { search: 5, kinds: 'nope', played: 'wat', staleDays: -3 } },
  ];
  const out = normalizePresets(raw);
  assert.deepEqual(out.map((p) => p.name), ['good', 'bad fields']);
  assert.deepEqual(out[0].filter.kinds, ['steam']);
  assert.equal(out[1].filter.search, '', 'bad types fall back to defaults');
  assert.deepEqual(out[1].filter.kinds, []);
  assert.equal(out[1].filter.played, 'any');
  assert.equal(out[1].filter.staleDays, undefined, 'a negative day count is dropped');
});

test('normalizePresets survives junk instead of throwing (control)', () => {
  assert.deepEqual(normalizePresets(null), []);
  assert.deepEqual(normalizePresets('nope'), []);
  assert.deepEqual(normalizePresets(undefined), []);
});

test('a corrupted deck/proton list is stripped, not passed through (control)', () => {
  // matchesCompat filters on whatever it is handed, so junk here would hide
  // games the user owns — the exact failure this module exists to prevent.
  const out = normalizePresets([
    { name: 'junk', filter: { search: '', kinds: [], played: 'any', deck: ['verified', 'wat', 7], proton: ['gold', null] } },
  ]);
  assert.deepEqual(out[0].filter.deck, ['verified']);
  assert.deepEqual(out[0].filter.proton, ['gold']);
});

test('an unknown played value cannot become the over-2h branch (control)', () => {
  // matchesPlayed falls through to >=2h for anything it does not recognise, so
  // a corrupted blob would silently hide every short game.
  const out = normalizePresets([{ name: 'x', filter: { played: 'nonsense' } }]);
  assert.equal(out[0].filter.played, 'any');
});
