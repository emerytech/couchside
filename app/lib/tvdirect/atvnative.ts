/**
 * The React Native half of Android TV control: a TLS socket, a CSPRNG, and
 * client-certificate minting. Everything here is platform code — the protocol
 * itself lives in ./atvproto.ts and ./androidtv.ts and is deliberately free of
 * these imports so it can be tested against real hardware from bare Node.
 *
 * THE THREE THINGS THIS FILE EXISTS TO SOLVE, each a real constraint:
 *
 * 1. SELF-SIGNED TLS. Every Android TV presents a certificate it generated
 *    itself (measured: issuer == subject, `CN=atvremote/<MAC>`). Both Node and
 *    react-native-tcp-socket opt out of verification with
 *    `rejectUnauthorized:false` — the flag is absent from the library's
 *    TypeScript types but IS read by its native code (see tlsTrust below).
 *    An earlier design assumed the flag did not exist and fetched the
 *    certificate out-of-band to pin it; that could not work, because there is
 *    no trusted connection to read a certificate from before you trust one.
 *    Pinning via `ca` remains supported and is stronger when a cert is held.
 *
 * 2. ENTROPY. node-forge falls back to a Math.random-seeded PRNG when no
 *    platform CSPRNG is present, which would mint predictable RSA keys — a real
 *    defect, not a lint. `react-native-get-random-values` polyfills
 *    crypto.getRandomValues, and forge's PRNG is explicitly seeded from it
 *    below rather than trusted to find it.
 *
 * 3. KEYGEN COST. RSA-2048 in JS took 0.2s on a dev Mac and is expected to be
 *    FAR slower on a phone — unmeasured, and the reason mintIdentity() reports
 *    its own duration and is called exactly once per TV, from an explicit user
 *    action with a progress state, never at import or on a render path.
 */
import 'react-native-get-random-values';
// Buffer is NOT a global in Hermes — using it unqualified threw "Property
// 'Buffer' doesn't exist" on device, AFTER TLS and the cert read had both
// succeeded. react-native-tcp-socket itself imports it from this same package
// (its own src/Socket.js line 1), which is why the dependency is already here.
import { Buffer } from 'buffer';
import forge from 'node-forge';
import TcpSocket from 'react-native-tcp-socket';

import {
  type AtvSocket,
  frame,
  makeFramer,
} from './atvproto.ts';
import {
  type MintResult,
  mintIdentity as mintWith,
  mintIdentityAsync as mintWithAsync,
  modulusFromPem,
  sha256,
} from './atvcrypto.ts';

export { modulusFromPem, sha256 } from './atvcrypto.ts';
export type { MintResult } from './atvcrypto.ts';

/**
 * TLS trust options for a smart TV, which ALWAYS presents a self-signed cert.
 *
 * `rejectUnauthorized:false` is MISSING from react-native-tcp-socket's
 * TypeScript types but is READ BY ITS NATIVE CODE — verified 2026-08-05 in
 * ios/TcpSocketClient.m `startTLS:`, which sets GCDAsyncSocketManuallyEvaluateTrust
 * and answers its trust delegate with completionHandler(YES). An earlier design
 * assumed the option did not exist and built a trust-on-first-use cert fetch to
 * work around it; that fetch could not work (it tried to read a certificate off
 * a handshake that had already failed) and BOTH LG and Google TV failed on
 * device with "could not read this TV's certificate" because of it.
 *
 * Passing a `ca` PINS one certificate and is strictly stronger, so it wins when
 * the caller has one. Without it we accept the TV's self-signed cert — the same
 * trust posture as the box agent (Python `ssl.CERT_NONE`) on a LAN-only link.
 */
function tlsTrust(caPem?: string): Record<string, unknown> {
  return caPem ? { ca: caPem } : { rejectUnauthorized: false };
}

