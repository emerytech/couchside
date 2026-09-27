/**
 * connFromBox must ALWAYS carry the TLS pin fields, so no UI path can hand-roll a
 * conn that drops secure/tlsPort/pinModulus and leaks the bearer token over
 * plaintext to a securely-paired box (KI-096: fleet.tsx status poll,
 * RemotePowerBar wol-relay). Install-free (strip-types glob).
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { connFromBox, connIsPinned } from '../boxConn.ts';

const secureBox = {
  host: 'steam-machine.local',
  port: 8787,
  token: 'tok-abc',
  lastIp: '10.1.1.38',
  secure: true as const,
  tlsPort: 8788,
  pinModulus: 'a'.repeat(64),
};

const plainBox = {
  host: 'oldbox.local',
  port: 8787,
  token: 'tok-xyz',
  lastIp: '10.1.1.50',
};

test('a secure box keeps all three pin fields, so the transport stays pinned', () => {
  const c = connFromBox(secureBox);
  assert.equal(c.secure, true, 'secure carried');
  assert.equal(c.tlsPort, 8788, 'tlsPort carried');
  assert.equal(c.pinModulus, 'a'.repeat(64), 'pinModulus carried');
  assert.ok(connIsPinned(c), 'attempt() would take the pinned path (token off the wire)');
  // and it still carries what a request needs
  assert.equal(c.host, 'steam-machine.local');
  assert.equal(c.token, 'tok-abc');
  assert.equal(c.lastIp, '10.1.1.38');
});

test('a plaintext-paired box stays plaintext (no pin fabricated)', () => {
  const c = connFromBox(plainBox);
  assert.equal(connIsPinned(c), false, 'a box that was never TLS-paired is not forced pinned');
  assert.equal(c.secure, undefined);
  assert.equal(c.tlsPort, undefined);
  assert.equal(c.pinModulus, undefined);
});

test('no secure field is ever silently dropped (the KI-096 regression)', () => {
  // The failure the leak came from: a conn built for a secure box that is MISSING
  // any one pin field falls to the plaintext token path. connFromBox must never
  // produce that from a secure box.
  const c = connFromBox(secureBox);
  const missingAny = c.secure === undefined || c.tlsPort === undefined || c.pinModulus === undefined;
  assert.equal(missingAny, false, 'a secure box never yields a conn missing a pin field');
});
