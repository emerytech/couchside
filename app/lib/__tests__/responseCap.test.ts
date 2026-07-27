/**
 * Binary-response size cap — lib/responseCap.ts.
 *
 * Run: from app/, `node --experimental-strip-types --test lib/__tests__/*.test.ts`
 * Picked up by the CI app-input glob.
 *
 * WHAT THIS GUARDS (KI-035). `mediaArtSource` and `screenFrameSource` read a box's
 * response with `arrayBuffer()` and no bound, then base64'd it (~1.33x) into a
 * data: URI. A box returning hundreds of megabytes — hostile, wedged, or a
 * capture tool gone wrong — took the phone's memory with it, and the screen
 * preview POLLS, so it got a fresh attempt every frame.
 *
 * The rule has to fail in the SAFE direction on both sides: too strict and a
 * legitimate screen frame stops rendering (the preview silently dies), too loose
 * and the cap is decorative. Every reject case below is therefore paired with a
 * realistic accept case.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  MAX_BINARY_BYTES,
  isDeclaredTooLarge,
  isUsableBodySize,
} from '../responseCap.ts';

const KB = 1024;
const MB = 1024 * 1024;

test('THE BUG: a huge declared body is refused before it is read', () => {
  assert.equal(isDeclaredTooLarge(String(500 * MB)), true);
  assert.equal(isDeclaredTooLarge(String(MAX_BINARY_BYTES + 1)), true);
  // CONTROL, the direction that keeps the feature working: real payloads pass.
  // A measured screen frame is ~100-400 KB; album art is smaller.
  assert.equal(isDeclaredTooLarge(String(400 * KB)), false);
  assert.equal(isDeclaredTooLarge(String(2 * MB)), false);
  assert.equal(isDeclaredTooLarge(String(MAX_BINARY_BYTES)), false, 'exactly at the cap is allowed');
});

test('an unknown Content-Length is not treated as too big', () => {
  // Refusing every response without a length would break any box that omits it;
  // the post-read check is what covers this case instead.
  for (const v of [null, undefined, '', '   ']) {
    assert.equal(isDeclaredTooLarge(v as string | null), false, `${String(v)} was refused`);
  }
});

test('a junk Content-Length falls through rather than being guessed at', () => {
  for (const v of ['abc', '-1', '1.5', '1e9', '0x100', '12 34', '+5', 'Infinity', 'NaN']) {
    assert.equal(isDeclaredTooLarge(v), false, `${v} was treated as a size`);
  }
  // CONTROL: a plain digit string IS parsed, so the above is genuinely about
  // unparseable input and not a function that always returns false.
  assert.equal(isDeclaredTooLarge(String(9 * MB)), true);
});

test('the post-read check is the backstop for a lying or absent length', () => {
  // A body that arrived oversized despite the header must not be encoded.
  assert.equal(isUsableBodySize(500 * MB), false);
  assert.equal(isUsableBodySize(MAX_BINARY_BYTES + 1), false);
  // CONTROL: normal sizes render.
  assert.equal(isUsableBodySize(400 * KB), true);
  assert.equal(isUsableBodySize(MAX_BINARY_BYTES), true, 'exactly at the cap renders');
});

test('an empty body is not renderable — preserving the old "no art" behaviour', () => {
  // Both callers already returned null on 0 bytes; that must not regress into
  // an empty data: URI reaching <Image>.
  assert.equal(isUsableBodySize(0), false);
  assert.equal(isUsableBodySize(-1), false);
  assert.equal(isUsableBodySize(NaN), false);
  assert.equal(isUsableBodySize(Infinity), false);
  // CONTROL: one byte is a body.
  assert.equal(isUsableBodySize(1), true);
});

test('the cap is generous enough that it cannot reject a real frame', () => {
  // Guards against someone "tightening" this to a number that silently kills
  // the screen preview. A measured frame is ~100-400 KB.
  assert.equal(MAX_BINARY_BYTES >= 4 * MB, true, `cap ${MAX_BINARY_BYTES} is too tight`);
  assert.equal(isUsableBodySize(400 * KB), true);
  assert.equal(isDeclaredTooLarge(String(400 * KB)), false);
});
