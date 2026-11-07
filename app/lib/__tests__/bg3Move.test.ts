import test from 'node:test';
import assert from 'node:assert/strict';
import {createBg3MoveInputs} from '../bg3Move.ts';
import {bg3MoveExtras} from '../bg3MoveLayout.ts';
import {moveLayout,verticalMoveLayout} from '../padLayout.ts';
test('mouse owners release independently; disposed callbacks cannot restart input',()=>{
 const events:unknown[]=[];
 const d=createBg3MoveInputs({move:(...v)=>events.push(['move',...v]),button:(...v)=>events.push(['mouse',...v]),key:k=>events.push(['key',k]),wheel(){},manual(){}});
 d.activate();d.button('left','l',true);d.button('drag','l',true);d.click('air','l');d.button('left','l',false);
 assert.deepEqual(events,[['mouse','l',1]]);d.dispose();d.button('late','l',true);d.tick();
 assert.deepEqual(events,[['mouse','l',1],['mouse','l',0]]);
});
test('camera diagonal holds and lease renewal use keyboard only; neutral and disposal release',()=>{
 const events:unknown[]=[];
 const d=createBg3MoveInputs({move:(...v)=>events.push(['move',...v]),button(){},key(){},wheel(){},manual(){},camera:(...v)=>events.push(['camera',...v])});
 d.activate();d.movement('camera');d.stick(1,1);d.tick(1000);d.stick(1,0);d.dispose();d.tick(2000);
 assert.deepEqual(events,[['camera','w',1],['camera','d',1],['camera','w',1],['camera','d',1],['camera','w',0],['camera','d',0]]);
});
test('touchpad temporarily owns cursor movement; camera mode does not disable Air Mouse',()=>{
 const events:unknown[]=[];const manual:boolean[]=[];
 const d=createBg3MoveInputs({move:(...v)=>events.push(v),button(){},key(){},wheel(){},manual:a=>manual.push(a),camera(){}});
 d.activate();d.stick(1,0);d.tick();d.touch(true);d.tick();d.move(2,3);d.touch(false);d.tick();
 assert.deepEqual(events,[[12,0],[2,3],[12,0]]);
 d.movement('camera');d.stick(1,0);assert.equal(manual.at(-1),false);d.dispose();
});
test('touchpad and extra clicks fit above/beside the original MOVE A/B targets',()=>{
 for(const [w,h] of [[932,430],[800,360],[430,932],[360,800]]){
  const l=(w>h?moveLayout:verticalMoveLayout)({width:w,height:h},{top:w>h?0:50,left:w>h?40:0,right:0,bottom:20});
  assert.ok(l.ok);if(!l.ok)continue;const e=bg3MoveExtras(l);assert.ok(e.ok,`${w}x${h}`);
  assert.ok(e.pad.y+e.pad.h<Math.min(l.byId.a.hit.y,l.byId.b.hit.y));
  for(const r of [e.pad,e.left,e.right])assert.ok(r.x>=l.play.x&&r.y>=l.play.y&&r.x+r.w<=l.play.x+l.play.w&&r.y+r.h<=l.play.y+l.play.h);
 }
});

test('touchpad ignores outside fingers and releases a double-tap drag on cancellation',async()=>{
 const {createBg3Touchpad}=await import('../bg3Touchpad.ts');const events:unknown[]=[];
 const p=createBg3Touchpad({active:v=>events.push(['active',v]),move:(...v)=>events.push(['move',...v]),click:k=>events.push(['click',k]),drag:v=>events.push(['drag',v]),scroll:n=>events.push(['scroll',n])});
 p.start(1,10,10,1000);p.move(999,20,20);p.move(1,20,15);p.end(1,1100);
 assert.ok(events.some(v=>JSON.stringify(v)==='["move",10,5]'));assert.ok(!events.some(v=>JSON.stringify(v).includes('scroll')));
 p.start(2,0,0,2000);p.end(2,2050);p.start(3,0,0,2200);p.move(3,10,0);p.cancel();
 assert.deepEqual(events.slice(-2),[['drag',false],['active',false]]);
});
