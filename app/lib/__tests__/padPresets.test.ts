import test from 'node:test';
import assert from 'node:assert/strict';
import { STARDEW_ACTIONS, stardewActionInput, CURRENT_CONTROLS, normalizePadPreset, shouldShowRotationTip, rotationTipFits, type RotationTipState } from '../padPresets.ts';
import { createSurfaceInputGate, surfaceChanged } from '../padSurface.ts';
import { stardewLayout, padLayout, MIN_TOUCH, rectGap, rectsIntersect, EXIT_MOAT_U } from '../padLayout.ts';

test('old installs, corrupt selections and unknown versions retain Current controls', () => {
  for (const raw of [undefined, null, false, 'stardew', {}, { version: 2, id: 'stardew', size: 'larger' },
    { version: 1, id: 'other', size: 'larger' }, { version: 1, id: 'stardew' },
    { version: 1, id: 'stardew', size: 'huge' }]) {
    assert.deepEqual(normalizePadPreset(raw), CURRENT_CONTROLS);
  }
  for (const size of ['standard', 'larger'] as const) {
    const choice = { version: 1, id: 'stardew', size };
    assert.deepEqual(normalizePadPreset(JSON.parse(JSON.stringify(choice))), choice);
  }
});

const eligible: RotationTipState = {
  ready: true, learned: false, focused: true, mode: 'gamepad', landscape: false,
  available: true, connected: true, blocked: false, tourVisible: false, selectorVisible: true,
};
test('rotation hint uses measured spare room, never shrinks the existing 182dp D-pad', () => {
  assert.equal(rotationTipFits(400, 126), true);
  assert.equal(rotationTipFits(250, 126), false);
  assert.equal(rotationTipFits(312, 126), true);
  assert.equal(rotationTipFits(311, 126), false);
  assert.equal(rotationTipFits(400, 0), false);
  assert.equal(rotationTipFits(400, 220), false, 'large text also needs room');
});
test('tip requires usable portrait PAD, never interrupts another mode or overlay', () => {
  assert.equal(shouldShowRotationTip(eligible), true);
  for (const patch of [
    { ready: false }, { learned: true }, { focused: false }, { landscape: true },
    { available: false }, { connected: false }, { blocked: true }, { tourVisible: true }, { selectorVisible: false },
    ...['move', 'swipe', 'trackpad', 'remote', 'steam', 'note'].map(mode => ({ mode })),
  ]) assert.equal(shouldShowRotationTip({ ...eligible, ...patch }), false, JSON.stringify(patch));
});

test('preset and size changes release even while remaining in landscape PAD', () => {
  const current = { mounted: true, mode: 'gamepad', landscape: true, layout: 'current:standard' };
  const standard = { ...current, layout: 'stardew:standard' };
  const larger = { ...current, layout: 'stardew:larger' };
  assert.equal(surfaceChanged(current, standard), true);
  assert.equal(surfaceChanged(standard, larger), true);
  assert.equal(surfaceChanged(larger, current), true);
  assert.equal(surfaceChanged(larger, { ...larger }), false);
});

test('removed responders cannot send presses OR releases into a new surface', () => {
  const gate = createSurfaceInputGate();
  const old = {}, next = {};
  const sent: number[] = [];
  const oldDown = gate.wrap(old, () => sent.push(1));
  const oldUp = gate.wrap(old, () => sent.push(0));
  gate.activate(old); oldDown();
  gate.revoke(); oldDown(); oldUp();
  gate.activate(next); oldDown(); oldUp();
  gate.wrap(next, () => sent.push(2))();
  assert.deepEqual(sent, [1, 2]);
});

const phones = [[667, 375, 0, 0], [812, 375, 50, 21], [844, 390, 47, 21],
  [852, 393, 59, 21], [932, 430, 59, 21], [956, 440, 62, 21], [892, 412, 0, 24],
  [800, 360, 0, 24], [917, 412, 0, 24], [1133, 744, 0, 20], [1194, 834, 0, 20], [579, 326, 0, 0]];
