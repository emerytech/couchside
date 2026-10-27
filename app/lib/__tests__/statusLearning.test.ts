import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { runInNewContext } from 'node:vm';
import { isValidLanIp } from '../lanIp.ts';

// Execute the real hook's effects with controlled poll snapshots and settings.
// No native runtime is needed; callbacks run after each simulated render.
const source = stripTypeScriptTypes(readFileSync(new URL('../../hooks/useCapsSync.ts', import.meta.url), 'utf8'))
  .replace(/^import .*;\n/gm, '').replace('export function useCapsSync', 'function useCapsSync');
function harness() {
  let settings: any = { host: 'steam-machine.local', port: 8787, lastIp: '10.1.1.38' };
  let poll: any = { data: null, dataKey: 'steam-machine.local:8787' };
  const consumed = { current: null };
  const effects: (() => void)[] = [];
  const writes: any[] = [];
  const context: any = {
    useCallback: (fn: any) => fn, useRef: () => consumed,
    useEffect: (fn: () => void) => effects.push(fn),
    usePoll: () => poll, api: {},
    hostKey: (s: any) => `${s.host}:${s.port}`,
    capsEqual: (a: any, b: any) => JSON.stringify(a) === JSON.stringify(b),
    normalizeMac: (s: any) => s || null, isValidLanIp,
    useSettings: () => ({ settings, ready: true, update: (patch: any) => {
      writes.push(patch); settings = { ...settings, ...patch };
    } }),
  };
  runInNewContext(source + '\nglobalThis.render = useCapsSync;', context);
  return {
    writes,
    snapshot(data: any, dataKey = 'steam-machine.local:8787') { poll = { data, dataKey }; },
    patch(patch: any) { settings = { ...settings, ...patch }; },
    render() { context.render(); effects.splice(0).forEach(fn => fn()); },
  };
}
test('dual-interface address learning cannot fight a newer ping snapshot on settings rerenders', () => {
  const h = harness();
  h.snapshot({ ip: '10.1.1.209', agent_version: '2.9.127' });
  h.render();
  assert.equal(h.writes.length, 1);
  h.patch({ lastIp: '10.1.1.38' }); // newer switcher ping arrived on the other interface
  for (let i = 0; i < 100; i++) h.render();
  assert.equal(h.writes.length, 1); // no stale write -> no utility/request flood
  h.snapshot({ ip: '10.1.1.209', agent_version: '2.9.127' }); // actual new response
  h.render();
  assert.equal(h.writes.length, 2);
});
test('a prior box response and invalid IP cannot overwrite the current box', () => {
  const h = harness();
  h.snapshot({ ip: '10.1.1.209' }, 'other.local:8787'); h.render();
  assert.equal(h.writes.length, 0);
  h.snapshot({ ip: 'attacker.example' }); h.render();
  assert.equal(h.writes.length, 0);
});
test('metadata is learned in one write and identical new responses cause no writes', () => {
  const h = harness();
  const d = { ip: '10.1.1.209', net: { mac: 'aa:bb:cc:dd:ee:ff' }, caps: { gaming: true }, agent_version: '2.9.127' };
  h.snapshot(d); h.render();
  assert.equal(h.writes.length, 1);
  assert.deepEqual(Object.keys(h.writes[0]).sort(), ['caps', 'lastIp', 'mac', 'version']);
  h.snapshot({ ...d }); h.render();
  assert.equal(h.writes.length, 1);
});
test('a persisted version that matches the agent causes no launch write; an upgrade writes only version', () => {
  const h = harness();
  // Cold launch: everything already learned and persisted (loadBoxes keeps version).
  h.patch({ version: '2.9.129', mac: 'aa:bb:cc:dd:ee:ff', caps: { gaming: true } });
  const d = { ip: '10.1.1.38', net: { mac: 'aa:bb:cc:dd:ee:ff' }, caps: { gaming: true }, agent_version: '2.9.129' };
  h.snapshot(d); h.render();
  assert.equal(h.writes.length, 0);
  // Control: the box's service was updated while the app was closed.
  h.snapshot({ ...d, agent_version: '2.9.130' }); h.render();
  assert.equal(h.writes.length, 1);
  assert.deepEqual({ ...h.writes[0] }, { version: '2.9.130' }); // spread: patch was built in the vm realm
});
test('a non-string agent_version is never persisted', () => {
  const h = harness();
  h.patch({ version: '2.9.129' });
  for (const v of [2129, true, { v: '2.9.130' }]) {
    h.snapshot({ ip: '10.1.1.38', agent_version: v }); h.render();
  }
  assert.equal(h.writes.length, 0);
  h.snapshot({ ip: '10.1.1.38', agent_version: '2.9.130' }); h.render();
  assert.deepEqual(h.writes.map((w) => ({ ...w })), [{ version: '2.9.130' }]);
});
test('per-tab power bars cannot persist stale network metadata', () => {
  const bar = readFileSync(new URL('../../components/RemotePowerBar.tsx', import.meta.url), 'utf8');
  assert.doesNotMatch(bar, /update\(\{\s*(?:lastIp|mac)\b/);
});
