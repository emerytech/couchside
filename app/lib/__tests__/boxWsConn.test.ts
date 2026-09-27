/**
 * The pinned WebSocket client: lib/boxWsConn.ts (PinnedWsConn, the core of
 * boxWs.PinnedWebSocket). On a secure box this carries the GAMEPAD, so its
 * lifecycle is tested end to end with a fake pinned socket: connect -> handshake
 * -> open -> frames -> close -> the late events RN still delivers.
 *
 * WHY. RN delivers a destroyed socket's close event (and any bytes already
 * queued) AFTER destroy(). On 2026-09-26 that exact hazard crossed HTTP replies
 * in the pinned pool (boxTlsConn). Here it would hand a CLOSED socket's frames to
 * onmessage: a pad client that has already torn down (and maybe reconnected)
 * would act on a stale frame. The "after close" cases FAIL against the pre-fix
 * class (proved by running this file against a copy of it with only its connect
 * injected). The fake keeps its callbacks after close(), so the class's OWN guard
 * is what is under test.
 *
 * Install-free (no native imports) so it runs in CI's fast strip-types glob.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { Buffer } from 'buffer';

import { PinnedWsConn } from '../boxWsConn.ts';
import type { PinnedSocket } from '../boxTlsConn.ts';
import { OPCODE, encodeFrame } from '../tvdirect/ws.ts';

class FakeSock implements PinnedSocket {
  writes: Uint8Array[] = [];
  closed = 0;
  dataCb: ((b: Uint8Array) => void) | null = null;
  closeCb: (() => void) | null = null;
  write(b: Uint8Array): void {
    this.writes.push(b);
  }
  onData(cb: (b: Uint8Array) => void): void {
    this.dataCb = cb;
  }
  onClose(cb: () => void): void {
    this.closeCb = cb;
  }
  close(): void {
    this.closed += 1; // like RN: no synchronous close event, callbacks stay attached
  }
  emit(b: Uint8Array): void {
    this.dataCb?.(b);
  }
}

const tick = () => new Promise<void>((r) => setTimeout(r, 0));
const UPGRADE = new Uint8Array(Buffer.from('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n'));
const serverText = (s: string) => encodeFrame(OPCODE.text, new Uint8Array(Buffer.from(s)), new Uint8Array(4)); // mask 0 = plain

async function openWs() {
  const sock = new FakeSock();
  const ws = new PinnedWsConn('10.0.0.5', '/ws/pad', () => Promise.resolve(sock));
  const log: string[] = [];
  ws.onopen = () => log.push('open');
  ws.onmessage = (ev) => log.push(`msg:${String(ev.data)}`);
  ws.onclose = () => log.push('close');
  ws.onerror = () => log.push('error');
  await tick();
  return { sock, ws, log };
}

test('lifecycle: handshake -> open -> message -> send -> close', async () => {
  const { sock, ws, log } = await openWs();
  const hs = Buffer.from(sock.writes[0]).toString('utf8');
  assert.match(hs, /^GET \/ws\/pad HTTP\/1\.1\r\n/);
  assert.match(hs, /Upgrade: websocket/);
  sock.emit(UPGRADE);
  assert.equal(ws.readyState, PinnedWsConn.OPEN);
  sock.emit(serverText('hello'));
  ws.send('{"t":"btn"}');
  assert.equal(sock.writes.length, 2, 'one handshake + one masked frame');
  ws.close();
  assert.equal(ws.readyState, PinnedWsConn.CLOSED);
  assert.ok(sock.closed >= 1, 'socket closed');
  assert.deepEqual(log, ['open', 'msg:hello', 'close']);
});

test('after close(), frames the old socket still delivers never reach onmessage', async () => {
  const { sock, ws, log } = await openWs();
  sock.emit(UPGRADE);
  ws.close();
  sock.emit(serverText('stale')); // queued bytes RN delivers after destroy()
  assert.deepEqual(log, ['open', 'close'], `stale frame delivered after close: ${JSON.stringify(log)}`);
});

test('frames that follow a close frame in the same chunk are not delivered', async () => {
  const { sock, log } = await openWs();
  sock.emit(UPGRADE);
  const closeFrame = encodeFrame(OPCODE.close, new Uint8Array(0), new Uint8Array(4));
  const after = serverText('after-close');
  const chunk = new Uint8Array(closeFrame.length + after.length);
  chunk.set(closeFrame);
  chunk.set(after, closeFrame.length);
  sock.emit(chunk);
  assert.deepEqual(log, ['open', 'close'], `frame after the close frame delivered: ${JSON.stringify(log)}`);
});

test('control: a late close event after close() fires onclose exactly once', async () => {
  const { sock, ws, log } = await openWs();
  sock.emit(UPGRADE);
  ws.close();
  sock.closeCb?.();
  assert.deepEqual(log, ['open', 'close']);
});

test('control: closed before the connect resolves -> the socket is closed, nothing written, no open', async () => {
  const sock = new FakeSock();
  let resolveConnect: ((s: PinnedSocket) => void) | null = null;
  const ws = new PinnedWsConn('10.0.0.5', '/ws/pad', () => new Promise<PinnedSocket>((r) => { resolveConnect = r; }));
  const log: string[] = [];
  ws.onopen = () => log.push('open');
  ws.onclose = () => log.push('close');
  ws.close();
  resolveConnect!(sock);
  await tick();
  assert.equal(sock.closed, 1);
  assert.equal(sock.writes.length, 0);
  assert.deepEqual(log, ['close']);
});

test('control: a refused connect -> onerror then onclose, once', async () => {
  const ws = new PinnedWsConn('10.0.0.5', '/ws/pad', () => Promise.reject(new Error('ECONNREFUSED')));
  const log: string[] = [];
  ws.onerror = () => log.push('error');
  ws.onclose = () => log.push('close');
  await tick();
  assert.deepEqual(log, ['error', 'close']);
  assert.equal(ws.readyState, PinnedWsConn.CLOSED);
});
