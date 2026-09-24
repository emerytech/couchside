/**
 * Local test of the POLAR (Standard Webhooks) path of worker.js, without deploying
 * or sending real email. Crafts a signed order.paid event, runs the worker's fetch
 * handler, intercepts the Resend call, and verifies the emitted key with the APP's
 * own license.ts (node-forge). Also checks the gates.
 *
 *   node --experimental-strip-types test-polar.mjs
 */
import { readFileSync } from 'node:fs';
import { createHmac, randomBytes } from 'node:crypto';
import assert from 'node:assert';
import worker from './worker.js';
import { verifyLicenseKey } from '../app/lib/license.ts';

const HOME = process.env.HOME;
const pem = readFileSync(`${HOME}/.config/couchside/license-ed25519.key`, 'utf8');
const der = Buffer.from(pem.replace(/-----[^-]+-----/g, '').replace(/\s+/g, ''), 'base64');
const LICENSE_PRIVATE_KEY_PKCS8_B64 = der.toString('base64');

const PRODUCT = '38d231f8-514f-427c-90fb-d0f82000fb1b';
const keyBytes = randomBytes(24);
const SECRET = 'whsec_' + keyBytes.toString('base64');

const env = {
  POLAR_WEBHOOK_SECRET: SECRET,
  POLAR_PRODUCT_ID: PRODUCT,
  LICENSE_PRIVATE_KEY_PKCS8_B64,
  RESEND_API_KEY: 'fake',
  FROM_EMAIL: 'Couchside <licenses@couchside.tv>',
};
const ctx = { waitUntil() {} };

function orderBody({ type = 'order.paid', status = 'paid', paid = true, refunded = false, product = PRODUCT, email = 'buyer@example.com', name = 'Polar Buyer' } = {}) {
  return JSON.stringify({
    type,
    data: {
      id: 'ord_test_123', status, paid, refunded, amount: 799, currency: 'usd',
      created_at: '2026-09-23T12:00:00Z',
      product_id: product, product: { id: product, name: 'Couchside Direct — Unlock License' },
      customer: { email, name },
    },
  });
}

function signed(raw, { id = 'msg_test1', ts = Math.floor(Date.now() / 1000), badSig = false } = {}) {
  const sig = createHmac('sha256', keyBytes).update(`${id}.${ts}.${raw}`).digest('base64');
  return new Request('https://x/', {
    method: 'POST', body: raw,
    headers: {
      'webhook-id': id,
      'webhook-timestamp': String(ts),
      'webhook-signature': `v1,${badSig ? 'AAAA' + sig.slice(4) : sig}`,
    },
  });
}

let captured = null;
globalThis.fetch = async (url, opts) => {
  if (String(url).includes('resend.com')) {
    const body = JSON.parse(opts.body);
    const m = body.text.match(/CS1\.[A-Za-z0-9_.-]+/);
    captured = { to: body.to, token: m && m[0] };
    return new Response('{}', { status: 200 });
  }
  throw new Error('unexpected fetch ' + url);
};

let pass = 0;
async function run(label, fn) { await fn(); console.log('ok -', label); pass++; }

await run('valid paid Polar order -> emails a key the app verifies', async () => {
  captured = null;
  const raw = orderBody();
  const res = await worker.fetch(signed(raw), env, ctx);
  assert.equal(res.status, 200);
  const out = await res.json();
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.equal(out.source, 'polar');
  assert.ok(captured && captured.token, 'no email captured');
  assert.equal(captured.to[0], 'buyer@example.com');
  const v = verifyLicenseKey(captured.token);
  assert.equal(v.ok, true, 'app rejected the key: ' + (v.ok ? '' : v.error));
  assert.equal(v.payload.name, 'Polar Buyer');
  assert.equal(v.payload.edition, 'direct');
});

await run('bad signature -> 401, nothing issued', async () => {
  captured = null;
  const raw = orderBody();
  const res = await worker.fetch(signed(raw, { badSig: true }), env, ctx);
  assert.equal(res.status, 401);
  assert.equal(captured, null);
});

await run('stale timestamp -> 401', async () => {
  const raw = orderBody();
  const res = await worker.fetch(signed(raw, { ts: Math.floor(Date.now() / 1000) - 10000 }), env, ctx);
  assert.equal(res.status, 401);
});

await run('wrong product -> skipped', async () => {
  const raw = orderBody({ product: 'some-other-product' });
  const out = await (await worker.fetch(signed(raw), env, ctx)).json();
  assert.equal(out.skipped, 'other product');
});

await run('non-paid order.created -> skipped', async () => {
  const raw = orderBody({ type: 'order.created', status: 'pending', paid: false });
  const out = await (await worker.fetch(signed(raw), env, ctx)).json();
  assert.match(out.skipped, /not paid/);
});

await run('refunded -> skipped', async () => {
  const raw = orderBody({ refunded: true });
  const out = await (await worker.fetch(signed(raw), env, ctx)).json();
  assert.equal(out.skipped, 'refunded');
});

console.log(`\n${pass}/6 passed`);
