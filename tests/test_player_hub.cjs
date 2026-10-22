// Execute the generated TV home's navigation with browser/storage stand-ins.
const assert=require('node:assert/strict');
const {execFileSync}=require('node:child_process');
const {mkdtempSync,readFileSync,rmSync}=require('node:fs');
const {tmpdir}=require('node:os');
const {join,resolve}=require('node:path');
const vm=require('node:vm');
const dir=mkdtempSync(join(tmpdir(),'couchside-hub-'));
try {
  const uri=execFileSync('bash',[resolve(__dirname,'../agent/couchside-player.sh'),'--print-hub'],{env:{...process.env,HOME:dir},encoding:'utf8'}).trim();
  const html=readFileSync(new URL(uri),'utf8');
  const ids=[...html.matchAll(/data-service="([a-z]+)"/g)].map(x=>x[1]);
  assert.equal(ids.length,14);assert.equal(new Set(ids).size,14);
  const events={},storage=new Map();let active=null;
  const tiles=ids.map(id=>({dataset:{service:id},focus(){active=this;events.focusin?.({target:this});}}));
  const context={document:{querySelectorAll:s=>s==='a.tile'?tiles:[],addEventListener:(name,fn)=>events[name]=fn},window:{addEventListener:(name,fn)=>events[name]=fn},localStorage:{getItem:k=>storage.get(k),setItem:(k,v)=>storage.set(k,v)}};
  vm.runInNewContext(html.match(/<script>([\s\S]*?)<\/script>/)[1],context);
  const key=k=>events.keydown({key:k,preventDefault(){}});
  assert.equal(active,tiles[0]);key('ArrowLeft');assert.equal(active,tiles[0]);
  tiles[9].focus();key('ArrowRight');assert.equal(active,tiles[9],'right edge stays on row');
  key('ArrowLeft');assert.equal(active,tiles[8],'navigation follows externally focused tile');
  key('ArrowDown');assert.equal(active,tiles[13],'partial final row reachable');
  key('ArrowDown');assert.equal(active,tiles[13]);
  key('ArrowUp');assert.equal(active,tiles[8]);
  events.pageshow();assert.equal(active,tiles[8],'return restores selected service');
  storage.set('couchside.player.lastService','untrusted-not-in-table');events.pageshow();assert.equal(active,tiles[0],'unknown saved service falls back safely');
  console.log('TV hub: generated allowlist, external focus, row edges, partial row, return and invalid-storage fallback passed');
} finally {rmSync(dir,{recursive:true,force:true});}
