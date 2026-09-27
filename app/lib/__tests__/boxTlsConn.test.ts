/**
 * The pinned-TLS keep-alive pool: lib/boxTlsConn.ts (PinnedConn).
 *
 * WHY THIS FILE EXISTS. On 2026-09-26 a Razr (Android 16) paired over TLS to a
 * Steam Machine showed Console crashes ("Cannot read property 'pressure' of
 * undefined") and an audio card fed a body with no `sinks`: requests were getting
 * OTHER requests' replies, and the app opened sockets at ~88/s at 70-160% CPU.
 * Every case below reproduces one of those failures with a fake socket and FAILS
 * against the pre-fix PinnedConn (proved by running this file against a copy of
 * the old class with only its connect injected):
 *
 *  - LATE DATA / LATE CLOSE / CHAIN: RN delivers a destroyed socket's close (and
 *    any queued bytes) AFTER destroy(). The old pool stayed wired to it, so a
 *    timed-out reply resolved the NEXT request (/api/audio got the /api/leds
 *    body), and the late close killed the new request and orphaned the new socket.
 *  - QUEUE DEADLINE: a request the caller had already abandoned was still written
 *    later. For a POST that means an action the UI reported as failed runs anyway.
 *  - BACKOFF: against a refusing host every queued request opened its own socket.
 *
 * The fake socket keeps its callbacks after close(), like the old connectPinned
 * did, so the pool's OWN guard is what is under test here.
 *
 * Install-free (no native imports) so it runs in CI's fast strip-types glob.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { Buffer } from 'buffer';

import { CONNECT_BACKOFF_MS, PinnedConn, frameHttpRequest } from '../boxTlsConn.ts';
import type { PinnedSocket } from '../boxTlsConn.ts';

type Responder = (s: FakeSock, path: string) => void;

class FakeSock implements PinnedSocket {
  id: number;
  writes: string[] = [];
  closed = false;
  dataCb: ((b: Uint8Array) => void) | null = null;
  closeCb: (() => void) | null = null;
  responder: Responder | null = null;
  constructor(id: number) {
    this.id = id;
  }
  write(b: Uint8Array): void {
    const t = Buffer.from(b).toString('utf8');
    this.writes.push(t);
    this.responder?.(this, t.split(' ')[1]);
  }
  onData(cb: (b: Uint8Array) => void): void {
    this.dataCb = cb;
  }
  onClose(cb: () => void): void {
    this.closeCb = cb;
  }
  // Like RN: destroy() does not emit close synchronously, and (like the old
  // connectPinned) the callbacks stay attached, so late events still fire.
  close(): void {
    this.closed = true;
  }
  emit(raw: string): void {
    this.dataCb?.(new Uint8Array(Buffer.from(raw, 'utf8')));
  }
  emitClose(): void {
    this.closeCb?.();
  }
}

const BODIES: Record<string, unknown> = {
  '/api/status': { mem: { used_mb: 1 }, cpu: {}, os: {}, disks: [] },
  '/api/audio': { available: true, default: 'x', sinks: [] },
  '/api/leds': { available: true, effects: [] },
  '/api/units': { units: [] },
};
function http(body: unknown): string {
  const j = JSON.stringify(body);
  return `HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(j)}\r\n\r\n${j}`;
}
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** A pool over fake sockets. `reply` answers each write after `delayMs` unless
 *  `hold(path)` says to keep that one unanswered (the test answers it later). */
