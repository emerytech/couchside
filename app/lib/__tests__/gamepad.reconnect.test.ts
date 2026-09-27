/**
 * GamepadClient reconnect-backoff test — the "~8s dead cursor" half of the
 * Android gamepad-churn bug (fix/android-gamepad-churn).
 *
 * A drop on a secure box re-runs the pinned connect (TLS handshake + modulus
 * cert-poll). Pre-fix, that dial could be aborted by the 4s connect watchdog while
 * still verifying, so the socket never reached OPEN and `attempt` — which reset ONLY
 * on a server `hello` frame — never reset. Each aborted dial then stacked the
 * backoff (150 -> 1000 -> 2000 -> 4000), a ~8s window of frozen cursor.
 *
 * The fix resets `attempt` the moment the socket reaches OPEN (gamepad.ts onopen),
 * so a socket that connects and then drops always retries in ~one step. This drives
 * that with a mock WebSocket that reaches OPEN but never sends `hello`, dropping each
 * time, and asserts the reconnect delay does NOT climb. It FAILS on the pre-fix logic
 * (delays [150, 1000, 2000]).
 *
 * No RN, no bundler: gamepad.ts only touches a global WebSocket + Date/timers, and
 * the (plaintext) mock never reaches the native pinned transport. Timers are fully
 * controllable so the backoff schedule is read without waiting real seconds.
 *
 * Run: from app/, `node --experimental-strip-types --test lib/__tests__/*.test.ts`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

// ---- frozen clock (gamepad compares Date.now to lastInbound) ---------------
let NOW = 1_000_000;
const realDateNow = Date.now;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(Date as any).now = () => NOW;

// ---- mock WebSocket --------------------------------------------------------
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
  /**
   * Reach OPEN but send NO `hello`. This is the exact shape of the bug: a dial that
   * connects the socket but drops before the server frame that used to be the only
   * thing that reset the reconnect backoff.
   */
  openNoHello() {
    this.readyState = 1; // OPEN
    if (this.onopen) this.onopen({});
  }
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).WebSocket = MockWebSocket;

// Import AFTER the WebSocket global is installed (real timers still active here).
const { GamepadClient } = await import('../gamepad.ts');

const CONN = { host: 'box.local', port: 8787, token: 'tok', lastIp: '10.0.0.5' };

test('reconnect backoff does NOT stack across a drop right after connecting (~one step each)', () => {
  // Controllable timers, confined to this synchronous test so node:test's own
  // machinery keeps the real ones. setTimeout is queued (never auto-fires) so the
  // scheduled reconnect delay can be read; setInterval (the keepalive) is tracked
  // but never fired, so the pong watchdog can't interfere.
  const realST = globalThis.setTimeout;
  const realCT = globalThis.clearTimeout;
  const realSI = globalThis.setInterval;
  const realCI = globalThis.clearInterval;
  type Timer = { id: number; fn: (...a: unknown[]) => void; delay: number };
  let idc = 1;
  let timeouts: Timer[] = [];
  const intervals = new Map<number, Timer>();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).setTimeout = (fn: any, delay: any) => {
    const id = idc++;
    timeouts.push({ id, fn, delay: Number(delay) || 0 });
    return id;
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).clearTimeout = (id: any) => {
    timeouts = timeouts.filter((t) => t.id !== id);
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).setInterval = (fn: any, delay: any) => {
    const id = idc++;
    intervals.set(id, { id, fn, delay: Number(delay) || 0 });
    return id;
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).clearInterval = (id: any) => {
    intervals.delete(id);
  };
  const restore = () => {
    globalThis.setTimeout = realST;
    globalThis.clearTimeout = realCT;
    globalThis.setInterval = realSI;
    globalThis.clearInterval = realCI;
  };

  try {
    MockWebSocket.reset();
    NOW = 1_000_000;
    const c = new GamepadClient();
    c.connect(CONN, { deviceName: 'phone' });

    const delays: number[] = [];
    for (let cycle = 0; cycle < 3; cycle++) {
      const ws = MockWebSocket.instances[MockWebSocket.instances.length - 1];
      ws.openNoHello(); // reaches OPEN -> clears the connect watchdog (+ resets backoff on the fix)
      ws.close(); // drops immediately -> onclose -> scheduleReconnect(setTimeout(delay))
      // With the connect watchdog cleared on open, the only pending timeout is the
      // reconnect timer just scheduled.
      assert.equal(timeouts.length, 1, `cycle ${cycle}: exactly one pending timer (the reconnect)`);
      delays.push(timeouts[0].delay);
      // Fire it to dial the next socket, exactly as the real timer would.
      const rc = timeouts.shift()!;
      rc.fn();
    }

    // The fix: every reconnect starts from a reset backoff, so ~one step (150ms) each.
    // Pre-fix, `attempt` only reset on a `hello` that never came, so the aborted dials
    // stacked: [150, 1000, 2000] (climbing toward the ~8s dead window).
    assert.deepEqual(delays, [150, 150, 150], `backoff stacked across drops: ${JSON.stringify(delays)}`);

    c.close();
  } finally {
    restore();
  }
});

