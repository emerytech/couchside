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
  /** Stable per-launcher id from the agent. Optional here only so the pure
   *  filter tests can build minimal fixtures; real launchers always carry it. */
  id?: string;
  label: string;
  kind: 'steam' | 'custom' | 'shortcut';
  /** Absent = Steam has no record = never played. 0 = launched, played nothing. */
  playtime_min?: number;
  /** Install size in bytes, from Steam's own appmanifest (agent >= 2.9.72).
   *  Absent means Steam did not state one — never a zero we invented. */
  size_bytes?: number;
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
  /**
   * Show only games the user has bookmarked.
   *
   * UNLIKE every other filter here, an empty result is CORRECT rather than a
   * bug: "show me my bookmarks" when nothing is bookmarked honestly means no
   * games. The unknown-passes rule elsewhere exists so a third party's missing
   * data cannot hide something you own; this is the user's own explicit mark,
   * so absence is an answer, not ignorance.
   */
  bookmarked?: boolean;
  /**
   * Only games at least this big, in GB. For "what is eating my disk".
   *
   * Entries with NO size are excluded while this is on — shortcuts have no
   * install size at all, and on a real library they outnumbered the games and
   * made the filter meaningless. See matchesSize for the full reasoning.
   */
  minSizeGb?: number;
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
    (f.proton?.length ?? 0) > 0 ||
    (f.minSizeGb ?? 0) > 0 ||
    f.bookmarked === true
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

const GB = 1024 * 1024 * 1024;

function matchesSize(g: FilterableGame, minGb: number | undefined): boolean {
  if (!minGb || minGb <= 0) return true;
  // AN ENTRY WITH NO SIZE IS EXCLUDED HERE, and this is the one place in this
  // module that departs from "unknown is included".
  //
  // Measured on a real box: "over 10 GB" returned 29 of 33 games when exactly
  // ONE was over 10 GB. The other 28 were non-Steam shortcuts — Netflix and the
  // like — which have no install size by nature. They are not games of unknown
  // size, they are entries the question does not apply to, and letting them
  // through made the filter useless for the only thing it is for.
  //
  // The unknown-passes rule protects against a THIRD PARTY's missing data
  // hiding something you own. Here the user has explicitly asked "show me what
  // is big", and an entry with no size cannot answer that. The sheet says this
  // out loud rather than leaving it to be discovered.
  if (g.size_bytes == null || g.size_bytes <= 0) return false;
  return g.size_bytes >= minGb * GB;
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
  bookmarks?: ReadonlySet<string>,
): boolean {
  const q = f.search.trim().toLowerCase();
  if (q && !g.label.toLowerCase().includes(q)) return false;
  if (f.kinds.length && !f.kinds.includes(g.kind)) return false;
  if (!matchesPlayed(g, f.played)) return false;
  if (!matchesStale(g, f.staleDays, nowSec)) return false;
  if (!matchesCompat(compat, f.deck ?? [], f.proton ?? [])) return false;
  if (!matchesSize(g, f.minSizeGb)) return false;
  if (f.bookmarked) {
    const k = bookmarkKey(g);
    if (!k || !bookmarks?.has(k)) return false;
  }
  return true;
}

