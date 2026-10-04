import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
const source = readFileSync(new URL('../../components/RemotePowerBar.tsx', import.meta.url), 'utf8');
const start = source.indexOf('      // Race relays:');
const body = source.slice(start, source.indexOf('\n      if (!current()) return;\n      if (!ok', start));
function run(relays: unknown[], send: (box: any) => Promise<unknown>, current = () => true) {
 const messages: string[] = [];
 const promise = runInNewContext('(async()=>{let ok=false;'+body+'; return ok;})()', {
  relays, current, api: { wolRelay: send }, connFromBox: (b: any) => b,
  mac: '02:00:00:00:00:01', setWakeDetail: (s: string) => messages.push(s),
 });
 return {promise, messages};
}
test('awake relay wins without waiting for an earlier stalled box', async () => {
 const calls: string[] = [];
 const {promise,messages}=run([{name:'stalled'},{name:'awake'}], b=>{
  calls.push(b.name);return b.name==='stalled'?new Promise(()=>{}):Promise.resolve({ok:true});
 });
 assert.equal(await promise,true);assert.deepEqual(calls,['stalled','awake']);assert.match(messages[0],/through awake/);
});
test('all failures and empty fleets complete without success',async()=>{
 assert.equal(await run([{name:'offline'}],async()=>{throw Error('offline');}).promise,false);
 assert.equal(await run([],async()=>({ok:true})).promise,false);
});
test('cancelled wake cannot publish a late relay result',async()=>{
 let valid=true; let resolve!: (r:unknown)=>void;
 const {promise,messages}=run([{name:'awake'}],()=>new Promise(r=>{resolve=r;}),()=>valid);
 valid=false;resolve({ok:true});await promise;assert.deepEqual(messages,[]);
});
