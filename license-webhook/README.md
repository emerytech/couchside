# Couchside Direct — Lemon Squeezy license auto-issuer

A tiny Cloudflare Worker that turns a real Lemon Squeezy purchase into an emailed
Couchside license key, automatically, in seconds. Test/refunded orders get nothing.

**Flow:** LS `order_created` webhook → verify signature → gate on `live + paid +
not refunded` → sign an Ed25519 key with the offline license key → email it via
Resend.

The license private key lives ONLY as an encrypted Worker secret. Nothing secret
is in git.

---

## One-time setup

### 1. Resend (email delivery)
1. Create a free account at <https://resend.com> (free tier: 3,000 emails/mo).
2. **Add + verify the sending domain `couchside.tv`** (Resend → Domains → Add):
   paste the SPF/DKIM DNS records it gives you into Cloudflare DNS for couchside.tv.
   (This also fixes the missing SPF/DMARC on couchside.tv.)
3. Create an **API key** (Resend → API Keys). You'll set it as `RESEND_API_KEY`.
4. Pick a from-address on that domain, e.g. `licenses@couchside.tv` (edit
   `FROM_EMAIL` in `wrangler.toml`).

### 2. Deploy the worker
```bash
cd license-webhook
npx wrangler deploy          # first run will prompt you to log into Cloudflare
```
Note the deployed URL, e.g. `https://couchside-license-webhook.<subdomain>.workers.dev`
(or bind a custom route/subdomain later).

### 3. Set the secrets (never committed)
```bash
# The license private key, as base64 of its PKCS#8 DER — piped straight in so it
# is never printed to the terminal or shell history:
openssl pkey -in ~/.config/couchside/license-ed25519.key -outform DER \
  | base64 | tr -d '\n' \
  | npx wrangler secret put LICENSE_PRIVATE_KEY_PKCS8_B64

npx wrangler secret put RESEND_API_KEY        # paste your Resend API key
npx wrangler secret put LS_WEBHOOK_SECRET      # the signing secret from step 4
```

### 4. Point Lemon Squeezy at it
Lemon Squeezy → **Settings → Webhooks → +**:
- **Callback URL:** the worker URL from step 2.
- **Signing secret:** make one up (or let LS generate it); set the SAME value as
  the `LS_WEBHOOK_SECRET` secret above. This is what proves a webhook really came
  from LS.
- **Events:** check **`order_created`** (only).
- Save.

### 5. (Optional) Only issue for the Couchside Direct product
In `wrangler.toml` set `LS_VARIANT_ID` to the product's **variant id** (LS →
product → variant → the numeric id), so unrelated products never mint a key.
Redeploy.

### 6. (Optional, recommended) Idempotency KV
```bash
npx wrangler kv namespace create ISSUED
```
Paste the printed id into the `[[kv_namespaces]]` block in `wrangler.toml`,
uncomment it, and redeploy. This dedupes re-delivered webhooks so a buyer isn't
emailed twice.

---

## How it gates abuse
- **`test_mode` orders are skipped** — the 4242 test card can't mint a key even
  while you're testing. Only real, live, paid orders issue.
- **Refunded / non-paid** orders are skipped.
- **Signature-verified** — a forged POST to the worker without the LS signing
  secret is rejected (401).
- The key is stamped with the buyer name + order id (traceable), and issuance is
  idempotent per order.

## Testing it
Because test orders are gated out, a test-mode purchase will **not** email a key —
that's the point. To exercise the worker itself:
- Use LS's **"Send test event"** on the webhook (it posts a sample `order_created`);
  a sample is usually `test_mode: true`, so expect a `skipped: test_mode` 200 — that
  confirms signature + routing work.
- For a true end-to-end test, do one **live** order (real card, ~$0.50 fee) and
  **refund it** afterward in the LS dashboard; you'll get the real key email.
- `GET` the worker URL returns `couchside license webhook: ok` (health check).

## If email fails
The worker returns `{ ok:false, token_for_manual_send: "CS1..." }` (still HTTP 200
so LS doesn't retry forever). The key is in that response in the LS webhook log —
send it by hand and fix the Resend config. Consider adding an alert here later.

## Rotating / security
- The license private key is the same one in `~/.config/couchside/` and used by
  `scripts/make-license.mjs`. It exists here only as the encrypted
  `LICENSE_PRIVATE_KEY_PKCS8_B64` secret. If you ever rotate the license keypair,
  update this secret AND the public key baked into `app/lib/license.ts` (a rebuild).
- WebCrypto Ed25519 here produces the exact same signatures node-forge verifies in
  the app (checked). If `importKey('pkcs8', …, 'Ed25519')` ever errors on deploy,
  bump `compatibility_date` in `wrangler.toml`.
