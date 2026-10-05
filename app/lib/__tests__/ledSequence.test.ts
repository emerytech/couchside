import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeSequenceTemplate } from '../ledSequence.ts';
test('double flash has two explicit dark delays with matching timing', () => {
  const s = makeSequenceTemplate('double-flash', 17, { r: 255, g: 40, b: 0 });
  assert.deepEqual(s.holds, [100,120,100,1500]);
  assert.equal(s.frames[1].filter(Boolean).length, 0);
  assert.equal(s.frames[3].filter(Boolean).length, 0);
});
test('all templates fit the device frame budget and do not share mutable colors', () => {
  for (const kind of ['double-flash','fade','flicker'] as const) {
    const s = makeSequenceTemplate(kind, 17, { r: 255, g: 40, b: 0 });
    assert.equal(s.frames.length, s.holds.length);
    assert.ok(s.frames.length <= 64);
    assert.ok(s.holds.every(h => h >= 30 && h <= 60000));
    assert.ok(s.frames.every(f => f.length === 17));
    const f = s.frames.find(f => f[0] != null)!;
    assert.notEqual(f[0], f[1]);
  }
});
