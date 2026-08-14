/**
 * Pinned TLS transport to a Couchside box (TLS P5, phase 5a).
 *
 * THE WALL (spec §1): RN's fetch/WebSocket/<Image>/WebView give no self-signed
 * trust override, and — proven by the 2026-08-13 device spike (spec §2) —
 * react-native-tcp-socket's `{ca}` option does NOT enforce a pin on iOS (the
 * native side manually accepts every cert once a `ca` is present). The one
 * mechanism that authenticates on BOTH iOS and Android is a MANUAL pin: connect
 * accept-all (encrypt), then read the live cert via getPeerCertificate() and
 * compare its RSA modulus to the modulus captured at pairing. This module is that
 * transport: `connectPinned` + a hand-rolled HTTP/1.1 client over the socket. The
 * RFC6455 WS client (phase 5b) rides the same `connectPinned`.
 *
 * Trust root = physical possession of the box at pairing (the fingerprint is read
 * off the box's own screen and delivered in the QR); the modulus is derived from
 * the PEM whose integrity that fingerprint proves. On mismatch we DESTROY the
 * socket before a byte of app data is sent — an active MITM presenting any other
 * cert is rejected in JS.
 *
 * Plaintext http/ws is NEVER removed (spec Decision B): callers fall back to it
 * for boxes without a pin. This module is only used when a box has `secure` +
 * `pinModulus`.
 */
import { Buffer } from 'buffer';
import TcpSocket from 'react-native-tcp-socket';

import { normalizeModulus, parseHttpResponse, type PinnedResponse } from './boxTlsCodec';

export { normalizeModulus, parseHttpResponse } from './boxTlsCodec';
export type { PinnedResponse } from './boxTlsCodec';
// Pairing-time forge helpers live in boxTlsPair (no native import); re-exported
// here for convenience.
export { certFpFromPem, modulusFromPem, resolveTlsPin, type TlsPin } from './boxTlsPair';

/** A live, pinned TLS byte stream. Mirrors the shape lib/tvdirect uses. */
export type PinnedSocket = {
  write(bytes: Uint8Array): void;
  onData(cb: (bytes: Uint8Array) => void): void;
  onClose(cb: () => void): void;
  close(): void;
};

export class PinMismatchError extends Error {
  constructor(
    readonly liveModulus: string | null,
    readonly pinnedModulus: string,
  ) {
    super('TLS pin mismatch: the box presented a certificate whose key does not match the pinned one');
    this.name = 'PinMismatchError';
  }
}

type PeerCert = { modulus?: string; pubkey?: string } | null;

// getPeerCertificate fires before the native TLS handshake finishes (see the
// atvnative note) — poll briefly until the modulus is available.
async function readLiveModulus(sock: { getPeerCertificate?: () => Promise<PeerCert> }, timeoutMs = 6000): Promise<string | null> {
  if (typeof sock.getPeerCertificate !== 'function') return null;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const cert = await sock.getPeerCertificate();
      if (cert && cert.modulus) return normalizeModulus(cert.modulus);
    } catch {
      // not secured yet — retry
    }
    if (Date.now() >= deadline) return null;
    await new Promise((r) => setTimeout(r, 150));
  }
}

/**
 * Open a TLS socket to the box and AUTHENTICATE it by modulus pin. Resolves only
 * once the live cert's modulus matches `pinModulus`; rejects (and destroys the
 * socket) on mismatch, on a missing modulus, or on any connect error.
 *
 * `pinModulus` must already be normalized (use modulusFromPem at pairing time).
 * `{ca}` is passed too — harmless on iOS (ignored), and it gives Android native
 * enforcement for free — but the modulus compare below is the load-bearing check
 * on both platforms.
 */