/** The surviving games, order preserved. */
export function applyFilter<T extends FilterableGame & { appid?: number }>(
  games: T[],
  f: FilterState,
  nowSec: number,
  compat?: Record<number, Compat>,
  bookmarks?: ReadonlySet<string>,
): T[] {
  return games.filter((g) =>
    matches(g, f, nowSec, g.appid != null ? compat?.[g.appid] : undefined, bookmarks),
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
  bookmarks?: ReadonlySet<string>,
): number {
  let n = 0;
  for (const g of games) {
    const c = g.appid != null ? compat?.[g.appid] : undefined;
    if (matches(g, f, nowSec, c, bookmarks)) n += 1;
  }
  return n;
}

/** Button label for the count. Singular at 1, and honest at 0. */
export function countLabel(n: number): string {
  if (n === 0) return 'NO GAMES MATCH';
  return `SHOW ${n.toLocaleString()} GAME${n === 1 ? '' : 'S'}`;
}

/**
 * Pick one game at random from a filtered list — "just choose for me".
 *
 * The point on Couchside is that the pick is LAUNCHABLE: elsewhere a shuffle
 * ends at a suggestion, here it ends at the game starting on the TV.
 *
 * `rand` is injected so this is testable; production passes Math.random.
 * Returns null for an empty list rather than throwing, because "no games match"
 * is a normal state of the filter above it.
 */
export function pickRandom<T>(games: T[], rand: () => number = Math.random): T | null {
  if (!games.length) return null;
  const i = Math.floor(rand() * games.length);
  // Guard the rand() === 1 edge: Math.random() never returns 1, but an injected
  // or future generator might, and an out-of-range index would return undefined
  // while the type still claims T.
  return games[Math.min(i, games.length - 1)] ?? null;
}

/**
 * "48.2 GB" / "860 MB" / null when Steam never said.
 *
 * Returns NULL rather than a dash or a zero: the caller then omits the line
 * entirely, because "0 GB" reads as free space that is not free.
 */
export function sizeLabel(bytes: number | undefined): string | null {
  if (bytes == null || bytes <= 0) return null;
  if (bytes >= GB) return `${(bytes / GB).toFixed(1)} GB`;
  return `${Math.max(1, Math.round(bytes / (1024 * 1024)))} MB`;
}

/** "12h 30m" / "45m" / "never". For the tile's playtime line. */
export function playtimeLabel(mins: number | undefined): string {
  if (mins == null || mins === 0) return 'never played';
  if (mins < 60) return `${mins}m`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m ? `${h}h ${m}m` : `${h}h`;
}

// ---------------------------------------------------------------------------
// Bookmarks — "come back to this one"
// ---------------------------------------------------------------------------

/**
 * The stable identity a bookmark is stored against.
 *
 * PREFER THE STEAM APPID. It is global and permanent: 702670 is Donut County on
 * every box, forever. The launcher `id` is the agent's own handle and is the
 * only thing a custom launcher or a non-Steam shortcut has, so it is the
 * fallback rather than the primary — a Steam game keyed by launcher id would
 * lose its bookmark the day the agent renumbered anything.
 *
 * Returns null when a game carries neither, which the filter treats as
 * "not bookmarked" rather than guessing.
 */
export function bookmarkKey(g: { appid?: number; id?: string }): string | null {
  if (typeof g.appid === 'number' && Number.isFinite(g.appid) && g.appid > 0) {
    return `app:${Math.floor(g.appid)}`;
  }
  const id = g.id?.trim();
  return id ? `id:${id}` : null;
}

/** Add or remove a key. Returns a NEW array; order is insertion order, which is
 *  also the order the UI lists them in. */
export function toggleBookmark(keys: readonly string[], key: string): string[] {
  return keys.includes(key) ? keys.filter((k) => k !== key) : [...keys, key];
}

// ---------------------------------------------------------------------------
// Saved filter presets
// ---------------------------------------------------------------------------

export type FilterPreset = { name: string; filter: FilterState };

/** Runtime allowlists for restoring a stored preset. The types themselves are
 *  compile-time only, so without these a corrupted blob would sail through. */
const DECK_VALUES: DeckStatus[] = ['verified', 'playable', 'unsupported', 'unknown'];
const PROTON_VALUES: ProtonTier[] = ['platinum', 'gold', 'silver', 'bronze', 'borked', 'unknown'];

/** Presets a user can keep. Past this the list stops being a shortcut. */
export const MAX_PRESETS = 12;
const MAX_PRESET_NAME = 28;

/** Clean a typed name, or null if there is nothing usable in it. Whitespace is
 *  collapsed so "  weekend   short " and "weekend short" are the same preset
 *  rather than two that look identical in the list. */
export function presetName(raw: string): string | null {
  const n = raw.replace(/\s+/g, ' ').trim().slice(0, MAX_PRESET_NAME);
  return n.length ? n : null;
}

/**
 * Save a filter under a name, replacing any existing preset with that name
 * case-insensitively — typing "Weekend" over "weekend" is plainly an edit, not
 * a second entry. A replacement keeps its ORIGINAL position so the list does
 * not reshuffle under the user's thumb.
 */
export function upsertPreset(
  list: readonly FilterPreset[],
  name: string,
  filter: FilterState,
): FilterPreset[] {
  const clean = presetName(name);
  if (!clean) return [...list];
  const at = list.findIndex((p) => p.name.toLowerCase() === clean.toLowerCase());
  const entry: FilterPreset = { name: clean, filter };
  if (at >= 0) {
    const next = [...list];
    next[at] = entry;
    return next;
  }
  // Oldest falls off the end rather than refusing the save: a full list must
  // not turn the button into a dead control with no explanation.
  return [...list, entry].slice(-MAX_PRESETS);
}

export function removePreset(list: readonly FilterPreset[], name: string): FilterPreset[] {
  return list.filter((p) => p.name.toLowerCase() !== name.toLowerCase());
}

/**
 * Coerce a stored blob back into presets, dropping anything malformed.
 *
 * Defensive on purpose: this is JSON that has been on disk across app upgrades,
 * and a filter shape that has gained fields since it was written. A preset that
 * cannot be read is skipped rather than allowed to throw and take every other
 * preset with it.
 */
export function normalizePresets(raw: unknown): FilterPreset[] {
  if (!Array.isArray(raw)) return [];
  const out: FilterPreset[] = [];
  for (const item of raw) {
    const o = item as { name?: unknown; filter?: unknown };
    const name = typeof o?.name === 'string' ? presetName(o.name) : null;
    if (!name) continue;
    const f = o.filter as Partial<FilterState> | undefined;
    if (!f || typeof f !== 'object') continue;
    const kinds = Array.isArray(f.kinds)
      ? f.kinds.filter((k): k is 'steam' | 'custom' | 'shortcut' =>
          k === 'steam' || k === 'custom' || k === 'shortcut')
      : [];
    const played: PlayedFilter =
      f.played === 'never' || f.played === 'under2h' || f.played === 'over2h' ? f.played : 'any';
    out.push({
      name,
      filter: {
        search: typeof f.search === 'string' ? f.search : '',
        kinds,
        played,
        staleDays: typeof f.staleDays === 'number' && f.staleDays > 0 ? Math.floor(f.staleDays) : undefined,
        // VALIDATE THE MEMBERS, do not just check it is an array. matchesCompat
        // filters on whatever it is handed, so a junk value in here would hide
        // games the user owns — the one outcome this module exists to prevent.
        deck: Array.isArray(f.deck)
          ? (f.deck.filter((d) => DECK_VALUES.includes(d as DeckStatus)) as DeckStatus[])
          : undefined,
        proton: Array.isArray(f.proton)
          ? (f.proton.filter((p2) => PROTON_VALUES.includes(p2 as ProtonTier)) as ProtonTier[])
          : undefined,
        bookmarked: f.bookmarked === true ? true : undefined,
      },
    });
    if (out.length >= MAX_PRESETS) break;
  }
  return out;
}
