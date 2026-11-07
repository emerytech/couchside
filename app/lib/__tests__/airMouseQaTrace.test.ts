import test from 'node:test';import assert from 'node:assert/strict';
import {createAirMouseQaTrace} from '../airMouseQaTrace.ts';
test('QA trace is bounded and summarizes actual accepted vectors without identity fields',()=>{
 const t=createAirMouseQaTrace(2);for(const at of [100,120,500]){t.sample(at,{timestamp:at/1000,x:1,y:2,z:3});t.send(at,3,-4);}
 const v=t.snapshot();assert.deepEqual(v.summary,{samples:2,sends:2,dx:6,dy:-8,maxSampleGapMs:20,maxSendGapMs:20});
 assert.equal(v.samples.length,2);assert.deepEqual(Object.keys(v).sort(),['samples','sends','sensitivity','summary','version']);
});
