import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCustomPadInputs, normalizeCustomPad, type CustomPad } from '../customPad.ts';
import { normalizeCustomPresets, normalizePadPreset } from '../padPresets.ts';
const custom: CustomPad = { version: 1, id: 'custom-test', name: 'My farm', bindings: { a: { output: 'x', label: 'Tool' }, b: { output: 'x', label: 'Also tool' }, x: { output: 'rt', label: 'Trigger' } } };
function fixture() {
  const events: string[] = [];
  const sink = (key: string) => ({ onDown: () => { events.push(`${key}+`); }, onUp: () => { events.push(`${key}-`); } });
  return { events, input: createCustomPadInputs(custom, { btn: sink, trig: sink }) };
}
test('two sources sharing one output release independently; repeated down/up ignored', () => {
  const { input, events } = fixture();
  input.btn('a').onDown(); input.btn('a').onDown(); input.btn('b').onDown(); input.btn('a').onUp();
  assert.deepEqual(events, ['x+']); input.btn('b').onUp(); input.btn('b').onUp();
  assert.deepEqual(events, ['x+', 'x-']);
});
test('cross-kind mappings coexist and teardown releases once and rejects late events', () => {
  const { input, events } = fixture();
  input.btn('x').onDown(); input.trig('rt').onDown(); input.btn('a').onDown();
  input.dispose(); input.dispose(); input.btn('x').onUp(); input.btn('b').onDown();
  assert.deepEqual(events, ['rt+', 'x+', 'rt-', 'x-']);
});
test('unchanged system buttons keep their outputs', () => {
  const { input, events } = fixture(); input.btn('guide').onDown(); input.btn('guide').onUp();
  assert.deepEqual(events, ['guide+', 'guide-']);
});
test('schema drops unsafe actions, bounds text, rejects unknown versions and IDs', () => {
  assert.equal(normalizeCustomPad({ ...custom, version: 2 }), undefined);
  assert.equal(normalizeCustomPad({ ...custom, id: '__proto__' }), undefined);
  assert.equal(normalizeCustomPad({ ...custom, name: ' '.repeat(4) }), undefined);
  const p = normalizeCustomPad({ ...custom, bindings: { a: { output: 'exec', label: 'Oops' }, b: { output: 'x', label: 'b'.repeat(29) }, x: custom.bindings.x } });
  assert.deepEqual(p?.bindings, { x: custom.bindings.x });
});
test('per-box data survives JSON roundtrip; duplicates and invalid entries are dropped', () => {
  const p = { version: 1, id: 'stardew', size: 'larger', custom };
  assert.deepEqual(normalizePadPreset(JSON.parse(JSON.stringify(p))), p);
  assert.deepEqual(normalizeCustomPresets([p,p,{}, { ...p, custom: { ...custom, id: 'bad' } }]), [p]);
  assert.equal(normalizeCustomPresets(Array.from({ length: 30 }, (_, i) => ({ ...p, custom: { ...custom, id: `custom-${i}` } }))).length, 20);
  assert.equal(normalizePadPreset({ ...p, id: 'unknown' }).custom, undefined);
  assert.deepEqual(normalizePadPreset({ version: 1, id: 'current', size: 'standard' }), { version: 1, id: 'current', size: 'standard' });
});
