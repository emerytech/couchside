/**
 * Install-free core of the pinned-TLS HTTP transport (TLS P5): one box's
 * keep-alive connection (PinnedConn) + the HTTP/1.1 request framing. NO native
 * imports. The socket comes from an INJECTED `connect` (boxTls wires in
 * connectPinned, which verifies the modulus pin before it resolves), so this
 * lifecycle runs in CI's install-free strip-types glob with a fake socket.
 *
 * A per-box persistent connection: connect + verify the pin ONCE, then reuse the
 * socket for every request with HTTP/1.1 keep-alive + Content-Length framing. A
 * fresh TLS handshake + getPeerCertificate retry PER request stacks into seconds
 * of latency on repeated calls. Requests to one box are serialized over its one
 * socket; the connection self-heals on close/error (the pin is re-verified on the
 * reconnect, because every socket comes from `connect`). The agent is HTTP/1.1
 * and sends an exact Content-Length on every response, so framing on a reused
 * socket is safe; bytes that fall outside a frame mean desync and drop the socket.
 *
 * WHY THIS FILE EXISTS (2026-09-26, Razr / Android 16 against a Steam Machine on
 * agent 2.9.116, TLS-paired): Console showed "Cannot read property 'pressure' of
 * undefined" and the audio card "'length' of undefined". Requests were receiving
 * OTHER requests' bodies (/api/audio got the /api/leds reply), and one process
 * opened sockets at ~88/s. Three pool defects, each reproduced here with a fake
 * socket before the fix:
 *  1. A torn-down socket stayed wired to the pool. RN delivers `close` (and any
 *     queued data) AFTER destroy(), so the OLD socket's late reply resolved the
 *     NEXT request, and its late close failed the new request and dropped the
 *     pool's reference to the NEW socket, orphaning it with live handlers.
 *     Now every handler is identity-guarded against the pool's current socket.
 *  2. A request's timeout started only when it became ACTIVE, while the caller
 *     (api.ts attempt) gave up after timeoutMs+1s from CALL time. Abandoned
 *     requests stayed queued and were still written later. Now the deadline runs
 *     from ENQUEUE; an expired request is removed and never written.
 *  3. No backoff: against a host that refuses, every queued request opened its
 *     own socket. Now a failed connect fails every request waiting on it with
 *     that one error, and requests during a growing cooldown (0.5 s up to 8 s)
 *     fail fast with the same error object (a PinMismatchError stays one).
 */
import { Buffer } from 'buffer';

import { httpFrameLength, parseHttpResponse } from './boxTlsCodec.ts';
import type { PinnedResponse } from './boxTlsCodec.ts';

/** A live, pinned TLS byte stream. Mirrors the shape lib/tvdirect uses. */
export type PinnedSocket = {
  write(bytes: Uint8Array): void;
  onData(cb: (bytes: Uint8Array) => void): void;
  onClose(cb: () => void): void;
  /**
   * OPTIONAL. A post-open transport error on the live socket.
   *
   * react-native-tcp-socket's write() is fire-and-forget on a single writeExecutor
   * thread: a failed write does NOT throw at the call site, it surfaces later as the
   * socket's `error` event (which connectPinned used to SWALLOW once settled). Wiring
   * this lets a consumer flip to a dead-socket state on that FIRST error instead of
   * waiting for RN's much-later `close`, during which it would keep writing frames
   * into a socket that is already gone. The WebSocket client (boxWsConn) wires it;
   * the HTTP pool (PinnedConn) does not (it degrades on close/desync instead), so it
   * is optional and a socket may omit it.
   */
  onError?(cb: (e: Error) => void): void;
  close(): void;
};

/**
 * A pinned request that ran out of time. `sent` says whether its bytes reached
 * the socket: true means the box may have acted on it; false means it expired
 * waiting in the queue or on the connect and was NEVER written. Callers check
 * `name` (like PinMismatchError) so they need not import this module.
 */
export class PinnedTimeoutError extends Error {
  readonly sent: boolean;
  constructor(sent: boolean) {
    super(sent ? 'pinned request timeout' : 'pinned request timeout (never sent)');
    this.name = 'PinnedTimeoutError';
    this.sent = sent;
  }
}

