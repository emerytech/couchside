import assert from 'node:assert/strict';
import test from 'node:test';
import { mintUploadTicket } from '../ticket.ts';
import { PinnedSocketClosedError, PinnedTimeoutError } from '../boxTlsConn.ts';

const conn = { host: 'box.local', port: 8787, token: 'synthetic', secure: true,
  tlsPort: 8788, pinModulus: 'a'.repeat(512) };
const ticket = 'b'.repeat(32);
const reply = { status: 200, headers: {}, bodyBytes: new Uint8Array(), body: JSON.stringify({ ticket }) };

test('picker stale socket: ticket retries once using the same pinned target', async () => {
  const calls: unknown[][] = [];
  const result = await mintUploadTicket(conn, '10.1.1.89', async (...args) => {
    calls.push(args);
    if (calls.length === 1) throw new PinnedSocketClosedError();
    return reply;
  });
  assert.equal(result, ticket);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0], calls[1]);
  assert.equal(calls[1][0], '10.1.1.89');
  assert.equal(calls[1][1], 8788);
  assert.equal(calls[1][2], conn.pinModulus);
  assert.equal((calls[1][3] as { path: string }).path, '/api/ticket?once=1');
});

test('ticket reconnect is bounded to one retry', async () => {
  let calls = 0;
  assert.equal(await mintUploadTicket(conn, conn.host, async () => {
    calls++; throw new PinnedSocketClosedError();
  }), null);
  assert.equal(calls, 2);
});

for (const error of [Object.assign(new Error('pin mismatch'), { name: 'PinMismatchError' }),
  new PinnedTimeoutError(true), new PinnedTimeoutError(false), new Error('other failure')]) {
  test(`does not retry ${error.name}: ${error.message}`, async () => {
    let calls = 0;
    assert.equal(await mintUploadTicket(conn, conn.host, async () => { calls++; throw error; }), null);
    assert.equal(calls, 1);
  });
}
for (const response of [{ ...reply, status: 401 }, { ...reply, body: '{}' },
  { ...reply, body: 'not JSON' }, { ...reply, body: JSON.stringify({ ticket: 'bad' }) }]) {
  test(`invalid ticket reply fails without retry: ${response.status} ${response.body}`, async () => {
    let calls = 0;
    assert.equal(await mintUploadTicket(conn, conn.host, async () => { calls++; return response; }), null);
    assert.equal(calls, 1);
  });
}
test('unsecured box does not request a ticket', async () => {
  assert.equal(await mintUploadTicket({ ...conn, secure: false }, conn.host,
    async () => { assert.fail('must not connect'); }), null);
});
