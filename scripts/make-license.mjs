#!/usr/bin/env node
/**
 * Couchside license-key signing tool (OFFLINE).
 *
 * The direct (off-store) edition ships LOCKED. It unlocks only when the buyer
 * pastes a key signed by the private half of the Ed25519 keypair below. The app
 * carries only the PUBLIC half, baked into app/lib/license.ts, and verifies the
 * signature entirely offline. Consequences:
 *   - A leaked APK grants nothing: without a valid key it is just the trial.
 *   - A key cannot be forged without this private file.
 *   - Every key is stamped with the buyer's name (shown in-app) and a unique id,
 *     so a shared key is traceable to whoever it was issued to.
 *
 * Keep the private key OFFLINE, exactly like the release signing key. It never
 * belongs in git, CI, or the app bundle.
 *
 * Usage:
 *   node scripts/make-license.mjs keygen
 *       Generate the keypair ONCE. Writes the private key (PKCS#8 PEM) and
 *       prints the public key to paste into app/lib/license.ts. Refuses to
 *       clobber an existing private key.
 *
 *   node scripts/make-license.mjs issue --name "Samuel P." [--email you@x] [--edition direct]
 *       Sign and print a license key for a buyer.
 *
 *   node scripts/make-license.mjs verify <CS1....>
 *       Local sanity check of a key against the private key's public half.
 *
 *   node scripts/make-license.mjs --self-test
 *       keygen + issue + verify + tamper round-trip in a throwaway tempdir.
 *       Touches nothing real; safe to run anywhere. Exits non-zero on failure.
 *
 * Private-key location (override with --key <path> or $COUCHSIDE_LICENSE_KEY):
 *   ~/.config/couchside/license-ed25519.key
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PREFIX = 'CS1';
const DEFAULT_KEY = path.join(os.homedir(), '.config', 'couchside', 'license-ed25519.key');

function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function fromB64url(s) {
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
  return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/') + pad, 'base64');
}

/** Raw 32-byte Ed25519 public key (base64url) from a public KeyObject. */
function publicKeyB64url(pub) {
  return pub.export({ format: 'jwk' }).x; // JWK `x` is already the raw key, base64url
}

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) out[key] = true;
      else { out[key] = next; i++; }
    } else {
      out._.push(a);
    }
  }
  return out;
}

function keyPath(args) {
  return args.key && args.key !== true ? String(args.key) : process.env.COUCHSIDE_LICENSE_KEY || DEFAULT_KEY;
}

function loadPrivate(kp) {
  if (!fs.existsSync(kp)) {
    console.error(`No private key at ${kp}\nRun:  node scripts/make-license.mjs keygen`);
    process.exit(2);
  }
  return crypto.createPrivateKey(fs.readFileSync(kp, 'utf8'));
}

/** Build the signed token for a payload object. */
function sign(priv, payload) {
  const payloadBytes = Buffer.from(JSON.stringify(payload), 'utf8');
  const sig = crypto.sign(null, payloadBytes, priv); // Ed25519 one-shot, 64 bytes
  return `${PREFIX}.${b64url(payloadBytes)}.${b64url(sig)}`;
}

/** Verify a token against a raw base64url public key. Returns the payload or null. */
function verifyToken(token, pubB64url) {
  const parts = String(token).trim().replace(/\s+/g, '').split('.');
  if (parts.length !== 3 || parts[0] !== PREFIX) return null;
  let payloadBytes, sig;
  try {
    payloadBytes = fromB64url(parts[1]);
    sig = fromB64url(parts[2]);
  } catch {
    return null;
  }
  if (sig.length !== 64) return null;
  const pub = crypto.createPublicKey({
    key: { kty: 'OKP', crv: 'Ed25519', x: pubB64url },
    format: 'jwk',
  });
  if (!crypto.verify(null, payloadBytes, pub, sig)) return null;
  try {
    return JSON.parse(payloadBytes.toString('utf8'));
  } catch {
    return null;
  }
}

