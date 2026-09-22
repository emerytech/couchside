/**
 * Offline license-key verification for the DIRECT (off-store) edition.
 *
 * Pure and RN-free on purpose: no react-native / expo imports, so it runs under
 * `node --test` exactly as it runs in Hermes, and lib/entitlement.ts layers the
 * storage + entitlement wiring on top. Mirrors lib/purchaseErrors.ts (logic that
 * is tested standalone).
 *
 * The direct edition ships LOCKED. It unlocks only when the buyer pastes a key
 * signed by the private half of an Ed25519 keypair the maintainer holds offline
 * (scripts/make-license.mjs). This module has only the PUBLIC half and verifies
 * the signature with no network call. Therefore:
 *   - A leaked APK grants nothing: without a valid key it is just the trial.
 *   - A key cannot be forged without the offline private key.
 *   - Every key is stamped with the buyer's name (surfaced in-app) and a unique
 *     id, so a shared key is traceable to whoever it was issued to.
 *
 * This is a $4.99 one-time unlock, not a DRM fortress: the goal is to make
 * casual leaking pointless and shared keys attributable, not to stop a
 * determined cracker (who could patch any build, store or not).
 *
 * node-forge is already a dependency (TV certificate minting) and runs in
 * Hermes; its Ed25519 verify is pure JS.
 */
import forge from 'node-forge';
import { Buffer } from 'buffer';

/**
 * Raw 32-byte Ed25519 PUBLIC key, base64url. The private half is offline (see
 * scripts/make-license.mjs). Rotating this constant invalidates every key ever
 * issued for builds that shipped it, so it changes only with a keypair rollover.
 */
export const LICENSE_PUBLIC_KEY_B64URL = 'XxWSktkSVbF9GseRqnxYlE1RK71KwCT7-ZUjv64s3Yc';

/** Token shape: `CS1.<payload-b64url>.<signature-b64url>`. */
export const LICENSE_PREFIX = 'CS1';

export type LicensePayload = {
  v: 1;
  /** Buyer name, shown in-app ("Licensed to ..."). Always present. */
  name: string;
  /** Optional buyer email, for the maintainer's records. */
  email?: string;
  /** Issued-at, unix seconds. */
  iat: number;
  /** Short unique key id (maintainer records / future revocation list). */
  id: string;
  /** Edition tag, e.g. "direct". */
  edition?: string;
};

export type LicenseError = 'format' | 'signature' | 'payload';
export type LicenseResult =
  | { ok: true; payload: LicensePayload; raw: string }
  | { ok: false; error: LicenseError };

function fromB64url(s: string): Uint8Array {
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + pad;
  return new Uint8Array(Buffer.from(b64, 'base64'));
}

/** Trim and strip internal whitespace so a wrapped/pasted key still parses. */
export function normalizeLicenseKey(input: string): string {
  return input.trim().replace(/\s+/g, '');
}

/**
 * Verify a pasted license key entirely offline. The optional `pubKeyB64url`
 * override exists ONLY for tests (verify a throwaway-signed token without ever
 * committing a real production key to the repo); production always uses the
 * baked-in constant. Never throws: any malformed input degrades to a typed
 * error, and an unverifiable signature is a hard rejection.
 */
export function verifyLicenseKey(
  input: string,
  pubKeyB64url: string = LICENSE_PUBLIC_KEY_B64URL,
): LicenseResult {
  const raw = normalizeLicenseKey(input);
  const parts = raw.split('.');
  if (parts.length !== 3 || parts[0] !== LICENSE_PREFIX || !parts[1] || !parts[2]) {
    return { ok: false, error: 'format' };
  }
  let payloadBytes: Uint8Array;
  let sig: Uint8Array;
  let pub: Uint8Array;
  try {
    payloadBytes = fromB64url(parts[1]);
    sig = fromB64url(parts[2]);
    pub = fromB64url(pubKeyB64url);
  } catch {
    return { ok: false, error: 'format' };
  }
  if (sig.length !== 64 || pub.length !== 32 || payloadBytes.length === 0) {
    return { ok: false, error: 'format' };
  }

  let good = false;
  try {
    good = forge.pki.ed25519.verify({
      message: Buffer.from(payloadBytes),
      signature: Buffer.from(sig),
      publicKey: Buffer.from(pub),
    });
  } catch {
    good = false; // degrade closed: an unverifiable key never unlocks
  }
  if (!good) return { ok: false, error: 'signature' };

  let payload: LicensePayload;
  try {
    payload = JSON.parse(Buffer.from(payloadBytes).toString('utf8'));
  } catch {
    return { ok: false, error: 'payload' };
  }
  if (payload == null || payload.v !== 1 || typeof payload.name !== 'string' || payload.name.length === 0) {
    return { ok: false, error: 'payload' };
  }
  return { ok: true, payload, raw };
}
