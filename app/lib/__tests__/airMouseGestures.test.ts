import test from 'node:test';
import assert from 'node:assert/strict';
import { AirMouseTouchHandoff, AirMouseShakeDetector } from '../airMouseGestures.ts';
test('touchpad temporarily owns motion, invalidates queued gyro and resumes after settling',()=>{
 const h=new AirMouseTouchHandoff();const before=h.generation;assert.equal(h.allows(0),true);
 h.setTouch(true,10);assert.notEqual(h.generation,before);assert.equal(h.allows(10000),false);
 const held=h.generation;h.setTouch(true,20);assert.equal(h.generation,held);
 h.setTouch(false,30);assert.equal(h.allows(149),false);assert.equal(h.allows(150),true);
 h.invalidate();assert.notEqual(h.generation,held);
});
test('shake needs rapid reversals, suppresses shake motion and rate-limits repeated activation',()=>{
 const d=new AirMouseShakeDetector(); const s=(t:number,z:number)=>({timestamp:t,z,x:0,y:0});
 for(let i=0;i<50;i++)assert.equal(d.step(s(i*.02,.8*Math.sin(i))).triggered,false);
 assert.equal(d.step(s(2,3)).triggered,false);assert.equal(d.step(s(2.1,-3)).triggered,false);
 assert.equal(d.step(s(2.2,3)).triggered,false);assert.deepEqual(d.step(s(2.3,-3)),{triggered:true,suppress:true});
 for(let i=0;i<10;i++)assert.equal(d.step(s(2.4+i*.02,i%2?3:-3)).triggered,false);
 assert.equal(d.step(s(3.2,0)).suppress,false);
});
test('single fast sweep and slow direction changes do not count as a shake',()=>{
 const d=new AirMouseShakeDetector();for(let i=0;i<30;i++)assert.equal(d.step({timestamp:i*.05,x:0,y:0,z:3}).triggered,false);
 for(let i=0;i<10;i++)assert.equal(d.step({timestamp:3+i,x:0,y:0,z:i%2?3:-3}).triggered,false);
});
