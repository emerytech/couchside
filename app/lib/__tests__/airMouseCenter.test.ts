import {test} from 'node:test';
import assert from 'node:assert/strict';
import {centerAirMousePointer} from '../airMouseCenter.ts';

test('Game Mode centering sends exactly one absolute center movement',async()=>{
  const moves:number[][]=[];
  await centerAirMousePointer(async()=>({session:'gamescope'}),(x,y)=>moves.push([x,y]),()=>true);
  assert.deepEqual(moves,[[.5,.5]]);
});
test('losing ownership or changing target during the probe prevents movement',async()=>{
  let live=true,finish!:(v:{session:string})=>void;
  const moves:number[][]=[];
  const pending=centerAirMousePointer(()=>new Promise(resolve=>{finish=resolve;}),(x,y)=>moves.push([x,y]),()=>live);
  live=false;finish({session:'gamescope'});await pending;
  assert.deepEqual(moves,[]);
});
test('an inactive surface never probes or moves',async()=>{
  await centerAirMousePointer(async()=>{assert.fail('inactive probe');},()=>assert.fail('inactive movement'),()=>false);
});
test('unsupported sessions fail explicitly without emitting pointer input',async()=>{
  for(const session of ['desktop','mock',null]){
    await assert.rejects(centerAirMousePointer(async()=>({session}),()=>assert.fail('unsupported movement'),()=>true),/not supported/);
  }
});
test('a failed probe is not replayed or replaced by a guessed movement',async()=>{
  let probes=0;
  await assert.rejects(centerAirMousePointer(async()=>{probes++;throw new Error('offline');},()=>assert.fail('fallback movement'),()=>true),/offline/);
  assert.equal(probes,1);
});
