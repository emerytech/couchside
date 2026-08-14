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

import { httpFrameLength, normalizeModulus, parseHttpResponse, type PinnedResponse } from './boxTlsCodec';

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

// ---- Hand-rolled HTTP/1.1 client over a REUSED pinned socket ----------------
//
// A per-box persistent connection: connect + verify the modulus ONCE, then reuse
// the socket for every request with HTTP/1.1 keep-alive + Content-Length framing.
// The alternative — a fresh TLS handshake + getPeerCertificate retry PER request —
// stacks into seconds of latency on repeated calls (the screen still-frame poll,
// dozens of connects per second). Requests to one box are serialized over its one
// socket; the connection self-heals on close/error (the pin is re-verified on the
// reconnect). The agent is HTTP/1.1 and sends an exact Content-Length on every
// response, so framing on a reused socket is safe.

function u8concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
}

type PendingReq = {
  bytes: Uint8Array;
  resolve: (r: PinnedResponse) => void;
  reject: (e: Error) => void;
  timeoutMs: number;
};

class PinnedConn {
  private sock: PinnedSocket | null = null;
  private connectP: Promise<PinnedSocket> | null = null;
  private queue: PendingReq[] = [];
  private active: PendingReq | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private buf: Uint8Array = new Uint8Array(0);
  private wantLen = -1; // total bytes (headers+body) of the in-flight response, -1 until headers parse

  constructor(
    private host: string,
    private port: number,
    private pin: string,
    private caPem?: string,
  ) {}

  request(bytes: Uint8Array, timeoutMs: number): Promise<PinnedResponse> {
    return new Promise((resolve, reject) => {
      this.queue.push({ bytes, resolve, reject, timeoutMs });
      void this.pump();
    });
  }

  private ensureSock(): Promise<PinnedSocket> {
    if (this.sock) return Promise.resolve(this.sock);
    if (!this.connectP) {
      this.connectP = connectPinned(this.host, this.port, this.pin, { caPem: this.caPem })
        .then((s) => {
          this.sock = s;
          this.buf = new Uint8Array(0);
          s.onData((b) => this.onData(b));
          s.onClose(() => this.onClose());
          return s;
        })
        .finally(() => {
          this.connectP = null;
        });
    }
    return this.connectP;
  }

  private async pump(): Promise<void> {
    if (this.active || this.queue.length === 0) return;
    const req = this.queue[0];
    this.active = req;
    this.wantLen = -1;
    let sock: PinnedSocket;
    try {
      sock = await this.ensureSock();
    } catch (e) {
      this.failActive(e as Error);
      return;
    }
    this.timer = setTimeout(() => this.failActive(new Error('pinned request timeout')), req.timeoutMs);
    try {
      sock.write(req.bytes);
    } catch (e) {
      this.failActive(e as Error);
    }
  }

  private onData(bytes: Uint8Array): void {
    if (!this.active) return; // stray bytes with nothing in flight — drop
    this.buf = u8concat(this.buf, bytes);
    if (this.wantLen < 0) {
      this.wantLen = httpFrameLength(this.buf);
      if (this.wantLen < 0) return; // headers still arriving
    }
    if (this.buf.length < this.wantLen) return; // body still arriving
    const raw = this.buf.subarray(0, this.wantLen);
    const rest = this.buf.slice(this.wantLen);
    const parsed = parseHttpResponse(raw);
    const req = this.active;
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    this.queue.shift();
    this.active = null;
    this.wantLen = -1;
    this.buf = rest;
    if (parsed) req!.resolve(parsed);
    else req!.reject(new Error('malformed HTTP response'));
    void this.pump();
  }

  private failActive(e: Error): void {
    const req = this.active;
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    this.active = null;
    this.wantLen = -1;
    // A mid-response error may have left the stream desynced — drop the socket so
    // the next request reconnects and re-verifies the pin.
    try { this.sock?.close(); } catch {}
    this.sock = null;
    this.buf = new Uint8Array(0);
    if (req) {
      this.queue.shift();
      req.reject(e);
    }
    void this.pump();
  }

  private onClose(): void {
    this.sock = null;
    this.buf = new Uint8Array(0);
    if (this.active) this.failActive(new Error('pinned socket closed'));
    else void this.pump();
  }
}

const POOL = new Map<string, PinnedConn>();

/**
 * One HTTP/1.1 request over a REUSED, modulus-pinned keep-alive socket to the box.
 * Replaces fetch for box calls when the box is secure. Requests to the same box
 * share one TLS connection (handshake + pin verify amortized), serialized in order.
 */
export function pinnedRequest(
  host: string,
  port: number,
  pinModulus: string,
  req: { method?: string; path: string; token?: string; body?: string; caPem?: string; timeoutMs?: number },
): Promise<PinnedResponse> {
  const key = `${host}:${port}:${pinModulus.slice(0, 16)}`;
  let conn = POOL.get(key);
  if (!conn) {
    conn = new PinnedConn(host, port, pinModulus, req.caPem);
    POOL.set(key, conn);
  }
  const method = req.method ?? 'GET';
  const bodyBytes = req.body ? Buffer.from(req.body, 'utf8') : null;
  let head = `${method} ${req.path} HTTP/1.1\r\nHost: ${host}\r\nConnection: keep-alive\r\n`;
  if (req.token) head += `Authorization: Bearer ${req.token}\r\n`;
  if (bodyBytes) head += `Content-Type: application/json\r\nContent-Length: ${bodyBytes.length}\r\n`;
  head += '\r\n';
  const reqBytes = bodyBytes
    ? u8concat(new Uint8Array(Buffer.from(head, 'utf8')), new Uint8Array(bodyBytes))
    : new Uint8Array(Buffer.from(head, 'utf8'));
  return conn.request(reqBytes, req.timeoutMs ?? 12000);
}
