/**
 * Decide whether an outside string is a Couchside pairing link — and refuse
 * everything else. This is the ONLY place a string from outside the app is
 * allowed to become a bearer-token destination.
 *
 * A pairing link says "trust this host, and send it this credential". The app
 * then opens a WebSocket to it, polls it forever, and will upload a user-picked
 * file to it. So a hostile QR sticker is not a cosmetic problem: it re-points a
 * LAN-only, no-cloud app at somebody's server. Every rule below exists to make
 * the set of reachable destinations enumerable.
 *
 * TWO CALLERS, ONE VALIDATOR. The in-app scanner and the inbound deep-link
 * handler (lib/DeepLink.tsx) both go through here. If the scanner were the
 * stricter of the two, an attacker would simply use a link instead of a QR and
 * the work would be worthless. `forms` is a REQUIRED argument, so each call
 * site has to state its accept surface out loud.
 *
 * NO `new URL()` — DELIBERATE, AND LOAD-BEARING. React Native replaces the
 * global URL with a regex shim (`polyfillGlobal('URL', ...)` in
 * react-native/Libraries/Core/setUpXHR.js -> Libraries/Blob/URL.js). Measured
 * on RN 0.86, that shim disagrees with the Node WHATWG URL the test runner
 * uses, in the accept direction:
 *   - `new URL('WIFI:S=home;T=WPA;;#x')` THROWS TypeError in the shim (it does
 *     `beforeHash.split('://')[1].includes('/')` on an undefined) and parses
 *     fine in Node. That is a plain-text QR — the most likely thing a user
 *     points this at by accident.
 *   - `.hash` is `/#([^/]*)/`, so a fragment value containing '/' truncates the
 *     rest away on device and keeps it in Node (`&ip=` silently vanishes).
 *   - `https://couchside.tv\@evil.com/pair` parses as host `evil.com` in the
 *     shim and host `couchside.tv` + path `/@evil.com/pair` in Node.
 * A rule written against Node's URL is therefore verified against a parser the
 * app does not run. Everything here is plain string work with identical
 * behaviour in Hermes and in bare Node, so the tests test the shipped code.
 *
 * Reject, never repair (CLAUDE.md §3.6). A malformed field means this is not
 * our code; nothing is defaulted into validity.
 *
 * ONE import, and only from another zero-import module: the LAN-IPv4 range
 * rule lives in lib/lanIp.ts (it also guards the lastIp persist path — KI-033),
 * so the octal-octet rejection exists in exactly one place. The `.ts` extension
 * on the specifier is required by the bare-Node test runner and is already the
 * repo's convention in lib/__tests__/.
 */
import { isValidLanIp } from './lanIp.ts';

/** Which producer's format a caller is willing to accept. */
export type PairLinkForm = 'https-pair' | 'couchside-setup';

/**
 * The frozen base table. A client string is compared for EQUALITY against
 * these — never prefix-matched, never regex-matched against the origin. That
 * is what kills `couchside.tv.evil.com`, `couchside.tv@evil.com`,
 * `evil.com/?x=couchside.tv` and the backslash variants in one stroke: none of
 * them produce a base that equals an entry.
 *
 * Extended only by adding an explicit entry (CLAUDE.md §3.3).
 */
const FORM_BASES: Readonly<Record<PairLinkForm, readonly string[]>> = Object.freeze({
  // The QR on the box's own /pair page (agent build_pair_url) and in the app's
  // SHOW QR modal (setup.tsx). Params ride the FRAGMENT so the token is never
  // sent to couchside.tv.
  'https-pair': Object.freeze(['https://couchside.tv/pair', 'https://couchside.tv/pair/']),
  // What the couchside.tv/pair page bounces the phone to, and what
  // agent/show-qr.sh prints. Params ride the QUERY.
  'couchside-setup': Object.freeze(['couchside://setup']),
});

/** Where each form keeps its params: everything right of this separator. */
const FORM_SEP: Readonly<Record<PairLinkForm, '#' | '?'>> = Object.freeze({
  'https-pair': '#',
  'couchside-setup': '?',
});

/** A QR scanner accepts only what our two QR producers actually emit. */
export const SCAN_FORMS: readonly PairLinkForm[] = Object.freeze(['https-pair'] as const);

/** The deep-link handler additionally accepts the scheme URL it is sent. */
export const DEEPLINK_FORMS: readonly PairLinkForm[] = Object.freeze([
  'https-pair',
  'couchside-setup',
] as const);

