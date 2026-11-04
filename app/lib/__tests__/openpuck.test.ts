import test from 'node:test';
import assert from 'node:assert/strict';
import { comparePuckFirmware, puckCheckMessage } from '../openpuck.ts';
test('installed device build determines update need, not the agent pin', () => {
  assert.equal(comparePuckFirmware('0.9.39', '0.9.40'), 'older');
  assert.equal(comparePuckFirmware('0.9.40', '0.9.40'), 'current');
  assert.equal(comparePuckFirmware('0.9.41', '0.9.40'), 'newer');
  assert.equal(comparePuckFirmware('0.9.40-custom', '0.9.41'), 'unknown');
  assert.equal(comparePuckFirmware('0.9.40', '0.9.41', true), 'unknown');
});
test('USB pass does not imply wireless or full controller validation', () => {
  assert.match(puckCheckMessage({ ok: true, usb_ok: true, wireless_ok: false, responses: 20 }), /Wireless input not confirmed/);
  assert.match(puckCheckMessage({ ok: true, usb_ok: true, wireless_ok: true, responses: 20 }), /does not verify every button/);
  assert.doesNotMatch(puckCheckMessage({ ok: false, error: 'Disconnected' }), /passed|confirmed/);
});
