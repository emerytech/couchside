/**
 * Certificate minting and hashing for Android TV pairing, via node-forge.
 *
 * Split out from ./atvnative.ts so it imports NOTHING platform-specific: forge
 * is pure JS and runs in both Hermes and bare Node, so this — the part where a
 * mistake produces a weak key or a silently wrong hash — is unit-testable
 * against Node's own crypto and openssl. atvnative.ts keeps the imports that
 * cannot load in a test (the TLS socket and the CSPRNG polyfill).
 *
 * ENTROPY IS INJECTED, deliberately. node-forge falls back to a
 * Math.random-seeded PRNG when it finds no platform CSPRNG, which would mint
 * predictable RSA keys. Rather than hope forge discovers the RN polyfill, the
 * caller passes getRandomValues in and this module seeds forge explicitly —
 * and REFUSES to generate a key if none is supplied.
 */
import forge from 'node-forge';

export type GetRandomValues = (a: Uint8Array) => Uint8Array;

/** An RSA keypair + self-signed cert, PEM encoded, plus the measured cost. */
export type MintResult = {
  certPem: string;
  keyPem: string;
  modulusHex: string;
  /** Wall-clock cost of key generation. Reported so the UI can be honest about
   *  it and so a slow phone shows up as a number rather than as a "hang". */
  elapsedMs: number;
};

/**
 * Build a forge PRNG that draws from the platform CSPRNG, or refuse.
 *
 * A dedicated instance whose `seedFileSync` is ours, rather than seeding the
 * global `forge.random`: this way the generator CANNOT silently fall back to
 * forge's Math.random path, because every byte it needs comes through the
 * function below. Passed explicitly to generateKeyPair.
 */
export function makePrng(getRandomValues: GetRandomValues | undefined) {
  if (!getRandomValues) {
    throw new Error('no platform CSPRNG available — refusing to generate a key');
  }
  const prng = forge.random.createInstance();
  prng.seedFileSync = (needed: number) => {
    const bytes = getRandomValues(new Uint8Array(needed));
    let s = '';
    for (const b of bytes) s += String.fromCharCode(b);
    return s;
  };
  return prng;
}

/**
 * Mint a client certificate for this phone. ONE per TV, persisted afterwards.
 *
 * Never call this on a render path: RSA-2048 in JS measured 0.2s on a dev Mac
 * and is expected to be far slower in Hermes on a phone — unmeasured, which is
 * exactly why elapsedMs is returned rather than assumed negligible.
 */
export function mintIdentity(getRandomValues: GetRandomValues | undefined): MintResult {
  const prng = makePrng(getRandomValues);
  const t0 = Date.now();
  const keys = forge.pki.rsa.generateKeyPair({ bits: 2048, prng });
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = '01';
  cert.validity.notBefore = new Date(Date.now() - 24 * 3600 * 1000);
  // Long-dated to match the agent's cert; a short-lived cert is refused.
  cert.validity.notAfter = new Date('2038-01-19T03:14:07Z');
  const attrs = [{ name: 'commonName', value: 'couchside' }];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.setExtensions([
    { name: 'basicConstraints', cA: true, pathLenConstraint: 0 },
    { name: 'subjectAltName', altNames: [{ type: 2, value: 'couchside' }] },
  ]);
  cert.sign(keys.privateKey, forge.md.sha256.create());
  return {
    certPem: forge.pki.certificateToPem(cert),
    keyPem: forge.pki.privateKeyToPem(keys.privateKey),
    modulusHex: modulusOf(keys.publicKey),
    elapsedMs: Date.now() - t0,
  };
}

function modulusOf(key: forge.pki.rsa.PublicKey): string {
  let hex = key.n.toString(16);
  if (hex.length % 2) hex = '0' + hex;
  return hex.toLowerCase();
}

/** The RSA modulus of a PEM certificate, as even-length lowercase hex. */
export function modulusFromPem(pem: string): string {
  const cert = forge.pki.certificateFromPem(pem);
  return modulusOf(cert.publicKey as forge.pki.rsa.PublicKey);
}

/**
 * SHA-256 through forge, so the protocol layer needs no platform crypto.
 *
 * Byte-string round-tripping is the trap here: forge speaks binary strings, so
 * every byte must survive as a single charCode in both directions. A `& 0xff`
 * that silently truncates would produce a hash that is wrong only for some
 * inputs — which is why this is tested against Node's crypto over random data.
 */
export async function sha256(data: Uint8Array): Promise<Uint8Array> {
  const md = forge.md.sha256.create();
  let s = '';
  for (const b of data) s += String.fromCharCode(b);
  md.update(s);
  const digest = md.digest().getBytes();
  const out = new Uint8Array(digest.length);
  for (let i = 0; i < digest.length; i++) out[i] = digest.charCodeAt(i) & 0xff;
  return out;
}