/**
 * The peer's RSA modulus, read off a LIVE socket — retried until TLS is truly up.
 *
 * WHY THE RETRY IS LOAD-BEARING: react-native-tcp-socket fires `secureConnect`
 * on the TCP connect event, NOT when TLS finishes —
 *   `socket.once('connect', () => tlsSocket.emit('secureConnect'))`  (src/index.js)
 * — so a `connectTLS` callback runs BEFORE the native side has set `_tls` and
 * `_peerTrust`. Native `getPeerCertificate` bails out (`if (!_tcpSocket || !_tls
 * || !_peerTrust) return nil`) and one eager read gets nothing. That is exactly
 * why build 122 failed on device with "no peer certificate available for
 * pairing" AFTER the TLS trust fix had otherwise worked.
 *
 * So: poll briefly until the certificate materialises. Prefer the native
 * `modulus`; fall back to parsing `pubkey` (base64 PKCS#1 RSAPublicKey from
 * SecKeyCopyExternalRepresentation) with forge, so a missing/odd modulus field
 * is not fatal either. Returns null if it never arrives — the caller then falls
 * back to a pinned cert or reports honestly.
 */
async function readPeerModulus(
  sock: unknown,
  timeoutMs = 6000,
): Promise<{ hex: string | null; diag: string }> {
  const anySock = sock as {
    getPeerCertificate?: () => Promise<{ modulus?: string; pubkey?: string } | null>;
  };
  if (typeof anySock.getPeerCertificate !== 'function') {
    return { hex: null, diag: 'getPeerCertificate is not exposed by the TLS socket' };
  }
  const deadline = Date.now() + timeoutMs;
  let attempts = 0;
  let last = 'never resolved';
  for (;;) {
    attempts += 1;
    try {
      const cert = await anySock.getPeerCertificate();
      if (cert && typeof cert === 'object') {
        if (cert.modulus) return { hex: normalizeHex(cert.modulus), diag: `modulus after ${attempts}` };
        const fromDer = cert.pubkey ? modulusFromPublicKeyDer(cert.pubkey) : null;
        if (fromDer) return { hex: fromDer, diag: `pubkey after ${attempts}` };
        // A dict with neither: record its actual keys — that is the whole
        // question, and guessing it from source has already failed twice.
        last = `cert dict had keys [${Object.keys(cert).join(',')}]`;
      } else {
        last = 'getPeerCertificate resolved null (TLS not secured yet?)';
      }
    } catch (e) {
      last = `getPeerCertificate rejected: ${(e as Error)?.message ?? String(e)}`;
    }
    if (Date.now() >= deadline) return { hex: null, diag: `${last} (${attempts} tries)` };
    await new Promise((r) => setTimeout(r, 150));
  }
}

function normalizeHex(v: string): string {
  const h = v.trim().toLowerCase().replace(/^0x/, '');
  return h.length % 2 ? '0' + h : h;
}

/** Parse the RSA modulus out of a base64 PKCS#1 RSAPublicKey (what iOS's
 *  SecKeyCopyExternalRepresentation returns). Never throws. */
function modulusFromPublicKeyDer(b64: string): string | null {
  try {
    const der = forge.util.decode64(b64);
    const asn1 = forge.asn1.fromDer(der);
    // RSAPublicKey ::= SEQUENCE { modulus INTEGER, publicExponent INTEGER }
    const modulus = (asn1 as unknown as { value: { value: string }[] }).value?.[0]?.value;
    if (!modulus) return null;
    return normalizeHex(forge.util.bytesToHex(modulus));
  } catch {
    return null;
  }
}

/**
 * Mint this phone's client certificate, seeded from the platform CSPRNG that
 * the polyfill imported above installs. Throws rather than falling back to a
 * weak PRNG — a predictable client key is a real defect, not a nit.
 */
export function mintIdentity(): MintResult {
  const g = globalThis as { crypto?: { getRandomValues?: (a: Uint8Array) => Uint8Array } };
  const grv = g.crypto?.getRandomValues?.bind(g.crypto);
  return mintWith(grv);
}

