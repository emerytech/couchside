/**
 * How large a binary response from a box is allowed to be. ZERO runtime imports,
 * so the rule is unit-testable on bare Node like lib/lanIp.ts.
 *
 * WHY (KI-035). `mediaArtSource` and `screenFrameSource` both did
 * `await res.arrayBuffer()` with no bound, then base64'd the result into a
 * `data:` URI. A box that returns hundreds of megabytes — hostile, wedged, or
 * just a capture tool gone wrong — is buffered whole into the phone's memory and
 * then amplified ~1.33x by the base64 encode. The screen preview POLLS, so it
 * gets a fresh chance every frame.
 *
 * These are small things by nature: a measured screen frame is ~100-400 KB and
 * album art is smaller still. 8 MB is ~20x the largest thing we expect, so it
 * cannot reject a legitimate frame, while still bounding the damage.
 *
 * WHAT THIS DOES NOT DO, stated plainly: React Native's fetch is the whatwg-fetch
 * polyfill, whose `response.body` is not a readable stream, so a body cannot be
 * aborted part-way from JS. When a server sends no `Content-Length`, or lies
 * about it, the bytes are already buffered by the time we can measure them. The
 * post-read check still prevents the base64 amplification and stops a giant
 * string reaching <Image>, but the initial buffer is not preventable here — a
 * true streaming cap needs a native fetch replacement. The agent does send
 * Content-Length, so the pre-check is the live path in practice.
 */

/** Largest binary body accepted from a box (8 MB). */
export const MAX_BINARY_BYTES = 8 * 1024 * 1024;

/**
 * Should a response be refused based on its declared Content-Length?
 *
 * Checked BEFORE reading the body, which is the only point where refusing
 * actually avoids buffering the bytes. An absent, empty, or unparseable header
 * returns false — "unknown" is not "too big", and refusing every response
 * without a Content-Length would break any box that omits it. The post-read
 * size check is what covers that case.
 */
export function isDeclaredTooLarge(
  contentLength: string | null | undefined,
  cap: number = MAX_BINARY_BYTES,
): boolean {
  if (contentLength == null) return false;
  const s = String(contentLength).trim();
  if (!s) return false;
  // Exactly digits: a negative, fractional, or junk value is not a size we can
  // reason about, so it falls through to the post-read check.
  if (!/^\d+$/.test(s)) return false;
  const n = Number(s);
  if (!Number.isFinite(n)) return false;
  return n > cap;
}

/**
 * Is a body we have already read an acceptable size to encode and render?
 *
 * Rejects empty (nothing to show — the callers already treated 0 as "no art")
 * and anything over the cap, which is the backstop for a missing or dishonest
 * Content-Length.
 */
export function isUsableBodySize(
  byteLength: number,
  cap: number = MAX_BINARY_BYTES,
): boolean {
  if (!Number.isFinite(byteLength)) return false;
  return byteLength > 0 && byteLength <= cap;
}
