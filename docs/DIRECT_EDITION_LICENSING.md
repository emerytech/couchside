# Direct-edition licensing (off-store unlock)

The **direct edition** is a Couchside build sold and handed out *without* the App
Store or Google Play — for de-Googled Android, side-loaders, and anyone who
can't or won't use a store. It unlocks with a **signed license key**, not an
in-app purchase.

> **Why this exists.** The beta build (`EXPO_PUBLIC_BETA_UNLOCK=1`) is
> unlocked-for-*anyone*: leak that APK and the app is free for the world. The
> direct edition ships **locked** and unlocks only against a key the maintainer
> signs offline. A leaked direct APK grants nothing; only a valid key does.

This doc is the durable reference so the path can later be wired to a real
license manager (Stripe / Gumroad / Ko-fi / Lemon Squeezy) without rediscovering
how any of it works. **Nothing here needs to change to automate issuance** —
today issuance is a manual CLI run; §7 is the seam where a webhook slots in.

---

## 1. Threat model — what a leak does and doesn't get you

| Leaked thing | Result |
|---|---|
| The direct **APK** | Nothing. It's locked; without a key it's just the 7-day trial. Post it anywhere. |
| A **license key** | That one key can be shared. But it is **stamped with the buyer's name** (shown in-app) and a unique `id`, so a shared key is traceable to who leaked it, and its `id` can be added to a future revocation blocklist. |
| The **public key** (baked in the app) | Nothing. Verification-only; you cannot sign with it. |
| The **private key** (offline) | Everything — the attacker can forge keys. Treat it exactly like the release signing key: offline, backed up, never in git/CI/app. |

This is a **$4.99 one-time unlock, not a DRM fortress**. The goal is to make
casual leaking pointless and shared keys attributable — not to stop a determined
cracker, who could patch any build (store or not). Don't over-engineer it.

---

## 2. How it works (offline Ed25519)

- Keypair: **Ed25519** (RFC 8032). Private half offline; public half baked into
  the app as a constant.