/**
 * The NON-BLOCKING mint the app must use. The sync one above froze the app on
 * device (reported: "it freezes and doesn't let me navigate anywhere") because
 * RSA-2048 monopolised the JS thread; this steps the keygen and yields between
 * slices so touches and navigation keep working.
 */
export function mintIdentityNonBlocking(): Promise<MintResult> {
  const g = globalThis as { crypto?: { getRandomValues?: (a: Uint8Array) => Uint8Array } };
  const grv = g.crypto?.getRandomValues?.bind(g.crypto);
  return mintWithAsync(grv);
}

/**
 * Build the connect function the protocol layer needs, pinning `caPem`.
 *
 * `caPem` is the TV's own certificate captured at pairing time. Pinning it is
 * strictly STRONGER than Node's rejectUnauthorized:false used by the live test:
 * that accepts any certificate, this accepts only the one this TV presented
 * when the user paired it.
 */
export function makeConnect(caPem?: string) {
  return (host: string, port: number, certPem: string, keyPem: string): Promise<AtvSocket> =>
    new Promise((resolve, reject) => {
      let settled = false;
      const framer = makeFramer();
      const frames: Uint8Array[] = [];
      const waiters: { resolve: (f: Uint8Array) => void; reject: (e: Error) => void }[] = [];
      // Filled from the LIVE socket once TLS is up — see peerModulusHex below.
      let liveModulusHex: string | null = null;
      let modulusDiag = 'not attempted';

      const sock = TcpSocket.connectTLS(
        { host, port, cert: certPem, key: keyPem, ...tlsTrust(caPem) },
        () => {
          if (settled) return;
          settled = true;
          // Read the peer's RSA modulus off the connection BEFORE resolving —
          // pairing calls peerModulusHex() as soon as this promise settles, so
          // fetching it in the background would race. The native layer exposes
          // it (certificateToDict -> "modulus") once trust has been manually
          // evaluated, which both trust modes above do, so the pairing secret
          // no longer needs an out-of-band certificate fetch.
          void (async () => {
            const probe = await readPeerModulus(sock);
            liveModulusHex = probe.hex;
            modulusDiag = probe.diag;
            resolve(makeSocket());
          })();

          function makeSocket(): AtvSocket {
            return {
            write: (bytes) => {
              // react-native-tcp-socket writes strings or Buffers; base64 is
              // the encoding both platforms agree on for arbitrary bytes.
              sock.write(Buffer.from(frame(bytes)) as unknown as string);
            },
            recv: (timeoutMs = 20000) =>
              frames.length
                ? Promise.resolve(frames.shift() as Uint8Array)
                : new Promise<Uint8Array>((res, rej) => {
                    const t = setTimeout(() => rej(new Error('recv timeout')), timeoutMs);
                    waiters.push({
                      resolve: (f) => { clearTimeout(t); res(f); },
                      reject: (e) => { clearTimeout(t); rej(e); },
                    });
                  }),
            close: () => { try { sock.destroy(); } catch {} },
            // The pairing secret needs the TV's modulus. Preferred source is the
            // LIVE socket (getPeerCertificate().modulus); a pinned cert is the
            // fallback. Throwing beats guessing: a wrong modulus produces a
            // secret the TV answers with silence, which is indistinguishable
            // from a dead link.
            peerModulusHex: () => {
              if (liveModulusHex) return liveModulusHex;
              if (caPem) return modulusFromPem(caPem);
              throw new Error(`no peer certificate for pairing — ${modulusDiag}`);
            },
            };
          }
        },
      );

      sock.on('data', (d: string | Buffer) => {
        const bytes =
          typeof d === 'string' ? Uint8Array.from(Buffer.from(d, 'base64')) : Uint8Array.from(d);
        for (const f of framer.push(bytes)) {
          const w = waiters.shift();
          if (w) w.resolve(f);
          else frames.push(f);
        }
      });
      const fail = (e: Error) => {
        if (!settled) { settled = true; reject(e); return; }
        const w = waiters.shift();
        if (w) w.reject(e);
      };
      sock.on('error', (e: Error) => fail(e));
      sock.on('close', () => fail(new Error('socket closed')));
    });
}

