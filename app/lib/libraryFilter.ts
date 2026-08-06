/**
 * Library triage: narrowing a shelf you already own down to "what am I playing
 * tonight". Phase 1 of docs/memory/project_library-triage.md.
 *
 * ZERO runtime imports, so the predicates — the part where an off-by-one hides a
 * game the user owns — are testable in bare Node.
 *
 * NO NETWORK ANYWHERE IN HERE. Everything filters on what the box already sent:
 * name, kind, and the playtime Steam records on the machine itself. The
 * compatibility data (ProtonDB, Deck Verified) that would need the internet is
 * phase 2 and deliberately absent.
 *
 * THE RULE THIS FILE EXISTS TO KEEP: a filter must never make a game the user
 * owns *silently* disappear. Anything unknown is INCLUDED, not excluded — if we
 * do not know a game's playtime, it stays visible rather than being quietly
 * swallowed by "under 2 hours". Erring the other way means the user goes looking
 * for a game they own and concludes the app lost it.
 */

/** The subset of a launcher this module needs. Structural, so tests need no api types. */
export type FilterableGame = {
  label: string;
  kind: 'steam' | 'custom' | 'shortcut';
  /** Absent = Steam has no record = never played. 0 = launched, played nothing. */
  playtime_min?: number;
  last_played?: number;
};

export type PlayedFilter =
  /** Everything. */
  | 'any'
  /** Steam has no record at all — the shelf of things bought and forgotten. */
  | 'never'
  /** Played, but under two hours (the "bounced off it" pile). */
  | 'under2h'
  /** Played two hours or more. */
  | 'over2h';

import type { Compat, DeckStatus, ProtonTier } from './compat.ts';
import { matchesCompat } from './compat.ts';

export type FilterState = {
  /** Case-insensitive substring of the title. */
  search: string;
  /** Which launcher kinds to include; empty means all. */
  kinds: ('steam' | 'custom' | 'shortcut')[];
  played: PlayedFilter;
  /** Only games not launched in this many days. 0/undefined = no constraint. */
  staleDays?: number;
  /** Steam Deck ratings to keep; empty = all. Unknown always passes. */
  deck?: DeckStatus[];
  /** ProtonDB tiers to keep; empty = all. Unknown always passes. */
  proton?: ProtonTier[];
};

export const EMPTY_FILTER: FilterState = { search: '', kinds: [], played: 'any' };

/**
 * Does this library carry playtime at all?
 *
 * PROBE-AND-APPEAR, the pattern this project uses everywhere else. An agent
 * older than 2.9.71 sends no playtime, and then EVERY game looks unplayed — so
 * "Never played" would cheerfully report that a 300-game library has never been
 * touched. That is not a degraded filter, it is a false statement about the
 * user's own library, so the controls hide entirely rather than lie.
 */
export function hasPlaytimeData(games: FilterableGame[]): boolean {
  return games.some((g) => g.playtime_min != null || g.last_played != null);
}

/** Is any constraint active? Drives the "clear" affordance and the count copy. */
export function isFiltering(f: FilterState): boolean {
  return (
    f.search.trim() !== '' ||
    f.kinds.length > 0 ||
    f.played !== 'any' ||
    (f.staleDays ?? 0) > 0 ||
    (f.deck?.length ?? 0) > 0 ||
    (f.proton?.length ?? 0) > 0
  );
}

const HOUR = 60;

function matchesPlayed(g: FilterableGame, played: PlayedFilter): boolean {
  if (played === 'any') return true;
  const mins = g.playtime_min;
  if (played === 'never') {
    // Absent OR an explicit zero both mean "you have not actually played this".
    return mins == null || mins === 0;
  }
  // For the "played" buckets, an unknown playtime cannot be judged — include it
  // rather than hiding a game the user owns. See the header note.
  if (mins == null) return true;
  if (played === 'under2h') return mins > 0 && mins < 2 * HOUR;
  return mins >= 2 * HOUR;
}

function matchesStale(g: FilterableGame, staleDays: number | undefined, nowSec: number): boolean {
  if (!staleDays || staleDays <= 0) return true;
  // Never launched counts as stale: it has been "not played" the whole time.
  if (g.last_played == null || g.last_played <= 0) return true;
  return nowSec - g.last_played >= staleDays * 86400;
}

/** Does one game survive the filter? `compat` is optional — a library with no
 *  ratings loaded behaves exactly as before. */
export function matches(
  g: FilterableGame,
  f: FilterState,
  nowSec: number,
  compat?: Compat,
): boolean {
  const q = f.search.trim().toLowerCase();
  if (q && !g.label.toLowerCase().includes(q)) return false;
  if (f.kinds.length && !f.kinds.includes(g.kind)) return false;
  if (!matchesPlayed(g, f.played)) return false;
  if (!matchesStale(g, f.staleDays, nowSec)) return false;
  if (!matchesCompat(compat, f.deck ?? [], f.proton ?? [])) return false;
  return true;
}

/** The surviving games, order preserved. */
export function applyFilter<T extends FilterableGame & { appid?: number }>(
  games: T[],
  f: FilterState,
  nowSec: number,
  compat?: Record<number, Compat>,
): T[] {
  return games.filter((g) =>
    matches(g, f, nowSec, g.appid != null ? compat?.[g.appid] : undefined),
  );
}

/**
 * How many survive — for the live count on the confirm button, the detail that
 * makes filtering feel like an interaction rather than a chore ("SHOW 272
 * GAMES" falling as you narrow).
 */
export function countMatching(
  games: (FilterableGame & { appid?: number })[],
  f: FilterState,
  nowSec: number,
  compat?: Record<number, Compat>,
): number {
  let n = 0;
  for (const g of games) {
    if (matches(g, f, nowSec, g.appid != null ? compat?.[g.appid] : undefined)) n += 1;
  }
  return n;
}

/** Button label for the count. Singular at 1, and honest at 0. */
export function countLabel(n: number): string {
  if (n === 0) return 'NO GAMES MATCH';
  return `SHOW ${n.toLocaleString()} GAME${n === 1 ? '' : 'S'}`;
}

/** "12h 30m" / "45m" / "never". For the tile's playtime line. */
export function playtimeLabel(mins: number | undefined): string {
  if (mins == null || mins === 0) return 'never played';
  if (mins < 60) return `${mins}m`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m ? `${h}h ${m}m` : `${h}h`;
}
