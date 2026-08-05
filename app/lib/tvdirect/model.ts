/**
 * The app-side TV device model for REMOTE-ONLY mode. ZERO runtime imports.
 *
 * Remote-only mode is the app driving a smart TV directly over the LAN with no
 * Couchside box in the picture. That inverts the model the rest of the app is
 * built on: every TV control today is agent-mediated, and every TV credential
 * lives in the BOX's /etc/couchside/config.json. With no box there is no agent
 * and no config file, so the phone has to own the device record itself.
 *
 * WHY A TV IS NOT A `Box`. Reusing lib/settings.ts's Box would be one field
 * cheaper and wrong: every Box consumer polls /api/status, opens /ws/gamepad,
 * syncs caps and expects a bearer token. A TV answers none of that, so a TV
 * masquerading as a Box would produce a fleet entry that is permanently
 * "unreachable" while working fine. Separate store, separate type.
 *
 * Import-free for the same reason lib/lanIp.ts is: this file holds the
 * validation that decides what the app will send commands to, and the bare-Node
 * test runner cannot load anything that imports react-native.
 */

import { isValidLanIp } from '../lanIp.ts';

/** Brands the app can drive DIRECTLY (no box). Still short of the agent's list:
 *  webos/samsung/vidaa need TLS work of their own and are absent here rather
 *  than listed-and-broken. `androidtv` covers Google TV and Android TV sets. */
export const DIRECT_BRANDS = ['roku', 'androidtv', 'webos'] as const;
export type DirectBrand = (typeof DIRECT_BRANDS)[number];

/**
 * Credentials for a paired LG webOS TV. Absent on Roku. `caPem` is the TV's own
 * self-signed cert, pinned on every connect (react-native-tcp-socket has no
 * accept-any mode); `clientKey` is the token the TV returned when the user
 * approved the on-screen prompt, and makes later connects silent.
 */
export type WebosCreds = {
  /** The TV's own cert, if captured, to PIN later connects. Optional: the
   *  connection accepts a self-signed peer without it (see atvnative.tlsTrust). */
  caPem?: string;
  clientKey: string;
};

/**
 * Credentials for a paired Android TV. Absent on Roku, which needs none (its
 * ECP is unauthenticated).
 *
 * `caPem` is OPTIONAL: the TV's own certificate, if captured, to PIN later
 * connections. Without it the connection accepts the self-signed peer directly
 * (atvnative.tlsTrust). An earlier design made it REQUIRED and fetched it before
 * connecting, which is what made every pairing fail on device.
 */
export type AtvCreds = {
  certPem: string;
  keyPem: string;
  modulusHex: string;
  caPem?: string;
};

export type DirectTv = {
  /** Stable id within the list ('tv-N'). */
  id: string;
  /** User-facing name, defaulted from the TV's own device-info. */
  name: string;
  brand: DirectBrand;
  /** LAN IPv4 literal. Names are refused — see isValidLanIp. */
  host: string;
  /** Android TV only. A record without these cannot be driven, so normalizeTv
   *  DROPS an androidtv entry that lacks them rather than keeping a TV whose
   *  every keypress would fail. */
  atv?: AtvCreds;
  /** LG webOS only. Same rule: a webos entry without creds is dropped. */
  webos?: WebosCreds;
};

export type DirectTvState = {
  tvs: DirectTv[];
  activeTvId: string | null;
};

export const EMPTY_TV_STATE: DirectTvState = { tvs: [], activeTvId: null };

/**
 * Accept a host for a direct TV connection.
 *
 * IP literals in LAN space only, reusing the KI-033-hardened gate rather than
 * writing a second address rule. Hostnames are refused deliberately: what a name
 * resolves to is decided by whoever answers DNS, and the whole promise of this
 * mode is that the phone only ever talks to something on the local network.
 * A user with a TV on a name can type its IP; a TV that only has a name is a
 * case we have not proven, and refusing is the closed direction.
 */
export function isValidTvHost(v: unknown): v is string {
  return typeof v === 'string' && isValidLanIp(v);
}

function isBrand(v: unknown): v is DirectBrand {
  return typeof v === 'string' && (DIRECT_BRANDS as readonly string[]).includes(v);
}