/**
 * A RAW TLS byte stream to a SELF-SIGNED host. Unlike makeConnect (which frames
 * for the Android TV protocol), this hands the caller raw bytes in and out — LG
 * webOS runs a real RFC6455 WebSocket over it (see lib/tvdirect/ws).
 *
 * `caPem` is optional: pass one to PIN that exact certificate; omit it and the
 * connection accepts the TV's self-signed cert via rejectUnauthorized:false.
 * See the note on TLS_ACCEPT_SELF_SIGNED for why that option is safe to use
 * here even though the library's TypeScript types omit it.
 */
export type RawTlsSocket = {
  write(bytes: Uint8Array): void;
  onData(cb: (bytes: Uint8Array) => void): void;
  onClose(cb: () => void): void;
  close(): void;
};

export function makeRawTlsConnect(caPem?: string) {
  return (host: string, port: number): Promise<RawTlsSocket> =>
    new Promise((resolve, reject) => {
      let settled = false;
      let dataCb: ((b: Uint8Array) => void) | null = null;
      let closeCb: (() => void) | null = null;
      const sock = TcpSocket.connectTLS({ host, port, ...tlsTrust(caPem) }, () => {
        if (settled) return;
        settled = true;
        resolve({
          write: (bytes) => sock.write(Buffer.from(bytes) as unknown as string),
          onData: (cb) => { dataCb = cb; },
          onClose: (cb) => { closeCb = cb; },
          close: () => { try { sock.destroy(); } catch {} },
        });
      });
      sock.on('data', (d: string | Buffer) => {
        const bytes = typeof d === 'string' ? Uint8Array.from(Buffer.from(d, 'base64')) : Uint8Array.from(d);
        dataCb?.(bytes);
      });
      sock.on('error', (e: Error) => { if (!settled) { settled = true; reject(e); } });
      sock.on('close', () => { closeCb?.(); });
    });
}

/** SHA-1 for the WebSocket handshake accept, via forge (no platform crypto import). */
export function sha1(data: Uint8Array): Uint8Array {
  const md = forge.md.sha1.create();
  let s = '';
  for (const b of data) s += String.fromCharCode(b);
  md.update(s);
  const digest = md.digest().getBytes();
  const out = new Uint8Array(digest.length);
  for (let i = 0; i < digest.length; i++) out[i] = digest.charCodeAt(i) & 0xff;
  return out;
}

/** CSPRNG bytes via the polyfilled platform crypto (WS masks + client key). */
export function randomBytes(n: number): Uint8Array {
  const g = globalThis as { crypto?: { getRandomValues?: (a: Uint8Array) => Uint8Array } };
  const grv = g.crypto?.getRandomValues?.bind(g.crypto);
  if (!grv) throw new Error('no platform CSPRNG');
  return grv(new Uint8Array(n));
}

/**
 * Is a TCP port open on this host? Used by the LAN sweep to prove a Google TV
 * (Android TV Remote 6466) or an LG (webOS SSAP 3001) is really there — neither
 * brand has an HTTP endpoint that proves its control channel is live, the way
 * Roku's device-info does.
 *
 * Plain TCP, no TLS: this asks "is something listening", never "who are you",
 * so it is the cheapest question that still answers honestly. Always resolves —
 * a refused or timed-out port is `false`, never a throw, because a sweep of 254
 * hosts is mostly failures by design.
 */
export function tcpProbe(host: string, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    let sock: ReturnType<typeof TcpSocket.createConnection> | undefined;
    const done = (v: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { sock?.destroy(); } catch {}
      resolve(v);
    };
    const timer = setTimeout(() => done(false), timeoutMs);
    try {
      sock = TcpSocket.createConnection({ host, port }, () => done(true));
      sock.on('error', () => done(false));
    } catch {
      done(false);
    }
  });
}
