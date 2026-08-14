/**
 * Pinned WebSocket to a Couchside box (TLS P5, phase 5b).
 *
 * A WHATWG-`WebSocket`-shaped client over a modulus-pinned TLS socket
 * (connectPinned, boxTls) + the existing transport-agnostic RFC6455 codec
 * (lib/tvdirect/ws.ts, already used for webOS TVs). Exposes exactly the surface
 * the box WS callers use — `binaryType`, `readyState`, `onopen/onmessage/onerror/
 * onclose`, `send`, `close` — so `gamepad.ts` and `screenstream.ts` can swap
 * `new WebSocket(ws://…)` for this when the box is `secure`, with the token riding
 * an ENCRYPTED, authenticated socket instead of a cleartext `?token=` query.
 *
 * Authentication is the modulus pin in connectPinned (spec §2 — `{ca}` is
 * unenforceable on iOS). We therefore skip Sec-WebSocket-Accept verification (the
 * peer is already proven by the pin); the handshake still requires a `101`.
 *
 * Native-only (imports react-native-tcp-socket via boxTls); verified on-device.
 * Plaintext `ws://` is never removed — this is used only for pinned boxes.
 */
import 'react-native-get-random-values'; // installs globalThis.crypto.getRandomValues

import { connectPinned, type PinnedSocket } from './boxTls';
import {
  OPCODE,
  encodeFrame,
  encodeText,
  frameText,
  handshake,
  makeDecoder,
  parseHandshakeResponse,
} from './tvdirect/ws';

const CONNECTING = 0;
const OPEN = 1;
const CLOSING = 2;
const CLOSED = 3;

function randomBytes(n: number): Uint8Array {
  const a = new Uint8Array(n);
  const g = globalThis as { crypto?: { getRandomValues?: (a: Uint8Array) => Uint8Array } };
  const grv = g.crypto?.getRandomValues?.bind(g.crypto);
  if (!grv) throw new Error('no platform CSPRNG for WS masks');
  return grv(a);
}

function toArrayBuffer(u: Uint8Array): ArrayBuffer {
  return u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength) as ArrayBuffer;
}

export type PinnedWsOpts = { caPem?: string; timeoutMs?: number };

export class PinnedWebSocket {
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

  constructor(host: string, port: number, pinModulus: string, path: string, opts?: PinnedWsOpts) {
    connectPinned(host, port, pinModulus, { caPem: opts?.caPem, timeoutMs: opts?.timeoutMs })
      .then((sock) => {
        if (this.readyState === CLOSED) { try { sock.close(); } catch {} return; } // closed before connect
        this.sock = sock;
        sock.onData((b) => this.onBytes(b));
        sock.onClose(() => this.handleClose());
        // No sha1 -> accept header not verified; the modulus pin already
        // authenticated the peer (ws.ts handshake still requires a 101).
        const { request } = handshake(host, { randomBytes }, path);
        sock.write(request);
      })
      .catch((e) => this.fail(e));
  }

  private onBytes(bytes: Uint8Array): void {
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
      this.sock.write(encodeFrame(opcode, payload, randomBytes(4)));
    } catch (e) {
      this.fail(e);
    }
  }

  send(data: string | ArrayBuffer | ArrayBufferView): void {
    if (!this.sock || this.readyState !== OPEN) return;
    try {
      if (typeof data === 'string') {
        this.sock.write(encodeText(data, randomBytes(4)));
      } else {
        const u = data instanceof ArrayBuffer
          ? new Uint8Array(data)
          : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
        this.sock.write(encodeFrame(OPCODE.binary, u, randomBytes(4)));
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
      try { this.sock.write(encodeFrame(OPCODE.close, new Uint8Array(0), randomBytes(4))); } catch {}
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
    try { this.sock?.close(); } catch {}
    this.sock = null;
    this.onclose?.();
  }
}
