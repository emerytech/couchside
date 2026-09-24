/**
 * Couchside Direct — license auto-issuer (Cloudflare Worker).
 *
 * Turns a real purchase into an emailed, offline-signed Couchside license key.
 * Supports TWO processors on the same endpoint (branch on the incoming headers):
 *
 *   - POLAR (polar.sh): Standard Webhooks signature (webhook-id / webhook-timestamp
 *     / webhook-signature headers, whsec_-prefixed base64 secret). Event `order.paid`
 *     (or a paid `order.created`). POLAR_WEBHOOK_SECRET.
 *   - LEMON SQUEEZY: hex HMAC-SHA256 in the X-Signature header. Event `order_created`.
 *     LS_WEBHOOK_SECRET. (Kept so old LS wiring still works; LS is being phased out.)
 *
 * Both paths GATE on a real, paid, non-refunded, non-test order, then sign an Ed25519
 * license key with the offline license key (WebCrypto Ed25519 <-> the app's node-forge
 * verify is proven) stamped with the buyer's name + order id, and email it via Resend.
 *
 * The license private key lives ONLY as the encrypted secret
 * LICENSE_PRIVATE_KEY_PKCS8_B64 (base64 of the PKCS#8 DER). Nothing here is in git.
 */
const PREFIX = 'CS1';
const EDITION = 'direct';

export default {
  async fetch(request, env, ctx) {
    if (request.method === 'GET') return new Response('couchside license webhook: ok', { status: 200 });
    if (request.method !== 'POST') return new Response('method not allowed', { status: 405 });

    const raw = await request.text();
    // Route by processor. Polar sends Standard Webhooks headers; LS sends X-Signature.
    if (request.headers.get('webhook-signature') || request.headers.get('webhook-id')) {
      return handlePolar(raw, request.headers, env, ctx);
    }
    return handleLemonSqueezy(raw, request.headers, env, ctx);
  },
};

// ---------- Polar (Standard Webhooks) ----------

async function handlePolar(raw, headers, env, ctx) {
  const ok = await verifyStandardWebhook(raw, headers, env.POLAR_WEBHOOK_SECRET);
  if (!ok) return json({ error: 'invalid signature' }, 401);

  let event;
  try { event = JSON.parse(raw); } catch { return json({ error: 'bad json' }, 400); }

  const type = event?.type;
  if (type !== 'order.paid' && type !== 'order.created') return json({ skipped: `event=${type}` }, 200);

  const d = event?.data || {};
  // Gate: a real, paid order. Polar's order.paid is already paid; be defensive anyway.
  const paid = type === 'order.paid' || d.paid === true || d.status === 'paid';
  if (!paid) return json({ skipped: `not paid (${d.status})` }, 200);
  if (d.refunded === true || d.status === 'refunded') return json({ skipped: 'refunded' }, 200);

  // Optional: only mint for our product/variant.
  const productId = String(d.product_id ?? d.product?.id ?? d.items?.[0]?.product_id ?? '');
  if (env.POLAR_PRODUCT_ID && productId !== String(env.POLAR_PRODUCT_ID)) {
    return json({ skipped: 'other product' }, 200);
  }

  const email = d.customer?.email || d.user?.email || d.customer_email || d.email;
  const name = (d.customer?.name || d.customer?.public_name || d.user?.public_name || '').trim() || 'Couchside customer';
  const orderId = String(d.id ?? d.checkout_id ?? '');
  if (!email) return json({ error: 'no buyer email on order', order: orderId }, 200);

  const createdAt = d.created_at || d.modified_at;
  const iat = Number.isFinite(Date.parse(createdAt)) ? Math.floor(Date.parse(createdAt) / 1000) : nowSeconds();
  return issueAndEmail(env, ctx, { source: 'polar', orderId, email, name, iat });
}

