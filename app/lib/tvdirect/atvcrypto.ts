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
 * Mint a client certificate WITHOUT blocking the JS thread.
 *
 * THIS EXISTS BECAUSE THE SYNCHRONOUS VERSION FROZE THE APP. Build 122 called
 * the sync generateKeyPair below on the JS thread; RSA-2048 took ~1.8s on a dev
 * Mac but far longer in Hermes on a phone, and while it ran the app accepted no
 * touches and could not navigate — reported from the field as "it freezes and
 * doesn't let me navigate anywhere".
 *
 * forge's stepping API (createKeyPairGenerationState / stepKeyPairGenerationState)
 * runs the search in bounded slices. We step for `sliceMs`, then YIELD to the
 * event loop so React can paint and the user can still move around or cancel.
 * Measured on this Mac: 43 slices, worst slice 60ms — i.e. the UI never stalls
 * longer than one slice.
 */
export async function mintIdentityAsync(
  getRandomValues: GetRandomValues | undefined,
  opts: { sliceMs?: number; onProgress?: (slices: number) => void; signal?: { aborted: boolean } } = {},
): Promise<MintResult> {
  const prng = makePrng(getRandomValues);
  const sliceMs = opts.sliceMs ?? 40;
  const t0 = Date.now();
  // The stepping API exists at runtime but is ABSENT from @types/node-forge —
  // the same "types are not the API surface" trap that cost us the TLS fix.
  const rsa = forge.pki.rsa as unknown as {
    createKeyPairGenerationState(bits: number, e: number, opts: unknown): unknown;
    stepKeyPairGenerationState(state: unknown, n: number): boolean;
  };
  const state = rsa.createKeyPairGenerationState(2048, 0x10001, { prng });
  let slices = 0;
  for (;;) {
    if (opts.signal?.aborted) throw new Error('key generation cancelled');
    const done = rsa.stepKeyPairGenerationState(state, sliceMs);
    slices += 1;
    opts.onProgress?.(slices);
    if (done) break;
    // Yield: without this the loop is just the sync version with extra steps.
    await new Promise((r) => setTimeout(r, 0));
  }
  const keys = (state as unknown as { keys: forge.pki.rsa.KeyPair }).keys;
  return finishCert(keys, t0);
}

/**
 * Mint a client certificate for this phone, SYNCHRONOUSLY. Kept for the bare-Node
 * tests (where blocking is fine and determinism is easier); the app must use
 * mintIdentityAsync above, or it freezes — see that docstring.
 */
export function mintIdentity(getRandomValues: GetRandomValues | undefined): MintResult {
  const prng = makePrng(getRandomValues);
  const t0 = Date.now();
  const keys = forge.pki.rsa.generateKeyPair({ bits: 2048, prng });
  return finishCert(keys, t0);
}

/** Build + self-sign the cert around a freshly generated keypair. Shared by the
 *  sync and stepping mints so they cannot drift in cert shape. */
function finishCert(keys: forge.pki.rsa.KeyPair, t0: number): MintResult {
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
    // PKCS#8 ("BEGIN PRIVATE KEY"), NOT PKCS#1 ("BEGIN RSA PRIVATE KEY").
    //
    // This is the difference between Google TV pairing working on Android and
    // not working at all. react-native-tcp-socket's Android side parses the PEM
    // body with PKCS8EncodedKeySpec and nothing else
    // (android/.../SSLCertificateHelper.java:108), so a PKCS#1 key throws
    // "Failed to parse private key from PEM" on every connectTLS — every pair,
    // every keypress. iOS happens to detect and convert PKCS#1
    // (ios/TcpSocketClient.m:614), which is exactly why this survived: the
    // feature was only ever verified on iOS TestFlight builds.
    //
    // PKCS#8 is accepted by BOTH platforms, so this is strictly wider.
    // No migration needed: identities are per-device (SecureStore, never
    // synced), Android has never had a working one to migrate, and an existing
    // iOS identity in PKCS#1 keeps working on iOS.
    keyPem: forge.pki.privateKeyInfoToPem(
      forge.pki.wrapRsaPrivateKey(forge.pki.privateKeyToAsn1(keys.privateKey)),
    ),
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