export function connectPinned(
  host: string,
  port: number,
  pinModulus: string,
  opts?: { caPem?: string; timeoutMs?: number },
): Promise<PinnedSocket> {
  const timeoutMs = opts?.timeoutMs ?? 12000;
  return new Promise((resolve, reject) => {
    let settled = false;
    let dataCb: ((b: Uint8Array) => void) | null = null;
    let closeCb: (() => void) | null = null;
    const fail = (e: Error) => {
      if (settled) return;
      settled = true;
      try { sock.destroy(); } catch {}
      reject(e);
    };
    const timer = setTimeout(() => fail(new Error('pinned connect timeout')), timeoutMs);
    // ca/rejectUnauthorized are read natively but absent from the .d.ts -> cast.
    const tlsOpts: Record<string, unknown> = { host, port };
    if (opts?.caPem) { tlsOpts.ca = opts.caPem; tlsOpts.rejectUnauthorized = true; }
    else { tlsOpts.rejectUnauthorized = false; }
    const sock = (TcpSocket.connectTLS as unknown as (o: Record<string, unknown>, cb: () => void) => any)(
      tlsOpts,
      () => {
        // Secure (encrypted) — now authenticate by modulus before resolving.
        void (async () => {
          const live = await readLiveModulus(sock);
          if (settled) return;
          if (!live || live !== pinModulus) {
            clearTimeout(timer);
            fail(new PinMismatchError(live, pinModulus));
            return;
          }
          settled = true;
          clearTimeout(timer);
          resolve({
            write: (b) => sock.write(Buffer.from(b) as unknown as string),
            onData: (cb) => { dataCb = cb; },
            onClose: (cb) => { closeCb = cb; },
            close: () => { try { sock.destroy(); } catch {} },
          });
        })();
      },
    );
    sock.on('data', (d: string | Buffer) => {
      const bytes = typeof d === 'string' ? Uint8Array.from(Buffer.from(d, 'base64')) : Uint8Array.from(d);
      dataCb?.(bytes);
    });
    sock.on('error', (e: Error) => fail(e));
    sock.on('close', () => { if (settled) closeCb?.(); else fail(new Error('socket closed before TLS pin verified')); });
  });
}

// ---- Hand-rolled HTTP/1.1 client over the pinned socket ---------------------

/**
 * One HTTP/1.1 request over a freshly-pinned socket, `Connection: close` so the
 * box closes when done and we read the whole response. Replaces `fetch` for box
 * calls when the box is `secure`. Small JSON responses only — this is the box
 * control API, not a bulk transfer.
 */
export async function pinnedRequest(
  host: string,
  port: number,
  pinModulus: string,
  req: { method?: string; path: string; token?: string; body?: string; caPem?: string; timeoutMs?: number },
): Promise<PinnedResponse> {
  const sock = await connectPinned(host, port, pinModulus, { caPem: req.caPem, timeoutMs: req.timeoutMs });
  return new Promise<PinnedResponse>((resolve, reject) => {
    const chunks: Uint8Array[] = [];
    let done = false;
    const finish = (fn: () => void) => { if (done) return; done = true; try { sock.close(); } catch {} fn(); };
    const readTimer = setTimeout(
      () => finish(() => reject(new Error('pinned request read timeout'))),
      req.timeoutMs ?? 12000,
    );
    sock.onData((b) => chunks.push(b));
    sock.onClose(() => {
      clearTimeout(readTimer);
      const raw = Buffer.concat(chunks.map((c) => Buffer.from(c)));
      const parsed = parseHttpResponse(new Uint8Array(raw));
      finish(() => (parsed ? resolve(parsed) : reject(new Error('malformed HTTP response'))));
    });
    const method = req.method ?? 'GET';
    const bodyBytes = req.body ? Buffer.from(req.body, 'utf8') : null;
    let head = `${method} ${req.path} HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n`;
    if (req.token) head += `Authorization: Bearer ${req.token}\r\n`;
    if (bodyBytes) head += `Content-Type: application/json\r\nContent-Length: ${bodyBytes.length}\r\n`;
    head += '\r\n';
    sock.write(new Uint8Array(Buffer.from(head, 'utf8')));
    if (bodyBytes) sock.write(new Uint8Array(bodyBytes));
  });
}