function rig(o: {
  delayMs?: number;
  hold?: (path: string, sock: FakeSock) => boolean;
  connectDelayMs?: number;
  refuse?: () => Error | null;
  now?: () => number;
} = {}) {
  const socks: FakeSock[] = [];
  let connects = 0;
  const conn = new PinnedConn(
    async () => {
      connects += 1;
      if (o.connectDelayMs) await sleep(o.connectDelayMs);
      else await Promise.resolve();
      const err = o.refuse?.() ?? null;
      if (err) throw err;
      const s = new FakeSock(socks.length + 1);
      s.responder = (sock, path) => {
        if (o.hold?.(path, sock)) return;
        setTimeout(() => sock.emit(http(BODIES[path] ?? { ok: true })), o.delayMs ?? 2);
      };
      socks.push(s);
      return s;
    },
    { now: o.now },
  );
  const req = (path: string, timeoutMs = 400, method = 'GET') =>
    conn.request(frameHttpRequest('box.test', { path, method }), timeoutMs);
  return {
    conn,
    socks,
    req,
    get connects() {
      return connects;
    },
    /** Every request line written to any socket, in order. */
    written: () => socks.flatMap((s) => s.writes.map((w) => w.split('\r\n')[0])),
  };
}

test('control: sequential requests on one healthy socket each get their own body', async () => {
  const r = rig();
  const a = await r.req('/api/status');
  const b = await r.req('/api/audio');
  assert.ok(JSON.parse(a.body).mem, 'status got status');
  assert.ok(Array.isArray(JSON.parse(b.body).sinks), 'audio got audio');
  assert.equal(r.connects, 1, 'one socket, reused');
});

test('LATE DATA: a timed-out request\'s late reply never resolves the NEXT request', async () => {
  let held: FakeSock | null = null;
  const r = rig({ hold: (p, s) => (p === '/api/leds' && !held ? ((held = s), true) : false), delayMs: 20 });
  await assert.rejects(r.req('/api/leds', 30), /timeout/);
  const pB = r.req('/api/audio', 400);
  await sleep(1);
  held!.emit(http(BODIES['/api/leds'])); // the dropped socket's reply arrives late
  const b = await pB;
  assert.ok(!b.body.includes('effects'), `audio received the LEDS body: ${b.body}`);
  assert.ok(Array.isArray(JSON.parse(b.body).sinks), 'audio got its own body');
});

test('LATE CLOSE: the old socket\'s late close does not fail the new request or orphan its socket', async () => {
  let first = true;
  const r = rig({ hold: () => (first ? ((first = false), true) : false), delayMs: 20 });
  await assert.rejects(r.req('/api/status', 30), /timeout/);
  const old = r.socks[0];
  assert.equal(old.closed, true, 'a timed-out socket is dropped (its stream can no longer be framed)');
  const pB = r.req('/api/audio', 400);
  await sleep(2);
  old.emitClose(); // destroy()'s close event lands after the new socket is in use
  const b = await pB;
  assert.ok(Array.isArray(JSON.parse(b.body).sinks), 'audio succeeded on the new socket');
  const c = await r.req('/api/status', 400);
  assert.ok(JSON.parse(c.body).mem, 'status got its own body');
  assert.equal(r.connects, 2, 'the new socket was kept, not orphaned and replaced');
  assert.equal(r.socks.filter((s) => !s.closed).length, 1, 'exactly one live socket');
});

test('CHAIN: a late close cannot orphan a live socket whose reply then crosses into the next request', async () => {
  let first = true;
  const r = rig({ hold: () => (first ? ((first = false), true) : false), delayMs: 20 });
  await assert.rejects(r.req('/api/status', 30), /timeout/);
  const old = r.socks[0];
  const pB = r.req('/api/audio', 400);
  await sleep(2);
  old.emitClose();
  await pB.catch(() => {});
  const c = await r.req('/api/status', 400);
  assert.ok(!c.body.includes('sinks'), `STATUS received the AUDIO body: ${c.body}`);
  assert.ok(JSON.parse(c.body).mem, 'status got its own body');
});

