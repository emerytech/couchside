import assert from 'node:assert/strict';
import test from 'node:test';
import { sendFile, parseUploadResult, type UploadConnection, type UploadDrivers } from '../fileUpload.ts';

const conn: UploadConnection = { host: '192.0.2.10', port: 8787, token: 'synthetic-bearer',
  secure: true, tlsPort: 8788, pinModulus: 'a'.repeat(512) };
const reply = { status: 200, body: '{"ok":true,"name":"test.txt","bytes":4,"path":"/drop/test.txt"}' };

function fixture() {
  const calls: unknown[][] = [];
  const drivers: UploadDrivers = {
    mintTicket: async () => { calls.push(['ticket']); return 'b'.repeat(32); },
    secure: async (...args) => { calls.push(['secure', ...args]); return reply; },
    legacy: async (...args) => { calls.push(['legacy', ...args]); return reply; },
  };
  return { calls, drivers };
}

test('secure uploads use the TLS port and saved pin; native bridge never receives bearer token', async () => {
  const { calls, drivers } = fixture();
  const progress = () => {};
  assert.equal(await sendFile(conn, 'file:///cache/test', 'test.txt', drivers, progress), reply);
  assert.deepEqual(calls, [['ticket'], ['secure', { host: conn.host, port: 8788,
    pinModulus: conn.pinModulus, ticket: 'b'.repeat(32), fileUri: 'file:///cache/test', name: 'test.txt' }, progress]]);
  assert.ok(!JSON.stringify(calls).includes(conn.token));
});

for (const broken of [
  { pinModulus: undefined }, { pinModulus: 'invalid' }, { tlsPort: undefined },
  { tlsPort: 0 }, { tlsPort: 65536 }, { tlsPort: 1.5 }, { secure: false },
]) {
  test(`incomplete secure pairing fails before any I/O: ${JSON.stringify(broken)}`, async () => {
    const { calls, drivers } = fixture();
    await assert.rejects(sendFile({ ...conn, ...broken }, 'file:///cache/test', 'test.txt', drivers), /pairing/);
    assert.deepEqual(calls, []);
  });
}

for (const ticket of [null, '', 'garbage', 'a'.repeat(31), 'a'.repeat(33)]) {
  test(`failed/malformed ticket never starts a transfer: ${ticket}`, async () => {
    const { calls, drivers } = fixture();
    drivers.mintTicket = async () => ticket;
    await assert.rejects(sendFile(conn, 'file:///cache/test', 'test.txt', drivers), /secure the upload/);
    assert.deepEqual(calls, []);
  });
}

for (const message of ['pin mismatch', 'connection lost', 'native module absent', 'timeout']) {
  test(`native failure is never retried or downgraded: ${message}`, async () => {
    const { calls, drivers } = fixture();
    const error = new Error(message);
    drivers.secure = async () => { calls.push(['secure']); throw error; };
    await assert.rejects(sendFile(conn, 'file:///cache/test', 'test.txt', drivers), e => e === error);
    assert.deepEqual(calls, [['ticket'], ['secure']]);
  });
}

test('legacy unpaired HTTP path remains compatible, with encoded filename', async () => {
  const { calls, drivers } = fixture();
  await sendFile({ host: '192.0.2.10', port: 8787, token: 'legacy-token' }, 'file:///cache/test', 'a + b.txt', drivers);
  assert.deepEqual(calls, [['legacy', 'http://192.0.2.10:8787/api/upload?name=a%20%2B%20b.txt', 'file:///cache/test', 'legacy-token', undefined]]);
});

test('invalid filenames fail before ticket minting', async () => {
  for (const name of ['', '..', '/etc/passwd', 'a\\b', 'a\0b', 'a\r\nb']) {
    const { calls, drivers } = fixture();
    await assert.rejects(sendFile(conn, 'file:///cache/test', name, drivers), /filename/);
    assert.deepEqual(calls, []);
  }
});

test('upload receipt preserves Linux and Windows paths and multi-GB byte counts', () => {
  for (const path of ['/home/user/Downloads/Couchside/game.bin', 'C:\\Users\\user\\Downloads\\Couchside\\game.bin']) {
    const result = { ok: true, name: 'game.bin', bytes: 5 * 1024 ** 3, path };
    assert.deepEqual(parseUploadResult(JSON.stringify(result)), result);
  }
});

test('malformed or incomplete success replies never produce a Sent confirmation', () => {
  const valid = { ok: true, name: 'test.bin', bytes: 1, path: '/drop/test.bin' };
  for (const body of ['not JSON', '', 'null', '[]', '{}',
    ...[{ ok: false }, { ok: 'true' }, { name: '' }, { path: null }, { path: '' },
      { bytes: '10' }, { bytes: 0 }, { bytes: -1 }, { bytes: 1.5 }, { bytes: Number.MAX_SAFE_INTEGER + 1 }]
      .map(patch => JSON.stringify({ ...valid, ...patch }))]) {
    assert.throws(() => parseUploadResult(body), /did not confirm/);
  }
});
