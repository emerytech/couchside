/**
 * Local end-to-end test of the license webhook worker, WITHOUT deploying or
 * sending real email. Runs the worker's own fetch handler against mock Lemon
 * Squeezy orders, intercepts the Resend call to capture the emailed key, and
 * verifies that key with the APP'S OWN license.ts (node-forge). Also checks the
 * test-mode and bad-signature gates.
 *
 * Run from license-webhook/:
 *   node --experimental-strip-types test-local.mjs
 */
import { readFileSync } from 'node:fs';
import { createHmac } from 'node:crypto';
import assert from 'node:assert';
import worker from './worker.js';
import { verifyLicenseKey } from '../app/lib/license.ts';

// node 20+ already exposes `crypto` (WebCrypto) as a global, same as CF Workers.

const HOME = process.env.HOME;
const pem = readFileSync(`${HOME}/.config/couchside/license-ed25519.key`, 'utf8');
const der = Buffer.from(pem.replace(/-----[^-]+-----/g, '').replace(/\s+/g, ''), 'base64');
const LICENSE_PRIVATE_KEY_PKCS8_B64 = der.toString('base64');

const SECRET = 'test-webhook-secret-123';
const env = {
  LS_WEBHOOK_SECRET: SECRET,
  LICENSE_PRIVATE_KEY_PKCS8_B64,
  RESEND_API_KEY: 'fake',
  FROM_EMAIL: 'Couchside <licenses@couchside.tv>',
};
const ctx = { waitUntil() {} };

function orderBody({ status = 'paid', test_mode = false, refunded = false, name = 'Jane Buyer', email = 'jane@example.com' } = {}) {
  return JSON.stringify({
    meta: { event_name: 'order_created' },
    data: {
      id: '9999',
      attributes: {
        status, test_mode, refunded,
        user_name: name, user_email: email,
        created_at: '2026-09-22T16:00:00.000000Z',
        first_order_item: { variant_id: 111 },
      },
    },
  });
}
function sign(raw) { return createHmac('sha256', SECRET).update(raw).digest('hex'); }
function req(raw, sigHex) {
  return new Request('https://x/', { method: 'POST', body: raw, headers: { 'X-Signature': sigHex ?? sign(raw) } });
}

// Intercept the Resend email call; capture the token that would be emailed.
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

await run('valid paid order -> emails a key that the app verifies', async () => {
  captured = null;
  const raw = orderBody();
  const res = await worker.fetch(req(raw), env, ctx);
  assert.equal(res.status, 200);
  const out = await res.json();
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.ok(captured && captured.token, 'no email captured');
  assert.equal(captured.to[0], 'jane@example.com');
  const v = verifyLicenseKey(captured.token);
  assert.equal(v.ok, true, 'app rejected the worker-issued key: ' + (v.ok ? '' : v.error));
  assert.equal(v.payload.name, 'Jane Buyer');
  assert.equal(v.payload.edition, 'direct');
});

await run('test_mode order is skipped (no key)', async () => {
  captured = null;
  const raw = orderBody({ test_mode: true });
  const out = await (await worker.fetch(req(raw), env, ctx)).json();
  assert.equal(out.skipped, 'test_mode');
  assert.equal(captured, null, 'must not email on a test order');
});

await run('refunded order is skipped', async () => {
  const raw = orderBody({ refunded: true });
  const out = await (await worker.fetch(req(raw), env, ctx)).json();
  assert.equal(out.skipped, 'refunded');
});

await run('non-paid order is skipped', async () => {
  const raw = orderBody({ status: 'pending' });
  const out = await (await worker.fetch(req(raw), env, ctx)).json();
  assert.equal(out.skipped, 'status=pending');
});

await run('bad signature is rejected (401), nothing issued', async () => {
  captured = null;
  const raw = orderBody();
  const res = await worker.fetch(req(raw, 'deadbeef'), env, ctx);
  assert.equal(res.status, 401);
  assert.equal(captured, null);
});

await run('wrong variant is skipped when LS_VARIANT_ID is set', async () => {
  const raw = orderBody();
  const out = await (await worker.fetch(req(raw), { ...env, LS_VARIANT_ID: '222' }, ctx)).json();
  assert.equal(out.skipped, 'other variant');
});

console.log(`\n${pass}/6 passed`);