- A license key is a signed token. The app verifies the signature **with no
  network call** (true to Couchside's no-cloud, no-account ethos).
- Verify uses **node-forge** (already a dependency, for TV cert minting; its
  Ed25519 is pure JS and runs in Hermes). Signing uses **node's `crypto`**
  Ed25519. Both are RFC 8032 and interoperate — proven by a test, not assumed.

### Token format

```
CS1.<payload-b64url>.<signature-b64url>
```

- `CS1` — version prefix.
- `payload` — UTF-8 JSON, base64url (no padding). The signature covers these
  **exact bytes** (no canonicalization games — verify over the transmitted
  bytes, then `JSON.parse` for display).
- `signature` — 64-byte Ed25519 signature, base64url.

Payload shape (`app/lib/license.ts` → `LicensePayload`):

```json
{ "v": 1, "name": "Samuel P.", "email": "s@example.com",
  "iat": 1758540000, "id": "a1b2c3d4", "edition": "direct" }
```

`name` is required and shown in-app ("Licensed to …"). `id` is a short random
key id for your records / future revocation. `email` is optional.

---

## 3. The keypair

Generated once with the CLI (§4). Current locations on the maintainer's machine:

- **Private key:** `~/.config/couchside/license-ed25519.key` (PKCS#8 PEM, `chmod
  600`). **Back this up offline.** Losing it means you can never issue another
  key for already-shipped builds. Leaking it lets anyone forge keys.
- **Public key:** baked into `app/lib/license.ts` as
  `LICENSE_PUBLIC_KEY_B64URL` (raw 32-byte Ed25519 key, base64url).

**Rotation cost:** changing the public key invalidates **every key ever issued**
for builds that shipped the old one. So rotate only on a compromise, and expect
to re-issue keys to existing buyers. This is why the private key's durability
matters as much as its secrecy.

---

## 4. The signing CLI — `scripts/make-license.mjs`

Zero-dependency Node script (uses only `node:crypto`), so it runs on any offline
machine that has the private key.

```bash
# Once, ever — generate the keypair. Prints the public key to bake into the app.
node scripts/make-license.mjs keygen

# Issue a key for a buyer (prints the CS1... token to stdout; details to stderr).
node scripts/make-license.mjs issue --name "Samuel P." --email you@example.com

# Sanity-check a key locally.
node scripts/make-license.mjs verify CS1....

# Self-test: keygen + issue + verify + tamper-reject + wrong-key-reject in a
# throwaway tempdir. Touches nothing real.
node scripts/make-license.mjs --self-test
```

Private-key path override: `--key <path>` or `$COUCHSIDE_LICENSE_KEY`
(default `~/.config/couchside/license-ed25519.key`).

Every issued key is **self-verified before it is emitted**, so the tool never
hands out a key that wouldn't unlock.

---

## 5. App code map

| File | Role |
|---|---|
| `app/lib/license.ts` | **Pure, RN-free.** `verifyLicenseKey()` — offline Ed25519 verify against the baked-in public key. Holds `LICENSE_PUBLIC_KEY_B64URL`. Tested standalone (`lib/__tests__/license.test.ts`). |
| `app/lib/entitlement.ts` | `IS_DIRECT_BUILD` (from `EXPO_PUBLIC_DIRECT`), `redeemLicenseKey()`, `getLicenseeName()`. Wires the license into the entitlement state machine (§6). |
| `app/lib/EntitlementContext.tsx` | `redeemLicense()` — redeem + refresh + one-shot unlock toast (mirrors `recordPurchase`). |
| `app/components/LicenseRedeemCard.tsx` | The paste-a-key UI. Rendered **only** when `IS_DIRECT_BUILD`. |
| `app/app/(tabs)/setup.tsx` | Direct build shows `LicenseRedeemCard` in place of Buy/Restore under Account. |
| `app/components/Paywall.tsx` | Direct build shows the redeem card (compact) instead of Buy/Restore. |
| `app/eas.json` | `direct` profile: APK, `EXPO_PUBLIC_DIRECT=1`, **no** beta unlock. |

---

## 6. The one non-obvious gotcha — the store fail-open

`entitlement.ts`'s `revalidateWithStore()` treats an **unreachable store** as
`purchased` (fail-open) so self-compiled / dev builds are never locked out.

A direct off-store APK has **no reachable store by definition** — so without a
guard it would hit that fail-open and unlock **for anyone who has the file**,
defeating the entire scheme. The guard:

```ts
if (IS_DIRECT_BUILD) return local;   // no store; the signed key is the ONLY unlock
```

runs **before** any fail-open branch. `lib/__tests__/entitlementDirect.test.ts`
is a source-scan guard pinning this ordering (bare Node can't execute
`entitlement.ts` — it imports `react-native`).

Unlock precedence in `getEntitlement()`: **beta → valid license → store cache →
trial clock.** The stored key is **re-verified on every read**, so editing
storage forges nothing — only a genuinely signed key unlocks.

---

## 7. FUTURE: wiring to a license manager

Today: buyer pays (Stripe/Ko-fi/PayPal/Gumroad) → you run `make-license.mjs
issue --name …` → email them the key. The seam to automate is **exactly that CLI
step**; nothing in the app changes.

### The automation

1. **Payment webhook** (Stripe `checkout.session.completed`, Gumroad/Ko-fi/Lemon
   Squeezy sale webhook) hits a small server you control.
2. The server does the same thing the CLI's `issue` does:
   ```js
   const payloadBytes = Buffer.from(JSON.stringify({
     v: 1, name: buyerName, email: buyerEmail,
     iat: Math.floor(Date.now()/1000),
     id: crypto.randomBytes(4).toString('hex'), edition: 'direct',
   }), 'utf8');
   const sig = crypto.sign(null, payloadBytes, privateKey);   // Ed25519, 64 bytes
   const token = `CS1.${b64url(payloadBytes)}.${b64url(sig)}`;
   ```
   (Lift `sign`/`b64url`/`verifyToken` straight out of `make-license.mjs`, or
   `import` it — keep the crypto identical so keys stay compatible.)
3. Email the `token` to the buyer; the app's redeem card takes it verbatim.

### Non-negotiables when you automate

- **Private key stays server-side and offline-grade.** Env var / secrets
  manager / KMS — never in the app bundle, never in the repo. If you'd rather
  never put it on an internet-facing box, keep issuance on a machine that pulls
  paid-orders and pushes keys out (the webhook only *queues* an order).
- **Record every issued key**: `id`, name, email, order id, date. This is your
  support ledger ("I lost my key" → re-send by order) and the input to
  revocation.
- **Idempotency**: key on the payment/order id so a re-delivered webhook doesn't
  mint a second key.
- **Signing stays identical** to `make-license.mjs`. If the payload JSON or
  encoding drifts, `license.test.ts`' interop guarantee no longer covers you.

### Revocation (only if you ever need it)

Verification is offline, so you can't revoke by flipping a server flag. Options,
cheapest first:
- **Blocklist of `id`s shipped in an app update.** `verifyLicenseKey` gains a
  small `REVOKED_IDS` set; a revoked key stops working once the user updates.
  Enough for "a key got mass-shared."
- **Device-binding** for new keys: the buyer sends a device code, you stamp it
  into the payload, the app checks it. Near-unleakable, more friction. Overkill
  for $4.99 unless abuse is real.
- **Optional online check** (last resort): breaks the no-cloud promise; don't,
  unless the business changes shape.

### Store builds are untouched

The redeem UI is gated on `IS_DIRECT_BUILD`, so App Store / Play builds stay
IAP-only and never show a key field — no alternative-payment / anti-steering
exposure. A separately-distributed non-store build sold direct is outside
Apple/Google's IAP rules by construction.

---

## 8. Building & distributing the direct APK

```bash
cd app
eas build -p android --profile direct     # APK, EXPO_PUBLIC_DIRECT=1, locked
```

The result is a sideloadable, locked APK safe to host publicly / hand out freely
(couchside.tv download, direct link, etc.) — it unlocks only with a key. iOS has
no real off-store sideload path (TestFlight/enterprise only), so the direct
edition is Android-first; the `direct` profile allows an iOS ad-hoc build but
it's rarely useful.

---

## 9. Verification status (what's proven vs pending)

**Proven (`node --test`, and a real production-signed token through the app's
own code path):**
- node-`crypto` Ed25519 signature verifies under node-forge Ed25519 (interop).
- Tampered payload, wrong-key signature, and malformed input are all rejected;
  never throws (degrades closed).
- The baked-in production public key is a well-formed 32-byte key and rejects
  throwaway-signed tokens.
- Source guards: direct build returns before any store fail-open; stored key is
  re-verified every read; refused key writes nothing.

**Pending on-device smoke (do before selling):**
- node-forge Ed25519 `verify` running in **Hermes** on a real device (web/Node
  prove the logic but use a different JS engine).
- Full redeem round-trip on a `direct` build: paste key → gate unmounts → app
  stays unlocked across a cold start.

---

## 10. Quick reference

- Prefix / version: `CS1`, payload `v: 1`.
- Build flag: `EXPO_PUBLIC_DIRECT=1` (EAS `direct` profile).
- Private key: `~/.config/couchside/license-ed25519.key` — **offline, backed up.**
- Public key: `app/lib/license.ts` → `LICENSE_PUBLIC_KEY_B64URL`.
- Issue a key: `node scripts/make-license.mjs issue --name "Buyer"`.
- Redeem: Setup → Account → paste key (or the trial-ended Paywall).