async function verifyStandardWebhook(raw, headers, secret) {
  const id = headers.get('webhook-id');
  const ts = headers.get('webhook-timestamp');
  const sigHeader = headers.get('webhook-signature');
  if (!secret || !id || !ts || !sigHeader) return false;

  // Reject stale timestamps (±5 min) to blunt replay.
  const t = parseInt(ts, 10);
  if (!Number.isFinite(t) || Math.abs(nowSeconds() - t) > 300) return false;

  const keyB64 = secret.startsWith('whsec_') ? secret.slice(6) : secret;
  const keyBytes = b64ToBytes(keyB64);
  const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${id}.${ts}.${raw}`)));
  const expected = bytesToB64(mac);
  // Header is a space-separated list of `v1,<b64sig>` (possibly several).
  const provided = sigHeader.split(' ').map((p) => (p.includes(',') ? p.split(',')[1] : p));
  return provided.some((p) => timingSafeEqualStr(p, expected));
}

// ---------- Lemon Squeezy (hex HMAC) ----------

async function handleLemonSqueezy(raw, headers, env, ctx) {
  const ok = await verifyLsSignature(raw, headers.get('X-Signature') || '', env.LS_WEBHOOK_SECRET);
  if (!ok) return json({ error: 'invalid signature' }, 401);

  let event;
  try { event = JSON.parse(raw); } catch { return json({ error: 'bad json' }, 400); }

  const eventName = event?.meta?.event_name;
  if (eventName !== 'order_created') return json({ skipped: `event=${eventName}` }, 200);

  const a = event?.data?.attributes || {};
  const orderId = String(event?.data?.id ?? a.identifier ?? '');
  if (a.test_mode === true) return json({ skipped: 'test_mode' }, 200);
  if (a.status !== 'paid') return json({ skipped: `status=${a.status}` }, 200);
  if (a.refunded === true) return json({ skipped: 'refunded' }, 200);
  if (env.LS_VARIANT_ID && String(a.first_order_item?.variant_id ?? '') !== String(env.LS_VARIANT_ID)) {
    return json({ skipped: 'other variant' }, 200);
  }
  const email = a.user_email;
  const name = (a.user_name || '').trim() || 'Couchside customer';
  if (!email) return json({ error: 'no buyer email on order' }, 200);
  const iat = Number.isFinite(Date.parse(a.created_at)) ? Math.floor(Date.parse(a.created_at) / 1000) : nowSeconds();
  return issueAndEmail(env, ctx, { source: 'lemonsqueezy', orderId, email, name, iat });
}

async function verifyLsSignature(raw, sigHex, secret) {
  if (!secret || !sigHex) return false;
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(raw)));
  return timingSafeEqualStr(toHex(mac), sigHex.trim().toLowerCase());
}

// ---------- shared: issue + email ----------

async function issueAndEmail(env, ctx, { source, orderId, email, name, iat }) {
  // Idempotency: skip if this order was already issued (KV optional).
  const dedupeKey = `${source}:${orderId}`;
  if (env.ISSUED && orderId) {
    const prior = await env.ISSUED.get(dedupeKey);
    if (prior) return json({ ok: true, already_issued: true, source }, 200);
  }

  const keyId = (await sha256hex(`${source}:${orderId}:${EDITION}`)).slice(0, 8);
  const token = await signLicense(env.LICENSE_PRIVATE_KEY_PKCS8_B64, { name, email, orderId, keyId, iat });

  try {
    await sendKeyEmail(env, email, name, token);
  } catch (e) {
    return json({ ok: false, source, email_error: String(e), token_for_manual_send: token }, 200);
  }
  if (env.ISSUED && orderId) ctx.waitUntil(env.ISSUED.put(dedupeKey, token, { expirationTtl: 60 * 60 * 24 * 730 }));
  return json({ ok: true, source, issued_to: name }, 200);
}

async function signLicense(privB64, { name, email, orderId, keyId, iat }) {
  const priv = await crypto.subtle.importKey('pkcs8', b64ToBytes(privB64), { name: 'Ed25519' }, false, ['sign']);
  const payload = { v: 1, name, email, iat, id: keyId, edition: EDITION, order: orderId };
  const payloadBytes = new TextEncoder().encode(JSON.stringify(payload));
  const sig = new Uint8Array(await crypto.subtle.sign('Ed25519', priv, payloadBytes));
  return `${PREFIX}.${bytesToB64url(payloadBytes)}.${bytesToB64url(sig)}`;
}

async function sha256hex(s) {
  const dgst = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)));
  return toHex(dgst);
}

// ---------- email (Resend) ----------

async function sendKeyEmail(env, to, name, token) {
  const from = env.FROM_EMAIL || 'Couchside <licenses@couchside.tv>';
  const text =
    `Hi ${name},\n\n` +
    `Thanks for buying Couchside Direct! Here's your license key:\n\n` +
    `${token}\n\n` +
    `To unlock: open the app, go to Setup -> Account, and paste it under ` +
    `"Redeem license key." It unlocks on that device offline -- no account, no store.\n\n` +
    `Keep this email: it's how you re-unlock if you reinstall or switch devices.\n\n` +
    `-- Couchside`;
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from, to: [to], subject: 'Your Couchside license key', text }),
  });
  if (!res.ok) throw new Error(`resend ${res.status}: ${(await res.text()).slice(0, 300)}`);
}

// ---------- utils ----------

function nowSeconds() { return Math.floor(Date.now() / 1000); }
function json(obj, status) { return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } }); }
function toHex(bytes) { return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join(''); }
function bytesToB64(bytes) { let s = ''; for (const b of bytes) s += String.fromCharCode(b); return btoa(s); }
function bytesToB64url(bytes) { return bytesToB64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
function b64ToBytes(b64) {
  const s = atob(b64.replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}
function timingSafeEqualStr(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