/** Cooldown after consecutive failed connects: 0.5, 1, 2, 4, then 8 s (cap). */
export const CONNECT_BACKOFF_MS: readonly number[] = [500, 1000, 2000, 4000, 8000];

export function u8concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
}

export type PinnedHttpRequest = { method?: string; path: string; token?: string; body?: string };

/** Frame one HTTP/1.1 keep-alive request (JSON body, optional bearer token). */
export function frameHttpRequest(host: string, req: PinnedHttpRequest): Uint8Array {
  const method = req.method ?? 'GET';
  const bodyBytes = req.body ? Buffer.from(req.body, 'utf8') : null;
  let head = `${method} ${req.path} HTTP/1.1\r\nHost: ${host}\r\nConnection: keep-alive\r\n`;
  if (req.token) head += `Authorization: Bearer ${req.token}\r\n`;
  if (bodyBytes) head += `Content-Type: application/json\r\nContent-Length: ${bodyBytes.length}\r\n`;
  head += '\r\n';
  const headBytes = new Uint8Array(Buffer.from(head, 'utf8'));
  return bodyBytes ? u8concat(headBytes, new Uint8Array(bodyBytes)) : headBytes;
}

function asError(e: unknown): Error {
  return e instanceof Error ? e : new Error(String(e));
}

type PendingReq = {
  bytes: Uint8Array;
  resolve: (r: PinnedResponse) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout> | null;
  done: boolean;
  deadline: number;
};

export type PinnedConnOpts = {
  /** Clock for the connect cooldown. Injectable so tests need not sleep. */
  now?: () => number;
};

export class PinnedConn {
  private readonly connect: () => Promise<PinnedSocket>;
  private readonly now: () => number;
  private sock: PinnedSocket | null = null;
  private connecting = false;
  /** Requests not yet written, in order. */
  private queue: PendingReq[] = [];
  /** The one request written to `sock` and awaiting its response. */
  private active: PendingReq | null = null;
  private buf: Uint8Array = new Uint8Array(0);
  private wantLen = -1; // total bytes (headers+body) of the in-flight response, -1 until headers parse
  private failures = 0;
  private cooldownUntil = 0;
  private lastErr: Error | null = null;

  constructor(connect: () => Promise<PinnedSocket>, opts?: PinnedConnOpts) {
    this.connect = connect;
    this.now = opts?.now ?? (() => (globalThis.performance?.now?.() ?? Date.now()));   // monotonic: a backward wall-clock step must not stretch the cooldown
  }

  request(bytes: Uint8Array, timeoutMs: number): Promise<PinnedResponse> {
    return new Promise((resolve, reject) => {
      if (this.inCooldown()) {
        // A connect to this box just failed. Fail fast with THAT error instead of
        // opening another socket against a host that refuses.
        reject(this.lastErr!);
        return;
      }
      const req: PendingReq = { bytes, resolve, reject, timer: null, done: false,
        deadline: this.now() + Math.max(0, timeoutMs) };
      // The deadline runs from ENQUEUE and covers queue wait + connect + reply.
      // The caller's own deadline starts at the same moment and is later, so the
      // pool always settles first and an abandoned request is never written.
      req.timer = setTimeout(() => this.expire(req), Math.max(0, timeoutMs));
      this.queue.push(req);
      this.pump();
    });
  }

  private inCooldown(): boolean {
    return !this.sock && !this.connecting && this.lastErr !== null && this.now() < this.cooldownUntil;
  }

  private pump(): void {
    if (this.active || this.queue.length === 0) return;
    // Timers can be delayed by a busy JS thread. Recheck elapsed time before
    // sending: a queued power/volume command must not execute after its budget.
    while (this.queue.length && this.now() >= this.queue[0].deadline) {
      this.settle(this.queue.shift()!, new PinnedTimeoutError(false), null);
    }
    if (!this.queue.length) return;
    const sock = this.sock;
    if (!sock) {
      this.startConnect();
      return;
    }
    const req = this.queue.shift()!;
    this.active = req;
    this.wantLen = -1;
    try {
      sock.write(req.bytes);
    } catch (e) {
      this.failActive(asError(e));
    }
  }

