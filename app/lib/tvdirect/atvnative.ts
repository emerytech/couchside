/**
 * The React Native half of Android TV control: a TLS socket, a CSPRNG, and
 * client-certificate minting. Everything here is platform code — the protocol
 * itself lives in ./atvproto.ts and ./androidtv.ts and is deliberately free of
 * these imports so it can be tested against real hardware from bare Node.
 *
 * THE THREE THINGS THIS FILE EXISTS TO SOLVE, each a real constraint:
 *
 * 1. SELF-SIGNED TLS. Every Android TV presents a certificate it generated
 *    itself (measured: issuer == subject, `CN=atvremote/<MAC>`). Node opts out
 *    of verification with `rejectUnauthorized:false`; react-native-tcp-socket
 *    has NO such flag and trusts a self-signed peer only by PINNING it as `ca`.
 *    So the cert is fetched out-of-band once (see fetchPeerCert) and pinned on
 *    every later connection — trust-on-first-use, with the pinned bytes stored
 *    beside the TV record so a swapped certificate fails loudly instead of
 *    silently connecting to something else.
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
import forge from 'node-forge';
import TcpSocket from 'react-native-tcp-socket';

import {
  type AtvSocket,
  frame,
  makeFramer,
} from './atvproto.ts';
import { type MintResult, mintIdentity as mintWith, modulusFromPem, sha256 } from './atvcrypto.ts';

export { modulusFromPem, sha256 } from './atvcrypto.ts';
export type { MintResult } from './atvcrypto.ts';

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
 * Fetch the TV's certificate so it can be pinned.
 *
 * This is the TOFU step forced by point 1 above: the library cannot be told to
 * accept an unknown self-signed peer, and the peer certificate is only readable
 * from an already-trusted connection. So the first connection is made in the
 * one mode that does not verify — `tls.connect` WITHOUT a `ca`, which
 * react-native-tcp-socket treats as "use the system trust store" and which
 * FAILS for a self-signed peer... therefore this instead reads the certificate
 * from the failure path where the library surfaces it.
 *
 * IMPORTANT: this is UNVERIFIED on device. If the library does not surface the
 * peer certificate on an untrusted handshake, TOFU is not possible this way and
 * the fallback is to ship the pinning step differently (see the PR body). The
 * caller must treat a null return as "cannot pair on this platform yet" and say
 * so, rather than pretending the TV was unreachable.
 */
export function fetchPeerCert(host: string, port: number, timeoutMs = 6000): Promise<string | null> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v: string | null) => {
      if (settled) return;
      settled = true;
      try { sock?.destroy(); } catch {}
      resolve(v);
    };
    const timer = setTimeout(() => done(null), timeoutMs);
    let sock: ReturnType<typeof TcpSocket.connectTLS> | undefined;
    try {
      sock = TcpSocket.connectTLS({ host, port, ca: undefined as never }, () => {
        clearTimeout(timer);
        const anySock = sock as unknown as { getPeerCertificate?: () => { raw?: string } };
        const peer = anySock.getPeerCertificate?.();
        done(peer?.raw ?? null);
      });
      sock.on('error', () => {
        clearTimeout(timer);
        const anySock = sock as unknown as { getPeerCertificate?: () => { raw?: string } };
        done(anySock.getPeerCertificate?.()?.raw ?? null);
      });
    } catch {
      clearTimeout(timer);
      done(null);
    }
  });
}

/**
 * Build the connect function the protocol layer needs, pinning `caPem`.
 *
 * `caPem` is the TV's own certificate captured at pairing time. Pinning it is
 * strictly STRONGER than Node's rejectUnauthorized:false used by the live test:
 * that accepts any certificate, this accepts only the one this TV presented
 * when the user paired it.
 */
export function makeConnect(caPem: string) {
  return (host: string, port: number, certPem: string, keyPem: string): Promise<AtvSocket> =>
    new Promise((resolve, reject) => {
      let settled = false;
      const framer = makeFramer();
      const frames: Uint8Array[] = [];
      const waiters: { resolve: (f: Uint8Array) => void; reject: (e: Error) => void }[] = [];

      const sock = TcpSocket.connectTLS(
        { host, port, ca: caPem, cert: certPem, key: keyPem },
        () => {
          if (settled) return;
          settled = true;
          resolve({
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
            // The pairing secret needs the TV's modulus. It is derived from the
            // pinned certificate rather than from the live socket, because the
            // library exposes no modulus getter — and the pinned cert IS the
            // certificate this connection just verified against.
            peerModulusHex: () => modulusFromPem(caPem),
          });
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
 * A RAW TLS byte stream to a self-signed host, cert pinned. Unlike makeConnect
 * (which frames for the Android TV protocol), this hands the caller raw bytes in
 * and out — LG webOS runs a real RFC6455 WebSocket over it (see lib/tvdirect/ws).
 * `caPem` is the TV's own cert, fetched via fetchPeerCert first (TOFU), so this
 * accepts exactly that TV and nothing else.
 */
export type RawTlsSocket = {
  write(bytes: Uint8Array): void;
  onData(cb: (bytes: Uint8Array) => void): void;
  onClose(cb: () => void): void;
  close(): void;
};

export function makeRawTlsConnect(caPem: string) {
  return (host: string, port: number): Promise<RawTlsSocket> =>
    new Promise((resolve, reject) => {
      let settled = false;
      let dataCb: ((b: Uint8Array) => void) | null = null;
      let closeCb: (() => void) | null = null;
      const sock = TcpSocket.connectTLS({ host, port, ca: caPem }, () => {
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