/**
 * Coerce one persisted entry, or null if it cannot be trusted.
 *
 * Drops rather than repairs: an entry with a bad host is a command destination
 * we cannot vouch for, and the repo rule is reject-don't-sanitise. A missing
 * name is cosmetic, so that one is defaulted.
 */
export function normalizeTv(raw: unknown): DirectTv | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.id !== 'string' || o.id.length === 0) return null;
  if (!isBrand(o.brand)) return null;
  if (!isValidTvHost(o.host)) return null;
  const name =
    typeof o.name === 'string' && o.name.trim().length > 0 ? o.name.trim() : o.host;
  const tv: DirectTv = { id: o.id, name, brand: o.brand, host: o.host };
  if (o.brand === 'androidtv') {
    // An Android TV without credentials cannot be driven at all — every key
    // would fail on a TLS handshake. Keeping such a record would put a dead
    // device in the picker, so it is dropped like a bad host is.
    const creds = normalizeAtvCreds(o.atv);
    if (!creds) return null;
    tv.atv = creds;
  }
  if (o.brand === 'webos') {
    const creds = normalizeWebosCreds(o.webos);
    if (!creds) return null;
    tv.webos = creds;
  }
  return tv;
}

function normalizeWebosCreds(raw: unknown): WebosCreds | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  // The client-key is what makes a reconnect silent, so it is REQUIRED; the
  // pinned cert is an optional hardening and its absence must not drop the TV.
  const clientKey = typeof o.clientKey === 'string' && o.clientKey.length > 0 ? o.clientKey : null;
  if (!clientKey) return null;
  const caPem = typeof o.caPem === 'string' && o.caPem.includes('BEGIN CERTIFICATE') ? o.caPem : undefined;
  return caPem ? { caPem, clientKey } : { clientKey };
}

function normalizeAtvCreds(raw: unknown): AtvCreds | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const pem = (v: unknown, marker: string) =>
    typeof v === 'string' && v.includes(marker) ? v : null;
  const certPem = pem(o.certPem, 'BEGIN CERTIFICATE');
  const keyPem = pem(o.keyPem, 'PRIVATE KEY');
  const modulusHex =
    typeof o.modulusHex === 'string' && /^[0-9a-f]+$/i.test(o.modulusHex)
      ? o.modulusHex.toLowerCase()
      : null;
  // Our own cert/key/modulus are REQUIRED (without them no connection can be
  // made); the TV's pinned cert is optional hardening.
  if (!certPem || !keyPem || !modulusHex) return null;
  const caPem = pem(o.caPem, 'BEGIN CERTIFICATE') ?? undefined;
  return caPem ? { certPem, keyPem, caPem, modulusHex } : { certPem, keyPem, modulusHex };
}

/** Coerce a whole persisted blob. Never throws; an unusable blob yields empty. */
export function normalizeTvState(raw: unknown): DirectTvState {
  if (!raw || typeof raw !== 'object') return EMPTY_TV_STATE;
  const o = raw as Record<string, unknown>;
  const list = Array.isArray(o.tvs) ? o.tvs : [];
  const tvs: DirectTv[] = [];
  for (const entry of list) {
    const tv = normalizeTv(entry);
    // Dedupe on brand+host: the same TV added twice is one device, and two
    // entries would make the active-id pointer ambiguous.
    if (tv && !tvs.some((t) => t.brand === tv.brand && t.host === tv.host)) tvs.push(tv);
  }
  const wanted = typeof o.activeTvId === 'string' ? o.activeTvId : null;
  // A dangling active id falls back to the first TV rather than to null: the
  // remote screen with a list of TVs and none selected is a dead end.
  const activeTvId = tvs.some((t) => t.id === wanted) ? wanted : (tvs[0]?.id ?? null);
  return { tvs, activeTvId };
}

/** Next free id for a list. Counter-free so it is a pure function of the list. */
export function nextTvId(tvs: DirectTv[]): string {
  let n = 0;
  for (const t of tvs) {
    const m = /^tv-(\d+)$/.exec(t.id);
    if (m) {
      const v = Number(m[1]);
      if (Number.isFinite(v) && v >= n) n = v + 1;
    }
  }
  return `tv-${n}`;
}

/** The active TV, or null. */
export function activeTv(state: DirectTvState): DirectTv | null {
  return state.tvs.find((t) => t.id === state.activeTvId) ?? null;
}
