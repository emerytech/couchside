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

import { normalizeModulus, type PinnedResponse } from './boxTlsCodec';
import { PinnedConn, frameHttpRequest, type PinnedSocket } from './boxTlsConn';

export { normalizeModulus, parseHttpResponse } from './boxTlsCodec';
export type { PinnedResponse } from './boxTlsCodec';
export { PinnedTimeoutError } from './boxTlsConn';
export type { PinnedSocket } from './boxTlsConn';
// Pairing-time forge helpers live in boxTlsPair (no native import); re-exported
// here for convenience.
export { certFpFromPem, modulusFromPem, resolveTlsPin, type TlsPin } from './boxTlsPair';

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
    let errorCb: ((e: Error) => void) | null = null;
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
        // Secure (encrypted). TCP_NODELAY: the gamepad streams ~90 Hz tiny frames,
        // so Nagle can coalesce/delay them into visible cursor stutter. Set it here,
        // via setNoDelay() on the LIVE socket — react-native-tcp-socket's native
        // connect() ignores a `noDelay` CONNECT option (only localAddress/interface/
        // reuseAddress/localPort/connectTimeout are read; Nagle is toggled only by
        // the separate setNoDelay() method, which exists on Android AND iOS). Best
        // effort: guarded + try/catch so a build without it cannot break connect.
        try {
          const s = sock as unknown as { setNoDelay?: (v?: boolean) => void };
          if (typeof s.setNoDelay === 'function') s.setNoDelay(true);
        } catch { /* Nagle stays on; correctness unaffected */ }
        // Now authenticate by modulus before resolving. Cap the cert poll at the
        // connect budget: a caller with a short timeoutMs (the gamepad socket, so a
        // reconnect's cert-verify fits inside its connect watchdog) must not let
        // readLiveModulus keep polling to its 6 s default past the point the connect
        // itself has already timed out. min() keeps the 6 s cap for the default path.
        void (async () => {
          const live = await readLiveModulus(sock, Math.min(timeoutMs, 6000));
          if (settled) return;
          if (!live || live !== pinModulus) {
            clearTimeout(timer);
            fail(new PinMismatchError(live, pinModulus));
            return;
          }
          settled = true;
          clearTimeout(timer);
          resolve({
            // A write can fail AFTER open (RN's write is fire-and-forget on a worker
            // thread, so a broken pipe surfaces as the 'error' event below, not here)
            // — but a synchronous throw is still possible. Route it to errorCb when a
            // consumer wired one (the WS client), else rethrow so the HTTP pool's own
            // try/catch (PinnedConn.pump) still sees it. Never both.
            write: (b) => {
              try {
                sock.write(Buffer.from(b) as unknown as string);
              } catch (e) {
                const err = e instanceof Error ? e : new Error(String(e));
                if (errorCb) errorCb(err);
                else throw err;
              }
            },
            onData: (cb) => { dataCb = cb; },
            onClose: (cb) => { closeCb = cb; },
            onError: (cb) => { errorCb = cb; },
            // Detach BEFORE destroy: RN delivers the close event (and any bytes
            // already queued) asynchronously AFTER destroy(), and nothing that
            // arrives then may reach whoever held this socket.
            close: () => {
              dataCb = null;
              closeCb = null;
              errorCb = null;
              try { sock.destroy(); } catch {}
            },
          });
        })();
      },
    );
    sock.on('data', (d: string | Buffer) => {
      const bytes = typeof d === 'string' ? Uint8Array.from(Buffer.from(d, 'base64')) : Uint8Array.from(d);
      dataCb?.(bytes);
    });
    // Pre-settle: a connect/handshake error rejects the connect (unchanged). Post-
    // settle: the socket was live and just died — hand it to errorCb (the WS client
    // tears down NOW instead of writing into a dead socket until RN's lagging close).
    // The HTTP pool wires no errorCb, so its post-settle errors still no-op here and
    // it degrades on the following 'close' exactly as before.
    sock.on('error', (e: Error) => { if (settled) errorCb?.(e); else fail(e); });
    sock.on('close', () => { if (settled) closeCb?.(); else fail(new Error('socket closed before TLS pin verified')); });
  });
}

// ---- Hand-rolled HTTP/1.1 client over a REUSED pinned socket ----------------
//
// The per-box keep-alive connection (queue, framing, deadlines, connect backoff,
// stale-socket guard) lives in boxTlsConn.ts so it is testable without the native
// module; this file only wires the real, pin-verifying connect into it.

const POOL = new Map<string, PinnedConn>();

/**
 * One HTTP/1.1 request over a REUSED, modulus-pinned keep-alive socket to the box.
 * Replaces fetch for box calls when the box is secure. Requests to the same box
 * share one TLS connection (handshake + pin verify amortized), serialized in order.
 * `timeoutMs` runs from this call and covers queue wait + connect + response.
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
    const caPem = req.caPem;
    conn = new PinnedConn(() => connectPinned(host, port, pinModulus, { caPem }));
    POOL.set(key, conn);
  }
  return conn.request(frameHttpRequest(host, req), req.timeoutMs ?? 12000);
}
