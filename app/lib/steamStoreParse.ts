/**
 * Parsing Steam's public store metadata (name + type) for a Steam appid.
 *
 * Phase 2 of "install a game you own but have not downloaded". The BOX enumerates
 * the owned-but-uninstalled library from its own disk (no key, no account — see the
 * agent's _installable_appids), but it has no reliable OFFLINE NAME for an
 * uninstalled game (appinfo.vdf is a partial cache). Names + type come from Valve's
 * own KEYLESS store endpoint, app-side:
 *
 *   store.steampowered.com/api/appdetails?appids=<id>&filters=basic
 *
 * NO Steam Web API key and no account — the same public per-appid metadata anyone
 * gets ("what is game 620"), the same host lib/compatFetch already uses. `type` is
 * what lets the grid drop the tools/DLC/demos that the library art cache overcounts
 * and show only games.
 *
 * ZERO runtime imports on purpose (like lib/compat.ts): this module only PARSES, so
 * a wrong parse — which would mislabel or hide a game the user owns — is testable in
 * bare Node against captured payloads. The fetching + caching live in ./steamStore.
 *
 * THE HONESTY RULE: a payload we cannot read is `null` (unknown), never a guessed
 * name or type. The grid keeps unknown-type entries out of the "games" filter rather
 * than inventing "game", and shows the box's own capsule art (which carries the
 * title) so an unresolved tile is still recognisable.
 */

export type AppDetails = {
  /** The store display name. */
  name: string;
  /** Steam's app type: "game" | "dlc" | "tool" | "demo" | "music" | "application" | … */
  type: string;
};

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
  const d = r.data as { name?: unknown; type?: unknown };
  const name = typeof d.name === 'string' ? d.name.trim() : '';
  const type = typeof d.type === 'string' ? d.type.toLowerCase() : '';
  if (!name || !type) return null;
  return { name, type };
}

/** Is this an app the user would actually install as a GAME (not a tool/DLC/demo)?
 *  Unknown type does NOT pass — the grid shows games it can identify and leaves the
 *  rest out rather than presenting a Steam runtime as something to install. */
export function isInstallableGameType(d: AppDetails | null | undefined): boolean {
  return !!d && d.type === 'game';
}