// A control alongside the stacking test: a socket that never even OPENs (a dead
// target — the mock stays CONNECTING) MUST still back off, so the fix does not turn a
// genuinely-down box into a 150ms hot loop.
test('control: dials that never reach OPEN still back off (dead target)', () => {
  const realST = globalThis.setTimeout;
  const realCT = globalThis.clearTimeout;
  const realSI = globalThis.setInterval;
  const realCI = globalThis.clearInterval;
  type Timer = { id: number; fn: (...a: unknown[]) => void; delay: number };
  let idc = 1;
  let timeouts: Timer[] = [];
  const intervals = new Map<number, Timer>();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).setTimeout = (fn: any, delay: any) => {
    const id = idc++;
    timeouts.push({ id, fn, delay: Number(delay) || 0 });
    return id;
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).clearTimeout = (id: any) => {
    timeouts = timeouts.filter((t) => t.id !== id);
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).setInterval = (fn: any, delay: any) => {
    const id = idc++;
    intervals.set(id, { id, fn, delay: Number(delay) || 0 });
    return id;
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).clearInterval = (id: any) => {
    intervals.delete(id);
  };
  const restore = () => {
    globalThis.setTimeout = realST;
    globalThis.clearTimeout = realCT;
    globalThis.setInterval = realSI;
    globalThis.clearInterval = realCI;
  };

  try {
    MockWebSocket.reset();
    NOW = 1_000_000;
    const c = new GamepadClient();
    c.connect(CONN, { deviceName: 'phone' });

    const delays: number[] = [];
    for (let cycle = 0; cycle < 3; cycle++) {
      // The socket stays CONNECTING; fire the connect watchdog to abort it, exactly
      // as the real 4s timer would on a stale/dead address.
      const watchdog = timeouts.find((t) => t.delay === 4000);
      assert.ok(watchdog, `cycle ${cycle}: the connect watchdog is armed`);
      timeouts = timeouts.filter((t) => t.id !== watchdog!.id);
      watchdog!.fn(); // -> teardown + scheduleReconnect
      const rc = timeouts.find((t) => t.delay !== 4000);
      assert.ok(rc, `cycle ${cycle}: a reconnect was scheduled`);
      delays.push(rc!.delay);
      timeouts = timeouts.filter((t) => t.id !== rc!.id);
      rc!.fn(); // dial again (still never opens)
    }

    // No socket ever reached OPEN, so backoff climbs — this is correct behaviour and
    // the reset-on-open fix must not flatten it.
    assert.deepEqual(delays, [150, 1000, 2000], `a dead target must back off: ${JSON.stringify(delays)}`);

    c.close();
  } finally {
    restore();
  }
});

// restore the clock so a leaked reference can't confuse other files
process.on('exit', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (Date as any).now = realDateNow;
});
