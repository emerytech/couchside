/**
 * Android TV protocol codec — lib/tvdirect/atvproto.ts + androidtv.ts.
 *
 * Run: from app/, `node --experimental-strip-types --test lib/__tests__/*.test.ts`
 *
 * WHY THIS FILE EXISTS. The protocol was proven against a real Google TV before
 * it was written into the app (see lib/__tests__/atv-live.mjs, which drives
 * these very modules over the LAN). What live hardware CANNOT give us is a
 * regression gate: the TV is not on CI, and a wrong keycode looks identical to
 * a TV that was asleep. So this file pins the parts that must never drift:
 *
 *  1. THE KEYCODES ARE DUPLICATED from the agent (_ATV_KEYS :8899,
 *     _ATV_OP_KEY :8897) because remote-only mode has no agent to ask.
 *  2. THE CODEC IS HAND-ROLLED, so its round-trip and its framing are pinned
 *     against known-good bytes rather than against itself.
 *  3. THE PAIRING CHECK-BYTE is the only local defence against a mistyped code
 *     (the TV answers a wrong secret with silence), so it is tested in BOTH
 *     directions with a real SHA-256.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import {
  ATV_FEATURES,
  ATV_KEYS,
  ATV_OP_KEY,
  ATV_PAIR_PORT,
  ATV_REMOTE_PORT,
  checkByteMatches,
  fb,
  fv,
  frame,
  hexToBytes,
  isPairingSecretAck,
  isRemotePing,
  isRemoteStart,
  isValidPairCode,
  keyInject,
  makeFramer,
  normalizeModulusHex,
  parse,
  pingValue,
  readVarint,
  remotePingReply,
  secretPreimage,
  varint,
} from '../tvdirect/atvproto.ts';
import { AtvSession, pairStart } from '../tvdirect/androidtv.ts';

const sha256 = async (b: Uint8Array) => new Uint8Array(createHash('sha256').update(b).digest());
const hex = (u: Uint8Array) => Buffer.from(u).toString('hex');

// ------------------------------------------------------------- key tables

test('Android TV keycodes match the agent VERBATIM (drift guard)', () => {
  // agent/couchsided.py:8899 _ATV_KEYS. These are Android KEYCODE_* constants;
  // a wrong number is a key that silently does something else on the TV.
  assert.equal(ATV_KEYS.up, 19);
  assert.equal(ATV_KEYS.down, 20);
  assert.equal(ATV_KEYS.left, 21);
  assert.equal(ATV_KEYS.right, 22);
  assert.equal(ATV_KEYS.ok, 23);
  assert.equal(ATV_KEYS.home, 3);
  assert.equal(ATV_KEYS.back, 4);
  assert.equal(ATV_KEYS.menu, 82);
  assert.equal(ATV_KEYS.power, 26);
  assert.equal(ATV_KEYS.volume_up, 24);
  assert.equal(ATV_KEYS.volume_down, 25);
  assert.equal(ATV_KEYS.mute, 91);
  assert.equal(ATV_KEYS.play_pause, 85);
  assert.equal(ATV_KEYS.play, 126);
  assert.equal(ATV_KEYS.pause, 127);
  assert.equal(ATV_KEYS.stop, 86);
  assert.equal(ATV_KEYS.rewind, 89);
  assert.equal(ATV_KEYS.fast_forward, 90);
  assert.equal(ATV_KEYS.next, 87);
  assert.equal(ATV_KEYS.previous, 88);
  // agent/couchsided.py:8897 _ATV_OP_KEY.
  assert.deepEqual({ ...ATV_OP_KEY }, { power_off: 26, volume_up: 24, volume_down: 25, mute: 91 });
  assert.equal(ATV_FEATURES, 622);
  assert.equal(ATV_PAIR_PORT, 6467);
  assert.equal(ATV_REMOTE_PORT, 6466);
});

test('the source key is deliberately ABSENT (KI-031)', () => {
  // KEYCODE_TV_INPUT (178) is in the agent's table but was MEASURED doing
  // nothing on Google TV, twice, on this exact set — while the agent still
  // answered ok. A key the TV silently drops must not be offerable here.
  assert.equal((ATV_KEYS as Record<string, number>).source, undefined);
  assert.ok(!(Object.values(ATV_KEYS) as number[]).includes(178));
});

// ----------------------------------------------------------------- codec

test('varints round-trip, including multi-byte boundaries', () => {
  for (const n of [0, 1, 3, 26, 127, 128, 300, 622, 16383, 16384, 1e6]) {
    const [got, pos] = readVarint(varint(n), 0);
    assert.equal(got, n, `varint ${n}`);
    assert.equal(pos, varint(n).length);
  }
  // Known-good encodings, so this cannot pass by being self-consistent.
  assert.equal(hex(varint(0)), '00');
  assert.equal(hex(varint(127)), '7f');
  assert.equal(hex(varint(128)), '8001');
  assert.equal(hex(varint(622)), 'ee04');
});

test('field writers produce the documented wire bytes', () => {
  // field 1, wiretype 0, value 3  ->  tag 0x08, value 0x03
  assert.equal(hex(fv(1, 3)), '0803');
  // field 2, wiretype 0, value 200 -> tag 0x10, varint 200 = c801
  assert.equal(hex(fv(2, 200)), '10c801');
  // field 1, wiretype 2, 2 bytes  -> tag 0x0a, len 0x02, payload
  assert.equal(hex(fb(1, Uint8Array.from([0xaa, 0xbb]))), '0a02aabb');
});

test('keyInject carries the keycode AND the SHORT direction', () => {
  // The TV ignores a key frame with no direction — this shipped correct only
  // because the agent's frame was copied exactly.
  // tag = (10<<3)|2 = 0x52, len 4, then key_code(1)=3 (0803) + direction(2)=3 (1003).
  assert.equal(hex(keyInject(3)), '520408031003');
  const f = parse(parse(keyInject(ATV_KEYS.home))[10]![0] as Uint8Array);
  assert.equal(f[1]![0], 3, 'keycode');
  assert.equal(f[2]![0], 3, 'direction SHORT');
});

test('parse walks fields and tolerates a frame it only partly understands', () => {
  const buf = Buffer.concat([Buffer.from(fv(1, 42)), Buffer.from(fb(2, Uint8Array.from([1, 2])))]);
  const f = parse(new Uint8Array(buf));
  assert.equal(f[1]![0], 42);
  assert.deepEqual(Array.from(f[2]![0] as Uint8Array), [1, 2]);
  // A trailing unknown wire type stops the walk rather than throwing: the
  // known fields are still usable, which is what the handshake relies on.
  const weird = new Uint8Array([...fv(1, 7), 0x0d, 0xff]);
  assert.equal(parse(weird)[1]![0], 7);
});

test('the framer reassembles frames split across chunk boundaries', () => {
  const a = frame(fv(1, 1));
  const b = frame(fv(2, 2));
  const all = Buffer.concat([Buffer.from(a), Buffer.from(b)]);
  // One byte at a time — the pathological TCP case, and the one a naive
  // "read once per frame" implementation gets wrong.
  const framer = makeFramer();
  const out: Uint8Array[] = [];
  for (const byte of all) out.push(...framer.push(Uint8Array.from([byte])));
  assert.equal(out.length, 2);
  assert.equal(parse(out[0])[1]![0], 1);
  assert.equal(parse(out[1])[2]![0], 2);
  // CONTROL: the whole buffer at once yields the same two frames.
  assert.equal(makeFramer().push(new Uint8Array(all)).length, 2);
});

test('ping replies echo the value the TV sent', () => {
  // A ping the TV does not get answered drops the channel, so the value has
  // to survive the round trip intact.
  const req = fb(8, fv(1, 7));
  const fields = parse(req);
  assert.ok(isRemotePing(fields));
  assert.equal(pingValue(fields), 7);
  assert.equal(parse(parse(remotePingReply(7))[9]![0] as Uint8Array)[1]![0], 7);
  // A malformed ping falls back to 1 rather than throwing inside the reader.
  assert.equal(pingValue(parse(fb(8, new Uint8Array(0)))), 1);
});

// --------------------------------------------------------------- pairing

test('modulus hex is normalised to even-length lowercase', () => {
  // Node hands back UPPERCASE and forge can produce an odd-length string; both
  // must hash identically or the secret is silently wrong.
  assert.equal(normalizeModulusHex('ABCD'), 'abcd');
  assert.equal(normalizeModulusHex('ABC'), '0abc');
  assert.equal(normalizeModulusHex('0xAB'), 'ab');
  assert.deepEqual(Array.from(hexToBytes('0A0B')), [10, 11]);
});

test('the secret preimage is exactly clientMod ‖ 010001 ‖ serverMod ‖ 010001 ‖ nonce', () => {
  const pre = secretPreimage('aabb', 'ccdd', '12e4f0');
  // nonce is the code MINUS its first byte (the check byte).
  assert.equal(hex(pre), 'aabb' + '010001' + 'ccdd' + '010001' + 'e4f0');
});

test('the check byte accepts the right code and rejects a wrong one', async () => {
  const clientMod = 'aabb';
  const serverMod = 'ccdd';
  const nonce = 'e4f0';
  // Derive the code the TV WOULD show: hash first, then take its first byte.
  const probe = await sha256(secretPreimage(clientMod, serverMod, '00' + nonce));
  const code = probe[0].toString(16).padStart(2, '0') + nonce;
  const secret = await sha256(secretPreimage(clientMod, serverMod, code));
  assert.ok(checkByteMatches(secret, code), 'the correct code must pass');
  // A single wrong digit in the CHECK byte must fail — this is the only local
  // defence, since the TV answers a bad secret with silence.
  const wrongCheck = (((probe[0] + 1) & 0xff).toString(16).padStart(2, '0')) + nonce;
  assert.ok(!checkByteMatches(secret, wrongCheck), 'a wrong check byte must fail');
});

test('pair codes are validated before anything is sent', () => {
  assert.ok(isValidPairCode('27e0b0'));
  assert.ok(isValidPairCode('27E0B0'));
  assert.ok(!isValidPairCode('27e0b'));
  assert.ok(!isValidPairCode('27e0b0a'));
  assert.ok(!isValidPairCode('27e0bz'));
  assert.ok(!isValidPairCode(''));
});

// ------------------------------------------------- session, on a fake socket

/** A scripted socket: replies are queued, writes are recorded. */
function fakeSocket(script: Uint8Array[]) {
  const writes: Uint8Array[] = [];
  const queue = [...script];
  let closed = false;
  return {
    writes,
    get closed() { return closed; },
    sock: {
      write: (b: Uint8Array) => {
        if (closed) throw new Error('closed');
        writes.push(b);
      },
      // An exhausted queue BLOCKS rather than throwing, because that is what a
      // real idle socket does. Throwing made the session's reader loop treat
      // "no more scripted frames" as "the TV hung up" and tear the connection
      // down mid-test — a fake that lies about idleness invents a failure the
      // production path does not have.
      recv: () => {
        const f = queue.shift();
        return f ? Promise.resolve(f) : new Promise<Uint8Array>(() => {});
      },
      close: () => { closed = true; },
      peerModulusHex: () => 'ccdd',
    },
  };
}

