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

test('isStale(): false on a fresh connection, true once the socket goes silent', () => {
  const c = freshClient();
  c.connect(CONN);
  MockWebSocket.instances[0].openAndHello(); // lastInbound = NOW
  assert.equal(c.isStale(), false, 'a fresh connection is not stale');
  NOW += 5_000 * 1.3 + 1; // past 1.3 ping intervals with no inbound frame
  assert.equal(c.isStale(), true, 'a silent OPEN socket reads stale');
  c.close();
});

test('isStale(): false whenever not connected', () => {
  const c = freshClient();
  assert.equal(c.isStale(), false, 'never connected');
  c.connect(CONN);
  MockWebSocket.instances[0].openAndHello();
  c.close();
  assert.equal(c.isStale(), false, 'after close');
});

test('reconnect(): forces a fresh socket even while still OPEN (pill tap-to-retry)', () => {
  const c = freshClient();
  c.connect(CONN);
  MockWebSocket.instances[0].openAndHello();
  // Still OPEN and only mildly stale (1.4 intervals): connect()/ensureLive would
  // no-op, but an explicit user tap must rebuild the socket.
  NOW += 5_000 * 1.4;
  c.reconnect();
  assert.equal(MockWebSocket.instances.length, 2, 'reconnect() opens a fresh socket');
  c.close();
});

test('reconnect(): no-op when not active', () => {
  const c = freshClient();
  c.reconnect();
  assert.equal(MockWebSocket.instances.length, 0);
});

// --- foreground-freeze recovery (the "green pill, dead mouse" field case) -----
// A foreground JS freeze leaves the socket OPEN but silent: no AppState event
// fires (no background transition), the ping timer + pong watchdog are frozen,
// and the box now keepalives the TCP so onclose never fires. The user's gesture
// is the only signal left. These lock the two recovery paths that gesture drives.

test('input-driven recovery: a swipe on a stale OPEN socket rebuilds it', () => {
  const c = freshClient();
  c.connect(CONN);
  MockWebSocket.instances[0].openAndHello(); // connected, lastInbound = NOW
  NOW += 5_000 * 2.5 + 1; // silent past the watchdog window (frozen, socket still OPEN)
  c.sendMouseMove(5, 5); // the user swipes
  assert.equal(
    MockWebSocket.instances.length,
    2,
    'a swipe on a stale-but-OPEN socket must rebuild, not vanish into the void',
  );
  c.close();
});

test('input-driven recovery: a swipe on a FRESH socket just sends (control)', () => {
  const c = freshClient();
  c.connect(CONN);
  const ws0 = MockWebSocket.instances[0];
  ws0.openAndHello(); // lastInbound = NOW (fresh)
  c.sendMouseMove(5, 5);
  assert.equal(MockWebSocket.instances.length, 1, 'a live socket is never rebuilt by input');
  assert.ok(
    ws0.sent.some((m) => m.includes('"t":"m"')),
    'the move frame was actually sent on the live socket',
  );
  c.close();
});

test('freshness guard: connect() rebuilds an OPEN-but-stale zombie (tab-focus path)', () => {
  const c = freshClient();
  c.connect(CONN);
  MockWebSocket.instances[0].openAndHello();
  // The tab-focus listener calls connect() WITHOUT ensureLive(). Pre-fix it saw
  // readyState OPEN and no-oped, stranding the zombie. Post-fix, staleness rebuilds.
  NOW += 5_000 * 2.5 + 1;
  c.connect(CONN);
  assert.equal(MockWebSocket.instances.length, 2, 'connect() rebuilds a stale OPEN socket');
  c.close();
});

test('freshness guard: connect() still no-ops over a FRESH OPEN socket (control)', () => {
  const c = freshClient();
  c.connect(CONN);
  MockWebSocket.instances[0].openAndHello();
  c.connect(CONN); // same conn, socket fresh — must not churn
  assert.equal(MockWebSocket.instances.length, 1, 'a fresh connected socket is not rebuilt');
  c.close();
});

// --- diagnostics counters ----------------------------------------------------
// The on-Pad panel is only useful if these counters actually discriminate. A
// counter that never moves would quietly send the next investigation down the
// wrong path, so each is asserted to move in ITS case and not in the others.

test('diagnostics: inputSends counts frames that really left the socket', async () => {
  const { getWsTrace } = await import('../gamepad.ts');
  const c = freshClient();
  c.connect(CONN);
  MockWebSocket.instances[0].openAndHello();
  const before = getWsTrace().inputSends;
  c.sendMouseMove(3, 4);
  assert.equal(getWsTrace().inputSends, before + 1, 'a sent move increments inputSends');
  c.close();
});

test('diagnostics: a drop on a dead socket counts as inputDropped, not inputSends', async () => {
  const { getWsTrace } = await import('../gamepad.ts');
  const c = freshClient();
  c.connect(CONN);
  const ws0 = MockWebSocket.instances[0];
  ws0.openAndHello();
  ws0.readyState = 3; // CLOSED under us, no onclose (the suspended-app case)
  const sends = getWsTrace().inputSends;
  const drops = getWsTrace().inputDropped;
  c.sendMouseButton('l', 1);
  assert.equal(getWsTrace().inputSends, sends, 'a dropped frame must NOT count as sent');
  assert.equal(getWsTrace().inputDropped, drops + 1, 'it counts as dropped');
  c.close();
});

test('diagnostics: getDiagnostics reports the recovery predicate honestly', () => {
  const c = freshClient();
  c.connect(CONN);
  MockWebSocket.instances[0].openAndHello();
  assert.equal(c.getDiagnostics().staleByWatchdog, false, 'fresh socket is not stale');
  assert.equal(c.getDiagnostics().status, 'connected');
  assert.equal(c.getDiagnostics().socket, 'open');
  // Past the watchdog window the panel must say the recovery is ARMED — that is
  // exactly what "why didn't it fire?" needs answered during an episode.
  NOW += 5_000 * 2.5 + 1;
  assert.equal(c.getDiagnostics().staleByWatchdog, true, 'silent socket reads stale');
  assert.ok(c.getDiagnostics().inboundAgeMs > 12_500, 'inbound age reflects the silence');
  c.close();
});

test('diagnostics: recoveries counts the input-driven rebuild', async () => {
  const { getWsTrace } = await import('../gamepad.ts');
  const c = freshClient();
  c.connect(CONN);
  MockWebSocket.instances[0].openAndHello();
  const before = getWsTrace().recoveries;
  NOW += 5_000 * 2.5 + 1;      // stale
  c.sendMouseMove(5, 5);       // the swipe that should rebuild
  assert.equal(getWsTrace().recoveries, before + 1, 'the rebuild is counted');
  assert.equal(MockWebSocket.instances.length, 2, 'and it really did reconnect');
  c.close();
});

// restore the clock so a leaked reference can't confuse other files
process.on('exit', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (Date as any).now = realDateNow;
});
