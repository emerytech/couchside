import { test } from 'node:test';
import assert from 'node:assert/strict';
import { portraitPadMetrics } from '../portraitPad.ts';
test('portrait controls fit 320 through tablet widths without shrinking touch targets below 44', () => {
  for (const screen of [320, 360, 375, 390, 393, 414, 430, 768]) {
    const w = screen - 24, m = portraitPadMetrics(w);
    assert.ok(m.button >= 44);
    assert.ok(6 * m.button + 24 <= w);
    assert.ok(2 * (m.stick + 44 + 8) + 8 <= w);
    assert.equal(m.clusterHeight, 3 * m.button + 8);
  }
});
test('alps width fits both rows and larger phones retain original sizes', () => {
  assert.deepEqual(portraitPadMetrics(336), { button: 52, stick: 112, clusterHeight: 164 });
  assert.deepEqual(portraitPadMetrics(406), { button: 58, stick: 132, clusterHeight: 182 });
});
