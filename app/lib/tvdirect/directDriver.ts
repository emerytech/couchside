/**
 * The box-less TvPairDriver: this phone driving the TV directly, persisting to
 * the on-phone TV store. Implements the same interface boxDriver does, so
 * components/TvPairForm renders identically with or without a box.
 *
 * Only the brands with a real app-side transport are exposed (Roku, Google TV,
 * LG webOS); the picker therefore never offers a TV this build cannot pair
 * without a box. samsung/vidaa stay boxDriver-only until their TLS work lands.
 *
 * Stateful, like the agent is server-side: an Android TV pairing holds its open
 * PairSession and the minted identity between start() and finish().
 */
import { type DiscoveredTv, type TvIdentifyResult, type TvPairResult } from '../api.ts';
import { pairStart, type PairSession } from './androidtv.ts';
import {
  fetchPeerCert,
  makeConnect,
  makeRawTlsConnect,
  mintIdentity,
  randomBytes,
  sha1,
  sha256,
} from './atvnative.ts';
import { ATV_PAIR_PORT } from './atvproto.ts';
import { type AtvCreds, isValidTvHost } from './model.ts';
import { rokuIdentify } from './roku.ts';
import { addTv, dropTvSession, scanForTvs } from './store.ts';
import { WebosSession } from './webos.ts';
import {
  ALL_BRANDS,
  type AndroidtvStart,
  type Brand,
  type TvPairDriver,
} from '../tvPairDriver.ts';

/** Brands the app can drive with no box. Mirrors model.DIRECT_BRANDS. */
const DIRECT_BRAND_IDS: Brand[] = ['roku', 'androidtv', 'webos'];

/** webOS transport deps, from the native layer. */
const WEBOS_DEPS = {
  fetchPeerCert,
  rawConnect: makeRawTlsConnect,
  crypto: { randomBytes, sha1 },
};

export function directDriver(): TvPairDriver {
  // Held between the two Android TV steps.
  let session: PairSession | null = null;
  let pendingCreds: AtvCreds | null = null;
  let pendingHost = '';
  let pendingName = '';

  // Refuse a non-LAN destination BEFORE contacting it — the app must never open
  // a socket to a public address a user typed (or a name that resolves to one).
  // Same KI-033-hardened gate the store uses; here it also stops the request.
  const lanGuard = (host: string): TvPairResult | null =>
    isValidTvHost(host) ? null : { ok: false, error: 'Enter the TV’s IP address on your network.' };

  const finishRoku = async (host: string): Promise<TvPairResult> => {
    const info = await rokuIdentify(host);
    if (!info) {
      return { ok: false, error: 'No Roku answered at that address. Check the IP and Wi-Fi.' };
    }
    const stored = await addTv({ name: info.name, brand: 'roku', host });
    return stored
      ? { ok: true, name: stored.name, host }
      : { ok: false, error: 'That address could not be stored.' };
  };

  return {
    // Same labels/order as ALL_BRANDS, filtered to what the app can drive.
    brands: ALL_BRANDS.filter((b) => DIRECT_BRAND_IDS.includes(b.id)),

    // The /24 Roku sweep already streams into DirectTvSetup's own scan button;
    // here it backs the shared form's "Scan for TVs". Android TV has no
    // broadcast discovery the app can do (iOS blocks UDP), so only Rokus appear.
    discover: async (): Promise<DiscoveredTv[]> => {
      const found = await scanForTvs();
      return found.map((tv) => ({ brand: 'roku', name: tv.name, host: tv.host }));
    },

    // No app-side identify probe: return null so the form SKIPS identify and
    // pairs the selected brand directly — exactly how it already degrades
    // against an agent too old to have the identify route.
    identify: async (): Promise<TvIdentifyResult | null> => null,

    pair: async (brand: Brand, host: string): Promise<TvPairResult> => {
      const bad = lanGuard(host);
      if (bad) return bad;
      if (brand === 'roku') return finishRoku(host);
      if (brand === 'webos') {
        // TOFU the LG's self-signed cert, register (the TV shows an Accept
        // prompt — the form is already narrating "Waiting for you to accept"),
        // persist the client-key for silent reconnect.
        const s = new WebosSession(host, WEBOS_DEPS);
        const r = await s.pair();
        s.close();
        if (!r.ok || !r.clientKey || !r.caPem) {
          return { ok: false, error: r.error ?? 'Pairing was refused by the TV.' };
        }
        dropTvSession(host); // a re-pair replaces creds; clear any live session
        const stored = await addTv({
          name: `LG webOS (${host})`,
          brand: 'webos',
          host,
          webos: { caPem: r.caPem, clientKey: r.clientKey },
        });
        return stored
          ? { ok: true, name: stored.name, host: stored.host }
          : { ok: false, error: 'Paired, but the TV could not be saved.' };
      }
      // webos/samsung/vidaa are not in this driver's brand list, so the form
      // never calls them; guard anyway so a future caller fails loudly.
      return { ok: false, error: `${brand} needs a Couchside box.` };
    },

    androidtvStart: async (host: string): Promise<AndroidtvStart> => {
      if (!isValidTvHost(host)) {
        return { ok: false, error: 'Enter the TV’s IP address on your network.' };
      }
      // Mint BEFORE opening the socket: the TV's code dialog expires fast
      // (measured 39s failed / 5.6s worked), and RSA keygen must not run in
      // that window. The caller (TvPairForm) shows its own "opening…" state.
      const minted = mintIdentity();
      const caPem = await fetchPeerCert(host, ATV_PAIR_PORT);
      if (!caPem) {
        return {
          ok: false,
          error:
            'Could not read this TV’s certificate. Check the IP and that the TV is on and on the same Wi-Fi — this TV may not be pairable from the app yet.',
        };
      }
      try {
        session = await pairStart(host, minted, { connect: makeConnect(caPem), sha256 }, 'Couchside');
      } catch (e) {
        return { ok: false, error: `The TV did not start pairing: ${(e as Error).message}` };
      }
      pendingCreds = { certPem: minted.certPem, keyPem: minted.keyPem, modulusHex: minted.modulusHex, caPem };
      pendingHost = host;
      pendingName = `Google TV (${host})`;
      return { ok: true, code_shown: true };
    },

    androidtvFinish: async (code: string): Promise<TvPairResult> => {
      if (!session || !pendingCreds) return { ok: false, error: 'Start pairing again.' };
      try {
        await session.finish(code.trim());
      } catch (e) {
        return { ok: false, error: (e as Error).message };
      } finally {
        session = null;
      }
      dropTvSession(pendingHost); // a re-pair replaces credentials
      const stored = await addTv({
        name: pendingName,
        brand: 'androidtv',
        host: pendingHost,
        atv: pendingCreds,
      });
      pendingCreds = null;
      return stored
        ? { ok: true, name: stored.name, host: stored.host }
        : { ok: false, error: 'Paired, but the TV could not be saved.' };
    },

    // No box, no RS-232-over-LAN path. The direct brand list never surfaces the
    // lg_commercial identify result (identify returns null), so this is only a
    // defensive guard.
    addLgCommercial: async (): Promise<TvPairResult> => ({
      ok: false,
      error: 'LG commercial displays need a Couchside box.',
    }),
  };
}
