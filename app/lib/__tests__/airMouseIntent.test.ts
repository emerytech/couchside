import test from 'node:test';
import assert from 'node:assert/strict';
import { AirMouseIntentStore } from '../airMouseIntent.ts';
test('menu remount retains explicit intent, with independent targets and defaults',()=>{
 const s=new AirMouseIntentStore();assert.equal(s.resolve('box',true),true);
 // A menu pause tears down sensors but does not change session intent.
 assert.equal(s.resolve('box',false),true);
 s.set('box',false);assert.equal(s.resolve('box',true),false);
 assert.equal(s.resolve('tv',false),false);s.set('tv',true);
 assert.equal(s.resolve('box',true),false);assert.equal(s.resolve('tv',false),true);
 // A new app session uses its configured default, not yesterday's runtime toggle.
 assert.equal(new AirMouseIntentStore().resolve('box',true),true);
});
