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
  return out;
}

/** Is this an app the user would actually install as a GAME (not a tool/DLC/demo)?
 *  Unknown type does NOT pass — the grid shows games it can identify and leaves the
 *  rest out rather than presenting a Steam runtime as something to install. */
export function isInstallableGameType(d: AppDetails | null | undefined): boolean {
  return !!d && d.type === 'game';
}