test('a session handshakes, then a key press writes exactly one inject frame', async () => {
  // The TV drives the handshake: configure -> set_active -> start.
  const f = fakeSocket([fb(1, fv(1, 1)), fb(2, fv(1, 1)), fb(40, fv(1, 1))]);
  const session = new AtvSession(
    '10.0.0.9',
    { certPem: 'c', keyPem: 'k', modulusHex: 'aabb' },
    { connect: async () => f.sock, sha256 },
  );
  await session.sendKey('home');
  // 2 handshake replies + the key. The reader loop may add nothing else here.
  assert.equal(f.writes.length, 3);
  const injected = parse(parse(f.writes[2])[10]![0] as Uint8Array);
  assert.equal(injected[1]![0], ATV_KEYS.home);
  session.close();
  assert.ok(f.closed);
});

test('an unknown key is refused locally and NOTHING is sent', async () => {
  const f = fakeSocket([fb(1, fv(1, 1)), fb(2, fv(1, 1)), fb(40, fv(1, 1))]);
  const session = new AtvSession(
    '10.0.0.9',
    { certPem: 'c', keyPem: 'k', modulusHex: 'aabb' },
    { connect: async () => f.sock, sha256 },
  );
  await assert.rejects(() => session.sendKey('selfdestruct' as never), /unknown key/);
  assert.equal(f.writes.length, 0, 'not even a connection was opened');
  session.close();
});

