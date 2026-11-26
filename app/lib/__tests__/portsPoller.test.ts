import test from 'node:test';
import assert from 'node:assert/strict';
import { PortsPoller, PORTS_BUSY_MS, PORTS_IDLE_MS, type PortsPollState } from '../portsPoller.ts';
import type { PortsState } from '../api';

const snapshot = (running: boolean, jobId = 'first'): PortsState => ({
  allowed: true, ports: [], install: {
    id: 'fixture', job_id: jobId, mode: 'install', running, started: 1,
    finished: running ? null : 2, exit_code: running ? null : 0, ok: running ? null : true,
    requires_user_files: false, user_files_prompt: null, lines: [],
  },
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((a, b) => { resolve = a; reject = b; });
  return { promise, resolve, reject };
}
class Clock {
  tasks = new Map<number, { fn: () => void; ms: number }>();
  seq = 0;
  set = (fn: () => void, ms: number) => { const id = ++this.seq; this.tasks.set(id, { fn, ms }); return id; };
  clear = (id: unknown) => { this.tasks.delete(id as number); };
  next() { assert.equal(this.tasks.size, 1); const [id, task] = [...this.tasks][0]; this.tasks.delete(id); task.fn(); return task.ms; }
}
const settle = async () => { await Promise.resolve(); await Promise.resolve(); };

test('busy completion changes cadence; a later job replaces the prior completion', async () => {
  const clock = new Clock(); const poller = new PortsPoller(clock);
  const replies = [snapshot(true), snapshot(false), snapshot(true, 'second'), snapshot(false, 'second')];
  let current!: PortsPollState;
  poller.start('box', async () => replies.shift()!, (s) => { current = s; });
  await settle(); assert.equal(current.data?.install?.running, true);
  assert.equal(clock.next(), PORTS_BUSY_MS); await settle();
  assert.equal(current.data?.install?.running, false);
  assert.equal(clock.next(), PORTS_IDLE_MS); await settle();
  assert.equal(current.data?.install?.job_id, 'second');
  assert.equal(clock.next(), PORTS_BUSY_MS); await settle();
  assert.equal(current.data?.install?.ok, true); poller.stop();
});

test('box switch clears old data immediately and drops delayed old-host reply', async () => {
  const clock = new Clock(); const poller = new PortsPoller(clock);
  const a = deferred<PortsState | null>(); const b = deferred<PortsState | null>();
  let current!: PortsPollState;
  poller.start('A', () => a.promise, (s) => { current = s; });
  poller.start('B', () => b.promise, (s) => { current = s; });
  assert.equal(current.data, null);
  b.resolve(snapshot(true, 'B')); await settle();
  a.resolve(snapshot(false, 'A')); await settle();
  assert.equal((current as PortsPollState).data?.install?.job_id, 'B'); assert.equal(clock.tasks.size, 1); poller.stop();
});

test('background/blur ignores late reply; reconnect same box immediately fetches fresh state', async () => {
  const clock = new Clock(); const poller = new PortsPoller(clock);
  const old = deferred<PortsState | null>(); let updates = 0; let current!: PortsPollState;
  const change = (s: PortsPollState) => { updates++; current = s; };
  poller.start('box', () => old.promise, change); poller.stop();
  old.resolve(snapshot(true, 'old')); await settle();
  assert.equal(updates, 1); assert.equal(clock.tasks.size, 0);
  poller.start('box', async () => snapshot(false, 'reconnected'), change); await settle();
  assert.equal(current.data?.install?.job_id, 'reconnected'); assert.equal(current.data?.install?.ok, true); poller.stop();
});

test('refresh invalidates an outstanding request, including its error and timer', async () => {
  const clock = new Clock(); const poller = new PortsPoller(clock);
  const old = deferred<PortsState | null>(); let calls = 0; let current!: PortsPollState;
  poller.start('box', () => ++calls === 1 ? old.promise : Promise.resolve(snapshot(true, 'fresh')), (s) => { current = s; });
  poller.refresh(); await settle(); old.reject(new Error('old timeout')); await settle();
  assert.equal(current.error, null); assert.equal(current.data?.install?.job_id, 'fresh');
  assert.equal(clock.tasks.size, 1); poller.stop();
});

test('temporary disconnection retains known status, retries, then clears error on recovery', async () => {
  const clock = new Clock(); const poller = new PortsPoller(clock);
  let calls = 0; let current!: PortsPollState;
  poller.start('box', async () => { if (++calls === 2) throw new Error('offline'); return snapshot(calls === 1); }, (s) => { current = s; });
  await settle(); clock.next(); await settle();
  assert.equal(current.error?.message, 'offline'); assert.equal(current.data?.install?.running, true);
  assert.equal(clock.next(), PORTS_BUSY_MS); await settle();
  assert.equal(current.error, null); assert.equal(current.data?.install?.ok, true); poller.stop();
});

test('old-agent null response replaces cached catalog and refresh while stopped never fetches', async () => {
  const clock = new Clock(); const poller = new PortsPoller(clock);
  let calls = 0; let current!: PortsPollState;
  poller.start('box', async () => ++calls === 1 ? snapshot(false) : null, (s) => { current = s; });
  await settle(); poller.refresh(); await settle(); assert.equal(current.data, null);
  poller.stop(); poller.refresh(); await settle(); assert.equal(calls, 2); assert.equal(clock.tasks.size, 0);
});


test('PIN pause polls quickly until expiry restores remote access', async () => {
  const clock = new Clock(); const poller = new PortsPoller(clock);
  const base = { ports: [], allowed: false, install: null };
  const pending: PortsState = { ...base, addon: { supported: true, state: 'pending', enabled: false,
    requested_enabled: true, remote_paused: true, expires_in: 2, attempts_remaining: 5 } };
  const expired: PortsState = { ...base, addon: { ...pending.addon!, state: 'expired', remote_paused: false, expires_in: 0 } };
  const replies = [pending, expired]; let current!: PortsPollState;
  poller.start('box', async () => replies.shift()!, (s) => { current = s; });
  await settle(); assert.equal(clock.next(), PORTS_BUSY_MS); await settle();
  assert.equal(current.data?.addon?.remote_paused, false);
  assert.equal(clock.next(), PORTS_IDLE_MS); poller.stop();
});
