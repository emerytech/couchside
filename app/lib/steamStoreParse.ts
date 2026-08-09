/**
 * Parsing Steam's public store metadata (name, type, release year, genres) for a
 * Steam appid.
 *
 * Phase 2/filters of "install a game you own but haven't downloaded". The BOX
 * enumerates the owned-but-uninstalled library from its own disk (no key, no
 * account — see the agent's _installable_appids). Since agent 2.9.76 it ALSO
 * ships name+type parsed OFFLINE from appinfo.vdf (the earlier "partial cache"
 * assumption was disproven by measurement: 100% name coverage of a real 1101-app
 * library) — those seed the page instantly. This module parses what appinfo
 * cannot supply (genres, release year), plus name/type for OLD agents, from
 * Valve's own KEYLESS store endpoint, app-side:
 *
 *   store.steampowered.com/api/appdetails?appids=<id>&l=english
 *
 * NO Steam Web API key and no account — the same public per-appid metadata anyone
 * gets ("what is game 620"), the same host lib/compatFetch already uses. `type`
 * lets the grid drop the tools/DLC the library cache overcounts; `releaseYear` and
 * `genres` power the sort + filter controls on the library page.
 *
 * ZERO runtime imports on purpose (like lib/compat.ts): this module only PARSES, so
 * a wrong parse — which would mislabel or mis-sort a game the user owns — is
 * testable in bare Node against captured payloads. The fetching + caching live in
 * ./steamStore.
 *
 * THE HONESTY RULE: a payload we cannot read is `null` (unknown), never a guessed
 * name/type; a missing release date or genre list is simply absent (the sort/filter
 * treats absent as "unknown", never invents a value).
 */

export type AppDetails = {
  /** The store display name. */
  name: string;
  /** Steam's app type: "game" | "dlc" | "tool" | "demo" | "music" | "application" | … */
  type: string;
  /** 4-digit release year, when the store states a parseable one. Sort key. */
  releaseYear?: number;
  /** Store genre labels ("Action", "RPG", …), lowercased for stable matching. */
  genres?: string[];
  /** Metacritic critic score 0–100, when the store carries one. A rating field
   *  any surface can show — it rides in the SAME appdetails payload as name/genre,
   *  so it costs no extra request. */
  metacritic?: number;
  /** Total Steam recommendations — a popularity proxy (NOT the positive/negative
   *  sentiment; that lives in lib/steamReviews.ts). Also free from this payload. */
  recommendations?: number;
  /** Native controller support per the store: 'full' | 'partial' | undefined.
   *  Relevant for a couch app — "which of these play well on the pad". */
  controllerSupport?: 'full' | 'partial';
};

/** Pull a 4-digit year out of Steam's free-form release date ("10 Aug, 2011",
 *  "2011", "Q3 2024", "Coming soon"). Absent/unparseable → undefined. */
function parseYear(raw: unknown): number | undefined {
  if (typeof raw !== 'string') return undefined;
  const m = raw.match(/\b(19|20)\d{2}\b/);
  if (!m) return undefined;
  const y = parseInt(m[0], 10);
  return y >= 1970 && y <= 2100 ? y : undefined;
}

/**
 * Parse one appid out of an appdetails response body. The endpoint keys the result
 * by the appid as a STRING and wraps it in `{success, data}`, so `success !== true`
 * (a delisted or region-locked app) is `null`, not an error. Never throws.
 */
