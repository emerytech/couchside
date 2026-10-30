import test from 'node:test';
import assert from 'node:assert/strict';
import { createPadDecisionTouch } from '../padDecisionTouch.ts';
import { createPadTouches } from '../padTouches.ts';
import { createSurfaceInputGate } from '../padSurface.ts';

const hit = { x: 100, y: 50, w: 60, h: 44 };
const point = (identifier: number, x = 120, y = 70) => ({ identifier, x, y });
function button() { const b = createPadDecisionTouch(); b.layout(hit); return b; }

test('Pass completes on its own finger ending while X remains physically held', () => {
  const b = button(), events: string[] = [], gate = createSurfaceInputGate(), token = {};
  gate.activate(token);
  const pad = createPadTouches([{ id: 'x', kind: 'button', hit: { x: 0, y: 0, w: 40, h: 40 }, action: { kind: 'button', key: 'x' } }], [], {
    action: gate.wrap(token, (_, down) => events.push(down ? 'x down' : 'x up')),
    stick() {},
  });
  const held = point(0, 10, 10), pass = point(9);
  pad.start([held]); b.start([pass]);
  assert.deepEqual(events, ['x down']);
  assert.equal(b.end([pass]), true); // finger 0 has NOT ended
  // Same order as PAD Pass: retire callbacks, send neutral, then grant control.
  gate.revoke(); events.push('release all', 'grant');
  pad.move([held]); pad.end([held]);
  assert.deepEqual(events, ['x down', 'release all', 'grant']);
  assert.equal(b.end([pass]), false);
});

test('an unrelated finger ending does not activate or release the decision', () => {
  const b = button(); b.start([point(0)]);
  assert.equal(b.end([point(7)]), false); assert.equal(b.pressed(), true);
  assert.equal(b.end([point(0)]), true); assert.equal(b.pressed(), false);
});

test('touch-down and movement do not choose Pass or Keep', () => {
  const b = button(); assert.equal(b.start([point(3)]), undefined);
  assert.equal(b.move([point(3, 130, 75)]), undefined);
  assert.equal(b.end([point(3, 130, 75)]), true);
});

test('dragging out then back cannot accidentally grant control', () => {
  const b = button(); b.start([point(3)]); b.move([point(3, 300)]);
  assert.equal(b.pressed(), false); b.move([point(3)]);
  assert.equal(b.end([point(3)]), false);
});

test('outside start or outside end cannot activate a decision', () => {
  const b = button(); b.start([point(3, 20)]); b.move([point(3)]);
  assert.equal(b.end([point(3)]), false);
  b.start([point(4)]); assert.equal(b.end([point(4, 500)]), false);
});

test('cancellation and layout replacement discard late end events', () => {
  const b = button(); b.start([point(1)]); b.cancel(); assert.equal(b.end([point(1)]), false);
  b.start([point(1)]); b.layout(hit); assert.equal(b.end([point(1)]), false);
  b.start([point(1)]); b.layout(null); assert.equal(b.end([point(1)]), false);
  b.start([point(2)]); assert.equal(b.end([point(2)]), false);
});

test('two fingers on one decision activate at most once', () => {
  const b = button(); b.start([point(8), point(2)]);
  assert.equal(b.end([point(2), point(8)]), true);
  assert.equal(b.end([point(8)]), false);
});

test('Keep does not adopt a finger that started on Pass', () => {
  const pass = button(), keep = createPadDecisionTouch();
  keep.layout({ ...hit, x: 200 }); pass.start([point(1)]);
  pass.move([point(1, 220)]); keep.move([point(1, 220)]);
  assert.equal(pass.end([point(1, 220)]), false);
  assert.equal(keep.end([point(1, 220)]), false);
});

test('malformed touch coordinates and identifiers are ignored', () => {
  const b = button(); b.start([point(NaN), point(3, Infinity)]);
  assert.equal(b.pressed(), false); assert.equal(b.end([point(3)]), false);
  b.start([point(4)]); assert.equal(b.end([point(4, NaN)]), false);
});