test('both Stardew sizes fit both rotations, with 44dp targets, no overlap and Exit moat', () => {
  for (const size of ['standard', 'larger'] as const) for (const [width, height, side, bottom] of phones) for (const left of [0, side]) {
    const layout = stardewLayout({ width, height }, { left, right: side - left, top: 0, bottom }, size);
    assert.ok(layout.ok, `${size} ${width}x${height}`);
    const p = layout.play;
    for (const n of layout.nodes) {
      for (const r of [n.rect, n.hit]) {
        assert.ok(r.x >= p.x - 1e-6 && r.y >= p.y - 1e-6 && r.x + r.w <= p.x + p.w + 1e-6 && r.y + r.h <= p.y + p.h + 1e-6, n.id);
      }
      assert.ok(n.hit.w >= MIN_TOUCH && n.hit.h >= MIN_TOUCH, n.id);
      for (const other of layout.nodes) if (n !== other) assert.equal(rectsIntersect(n.hit, other.hit), false, `${n.id}/${other.id}`);
      if (n.layer !== 9) assert.ok(rectGap(n.hit, layout.byId.exit.hit) >= EXIT_MOAT_U * layout.u - 1e-6, `Exit/${n.id}`);
    }

  }
});

test('larger is selective and refuses undersized windows instead of clipping', () => {
  const win = { width: 844, height: 390 }, safe = { top: 0, left: 47, right: 0, bottom: 21 };
  const current = padLayout(win, safe), standard = stardewLayout(win, safe, 'standard'), larger = stardewLayout(win, safe, 'larger');
  assert.ok(current.ok && standard.ok && larger.ok);
  assert.ok(larger.byId.a.rect.w > standard.byId.a.rect.w);
  assert.ok(larger.byId.move.rect.w > standard.byId.move.rect.w);
  assert.deepEqual(larger.byId.exit.rect, standard.byId.exit.rect);
  assert.deepEqual(padLayout(win, safe), current);
  assert.equal(stardewLayout({ width: 800, height: 325 }, { top: 0, left: 0, right: 0, bottom: 0 }, 'larger').ok, false);
  assert.equal(stardewLayout({ width: 550, height: 326 }, { top: 0, left: 0, right: 0, bottom: 0 }, 'larger').ok, false);
});


test('Stardew actions use documented Xbox buttons and analog triggers, with explicit releases', () => {
  const expected = [
    ['Previous item', 'trigger', 'lt'], ['Inventory / Back', 'button', 'b'],
    ['Next item', 'trigger', 'rt'], ['Use tool', 'button', 'x'],
    ['Interact / Select', 'button', 'a'], ['Crafting', 'button', 'y'],
    ['Menu / Pause', 'button', 'start'],
  ];
  assert.deepEqual(STARDEW_ACTIONS.map(a => [a.label, a.kind, a.key]), expected);
  for (const action of STARDEW_ACTIONS) {
    const events: unknown[] = [];
    const controls = {
      btn: (key: string) => ({ onDown: () => events.push(['button', key, 1]), onUp: () => events.push(['button', key, 0]) }),
      trig: (key: string) => ({ onDown: () => events.push(['trigger', key, 255]), onUp: () => events.push(['trigger', key, 0]) }),
    };
    const input = stardewActionInput(action, controls);
    assert.deepEqual(events, [], 'rendering never sends input');
    input.onDown();
    assert.deepEqual(events, [[action.kind, action.key, action.kind === 'trigger' ? 255 : 1]], 'hold remains pressed until release');
    input.onUp();
    assert.deepEqual(events[1], [action.kind, action.key, 0]);
  }
});


test('preset background is local, defaults to farm, and Current ignores stale overrides', () => {
  const preset = { version: 1, id: 'stardew', size: 'larger' };
  assert.equal(normalizePadPreset(preset).background, undefined);
  assert.equal(normalizePadPreset({ ...preset, background: 'current' }).background, 'current');
  assert.equal(normalizePadPreset({ ...preset, background: 'farm' }).background, 'farm');
  assert.equal(normalizePadPreset({ ...preset, background: 'bad' }).background, undefined);
  assert.deepEqual(normalizePadPreset({ ...preset, id: 'current', background: 'farm' }), CURRENT_CONTROLS);
});
