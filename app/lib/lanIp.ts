/**
 * Is this string an IPv4 literal on the LAN? ZERO runtime imports.
 *
 * WHY IT IS ITS OWN FILE. This is a security control: it is the gate that stops
 * a value learned from an UNAUTHENTICATED source from becoming a destination we
 * send a bearer token to. It used to live in lib/settings.ts, which imports
 * react-native and expo-secure-store and therefore cannot be loaded by the bare
 * Node test runner this repo uses for pure modules — so the rule below shipped
 * with no test, and a hole sat in it (KI-033). Import-free so the corpus in
 * lib/__tests__/lanIp.test.ts can actually exercise it.
 *
 * THE HOLE, MEASURED 2026-07-27. The old pattern was `\d{1,3}` per octet, then
 * `Number()`. JS `Number()` is always decimal, so `Number('010')` is 10 and
 * `010.1.1.5` was read as 10.x.x.x — private, accepted. Every OS resolver reads
 * a leading zero as OCTAL (inet_aton), so that same string resolves to
 * 8.1.1.5 — a PUBLIC address. With controls in both directions:
 *
 *     input          this function   inet_aton resolves to
 *     10.1.1.5       accept          10.1.1.5     <- control, correct accept
 *     8.1.1.5        reject          8.1.1.5      <- control, correct reject
 *     010.1.1.5      WAS accept      8.1.1.5      <- the escape, now rejected
 *
 * The rule is therefore: an octet is a bare `0`, or 1-3 digits not starting
 * with `0`. Never widen this back to `\d{1,3}`; the length cap alone only
 * catches the four-digit forms like `0177`.
 */

/** An octet: a single 0, or 1-3 digits with no leading zero. */
const OCTET = '(0|[1-9]\\d{0,2})';
const IPV4 = new RegExp(`^${OCTET}\\.${OCTET}\\.${OCTET}\\.${OCTET}$`);

/**
 * True for an IPv4 literal in private / loopback / link-local / CGNAT space.
 *
 * Rejects public addresses and rejects hostnames outright — a name is not
 * checkable here, since what it resolves to is up to whoever answers DNS.
 * IPv6 is intentionally unsupported: returning false for it is the closed
 * direction, so an IPv6 literal is simply never accepted as a fallback.
 */
export function isValidLanIp(v: string): boolean {
  if (typeof v !== 'string') return false;
  const m = IPV4.exec(v);
  if (!m) return false;
  const [a, b, c, d] = m.slice(1).map(Number);
  if (a > 255 || b > 255 || c > 255 || d > 255) return false;
  if (a === 10 || a === 127) return true;
  if (a === 192 && b === 168) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 169 && b === 254) return true; // link-local
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT (Tailscale lives here)
  return false;
}
