/**
 * Minimal RFC6455 WebSocket client, running over an INJECTED byte stream.
 * ZERO runtime imports — the TLS socket (react-native-tcp-socket) and the
 * crypto (randomBytes, sha1) are passed in, so this — the frame masking and
 * length encoding, which are silently-wrong-or-right — is unit-testable in
 * bare Node against a real `ws` server.
 *
 * WHY HAND-ROLLED: LG webOS SSAP is JSON over wss://<ip>:3001 with a SELF-SIGNED
 * cert. RN's built-in WebSocket cannot skip TLS validation; react-native-tcp-
 * socket gives a raw TLS socket but no WebSocket layer. So we pin the cert on
 * the TLS socket and run the WebSocket handshake + framing ourselves on top.
 *
 * Scope is deliberately small: text frames (SSAP is JSON), plus ping/pong/close
 * control frames. Client frames are masked (required by spec); server frames are
 * not. Fragmentation is reassembled.
 */

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

export type WsCrypto = {
  /** n cryptographically-random bytes (for the client key + per-frame masks). */
  randomBytes(n: number): Uint8Array;
  /** SHA-1, for verifying the server's Sec-WebSocket-Accept. Optional: if
   *  absent, the accept header is not verified (handshake still proceeds on a
   *  101), which on a pinned-cert LAN TV is acceptable. */
  sha1?(data: Uint8Array): Uint8Array;
};

function utf8(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}
function fromUtf8(b: Uint8Array): string {
  return new TextDecoder().decode(b);
}
function concat(parts: Uint8Array[]): Uint8Array {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

// ---- base64 (no Buffer dependency; RN Hermes + Node both run this) ----
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
export function base64(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i], b = i + 1 < bytes.length ? bytes[i + 1] : 0, c = i + 2 < bytes.length ? bytes[i + 2] : 0;
    out += B64[a >> 2] + B64[((a & 3) << 4) | (b >> 4)];
    out += i + 1 < bytes.length ? B64[((b & 15) << 2) | (c >> 6)] : '=';
    out += i + 2 < bytes.length ? B64[c & 63] : '=';
  }
  return out;
}

