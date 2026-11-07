import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createCursorFling,registerCursorFlingStop,stopCursorFlings} from '../cursorFling.ts';
function rig(){let now=100,allowed=true,id=0;const tasks=new Map<number,()=>void>(),moves:number[][]=[],active:boolean[]=[];
 const pad=createCursorFling({allowed:()=>allowed,move:(x,y)=>moves.push([x,y]),active:v=>active.push(v)},()=>now,
 fn=>{tasks.set(++id,fn);return id as unknown as ReturnType<typeof setTimeout>;},t=>{tasks.delete(t as unknown as number);});
 return {pad,moves,active,tasks,advance(ms=16){now+=ms;const q=[...tasks.values()];tasks.clear();q.forEach(f=>f());},fast(){pad.begin();now+=16;pad.sample(32,0);},block(){allowed=false;}};
}
test('only eligible fast releases glide, decay and finish within bounds',()=>{const r=rig();r.fast();assert.equal(r.pad.release(true),true);for(let i=0;i<50;i++)r.advance();assert.ok(r.moves.length>0);assert.ok(r.moves.flat().every(Number.isFinite));assert.ok(r.moves.reduce((s,[x,y])=>s+Math.hypot(x,y),0)<=1400);assert.equal(r.active.at(-1),false);assert.equal(r.tasks.size,0);});
test('off/ineligible release, stationary release and stale velocity never glide',()=>{const r=rig();r.fast();assert.equal(r.pad.release(false),false);r.fast();r.advance(90);assert.equal(r.pad.release(true),false);r.pad.begin();assert.equal(r.pad.release(true),false);assert.equal(r.moves.length,0);});
test('new touch cancels momentum immediately without cancelling that new touch',()=>{const r=rig();r.fast();r.pad.release(true);r.advance();const count=r.moves.length;r.pad.begin();r.pad.stopGlide();r.advance();assert.equal(r.moves.length,count);assert.equal(r.active.at(-1),true);});
test('app touch, ownership loss, cancellation and scheduling stalls stop motion',()=>{for(const kind of ['touch','blocked','cancel','delay']){const r=rig();r.fast();r.pad.release(true);const unregister=registerCursorFlingStop(r.pad.stopGlide);if(kind==='touch')stopCursorFlings();if(kind==='blocked')r.block();if(kind==='cancel')r.pad.cancel();r.advance(kind==='delay'?100:16);assert.equal(r.moves.length,0);assert.equal(r.tasks.size,0);unregister();}});

test('distance scales travel, while new touch still stops Long immediately',()=>{
 const totals=[];
 for(const distance of [1,2,4]){const r=rig();r.fast();r.pad.release(true,distance);for(let i=0;i<50;i++)r.advance();totals.push(r.moves.reduce((s,[x,y])=>s+Math.hypot(x,y),0));assert.equal(r.tasks.size,0);}
 assert.ok(Math.abs(totals[1]/totals[0]-2)<.1);assert.ok(Math.abs(totals[2]/totals[0]-4)<.1);
 const r=rig();r.fast();r.pad.release(true,4);r.advance();const n=r.moves.length;stopCursorFlings();r.pad.begin();r.advance();assert.equal(r.moves.length,n);
});
