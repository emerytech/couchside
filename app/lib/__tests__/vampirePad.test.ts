import test from 'node:test';
import assert from 'node:assert/strict';
import { vampireLayout, MIN_TOUCH, rectsIntersect } from '../padLayout.ts';
import { normalizePadPreset, CURRENT_CONTROLS } from '../padPresets.ts';
import { padTouchControls } from '../padTouchLayouts.ts';
import { surfaceChanged } from '../padSurface.ts';

test('handedness survives storage and invalid selections fail closed', () => {
  for (const hand of ['left', 'right'] as const) {
    const choice = { version: 1, id: 'vampire', size: 'larger', hand };
    assert.deepEqual(normalizePadPreset(JSON.parse(JSON.stringify(choice))), choice);
  }
  assert.deepEqual(normalizePadPreset({ version: 1, id: 'vampire', hand: 'bad' }), CURRENT_CONTROLS);
  assert.equal(surfaceChanged({ mounted: true, mode: 'gamepad', landscape: true, layout: 'vampire:larger:left' },
    { mounted: true, mode: 'gamepad', landscape: true, layout: 'vampire:larger:right' }), true);
});

test('both thumb clusters fit phones and tablets without overlapping touch targets', () => {
  for (const [width, height, side, bottom] of [[667,375,0,0],[844,390,47,21],[956,440,62,21],[800,360,0,24],[1194,834,0,20]]) {
    for (const hand of ['left', 'right'] as const) for (const left of [0,side]) {
      const l = vampireLayout({ width, height }, { left, right: side-left, top:0, bottom }, hand);
      assert.ok(l.ok);
      for (const n of l.nodes) {
        assert.ok(n.hit.w >= MIN_TOUCH && n.hit.h >= MIN_TOUCH, n.id);
        assert.ok(n.hit.x >= l.play.x && n.hit.y >= l.play.y, n.id);
        assert.ok(n.hit.x+n.hit.w <= l.play.x+l.play.w+0.001 && n.hit.y+n.hit.h <= l.play.y+l.play.h+0.001, n.id);
        for (const other of l.nodes) if (other !== n) assert.equal(rectsIntersect(n.hit,other.hit),false, `${hand}: ${n.id}/${other.id}`);
      }
      const controls = padTouchControls(l,'vampire');
      assert.deepEqual(controls.map(c=>c.id), ['move','a','b','start']);
      const movement = controls[0];
      assert.equal(movement.kind,'stick');
      assert.ok(hand === 'left' ? l.byId.move.rect.x < l.play.x+l.play.w/2 : l.byId.move.rect.x+l.byId.move.rect.w > l.play.x+l.play.w/2);
    }
  }
});