function cmdKeygen(args) {
  const kp = keyPath(args);
  if (fs.existsSync(kp) && !args.force) {
    console.error(`Refusing to overwrite existing key: ${kp}\nPass --force only if you truly mean to (it invalidates every key ever issued).`);
    process.exit(2);
  }
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  fs.mkdirSync(path.dirname(kp), { recursive: true });
  fs.writeFileSync(kp, privateKey.export({ format: 'pem', type: 'pkcs8' }), { mode: 0o600 });
  const pub = publicKeyB64url(publicKey);
  console.log(`Private key written: ${kp}  (chmod 600)`);
  console.log('\nBACK THIS FILE UP OFFLINE. Losing it means you can never issue another key');
  console.log('for builds already shipped; leaking it lets anyone forge keys.\n');
  console.log('Paste this into app/lib/license.ts as LICENSE_PUBLIC_KEY_B64URL:\n');
  console.log(`  ${pub}\n`);
}

function cmdIssue(args) {
  const name = args.name && args.name !== true ? String(args.name).trim() : '';
  if (!name) {
    console.error('issue needs --name "Buyer Name"');
    process.exit(2);
  }
  const priv = loadPrivate(keyPath(args));
  const payload = {
    v: 1,
    name,
    iat: Math.floor(Date.now() / 1000),
    id: crypto.randomBytes(4).toString('hex'),
    edition: args.edition && args.edition !== true ? String(args.edition) : 'direct',
  };
  if (args.email && args.email !== true) payload.email = String(args.email);
  const token = sign(priv, payload);
  const pub = publicKeyB64url(crypto.createPublicKey(priv));
  if (verifyToken(token, pub) == null) {
    console.error('INTERNAL: issued key failed self-verification; not emitting it.');
    process.exit(1);
  }
  console.error(`Issued to ${name}  (id ${payload.id}, ${new Date(payload.iat * 1000).toISOString()})`);
  console.log(token);
}

function cmdVerify(args) {
  const token = args._[1];
  if (!token) {
    console.error('verify needs a token: make-license.mjs verify CS1....');
    process.exit(2);
  }
  const pub = publicKeyB64url(crypto.createPublicKey(loadPrivate(keyPath(args))));
  const payload = verifyToken(token, pub);
  if (payload == null) {
    console.error('INVALID');
    process.exit(1);
  }
  console.log('VALID', JSON.stringify(payload));
}

function selfTest() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-license-'));
  const kp = path.join(dir, 'k.key');
  try {
    cmdKeygen({ key: kp });
    const priv = loadPrivate(kp);
    const pub = publicKeyB64url(crypto.createPublicKey(priv));
    const token = sign(priv, { v: 1, name: 'Self Test', iat: 1, id: 'deadbeef', edition: 'direct' });
    const ok = verifyToken(token, pub);
    if (!ok || ok.name !== 'Self Test') throw new Error('round-trip verify failed');

    // Tamper: flip a byte of the payload segment -> must fail.
    const [, p, s] = token.split('.');
    const bytes = fromB64url(p);
    bytes[0] ^= 0x01;
    const tampered = `${PREFIX}.${b64url(bytes)}.${s}`;
    if (verifyToken(tampered, pub) != null) throw new Error('tampered payload verified (must not)');

    // Wrong key: another keypair's public half must reject.
    const other = publicKeyB64url(crypto.generateKeyPairSync('ed25519').publicKey);
    if (verifyToken(token, other) != null) throw new Error('verified under wrong public key');

    console.log('self-test OK (sign, verify, tamper-reject, wrong-key-reject)');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args['self-test']) return selfTest();
  const cmd = args._[0];
  if (cmd === 'keygen') return cmdKeygen(args);
  if (cmd === 'issue') return cmdIssue(args);
  if (cmd === 'verify') return cmdVerify(args);
  console.error('Usage: make-license.mjs <keygen|issue|verify|--self-test>  (see file header)');
  process.exit(2);
}

main();
