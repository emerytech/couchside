import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
const file=readFileSync(new URL('../../components/RemotePowerBar.tsx',import.meta.url),'utf8');
const start=file.indexOf('    // Clear prior success when the box sleeps again;');
const body=file.slice(start,file.indexOf('\n  }, [wakePhase,',start));
function observe(patch: Record<string,unknown>) {
 const phases:string[]=[];let success=0;
 const c={wakePhase:'waiting',reachable:true,status:{dataKey:'box',lastSuccess:101},boxKey:'box',wakeStarted:100,wakeRun:{current:1},setWakePhase:(s:string)=>phases.push(s),setWakeDetail:()=>{},hapticSuccess:()=>success++, ...patch};
 runInNewContext('(function(){'+body+'})()',c);
 return {phases,success};
}
test('fresh current-box response confirms wake',()=>assert.deepEqual(observe({}),{phases:['awake'],success:1}));
test('cached status cannot confirm wake',()=>assert.deepEqual(observe({status:{dataKey:'box',lastSuccess:99}}).phases,[]));
test('response from another box cannot confirm wake',()=>assert.deepEqual(observe({status:{dataKey:'other',lastSuccess:101}}).phases,[]));
test('timeout recovers when the box finally responds',()=>assert.deepEqual(observe({wakePhase:'timeout'}).phases,['awake']));
test('previous success clears when box sleeps again',()=>assert.deepEqual(observe({wakePhase:'awake',reachable:false}).phases,['idle']));
test('normal connection does not produce unsolicited wake success',()=>assert.deepEqual(observe({wakePhase:'idle'}).phases,[]));
