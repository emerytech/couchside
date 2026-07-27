/**
 * LAN-address gate — lib/lanIp.ts.
 *
 * Run: from app/, `node --experimental-strip-types --test lib/__tests__/*.test.ts`
 *
 * THE BUG THIS EXISTS FOR (KI-033, found 2026-07-27): `010.1.1.5` was accepted
 * as private. JS reads octets with `Number()`, always decimal, so `'010'` is 10;
 * the OS reads a leading zero as octal via inet_aton, so it resolves to 8.1.1.5,
 * a public address. The gate exists specifically to stop a value learned from an
 * unauthenticated ping response from becoming a bearer-token destination, so an
 * accept there defeats the whole control.
 *
 * Every octal case below is paired with the plain-decimal address it was
 * MEASURED to resolve to, and with a control in the opposite direction, per
 * CLAUDE.md §11 rule 3 — an all-rejects test would pass just as well against a
 * function that rejects everything.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { isValidLanIp } from '../lanIp.ts';

test('THE BUG: a leading zero cannot smuggle a public address through', () => {
  // Measured: inet_aton('010.1.1.5') -> 8.1.1.5, which is public.
  assert.equal(isValidLanIp('010.1.1.5'), false, '010.1.1.5 resolves to 8.1.1.5');
  // CONTROL, the other direction: the address it *looks* like really is private,
  // so this test cannot pass by rejecting everything shaped like an IP.
  assert.equal(isValidLanIp('10.1.1.5'), true);
  // CONTROL: what it actually resolves to is rejected when written plainly.
  assert.equal(isValidLanIp('8.1.1.5'), false);
});

test('leading zeros are refused in every octet position', () => {
  for (const v of ['010.1.1.5', '10.010.1.5', '10.1.010.5', '10.1.1.05', '0127.0.0.1']) {
    assert.equal(isValidLanIp(v), false, `${v} was accepted`);
  }
  // A bare zero octet is legitimate and must still pass.
  assert.equal(isValidLanIp('10.0.0.1'), true);
  assert.equal(isValidLanIp('192.168.0.1'), true);
});

test('every private range is accepted', () => {
  for (const v of [
    '10.0.0.1', '10.255.255.254',
    '127.0.0.1',
    '192.168.1.5',
    '172.16.0.1', '172.31.255.254',
    '169.254.1.1', // link-local
    '100.64.0.1', '100.127.255.254', // CGNAT — Tailscale lives here
  ]) {
    assert.equal(isValidLanIp(v), true, `${v} was rejected`);
  }
});

test('public and near-miss ranges are refused', () => {
  for (const v of [
    '8.8.8.8', '1.1.1.1', '203.0.113.5',
    '172.15.0.1', '172.32.0.1', // just outside 172.16/12
    '192.169.1.1', '191.168.1.1', // near-miss on 192.168
    '100.63.255.255', '100.128.0.1', // just outside CGNAT
    '169.253.1.1', // just outside link-local
  ]) {
    assert.equal(isValidLanIp(v), false, `${v} was accepted`);
  }
});

test('anything that is not four decimal octets is refused', () => {
  for (const v of [
    'bazzite.local', 'localhost', '', ' ', '10.1.1', '10.1.1.5.6',
    '10.1.1.-5', '10.1.1.5 ', ' 10.1.1.5', '10.1.1.5/24', '10.1.1.5:8787',
    '::1', 'fe80::1', '0x0a.1.1.5', '167772161', // the integer form of 10.0.0.1
    '10.1.1.256', '256.1.1.1',
  ]) {
    assert.equal(isValidLanIp(v), false, `${v} was accepted`);
  }
});

test('a non-string cannot throw or sneak through', () => {
  for (const v of [null, undefined, 42, {}, [], true]) {
    assert.equal(isValidLanIp(v as unknown as string), false, `${String(v)} was accepted`);
  }
});
