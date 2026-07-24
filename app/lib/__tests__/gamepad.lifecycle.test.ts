/**
 * GamepadClient socket-lifecycle tests — the safety-critical input path
 * (CLAUDE.md §4). No RN, no bundler: gamepad.ts only touches a global
 * `WebSocket` and Date/timers, so we mock WebSocket + a controllable clock and
 * drive the client directly.
 *
 * Run: from app/, `node --experimental-strip-types --test lib/__tests__/*.test.ts`
 * (Node >= 22.6). Wired into CI as the "gamepad-lifecycle" job.
 *
 * Regression under test: a torn-down socket (this.ws === null) must NOT be left
 * behind by connect()/ensureLive() over a stale 'connected' status — that was
 * the "green pill, dead mouse, force-quit to recover" zombie.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

// ---- controllable clock (ensureLive/watchdog compare Date.now to lastInbound)
let NOW = 1_000_000;
const realDateNow = Date.now;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(Date as any).now = () => NOW;

// ---- mock WebSocket -------------------------------------------------------
type Handler = ((ev: unknown) => void) | null;
class MockWebSocket {
  static instances: MockWebSocket[] = [];
  static reset() {
    MockWebSocket.instances = [];
  }
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  url: string;
  readyState = 0; // CONNECTING
  onopen: Handler = null;
  onmessage: Handler = null;
  onerror: Handler = null;
  onclose: Handler = null;
  sent: string[] = [];

  constructor(url: string) {
    this.url = url;
    MockWebSocket.instances.push(this);
  }
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    if (this.readyState === 3) return;
    this.readyState = 3;
    if (this.onclose) this.onclose({});
  }
  /** Simulate the real open + `hello` handshake that drives status→connected. */
  openAndHello(dev = 'mock pad') {
    this.readyState = 1; // OPEN
    if (this.onopen) this.onopen({});
    if (this.onmessage) this.onmessage({ data: JSON.stringify({ t: 'hello', dev }) });
  }
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).WebSocket = MockWebSocket;

// Import AFTER the WebSocket global is installed.
const { GamepadClient } = await import('../gamepad.ts');

const CONN = { host: 'box.local', port: 8787, token: 'tok', lastIp: '10.0.0.5' };

function freshClient() {
  MockWebSocket.reset();
  NOW = 1_000_000;
  return new GamepadClient();
}

test('connect() drives to connected via the hello handshake', () => {
  const c = freshClient();
  c.connect(CONN, { deviceName: 'phone' });
  assert.equal(MockWebSocket.instances.length, 1, 'one socket opened');
  MockWebSocket.instances[0].openAndHello();
  assert.equal(c.getStatus(), 'connected');
  c.close();
});

test('ZOMBIE FIX: connect() rebuilds a torn-down socket instead of no-oping', () => {
  const c = freshClient();
  c.connect(CONN, { deviceName: 'phone' });
  MockWebSocket.instances[0].openAndHello();
  assert.equal(c.getStatus(), 'connected');

  // The noPad toggle calls teardownSocket(false) (nulls this.ws) but leaves
  // status 'connected'. Pre-fix, the connect() guard saw 'connected' and
  // returned WITHOUT opening — a null-socket zombie. Post-fix, wsAlive is false
  // so it falls through to open().
  c.connect(CONN, { noPad: true });
  assert.equal(
    MockWebSocket.instances.length,
    2,
    'connect() must open a new socket over the torn-down one, not no-op',
  );
  c.close();
});

test('ensureLive(): no-op on a fresh OPEN socket', () => {
  const c = freshClient();
  c.connect(CONN);
  MockWebSocket.instances[0].openAndHello();
  c.ensureLive();
  assert.equal(MockWebSocket.instances.length, 1, 'a live socket is left alone');
  c.close();
});

test('ensureLive(): reconnects an OPEN-but-stale (half-dead) socket', () => {
  const c = freshClient();
  c.connect(CONN);
  MockWebSocket.instances[0].openAndHello(); // lastInbound = NOW
  // Socket still says OPEN, but no inbound frame for > 2.5 ping intervals: the
  // pipe is half-dead. connect() can't see this (readyState OPEN); ensureLive can.
  NOW += 5_000 * 2.5 + 1;
  c.ensureLive();
  assert.equal(MockWebSocket.instances.length, 2, 'stale OPEN socket is rebuilt');
  c.close();
});

test('ensureLive(): reconnects when the socket has closed under us', () => {
  const c = freshClient();
  c.connect(CONN);
  const ws0 = MockWebSocket.instances[0];
  ws0.openAndHello();
  ws0.readyState = 3; // CLOSED, without an onclose (e.g. app was suspended)
  c.ensureLive();
  assert.equal(MockWebSocket.instances.length, 2, 'a CLOSED socket is rebuilt');
  c.close();
});

test('ensureLive(): no-op when not active (never connected / after close)', () => {
  const c = freshClient();
  c.ensureLive(); // active === false
  assert.equal(MockWebSocket.instances.length, 0, 'no socket opened while inactive');
});

test('normal background→foreground still reconnects (close then connect)', () => {
  const c = freshClient();
  c.connect(CONN);
  MockWebSocket.instances[0].openAndHello();
  c.close(); // background
  assert.equal(c.getStatus(), 'closed');
  c.connect(CONN); // foreground
  assert.equal(MockWebSocket.instances.length, 2, 'foreground opens a fresh socket');
  c.close();
});

// restore the clock so a leaked reference can't confuse other files
process.on('exit', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (Date as any).now = realDateNow;
});