  private startConnect(): void {
    if (this.connecting) return;
    if (this.inCooldown()) {
      this.rejectQueued(this.lastErr!);
      return;
    }
    this.connecting = true;
    let p: Promise<PinnedSocket>;
    try {
      p = this.connect();
    } catch (e) {
      p = Promise.reject(e);
    }
    p.then(
      (s) => {
        this.connecting = false;
        this.failures = 0;
        this.lastErr = null;
        this.cooldownUntil = 0;
        this.sock = s;
        this.buf = new Uint8Array(0);
        this.wantLen = -1;
        // Identity-guarded. Once `s` is no longer the pool's socket (dropped on a
        // timeout or desync, replaced by a reconnect), whatever it still emits
        // (late reply bytes, the close RN delivers AFTER destroy()) is ignored.
        s.onData((b) => {
          if (this.sock === s) this.onData(b);
        });
        s.onClose(() => {
          if (this.sock === s) this.onClose();
        });
        this.pump();
      },
      (e: unknown) => {
        this.connecting = false;
        const err = asError(e);
        this.failures += 1;
        this.lastErr = err;
        const step = CONNECT_BACKOFF_MS[Math.min(this.failures, CONNECT_BACKOFF_MS.length) - 1];
        this.cooldownUntil = this.now() + step;
        // Every request that was waiting on THIS connect fails with its error:
        // one refused connect is one refused connect, not one per request.
        this.rejectQueued(err);
      },
    );
  }

  private rejectQueued(err: Error): void {
    for (const r of this.queue.splice(0)) this.settle(r, err, null);
  }

  private settle(req: PendingReq, err: Error | null, res: PinnedResponse | null): void {
    if (req.done) return;
    req.done = true;
    if (req.timer) clearTimeout(req.timer);
    req.timer = null;
    if (err) req.reject(err);
    else req.resolve(res!);
  }

  private expire(req: PendingReq): void {
    if (req.done) return;
    if (this.active === req) {
      // Written, and the box has not answered in time. Its reply may still be in
      // flight, so the stream can no longer frame the NEXT response: drop the
      // socket (the next request reconnects and re-verifies the pin).
      this.failActive(new PinnedTimeoutError(true));
      return;
    }
    const i = this.queue.indexOf(req);
    if (i >= 0) this.queue.splice(i, 1);
    this.settle(req, new PinnedTimeoutError(false), null);
  }

  /** Stop using the current socket. Clears `sock` FIRST, so every later event
   *  from the old socket fails the identity guard. */
  private dropSocket(): void {
    const s = this.sock;
    this.sock = null;
    this.buf = new Uint8Array(0);
    this.wantLen = -1;
    if (s) {
      try { s.close(); } catch {}
    }
  }

  private onData(bytes: Uint8Array): void {
    const req = this.active;
    if (!req) {
      // Bytes with nothing in flight belong to no request we can name: the
      // stream is desynced. Drop the socket rather than let them prefix the next
      // response.
      this.dropSocket();
      this.pump();
      return;
    }
    this.buf = u8concat(this.buf, bytes);
    if (this.wantLen < 0) {
      this.wantLen = httpFrameLength(this.buf);
      if (this.wantLen < 0) return; // headers still arriving
    }
    if (this.buf.length < this.wantLen) return; // body still arriving
    const parsed = parseHttpResponse(this.buf.subarray(0, this.wantLen));
    const extra = this.buf.length > this.wantLen;
    this.active = null;
    this.buf = new Uint8Array(0);
    this.wantLen = -1;
    // Requests are strictly serialized (one in flight), so bytes past this
    // response's frame answer nothing we asked: desynced, drop the socket.
    if (extra) this.dropSocket();
    if (parsed) this.settle(req, null, parsed);
    else this.settle(req, new Error('malformed HTTP response'), null);
    this.pump();
  }

  private failActive(e: Error): void {
    const req = this.active;
    this.active = null;
    // A mid-response error may have left the stream desynced. Drop the socket so
    // the next request reconnects and re-verifies the pin.
    this.dropSocket();
    if (req) this.settle(req, e, null);
    this.pump();
  }

  private onClose(): void {
    // Only reached for the CURRENT socket (identity guard at registration).
    this.sock = null;
    this.failActive(new Error('pinned socket closed'));
  }
}
