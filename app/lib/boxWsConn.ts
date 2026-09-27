/**
 * Install-free core of the pinned WebSocket (TLS P5, phase 5b): a WHATWG-
 * `WebSocket`-shaped client over an INJECTED pinned byte stream + the
 * transport-agnostic RFC6455 codec (lib/tvdirect/ws.ts). boxWs.ts subclasses it
 * with the real connectPinned; keeping the socket injected lets CI drive this
 * lifecycle with a fake socket (connect -> handshake -> open -> close -> late
 * bytes), which matters because it carries the gamepad on a secure box.
 *
 * Authentication is the modulus pin in connectPinned (spec §2: `{ca}` is
 * unenforceable on iOS). We therefore skip Sec-WebSocket-Accept verification (the
 * peer is already proven by the pin); the handshake still requires a `101`.
 *
 * Once CLOSED, nothing the old socket still delivers reaches onmessage/onopen:
 * RN delivers close (and any bytes already queued) asynchronously after
 * destroy(), the same late-event hazard that crossed HTTP replies in
 * boxTlsConn.ts (2026-09-26).
 */
import type { PinnedSocket } from './boxTlsConn.ts';
import {
  OPCODE,
  encodeFrame,
  encodeText,
  frameText,
  handshake,
  makeDecoder,
  parseHandshakeResponse,
} from './tvdirect/ws.ts';

const CONNECTING = 0;
const OPEN = 1;
const CLOSING = 2;
const CLOSED = 3;

/** WS frame masks + the handshake key. Needs a platform CSPRNG (boxWs.ts
 *  installs react-native-get-random-values on device; Node has one built in). */
export function wsRandomBytes(n: number): Uint8Array {
  const a = new Uint8Array(n);
  const g = globalThis as { crypto?: { getRandomValues?: (a: Uint8Array) => Uint8Array } };
  const grv = g.crypto?.getRandomValues?.bind(g.crypto);
  if (!grv) throw new Error('no platform CSPRNG for WS masks');
  return grv(a);
}

function toArrayBuffer(u: Uint8Array): ArrayBuffer {
  return u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength) as ArrayBuffer;
}

export class PinnedWsConn {
  static readonly CONNECTING = CONNECTING;
  static readonly OPEN = OPEN;
  static readonly CLOSING = CLOSING;
  static readonly CLOSED = CLOSED;

  binaryType: 'arraybuffer' | 'blob' = 'blob';
  readyState: number = CONNECTING;
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string | ArrayBuffer }) => void) | null = null;
  onerror: ((e?: unknown) => void) | null = null;
  onclose: (() => void) | null = null;

  private sock: PinnedSocket | null = null;
  private decoder = makeDecoder();
  private expectAccept: string | null = null;
  private upgraded = false;
  private hsBuf: Uint8Array = new Uint8Array(0);

  constructor(host: string, path: string, connect: () => Promise<PinnedSocket>) {
    connect()
      .then((sock) => {
        if (this.readyState === CLOSED) { try { sock.close(); } catch {} return; } // closed before connect
        this.sock = sock;
        // Identity-guarded: after handleClose drops `sock`, its late events are ignored.
        sock.onData((b) => { if (this.sock === sock) this.onBytes(b); });
        sock.onClose(() => { if (this.sock === sock) this.handleClose(); });
        // A post-open transport error (a fire-and-forget write that failed on RN's
        // worker thread) means this socket is dead. Treat it as a clean close: flip
        // to CLOSED and fire onclose ONCE, so send() stops writing into a socket the
        // OS has already given up on — instead of feeding it frames until RN's much-
        // later `close` finally lands. Not fail(): a mid-stream drop is a disconnect,
        // not an app-visible error, and onclose is what drives the reconnect.
        sock.onError?.(() => { if (this.sock === sock) this.handleClose(); });
        // No sha1 -> accept header not verified; the modulus pin already
        // authenticated the peer (ws.ts handshake still requires a 101).
        const { request } = handshake(host, { randomBytes: wsRandomBytes }, path);
        sock.write(request);
      })
      .catch((e) => this.fail(e));
  }

  private onBytes(bytes: Uint8Array): void {
    if (this.readyState === CLOSED) return;
    if (!this.upgraded) {
      // Accumulate until the handshake response is complete.
      const merged = new Uint8Array(this.hsBuf.length + bytes.length);
      merged.set(this.hsBuf);
      merged.set(bytes, this.hsBuf.length);
      this.hsBuf = merged;
      const res = parseHandshakeResponse(this.hsBuf, this.expectAccept);
      if (!res.done) return;
      if (!res.ok) { this.fail(new Error(res.error || 'ws handshake failed')); return; }
      this.upgraded = true;
      this.readyState = OPEN;
      this.hsBuf = new Uint8Array(0);
      this.onopen?.();
      if (res.rest && res.rest.length) this.pump(res.rest); // server pipelined a frame
      return;
    }
    this.pump(bytes);
  }

  private pump(bytes: Uint8Array): void {
    for (const frame of this.decoder.push(bytes)) {
      if (this.readyState === CLOSED) return; // closed by an earlier frame / callback
      if (frame.opcode === OPCODE.text) {
        this.onmessage?.({ data: frameText(frame) });
      } else if (frame.opcode === OPCODE.binary) {
        this.onmessage?.({ data: toArrayBuffer(frame.payload) });
      } else if (frame.opcode === OPCODE.ping) {
        this.rawSend(OPCODE.pong, frame.payload);
      } else if (frame.opcode === OPCODE.close) {
        this.close();
      }
      // pong: ignore
    }
  }

  private rawSend(opcode: number, payload: Uint8Array): void {
    if (!this.sock || this.readyState !== OPEN) return;
    try {
      this.sock.write(encodeFrame(opcode, payload, wsRandomBytes(4)));
    } catch (e) {
      this.fail(e);
    }
  }

  send(data: string | ArrayBuffer | ArrayBufferView): void {
    if (!this.sock || this.readyState !== OPEN) return;
    try {
      if (typeof data === 'string') {
        this.sock.write(encodeText(data, wsRandomBytes(4)));
      } else {
        const u = data instanceof ArrayBuffer
          ? new Uint8Array(data)
          : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
        this.sock.write(encodeFrame(OPCODE.binary, u, wsRandomBytes(4)));
      }
    } catch (e) {
      this.fail(e);
    }
  }

  close(): void {
    if (this.readyState === CLOSED || this.readyState === CLOSING) {
      this.readyState = CLOSED;
      return;
    }
    if (this.sock && this.readyState === OPEN) {
      try { this.sock.write(encodeFrame(OPCODE.close, new Uint8Array(0), wsRandomBytes(4))); } catch {}
    }
    this.readyState = CLOSING;
    try { this.sock?.close(); } catch {}
    this.handleClose();
  }

  private fail(e: unknown): void {
    if (this.readyState === CLOSED) return;
    this.onerror?.(e);
    this.handleClose();
  }

  private handleClose(): void {
    if (this.readyState === CLOSED) return;
    this.readyState = CLOSED;
    const s = this.sock;
    this.sock = null;
    try { s?.close(); } catch {}
    this.onclose?.();
  }
}
