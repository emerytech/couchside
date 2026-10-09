import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { stripTypeScriptTypes } from 'node:module';

const source = readFileSync(new URL('../../components/RemotePowerBar.tsx', import.meta.url), 'utf8');
const start = source.indexOf('      // Native builds can broadcast immediately');
const body = source.slice(start, source.indexOf('      // A LAN relay', start));
async function run(os: string, send: () => Promise<boolean>, current = () => true) {
  const phases: string[] = [];
  let refreshes = 0;
  const result = await runInNewContext(stripTypeScriptTypes('(async()=>{let ok=false,phoneErr=null;' + body + ';return {ok,phoneErr};})()'), {
    Error,
    Platform: { OS: os }, wolAvailable: true, current,
    mac: '02:00:00:00:00:01', settings: { lastIp: '192.168.1.2' },
    sendWol: send, setWakeDetail: () => {}, setWakePhase: (p: string) => phases.push(p),
    status: { refresh: () => refreshes++ }, setTimeout: (fn: () => void) => fn(),
  });
  return { result, phases, refreshes };
}
for (const os of ['ios', 'android']) {
  test(`${os} sends direct burst and starts checking before relay lookup`, async () => {
    let sends = 0;
    const r = await run(os, async () => ++sends === 2);
    assert.equal(sends, 3);
    assert.equal(r.result.ok, true);
    assert.deepEqual(r.phases, ['waiting']);
    assert.equal(r.refreshes, 1);
  });
}
test('direct failure leaves relay fallback available', async () => {
  const r = await run('ios', async () => { throw new Error('Network unavailable'); });
  assert.equal(r.result.ok, false);
  assert.equal(r.result.phoneErr, 'Network unavailable');
  assert.deepEqual(r.phases, []);
});
test('cancelled burst cannot publish stale wake progress', async () => {
  let valid = true, sends = 0;
  const r = await run('ios', async () => { sends++; valid = false; return true; }, () => valid);
  assert.equal(sends, 1);
  assert.deepEqual(r.phases, []);
  assert.equal(r.refreshes, 0);
});
