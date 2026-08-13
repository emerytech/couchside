/**
 * Pure codec for the pinned-TLS transport — lib/boxTlsCodec.ts.
 *
 * WHY THIS FILE EXISTS. Both functions fail SILENTLY:
 *
 *  - normalizeModulus feeds the pin compare in boxTls.connectPinned. If it does
 *    not reduce getPeerCertificate's format and node-forge's format to the SAME
 *    string, the compare is wrong in one of two ways, both silent: always-unequal
 *    (the user is locked out of their own box, looks like "TLS broken"), or — the
 *    dangerous one — always-equal (the pin is defeated, an MITM cert is accepted).
 *  - parseHttpResponse turns raw box replies into status/headers/body. A mis-parse
 *    corrupts every response with no error. The head/body split must be byte-exact
 *    so a UTF-8 body cannot shift the header boundary.
 *
 * Install-free (no forge/native imports) so it runs in CI's fast test glob.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { normalizeModulus, parseHttpResponse } from '../boxTlsCodec.ts';

test('normalizeModulus reduces getPeerCertificate vs forge formats to one string', () => {
  // The whole point: a colon-delimited uppercase modulus (one platform's shape)
  // and a bare lowercase one (the other's) must compare EQUAL.
  const a = normalizeModulus('AB:CD:EF:01:23');
  const b = normalizeModulus('abcdef0123');
  assert.equal(a, 'abcdef0123');
  assert.equal(a, b);
});

test('normalizeModulus strips 0x, whitespace, case', () => {
  assert.equal(normalizeModulus('0xABCD'), 'abcd');
  assert.equal(normalizeModulus('  ab cd  '), 'abcd');
  assert.equal(normalizeModulus('ABCD'), 'abcd');
});

test('normalizeModulus drops a leading DER sign byte / zero padding', () => {
  // openssl/DER prepend a 00 to keep the high-bit-set integer positive; the raw
  // key does not. Both must normalize the same.
  assert.equal(normalizeModulus('00abcd'), 'abcd');
  assert.equal(normalizeModulus('0000abcd'), 'abcd');
  assert.equal(normalizeModulus('00abcd'), normalizeModulus('abcd'));
});

test('normalizeModulus returns null for empty / all-zero / nullish (never "")', () => {
  // A null pin must be caught by the caller as "no pin", never silently equal to
  // another empty normalization.
  assert.equal(normalizeModulus(''), null);
  assert.equal(normalizeModulus(null), null);
  assert.equal(normalizeModulus(undefined), null);
  assert.equal(normalizeModulus('0000'), null);
  assert.equal(normalizeModulus(':::'), null);
});

const enc = (s: string) => new Uint8Array(Buffer.from(s, 'latin1'));

test('parseHttpResponse: status + lowercased headers + JSON body', () => {
  const raw = enc(
    'HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 11\r\n\r\n{"ok":true}',
  );
  const r = parseHttpResponse(raw);
  assert.ok(r);
  assert.equal(r.status, 200);
  assert.equal(r.headers['content-type'], 'application/json');
  assert.equal(r.headers['content-length'], '11');
  assert.deepEqual(JSON.parse(r.body), { ok: true });
});

test('parseHttpResponse: 401 and other statuses parse', () => {
  const r = parseHttpResponse(enc('HTTP/1.1 401 Unauthorized\r\n\r\n{"error":"unauthorized"}'));
  assert.ok(r);
  assert.equal(r.status, 401);
  assert.deepEqual(JSON.parse(r.body), { error: 'unauthorized' });
});

test('parseHttpResponse returns null until the CRLFCRLF header terminator arrives', () => {
  assert.equal(parseHttpResponse(enc('HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n')), null);
  assert.equal(parseHttpResponse(enc('')), null);
});

test('parseHttpResponse: a UTF-8 body does not shift the header boundary', () => {
  // Build the head as latin1 and the body as UTF-8 (a multibyte char), then splice
  // the raw bytes — exactly what arrives on the wire. The head scan must find the
  // separator by bytes, and the body must decode back to the original string.
  const body = '{"name":"café ☕ 日本"}';
  const head = 'HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\r\n';
  const raw = new Uint8Array(Buffer.concat([Buffer.from(head, 'latin1'), Buffer.from(body, 'utf8')]));
  const r = parseHttpResponse(raw);
  assert.ok(r);
  assert.equal(r.status, 200);
  assert.equal(r.body, body);
  assert.equal(JSON.parse(r.body).name, 'café ☕ 日本');
});

test('parseHttpResponse: colons in the body do not leak into header parsing', () => {
  const raw = enc('HTTP/1.1 200 OK\r\nX-A: 1\r\n\r\n{"ratio":"16:9","t":"a:b:c"}');
  const r = parseHttpResponse(raw);
  assert.ok(r);
  assert.deepEqual(Object.keys(r.headers), ['x-a']);
  assert.equal(r.headers['x-a'], '1');
  assert.deepEqual(JSON.parse(r.body), { ratio: '16:9', t: 'a:b:c' });
});
