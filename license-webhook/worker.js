/**
 * Couchside Direct — Lemon Squeezy license auto-issuer (Cloudflare Worker).
 *
 * Lemon Squeezy fires an `order_created` webhook on every order. This worker:
 *   1. verifies the LS webhook signature (HMAC-SHA256 of the raw body),
 *   2. GATES on a real order — live (not test_mode), paid, not refunded, and
 *      (optionally) our variant — so a test/refunded/other order mints NOTHING,
 *   3. signs an Ed25519 license key with the offline license key (same key
 *      scripts/make-license.mjs uses; WebCrypto Ed25519 <-> node-forge verify is
 *      proven), stamped with the buyer's name + order id,
 *   4. emails it to the buyer via Resend.
 *
 * The license private key lives ONLY as the encrypted secret
 * LICENSE_PRIVATE_KEY_PKCS8_B64 (base64 of the PKCS#8 DER). Nothing here is in git.
 *
 * Idempotency: iat is derived from the order's own created_at, so a re-delivered
 * webhook produces the SAME token; the optional KV binding ISSUED also dedupes
 * the email. Without KV a redelivery would re-email the same key — harmless.
 */
const PREFIX = 'CS1';
const EDITION = 'direct';

export default {
  async fetch(request, env, ctx) {
    if (request.method === 'GET') return new Response('couchside license webhook: ok', { status: 200 });
    if (request.method !== 'POST') return new Response('method not allowed', { status: 405 });

    const raw = await request.text();

    // 1. Verify the Lemon Squeezy signature (hex HMAC-SHA256 of the raw body).
    const ok = await verifyLsSignature(raw, request.headers.get('X-Signature') || '', env.LS_WEBHOOK_SECRET);
    if (!ok) return json({ error: 'invalid signature' }, 401);

    let event;
    try { event = JSON.parse(raw); } catch { return json({ error: 'bad json' }, 400); }

    const eventName = event?.meta?.event_name;
    if (eventName !== 'order_created') return json({ skipped: `event=${eventName}` }, 200);

    const a = event?.data?.attributes || {};
    const orderId = String(event?.data?.id ?? a.identifier ?? '');

    // 2. Gate: only a real, paid, non-refunded order for our product.
    if (a.test_mode === true) return json({ skipped: 'test_mode' }, 200);
    if (a.status !== 'paid') return json({ skipped: `status=${a.status}` }, 200);
    if (a.refunded === true) return json({ skipped: 'refunded' }, 200);
    if (env.LS_VARIANT_ID && String(a.first_order_item?.variant_id ?? '') !== String(env.LS_VARIANT_ID)) {
      return json({ skipped: 'other variant' }, 200);
    }

    const email = a.user_email;
    const name = (a.user_name || '').trim() || 'Couchside customer';
    if (!email) return json({ error: 'no buyer email on order' }, 200);

    // 3. Idempotency: skip if this order was already issued.
    if (env.ISSUED) {
      const prior = await env.ISSUED.get(orderId);
      if (prior) return json({ ok: true, already_issued: true }, 200);
    }

    // 4. Sign the license key (iat from the order so it's deterministic).
    const iat = Number.isFinite(Date.parse(a.created_at)) ? Math.floor(Date.parse(a.created_at) / 1000) : nowSeconds();
    const keyId = (await sha256hex(orderId + ':' + EDITION)).slice(0, 8);
    const token = await signLicense(env.LICENSE_PRIVATE_KEY_PKCS8_B64, { name, email, orderId, keyId, iat });

    // 5. Email it.
    try {
      await sendKeyEmail(env, email, name, token);
    } catch (e) {
      // Don't 500 — LS would retry forever. Log + 200; the order is in ISSUED-less
      // limbo, so surface it: return the token so it shows in the LS webhook log
      // for manual send. (Consider alerting here.)
      return json({ ok: false, email_error: String(e), token_for_manual_send: token }, 200);
    }

    if (env.ISSUED) ctx.waitUntil(env.ISSUED.put(orderId, token, { expirationTtl: 60 * 60 * 24 * 730 }));
    return json({ ok: true, issued_to: name }, 200);
  },
};

// ---------- crypto ----------

async function verifyLsSignature(raw, sigHex, secret) {
  if (!secret || !sigHex) return false;
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(raw)));
  return timingSafeEqualHex(toHex(mac), sigHex.trim().toLowerCase());
}

async function signLicense(privB64, { name, email, orderId, keyId, iat }) {
  const priv = await crypto.subtle.importKey('pkcs8', b64ToBytes(privB64), { name: 'Ed25519' }, false, ['sign']);
  const payload = { v: 1, name, email, iat, id: keyId, edition: EDITION, order: orderId };
  const payloadBytes = new TextEncoder().encode(JSON.stringify(payload));
  const sig = new Uint8Array(await crypto.subtle.sign('Ed25519', priv, payloadBytes));
  return `${PREFIX}.${bytesToB64url(payloadBytes)}.${bytesToB64url(sig)}`;
}

async function sha256hex(s) {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)));
  return toHex(d);
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
function bytesToB64url(bytes) {
  let s = ''; for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64ToBytes(b64) {
  const s = atob(b64.replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}
function timingSafeEqualHex(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
