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
 * The client itself lives in boxWsConn.ts (install-free, unit-tested with a fake
 * socket); this file only wires the real, pin-verifying connectPinned into it.
 *
 * Native-only (imports react-native-tcp-socket via boxTls); verified on-device.
 * Plaintext `ws://` is never removed — this is used only for pinned boxes.
 */
import 'react-native-get-random-values'; // installs globalThis.crypto.getRandomValues

import { connectPinned } from './boxTls';
import { PinnedWsConn } from './boxWsConn';

export type PinnedWsOpts = { caPem?: string; timeoutMs?: number };

export class PinnedWebSocket extends PinnedWsConn {
  constructor(host: string, port: number, pinModulus: string, path: string, opts?: PinnedWsOpts) {
    super(host, path, () => connectPinned(host, port, pinModulus, { caPem: opts?.caPem, timeoutMs: opts?.timeoutMs }));
  }
}
