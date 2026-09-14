/**
 * Network-throughput formatting for the Console VITALS strip.
 *
 * In its own testable module (not inline in index.tsx) for the KI-056 reason
 * baked into lib/downloadSize.ts: the install-free test glob does not reach
 * screen files, and a rate the agent reports honestly must not be able to
 * render as a lie without a test catching it.
 *
 * Bytes/sec in, a short human string out, decimal units (÷1000) to match the
 * downloads card and Steam's own convention. Kept to ~5 chars so two of these
 * (down + up) fit one line on a 360-375pt phone.
 */

/** A byte-rate as a compact string: "0/s", "340K/s", "12.4M/s", "1.1G/s".
 *  Non-finite or negative input degrades to "0/s" rather than "NaN/s". */
export function fmtRate(bps: number): string {
  if (!Number.isFinite(bps) || bps <= 0) return '0/s';
  if (bps < 1e3) return `${Math.round(bps)}B/s`;
  if (bps < 1e6) return `${Math.round(bps / 1e3)}K/s`;
  if (bps < 1e9) return `${(bps / 1e6).toFixed(1)}M/s`;
  return `${(bps / 1e9).toFixed(1)}G/s`;
}
