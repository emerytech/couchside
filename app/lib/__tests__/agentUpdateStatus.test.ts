import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { agentUpdateStatusText } from '../agentUpdateStatus.ts';
const baseline = { available: false, installed: '0.4.15-win', latest: null };
test('disabled is never reported as up to date', () => {
  assert.equal(agentUpdateStatusText({ ...baseline, disabled: true }), 'Update checks are off on this PC');
});
test('failed checks are distinct from no update', () => {
  assert.equal(agentUpdateStatusText({ ...baseline, error: 'offline' }), 'Could not check for updates');
});
test('old agents retain their existing status', () => {
  assert.equal(agentUpdateStatusText(baseline), 'Up to date — service 0.4.15-win');
  assert.equal(agentUpdateStatusText(null), 'Service updates');
  assert.equal(agentUpdateStatusText({ ...baseline, available: true, latest: '0.4.16-win' }), 'Update available — service 0.4.16-win');
});
