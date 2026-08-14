/**
 * Pure codec for the pinned-TLS transport (TLS P5) — NO forge / native imports, so
 * it runs in CI's install-free fast test glob (`lib/__tests__/*.test.ts`), exactly
 * like lib/tvdirect/atvcrypto.ts is split from the native atvnative.ts.
 *
 * Holds the two pieces whose failures are SILENT and therefore must be tested:
 *  - modulus NORMALIZE (not derive — that needs forge, so it lives in boxTls.ts):
 *    getPeerCertificate and node-forge format the modulus differently, so a bad
 *    normalize makes the pin compare in boxTls.connectPinned either always-fail
 *    (locks the user out of their own box) or always-pass (defeats the pin).
 *  - the HTTP/1.1 response parser: a mis-parse silently corrupts every box reply.
 *
 * `buffer` here is Node's built-in module (resolves without npm install).
 */
import { Buffer } from 'buffer';

/**
 * Normalize an RSA modulus hex string for comparison. getPeerCertificate (native)
 * and node-forge format differently — colons, `0x`, case, a leading DER sign byte
 * — so BOTH sides run through this before an equality check.
 */
export function normalizeModulus(v?: string | null): string | null {
  if (!v) return null;
  let h = v.toLowerCase().replace(/[^0-9a-f]/g, '');
  // Leading zeros are never significant in a big-integer hex: node-forge's
  // n.toString(16) emits none, while a DER INTEGER prepends a 00 sign byte for a
  // high-bit-set modulus (every RSA-2048 key). Strip all so both sides match.
  h = h.replace(/^0+/, '');
  return h || null;
}

export type PinnedResponse = {
  status: number;
  headers: Record<string, string>;
  /** Body decoded as UTF-8 (the box control API is JSON). */
  body: string;
  /** Raw body bytes — for binary responses (cover art, screen frames). */
  bodyBytes: Uint8Array;
};

/**
 * Parse a raw HTTP/1.1 response buffer into status + headers + body. Returns null
 * if the header terminator (CRLFCRLF) has not arrived yet. Body is decoded UTF-8
 * (the box API is JSON); header bytes are treated as latin1 so the CRLF scan is
 * byte-exact regardless of any UTF-8 in the body.
 */
export function parseHttpResponse(raw: Uint8Array): PinnedResponse | null {
  const head = Buffer.from(raw).toString('latin1');
  const sep = head.indexOf('\r\n\r\n');
  if (sep < 0) return null;
  const lines = head.slice(0, sep).split('\r\n');
  const status = parseInt((lines[0] || '').split(' ')[1] || '0', 10);
  const headers: Record<string, string> = {};
  for (let i = 1; i < lines.length; i++) {
    const idx = lines[i].indexOf(':');
    if (idx > 0) headers[lines[i].slice(0, idx).trim().toLowerCase()] = lines[i].slice(idx + 1).trim();
  }
  const bodyBytes = raw.subarray(sep + 4);
  const body = Buffer.from(bodyBytes).toString('utf8');
  return { status, headers, body, bodyBytes };
}