export function parseAppDetails(appid: number, body: unknown): AppDetails | null {
  if (!body || typeof body !== 'object') return null;
  const rec = (body as Record<string, unknown>)[String(appid)];
  if (!rec || typeof rec !== 'object') return null;
  const r = rec as { success?: unknown; data?: unknown };
  if (r.success !== true || !r.data || typeof r.data !== 'object') return null;
  const d = r.data as {
    name?: unknown; type?: unknown;
    release_date?: { date?: unknown } | unknown;
    genres?: unknown;
    metacritic?: { score?: unknown } | unknown;
    recommendations?: { total?: unknown } | unknown;
    controller_support?: unknown;
  };
  const name = typeof d.name === 'string' ? d.name.trim() : '';
  const type = typeof d.type === 'string' ? d.type.toLowerCase() : '';
  if (!name || !type) return null;

  const out: AppDetails = { name, type };

  const rd = d.release_date;
  const y = parseYear(rd && typeof rd === 'object' ? (rd as { date?: unknown }).date : undefined);
  if (y !== undefined) out.releaseYear = y;

  if (Array.isArray(d.genres)) {
    const g = d.genres
      .map((x) =>
        x && typeof x === 'object' && typeof (x as { description?: unknown }).description === 'string'
          ? ((x as { description: string }).description).trim().toLowerCase()
          : '')
      .filter(Boolean);
    if (g.length) out.genres = g;
  }

  // Metacritic: an integer 0–100. Guard the range so a malformed value is dropped.
  const mc = d.metacritic;
  const score = mc && typeof mc === 'object' ? (mc as { score?: unknown }).score : undefined;
  if (typeof score === 'number' && Number.isFinite(score) && score >= 0 && score <= 100) {
    out.metacritic = Math.round(score);
  }

  // Steam recommendation count (popularity proxy).
  const rc = d.recommendations;
  const total = rc && typeof rc === 'object' ? (rc as { total?: unknown }).total : undefined;
  if (typeof total === 'number' && Number.isFinite(total) && total >= 0) {
    out.recommendations = Math.round(total);
  }

  // Controller support: only 'full'/'partial' are meaningful; anything else absent.
  if (d.controller_support === 'full' || d.controller_support === 'partial') {
    out.controllerSupport = d.controller_support;
  }
  return out;
}

/**
 * The Steam REVIEW SENTIMENT summary, from the keyless appreviews endpoint
 * (store.steampowered.com/appreviews/<id>?json=1) — a DIFFERENT request from
 * appdetails, so it is fetched lazily (see lib/steamReviews.ts) only when a
 * surface actually wants it. This is the "Overwhelmingly Positive / 98%" line
 * people recognise; appdetails only carries the raw recommendation count.
 */
export type SteamReview = {
  /** review_score, 0–9 (0 = no score, 9 = Overwhelmingly Positive). Sort key. */
  score: number;
  /** review_score_desc, e.g. "Very Positive". */
  desc: string;
  /** Positive share, 0–100 (rounded). undefined when there are no reviews. */
  positivePct?: number;
  /** total_reviews. */
  total: number;
};

/** Parse the appreviews `query_summary`. Returns null on a malformed body or a
 *  game with no reviews at all (total 0, score 0). Never throws. */
export function parseReviewSummary(body: unknown): SteamReview | null {
  if (!body || typeof body !== 'object') return null;
  const b = body as { success?: unknown; query_summary?: unknown };
  if (b.success !== 1 && b.success !== true) return null;
  const q = b.query_summary;
  if (!q || typeof q !== 'object') return null;
  const s = q as {
    review_score?: unknown; review_score_desc?: unknown;
    total_positive?: unknown; total_reviews?: unknown;
  };
  const score = typeof s.review_score === 'number' ? s.review_score : NaN;
  const desc = typeof s.review_score_desc === 'string' ? s.review_score_desc.trim() : '';
  const total = typeof s.total_reviews === 'number' ? s.total_reviews : 0;
  const pos = typeof s.total_positive === 'number' ? s.total_positive : 0;
  if (!Number.isFinite(score) || score < 0 || score > 9) return null;
  if (total <= 0 || !desc) return null; // no reviews -> nothing to show
  return {
    score: Math.round(score),
    desc,
    total: Math.round(total),
    positivePct: Math.round((pos / total) * 100),
  };
}

/** Is this an app the user would actually install as a GAME (not a tool/DLC/demo)?
 *  Unknown type does NOT pass — the grid shows games it can identify and leaves the
 *  rest out rather than presenting a Steam runtime as something to install. */
export function isInstallableGameType(d: AppDetails | null | undefined): boolean {
  return !!d && d.type === 'game';
}
