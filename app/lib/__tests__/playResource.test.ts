import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PlayResource } from '../playResource.ts';
test('tab revisits reuse fresh data; manual refresh bypasses freshness', async () => {
 const r = new PlayResource<number>(); let calls = 0; const fetch = async () => ++calls;
 await r.fetch(fetch, 60000); await r.fetch(fetch, 60000);
 assert.equal(calls, 1); assert.equal(r.snapshot.data, 1);
 await r.fetch(fetch, 60000, true); assert.equal(calls, 2);
});
test('overlapping focus/refresh requests share one request and stay pending until completion', async () => {
 const r = new PlayResource<number>(); let finish!: (n:number)=>void; let calls=0;
 const fn=()=>{calls++;return new Promise<number>(resolve=>{finish=resolve;});};
 const first=r.fetch(fn, 60000); const second=r.fetch(fn, 60000,true);
 await Promise.resolve(); assert.equal(calls,1); assert.equal(r.snapshot.pending,true);
 finish(42); await Promise.all([first,second]); assert.equal(r.snapshot.pending,false); assert.equal(r.snapshot.data,42);
});
test('failure retains last good result, retries, and isolates another box', async () => {
 const a=new PlayResource<number>(), b=new PlayResource<number>();
 await a.fetch(async()=>7,60000);
 await a.fetch(async()=>{throw Error('offline');},60000,true);
 assert.equal(a.snapshot.data,7); assert.equal(a.snapshot.error?.message,'offline'); assert.equal(b.snapshot.data,null);
 await a.fetch(async()=>8,60000); assert.equal(a.snapshot.error,null); assert.equal(a.snapshot.data,8);
});
test('subscribers receive completion and unsubscribe safely', async () => {
 const r=new PlayResource<null>(); let changes=0; const stop=r.subscribe(()=>changes++);
 await r.fetch(async()=>null,1000); assert.equal(changes,3); stop(); await r.fetch(async()=>null,1000,true); assert.equal(changes,3);
});
test('expired data refreshes; a valid null result is cached too', async () => {
 const r=new PlayResource<null>();let calls=0;const fetch=async()=>{calls++;return null;};
 await r.fetch(fetch,60000);await r.fetch(fetch,60000);assert.equal(calls,1);
 r.snapshot={...r.snapshot,updated:Date.now()-61000};
 await r.fetch(fetch,60000);assert.equal(calls,2);assert.equal(r.snapshot.error,null);
});
