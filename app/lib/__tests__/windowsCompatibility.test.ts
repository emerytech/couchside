import test from 'node:test';
import assert from 'node:assert/strict';
import { usableConsoleStatus } from '../consoleStatus.ts';
import { verifyDiscoveryEndpoint } from '../discoveryEndpoint.ts';
import type { Status } from '../api.ts';
import type { FoundBox } from '../boxDiscovery.ts';
const core = { mem: {total_mb: 16000, used_mb: 4000, available_mb: 12000},
  load: [0.5, 0.4, 0.3], disks: [{mount:'C:', used_gb:10, total_gb:100, pct:10}] };
test('Windows and older Linux status works without optional cpu/os; newer Linux unchanged', () => {
  for (const d of [core, {...core, cpu:{cur_mhz:3200}, os:{name:'SteamOS'}}]) {
    assert.equal(usableConsoleStatus(d as Status), d);
  }
});
test('partial/error/malformed core stats stay rejected', () => {
  for (const d of [null, {}, {error:'temporary'}, {...core, mem:null}, {...core, load:[]},
    {...core, load:['bad']}, {...core, disks:[{}]}, {...core, mem:{total_mb:0,used_mb:0}}]) {
    assert.equal(usableConsoleStatus(d as Status), null);
  }
});
const fp='a'.repeat(64);
const box: FoundBox={ip:'10.1.1.197',name:'emery-pc',host:'emery-pc.local',port:8787,version:'0.4.13-win',fp,tlsPort:8788};
const advert={couchside:true,name:box.name,version:box.version,port:8787,ip:box.ip,tls_fp:fp};
test('relayed UDP uses advertised address only after matching HTTP identity/pin', async () => {
  const calls:string[]=[];
  const got=await verifyDiscoveryEndpoint(advert,'10.1.1.1',8787,async ip=>{calls.push(ip);return ip===box.ip?box:null;});
  assert.equal(got,box);assert.deepEqual(calls,[box.ip]);
});
test('old agents without address advert retain verified source fallback', async () => {
  const {ip, tls_fp, ...legacy}=advert;
  assert.equal(await verifyDiscoveryEndpoint(legacy,box.ip,8787,async()=>box),box);
});
test('unreachable relay, wrong agent and changed TLS pin are not listed', async () => {
  for (const got of [null,{...box,name:'other'}, {...box,fp:'b'.repeat(64)}]) {
    assert.equal(await verifyDiscoveryEndpoint(advert,'10.1.1.1',8787,async()=>got),null);
  }
});
test('public, hostname, octal and invalid-port hints never become probe targets', async () => {
  for (const ip of ['8.8.8.8','attacker.example','010.1.1.5']) {
    const calls:string[]=[];
    await verifyDiscoveryEndpoint({...advert,ip},'10.1.1.1',8787,async v=>{calls.push(v);return null;});
    assert.deepEqual(calls,['10.1.1.1']);
  }
  let count=0;
  assert.equal(await verifyDiscoveryEndpoint({...advert,port:70000},box.ip,8787,async()=>{count++;return box;}),null);
  assert.equal(count,0);
});

// Execute the real UDP callback with a fake native socket: this catches late
// async results and duplicate datagrams that a pure endpoint test cannot.
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { runInNewContext } from 'node:vm';
function udpHarness(fetcher: typeof fetch) {
  const listeners: Record<string, (...args: any[]) => void> = {};
  const socket = {once:(n:string,f:(...args:any[])=>void)=>{listeners[n]=f;},
    on:(n:string,f:(...args:any[])=>void)=>{listeners[n]=f;},close:()=>{},setBroadcast:()=>{},
    bind:(_p:number,cb:()=>void)=>cb(),send:()=>{}};
  const js=stripTypeScriptTypes(readFileSync(new URL('../boxDiscovery.ts',import.meta.url),'utf8'))
    .replace(/^import .*;\n/gm,'').replace(/^export /gm,'');
  const ctx:any={require:()=>({createSocket:()=>socket}),Buffer,AbortController,
    setTimeout,clearTimeout,fetch:fetcher,verifyDiscoveryEndpoint,DEFAULT_PORT:8787,Network:{}};
  runInNewContext(js+'\nglobalThis.run = udpProbe;',ctx);
  return {run:(report:(box:FoundBox)=>void)=>ctx.run('10.1.1.94',8787,40,report),
    reply:()=>listeners.message(Buffer.from(JSON.stringify(advert)),{address:'10.1.1.1'})};
}
test('real UDP callback collapses duplicate replies and reports verified address',async()=>{
  let probes=0;const reports:FoundBox[]=[];
  const h=udpHarness((async()=>{probes++;return {ok:true,json:async()=>({app:'couchside-agent',host:box.name,version:box.version,tls_port:8788,tls_fp:fp})};}) as unknown as typeof fetch);
  const pending=h.run(b=>reports.push(b));h.reply();h.reply();
  const result=await pending;assert.equal(probes,1);assert.equal(result[0].ip,box.ip);assert.equal(reports.length,1);
});
test('verification completing after UDP scan closes cannot update list/UI',async()=>{
  let release!:(value:any)=>void;
  const h=udpHarness((()=>new Promise(resolve=>{release=resolve;})) as typeof fetch);
  const reports:FoundBox[]=[];const pending=h.run(b=>reports.push(b));h.reply();
  assert.equal((await pending).length,0);
  release({ok:true,json:async()=>({app:'couchside-agent',host:box.name,version:box.version,tls_port:8788,tls_fp:fp})});
  await new Promise(resolve=>setTimeout(resolve,0));assert.equal(reports.length,0);
});