test('QUEUE DEADLINE: a request that expires while queued is rejected and NEVER written', async () => {
  let release: (() => void) | null = null;
  const r = rig({
    hold: (p, s) => {
      if (p !== '/api/status' || release) return false;
      release = () => s.emit(http(BODIES['/api/status']));
      return true;
    },
  });
  const pA = r.req('/api/status', 400); // active, slow
  // Queued behind A; its caller gives up at 40 ms (api.ts attempt()'s deadline).
  const pB = r.req('/api/decky/plugins/install', 40, 'POST').then(() => 'resolved', (e: Error) => e);
  setTimeout(() => release!(), 80); // A answers only AFTER B's deadline
  const a = await pA;
  assert.ok(JSON.parse(a.body).mem, 'A still got its own reply');
  const c = await r.req('/api/units', 400);
  assert.ok(Array.isArray(JSON.parse(c.body).units), 'C got its own reply');
  await sleep(30);
  assert.deepEqual(r.written(), ['GET /api/status HTTP/1.1', 'GET /api/units HTTP/1.1'],
    'the abandoned POST was never written');
  const b = await pB;
  assert.ok(b instanceof Error && /timeout/.test(b.message), `B settled as ${String(b)}`);
});

test('QUEUE DEADLINE: the deadline covers the connect wait too', async () => {
  const r = rig({ connectDelayMs: 80 });
  await assert.rejects(r.req('/api/status', 20), /timeout/);
  await sleep(100); // connect completes after the caller gave up
  assert.deepEqual(r.written(), [], 'nothing written for the expired request');
  const b = await r.req('/api/audio', 400);
  assert.ok(Array.isArray(JSON.parse(b.body).sinks));
  assert.equal(r.connects, 1, 'the late connect was kept and reused, not redone');
});

test('timeout errors say whether the request was written (PinnedTimeoutError.sent)', async () => {
  let release: (() => void) | null = null;
  const r = rig({
    hold: (p, s) => {
      if (release) return false;
      release = () => s.emit(http(BODIES['/api/status']));
      return true;
    },
  });
  const pA = r.req('/api/status', 60);
  const pB = r.req('/api/audio', 20);
  const eB = await pB.catch((e: Error) => e);
  const eA = await pA.catch((e: Error) => e);
  assert.ok(eA instanceof Error && eB instanceof Error);
  assert.equal(eB.name, 'PinnedTimeoutError');
  assert.equal((eB as Error & { sent: boolean }).sent, false, 'queued request: never sent');
  assert.equal(eA.name, 'PinnedTimeoutError');
  assert.equal((eA as Error & { sent: boolean }).sent, true, 'active request: sent, the box may have acted');
});

test('BACKOFF: a queued burst against a refusing host is ONE connect; all fail with that same error', async () => {
  let t = 1_000_000;
  let refuse = true;
  const errs: Error[] = [];
  const r = rig({
    now: () => t,
    refuse: () => {
      if (!refuse) return null;
      const e = new Error(`connect ECONNREFUSED #${errs.length + 1}`);
      errs.push(e);
      return e;
    },
  });
  const burst = Array.from({ length: 10 }, (_, i) => r.req(`/api/x${i}`, 400).catch((e: Error) => e));
  const out = await Promise.all(burst);
  assert.equal(r.connects, 1, 'one connect for the whole burst');
  for (const e of out) assert.equal(e, errs[0], 'every request got the one connect error (same object)');

  // Each cooldown lasts exactly its step: 0.5 s, 1, 2, 4, 8, then stays at 8.
  // One ms before it ends: fail fast with the SAME error, no socket. At its end:
  // one fresh connect (which fails again and starts the next, longer cooldown).
  let tFail = t;
  for (let i = 0; i <= CONNECT_BACKOFF_MS.length; i++) {
    const cd = CONNECT_BACKOFF_MS[Math.min(i, CONNECT_BACKOFF_MS.length - 1)];
    const before: number = r.connects;
    const last: Error = errs[errs.length - 1];
    t = tFail + cd - 1;
    assert.equal(await r.req('/api/y', 400).catch((e: Error) => e), last, 'fails fast with the last connect error');
    assert.equal(r.connects, before, `no connect inside cooldown #${i + 1} (${cd} ms)`);
    t = tFail + cd;
    const e = await r.req('/api/z', 400).catch((err: Error) => err);
    assert.equal(r.connects, before + 1, `one fresh connect once cooldown #${i + 1} (${cd} ms) ends`);
    assert.equal(e, errs[errs.length - 1]);
    tFail = t;
  }

  // A successful pinned connect resets the backoff.
  t = tFail + CONNECT_BACKOFF_MS[CONNECT_BACKOFF_MS.length - 1];
  refuse = false;
  const ok = await r.req('/api/status', 400);
  assert.ok(JSON.parse(ok.body).mem);
  r.socks[r.socks.length - 1].emitClose(); // box restarts
  refuse = true;
  const before: number = r.connects;
  await r.req('/api/status', 400).catch(() => {});
  assert.equal(r.connects, before + 1);
  t += CONNECT_BACKOFF_MS[0] - 1;
  await r.req('/api/status', 400).catch(() => {});
  assert.equal(r.connects, before + 1, 'still cooling down');
  t += 1;
  await r.req('/api/status', 400).catch(() => {});
  assert.equal(r.connects, before + 2, 'after a success the first cooldown is 0.5 s again');
});

