import test from 'node:test';
import assert from 'node:assert/strict';
import { PRESET_IDS, adjacentPreset, presetDraft, presetInfo, previewLayout } from '../padPresetGallery.ts';
import { padTouchControls } from '../padTouchLayouts.ts';
import { createPadTouches } from '../padTouches.ts';

test('gallery cycles both directions through every preset', () => {
  let id = PRESET_IDS[0];
  const visited = new Set([id]);
  for (let i=1; i<PRESET_IDS.length; i++) { id=adjacentPreset(id,1); visited.add(id); }
  assert.equal(visited.size,PRESET_IDS.length);
  assert.equal(adjacentPreset(id,1),PRESET_IDS[0]);
  assert.equal(adjacentPreset(PRESET_IDS[0],-1),id);
  for (const p of PRESET_IDS) assert.equal(adjacentPreset(adjacentPreset(p,1),-1),p);
});

test('each preview has art metadata and independent draft defaults', () => {
  for (const id of PRESET_IDS) {
    const a=presetDraft(id), b=presetDraft(id);
    a.background='current';
    assert.notEqual(a,b);
    assert.notEqual(b.background,'current');
    assert.ok(presetInfo(id).title);
    if(id!=='current') assert.ok(presetInfo(id).backdrop);
  }
});

test('scaled native preview hit targets track the drawing and release on disposal', () => {
  for (const id of PRESET_IDS) for (const width of [320,390,740,1000]) {
    const p=presetDraft(id), layout=previewLayout(p,width);
    assert.ok(layout.ok);
    for(const n of layout.nodes) {
      assert.equal(layout.byId[n.id],n);
      assert.ok(n.hit.x>=-0.001 && n.hit.y>=-0.001);
      assert.ok(n.hit.x+n.hit.w<=width+0.001);
      assert.ok(n.hit.y+n.hit.h<=width*390/844+0.001);
    }
    const actions: boolean[]=[];
    const router=createPadTouches(padTouchControls(layout,id),[],{
      action(a,down){ if(a.kind==='button' && a.key==='a')actions.push(down); },
      stick(){}, feedback(){}, changed(){},
    });
    const a=layout.byId.a.hit;
    router.start([{identifier:1,x:a.x+a.w/2,y:a.y+a.h/2}]);
    assert.deepEqual(actions,[true],`${id} ${width}`);
    router.dispose();
    assert.deepEqual(actions,[true,false]);
  }
  assert.equal(previewLayout(presetDraft('vampire'),NaN).ok,false);
});
