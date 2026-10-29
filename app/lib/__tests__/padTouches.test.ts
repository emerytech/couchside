import test from 'node:test';
import assert from 'node:assert/strict';
import { createPadTouches, type PadAction, type PadControl } from '../padTouches.ts';
import { padTouchControls } from '../padTouchLayouts.ts';
import { padLayout, stardewLayout, moveLayout, type PadLayout } from '../padLayout.ts';
import { createSurfaceInputGate } from '../padSurface.ts';
const point = (identifier: number, x: number, y: number) => ({ identifier, x, y });
const button = (id: string, key: 'x' | 'a' | 'du' | 'dd' = 'x', x = 100): Extract<PadControl, { kind: 'button' }> => ({ id, hit: { x, y: 0, w: 50, h: 50 }, kind: 'button', action: { kind: 'button', key } });
const stick: PadControl = { id: 'left', hit: { x: 0, y: 0, w: 90, h: 90 }, kind: 'stick', stick: 'l', value: (x, y) => ({ x, y }), click: 'l3' };
function harness(controls: PadControl[] = [stick, button('x')], excluded = [] as { x: number; y: number; w: number; h: number }[]) {
  const events: unknown[][] = [], held = new Set<string>(), axes = new Map<string, number[]>();
  let now = 0, seq = 0;
  const jobs = new Map<number, { at: number; fn: () => void }>();
  const output = { action(a: PadAction, down: boolean) { events.push([a.kind, a.key, down]); if (down) held.add(`${a.kind}:${a.key}`); else held.delete(`${a.kind}:${a.key}`); }, stick(k: string, x: number, y: number) { events.push(['stick', k, x, y]); axes.set(k, [x, y]); } };
  const router = createPadTouches(controls, excluded, output, { now: () => now,
    later(fn, ms) { const id = ++seq; jobs.set(id, { at: now + ms, fn }); return id as unknown as ReturnType<typeof setTimeout>; },
    clear(id) { jobs.delete(id as unknown as number); } });
  const advance = (ms: number) => { const target = now + ms; for (;;) { const next = [...jobs].sort((a, b) => a[1].at - b[1].at)[0]; if (!next || next[1].at > target) break; jobs.delete(next[0]); now = next[1].at; next[1].fn(); } now = target; };
  return { router, events, held, axes, advance, jobs };
}
for (const actionFirst of [false, true]) for (const releaseActionFirst of [false, true]) {
  test(`two fingers independent: actionFirst=${actionFirst}, releaseActionFirst=${releaseActionFirst}`, () => {
    const h = harness(), move = point(0, 10, 10), action = point(9, 110, 10);
    h.router.start(actionFirst ? [action, move] : [move, action]);
    h.router.move([point(0, 50, 10)]);
    assert.deepEqual(h.axes.get('l'), [40, 0]); assert(h.held.has('button:x'));
    h.advance(5000);
    h.router.end([releaseActionFirst ? action : move]);
    assert.equal(h.held.has('button:x'), !releaseActionFirst);
    assert.deepEqual(h.axes.get('l'), releaseActionFirst ? [40, 0] : [0, 0]);
    h.router.end([releaseActionFirst ? move : action]); assert.equal(h.held.size, 0); assert.deepEqual(h.axes.get('l'), [0, 0]);
  });
}
test('two sticks and two actions ignore touch array order and centroids', () => {
  const right = { ...stick, id: 'right', stick: 'r' as const, hit: { x: 200, y: 0, w: 90, h: 90 } };
  const h = harness([stick, right, button('x'), button('a', 'a', 300)]);
  h.router.start([point(7, 210, 10), point(0, 10, 10), point(8, 110, 10), point(4, 310, 10)]);
  h.router.move([point(0, 35, 25), point(7, 200, 50)]);
  assert.deepEqual(h.axes.get('l'), [25, 15]); assert.deepEqual(h.axes.get('r'), [-10, 40]);
  assert.equal(h.held.size, 2); h.router.cancel(); assert.equal(h.held.size, 0);
  assert.deepEqual([...h.axes.values()], [[0, 0], [0, 0]]);
});
test('shared protocol A owners release only after the last owner', () => {
  const h = harness([button('ok', 'a'), button('a', 'a', 200)]);
  h.router.start([point(0, 110, 10), point(1, 210, 10)]); h.router.start([point(0, 110, 10)]);
  h.router.end([point(0, 0, 0)]); assert(h.held.has('button:a'));
  h.router.end([point(1, 0, 0)]); assert.deepEqual(h.events, [['button', 'a', true], ['button', 'a', false]]);
});
test('face roll changes only its group and keeps other button owners', () => {
  const h = harness([{ ...button('x'), slideGroup: 'face' }, { ...button('a', 'a', 200), slideGroup: 'face' }, button('otherA', 'a', 300)]);
  h.router.start([point(0, 110, 10), point(1, 310, 10)]); h.router.move([point(0, 210, 10)]);
  assert(!h.held.has('button:x')); assert(h.held.has('button:a'));
  h.router.move([point(0, 310, 10)]); assert(h.held.has('button:a')); // otherA still owns it
  h.router.end([point(1, 0, 0)]); assert(!h.held.size);
  h.router.move([point(0, 110, 10)]); assert(h.held.has('button:x'));
});
test('ordinary button drag out cancels; blank, chrome and extra stick fingers never slide into action', () => {
  const h = harness(undefined, [{ x: 10, y: 10, w: 10, h: 10 }]);
  h.router.start([point(0, 15, 15), point(1, 400, 10), point(2, 30, 30), point(3, 40, 40)]);
  h.router.move([point(0, 110, 10), point(1, 110, 10), point(3, 110, 10)]); assert.equal(h.held.size, 0);
  h.router.start([point(4, 110, 10)]); h.router.move([point(4, 180, 10)]); assert.equal(h.held.size, 0);
  h.router.move([point(4, 110, 10)]); assert.equal(h.held.size, 0);
  h.router.end([point(2, 0, 0)]); h.router.move([point(3, 50, 50)]); assert.deepEqual(h.axes.get('l'), [0, 0]);
});
test('opposite D-pad directions neutralize and releasing one restores the other', () => {
  const h = harness([button('up', 'du'), button('down', 'dd', 200)]);
  h.router.start([point(0, 110, 10)]); assert(h.held.has('button:du'));
  h.router.start([point(1, 210, 10)]); assert.equal(h.held.size, 0);
  h.router.end([point(1, 0, 0)]); assert(h.held.has('button:du')); h.router.cancel(); assert.equal(h.held.size, 0);
});
test('QAM retains guide lead/hold timing and cannot release a physically held A', () => {
  const h = harness([button('a', 'a'), { id: 'qam', kind: 'command', command: 'qam', hit: { x: 200, y: 0, w: 50, h: 50 } }]);
  h.router.start([point(0, 110, 10), point(1, 210, 10)]); assert(h.held.has('button:guide'));
  h.advance(59); assert.equal(h.events.filter(e => e[1] === 'a').length, 1);
  h.advance(121); assert(h.held.has('button:a')); assert(!h.held.has('button:guide'));
  h.router.end([point(0, 0, 0)]); assert.equal(h.held.size, 0);
});
test('cancel/dispose remove delayed chord and click work; stale callbacks never reactivate', () => {
  const h = harness([stick, { id: 'qam', kind: 'command', command: 'qam', hit: { x: 200, y: 0, w: 50, h: 50 } }]);
  h.router.start([point(0, 20, 20)]); h.router.end([point(0, 20, 20)]); assert(h.held.has('button:l3'));
  h.router.start([point(1, 210, 10)]); h.router.dispose(); const end = h.events.length;
  h.advance(5000); h.router.start([point(2, 210, 10)]); h.router.move([point(0, 50, 50)]); h.router.activate({ kind: 'button', key: 'a' });
  assert.equal(h.events.length, end); assert.equal(h.held.size, 0); assert.equal(h.jobs.size, 0);
});
test('a dragged stick that returns home is not a stick-click; long hold is not a tap', () => {
  const h = harness(); h.router.start([point(0, 20, 20)]); h.router.move([point(0, 70, 20), point(0, 20, 20)]); h.router.end([point(0, 20, 20)]);
  h.router.start([point(0, 20, 20)]); h.advance(500); h.router.end([point(0, 20, 20)]); assert.equal(h.held.size, 0);
});
const okay = (layout: PadLayout) => { assert(layout.ok); return layout; };
for (const preset of ['current', 'stardew', 'move'] as const) test(`${preset}: actual geometry supports movement plus action and excludes Exit`, () => {
  const win = { width: 932, height: 430 }, safe = { left: 59, right: 0, top: 0, bottom: 21 };
  const layout = okay(preset === 'current' ? padLayout(win, safe) : preset === 'stardew' ? stardewLayout(win, safe, 'larger') : moveLayout(win, safe));
  const controls = padTouchControls(layout, preset), h = harness(controls, layout.nodes.filter(n => n.layer === 9).map(n => n.hit));
  const at = (id: string, finger: number) => { const c = controls.find(n => n.id === id)!; return point(finger, c.hit.x + c.hit.w / 2, c.hit.y + c.hit.h / 2); };
  const m = at(preset === 'current' ? 'lstick' : 'move', 0), a = at(preset === 'move' ? 'a' : 'x', 1);
  h.router.start([m, a]); h.router.move([{ ...m, x: m.x + 50 }]); assert(h.axes.get('l')![0] > 0); assert.equal(h.held.size, 1);
  const exit = layout.byId.exit.hit; h.router.start([point(3, exit.x + 1, exit.y + 1)]); assert.equal(h.held.size, 1);
  h.router.cancel(); assert.equal(h.held.size, 0); assert.deepEqual(h.axes.get('l'), [0, 0]);
});
test('revoked surface token plus disposed router cannot press on the replacement connection', () => {
  const gate = createSurfaceInputGate(), old = {}, next = {}, events: unknown[] = [];
  gate.activate(old);
  const router = createPadTouches([stick, button('x')], [], { action: gate.wrap(old, (a, d) => events.push([a, d])), stick: gate.wrap(old, (k, x, y) => events.push([k, x, y])) });
  router.start([point(0, 10, 10), point(1, 110, 10)]); gate.revoke(); router.dispose(); gate.activate(next);
  const len = events.length; router.move([point(0, 50, 10)]); router.start([point(2, 110, 10)]); assert.equal(events.length, len);
});
test('opposite-direction cancellation is atomic and emits no new presses', () => {
  const h = harness([button('up', 'du'), button('down', 'dd', 200)]);
  h.router.start([point(0, 110, 10), point(1, 210, 10)]); h.events.length = 0;
  h.router.cancel(); assert.deepEqual(h.events, []); assert.equal(h.held.size, 0);
});
test('ordinary cleanup releases only active outputs, then permits a fresh gesture', () => {
  const h = harness(); h.router.start([point(0, 10, 10), point(1, 110, 10)]); h.router.move([point(0, 50, 10)]);
  h.events.length = 0; h.router.cancel(); assert(h.events.every(e => e[0] === 'stick' ? e[2] === 0 && e[3] === 0 : e[2] === false));
  h.router.start([point(0, 110, 10)]); assert(h.held.has('button:x')); h.router.dispose();
});
test('a displaced final touch without a move callback never becomes L3', () => {
  const h = harness(); h.router.start([point(0, 20, 20)]); h.router.end([point(0, 70, 20)]);
  assert.equal(h.held.size, 0); assert.equal(h.jobs.size, 0); assert.deepEqual(h.axes.get('l'), [0, 0]);
});
test('opposing directions ending in one native event emit no transient press', () => {
  const h = harness([button('up', 'du'), button('down', 'dd', 200)]);
  h.router.start([point(0, 110, 10), point(1, 210, 10)]); assert.deepEqual(h.events, []);
  h.router.end([point(0, 110, 10), point(1, 210, 10)]); assert.deepEqual(h.events, []);
});
