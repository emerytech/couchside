/**
 * License-key verification (app/lib/license.ts).
 *
 * Proves the exact thing that would otherwise only be assumed: a key SIGNED by
 * the offline tool (scripts/make-license.mjs uses node's crypto Ed25519) VERIFIES
 * inside the app (license.ts uses node-forge's Ed25519). Both are RFC 8032, but
 * "both are standard" is a claim; this test is the evidence — sign with node
 * crypto here, verify through the real app code path.
 *
 * The keys signed here come from a THROWAWAY keypair minted in-process. The
 * production private key is offline and never in CI, and no real redeemable key
 * is ever committed to this public repo. The production PUBLIC key baked into
 * license.ts is exercised too: it must be a well-formed 32-byte Ed25519 key, and
 * it must REJECT a throwaway-signed token (so the default path is truly bound to
 * the real key, not accidentally accepting anything).
 */
import { test } from 'node:test';
import assert from 'node:assert';
import crypto from 'node:crypto';

import {
  verifyLicenseKey,
  normalizeLicenseKey,
  LICENSE_PREFIX,
  LICENSE_PUBLIC_KEY_B64URL,
} from '../../license.ts';

function b64url(buf: Buffer | Uint8Array): string {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function pubB64url(pub: crypto.KeyObject): string {
  return (pub.export({ format: 'jwk' }) as { x: string }).x;
}
function mint(priv: crypto.KeyObject, payload: unknown): string {
  const payloadBytes = Buffer.from(JSON.stringify(payload), 'utf8');
  const sig = crypto.sign(null, payloadBytes, priv);
  return `${LICENSE_PREFIX}.${b64url(payloadBytes)}.${b64url(sig)}`;
}

// Throwaway signing keypair — NOT the production key.
const kp = crypto.generateKeyPairSync('ed25519');
const PUB = pubB64url(kp.publicKey);
const goodPayload = { v: 1, name: 'Samuel P.', email: 's@example.com', iat: 1758000000, id: 'a1b2c3d4', edition: 'direct' };

test('a validly signed key verifies (node crypto sign -> node-forge verify interop)', () => {
  const token = mint(kp.privateKey, goodPayload);
  const r = verifyLicenseKey(token, PUB);
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.payload.name, 'Samuel P.');
    assert.equal(r.payload.id, 'a1b2c3d4');
    assert.equal(r.payload.edition, 'direct');
  }
});

test('a whitespace-wrapped paste still verifies', () => {
  const token = mint(kp.privateKey, goodPayload);
  const wrapped = token.slice(0, 20) + '\n  ' + token.slice(20);
  assert.equal(verifyLicenseKey(wrapped, PUB).ok, true);
  assert.equal(normalizeLicenseKey('  a b\nc '), 'abc');
});

test('a tampered payload is rejected (signature error)', () => {
  const token = mint(kp.privateKey, goodPayload);
  const [, p, s] = token.split('.');
  const bytes = Buffer.from(p.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  bytes[0] ^= 0x01;
  const tampered = `${LICENSE_PREFIX}.${b64url(bytes)}.${s}`;
  const r = verifyLicenseKey(tampered, PUB);
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.error, 'signature');
});

test('a signature from a different key is rejected', () => {
  const other = crypto.generateKeyPairSync('ed25519');
  const token = mint(other.privateKey, goodPayload); // signed by the wrong key
  const r = verifyLicenseKey(token, PUB);
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.error, 'signature');
});

test('the production public key REJECTS a throwaway-signed token', () => {
  // The default code path (no pubkey override) must be bound to the real key.
  const token = mint(kp.privateKey, goodPayload);
  const r = verifyLicenseKey(token); // uses LICENSE_PUBLIC_KEY_B64URL
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.error, 'signature');
});

test('the baked-in production public key is a well-formed 32-byte Ed25519 key', () => {
  const pad = LICENSE_PUBLIC_KEY_B64URL.length % 4 === 0 ? '' : '='.repeat(4 - (LICENSE_PUBLIC_KEY_B64URL.length % 4));
  const raw = Buffer.from(LICENSE_PUBLIC_KEY_B64URL.replace(/-/g, '+').replace(/_/g, '/') + pad, 'base64');
  assert.equal(raw.length, 32);
});

test('malformed input degrades to a typed error, never throws', () => {
  for (const bad of ['', 'nope', 'CS1.only-two', 'CS2.aa.bb', 'CS1..', 'CS1.@@@.###']) {
    const r = verifyLicenseKey(bad, PUB);
    assert.equal(r.ok, false);
  }
  // A valid signature over non-JSON payload bytes -> payload error, not a throw.
  const notJson = Buffer.from('not json at all', 'utf8');
  const sig = crypto.sign(null, notJson, kp.privateKey);
  const r = verifyLicenseKey(`${LICENSE_PREFIX}.${b64url(notJson)}.${b64url(sig)}`, PUB);
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.error, 'payload');
});

test('a signed payload missing a name is rejected', () => {
  const token = mint(kp.privateKey, { v: 1, iat: 1, id: 'x', edition: 'direct' });
  const r = verifyLicenseKey(token, PUB);
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.error, 'payload');
});