test('BACKOFF keeps a PinMismatchError a PinMismatchError (api.ts maps it to re-pair)', async () => {
  let t = 5_000;
  class PinMismatchError extends Error {
    constructor() {
      super('TLS pin mismatch');
      this.name = 'PinMismatchError';
    }
  }
  const mismatch = new PinMismatchError();
  const r = rig({ now: () => t, refuse: () => mismatch });
  const e1 = await r.req('/api/status', 400).catch((e: Error) => e);
  t += 100;
  const e2 = await r.req('/api/status', 400).catch((e: Error) => e);
  assert.equal(e1, mismatch);
  assert.equal(e2, mismatch, 'the cooldown rejection is the SAME error object');
  assert.equal(e2.name, 'PinMismatchError');
  assert.equal(r.connects, 1);
});

test('stray bytes with nothing in flight drop the socket instead of prefixing the next reply', async () => {
  const r = rig();
  await r.req('/api/status');
  r.socks[0].emit(http({ stray: true })); // unsolicited: desynced stream
  assert.equal(r.socks[0].closed, true, 'desynced socket dropped');
  const b = await r.req('/api/audio');
  assert.ok(!b.body.includes('stray'), `audio received the stray bytes: ${b.body}`);
  assert.equal(r.connects, 2, 'reconnected (pin re-verified by connect)');
});

test('bytes past a reply\'s Content-Length drop the socket (never framed into the next reply)', async () => {
  let once = true;
  const r = rig({
    hold: (p, s) => {
      if (!once) return false;
      once = false;
      setTimeout(() => s.emit(http(BODIES['/api/status']) + http({ extra: true })), 2);
      return true;
    },
  });
  const a = await r.req('/api/status');
  assert.ok(JSON.parse(a.body).mem);
  const b = await r.req('/api/audio');
  assert.ok(!b.body.includes('extra'), `audio received the extra bytes: ${b.body}`);
  assert.equal(r.connects, 2);
});

test('frameHttpRequest: bearer token and JSON body are framed exactly', () => {
  const bytes = frameHttpRequest('10.0.0.5', { method: 'POST', path: '/api/x', token: 'tok', body: '{"a":"é"}' });
  const text = Buffer.from(bytes).toString('utf8');
  assert.equal(
    text,
    'POST /api/x HTTP/1.1\r\nHost: 10.0.0.5\r\nConnection: keep-alive\r\nAuthorization: Bearer tok\r\n' +
      'Content-Type: application/json\r\nContent-Length: 10\r\n\r\n{"a":"é"}',
  );
  const get = Buffer.from(frameHttpRequest('h', { path: '/api/ping' })).toString('utf8');
  assert.equal(get, 'GET /api/ping HTTP/1.1\r\nHost: h\r\nConnection: keep-alive\r\n\r\n');
});
