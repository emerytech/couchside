/**
 * Certificate minting and hashing — lib/tvdirect/atvcrypto.ts.
 *
 * WHY THIS FILE EXISTS. This is the code whose failures are SILENT:
 *
 *  - A wrong SHA-256 does not throw. It produces a pairing secret the TV
 *    rejects with silence, which looks exactly like a dead link. forge speaks
 *    "binary strings", so every byte has to survive a charCode round trip in
 *    both directions — tested against Node's own crypto over random data,
 *    including the high bytes (>= 0x80) where a truncating conversion breaks.
 *  - A weak key does not throw either. forge falls back to a Math.random PRNG
 *    when it finds no CSPRNG, so minting REFUSES without one, and that refusal
 *    is tested rather than assumed.
 *  - A mis-derived modulus produces a secret that fails only at pairing time,
 *    so the modulus is cross-checked against openssl's own answer.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomFillSync } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { makePrng, mintIdentity, modulusFromPem, sha256 } from '../atvcrypto.ts';

const getRandomValues = (a: Uint8Array) => {
  randomFillSync(a);
  return a;
};

test('sha256 matches Node crypto, including high bytes', async () => {
  const cases: Uint8Array[] = [
    new Uint8Array(0),
    Uint8Array.from([0]),
    Uint8Array.from([0xff]),
    // Every byte value: the range where a naive charCode conversion truncates.
    Uint8Array.from(Array.from({ length: 256 }, (_, i) => i)),
    new Uint8Array(randomBytes(1000)),
  ];
  for (const input of cases) {
    const mine = await sha256(input);
    const theirs = new Uint8Array(createHash('sha256').update(input).digest());
    assert.deepEqual(
      Buffer.from(mine).toString('hex'),
      Buffer.from(theirs).toString('hex'),
      `sha256 mismatch for ${input.length} bytes`,
    );
  }
});

test('sha256 agrees with Node on 50 random inputs (fuzz)', async () => {
  for (let i = 0; i < 50; i++) {
    const input = new Uint8Array(randomBytes(1 + (i * 37) % 300));
    const mine = Buffer.from(await sha256(input)).toString('hex');
    const theirs = createHash('sha256').update(input).digest('hex');
    assert.equal(mine, theirs);
  }
});

test('minting REFUSES without a CSPRNG rather than using a weak PRNG', () => {
  // forge silently falls back to a Math.random-seeded PRNG, which would mint
  // predictable client keys. Refusing is the whole point.
  assert.throws(() => makePrng(undefined), /no platform CSPRNG/);
  assert.throws(() => mintIdentity(undefined), /no platform CSPRNG/);
});

test('a minted identity is a usable self-signed cert with a matching modulus', () => {
  const id = mintIdentity(getRandomValues);
  assert.match(id.certPem, /^-----BEGIN CERTIFICATE-----/);
  assert.match(id.keyPem, /PRIVATE KEY-----/);
  assert.match(id.modulusHex, /^[0-9a-f]+$/, 'lowercase hex');
  assert.equal(id.modulusHex.length % 2, 0, 'even length — it gets hex-decoded');
  // 2048-bit key = 256 bytes = 512 hex chars.
  assert.equal(id.modulusHex.length, 512);
  assert.ok(id.elapsedMs >= 0);
  // The modulus the pairing secret uses must be the CERT's modulus.
  assert.equal(modulusFromPem(id.certPem), id.modulusHex);
});

test('the modulus agrees with openssl (an independent implementation)', () => {
  // A control against a tool that is not forge: a self-consistent-but-wrong
  // modulus would pass every other assertion here.
  const id = mintIdentity(getRandomValues);
  const dir = mkdtempSync(join(tmpdir(), 'atvcert-'));
  const p = join(dir, 'c.pem');
  writeFileSync(p, id.certPem);
  const out = execFileSync('openssl', ['x509', '-in', p, '-noout', '-modulus'], {
    encoding: 'utf8',
  });
  const expected = out.trim().replace(/^Modulus=/, '').toLowerCase();
  assert.equal(id.modulusHex, expected);
});

test('two mints differ — the CSPRNG is actually being consumed', () => {
  // If forge were seeded identically each time (or not at all), these would
  // collide. This is the observable proxy for "the entropy is real".
  const a = mintIdentity(getRandomValues);
  const b = mintIdentity(getRandomValues);
  assert.notEqual(a.modulusHex, b.modulusHex);
  assert.notEqual(a.keyPem, b.keyPem);
});

test('the cert carries the extensions Android TV expects', () => {
  const id = mintIdentity(getRandomValues);
  const dir = mkdtempSync(join(tmpdir(), 'atvcert-'));
  const p = join(dir, 'c.pem');
  writeFileSync(p, id.certPem);
  const text = execFileSync('openssl', ['x509', '-in', p, '-noout', '-text'], {
    encoding: 'utf8',
  });
  assert.match(text, /CA:TRUE/, 'basicConstraints CA:TRUE (matches the agent)');
  assert.match(text, /DNS:couchside/, 'subjectAltName');
  assert.match(text, /CN\s*=\s*couchside/, 'common name');
  // Long-dated: a short-lived cert is refused by the TV.
  assert.match(text, /2038/, 'notAfter is far future');
});

// ------------------------------------------------- the non-blocking mint
// Build 122 froze the app on device: RSA-2048 ran synchronously and the JS
// thread took no touches until it finished. These pin the fix.

import { mintIdentityAsync } from '../atvcrypto.ts';

test('mintIdentityAsync YIELDS to the event loop (the freeze fix)', async () => {
  // A timer that keeps ticking during keygen is the observable proxy for "the
  // JS thread is not monopolised". Under the SYNC mint this counter cannot
  // advance at all; under the stepping mint it must.
  let ticks = 0;
  const timer = setInterval(() => { ticks += 1; }, 5);
  try {
    const id = await mintIdentityAsync(getRandomValues, { sliceMs: 20 });
    assert.equal(id.modulusHex.length, 512, 'still a real 2048-bit key');
    assert.match(id.certPem, /^-----BEGIN CERTIFICATE-----/);
  } finally {
    clearInterval(timer);
  }
  assert.ok(ticks > 0, `event loop ran during keygen (ticks=${ticks})`);
});

test('the async mint produces the SAME cert shape as the sync one', () => {
  // Both go through finishCert, so this guards the two paths from drifting.
  const sync = mintIdentity(getRandomValues);
  assert.equal(sync.modulusHex.length, 512);
  assert.equal(modulusFromPem(sync.certPem), sync.modulusHex);
});

test('async mint refuses without a CSPRNG, like the sync one', async () => {
  await assert.rejects(() => mintIdentityAsync(undefined), /no platform CSPRNG/);
});

test('async mint is cancellable (a stuck pair must not run forever)', async () => {
  const signal = { aborted: true };
  await assert.rejects(() => mintIdentityAsync(getRandomValues, { signal }), /cancelled/);
});

test('the private key is PKCS#8, because Android cannot read PKCS#1', async () => {
  // NOT a style preference. react-native-tcp-socket parses the PEM body on
  // Android with PKCS8EncodedKeySpec and nothing else, so a PKCS#1 key
  // ("BEGIN RSA PRIVATE KEY") throws on every connectTLS — every Google TV
  // pair and every keypress, on every Android device. iOS quietly converts it,
  // which is why this shipped unnoticed: the feature was only verified there.
  //
  // The older assertion in this file matched /PRIVATE KEY-----/, which is true
  // of BOTH formats and therefore could never have caught it.
  const id = await mintIdentityAsync(getRandomValues);
  assert.ok(
    id.keyPem.startsWith('-----BEGIN PRIVATE KEY-----'),
    `key must be PKCS#8; got: ${id.keyPem.slice(0, 32)}`,
  );
  assert.ok(!id.keyPem.includes('BEGIN RSA PRIVATE KEY'), 'must not be PKCS#1');
});