/** Build the client handshake request bytes + the accept value to expect. */
export function handshake(
  host: string,
  crypto: WsCrypto,
  path = '/',
): { request: Uint8Array; expectAccept: string | null } {
  const keyBytes = crypto.randomBytes(16);
  const key = base64(keyBytes);
  const lines = [
    `GET ${path} HTTP/1.1`,
    `Host: ${host}`,
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Key: ${key}`,
    'Sec-WebSocket-Version: 13',
    '',
    '',
  ];
  let expectAccept: string | null = null;
  if (crypto.sha1) {
    expectAccept = base64(crypto.sha1(utf8(key + WS_GUID)));
  }
  return { request: utf8(lines.join('\r\n')), expectAccept };
}

/**
 * Parse the server's handshake response out of a byte buffer. Returns done=false
 * while the header is still arriving. On done: ok + any leftover bytes (the
 * start of the first frame, if the server pipelined one).
 */
export function parseHandshakeResponse(
  buf: Uint8Array,
  expectAccept: string | null,
): { done: boolean; ok?: boolean; error?: string; rest?: Uint8Array } {
  const text = fromUtf8(buf);
  const end = text.indexOf('\r\n\r\n');
  if (end < 0) return { done: false };
  const header = text.slice(0, end);
  const rest = buf.subarray(end + 4);
  const status = header.split('\r\n')[0] || '';
  if (!/HTTP\/1\.\d 101/.test(status)) {
    return { done: true, ok: false, error: `websocket upgrade refused: ${status}` };
  }
  if (expectAccept) {
    const m = /sec-websocket-accept:\s*(.+)/i.exec(header);
    if (!m || m[1].trim() !== expectAccept) {
      return { done: true, ok: false, error: 'bad Sec-WebSocket-Accept (not a real WS server?)' };
    }
  }
  return { done: true, ok: true, rest };
}

/** Encode a masked text frame (opcode 0x1, FIN). Client frames MUST be masked. */
export function encodeText(text: string, mask: Uint8Array): Uint8Array {
  const payload = utf8(text);
  return encodeFrame(0x1, payload, mask);
}

export function encodeFrame(opcode: number, payload: Uint8Array, mask: Uint8Array): Uint8Array {
  const len = payload.length;
  const header: number[] = [0x80 | (opcode & 0x0f)]; // FIN + opcode
  if (len < 126) header.push(0x80 | len);
  else if (len < 65536) header.push(0x80 | 126, (len >> 8) & 0xff, len & 0xff);
  else {
    // 64-bit length; JS numbers are safe well past any SSAP message size.
    header.push(0x80 | 127, 0, 0, 0, 0, (len >>> 24) & 0xff, (len >>> 16) & 0xff, (len >>> 8) & 0xff, len & 0xff);
  }
  const masked = new Uint8Array(len);
  for (let i = 0; i < len; i++) masked[i] = payload[i] ^ mask[i & 3];
  return concat([Uint8Array.from(header), mask, masked]);
}

export type WsFrame = { opcode: number; payload: Uint8Array };

/**
 * Stateful frame decoder for the SERVER→client direction (frames unmasked, per
 * spec; we tolerate a mask bit anyway). Reassembles fragmented messages into a
 * single frame with the initiating opcode. Feed it bytes; it returns whatever
 * complete frames it now has.
 */
export function makeDecoder(): { push(bytes: Uint8Array): WsFrame[] } {
  let buf: Uint8Array = new Uint8Array(0);
  let fragOpcode = 0;
  let fragParts: Uint8Array[] = [];
  return {
    push(bytes: Uint8Array): WsFrame[] {
      buf = concat([buf, bytes]);
      const out: WsFrame[] = [];
      for (;;) {
        if (buf.length < 2) return out;
        const b0 = buf[0], b1 = buf[1];
        const fin = (b0 & 0x80) !== 0;
        const opcode = b0 & 0x0f;
        const masked = (b1 & 0x80) !== 0;
        let len = b1 & 0x7f;
        let pos = 2;
        if (len === 126) {
          if (buf.length < 4) return out;
          len = (buf[2] << 8) | buf[3];
          pos = 4;
        } else if (len === 127) {
          if (buf.length < 10) return out;
          // high 32 bits ignored (no SSAP message is 4GB)
          len = (buf[6] * 2 ** 24) + (buf[7] << 16) + (buf[8] << 8) + buf[9];
          pos = 10;
        }
        const maskKey = masked ? buf.subarray(pos, pos + 4) : null;
        if (masked) pos += 4;
        if (buf.length < pos + len) return out;
        let payload = buf.subarray(pos, pos + len);
        if (maskKey) {
          const un = new Uint8Array(len);
          for (let i = 0; i < len; i++) un[i] = payload[i] ^ maskKey[i & 3];
          payload = un;
        } else {
          payload = payload.slice(); // detach from buf before we advance it
        }
        buf = buf.subarray(pos + len);

        if (opcode === 0x0) {
          // continuation
          fragParts.push(payload);
          if (fin) { out.push({ opcode: fragOpcode, payload: concat(fragParts) }); fragParts = []; fragOpcode = 0; }
        } else if (opcode === 0x1 || opcode === 0x2) {
          if (fin) out.push({ opcode, payload });
          else { fragOpcode = opcode; fragParts = [payload]; }
        } else {
          // control frame (ping/pong/close) — always unfragmented
          out.push({ opcode, payload });
        }
      }
    },
  };
}

export function frameText(frame: WsFrame): string {
  return fromUtf8(frame.payload);
}

export const OPCODE = { text: 0x1, binary: 0x2, close: 0x8, ping: 0x9, pong: 0xa } as const;