test('pairing refuses a bad code WITHOUT sending a secret', async () => {
  const f = fakeSocket([fb(11, fv(1, 1)), fb(20, fv(1, 1)), fb(31, fv(1, 1))]);
  const session = await pairStart(
    '10.0.0.9',
    { certPem: 'c', keyPem: 'k', modulusHex: 'aabb' },
    { connect: async () => f.sock, sha256 },
  );
  const beforeWrites = f.writes.length; // the 3 pairing steps
  await assert.rejects(() => session.finish('nothex'), /6 hex digits/);
  await assert.rejects(() => session.finish('000000'), /does not match/);
  assert.equal(f.writes.length, beforeWrites, 'no secret frame was written');
});

test('a completed pairing returns the identity to persist', async () => {
  const clientMod = 'aabb';
  const nonce = 'e4f0';
  const probe = await sha256(secretPreimage(clientMod, 'ccdd', '00' + nonce));
  const code = probe[0].toString(16).padStart(2, '0') + nonce;
  const f = fakeSocket([
    fb(11, fv(1, 1)), fb(20, fv(1, 1)), fb(31, fv(1, 1)),
    fb(41, fv(1, 1)), // secret ack
  ]);
  const identity = { certPem: 'CERT', keyPem: 'KEY', modulusHex: clientMod };
  const session = await pairStart('10.0.0.9', identity, { connect: async () => f.sock, sha256 });
  const out = await session.finish(code);
  assert.deepEqual(out, identity);
  assert.ok(isPairingSecretAck(parse(fb(41, fv(1, 1)))));
  assert.ok(f.closed, 'the pairing socket is released');
});

test('handshake helpers identify the frames they name', () => {
  assert.ok(isRemoteStart(parse(fb(40, fv(1, 1)))));
  assert.ok(!isRemoteStart(parse(fb(8, fv(1, 1)))));
  assert.ok(isRemotePing(parse(fb(8, fv(1, 1)))));
  assert.ok(!isRemotePing(parse(fb(40, fv(1, 1)))));
});
