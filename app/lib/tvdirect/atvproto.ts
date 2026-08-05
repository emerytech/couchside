/**
 * Android TV / Google TV Remote v2 protocol, in TypeScript. ZERO runtime imports.
 *
 * This is the half that was PROVEN against real hardware before any of it was
 * written into the app: a JS spike drove the bedroom Hisense Google TV
 * (10.1.1.98) on 2026-08-05 — paired, reconnected silently on the persisted
 * cert, and injected keys the owner watched land (power toggled the TV, volume
 * reached 30, and the on-screen selection moved). See
 * docs/memory/project_remote-only-mode.md.
 *
 * PORTED VERBATIM from the agent's backend (agent/couchsided.py `_atv_*`,
 * `_ATV_KEYS` :8899, `_ATV_OP_KEY` :8897). Duplicated rather than derived for
 * the same reason as the Roku tables: in remote-only mode there is no agent to
 * ask. lib/__tests__/atvproto.test.ts pins the keycodes against the agent so a
 * one-sided "fix" fails CI.
 *
 * THE SOCKET IS INJECTED (see AtvSocket). Node's `tls` is not available in
 * React Native and react-native-tcp-socket is not available in the bare-Node
 * test runner, so neither may be imported here. That is what lets the tests
 * drive this module against the REAL TV from Node while the app supplies its
 * own adapter — the untested surface stays a thin adapter rather than the whole
 * protocol.
 */

// ---------------------------------------------------------------- key tables

/** Unified TV ops -> Android keycodes. VERBATIM from _ATV_OP_KEY (couchsided.py:8897). */
export const ATV_OP_KEY = {
  power_off: 26,
  volume_up: 24,
  volume_down: 25,
  mute: 91,
} as const;
export type AtvOp = keyof typeof ATV_OP_KEY;

/**
 * Remote keys -> Android keycodes. VERBATIM from _ATV_KEYS (couchsided.py:8899).
 *
 * `source` (KEYCODE_TV_INPUT, 178) is deliberately ABSENT. It is in the agent's
 * table but KI-031 measured it doing NOTHING on Google TV twice on this very
 * set, while the agent still answered ok — a key the TV silently drops is worse
 * than a missing one, and this table has no legacy callers to keep working.
 */
export const ATV_KEYS = {
  up: 19,
  down: 20,
  left: 21,
  right: 22,
  ok: 23,
  home: 3,
  back: 4,
  menu: 82,
  power: 26,
  volume_up: 24,
  volume_down: 25,
  mute: 91,
  play_pause: 85,
  play: 126,
  pause: 127,
  stop: 86,
  rewind: 89,
  fast_forward: 90,
  next: 87,
  previous: 88,
} as const;
export type AtvKey = keyof typeof ATV_KEYS;

/** Feature bitmask echoed during the remote handshake (_ATV_FEATURES :8892). */
export const ATV_FEATURES = 622;
/** Key press direction: SHORT. The TV ignores a frame without it. */
const DIRECTION_SHORT = 3;

export const ATV_PAIR_PORT = 6467;
export const ATV_REMOTE_PORT = 6466;

// ------------------------------------------------------------ protobuf codec
// Hand-rolled, matching the agent: the wire is varint-length-prefixed protobuf
// and the message set used here is small enough that a real protobuf runtime
// would be a dependency bought for nothing.

export function varint(n: number): Uint8Array {
  const out: number[] = [];
  for (;;) {
    const b = n & 0x7f;
    n = Math.floor(n / 128);
    if (n) out.push(b | 0x80);
    else {
      out.push(b);
      break;
    }
  }
  return Uint8Array.from(out);
}

export function readVarint(buf: Uint8Array, pos: number): [number, number] {
  let shift = 0;
  let val = 0;
  for (;;) {
    if (pos >= buf.length) throw new Error('truncated varint');
    const b = buf[pos++];
    val += (b & 0x7f) * 2 ** shift;
    if (!(b & 0x80)) return [val, pos];
    shift += 7;
    if (shift > 63) throw new Error('varint too long');
  }
}

