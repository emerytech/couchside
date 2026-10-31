import test from 'node:test';
import assert from 'node:assert/strict';
import { GAME_PADS, GAME_PAD_IDS } from '../gamePadCatalog.ts';
import { gamePresetLayout, MIN_TOUCH, rectsIntersect } from '../padLayout.ts';
import { normalizePadPreset, CURRENT_CONTROLS } from '../padPresets.ts';
import { padTouchControls } from '../padTouchLayouts.ts';

for (const id of GAME_PAD_IDS) {
  test(`${id}: preferences round-trip without mutating caller data`, () => {
    for (const hand of ['left','right']) for (const background of ['current','themed']) {
      const p = Object.freeze({ version:1, id, size:'larger', hand, background });
      assert.deepEqual(normalizePadPreset(JSON.parse(JSON.stringify(p))),p);
    }
    assert.deepEqual(normalizePadPreset({version:2,id}),CURRENT_CONTROLS);
  });
  test(`${id}: safe-area fit, independent actions, no overlapping targets`, () => {
    for (const [width,height,side,bottom] of [[579,326,0,0],[667,375,0,0],[844,390,47,21],[956,440,62,21],[800,360,0,24],[1194,834,0,20]]) {
      for (const hand of ['left','right'] as const) for (const left of [0,side]) {
        const l=gamePresetLayout({width,height},{left,right:side-left,top:0,bottom},id,hand);
        assert.ok(l.ok, `${width}x${height}`);
        for (const n of l.nodes) {
          assert.ok(n.hit.w>=MIN_TOUCH && n.hit.h>=MIN_TOUCH,n.id);
          assert.ok(n.hit.x>=l.play.x-0.001 && n.hit.y>=l.play.y-0.001,n.id);
          assert.ok(n.hit.x+n.hit.w<=l.play.x+l.play.w+0.001 && n.hit.y+n.hit.h<=l.play.y+l.play.h+0.001,n.id);
          for (const other of l.nodes) if(other!==n) assert.equal(rectsIntersect(n.hit,other.hit),false,`${id} ${n.id}/${other.id} ${width}`);
        }
        const controls=padTouchControls(l,id);
        assert.equal(new Set(controls.map(c=>c.id)).size,controls.length);
        assert.equal(controls.filter(c=>c.kind==='stick').length,GAME_PADS[id].layout==='twin'?2:1);
        for(const a of GAME_PADS[id].actions) {
          const c=controls.find(c=>c.id===a.key);
          assert.ok(c && c.kind==='button');
          assert.deepEqual(c.action,{kind:a.kind,key:a.key});
        }
      }
    }
  });
}
