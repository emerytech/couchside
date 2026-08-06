/**
 * LG webOS app-direct: the WebSocket framing (lib/tvdirect/ws.ts) and the SSAP
 * protocol (lib/tvdirect/webosproto.ts). Both are import-free, so this runs in
 * the install-free test glob.
 *
 * WHY: the frame masking and length encoding are the classic silently-wrong-or-
 * right code, and the register manifest must stay BYTE-VERBATIM vs the agent
 * (any drift → the TV returns 401). Both are pinned here.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes as nodeRandom } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  base64,
  encodeText,
  encodeFrame,
  handshake,
  makeDecoder,
  OPCODE,
  parseHandshakeResponse,
  frameText,
} from '../tvdirect/ws.ts';
import {
  WEBOS_KEYS,
  WEBOS_OP_URI,
  WEBOS_PORT,
  WEBOS_REGISTER_JSON,
  clientKeyOf,
  isPrompt,
  isRegistered,
  pointerButtonFrame,
  registerMessage,
  requestMessage,
} from '../tvdirect/webosproto.ts';

const crypto = {
  randomBytes: (n: number) => new Uint8Array(nodeRandom(n)),
  sha1: (d: Uint8Array) => new Uint8Array(createHash('sha1').update(d).digest()),
};

// ------------------------------------------------------------ WS handshake

test('base64 matches Node Buffer', () => {
  for (const n of [0, 1, 2, 3, 16, 100]) {
    const b = new Uint8Array(nodeRandom(n));
    assert.equal(base64(b), Buffer.from(b).toString('base64'));
  }
});

test('handshake accept matches the RFC 6455 example vector', () => {
  // RFC 6455 §1.3: key "dGhlIHNhbXBsZSBub25jZQ==" -> accept "s3pPLMBiTxaQ9kYGzzhZRbK+xOo=".
  // Force that exact key by stubbing randomBytes to decode it.
  const keyBytes = Uint8Array.from(Buffer.from('dGhlIHNhbXBsZSBub25jZQ==', 'base64'));
  const hs = handshake('10.0.0.5:3001', { ...crypto, randomBytes: () => keyBytes });
  assert.equal(hs.expectAccept, 's3pPLMBiTxaQ9kYGzzhZRbK+xOo=');
  const text = Buffer.from(hs.request).toString();
  assert.match(text, /GET \/ HTTP\/1\.1/);
  assert.match(text, /Upgrade: websocket/);
  assert.match(text, /Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==/);
});

test('parseHandshakeResponse: waits, accepts a good 101, rejects a bad accept/status', () => {
  const accept = 's3pPLMBiTxaQ9kYGzzhZRbK+xOo=';
  // partial header -> not done
  assert.equal(parseHandshakeResponse(Buffer.from('HTTP/1.1 101 Switching'), accept).done, false);
  // good, with a pipelined frame byte after the header
  const good = Buffer.concat([
    Buffer.from(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`),
    Buffer.from([0x81, 0x00]),
  ]);
  const r = parseHandshakeResponse(good, accept);
  assert.equal(r.ok, true);
  assert.deepEqual([...(r.rest as Uint8Array)], [0x81, 0x00]);
  // wrong accept
  assert.equal(parseHandshakeResponse(Buffer.from(`HTTP/1.1 101 x\r\nSec-WebSocket-Accept: nope\r\n\r\n`), accept).ok, false);
  // not a 101
  assert.equal(parseHandshakeResponse(Buffer.from('HTTP/1.1 403 Forbidden\r\n\r\n'), accept).ok, false);
});

// ------------------------------------------------------------ WS framing

test('a client frame is masked, and a decoder recovers it (round trip, all lengths)', () => {
  const dec = makeDecoder();
  for (const msg of ['', 'x', 'a'.repeat(125), 'b'.repeat(126), 'c'.repeat(70000), 'héllo 千 🎮']) {
    const mask = new Uint8Array(nodeRandom(4));
    const frame = encodeText(msg, mask);
    // client frame MUST have the mask bit set
    assert.equal((frame[1] & 0x80) !== 0, true, 'client frame masked');
    const got = dec.push(frame);
    assert.equal(got.length, 1);
    assert.equal(got[0].opcode, OPCODE.text);
    assert.equal(frameText(got[0]), msg);
  }
});

test('decoder handles an UNMASKED server frame and reassembles fragments', () => {
  const dec = makeDecoder();
  // server text frame, unmasked, "hi"
  const server = Uint8Array.from([0x81, 0x02, 0x68, 0x69]);
  assert.equal(frameText(dec.push(server)[0]), 'hi');
  // fragmented: text "ab" split into (fin=0, "a") + (continuation fin=1, "b")
  const f1 = Uint8Array.from([0x01, 0x01, 0x61]); // opcode text, FIN=0
  const f2 = Uint8Array.from([0x80, 0x01, 0x62]); // opcode cont, FIN=1
  assert.equal(dec.push(f1).length, 0, 'no frame until FIN');
  const done = dec.push(f2);
  assert.equal(done.length, 1);
  assert.equal(frameText(done[0]), 'ab');
});

test('decoder yields control frames and splits a byte stream at arbitrary boundaries', () => {
  const dec = makeDecoder();
  const ping = Uint8Array.from([0x89, 0x00]);
  assert.equal(dec.push(ping)[0].opcode, OPCODE.ping);
  // deliver one text frame one byte at a time
  const mask = Uint8Array.from([1, 2, 3, 4]);
  const frame = encodeFrame(OPCODE.text, new TextEncoder().encode('drip'), mask);
  let out: ReturnType<typeof dec.push> = [];
  for (const byte of frame) out = out.concat(dec.push(Uint8Array.from([byte])));
  assert.equal(out.length, 1);
  assert.equal(frameText(out[0]), 'drip');
});

// ------------------------------------------------------------ SSAP protocol

test('the register manifest is BYTE-VERBATIM vs the agent (drift = 401)', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const agent = readFileSync(join(here, '../../../agent/couchsided.py'), 'utf8');
  const m = /_WEBOS_REGISTER_JSON = (['"])(.*?)\1/s.exec(agent);
  assert.ok(m, 'found _WEBOS_REGISTER_JSON in the agent');
  // The agent literal uses \\uXXXX (escaped backslash) for non-ASCII; unescape
  // the python-string level to get the actual JSON text, then compare parsed.
  const agentJson = m![2].replace(/\\\\/g, '\\');
  assert.deepEqual(
    JSON.parse(WEBOS_REGISTER_JSON),
    JSON.parse(agentJson),
    'app manifest must parse identically to the agent manifest',
  );
  // And the signature block is intact (the load-bearing part).
  const parsed = JSON.parse(WEBOS_REGISTER_JSON);
  assert.equal(parsed.pairingType, 'PROMPT');
  assert.ok(parsed.manifest.signatures[0].signature.length > 100, 'signature present');
  assert.equal(parsed.manifest.signed.appId, 'com.lge.test');
});

test('registerMessage carries the manifest, adds client-key only when given', () => {
  const fresh = JSON.parse(registerMessage('cs_1'));
  assert.equal(fresh.type, 'register');
  assert.equal(fresh.id, 'cs_1');
  assert.equal(fresh.payload['client-key'], undefined, 'no key on first pair (TV prompts)');
  assert.equal(fresh.payload.pairingType, 'PROMPT');
  const silent = JSON.parse(registerMessage('cs_2', 'KEY123'));
  assert.equal(silent.payload['client-key'], 'KEY123', 'stored key = silent reconnect');
});

test('requestMessage + pointer frame shapes match the agent', () => {
  const r = JSON.parse(requestMessage('cs_3', WEBOS_OP_URI.volume_up));
  assert.deepEqual(r, { id: 'cs_3', type: 'request', uri: 'ssap://audio/volumeUp' });
  // pointer socket button protocol is line-based text, not JSON
  assert.equal(pointerButtonFrame(WEBOS_KEYS.ok), 'type:button\nname:ENTER\n\n');
  assert.equal(WEBOS_PORT, 3001);
});

test('SSAP message classifiers', () => {
  assert.equal(isPrompt({ payload: { pairingType: 'PROMPT' } }), true);
  assert.equal(isPrompt({ payload: {} }), false);
  assert.equal(isRegistered({ type: 'registered' }), true);
  assert.equal(clientKeyOf({ type: 'registered', payload: { 'client-key': 'abc' } }), 'abc');
  assert.equal(clientKeyOf({ type: 'response', payload: {} }), undefined);
});
