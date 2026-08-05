/**
 * The seam that lets ONE pairing UI (components/TvPairForm) work whether or not
 * a Couchside box is present.
 *
 * The box-side SmartTvSetup and the box-less DirectTvSetup used to be two
 * different screens with two different Google TV flows — the exact "grow two of
 * something" mistake this file exists to undo. The form is identical either
 * way: a brand picker, a scan, an IP field, an optional MAC, an Android TV code
 * step, a result line. Only what sits behind each action differs:
 *
 *   - boxDriver forwards to the agent's /api/tv/* routes (credentials live on
 *     the box). Behaviour is byte-identical to the old SmartTvSetup — same
 *     calls, same order — so a box owner sees no change.
 *   - directDriver drives the TV straight from the phone via lib/tvdirect and
 *     persists to the on-phone TV store. It reports only the brands the app can
 *     actually reach without a box (Roku, Google TV today) so the picker never
 *     offers a TV it cannot pair.
 *
 * A driver instance may be STATEFUL: Android TV pairing is two-step and the
 * direct driver holds its open PairSession between start and finish (the agent
 * does the same server-side for the box driver).
 */
import { api, type ConnSettings, type DiscoveredTv, type TvIdentifyResult, type TvPairResult } from './api.ts';

export type Brand = 'webos' | 'samsung' | 'roku' | 'androidtv' | 'vidaa';

export type BrandMeta = { id: Brand; label: string; needsMac: boolean; verb: string };

/** The full roster, in display order. A driver exposes a SUBSET via `brands`. */
export const ALL_BRANDS: BrandMeta[] = [
  { id: 'webos', label: 'LG', needsMac: true, verb: 'Pair' },
  { id: 'samsung', label: 'Samsung', needsMac: true, verb: 'Pair' },
  { id: 'roku', label: 'Roku', needsMac: false, verb: 'Add' },
  { id: 'androidtv', label: 'Google TV', needsMac: true, verb: 'Pair' },
  { id: 'vidaa', label: 'Hisense', needsMac: true, verb: 'Add' },
];

export type AndroidtvStart = { ok: boolean; code_shown?: boolean; error?: string };

/**
 * Everything the pairing form does, as async operations. Kept deliberately
 * close to the agent's own API surface so boxDriver is a thin forward and the
 * form's hard-won logic (identify-then-act, the blocked/force-pair escape
 * hatch, the settled-vs-narration message split) is untouched by the move.
 */
export type TvPairDriver = {
  /** Brands the picker offers. */
  brands: BrandMeta[];
  /** Sweep the LAN for pairable TVs. */
  discover(): Promise<DiscoveredTv[]>;
  /** Ask what is at `host`, or null to SKIP identify and pair the chosen brand
   *  directly (the direct driver has no probe; an old agent 404s the route). */
  identify(host: string): Promise<TvIdentifyResult | null>;
  /** One-shot pair/add for roku/webos/samsung/vidaa. */
  pair(brand: Brand, host: string, mac?: string): Promise<TvPairResult>;
  /** Android TV step 1 — the TV shows a 6-digit code. */
  androidtvStart(host: string): Promise<AndroidtvStart>;
  /** Android TV step 2 — complete with the displayed code. */
  androidtvFinish(code: string, mac?: string): Promise<TvPairResult>;
  /** LG commercial/signage fallback (box only; direct rejects). */
  addLgCommercial(host: string): Promise<TvPairResult>;
};

// --------------------------------------------------------------- box driver

/** Drives a TV through the box agent. Every call is the SAME api.* the old
 *  SmartTvSetup made, so box behaviour is unchanged. */
export function boxDriver(settings: ConnSettings): TvPairDriver {
  return {
    brands: ALL_BRANDS,
    discover: async () => (await api.tvDiscover(settings)).tvs,
    identify: (host) => api.tvIdentify(settings, host),
    pair: (brand, host, mac) => {
      if (brand === 'webos') return api.tvPairWebos(settings, host, mac);
      if (brand === 'samsung') return api.tvPairSamsung(settings, host, mac);
      if (brand === 'vidaa') return api.tvAddVidaa(settings, host, mac);
      return api.tvAddRoku(settings, host);
    },
    androidtvStart: (host) => api.tvAndroidtvPairStart(settings, host),
    androidtvFinish: (code, mac) => api.tvAndroidtvPairFinish(settings, code, mac),
    addLgCommercial: (host) => api.tvAddLgCommercial(settings, host),
  };
}
