import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fleetHealth } from '../fleetHealth.ts';

test('initial connection is neutral; a transient miss preserves uncertainty', () => {
  assert.equal(fleetHealth(undefined, 1000), 'checking');
  assert.equal(fleetHealth({ error: 'timeout', failures: 1, lastSuccess: 1000 }, 5000), 'reconnecting');
  assert.equal(fleetHealth({ error: 'timeout', failures: 1, lastSuccess: null }, 5000), 'reconnecting');
});
test('repeated failures or stale data become offline; a success recovers immediately', () => {
  assert.equal(fleetHealth({ error: 'timeout', failures: 3, lastSuccess: 1000 }, 5000), 'offline');
  assert.equal(fleetHealth({ error: 'timeout', failures: 1, lastSuccess: 1000 }, 16000), 'offline');
  assert.equal(fleetHealth({ error: null, failures: 0, lastSuccess: 17000 }, 17000), 'online');
});
