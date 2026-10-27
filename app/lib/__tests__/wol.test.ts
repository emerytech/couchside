import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { runInNewContext } from 'node:vm';

const source = stripTypeScriptTypes(readFileSync(new URL('../wol.ts', import.meta.url), 'utf8'))
  .replace(/^import .*;\n/gm, '').replace(/export /g, '');
function harness(mode: 'ok' | 'stuck' | 'bind-error') {
  const packets: any[] = [];
  let timeout: () => void = () => {};
  let bind: (err?: Error) => void = () => {};
  let closed = 0;
  const socket = {
    once() {}, close() { closed++; }, setBroadcast() {},
    bind(_port: number, cb: typeof bind) {
      bind = cb;
      if (mode === 'ok') cb();
      if (mode === 'bind-error') cb(new Error('bind failed'));
    },
    send(packet: Buffer, _offset: number, _length: number, port: number, addr: string, cb: (err?: Error) => void) {
      packets.push({packet, port, addr}); cb();
    },
  };
  const context: any = {
    Buffer, require: () => ({ createSocket: () => socket }),
    setTimeout: (fn: () => void) => { timeout = fn; return 1; }, clearTimeout() {},
  };
  runInNewContext(source + '\nglobalThis.send = sendWol;', context);
  return { send: context.send, packets, expire: () => timeout(), lateBind: () => bind(), closed: () => closed };
}
test('broadcasts the correct packet to both LAN and global addresses on ports 7/9', async () => {
  const h = harness('ok');
  assert.equal(await h.send('90:82:c3:5c:26:c8', {ip:'10.1.1.38'}), true);
  assert.equal(h.packets.length, 4);
  assert.deepEqual(h.packets.map(p => [p.addr,p.port]), [['10.1.1.255',9],['10.1.1.255',7],['255.255.255.255',9],['255.255.255.255',7]]);
  const expected = Buffer.concat([Buffer.alloc(6,255), ...Array.from({length:16},()=>Buffer.from('9082c35c26c8','hex'))]);
  for (const p of h.packets) assert.deepEqual(p.packet,expected);
  assert.equal(h.closed(),1);
});
test('missing native bind callback times out without sending later', async () => {
  const h = harness('stuck');
  const result = h.send('90:82:c3:5c:26:c8');
  h.expire();
  assert.equal(await result,false);
  h.lateBind();
  assert.equal(h.packets.length,0);
  assert.equal(h.closed(),1);
});
test('bind failure reports failure and closes socket', async () => {
  const h = harness('bind-error');
  assert.equal(await h.send('90:82:c3:5c:26:c8'),false);
  assert.equal(h.closed(),1);
});