/**
 * The OTHER QR on the box's pairing screen: an install/store link, drawn right
 * next to the pairing code. Catching it is the single most likely honest
 * mistake, so it gets its own reason rather than "not a Couchside code".
 *
 * BOTH forms are listed because a box updates on its own schedule: agents
 * before 2.9.61 encode the old marketing-page anchor, newer ones encode the
 * dedicated /get/ page. A phone on the current app will meet both for as long
 * as un-updated boxes exist, and the friendly answer should not depend on which
 * one it happens to be looking at. Exact strings from the agent's
 * `json.dumps(...)` — keep in sync with couchsided.py's `get_js`.
 */
const STORE_CODES: readonly string[] = Object.freeze([
  'https://couchside.tv/get/',
  'https://couchside.tv/#get',
]);

/** Hostname suffixes a pairing link may carry. Frozen; explicit entries only. */
const HOST_SUFFIXES: readonly string[] = Object.freeze(['.local']);

/** Longer than any real payload (~145 chars); refuses a QR built to be a bomb. */
const MAX_RAW_LEN = 2048;

/** RFC-1123 label. Case is PRESERVED downstream — see hostShapeOk. */
const LABEL_RE = /^[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/;

/** Printable ASCII, no space, no controls. */
const TOKEN_RE = /^[\x21-\x7e]+$/;

const TOKEN_MIN = 8;
const TOKEN_MAX = 256;

export type PairLink = {
  /** mDNS name or private IPv4 literal. Stored verbatim (see hostShapeOk). */
  host: string;
  port: number;
  token: string;
  /** Optional cached LAN IP fallback. Absent when the link omitted or failed it. */
  ip?: string;
};

/**
 * Why a string was refused. The screen maps these to copy; the raw payload is
 * never echoed back to the user (it carries a live credential).
 */
export type PairRejectReason =
  | 'empty'
  | 'too-long'
  | 'store-code'
  | 'not-pair-link'
  | 'duplicate-param'
  | 'missing-host'
  | 'bad-host'
  | 'missing-token'
  | 'bad-token'
  | 'bad-port';

export type PairLinkResult =
  | { ok: true; link: PairLink }
  | { ok: false; reason: PairRejectReason };

const rej = (reason: PairRejectReason): PairLinkResult => ({ ok: false, reason });

/**
 * Single-decode each param value, exactly like lib/DeepLink.tsx's parseQuery:
 * URLSearchParams + decodeURIComponent double-decodes and mangles any value
 * containing '%', which a hand-set token may legitimately have.
 *
 * Returns null on a REPEATED key. No producer emits duplicates, and accepting
 * them means the app and any other parser can disagree about which value wins
 * (`token=good&token=evil`). Null-prototype map, so `__proto__=` is inert.
 */
function parseParams(qs: string): Record<string, string> | null {
  const out: Record<string, string> = Object.create(null);
  if (!qs) return out;
  for (const piece of qs.split('&')) {
    if (!piece) continue;
    const eq = piece.indexOf('=');
    const rawKey = eq < 0 ? piece : piece.slice(0, eq);
    const rawVal = eq < 0 ? '' : piece.slice(eq + 1);
    let key = rawKey;
    let val = rawVal;
    try {
      key = decodeURIComponent(rawKey);
    } catch {
      /* keep raw key */
    }
    try {
      val = decodeURIComponent(rawVal);
    } catch {
      /* keep raw value */
    }
    if (Object.prototype.hasOwnProperty.call(out, key)) return null;
    out[key] = val;
  }
  return out;
}

/**
 * A dotted-quad IPv4 in LAN space. Range + octal-octet rules live in
 * lib/lanIp.ts (one gate, one corpus — KI-033); this only adds the loopback
 * policy: false for `host` (the box never emits 127/8 — a link aiming the app
 * at the PHONE'S own loopback has no legitimate producer) and true for `ip`,
 * which matches the shipped isValidLanIp behaviour that addBox already applies.
 */
function isLanIpv4(v: string, allowLoopback: boolean): boolean {
  if (!isValidLanIp(v)) return false;
  return allowLoopback || !v.startsWith('127.');
}

/**
 * Is `host` a destination this app is allowed to send a bearer token to?
 *
 * Accepts exactly three shapes:
 *   1. A private IPv4 literal (isLanIpv4, loopback excluded).
 *   2. A SINGLE label with no dot ("steamdeck"). agent/show-qr.sh builds its
 *      URL from whatever the user typed after `ssh`, so a bare label is a
 *      shipped producer. A name with no dot has no public suffix and cannot
 *      address the internet on its own; the residual risk is a hostile DNS
 *      search domain, which already implies a compromised LAN.
 *   3. A multi-label name whose LOWERCASED form ends in an allowlisted suffix
 *      (.local). This is what the agent emits.
 *
 * Everything else is refused, including every IPv6 form. IPv6 is not a
 * conservatism: lib/gamepad.ts builds `ws://${host}:${port}` with no bracket
 * handling, so a v6 literal makes a malformed URL. Accepting it would ship a
 * rule we cannot honour. `::ffff:1.2.3.4` in particular is refused outright
 * rather than unwrapped-and-rechecked — unwrapping is how that bypass lands.
 *
 * Case is checked but NOT folded. Hostnames are case-insensitive, but
 * SettingsContext.addBox dedupes on an exact host string, so folding here
 * would file a second row for a box the LAN-scan path stored with its original
 * casing. See KNOWN_ISSUES for the dedupe hazard itself.
 */
export function isAllowedPairHost(host: string): boolean {
  return hostShapeOk(host);
}

function hostShapeOk(host: string): boolean {
  if (!host || host.length > 253) return false;
  // Explicit refusals first, so the intent is auditable rather than implied by
  // the label regex: userinfo, ports, paths, IPv6 brackets, escapes, spaces.
  if (/[:/\\@?#%_[\]\s]/.test(host)) return false;
  if (isLanIpv4(host, false)) return true;
  // A dotted-quad-shaped string that failed the LAN test must not fall through
  // to the hostname branch and get accepted as a "name" (1.2.3.4 has valid
  // labels). Any all-numeric final label means it was meant as an address.
  const labels = host.split('.');
  if (labels.some((l) => !LABEL_RE.test(l))) return false;
  if (/^\d+$/.test(labels[labels.length - 1])) return false;
  if (labels.length === 1) {
    // A single label must not be an ADDRESS IN DISGUISE. The all-digits rule
    // above already refuses the 32-bit integer form (134744072 -> 8.8.8.8),
    // but the C resolver also reads HEX literals as addresses. MEASURED
    // 2026-07-27 through plain getaddrinfo — the ordinary path every fetch and
    // WebSocket takes — with controls in the same run:
    //
    //     0x08080808  -> 8.8.8.8            PUBLIC
    //     0xdeadbeef  -> 222.173.190.239    PUBLIC
    //     0X8         -> 0.0.0.8
    //     steamdeck   -> does not resolve   <- control: a real name is not an address
    //     bazzite     -> does not resolve   <- control
    //     10.0.0.1    -> 10.0.0.1           <- control
    //
    // So `#host=0x08080808` would walk a bare-label allowlist straight to
    // 8.8.8.8 with the bearer token. Refuse the hex shape, and require at
    // least one letter that is not part of a 0x prefix so nothing
    // number-parseable survives as a "name".
    if (/^0x[0-9a-f]*$/i.test(host)) return false;
    return /[a-z]/i.test(host.replace(/^0x/i, ''));
  }
  const lower = host.toLowerCase();
  return HOST_SUFFIXES.some((s) => lower.endsWith(s));
}

/**
 * Parse and validate. Returns the link, or the reason it was refused.
 *
 * `defaultPort` is passed in rather than imported so this file keeps ZERO
 * imports and runs under the bare-Node test runner CI already uses. It also
 * means DEFAULT_PORT stays defined once, in lib/settings.ts, instead of being
 * copied here to drift.
 */
export function parsePairLink(
  raw: string,
  opts: { forms: readonly PairLinkForm[]; defaultPort: number },
): PairLinkResult {
  if (typeof raw !== 'string') return rej('not-pair-link');
  const text = raw.trim();
  if (!text) return rej('empty');
  if (text.length > MAX_RAW_LEN) return rej('too-long');
  if (STORE_CODES.includes(text)) return rej('store-code');

  let params: Record<string, string> | null | undefined;
  for (const form of opts.forms) {
    const sep = FORM_SEP[form];
    const bases = FORM_BASES[form];
    if (!sep || !bases) continue; // not a known form name — ignored, never trusted
    const at = text.indexOf(sep);
    const base = (at < 0 ? text : text.slice(0, at)).toLowerCase();
    // Scheme and host are case-insensitive by RFC, and Android hands the
    // scheme back lowercased while iOS does not. Folding the base cannot
    // invent a new origin; it only removes a platform-dependent mismatch.
    if (!bases.includes(base)) continue;
    params = parseParams(at < 0 ? '' : text.slice(at + 1));
    break;
  }
  if (params === undefined) return rej('not-pair-link');
  if (params === null) return rej('duplicate-param');

  const host = (params.host ?? '').trim();
  if (!host) return rej('missing-host');
  if (!hostShapeOk(host)) return rej('bad-host');

  const token = params.token ?? '';
  if (!token) return rej('missing-token');
  if (token.length < TOKEN_MIN || token.length > TOKEN_MAX || !TOKEN_RE.test(token)) {
    // Deliberately NOT /^[0-9a-f]{48}$/. That is what install.sh mints, but the
    // agent's --token accepts a literal and pre-Couchside tokens were migrated
    // forward; tightening this would refuse legitimately configured boxes.
    return rej('bad-token');
  }

  // Absent is fine (the box's port is 8787 by default). Malformed is NOT
  // silently defaulted the way DeepLink.tsx does today: a QR is machine-
  // generated, so a broken port means this is not our code.
  let port = opts.defaultPort;
  const rawPort = params.port ?? '';
  if (rawPort) {
    if (!/^[0-9]{1,5}$/.test(rawPort)) return rej('bad-port');
    port = Number(rawPort);
    if (port < 1 || port > 65535) return rej('bad-port');
  }

  // `ip` is only a fallback route to a host we already validated, so a bad one
  // is DROPPED rather than fatal — matching what addBox already does with it.
  const rawIp = (params.ip ?? '').trim();
  const ip = rawIp && isLanIpv4(rawIp, true) ? rawIp : undefined;

  // Unknown params are ignored, not fatal: they cannot reach anything, and
  // refusing them would break forward compatibility with a newer agent.
  return { ok: true, link: { host, port, token, ip } };
}

/**
 * What accepting this link would DO to the stored fleet.
 *
 * Matching mirrors SettingsContext's sameTarget (exact host string + port —
 * NOT case-folded, because addBox dedupes on the exact string). The
 * distinction that matters is `token-change`: addBox silently overwrites the
 * stored token for a matched box, so a hostile QR for a host the user already
 * owns would swap their working credential for the attacker's and the box
 * would just go "offline". The scanner asks first; same-token and brand-new
 * links have nothing to defend.
 */
export function pairCollision(
  boxes: readonly { host: string; port: number; token: string; name: string }[],
  link: PairLink,
): { kind: 'new' } | { kind: 'same-token'; name: string } | { kind: 'token-change'; name: string } {
  const hit = boxes.find((b) => b.host === link.host && b.port === link.port);
  if (!hit) return { kind: 'new' };
  if (hit.token === link.token) return { kind: 'same-token', name: hit.name };
  return { kind: 'token-change', name: hit.name };
}

/**
 * Build the pairing link the QR encodes — or return NULL for a box whose link
 * parsePairLink would refuse. Kept here so the writer and the reader sit in
 * one file — the format used to be stated in four places and parsed in none.
 * Mirrors agent build_pair_url() byte for byte.
 *
 * The null return is the symmetry that makes the pair provable: the app can
 * never render a QR its own scanner rejects (degrade closed, §3.7). A test
 * round-trips every accepted build back through parsePairLink, and asserts
 * that a box the reader would refuse builds nothing at all.
 */
export function buildPairLink(box: {
  host: string;
  port: number;
  token: string;
  lastIp?: string;
}): string | null {
  const host = (box.host ?? '').trim();
  if (!hostShapeOk(host)) return null;
  if (!Number.isInteger(box.port) || box.port < 1 || box.port > 65535) return null;
  const token = box.token ?? '';
  if (token.length < TOKEN_MIN || token.length > TOKEN_MAX || !TOKEN_RE.test(token)) return null;
  let q =
    `host=${encodeURIComponent(host)}` +
    `&port=${encodeURIComponent(String(box.port))}` +
    `&token=${encodeURIComponent(token)}`;
  // A lastIp that would not survive the reader is dropped, not fatal — same
  // policy as the reader's own ip handling.
  if (box.lastIp && isLanIpv4(box.lastIp, true)) q += `&ip=${encodeURIComponent(box.lastIp)}`;
  const url = `https://couchside.tv/pair#${q}`;
  return url.length > MAX_RAW_LEN ? null : url;
}
