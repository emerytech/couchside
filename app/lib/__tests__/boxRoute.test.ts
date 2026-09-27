/**
 * Host-selection policy: lib/boxRoute.ts (raceIpFirst, ttlMemo), the pure core
 * of api.ts raceGet and of the throttle on attempt()'s secure-link diagnostics.
 *
 * WHY THIS FILE EXISTS. On 2026-09-26 the box's mDNS name resolved ONLY to IPv6
 * on the phone (the LAN gained a ULA prefix; the agent listens on 0.0.0.0), so
 * every hostname attempt was a refused connect. The old race started the hostname
 * on EVERY GET whose IP path had not finished in 250 ms, even when the IP probe
 * had already proven the box and the request was merely queued, and each failure
 * then ran two diagnostic pings. The first case ("IP proven, request merely
 * slow") and the burst-throttle case FAIL against the old logic (proved by
 * running this file against a copy of the old raceGet and a pass-through memo).
 *
 * The rest pass on both, on purpose: when the IP has NOT proven itself, or its
 * request fails, the hostname must still join exactly as before.
 *
 * Install-free (no RN imports) so it runs in CI's fast strip-types glob.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { raceIpFirst, ttlMemo } from '../boxRoute.ts';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const after = <T>(ms: number, v: T) => sleep(ms).then(() => v);
const failAfter = (ms: number, msg: string) => sleep(ms).then(() => { throw new Error(msg); });

function race(o: { probe: () => Promise<boolean>; ip: () => Promise<string>; host: () => Promise<string> }) {
  const calls = { ip: 0, host: 0 };
  const p = raceIpFirst<string>({
    staggerMs: 30,
    probeIp: o.probe,
    viaIp: () => { calls.ip += 1; return o.ip(); },
    viaHost: () => { calls.host += 1; return o.host(); },
  });
  return { p, calls };
}

test('IP proven, request merely slow: the hostname is NOT started', async () => {
  const { p, calls } = race({
    probe: () => after(5, true), // proven well inside the 30 ms stagger
    ip: () => after(120, 'ip'), // queued behind other requests on the one socket
    host: () => failAfter(1, 'ECONNREFUSED (IPv6-only mDNS)'),
  });
  assert.equal(await p, 'ip');
  assert.equal(calls.host, 0, 'hostname attempted although the IP had proven the box');
});

test('IP proven, then the IP request FAILS: the hostname still joins and can win', async () => {
  const { p, calls } = race({
    probe: () => after(5, true),
    ip: () => failAfter(60, 'ip request failed'),
    host: () => after(5, 'host'),
  });
  assert.equal(await p, 'host');
  assert.equal(calls.host, 1);
});

test('IP proven, both fail: rejects with the HOSTNAME error', async () => {
  const { p, calls } = race({
    probe: () => after(5, true),
    ip: () => failAfter(60, 'ip failed'),
    host: () => failAfter(5, 'host failed'),
  });
  await assert.rejects(p, /host failed/);
  assert.equal(calls.host, 1);
});

test('control: probe still pending at the stagger, the hostname joins (old behaviour)', async () => {
  const { p, calls } = race({
    probe: () => after(200, true),
    ip: () => after(1, 'ip'),
    host: () => after(10, 'host'),
  });
  assert.equal(await p, 'host');
  assert.equal(calls.host, 1);
  assert.equal(calls.ip, 0, 'IP request not yet sent when the hostname won');
});

test('control: probe FAILS, the hostname joins and wins; the IP request is never sent', async () => {
  const { p, calls } = race({
    probe: () => after(5, false),
    ip: () => after(1, 'ip'),
    host: () => after(5, 'host'),
  });
  assert.equal(await p, 'host');
  assert.equal(calls.ip, 0, 'no token to an address that did not prove itself');
});

test('control: probe fails and hostname fails, rejects with the hostname error', async () => {
  const { p } = race({
    probe: () => after(5, false),
    ip: () => after(1, 'ip'),
    host: () => failAfter(5, 'host unreachable'),
  });
  await assert.rejects(p, /host unreachable/);
});

test('control: a throwing probe counts as "not proven"', async () => {
  const { p, calls } = race({
    probe: () => Promise.reject(new Error('probe blew up')),
    ip: () => after(1, 'ip'),
    host: () => after(5, 'host'),
  });
  assert.equal(await p, 'host');
  assert.equal(calls.ip, 0);
});

test('control: fast IP wins alone; the hostname never starts', async () => {
  const { p, calls } = race({
    probe: () => after(2, true),
    ip: () => after(2, 'ip'),
    host: () => after(1, 'host'),
  });
  assert.equal(await p, 'ip');
  await sleep(50);
  assert.equal(calls.host, 0);
});

test('ttlMemo: a burst of callers shares ONE lookup; reused inside the window, redone after', async () => {
  let t = 1000;
  let calls = 0;
  const memo = ttlMemo<string | null>(5000, () => t);
  const lookup = () => { calls += 1; return after(5, null); }; // a ping that got no answer
  const burst = await Promise.all(Array.from({ length: 20 }, () => memo('steam-machine.local', lookup)));
  assert.deepEqual(burst, Array(20).fill(null));
  assert.equal(calls, 1, 'twenty failures, one ping');
  t += 4999;
  await memo('steam-machine.local', lookup);
  assert.equal(calls, 1, 'still inside the 5 s window (a null answer is cached too)');
  t += 1;
  await memo('steam-machine.local', lookup);
  assert.equal(calls, 2, 'window over: asked again');
  await memo('10.0.0.5', lookup);
  assert.equal(calls, 3, 'keyed per host');
});

test('ttlMemo: a rejected lookup is not cached', async () => {
  let calls = 0;
  const memo = ttlMemo<string>(5000);
  await assert.rejects(memo('h', () => { calls += 1; return Promise.reject(new Error('boom')); }));
  assert.equal(await memo('h', () => { calls += 1; return Promise.resolve('ok'); }), 'ok');
  assert.equal(calls, 2);
});