function concat(parts: Uint8Array[]): Uint8Array {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

const tag = (field: number, wt: number) => varint((field << 3) | wt);
/** varint field */
export const fv = (field: number, val: number) => concat([tag(field, 0), varint(val)]);
/** length-delimited field */
export const fb = (field: number, data: Uint8Array) =>
  concat([tag(field, 2), varint(data.length), data]);
/** string field */
export const fstr = (field: number, s: string) => fb(field, utf8(s));

function utf8(s: string): Uint8Array {
  // TextEncoder exists in RN 0.86 (Hermes) and in Node; avoids a Buffer import
  // so this module stays runtime-agnostic.
  return new TextEncoder().encode(s);
}

/** Field number -> occurrences. Values are numbers (varint) or byte slices. */
export type AtvFields = Record<number, (number | Uint8Array)[]>;

/** Parse one frame body. Unknown wire types stop the walk rather than throwing:
 *  a frame we only partly understand is still useful for its known fields. */
export function parse(buf: Uint8Array): AtvFields {
  const fields: AtvFields = {};
  let pos = 0;
  while (pos < buf.length) {
    let t: number;
    try {
      [t, pos] = readVarint(buf, pos);
    } catch {
      return fields;
    }
    const field = Math.floor(t / 8);
    const wt = t % 8;
    if (wt === 0) {
      let v: number;
      [v, pos] = readVarint(buf, pos);
      (fields[field] ??= []).push(v);
    } else if (wt === 2) {
      let ln: number;
      [ln, pos] = readVarint(buf, pos);
      (fields[field] ??= []).push(buf.subarray(pos, pos + ln));
      pos += ln;
    } else {
      return fields;
    }
  }
  return fields;
}

/** Pairing messages ride an envelope carrying protocol version + status. */
export const pairEnvelope = (innerField: number, inner: Uint8Array) =>
  concat([fv(1, 2), fv(2, 200), fb(innerField, inner)]);

// ------------------------------------------------------------- socket seam

/**
 * The transport this module needs. Deliberately tiny: connect with a client
 * certificate, exchange length-prefixed frames, close.
 *
 * `connect` MUST NOT verify the TV's certificate against a public CA — every
 * Android TV presents a self-signed cert it generated itself (measured: issuer
 * == subject, `CN=atvremote/<MAC>`). Node does this with
 * `rejectUnauthorized:false`; react-native-tcp-socket has no such flag and
 * accepts a self-signed peer only by PINNING it as `ca`, which is why the app
 * adapter fetches the cert first. That difference is the entire reason this
 * seam exists.
 */
export type AtvSocket = {
  /** Send one frame (the length prefix is added by the caller of this type). */
  write(bytes: Uint8Array): void;
  /** Resolve the next complete frame body, or reject on close/timeout. */
  recv(timeoutMs?: number): Promise<Uint8Array>;
  close(): void;
  /** The peer's RSA modulus as hex — needed for the pairing secret. */
  peerModulusHex(): string;
};

export type AtvConnect = (
  host: string,
  port: number,
  certPem: string,
  keyPem: string,
) => Promise<AtvSocket>;

/** Frame a message for the wire: varint length, then the body. */
export function frame(msg: Uint8Array): Uint8Array {
  return concat([varint(msg.length), msg]);
}

/**
 * Split a growing byte stream into complete frames. Returned by reference so a
 * transport adapter can feed it bytes as they arrive; it keeps the remainder.
 */
export function makeFramer(): {
  push(chunk: Uint8Array): Uint8Array[];
} {
  // Typed as the concat() return so TS keeps the ArrayBuffer-backed variant;
  // `new Uint8Array(0)` widens to ArrayBufferLike and then fails to reassign.
  let buf: Uint8Array = concat([]);
  return {
    push(chunk: Uint8Array): Uint8Array[] {
      buf = concat([buf, chunk]);
      const out: Uint8Array[] = [];
      for (;;) {
        if (!buf.length) return out;
        let ln: number;
        let pos: number;
        try {
          [ln, pos] = readVarint(buf, 0);
        } catch {
          return out; // length prefix not fully arrived
        }
        if (buf.length < pos + ln) return out;
        out.push(buf.subarray(pos, pos + ln));
        buf = buf.subarray(pos + ln);
      }
    },
  };
}

// --------------------------------------------------------------- pairing

/** Even-length lowercase hex, which is what the secret hash is fed. */
export function normalizeModulusHex(hex: string): string {
  const h = hex.trim().toLowerCase().replace(/^0x/, '');
  return h.length % 2 ? '0' + h : h;
}

export function hexToBytes(hex: string): Uint8Array {
  const h = normalizeModulusHex(hex);
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.substr(i * 2, 2), 16);
  return out;
}

