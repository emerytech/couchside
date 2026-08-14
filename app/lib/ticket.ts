/**
 * Short-lived TLS tickets for the un-pinnable native loaders (TLS P5).
 *
 * The app pins its own socket for the API/WS, but the platform <Image> loader
 * (cover art) and the streamed file uploader cannot pin a self-signed cert. So on
 * a `secure` box the app mints a ticket over the ALREADY-PINNED channel (agent
 * POST /api/ticket) and passes it as ?ticket= on those requests — the real bearer
 * token never rides those cleartext URLs. A ticket grants only cover reads
 * (multi-use, short TTL) or one upload (single-use); it can't drive the box.
 *
 * Plaintext boxes keep ?token= (there is no TLS to protect anyway). Imports only
 * the fast-glob-safe boxTransport boundary — no native package at module load.
 */
import { pinnedRequest } from './boxTransport.ts';

type Conn = {
  host: string;
  port: number;
  token: string;
  secure?: boolean;
  tlsPort?: number;
  pinModulus?: string;
};

function canPin(c: Conn): c is Conn & { tlsPort: number; pinModulus: string } {
  return !!(c.secure && c.tlsPort && c.pinModulus);
}

const imageCache = new Map<string, { ticket: string; exp: number }>();
const inflight = new Set<string>();

const keyOf = (host: string, port: number): string => `${host}:${port}`;

/** The current valid multi-use image ticket for this box, or null. Synchronous —
 *  callers read it inline for an <Image> uri and fall back to the text card when
 *  it's null (the first ~second on a fresh secure box, before the mint lands). */
export function getImageTicket(host: string, port: number): string | null {
  const e = imageCache.get(keyOf(host, port));
  return e && e.exp > Date.now() ? e.ticket : null;
}

/** Keep a fresh multi-use image ticket warm for a secure box (fire-and-forget).
 *  No-ops when one is still valid (>1min left) or a mint is already in flight. */
export function ensureImageTicket(c: Conn, host: string): void {
  if (!canPin(c)) return;
  const k = keyOf(host, c.port);
  const e = imageCache.get(k);
  if (e && e.exp > Date.now() + 60_000) return;
  if (inflight.has(k)) return;
  inflight.add(k);
  pinnedRequest(host, c.tlsPort, c.pinModulus, { method: 'POST', path: '/api/ticket', token: c.token })
    .then((r) => {
      const j = JSON.parse(r.body || '{}');
      if (typeof j.ticket === 'string' && j.ticket) {
        const ttl = typeof j.ttl === 'number' ? j.ttl : 300;
        // Expire our copy 30s early so we never present a ticket the box just dropped.
        imageCache.set(k, { ticket: j.ticket, exp: Date.now() + ttl * 1000 - 30_000 });
      }
    })
    .catch(() => {})
    .finally(() => {
      inflight.delete(k);
    });
}

/** Mint a fresh SINGLE-USE upload ticket over the pinned channel. Null on failure
 *  (caller then degrades to the token header — a rare, single-request exposure). */
export async function mintUploadTicket(c: Conn, host: string): Promise<string | null> {
  if (!canPin(c)) return null;
  try {
    const r = await pinnedRequest(host, c.tlsPort, c.pinModulus, {
      method: 'POST',
      path: '/api/ticket?once=1',
      token: c.token,
    });
    const j = JSON.parse(r.body || '{}');
    return typeof j.ticket === 'string' && j.ticket ? j.ticket : null;
  } catch {
    return null;
  }
}
