/**
 * How well does this game run on a Linux handheld / SteamOS box.
 *
 * Phase 2 of docs/memory/project_library-triage.md. Two independent sources,
 * both PUBLIC PER-APPID METADATA — "how does game 1086940 run", the same answer
 * for everyone:
 *
 *   Valve Deck compatibility  store.steampowered.com/saleaction/ajaxgetdeck…
 *   ProtonDB community tier   protondb.com/api/v1/reports/summaries/<appid>.json
 *
 * NO STEAM API KEY, and no account of any kind. A Steam Web API key exists to
 * read YOUR data — owned games, playtime — and this never asks for that: the box
 * already has it on disk (phase 1). That distinction is what makes this feature
 * viable at all; the account-linked design would have needed a Valve key and a
 * public profile, which is friction most people would never get through.
 *
 * ZERO runtime imports here on purpose. This module PARSES and RANKS; the
 * fetching and caching live in ./compatFetch.ts, so the part where a wrong parse
 * would mislabel a game is testable in bare Node against captured real payloads.
 *
 * THE HONESTY RULE: unknown is a first-class value, never coerced into a
 * verdict. A game with no ProtonDB reports is "unknown", not "borked"; a game
 * Valve has not rated is "unknown", not "unsupported". Telling someone a game
 * they own will not run, when nobody actually said that, is worse than saying
 * nothing.
 */

/** Valve's own rating. `resolved_category` — mapping VERIFIED against known
 *  titles 2026-08-06: 1 = Unsupported (R6 Siege), 2 = Playable (RDR2, Risk of
 *  Rain 2), 3 = Verified (Baldur's Gate 3). 0/absent = not yet rated. */
export type DeckStatus = 'verified' | 'playable' | 'unsupported' | 'unknown';

/** ProtonDB's community tier, best-to-worst. */
export type ProtonTier = 'platinum' | 'gold' | 'silver' | 'bronze' | 'borked' | 'unknown';

export type Compat = {
  deck: DeckStatus;
  proton: ProtonTier;
  /** How many ProtonDB reports back the tier. 0 with a real tier means the
   *  payload said so; the UI can use it to avoid quoting a lone opinion. */
  protonReports: number;
};

export const UNKNOWN_COMPAT: Compat = { deck: 'unknown', proton: 'unknown', protonReports: 0 };

const DECK_BY_CATEGORY: Record<number, DeckStatus> = {
  1: 'unsupported',
  2: 'playable',
  3: 'verified',
};

/** Parse Valve's deck compatibility payload. Never throws; anything unexpected
 *  is 'unknown' rather than a guess. */
export function parseDeckStatus(body: unknown): DeckStatus {
  const b = body as { success?: number; results?: { resolved_category?: unknown } } | null;
  if (!b || b.success !== 1) return 'unknown';
  const cat = b.results?.resolved_category;
  if (typeof cat !== 'number') return 'unknown';
  return DECK_BY_CATEGORY[cat] ?? 'unknown';
}

const TIERS: ProtonTier[] = ['platinum', 'gold', 'silver', 'bronze', 'borked'];

/**
 * Parse ProtonDB's summary. Uses `tier`, NOT `bestReportedTier`: "best anyone
 * ever reported" is the most flattering number on the page and would tell
 * someone a game is Platinum when the consensus is Gold. The realistic figure is
 * the useful one when you are deciding what to start tonight.
 */
export function parseProton(body: unknown): { tier: ProtonTier; reports: number } {
  const b = body as { tier?: unknown; total?: unknown } | null;
  if (!b) return { tier: 'unknown', reports: 0 };
  const t = typeof b.tier === 'string' ? b.tier.toLowerCase() : '';
  const tier = (TIERS as string[]).includes(t) ? (t as ProtonTier) : 'unknown';
  const reports = typeof b.total === 'number' && b.total >= 0 ? Math.floor(b.total) : 0;
  return { tier, reports };
}

/** Rank for sorting — higher is better. Unknown sorts BELOW every known rating
 *  but ABOVE borked, because "nobody has tested it" is not worse than "it is
 *  known to be broken". */
export function protonRank(t: ProtonTier): number {
  switch (t) {
    case 'platinum': return 5;
    case 'gold': return 4;
    case 'silver': return 3;
    case 'bronze': return 2;
    case 'unknown': return 1;
    case 'borked': return 0;
  }
}

export function deckRank(s: DeckStatus): number {
  switch (s) {
    case 'verified': return 3;
    case 'playable': return 2;
    case 'unknown': return 1;
    case 'unsupported': return 0;
  }
}

/** Short label for a badge. Deliberately the plain word, not a marketing term. */
export function deckLabel(s: DeckStatus): string {
  return s === 'unknown' ? 'Not rated' : s[0].toUpperCase() + s.slice(1);
}

export function protonLabel(t: ProtonTier): string {
  return t === 'unknown' ? 'No reports' : t[0].toUpperCase() + t.slice(1);
}

/**
 * Does a game pass a compatibility filter?
 *
 * UNKNOWN ALWAYS PASSES, for the same reason unknown playtime does in
 * libraryFilter: a filter must never make a game the user owns silently vanish
 * because a third-party service has no data on it. They would go looking for it
 * and conclude the app lost their library.
 */
export function matchesCompat(
  c: Compat | undefined,
  wantDeck: DeckStatus[],
  wantProton: ProtonTier[],
): boolean {
  if (!c) return true;
  if (wantDeck.length && c.deck !== 'unknown' && !wantDeck.includes(c.deck)) return false;
  if (wantProton.length && c.proton !== 'unknown' && !wantProton.includes(c.proton)) return false;
  return true;
}