/**
 * The bytes the pairing secret is the SHA-256 of:
 *   clientModulus ‖ 010001 ‖ serverModulus ‖ 010001 ‖ nonce
 * where 010001 is the RSA exponent 65537 zero-prefixed, and the nonce is the
 * last four hex digits of the code the TV displays. Split out from the hashing
 * so it is testable without a crypto implementation.
 */
export function secretPreimage(
  clientModulusHex: string,
  serverModulusHex: string,
  code: string,
): Uint8Array {
  const exp = hexToBytes('010001');
  return concat([
    hexToBytes(clientModulusHex),
    exp,
    hexToBytes(serverModulusHex),
    exp,
    hexToBytes(code.slice(2)),
  ]);
}

/**
 * The TV shows `code` = <check byte><nonce>. The check byte is the first byte
 * of the TV's own computed secret, so comparing it locally catches a mistyped
 * code (and a mis-derived modulus) BEFORE sending — the TV answers a wrong
 * secret with silence, which is indistinguishable from a dead link.
 */
export function checkByteMatches(secret: Uint8Array, code: string): boolean {
  return secret.length > 0 && secret[0] === parseInt(code.slice(0, 2), 16);
}

export function isValidPairCode(code: string): boolean {
  return /^[0-9a-fA-F]{6}$/.test(code.trim());
}

// -------------------------------------------------- message constructors

/** pairing_request(10){ service_name(1), client_name(2) } */
export const pairingRequest = (clientName: string) =>
  pairEnvelope(10, concat([fstr(1, 'atvremote'), fstr(2, clientName)]));

/** The encoding both options(20) and configuration(30) carry: HEX, 6 symbols. */
const ENCODING = () => concat([fv(1, 3), fv(2, 6)]);

/** pairing_option(20){ input_encodings(1), preferred_role(3)=1 } */
export const pairingOptions = () => pairEnvelope(20, concat([fb(1, ENCODING()), fv(3, 1)]));

/** pairing_configuration(30){ encoding(1), client_role(2)=1 } */
export const pairingConfiguration = () =>
  pairEnvelope(30, concat([fb(1, ENCODING()), fv(2, 1)]));

/** pairing_secret(40){ secret(1) } */
export const pairingSecret = (secret: Uint8Array) => pairEnvelope(40, fb(1, secret));

/** Reply to remote_configure(1) with our device info. */
export const remoteConfigureReply = () => {
  const dev = concat([fv(3, 1), fstr(4, '1'), fstr(5, 'atvremote'), fstr(6, '1.0.0')]);
  return fb(1, concat([fv(1, ATV_FEATURES), fb(2, dev)]));
};

/** Reply to remote_set_active(2). */
export const remoteSetActiveReply = () => fb(2, fv(1, ATV_FEATURES));

/** Answer a remote_ping_request(8) with the same value. The TV drops a channel
 *  whose pings go unanswered, so this is mandatory, not optional politeness. */
export const remotePingReply = (val: number) => fb(9, fv(1, val));

/** remote_key_inject(10){ key_code(1), direction(2)=SHORT } */
export const keyInject = (keycode: number) =>
  fb(10, concat([fv(1, keycode), fv(2, DIRECTION_SHORT)]));

/** Extract the ping value from a parsed remote_ping_request field. */
export function pingValue(fields: AtvFields): number {
  const raw = fields[8]?.[0];
  if (raw instanceof Uint8Array) {
    const inner = parse(raw)[1]?.[0];
    if (typeof inner === 'number') return inner;
  }
  return 1;
}

/** Frame-kind helpers, so callers read as protocol rather than field numbers. */
export const isRemoteConfigure = (f: AtvFields) => 1 in f;
export const isRemoteSetActive = (f: AtvFields) => 2 in f;
export const isRemotePing = (f: AtvFields) => 8 in f;
export const isRemoteStart = (f: AtvFields) => 40 in f;
export const isPairingRequestAck = (f: AtvFields) => 11 in f;
export const isPairingOptionsAck = (f: AtvFields) => 20 in f;
export const isPairingConfigurationAck = (f: AtvFields) => 31 in f;
export const isPairingSecretAck = (f: AtvFields) => 41 in f;
